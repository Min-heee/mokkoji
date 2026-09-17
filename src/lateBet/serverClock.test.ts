import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServerClock, withClockSample } from './serverClock';

describe('serverClock', () => {
  it('샘플이 없으면 기기 시각 그대로, 샘플이 오면 왕복의 가운데를 기준으로 보정한다', () => {
    let device = 1_000_000;
    const clock = createServerClock(() => device);
    assert.equal(clock.now(), 1_000_000);
    assert.equal(clock.hasSample(), false);
    // 기기가 1시간 느리다: 요청 t0=1,000,000 응답 t1=1,000,200, 서버는 그 가운데에 +1h
    assert.equal(clock.addSample(1_000_100 + 3_600_000, 1_000_000, 1_000_200), true);
    assert.equal(clock.offsetMs(), 3_600_000);
    device = 1_005_000;
    assert.equal(clock.now(), 1_005_000 + 3_600_000);
  });

  it('RTT 800ms 초과 샘플은 버린다 — 단 첫 샘플은 임시로 받고 좋은 샘플이 오면 바꾼다', () => {
    const clock = createServerClock(() => 0);
    assert.equal(clock.addSample(10_000, 0, 2_000), true);
    assert.equal(clock.offsetMs(), 9_000);
    assert.equal(clock.addSample(20_000, 0, 2_000), true); // 아직 임시라 또 받는다
    assert.equal(clock.addSample(5_100, 0, 200), true);
    assert.equal(clock.offsetMs(), 5_000);
    assert.equal(clock.addSample(99_000, 0, 2_000), false);
    assert.equal(clock.offsetMs(), 5_000);
    assert.equal(clock.addSample(Number.NaN, 0, 1), false);
  });

  it('오프셋이 바뀔 때만 구독자를 부른다 (가짜 서버의 시간 빨리 감기가 즉시 반영된다)', async () => {
    let device = 0;
    const clock = createServerClock(() => device);
    let calls = 0;
    const off = clock.subscribe(() => {
      calls += 1;
    });
    await withClockSample(async () => ({ serverNowMs: 600_000 }), clock, () => device);
    await withClockSample(async () => ({ serverNowMs: 600_000 }), clock, () => device);
    assert.equal(calls, 1);
    device = 50;
    off();
    clock.addSample(1, 0, 0);
    assert.equal(calls, 1);
  });
});
