import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  afterReport,
  BACKOFF_MAX_MS,
  backoffMs,
  beforeReport,
  decideReport,
  distanceToTarget,
  FAR_INTERVAL_MS,
  INITIAL_REPORT_STATE,
  intervalForDistance,
  isStill,
  likelyInside,
  MAX_SAMPLE_AGE_MS,
  MID_INTERVAL_MS,
  NEAR_INTERVAL_MS,
  sampleQuality,
  SLOW_INTERVAL_MS,
  STILL_AFTER_MS,
  STILL_INTERVAL_MS,
  trackStill,
  watchOptionsFor,
  watchTier,
  NEAR_TIER_HYSTERESIS_M,
  FAR_TIER_HYSTERESIS_M,
  type ReportSample,
  type ReportState,
  type ReportTarget,
} from './reportPolicy';

// 강남역 근처. 위도 1도 ≈ 111,195m → 북쪽으로 d 미터 = d / 111195 도
const TARGET: ReportTarget = { lat: 37.4979, lng: 127.0276, radiusM: 100 };
const M_PER_DEG = 111_195;
const north = (m: number) => TARGET.lat + m / M_PER_DEG;

function at(distM: number, extra: Partial<ReportSample> = {}): ReportSample {
  return { lat: north(distM), lng: TARGET.lng, accuracyM: 10, mocked: false, atMs: 1_000_000, ...extra };
}

/** 성공 전송 한 번을 흉내 낸다 */
function sent(state: ReportState, nowMs: number, reason: ReportState['lastReason'] = 'outside', inside = false): ReportState {
  return afterReport(beforeReport(state, nowMs), { ok: true, reason, arrived: false, inside }, nowMs);
}

describe('reportPolicy 샘플 품질', () => {
  it('정확도 경계: 100m 까지 ok, 100m 초과 부정확, 1000m 까지 보냄, 1000m 초과는 버림', () => {
    assert.equal(sampleQuality({ lat: 37, lng: 127, accuracyM: 0 }), 'ok');
    assert.equal(sampleQuality({ lat: 37, lng: 127, accuracyM: 100 }), 'ok');
    assert.equal(sampleQuality({ lat: 37, lng: 127, accuracyM: 100.1 }), 'inaccurate');
    assert.equal(sampleQuality({ lat: 37, lng: 127, accuracyM: 1000 }), 'inaccurate');
    assert.equal(sampleQuality({ lat: 37, lng: 127, accuracyM: 1000.1 }), 'coarse');
  });

  it('정확도를 모르면(null) 서버처럼 검사를 건너뛴다', () => {
    assert.equal(sampleQuality({ lat: 37, lng: 127, accuracyM: null }), 'ok');
  });

  it('쓰레기 값(음수 — iOS 무효 측정 −1, NaN)과 좌표 오류는 invalid', () => {
    assert.equal(sampleQuality({ lat: 37, lng: 127, accuracyM: -1 }), 'invalid');
    assert.equal(sampleQuality({ lat: 37, lng: 127, accuracyM: Number.NaN }), 'invalid');
    assert.equal(sampleQuality({ lat: 91, lng: 127, accuracyM: 5 }), 'invalid');
    assert.equal(sampleQuality({ lat: Number.NaN, lng: 127, accuracyM: 5 }), 'invalid');
  });
});

describe('reportPolicy 거리별 간격', () => {
  it('2km 이상 30초, 300m~2km 10초, 300m 안 3초, 모르면 10초', () => {
    assert.equal(intervalForDistance(5000), FAR_INTERVAL_MS);
    assert.equal(intervalForDistance(2000), FAR_INTERVAL_MS);
    assert.equal(intervalForDistance(1999), MID_INTERVAL_MS);
    assert.equal(intervalForDistance(300), MID_INTERVAL_MS);
    assert.equal(intervalForDistance(299), NEAR_INTERVAL_MS);
    assert.equal(intervalForDistance(0), NEAR_INTERVAL_MS);
    assert.equal(intervalForDistance(null), MID_INTERVAL_MS);
    assert.equal(intervalForDistance(-1), MID_INTERVAL_MS);
    assert.equal(intervalForDistance(Number.NaN), MID_INTERVAL_MS);
  });

  it('watch 구간과 옵션은 같은 경계를 쓰고, 가까울수록 촘촘하다', () => {
    assert.equal(watchTier(2500), 'far');
    assert.equal(watchTier(800), 'mid');
    assert.equal(watchTier(null), 'mid');
    assert.equal(watchTier(50), 'near');
    const far = watchOptionsFor('far');
    const mid = watchOptionsFor('mid');
    const near = watchOptionsFor('near');
    assert.ok(far.distanceIntervalM > mid.distanceIntervalM && mid.distanceIntervalM > near.distanceIntervalM);
    // 샘플은 전송 간격보다 촘촘해야 한다
    assert.ok(far.timeIntervalMs <= FAR_INTERVAL_MS && mid.timeIntervalMs <= MID_INTERVAL_MS && near.timeIntervalMs <= NEAR_INTERVAL_MS);
  });

  it('목적지까지 거리는 반올림한 미터, 좌표가 틀리면 null', () => {
    const d = distanceToTarget(at(1500), TARGET);
    assert.ok(d !== null && Math.abs(d - 1500) <= 2);
    assert.equal(distanceToTarget({ lat: 200, lng: 0 }, TARGET), null);
  });
});

describe('reportPolicy 반경 추정', () => {
  it('거리 − min(정확도, 300) ≤ 반경 이면 안으로 본다(경계 포함)', () => {
    assert.equal(likelyInside(100, 0, 100), true);
    assert.equal(likelyInside(101, null, 100), false);
    assert.equal(likelyInside(150, 50, 100), true);
    assert.equal(likelyInside(151, 50, 100), false);
    // 오차는 300m 까지만 빼 준다
    assert.equal(likelyInside(400, 2000, 100), true);
    assert.equal(likelyInside(401, 2000, 100), false);
    assert.equal(likelyInside(null, 10, 100), false);
  });
});

describe('reportPolicy 전송 결정', () => {
  it('처음에는 바로 보낸다', () => {
    const d = decideReport(INITIAL_REPORT_STATE, at(1500), TARGET, 1_000_000);
    assert.equal(d.send, true);
    assert.equal(d.why, 'first');
    assert.equal(d.nextInMs, MID_INTERVAL_MS);
  });

  it('위치가 없으면 안 보낸다', () => {
    const d = decideReport(INITIAL_REPORT_STATE, null, TARGET, 1_000_000);
    assert.deepEqual([d.send, d.why], [false, 'noSample']);
  });

  it('정확도 1000m 초과 샘플은 버린다(coarse) — 거리는 표시용으로 준다', () => {
    const d = decideReport(INITIAL_REPORT_STATE, at(500, { accuracyM: 2000 }), TARGET, 1_000_000);
    assert.equal(d.send, false);
    assert.equal(d.why, 'coarse');
    assert.ok(d.distanceM !== null);
  });

  it('좌표 오류는 버린다', () => {
    const d = decideReport(INITIAL_REPORT_STATE, { ...at(500), lat: 999 }, TARGET, 1_000_000);
    assert.deepEqual([d.send, d.why], [false, 'invalid']);
  });

  it('정확도 100m 초과는 보내되 품질은 부정확으로 표시한다', () => {
    const d = decideReport(INITIAL_REPORT_STATE, at(1500, { accuracyM: 180 }), TARGET, 1_000_000);
    assert.equal(d.send, true);
    assert.equal(d.quality, 'inaccurate');
  });

  it('10분보다 오래된 샘플은 보내지 않고, 10분 안이면 보낸다', () => {
    const s = at(1500, { atMs: 0 });
    assert.equal(decideReport(INITIAL_REPORT_STATE, s, TARGET, MAX_SAMPLE_AGE_MS).send, true);
    const d = decideReport(INITIAL_REPORT_STATE, s, TARGET, MAX_SAMPLE_AGE_MS + 1);
    assert.deepEqual([d.send, d.why], [false, 'stale']);
  });

  it('거리 구간별 간격 경계: 2km 밖은 30초가 되기 전엔 기다리고 30초에 보낸다', () => {
    const t0 = 1_000_000;
    const st = sent(INITIAL_REPORT_STATE, t0);
    const s = at(3000, { atMs: t0 });
    const wait = decideReport(st, s, TARGET, t0 + FAR_INTERVAL_MS - 1);
    assert.deepEqual([wait.send, wait.why, wait.nextInMs], [false, 'wait', 1]);
    const go = decideReport(st, s, TARGET, t0 + FAR_INTERVAL_MS);
    assert.deepEqual([go.send, go.why], [true, 'due']);
  });

  it('300m~2km 는 10초, 300m 안은 3초', () => {
    const t0 = 1_000_000;
    const st = sent(INITIAL_REPORT_STATE, t0);
    assert.equal(decideReport(st, at(1000, { atMs: t0 }), TARGET, t0 + MID_INTERVAL_MS - 1).send, false);
    assert.equal(decideReport(st, at(1000, { atMs: t0 }), TARGET, t0 + MID_INTERVAL_MS).send, true);
    assert.equal(decideReport(st, at(250, { atMs: t0 }), TARGET, t0 + NEAR_INTERVAL_MS - 1).send, false);
    assert.equal(decideReport(st, at(250, { atMs: t0 }), TARGET, t0 + NEAR_INTERVAL_MS).send, true);
  });

  it('반경 추정 진입: 직전 전송이 밖이었으면 간격을 무시하고 즉시 보낸다', () => {
    const t0 = 1_000_000;
    const st = sent(INITIAL_REPORT_STATE, t0, 'outside', false);
    const d = decideReport(st, at(80, { atMs: t0 + 500 }), TARGET, t0 + 500);
    assert.deepEqual([d.send, d.why], [true, 'entered']);
  });

  it('계속 반경 안이면 즉시가 아니라 3초마다', () => {
    const t0 = 1_000_000;
    const st = sent(INITIAL_REPORT_STATE, t0, 'low_accuracy', true);
    assert.equal(decideReport(st, at(80, { atMs: t0 }), TARGET, t0 + 500).send, false);
    assert.equal(decideReport(st, at(80, { atMs: t0 }), TARGET, t0 + NEAR_INTERVAL_MS).send, true);
  });

  it('부정확해도 오차를 빼면 반경 안이면 진입으로 본다(서버가 근처에 온 시각을 남긴다)', () => {
    const t0 = 1_000_000;
    const st = sent(INITIAL_REPORT_STATE, t0);
    const d = decideReport(st, at(250, { accuracyM: 180, atMs: t0 }), TARGET, t0 + 100);
    assert.deepEqual([d.send, d.why, d.quality], [true, 'entered', 'inaccurate']);
  });

  it('모의 위치: 처음 본 순간 즉시 보내고(서버가 mocked 로 거부), 그 뒤 30초', () => {
    const t0 = 1_000_000;
    const st = sent(INITIAL_REPORT_STATE, t0, 'outside');
    const first = decideReport(st, at(1000, { mocked: true, atMs: t0 }), TARGET, t0 + 100);
    assert.deepEqual([first.send, first.why], [true, 'mockedFirst']);
    const after = sent(st, t0 + 100, 'mocked');
    assert.equal(decideReport(after, at(1000, { mocked: true }), TARGET, t0 + 100 + SLOW_INTERVAL_MS - 1).send, false);
    assert.equal(decideReport(after, at(1000, { mocked: true }), TARGET, t0 + 100 + SLOW_INTERVAL_MS).send, true);
  });

  it('모의 위치로 반경 안이어도 진입 즉시 전송은 하지 않는다', () => {
    const t0 = 1_000_000;
    const st = sent(INITIAL_REPORT_STATE, t0, 'mocked');
    const d = decideReport(st, at(10, { mocked: true }), TARGET, t0 + 100);
    assert.equal(d.send, false);
  });

  it('처음 샘플이 모의 위치면 mockedFirst', () => {
    const d = decideReport(INITIAL_REPORT_STATE, at(1000, { mocked: true }), TARGET, 1_000_000);
    assert.deepEqual([d.send, d.why], [true, 'mockedFirst']);
  });

  it('모의 위치를 끄면 30초를 기다리지 않고 바로 다시 보낸다', () => {
    const t0 = 1_000_000;
    const st = sent(INITIAL_REPORT_STATE, t0, 'mocked');
    const d = decideReport(st, at(1000), TARGET, t0 + 100);
    assert.deepEqual([d.send, d.why], [true, 'due']);
  });

  it('not_open 을 받으면 30초', () => {
    const t0 = 1_000_000;
    const st = sent(INITIAL_REPORT_STATE, t0, 'not_open');
    assert.equal(decideReport(st, at(50), TARGET, t0 + SLOW_INTERVAL_MS - 1).send, false);
    assert.equal(decideReport(st, at(50), TARGET, t0 + SLOW_INTERVAL_MS).send, true);
  });

  it('closed · already_arrived · 도착이면 더 보내지 않는다', () => {
    for (const reason of ['closed', 'already_arrived'] as const) {
      const st = sent(INITIAL_REPORT_STATE, 0, reason);
      assert.equal(st.stopped, true);
      assert.deepEqual([decideReport(st, at(10), TARGET, 999_999).send, decideReport(st, at(10), TARGET, 999_999).why], [false, 'stopped']);
    }
    const arrived = afterReport(INITIAL_REPORT_STATE, { ok: true, reason: null, arrived: true, inside: true }, 0);
    assert.equal(arrived.stopped, true);
    // 반경 밖·부정확·모의는 계속 보낸다
    for (const reason of ['outside', 'low_accuracy', 'mocked', 'not_open', 'bad_position'] as const) {
      assert.equal(sent(INITIAL_REPORT_STATE, 0, reason).stopped, false);
    }
  });
});

describe('reportPolicy 실패 백오프', () => {
  it('3초 → 6초 → 12초 → 24초 → 30초 상한', () => {
    assert.equal(backoffMs(0), 0);
    assert.equal(backoffMs(1), 3_000);
    assert.equal(backoffMs(2), 6_000);
    assert.equal(backoffMs(3), 12_000);
    assert.equal(backoffMs(4), 24_000);
    assert.equal(backoffMs(5), BACKOFF_MAX_MS);
    assert.equal(backoffMs(50), BACKOFF_MAX_MS);
    assert.equal(backoffMs(Number.NaN), 0);
  });

  it('실패 중에는 거리 간격(30초) 대신 백오프를 따르고, 성공하면 초기화된다', () => {
    const t0 = 1_000_000;
    let st = afterReport(beforeReport(INITIAL_REPORT_STATE, t0), { ok: false }, t0);
    assert.equal(st.failures, 1);
    const far = at(5000, { atMs: t0 });
    const wait = decideReport(st, far, TARGET, t0 + 2_999);
    assert.deepEqual([wait.send, wait.why, wait.nextInMs], [false, 'backoff', 1]);
    assert.deepEqual([decideReport(st, far, TARGET, t0 + 3_000).send, decideReport(st, far, TARGET, t0 + 3_000).why], [true, 'retry']);

    st = afterReport(beforeReport(st, t0 + 3_000), { ok: false }, t0 + 3_000);
    assert.equal(st.failures, 2);
    assert.equal(decideReport(st, far, TARGET, t0 + 3_000 + 5_999).send, false);
    assert.equal(decideReport(st, far, TARGET, t0 + 3_000 + 6_000).send, true);

    st = sent(st, t0 + 9_000);
    assert.equal(st.failures, 0);
    assert.equal(decideReport(st, far, TARGET, t0 + 9_000 + 3_000).send, false);
    assert.equal(decideReport(st, far, TARGET, t0 + 9_000 + FAR_INTERVAL_MS).send, true);
  });

  it('실패가 쌓여도 대기는 30초를 넘지 않는다', () => {
    let st: ReportState = INITIAL_REPORT_STATE;
    for (let i = 0; i < 12; i += 1) st = afterReport(st, { ok: false }, 0);
    assert.equal(decideReport(st, at(5000, { atMs: 0 }), TARGET, BACKOFF_MAX_MS).send, true);
    assert.equal(decideReport(st, at(5000, { atMs: 0 }), TARGET, BACKOFF_MAX_MS - 1).send, false);
  });

  it('보내는 중(beforeReport)에는 시도 시각이 먼저 찍혀 겹쳐 보내지 않는다', () => {
    const t0 = 1_000_000;
    const inflight = beforeReport(sent(INITIAL_REPORT_STATE, t0 - FAR_INTERVAL_MS), t0);
    assert.equal(inflight.lastAttemptAtMs, t0);
  });
});

describe('reportPolicy 제자리', () => {
  it('20m 안에서 60초 넘게 머물면 간격을 60초로 늘린다', () => {
    const t0 = 1_000_000;
    let st = trackStill(INITIAL_REPORT_STATE, at(1000, { atMs: t0 }));
    st = trackStill(st, at(1010, { atMs: t0 + 30_000 })); // 10m 흔들림 — 같은 자리
    assert.equal(st.stillSinceMs, t0);
    assert.equal(isStill(st, t0 + STILL_AFTER_MS - 1), false);
    assert.equal(isStill(st, t0 + STILL_AFTER_MS), true);

    const lastSent = t0 + STILL_AFTER_MS;
    st = sent(st, lastSent);
    const s = at(1005, { atMs: lastSent });
    assert.equal(decideReport(st, s, TARGET, lastSent + MID_INTERVAL_MS).send, false);
    assert.equal(decideReport(st, s, TARGET, lastSent + STILL_INTERVAL_MS).send, true);
  });

  it('20m 넘게 움직이면 제자리 기준점을 새로 잡는다', () => {
    const t0 = 1_000_000;
    let st = trackStill(INITIAL_REPORT_STATE, at(1000, { atMs: t0 }));
    st = trackStill(st, at(1050, { atMs: t0 + 90_000 }));
    assert.equal(st.stillSinceMs, t0 + 90_000);
    assert.equal(isStill(st, t0 + 90_000 + 1), false);
  });

  it('반경 안이면 제자리여도 3초', () => {
    const t0 = 1_000_000;
    let st = trackStill(INITIAL_REPORT_STATE, at(50, { atMs: t0 }));
    st = sent(st, t0 + STILL_AFTER_MS, 'low_accuracy', true);
    const s = at(50, { atMs: t0 + STILL_AFTER_MS });
    assert.equal(decideReport(st, s, TARGET, t0 + STILL_AFTER_MS + NEAR_INTERVAL_MS).send, true);
  });

  it('좌표 오류 샘플은 제자리 추적을 바꾸지 않는다', () => {
    const st = trackStill(INITIAL_REPORT_STATE, at(1000));
    assert.equal(trackStill(st, { ...at(1000), lat: Number.NaN }), st);
  });
});

describe('watch 구간 이력(hysteresis)', () => {
  it('300m 경계에서 ±10m 흔들려도 구간이 뒤집히지 않는다', () => {
    let tier = watchTier(295, 'mid');
    assert.equal(tier, 'mid');
    for (const d of [305, 298, 302, 296, 309, 291, 310]) {
      tier = watchTier(d, tier);
      assert.equal(tier, 'mid', `${d}m`);
    }
    // near 에 들어간 뒤에도 마찬가지
    tier = 'near';
    for (const d of [295, 305, 298, 302, 296, 309]) {
      tier = watchTier(d, tier);
      assert.equal(tier, 'near', `${d}m`);
    }
  });

  it('이력 폭을 넘으면 바뀐다', () => {
    assert.equal(watchTier(300 - NEAR_TIER_HYSTERESIS_M - 1, 'mid'), 'near');
    assert.equal(watchTier(300 + NEAR_TIER_HYSTERESIS_M + 1, 'near'), 'mid');
    assert.equal(watchTier(2000 + FAR_TIER_HYSTERESIS_M + 1, 'mid'), 'far');
    assert.equal(watchTier(2000 - FAR_TIER_HYSTERESIS_M - 1, 'far'), 'mid');
  });

  it('2km 경계에서도 흔들림에 버틴다', () => {
    let tier = watchTier(1995, 'mid');
    for (const d of [2005, 1998, 2003, 2050, 1960]) {
      tier = watchTier(d, tier);
      assert.equal(tier, 'mid', `${d}m`);
    }
    tier = 'far';
    for (const d of [1995, 2005, 1950, 2003]) {
      tier = watchTier(d, tier);
      assert.equal(tier, 'far', `${d}m`);
    }
  });

  it('멀리 건너뛰면 바로 바뀌고, 모르는 거리는 이력 없이 mid', () => {
    assert.equal(watchTier(50, 'far'), 'near');
    assert.equal(watchTier(5000, 'near'), 'far');
    assert.equal(watchTier(null, 'near'), 'mid');
    assert.equal(watchTier(NaN, 'far'), 'mid');
  });

  it('지금 구간을 안 주면 예전처럼 문턱만 본다', () => {
    assert.equal(watchTier(299), 'near');
    assert.equal(watchTier(300), 'mid');
    assert.equal(watchTier(2000), 'far');
  });
});
