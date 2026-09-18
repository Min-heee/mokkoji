import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mulberry32 } from './betting';
import {
  closeAtMs,
  DEFAULT_LATE_POLICY,
  fullForfeitAtMs,
  isLocationShared,
  lateUnits,
  locationShareWindow,
  MAX_EPOCH_MS,
  MAX_SHARE_AFTER_DEADLINE_MINUTES,
  MAX_STAKE,
  SHARE_TAIL_AFTER_FULL_FORFEIT_MINUTES,
  normalizeLatePolicy,
  penaltyFor,
  projectedPenalty,
  settleLateBet,
  type ArrivalRecord,
  type LateBetResult,
  type LatePolicy,
} from './lateBet';

const MIN = 60_000;
/** 약속 시각 (2026-09-17T10:00:00Z — 값 자체는 의미 없다, 타임존 무관) */
const DEADLINE = 1_789_639_200_000;

/** 기본 테스트 정책: 1000포인트, 5분마다 100포인트 차감 */
const policy = (over: Partial<LatePolicy> = {}): LatePolicy => ({
  stake: 1000,
  radiusM: 100,
  unitMinutes: 5,
  penaltyPerUnit: 100,
  graceMinutes: 0,
  ...over,
});

/** 마감 기준 상대 분으로 도착 기록 (음수 = 일찍) */
const at = (personId: string, minutesFromDeadline: number | null): ArrivalRecord => ({
  personId,
  arrivedAtMs: minutesFromDeadline === null ? null : DEADLINE + minutesFromDeadline * MIN,
});

const byId = (res: LateBetResult, id: string) => {
  const r = res.persons.find((x) => x.personId === id);
  assert.ok(r, `${id} 없음`);
  return r;
};

/** 모든 정산 결과가 지켜야 하는 불변식 */
function assertInvariants(res: LateBetResult, stake: number) {
  let net = 0;
  let forfeited = 0;
  let received = 0;
  for (const r of res.persons) {
    for (const v of [r.forfeited, r.received, r.net, r.lateMinutes]) {
      assert.ok(Number.isSafeInteger(v), `정수 아님: ${JSON.stringify(r)}`);
    }
    assert.ok(r.forfeited >= 0 && r.forfeited <= stake, `forfeited 범위: ${JSON.stringify(r)}`);
    assert.ok(r.received >= 0);
    assert.ok(r.lateMinutes >= 0);
    assert.equal(r.net, r.received - r.forfeited);
    if (r.status !== 'onTime') assert.equal(r.received, 0, '지각·노쇼는 받지 못한다');
    if (r.status === 'onTime') assert.equal(r.forfeited, 0, '정시 도착은 잃지 않는다');
    if (r.status === 'noShow') assert.equal(r.arrivedAtMs, null);
    net += r.net;
    forfeited += r.forfeited;
    received += r.received;
  }
  assert.equal(net, 0, 'sum(net) === 0');
  assert.equal(forfeited, res.pot);
  assert.equal(received, res.pot);
  assert.ok(Number.isSafeInteger(res.pot) && res.pot >= 0);
  assert.equal(res.voided, res.voidReason !== null);
  if (res.voided) assert.equal(res.pot, 0);
}

describe('normalizeLatePolicy', () => {
  it('객체가 아니면 기본 정책 (매번 새 객체)', () => {
    for (const raw of [null, undefined, 'x', 42, NaN, true]) {
      assert.deepEqual(normalizeLatePolicy(raw), DEFAULT_LATE_POLICY);
    }
    assert.notEqual(normalizeLatePolicy(null), DEFAULT_LATE_POLICY);
    assert.deepEqual(normalizeLatePolicy({}), DEFAULT_LATE_POLICY);
  });

  it('정상 값은 그대로 통과', () => {
    const p = policy({ graceMinutes: 3 });
    assert.deepEqual(normalizeLatePolicy(p), p);
  });

  it('NaN·Infinity·문자열·null 필드는 기본값으로', () => {
    assert.deepEqual(
      normalizeLatePolicy({
        stake: NaN,
        radiusM: Infinity,
        unitMinutes: '5',
        penaltyPerUnit: null,
        graceMinutes: -Infinity,
      }),
      DEFAULT_LATE_POLICY,
    );
  });

  it('음수는 하한으로, 소수는 내림, 너무 큰 값은 상한으로', () => {
    const p = normalizeLatePolicy({
      stake: -500,
      radiusM: -1,
      unitMinutes: 0,
      penaltyPerUnit: -3,
      graceMinutes: -2,
    });
    assert.deepEqual(p, {
      stake: 0,
      radiusM: 30,
      unitMinutes: 1,
      penaltyPerUnit: 0,
      graceMinutes: 0,
    });
    const q = normalizeLatePolicy({
      stake: 999.9,
      radiusM: 5000,
      unitMinutes: 2.7,
      penaltyPerUnit: 1e30,
      graceMinutes: 1.5,
    });
    assert.deepEqual(q, {
      stake: 999,
      radiusM: 1000,
      unitMinutes: 2,
      penaltyPerUnit: MAX_STAKE,
      graceMinutes: 1,
    });
  });

  it('unitMinutes 0.5처럼 내림하면 0이 되는 값도 1 이상을 보장 (0으로 나누기 방지)', () => {
    assert.equal(normalizeLatePolicy({ unitMinutes: 0.5 }).unitMinutes, 1);
  });

  it('멱등이다', () => {
    const once = normalizeLatePolicy({ stake: 12.3, radiusM: 10, unitMinutes: -1 });
    assert.deepEqual(normalizeLatePolicy(once), once);
  });
});

describe('lateUnits', () => {
  it('마감 전·정확히 마감 시각은 0, +1ms는 1단위', () => {
    const p = policy();
    assert.equal(lateUnits(p, DEADLINE, DEADLINE - 30 * MIN), 0);
    assert.equal(lateUnits(p, DEADLINE, DEADLINE), 0);
    assert.equal(lateUnits(p, DEADLINE, DEADLINE + 1), 1);
  });

  it('unitMinutes 경계: 정확히 1단위는 1, +1ms는 2', () => {
    const p = policy({ unitMinutes: 5 });
    assert.equal(lateUnits(p, DEADLINE, DEADLINE + 5 * MIN), 1);
    assert.equal(lateUnits(p, DEADLINE, DEADLINE + 5 * MIN + 1), 2);
    assert.equal(lateUnits(p, DEADLINE, DEADLINE + 10 * MIN), 2);
    assert.equal(lateUnits(policy({ unitMinutes: 1 }), DEADLINE, DEADLINE + 7 * MIN + 1), 8);
  });

  it('grace 경계: 정확히 마감+grace는 0, +1ms는 1단위 (단위는 grace 뒤부터 센다)', () => {
    const p = policy({ graceMinutes: 3 });
    assert.equal(lateUnits(p, DEADLINE, DEADLINE + 3 * MIN), 0);
    assert.equal(lateUnits(p, DEADLINE, DEADLINE + 3 * MIN + 1), 1);
    assert.equal(lateUnits(p, DEADLINE, DEADLINE + 8 * MIN), 1);
    assert.equal(lateUnits(p, DEADLINE, DEADLINE + 8 * MIN + 1), 2);
  });

  it('쓰레기 시각은 0 (판정 불가)', () => {
    assert.equal(lateUnits(policy(), NaN, DEADLINE), 0);
    assert.equal(lateUnits(policy(), DEADLINE, NaN), 0);
    assert.equal(lateUnits(policy(), DEADLINE, Infinity), 0);
  });

  it('유한 거대 시각(±1e308·1e21·2**53)도 쓰레기 → 0, Infinity를 돌려주지 않는다', () => {
    // 리뷰 재현: 예전엔 lateUnits(p, -1e308, 1e308) === Infinity, (p, DEADLINE, 1e308) === 3.33e302
    assert.equal(lateUnits(policy(), -1e308, 1e308), 0);
    for (const huge of [1e308, -1e308, 1e21, 2 ** 53, -(2 ** 53), MAX_EPOCH_MS + 1]) {
      assert.equal(lateUnits(policy(), DEADLINE, huge), 0, `도착 ${huge}`);
      assert.equal(lateUnits(policy(), huge, DEADLINE), 0, `마감 ${huge}`);
    }
  });

  it('Date 범위 양끝(±8.64e15)끼리의 차이도 안전 정수 단위 수', () => {
    const units = lateUnits(policy({ unitMinutes: 1 }), -MAX_EPOCH_MS, MAX_EPOCH_MS);
    assert.ok(Number.isSafeInteger(units));
    assert.equal(units, (2 * MAX_EPOCH_MS) / MIN);
    assert.equal(lateUnits(policy(), MAX_EPOCH_MS, -MAX_EPOCH_MS), 0);
  });
});

describe('penaltyFor', () => {
  it('정시는 0, 지각은 단위 × 차감액', () => {
    const p = policy();
    assert.equal(penaltyFor(p, DEADLINE, DEADLINE), 0);
    assert.equal(penaltyFor(p, DEADLINE, DEADLINE + 1), 100);
    assert.equal(penaltyFor(p, DEADLINE, DEADLINE + 12 * MIN), 300);
  });

  it('상한: stake를 넘겨 차감하지 않는다', () => {
    const p = policy({ stake: 250, penaltyPerUnit: 100 });
    assert.equal(penaltyFor(p, DEADLINE, DEADLINE + 10 * MIN), 200);
    assert.equal(penaltyFor(p, DEADLINE, DEADLINE + 10 * MIN + 1), 250);
    assert.equal(penaltyFor(p, DEADLINE, DEADLINE + 1000 * MIN), 250);
    // 아주 먼 미래여도 안전 정수 안에서 stake
    assert.equal(penaltyFor(policy({ stake: MAX_STAKE, penaltyPerUnit: MAX_STAKE - 1, unitMinutes: 1 }), 0, 8.64e15), MAX_STAKE);
  });

  it('노쇼(null)는 stake 전액 — 단위 차감이 0이어도', () => {
    assert.equal(penaltyFor(policy(), DEADLINE, null), 1000);
    assert.equal(penaltyFor(policy({ penaltyPerUnit: 0 }), DEADLINE, null), 1000);
  });

  it('단위 차감이 0이면 아무리 늦어도 0', () => {
    assert.equal(penaltyFor(policy({ penaltyPerUnit: 0 }), DEADLINE, DEADLINE + 500 * MIN), 0);
  });

  it('쓰레기 도착 시각은 노쇼 취급, 쓰레기 마감은 0', () => {
    assert.equal(penaltyFor(policy(), DEADLINE, NaN), 1000);
    assert.equal(penaltyFor(policy(), DEADLINE, Infinity), 1000);
    assert.equal(penaltyFor(policy(), NaN, DEADLINE), 0);
    assert.equal(penaltyFor(policy(), Infinity, null), 0);
    // 유한 거대값도 같은 취급 (도착 → 노쇼 전액, 마감 → 0)
    assert.equal(penaltyFor(policy(), DEADLINE, 1e308), 1000);
    assert.equal(penaltyFor(policy(), DEADLINE, -1e308), 1000);
    assert.equal(penaltyFor(policy(), 1e308, DEADLINE), 0);
    assert.equal(penaltyFor(policy(), -1e308, 1e308), 0);
  });

  it('쓰레기 정책도 정규화해서 정수만 돌려준다', () => {
    const dirty = { ...policy(), stake: 1000.7, penaltyPerUnit: 33.9, unitMinutes: NaN } as LatePolicy;
    // stake 1000, 단위 5분(기본), 33포인트
    assert.equal(penaltyFor(dirty, DEADLINE, DEADLINE + 6 * MIN), 66);
    assert.equal(penaltyFor({ ...policy(), stake: -5 }, DEADLINE, null), 0);
  });
});

describe('fullForfeitAtMs / projectedPenalty', () => {
  it('그 시각까지는 전액 미만, 1ms 뒤부터 전액', () => {
    const cases = [
      policy(), // 10단위
      policy({ stake: 250 }), // 3단위 (올림)
      policy({ graceMinutes: 7, unitMinutes: 1, penaltyPerUnit: 1, stake: 30 }),
      policy({ penaltyPerUnit: 5000 }), // 1단위 만에 전액 → 마감+grace
    ];
    for (const p of cases) {
      const t = fullForfeitAtMs(p, DEADLINE);
      assert.ok(t !== null);
      assert.ok(penaltyFor(p, DEADLINE, t) < p.stake, JSON.stringify(p));
      assert.equal(penaltyFor(p, DEADLINE, t + 1), p.stake, JSON.stringify(p));
    }
    assert.equal(fullForfeitAtMs(policy(), DEADLINE), DEADLINE + 45 * MIN);
    assert.equal(fullForfeitAtMs(policy({ penaltyPerUnit: 5000, graceMinutes: 2 }), DEADLINE), DEADLINE + 2 * MIN);
  });

  it('단위 차감 0 · stake 0 · 쓰레기 마감이면 null', () => {
    assert.equal(fullForfeitAtMs(policy({ penaltyPerUnit: 0 }), DEADLINE), null);
    assert.equal(fullForfeitAtMs(policy({ stake: 0 }), DEADLINE), null);
    assert.equal(fullForfeitAtMs(policy(), NaN), null);
    assert.equal(fullForfeitAtMs(policy(), 1e308), null);
    assert.equal(fullForfeitAtMs(policy(), -(2 ** 53)), null);
  });

  it('projectedPenalty = 지금 도착하면 잃는 포인트', () => {
    const p = policy();
    assert.equal(projectedPenalty(p, DEADLINE, DEADLINE - MIN), 0);
    assert.equal(projectedPenalty(p, DEADLINE, DEADLINE + 1), 100);
    assert.equal(projectedPenalty(p, DEADLINE, DEADLINE + 7 * MIN), 200);
    assert.equal(projectedPenalty(p, DEADLINE, DEADLINE + 999 * MIN), 1000);
    assert.equal(projectedPenalty(p, DEADLINE, NaN), 0);
    assert.equal(projectedPenalty(p, DEADLINE, Infinity), 0);
    assert.equal(projectedPenalty(p, DEADLINE, 1e308), 0); // 유한 거대값도 쓰레기 시각
  });
});

describe('settleLateBet', () => {
  const ABC = ['a', 'b', 'c'];

  it('전원 정시 도착: 아무도 안 잃는 정상 종료 (무효 아님)', () => {
    const res = settleLateBet(policy(), ABC, [at('a', -10), at('b', -1), at('c', 0)], DEADLINE);
    assert.equal(res.pot, 0);
    assert.equal(res.voided, false);
    assert.equal(res.voidReason, null);
    for (const r of res.persons) {
      assert.equal(r.status, 'onTime');
      assert.equal(r.net, 0);
    }
    assertInvariants(res, 1000);
  });

  it('1명 지각: 잃은 포인트를 정시 도착자들이 나눠 갖는다', () => {
    const res = settleLateBet(policy(), ABC, [at('a', -5), at('b', -2), at('c', 7)], DEADLINE);
    assert.equal(res.pot, 200);
    assert.deepEqual(byId(res, 'c'), {
      personId: 'c',
      arrivedAtMs: DEADLINE + 7 * MIN,
      status: 'late',
      lateMinutes: 7,
      forfeited: 200,
      received: 0,
      net: -200,
    });
    assert.equal(byId(res, 'a').net, 100);
    assert.equal(byId(res, 'b').net, 100);
    assert.equal(res.voided, false);
    assertInvariants(res, 1000);
  });

  it('여러 명 지각: 지각자는 서로의 포인트를 받지 못한다', () => {
    const res = settleLateBet(
      policy(),
      ['a', 'b', 'c', 'd'],
      [at('a', -5), at('b', 3), at('c', 12), at('d', 500)],
      DEADLINE,
    );
    assert.equal(byId(res, 'b').forfeited, 100);
    assert.equal(byId(res, 'c').forfeited, 300);
    assert.equal(byId(res, 'd').forfeited, 1000);
    assert.equal(res.pot, 1400);
    assert.equal(byId(res, 'a').received, 1400);
    assert.equal(byId(res, 'b').received, 0);
    assertInvariants(res, 1000);
  });

  it('노쇼: 기록 없음·null 모두 stake 전액 몰수', () => {
    const res = settleLateBet(policy(), ABC, [at('a', -5), at('b', null)], DEADLINE);
    for (const id of ['b', 'c']) {
      const r = byId(res, id);
      assert.equal(r.status, 'noShow');
      assert.equal(r.arrivedAtMs, null);
      assert.equal(r.lateMinutes, 0);
      assert.equal(r.forfeited, 1000);
    }
    assert.equal(byId(res, 'a').received, 2000);
    assertInvariants(res, 1000);
  });

  it('전원 지각·노쇼: 받을 사람이 없어 무효, 전원 환불', () => {
    const res = settleLateBet(policy(), ABC, [at('a', 1), at('b', 30)], DEADLINE);
    assert.equal(res.voided, true);
    assert.equal(res.voidReason, 'noWinner');
    assert.equal(res.pot, 0);
    assert.deepEqual(
      res.persons.map((r) => [r.status, r.forfeited, r.received, r.net]),
      [
        ['late', 0, 0, 0],
        ['late', 0, 0, 0],
        ['noShow', 0, 0, 0],
      ],
    );
    assert.equal(byId(res, 'b').lateMinutes, 30);
    assertInvariants(res, 1000);
  });

  it('stake 0: 내기 없음으로 무효 (상태는 그대로 알려준다)', () => {
    const res = settleLateBet(policy({ stake: 0 }), ABC, [at('a', -1), at('b', 9)], DEADLINE);
    assert.equal(res.voided, true);
    assert.equal(res.voidReason, 'noStake');
    assert.deepEqual(
      res.persons.map((r) => r.status),
      ['onTime', 'late', 'noShow'],
    );
    assertInvariants(res, 0);
  });

  it('전원 지각이어도 잃은 포인트가 0이면(단위 차감 0) 무효가 아닌 정상 종료', () => {
    const res = settleLateBet(policy({ penaltyPerUnit: 0 }), ['a', 'b'], [at('a', 5), at('b', 9)], DEADLINE);
    assert.equal(res.voided, false);
    assert.equal(res.pot, 0);
    assertInvariants(res, 1000);
  });

  it('나머지 포인트는 가장 일찍 온 순으로 1포인트씩 — 입력 순서와 무관하게 결정적', () => {
    // pot = 1000, 정시 3명 → 333씩 + 나머지 1은 가장 일찍 온 c에게
    const ids = ['a', 'b', 'c', 'x'];
    const arrivals = [at('a', -5), at('b', -1), at('c', -20), at('x', null)];
    const res = settleLateBet(policy(), ids, arrivals, DEADLINE);
    assert.equal(byId(res, 'c').received, 334);
    assert.equal(byId(res, 'a').received, 333);
    assert.equal(byId(res, 'b').received, 333);
    assertInvariants(res, 1000);
    // arrivals 순서를 뒤집어도 같은 결과
    assert.deepEqual(settleLateBet(policy(), ids, [...arrivals].reverse(), DEADLINE), res);
  });

  it('나머지 분배: 도착 시각 동률이면 participantIds 순서', () => {
    // 나머지가 2가 되도록: 노쇼 1명(1000) + 1단위 지각(100) = pot 1100, 정시 3명 → 366씩 + 나머지 2
    const ids = ['a', 'b', 'c', 'late', 'gone'];
    const arrivals = [at('c', -3), at('b', -3), at('a', -3), at('late', 1)];
    const res = settleLateBet(policy(), ids, arrivals, DEADLINE);
    assert.equal(res.pot, 1100);
    assert.deepEqual(
      ['a', 'b', 'c'].map((id) => byId(res, id).received),
      [367, 367, 366],
    );
    // 참가자 순서를 바꾸면 그 순서를 따른다
    const res2 = settleLateBet(policy(), ['c', 'b', 'a', 'late', 'gone'], arrivals, DEADLINE);
    assert.deepEqual(
      ['a', 'b', 'c'].map((id) => byId(res2, id).received),
      [366, 367, 367],
    );
    assertInvariants(res, 1000);
    assertInvariants(res2, 1000);
  });

  it('grace 안에 온 사람은 정시 도착으로 나눠 받는다, +1ms는 지각', () => {
    const p = policy({ graceMinutes: 3 });
    const arrivals: ArrivalRecord[] = [
      { personId: 'a', arrivedAtMs: DEADLINE + 3 * MIN },
      { personId: 'b', arrivedAtMs: DEADLINE + 3 * MIN + 1 },
    ];
    const res = settleLateBet(p, ['a', 'b'], arrivals, DEADLINE);
    assert.equal(byId(res, 'a').status, 'onTime');
    assert.equal(byId(res, 'a').lateMinutes, 0);
    assert.equal(byId(res, 'a').received, 100);
    assert.equal(byId(res, 'b').status, 'late');
    // lateMinutes는 마감 기준 (grace 미차감, 올림)
    assert.equal(byId(res, 'b').lateMinutes, 4);
    assert.equal(byId(res, 'b').forfeited, 100);
    assertInvariants(res, 1000);
  });

  it('상한: 아무리 늦어도 stake까지만 잃는다', () => {
    const res = settleLateBet(policy({ stake: 250 }), ['a', 'b'], [at('a', 0), at('b', 100_000)], DEADLINE);
    assert.equal(byId(res, 'b').forfeited, 250);
    assert.equal(byId(res, 'a').received, 250);
    assertInvariants(res, 250);
  });

  it('참가자 1명: 정시면 0으로 정상 종료, 지각이면 무효', () => {
    const ok = settleLateBet(policy(), ['solo'], [at('solo', -1)], DEADLINE);
    assert.equal(ok.voided, false);
    assert.equal(ok.pot, 0);
    const late = settleLateBet(policy(), ['solo'], [at('solo', 1)], DEADLINE);
    assert.equal(late.voidReason, 'noWinner');
    assert.equal(byId(late, 'solo').net, 0);
    assertInvariants(ok, 1000);
    assertInvariants(late, 1000);
  });

  it('빈 참가자: 빈 결과로 정상 종료', () => {
    const res = settleLateBet(policy(), [], [at('ghost', -1)], DEADLINE);
    assert.deepEqual(res, { persons: [], pot: 0, voided: false, voidReason: null });
  });

  it('참가자 목록에 없는 arrival은 무시, participantIds 중복은 한 번만', () => {
    const res = settleLateBet(
      policy(),
      ['a', 'b', 'a', 'b'],
      [at('a', -1), at('ghost', -30), at('b', 6)],
      DEADLINE,
    );
    assert.deepEqual(
      res.persons.map((r) => r.personId),
      ['a', 'b'],
    );
    assert.equal(res.pot, 200);
    assert.equal(byId(res, 'a').received, 200);
    assertInvariants(res, 1000);
  });

  it('중복 arrival: 가장 이른 유효 시각을 쓴다 (null·쓰레기는 건너뛴다)', () => {
    const arrivals: ArrivalRecord[] = [
      at('a', 20),
      at('a', null),
      { personId: 'a', arrivedAtMs: NaN },
      { personId: 'a', arrivedAtMs: -Infinity },
      at('a', -2),
      at('a', 3),
      at('b', 8),
      at('b', 6),
    ];
    const res = settleLateBet(policy(), ['a', 'b'], arrivals, DEADLINE);
    assert.equal(byId(res, 'a').arrivedAtMs, DEADLINE - 2 * MIN);
    assert.equal(byId(res, 'a').status, 'onTime');
    assert.equal(byId(res, 'b').arrivedAtMs, DEADLINE + 6 * MIN);
    assert.equal(byId(res, 'b').forfeited, 200);
    assertInvariants(res, 1000);
  });

  it('Infinity·NaN 도착 시각만 있는 사람은 노쇼', () => {
    const res = settleLateBet(
      policy(),
      ['a', 'b', 'c'],
      [at('a', -1), { personId: 'b', arrivedAtMs: Infinity }, { personId: 'c', arrivedAtMs: NaN }],
      DEADLINE,
    );
    assert.equal(byId(res, 'b').status, 'noShow');
    assert.equal(byId(res, 'c').status, 'noShow');
    assert.equal(byId(res, 'a').received, 2000);
    assertInvariants(res, 1000);
  });

  it('쓰레기 마감 시각(NaN·Infinity): 판정 불가로 무효, 전원 환불', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const res = settleLateBet(policy(), ABC, [at('a', -1), at('b', 9)], bad);
      assert.equal(res.voidReason, 'invalidDeadline');
      assertInvariants(res, 1000);
      for (const r of res.persons) assert.equal(r.net, 0);
    }
  });

  it('유한 거대 도착 시각(1e308·1e21·2**53)은 무효 기록 → 노쇼, lateMinutes가 새지 않는다', () => {
    for (const huge of [1e308, 1e21, 2 ** 53, MAX_EPOCH_MS + 1, -1e308, -(2 ** 53)]) {
      const res = settleLateBet(
        policy(),
        ['a', 'b'],
        [at('a', -1), { personId: 'b', arrivedAtMs: huge }],
        DEADLINE,
      );
      const b = byId(res, 'b');
      assert.equal(b.status, 'noShow', `${huge}`);
      assert.equal(b.arrivedAtMs, null);
      assert.equal(b.lateMinutes, 0);
      assert.equal(b.forfeited, 1000);
      assert.equal(byId(res, 'a').received, 1000);
      assertInvariants(res, 1000);
    }
    // 거대값과 유효한 기록이 섞여 있으면 유효한 쪽만 쓴다 (-1e308이 '가장 이른 시각'으로 뽑히면 안 된다)
    const mixed = settleLateBet(
      policy(),
      ['a', 'b'],
      [at('a', -1), { personId: 'b', arrivedAtMs: -1e308 }, at('b', 6), { personId: 'b', arrivedAtMs: 1e308 }],
      DEADLINE,
    );
    assert.equal(byId(mixed, 'b').arrivedAtMs, DEADLINE + 6 * MIN);
    assert.equal(byId(mixed, 'b').lateMinutes, 6);
    assertInvariants(mixed, 1000);
  });

  it('유한 거대 마감 시각(±1e308·2**53)은 invalidDeadline, 결과가 JSON 왕복에서 보존된다', () => {
    for (const bad of [1e308, -1e308, 2 ** 53, -(2 ** 53), MAX_EPOCH_MS + 1]) {
      // 리뷰 재현 입력: 마감·도착이 반대 방향 극단값 → 예전엔 lateMinutes = Infinity (JSON에서 null)
      const res = settleLateBet(
        policy(),
        ['a', 'b'],
        [
          { personId: 'a', arrivedAtMs: 1e308 },
          { personId: 'b', arrivedAtMs: -1e308 },
        ],
        bad,
      );
      assert.equal(res.voidReason, 'invalidDeadline');
      assertInvariants(res, 1000);
      assert.deepEqual(JSON.parse(JSON.stringify(res)), res);
    }
  });

  it('Date 범위 양끝(±8.64e15)의 마감·도착은 유효하고 lateMinutes는 안전 정수', () => {
    const res = settleLateBet(
      policy(),
      ['a', 'b'],
      [
        { personId: 'a', arrivedAtMs: -MAX_EPOCH_MS },
        { personId: 'b', arrivedAtMs: MAX_EPOCH_MS },
      ],
      -MAX_EPOCH_MS,
    );
    assert.equal(res.voided, false);
    assert.equal(byId(res, 'a').status, 'onTime');
    const b = byId(res, 'b');
    assert.equal(b.status, 'late');
    assert.equal(b.lateMinutes, (2 * MAX_EPOCH_MS) / MIN);
    assert.equal(b.forfeited, 1000);
    assertInvariants(res, 1000);
    assert.deepEqual(JSON.parse(JSON.stringify(res)), res);
  });

  it('속성 테스트: 마감·도착 시각에 유한 거대값을 섞은 3000건에서도 모든 값이 안전 정수', () => {
    const rnd = mulberry32(8640);
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const times = [1e308, -1e308, 1e300, 1e21, 5.5e20, 2 ** 53, -(2 ** 53), MAX_EPOCH_MS, -MAX_EPOCH_MS, MAX_EPOCH_MS + 1, Infinity, NaN, 0];
    const time = () => (rnd() < 0.4 ? times[int(0, times.length - 1)] : DEADLINE + int(-30 * MIN, 90 * MIN));
    let voidedByDeadline = 0;
    for (let i = 0; i < 3000; i++) {
      const p = policy({ stake: int(0, 3000), unitMinutes: int(1, 15), penaltyPerUnit: int(0, 500), graceMinutes: int(0, 10) });
      const ids = Array.from({ length: int(0, 6) }, (_, k) => `p${k}`);
      const arrivals: ArrivalRecord[] = [];
      for (const id of ids) {
        for (let c = int(0, 2); c > 0; c--) arrivals.push({ personId: id, arrivedAtMs: rnd() < 0.1 ? null : time() });
      }
      const deadline = rnd() < 0.5 ? DEADLINE : time();
      const res = settleLateBet(p, ids, arrivals, deadline);
      assertInvariants(res, p.stake);
      assert.deepEqual(JSON.parse(JSON.stringify(res)), res, 'JSON 왕복에서 값이 바뀌면 안 된다 (Infinity → null)');
      if (res.voidReason === 'invalidDeadline') voidedByDeadline++;
      for (const a of arrivals) {
        if (a.arrivedAtMs === null) continue;
        const units = lateUnits(p, deadline, a.arrivedAtMs);
        assert.ok(Number.isSafeInteger(units) && units >= 0, `lateUnits: ${units}`);
        const pen = penaltyFor(p, deadline, a.arrivedAtMs);
        assert.ok(Number.isSafeInteger(pen) && pen >= 0 && pen <= p.stake);
      }
    }
    assert.ok(voidedByDeadline > 100, `거대 마감 케이스: ${voidedByDeadline}`);
  });

  it('쓰레기 정책(NaN·음수·소수 stake)에도 정수 결과', () => {
    const dirty = { ...policy(), stake: 1000.9, penaltyPerUnit: 33.3, graceMinutes: NaN } as LatePolicy;
    const res = settleLateBet(dirty, ABC, [at('a', -1), at('b', -1), at('c', 6)], DEADLINE);
    assert.equal(byId(res, 'c').forfeited, 66);
    assert.equal(res.pot, 66);
    assertInvariants(res, 1000);

    const negative = settleLateBet({ ...policy(), stake: -100 }, ABC, [at('a', -1)], DEADLINE);
    assert.equal(negative.voidReason, 'noStake');
    const nan = settleLateBet({ ...policy(), stake: NaN }, ABC, [at('a', -1)], DEADLINE);
    assert.equal(nan.voidReason, 'noStake');
    assertInvariants(negative, 0);
    assertInvariants(nan, 0);
  });

  it('쓰레기 참가자·arrival 항목은 건너뛴다', () => {
    const ids = ['a', '', null, 7, 'b'] as unknown as string[];
    const arrivals = [null, 'x', { personId: 'a' }, at('b', -1)] as unknown as ArrivalRecord[];
    const res = settleLateBet(policy(), ids, arrivals, DEADLINE);
    assert.deepEqual(
      res.persons.map((r) => [r.personId, r.status]),
      [
        ['a', 'noShow'],
        ['b', 'onTime'],
      ],
    );
    assertInvariants(res, 1000);
  });

  it('입력을 변형하지 않는다', () => {
    const p = Object.freeze(policy());
    const ids = Object.freeze(['a', 'b']) as string[];
    const arrivals = Object.freeze([Object.freeze(at('a', -1)), Object.freeze(at('b', 9))]) as ArrivalRecord[];
    assert.doesNotThrow(() => settleLateBet(p, ids, arrivals, DEADLINE));
  });

  it('속성 테스트: 무작위 입력 2000건에서 불변식(합계 0·정수·범위)과 결정성이 성립', () => {
    const rnd = mulberry32(20260917);
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const junk = [NaN, Infinity, -Infinity, -7, 0.5, 1e20];
    // 시각 쓰레기: 비유한값뿐 아니라 '유한 거대값'도 (JSON으로 실제 들어올 수 있는 건 이쪽)
    const timeJunk = [NaN, Infinity, -Infinity, 1e308, -1e308, 1e21, 2 ** 53, -(2 ** 53)];
    const maybeJunk = (v: number) => (rnd() < 0.08 ? junk[int(0, junk.length - 1)] : v);
    let settled = 0;

    for (let i = 0; i < 2000; i++) {
      const raw = {
        stake: maybeJunk(rnd() < 0.1 ? 0 : int(1, 5000) + (rnd() < 0.2 ? 0.37 : 0)),
        radiusM: maybeJunk(int(0, 2000)),
        unitMinutes: maybeJunk(int(1, 15)),
        penaltyPerUnit: maybeJunk(int(0, 700)),
        graceMinutes: maybeJunk(int(0, 10)),
      } as LatePolicy;
      const stake = normalizeLatePolicy(raw).stake;

      const n = int(0, 9);
      const ids = Array.from({ length: n }, (_, k) => `p${k}`);
      if (n > 0 && rnd() < 0.2) ids.push(ids[int(0, n - 1)]); // 중복 참가자

      const arrivals: ArrivalRecord[] = [];
      for (const id of [...ids, 'ghost']) {
        const count = rnd() < 0.15 ? 0 : int(1, 3);
        for (let c = 0; c < count; c++) {
          const r = rnd();
          const arrivedAtMs =
            r < 0.1
              ? null
              : r < 0.15
                ? timeJunk[int(0, timeJunk.length - 1)]
                : r < 0.3
                  ? DEADLINE // 동률을 자주 만든다
                  : DEADLINE + int(-30 * MIN, 90 * MIN);
          arrivals.push({ personId: id, arrivedAtMs });
        }
      }

      const res = settleLateBet(raw, ids, arrivals, DEADLINE);
      assertInvariants(res, stake);
      assert.equal(res.persons.length, new Set(ids).size);
      if (!res.voided && res.pot > 0) settled++;

      // 정시 도착자끼리는 1포인트 넘게 차이 나지 않고, 더 일찍 온 사람이 덜 받지 않는다
      const winners = res.persons.filter((r) => r.status === 'onTime');
      for (const a of winners) {
        for (const b of winners) {
          assert.ok(Math.abs(a.received - b.received) <= 1);
          if ((a.arrivedAtMs as number) < (b.arrivedAtMs as number)) assert.ok(a.received >= b.received);
        }
      }

      // 결정성: arrivals 순서를 섞어도 같은 결과
      const shuffled = [...arrivals];
      for (let k = shuffled.length - 1; k > 0; k--) {
        const j = int(0, k);
        [shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]];
      }
      assert.deepEqual(settleLateBet(raw, ids, shuffled, DEADLINE), res);
    }
    // 무효·pot 0만 나와서 테스트가 공허해지지 않았는지
    assert.ok(settled > 500, `실제 분배된 케이스: ${settled}`);
  });
});

describe('closeAtMs / locationShareWindow / isLocationShared', () => {
  /** 주최자가 [시작하기]를 누른 시각 (약속 40분 전) */
  const STARTED = DEADLINE - 40 * MIN;

  it('마감(closeAtMs) = 전액 몰수 시각 + 30분 꼬리 (오너 결정 변경 3)', () => {
    const p = policy();
    assert.equal(SHARE_TAIL_AFTER_FULL_FORFEIT_MINUTES, 30);
    assert.equal(fullForfeitAtMs(p, DEADLINE), DEADLINE + 45 * MIN);
    assert.equal(closeAtMs(p, DEADLINE), DEADLINE + 75 * MIN);
  });

  it('공개 창: 시작 = 주최자가 [시작하기]를 누른 시각, 끝 = closeAtMs. 시작 전에는 창이 없다', () => {
    const p = policy();
    assert.deepEqual(locationShareWindow(p, DEADLINE, STARTED), { startMs: STARTED, endMs: DEADLINE + 75 * MIN });
    assert.equal(locationShareWindow(p, DEADLINE, null), null);
    // 시작 시각이 언제든(약속 2시간 전이든 3분 전이든) 그 순간부터 열린다
    assert.equal(locationShareWindow(p, DEADLINE, DEADLINE - 3 * MIN)?.startMs, DEADLINE - 3 * MIN);
  });

  it('꼬리 안(전액 몰수 뒤 30분)에는 아직 공개되고, 꼬리가 끝나면 닫힌다', () => {
    const p = policy();
    const full = fullForfeitAtMs(p, DEADLINE) as number;
    assert.equal(isLocationShared(p, DEADLINE, STARTED, full + 1, false), true);
    assert.equal(isLocationShared(p, DEADLINE, STARTED, full + 30 * MIN, false), true);
    assert.equal(isLocationShared(p, DEADLINE, STARTED, full + 30 * MIN + 1, false), false);
  });

  it('꼬리를 붙여도 마감 + 180분 상한을 넘지 않는다', () => {
    // 전액 몰수가 마감 + 170분 → 꼬리를 붙이면 200분이지만 180분에서 잘린다
    const p = policy({ stake: 180, penaltyPerUnit: 1, unitMinutes: 1, graceMinutes: 0 });
    assert.equal(fullForfeitAtMs(p, DEADLINE), DEADLINE + 179 * MIN);
    assert.equal(closeAtMs(p, DEADLINE), DEADLINE + MAX_SHARE_AFTER_DEADLINE_MINUTES * MIN);
    // 전액 몰수가 마감 + 100분이면 꼬리가 온전히 붙는다
    const q = policy({ stake: 100, penaltyPerUnit: 1, unitMinutes: 1, graceMinutes: 0 });
    assert.equal(closeAtMs(q, DEADLINE), DEADLINE + 129 * MIN);
  });

  it('전액 몰수 시각이 없으면(단위 차감 0·stake 0) 마감 + 60분', () => {
    assert.equal(closeAtMs(policy({ penaltyPerUnit: 0 }), DEADLINE), DEADLINE + 60 * MIN);
    assert.equal(closeAtMs(policy({ stake: 0 }), DEADLINE), DEADLINE + 60 * MIN);
  });

  it('프라이버시: 전액 몰수가 아주 먼 정책이어도 마감 + 상한에서 공개를 끝낸다', () => {
    const slow = policy({ stake: 100_000, penaltyPerUnit: 1, unitMinutes: 10 });
    assert.equal(closeAtMs(slow, DEADLINE), DEADLINE + MAX_SHARE_AFTER_DEADLINE_MINUTES * MIN);
  });

  it('시작한 뒤 + 공개 창 안 + 도착 전일 때만 공개 (양끝 포함)', () => {
    const p = policy();
    const { startMs, endMs } = locationShareWindow(p, DEADLINE, STARTED) as { startMs: number; endMs: number };
    assert.equal(isLocationShared(p, DEADLINE, STARTED, startMs - 1, false), false);
    assert.equal(isLocationShared(p, DEADLINE, STARTED, startMs, false), true);
    assert.equal(isLocationShared(p, DEADLINE, STARTED, DEADLINE, false), true);
    assert.equal(isLocationShared(p, DEADLINE, STARTED, endMs, false), true);
    assert.equal(isLocationShared(p, DEADLINE, STARTED, endMs + 1, false), false);
  });

  it('주최자가 아직 시작하지 않았으면 약속 시각이 코앞이어도 공개하지 않는다', () => {
    assert.equal(isLocationShared(policy(), DEADLINE, null, DEADLINE - MIN, false), false);
    assert.equal(isLocationShared(policy(), DEADLINE, null, DEADLINE, false), false);
  });

  it('도착한 사람은 창 안이어도 공개하지 않는다', () => {
    assert.equal(isLocationShared(policy(), DEADLINE, STARTED, DEADLINE - MIN, true), false);
  });

  it('쓰레기 시각이면 공개하지 않는 쪽으로 닫는다', () => {
    const p = policy();
    assert.equal(closeAtMs(p, NaN), null);
    assert.equal(locationShareWindow(p, NaN, STARTED), null);
    assert.equal(locationShareWindow(p, DEADLINE, NaN), null);
    assert.equal(locationShareWindow(p, DEADLINE, Infinity), null);
    assert.equal(isLocationShared(p, NaN, STARTED, 0, false), false);
    assert.equal(isLocationShared(p, DEADLINE, STARTED, NaN, false), false);
    assert.equal(isLocationShared(p, Infinity, STARTED, DEADLINE, false), false);
    assert.equal(isLocationShared(p, DEADLINE, STARTED, DEADLINE, undefined as unknown as boolean), false);
  });
});
