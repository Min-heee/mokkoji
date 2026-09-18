/**
 * useLive 의 읽기 창구 (순수 모듈, React 없음 — node 테스트).
 *
 * - poll(): 폴링 타이머용. 진행 중인 읽기가 있으면 그 프로미스를 그대로 돌려준다(중복 요청 없음).
 * - refresh(): 변경 RPC(start·kick·edit…) 뒤에 부르는 '지금 서버 상태' 읽기. 진행 중인 읽기가 있으면 그것은
 *   변경 RPC 보다 먼저 서버에 닿았을 수 있어(변경 전 스냅샷) 돌려주지 않고, 끝난 뒤 한 번 더 읽어 그 결과를 돌려준다.
 *   기다리는 동안 여러 번 불려도 뒤따르는 읽기는 한 번이다.
 * - 늦게 도착한 옛 응답은 버린다: 더 새 요청의 응답이 이미 적용됐으면 onValue/onError 를 부르지 않는다.
 *   (폴링 응답이 변경 뒤 응답보다 늦게 와도 화면이 변경 전으로 되돌아가지 않는다)
 */
export interface RefreshGate<T> {
  poll(): Promise<T | null>;
  refresh(): Promise<T | null>;
}

export function createRefreshGate<T>(opts: {
  read: () => Promise<T>;
  onValue: (value: T) => void;
  onError: (error: unknown) => void;
}): RefreshGate<T> {
  let seq = 0;
  let applied = 0;
  let inflight: Promise<T | null> | null = null;
  let followUp: Promise<T | null> | null = null;

  const fire = (): Promise<T | null> => {
    const mine = ++seq;
    const p: Promise<T | null> = opts
      .read()
      .then((value) => {
        if (mine > applied) {
          applied = mine;
          opts.onValue(value);
        }
        return value;
      })
      .catch((e: unknown) => {
        if (mine > applied) opts.onError(e);
        return null;
      })
      .finally(() => {
        if (inflight === p) inflight = null;
      });
    inflight = p;
    return p;
  };

  return {
    poll: () => inflight ?? fire(),
    refresh: () => {
      if (!inflight) return fire();
      if (!followUp) {
        followUp = inflight.then(() => {
          followUp = null;
          return fire();
        });
      }
      return followUp;
    },
  };
}
