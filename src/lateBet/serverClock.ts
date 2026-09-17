/**
 * 서버 시계 추정 — 표시 전용 (설계서 §1 원칙 2, §5.1).
 *
 * offset = serverNowMs − (t0 + t1) / 2.  t0·t1 = 요청 직전·응답 직후의 기기 시각.
 * - RTT 가 800ms 를 넘는 샘플은 버린다(단, 아직 샘플이 하나도 없으면 임시로 받아 둔다).
 * - 판정에는 절대 쓰지 않는다. 도착·마감·정산은 전부 서버 now() 다.
 * - React/RN 을 import 하지 않는다. 훅은 useServerNow.ts.
 */
export const MAX_GOOD_RTT_MS = 800;

export interface ServerClock {
  /** 서버 기준 현재 시각(추정). 샘플이 없으면 기기 시각 그대로 */
  now(): number;
  offsetMs(): number;
  hasSample(): boolean;
  /** 응답의 serverNowMs 로 보정. 받아들였으면 true */
  addSample(serverNowMs: number, t0: number, t1: number): boolean;
  /** 오프셋이 바뀌면 불린다(카운트다운을 즉시 다시 그리게) */
  subscribe(listener: () => void): () => void;
  reset(): void;
}

export function createServerClock(deviceNow: () => number = Date.now): ServerClock {
  let offset = 0;
  let sampled = false;
  let provisional = false;
  const listeners = new Set<() => void>();

  return {
    now: () => deviceNow() + offset,
    offsetMs: () => offset,
    hasSample: () => sampled,
    addSample(serverNowMs, t0, t1) {
      if (![serverNowMs, t0, t1].every((v) => typeof v === 'number' && Number.isFinite(v)) || t1 < t0) return false;
      const slow = t1 - t0 > MAX_GOOD_RTT_MS;
      if (slow && sampled && !provisional) return false;
      const next = Math.round(serverNowMs - (t0 + t1) / 2);
      sampled = true;
      provisional = slow;
      if (next !== offset) {
        offset = next;
        listeners.forEach((fn) => fn());
      }
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      offset = 0;
      sampled = false;
      provisional = false;
      listeners.forEach((fn) => fn());
    },
  };
}

/** 앱 전체가 공유하는 서버 시계 */
export const serverClock: ServerClock = createServerClock();

/** 서버 기준 현재 시각(추정). 렌더 중에 부르지 말고 useServerNow 를 써라(값이 얼어붙는다) */
export const serverNow = (): number => serverClock.now();

/**
 * serverNowMs 가 든 응답을 돌려주는 호출을 감싸 왕복 시간을 재고 시계를 보정한다.
 *   const live = await withClockSample(() => api.getLive(id));
 */
export async function withClockSample<T extends { serverNowMs: number }>(
  call: () => Promise<T>,
  clock: ServerClock = serverClock,
  deviceNow: () => number = Date.now,
): Promise<T> {
  const t0 = deviceNow();
  const res = await call();
  clock.addSample(res.serverNowMs, t0, deviceNow());
  return res;
}
