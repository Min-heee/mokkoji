import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { closeAtMs, fullForfeitAtMs, penaltyFor, type LatePolicy } from './lateBet';
import {
  DEFAULT_PRESET_ID,
  describePolicy,
  FULL_FORFEIT_CAP_MINUTES,
  GRACE_CHOICES,
  isValidPolicy,
  LATE_PRESETS,
  matchPreset,
  minutesToFullForfeit,
  policyWithStake,
  POLICY_LIMITS,
  presetPolicy,
  RADIUS_CHOICES,
  shortPolicyLine,
  STAKE_CHOICES,
  validatePolicy,
} from './latePresets';
import { formatKoreanTime } from './tzGuard';

const MIN = 60_000;
const MEET = Date.UTC(2026, 8, 25, 10, 30); // 2026-09-25 19:30 KST
const NORMAL = presetPolicy('normal');

/** 부록 A 의 CHECK 제약을 SQL 그대로 옮긴 참조 구현 (validatePolicy 와 따로 적어 서로를 검사한다) */
function sqlCheck(p: LatePolicy): boolean {
  const int = (v: number) => Number.isInteger(v);
  const between = (v: number, a: number, b: number) => int(v) && v >= a && v <= b;
  return (
    between(p.stake, 0, 300) &&
    between(p.radiusM, 30, 1000) &&
    between(p.unitMinutes, 1, 60) &&
    between(p.penaltyPerUnit, 0, 300) &&
    between(p.graceMinutes, 0, 30) &&
    (p.penaltyPerUnit === 0 ||
      p.stake === 0 ||
      (Math.ceil(p.stake / p.penaltyPerUnit) - 1) * p.unitMinutes + p.graceMinutes <= 180)
  );
}

describe('프리셋', () => {
  it('세 프리셋 모두 validatePolicy 를 통과한다', () => {
    assert.equal(LATE_PRESETS.length, 3);
    for (const p of LATE_PRESETS) assert.deepEqual(validatePolicy(p.policy), { ok: true, issues: [] }, p.name);
  });

  it('기본은 보통: 100P, 5분마다 10P, 반경 100m, 봐주는 시간 0분 (공개 시점은 정책이 아니다)', () => {
    assert.equal(DEFAULT_PRESET_ID, 'normal');
    assert.deepEqual(presetPolicy(), {
      stake: 100,
      radiusM: 100,
      unitMinutes: 5,
      penaltyPerUnit: 10,
      graceMinutes: 0,
    });
  });

  it('전액을 잃는 때는 엔진에서 나온다: 순한맛 90분, 보통 45분, 매운맛 29분 넘게', () => {
    const minutes = LATE_PRESETS.map((p) => describePolicy(p.policy, MEET).fullLateMinutes);
    assert.deepEqual(minutes, [90, 45, 29]);
    for (const p of LATE_PRESETS) {
      const at = fullForfeitAtMs(p.policy, MEET) as number;
      // 그 시각 정각 도착은 아직 전액이 아니고, 1ms 넘기면 전액이다
      assert.ok(penaltyFor(p.policy, MEET, at) < p.policy.stake, p.name);
      assert.equal(penaltyFor(p.policy, MEET, at + 1), p.policy.stake, p.name);
    }
  });

  it('presetPolicy 는 사본을 준다', () => {
    const a = presetPolicy('mild');
    a.stake = 999;
    assert.equal(presetPolicy('mild').stake, 100);
  });

  it('폼 선택지의 모든 조합이 서버 CHECK 를 통과한다', () => {
    for (const preset of LATE_PRESETS) {
      for (const stake of STAKE_CHOICES) {
        for (const graceMinutes of GRACE_CHOICES) {
          for (const radiusM of RADIUS_CHOICES) {
            const p = policyWithStake(preset.id, stake, { graceMinutes, radiusM });
            assert.ok(isValidPolicy(p), JSON.stringify(p));
          }
        }
      }
    }
  });
});

describe('policyWithStake', () => {
  it('프리셋 고유의 스테이크면 프리셋과 같다', () => {
    for (const p of LATE_PRESETS) assert.deepEqual(policyWithStake(p.id, p.policy.stake), p.policy);
  });

  it('스테이크를 바꿔도 전액을 잃는 때가 프리셋보다 늦어지지 않는다', () => {
    for (const p of LATE_PRESETS) {
      const base = minutesToFullForfeit(p.policy) as number;
      for (const stake of [1, 7, 50, 100, 200, 299, 300]) {
        const m = minutesToFullForfeit(policyWithStake(p.id, stake)) as number;
        assert.ok(m <= base, `${p.name} ${stake}P → ${m}분`);
      }
    }
  });

  it('스테이크 0이면 차감도 0, 범위를 넘으면 자른다', () => {
    assert.equal(policyWithStake('spicy', 0).penaltyPerUnit, 0);
    assert.equal(policyWithStake('normal', 5000).stake, 300);
    assert.equal(policyWithStake('normal', -5).stake, 0);
    assert.equal(policyWithStake('normal', 120.9).stake, 120);
  });

  it('matchPreset 은 스테이크를 바꾼 정책에서도 프리셋을 찾는다', () => {
    assert.equal(matchPreset(policyWithStake('mild', 50)), 'mild');
    assert.equal(matchPreset(policyWithStake('spicy', 100)), 'spicy');
    assert.equal(matchPreset(policyWithStake('normal', 200)), 'normal');
    // 순한맛은 단위가 10분이라 스테이크를 바꿔도 보통과 구분된다
    assert.equal(matchPreset(policyWithStake('mild', 200)), 'mild');
    assert.equal(matchPreset({ ...NORMAL, unitMinutes: 7 }), null);
  });
});

describe('validatePolicy', () => {
  it('범위의 양끝은 통과, 한 칸 밖은 거부', () => {
    for (const field of Object.keys(POLICY_LIMITS) as (keyof LatePolicy)[]) {
      const { min, max } = POLICY_LIMITS[field];
      // 다른 제약(180분)에 걸리지 않도록 내기 없는 정책 위에서 한 필드만 바꾼다
      const base: LatePolicy = { ...NORMAL, stake: 0, penaltyPerUnit: 0 };
      assert.ok(isValidPolicy({ ...base, [field]: min }), `${field}=${min}`);
      assert.ok(isValidPolicy({ ...base, [field]: max }), `${field}=${max}`);
      for (const bad of [min - 1, max + 1, min + 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const r = validatePolicy({ ...base, [field]: bad });
        assert.equal(r.ok, false, `${field}=${bad}`);
        assert.deepEqual(r.issues.map((i) => i.field), [field]);
      }
    }
  });

  it('전액 몰수까지 180분은 통과, 181분은 거부', () => {
    // (ceil(300/10) − 1) × 6 + 6 = 180
    const ok: LatePolicy = { ...NORMAL, stake: 300, penaltyPerUnit: 10, unitMinutes: 6, graceMinutes: 6 };
    assert.equal(minutesToFullForfeit(ok), FULL_FORFEIT_CAP_MINUTES);
    assert.ok(isValidPolicy(ok));
    const bad = validatePolicy({ ...ok, graceMinutes: 7 });
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.issues.map((i) => i.field), ['fullForfeit']);
    assert.match(bad.issues[0].message, /181분/);
  });

  it('내기가 없거나 단위 차감이 0이면 180분 제약을 보지 않는다', () => {
    assert.equal(minutesToFullForfeit({ ...NORMAL, stake: 0 }), null);
    assert.ok(isValidPolicy({ ...NORMAL, stake: 0, penaltyPerUnit: 1, unitMinutes: 60 }));
    assert.ok(isValidPolicy({ ...NORMAL, stake: 300, penaltyPerUnit: 0, unitMinutes: 60 }));
  });

  it('문자열·null 같은 쓰레기는 거부한다(고쳐 주지 않는다)', () => {
    assert.equal(validatePolicy(null as unknown as LatePolicy).ok, false);
    assert.equal(validatePolicy({ ...NORMAL, stake: '100' as unknown as number }).ok, false);
  });

  it('SQL CHECK 를 그대로 옮긴 참조식과 무작위 2,000건에서 같은 판정을 낸다', () => {
    let seed = 20260917;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    let rejected = 0;
    for (let i = 0; i < 2000; i += 1) {
      // 각 필드: 범위 한 칸 밖 ~ 한 칸 밖 (대부분 범위 안, 가끔 밖)
      const pick = (f: keyof LatePolicy) => POLICY_LIMITS[f].min - 1 + rnd(POLICY_LIMITS[f].max - POLICY_LIMITS[f].min + 3);
      const p: LatePolicy = {
        stake: pick('stake'),
        radiusM: pick('radiusM'),
        unitMinutes: pick('unitMinutes'),
        penaltyPerUnit: pick('penaltyPerUnit'),
        graceMinutes: pick('graceMinutes'),
      };
      assert.equal(isValidPolicy(p), sqlCheck(p), JSON.stringify(p));
      if (!sqlCheck(p)) rejected += 1;
    }
    assert.ok(rejected > 200 && rejected < 1800, `거부 ${rejected}건 — 양쪽 다 충분히 나와야 한다`);
  });
});

describe('describePolicy', () => {
  it('말하는 전액 시각 === fullForfeitAtMs, 체크인 마감 = 전액 시각 + 30분 꼬리 (세 프리셋)', () => {
    for (const p of LATE_PRESETS) {
      const d = describePolicy(p.policy, MEET);
      const at = fullForfeitAtMs(p.policy, MEET) as number;
      assert.equal(d.fullForfeitAtMs, at, p.name);
      assert.equal(d.closeMs, at + 30 * MIN, p.name);
      assert.ok(d.close.startsWith(`${formatKoreanTime(at + 30 * MIN, 'Asia/Seoul')}에 체크인이 닫혀요`), d.close);
      assert.ok(d.full.includes(`${p.policy.stake}P를 모두 잃어요`), d.full);
    }
  });

  it('보통 프리셋의 문장', () => {
    const d = describePolicy(NORMAL, MEET);
    assert.equal(d.penalty, '늦으면 5분마다 10P씩 잃어요. 1분만 늦어도 10P예요.');
    assert.equal(d.example, '10분 늦으면 −20P');
    assert.equal(d.full, '45분 넘게 늦으면 100P를 모두 잃어요.');
    assert.equal(d.close, '오후 8:45에 체크인이 닫혀요. 그 뒤에 와도 도착으로 남지 않아요.');
    assert.equal(d.radius, '약속 장소 100m 안에 들어오면 도착이에요.');
    assert.equal(d.grace, '봐주는 시간은 없어요. 약속 시각이 마감이에요.');
    assert.equal(d.lines.length, 7);
    assert.ok(!('share' in d), '위치 공개 시작 문장은 없다(주최자의 [시작하기]가 시작이다)');
  });

  it('매운맛은 29분 넘게, 예시도 엔진 값', () => {
    const d = describePolicy(presetPolicy('spicy'), MEET);
    assert.equal(d.full, '29분 넘게 늦으면 300P를 모두 잃어요.');
    assert.equal(d.example, '2분 늦으면 −20P');
    assert.equal(d.close, '오후 8:29에 체크인이 닫혀요. 그 뒤에 와도 도착으로 남지 않아요.');
  });

  it('봐주는 시간이 있으면 예시와 전액 시각이 그만큼 밀린다', () => {
    const p: LatePolicy = { ...NORMAL, graceMinutes: 5 };
    const d = describePolicy(p, MEET);
    assert.equal(d.grace, '약속 시각에서 5분까지는 늦어도 봐줘요.');
    assert.equal(d.penalty, '5분을 넘겨 늦으면 5분마다 10P씩 잃어요.');
    assert.equal(d.example, '15분 늦으면 −20P');
    assert.equal(d.full, '50분 넘게 늦으면 100P를 모두 잃어요.');
    assert.equal(d.fullForfeitAtMs, MEET + 50 * MIN);
  });

  it('내기가 없으면 포인트 문장이 없고 마감은 약속 1시간 뒤', () => {
    const d = describePolicy({ ...NORMAL, stake: 0, penaltyPerUnit: 0 }, MEET);
    assert.equal(d.stake, '포인트는 걸지 않고 위치만 공유해요.');
    assert.equal(d.penalty, '');
    assert.equal(d.example, '');
    assert.equal(d.full, '');
    assert.equal(d.fullForfeitAtMs, null);
    assert.equal(d.close, '오후 8:30에 체크인이 닫혀요.');
  });

  it('단위 차감이 0이면 오지 않을 때만 잃는다고 말한다', () => {
    const d = describePolicy({ ...NORMAL, penaltyPerUnit: 0 }, MEET);
    assert.equal(d.fullForfeitAtMs, null);
    assert.equal(d.close, '오후 8:30까지 오지 않으면 100P를 모두 잃어요.');
    assert.equal(d.closeMs, closeAtMs({ ...NORMAL, penaltyPerUnit: 0 }, MEET));
  });

  it('한 단위에 전액이면 "조금이라도 늦으면"', () => {
    const d = describePolicy({ ...NORMAL, stake: 50, penaltyPerUnit: 50 }, MEET);
    assert.equal(d.full, '조금이라도 늦으면 50P를 모두 잃어요.');
    assert.equal(d.example, '');
  });

  it('시간대를 주면 그 시간대의 벽시계로 말한다', () => {
    // 같은 순간이 방콕에서는 오후 5:30 → 마감 오후 6:15
    const d = describePolicy(NORMAL, MEET, 'Asia/Bangkok');
    assert.ok(d.close.startsWith('오후 6:45에'), d.close);
  });
});

describe('shortPolicyLine', () => {
  it('공유 문구의 둘째 줄', () => {
    assert.equal(shortPolicyLine(NORMAL), '100P 걸기 · 5분 늦을 때마다 10P');
    assert.equal(shortPolicyLine({ ...NORMAL, stake: 0 }), '포인트 없이 위치만 공유');
    assert.equal(shortPolicyLine({ ...NORMAL, penaltyPerUnit: 0 }), '100P 걸기 · 오지 않으면 모두 잃어요');
  });
});
