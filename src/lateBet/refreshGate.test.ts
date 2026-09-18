import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRefreshGate } from './refreshGate';

interface Snap {
  startedAtMs: number | null;
}

/** '요청 시점에 읽고 응답만 지연' 하는 서버 모형 — 실제 lb_get_live 가 변경 RPC 보다 먼저 처리되고 응답만 늦는 경우 */
function fakeServer() {
  const state: Snap = { startedAtMs: null };
  let delay = 0;
  const read = () => {
    const snap: Snap = { ...state };
    const wait = delay;
    return new Promise<Snap>((resolve) => setTimeout(() => resolve(snap), wait));
  };
  return {
    state,
    read,
    setDelay(ms: number) {
      delay = ms;
    },
    start() {
      state.startedAtMs = 1000;
    },
  };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('refreshGate — 변경 RPC 뒤 refresh 는 진행 중인 옛 읽기를 돌려주지 않는다', () => {
  it('폴링이 먼저 나가 있어도 refresh() 는 그 뒤에 한 번 더 읽어 변경 뒤 상태를 돌려준다', async () => {
    const server = fakeServer();
    const applied: Snap[] = [];
    const gate = createRefreshGate<Snap>({ read: server.read, onValue: (v) => applied.push(v), onError: () => assert.fail('오류 없음') });

    server.setDelay(60);
    const polling = gate.poll(); // 시작 전 스냅샷을 든 폴링 응답이 날아가는 중
    await tick(10);
    server.start(); // 변경 RPC 완료
    server.setDelay(5);
    const after = await gate.refresh();

    assert.equal(after?.startedAtMs, 1000);
    assert.equal((await polling)?.startedAtMs, null);
    // 화면에 마지막으로 적용된 값은 변경 뒤 상태
    assert.equal(applied.at(-1)?.startedAtMs, 1000);
  });

  it('진행 중인 읽기가 없으면 refresh() 는 바로 읽고, poll() 은 진행 중인 읽기를 재사용한다', async () => {
    const server = fakeServer();
    let reads = 0;
    const gate = createRefreshGate<Snap>({
      read: () => {
        reads += 1;
        return server.read();
      },
      onValue: () => {},
      onError: () => {},
    });
    server.setDelay(20);
    const a = gate.poll();
    const b = gate.poll();
    assert.equal(a, b);
    await a;
    assert.equal(reads, 1);
    await gate.refresh();
    assert.equal(reads, 2);
  });

  it('기다리는 동안 refresh() 를 여러 번 불러도 뒤따르는 읽기는 한 번이다', async () => {
    const server = fakeServer();
    let reads = 0;
    const gate = createRefreshGate<Snap>({
      read: () => {
        reads += 1;
        return server.read();
      },
      onValue: () => {},
      onError: () => {},
    });
    server.setDelay(30);
    void gate.poll();
    const r1 = gate.refresh();
    const r2 = gate.refresh();
    assert.equal(r1, r2);
    await r1;
    assert.equal(reads, 2);
    // 뒤따르는 읽기가 끝난 뒤에는 다시 새로 읽는다
    await gate.refresh();
    assert.equal(reads, 3);
  });

  it('폴링 응답(변경 전) → 뒤따르는 읽기(변경 뒤) 순으로 적용되어 화면이 변경 전으로 되돌아가지 않는다', async () => {
    const server = fakeServer();
    const applied: Snap[] = [];
    const gate = createRefreshGate<Snap>({ read: server.read, onValue: (v) => applied.push(v), onError: () => {} });
    server.setDelay(40);
    const old = gate.poll();
    await tick(5);
    server.start();
    server.setDelay(5);
    const fresh = gate.refresh();
    await Promise.all([old, fresh]);
    assert.deepEqual(
      applied.map((s) => s.startedAtMs),
      [null, 1000],
    );
  });

  it('읽기 실패는 onError 로 올리고 null 을 돌려주며, 다음 refresh 는 다시 읽는다', async () => {
    let n = 0;
    const errors: unknown[] = [];
    const values: number[] = [];
    const gate = createRefreshGate<number>({
      read: () => {
        n += 1;
        return n === 1 ? Promise.reject(new Error('연결 끊김')) : Promise.resolve(n);
      },
      onValue: (v) => values.push(v),
      onError: (e) => errors.push(e),
    });
    assert.equal(await gate.poll(), null);
    assert.equal(errors.length, 1);
    assert.equal(await gate.refresh(), 2);
    assert.deepEqual(values, [2]);
  });
});
