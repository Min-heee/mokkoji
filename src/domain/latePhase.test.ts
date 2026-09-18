import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { closeAtMs, DEFAULT_LATE_POLICY, fullForfeitAtMs, type LatePolicy } from './lateBet';
import {
  allActiveArrived,
  isCheckInOpen,
  isClosedPhase,
  isLocationVisible,
  isStarted,
  lateCloseMs,
  myParticipant,
  onTimeUntilMs,
  phase,
  pollIntervalMs,
  type LatePhaseInput,
} from './latePhase';

const MIN = 60_000;
const MEET = Date.UTC(2026, 8, 25, 10, 30); // 2026-09-25 19:30 KST
const POLICY: LatePolicy = { ...DEFAULT_LATE_POLICY, stake: 100, unitMinutes: 5, penaltyPerUnit: 10 };
const CLOSE = lateCloseMs(POLICY, MEET);
/** 주최자가 [시작하기]를 누른 시각 (약속 50분 전 — 값 자체는 판정에 안 쓰이고 '있다/없다'만 본다) */
const STARTED_AT = MEET - 50 * MIN;

function live(over: Partial<LatePhaseInput> = {}, apptOver: Partial<LatePhaseInput['appointment']> = {}): LatePhaseInput {
  return {
    myUserId: 'me',
    myState: 'active',
    settlePending: false,
    appointment: {
      status: 'open',
      meetAtMs: MEET,
      startedAtMs: STARTED_AT,
      closeMs: CLOSE,
      policy: POLICY,
      ...apptOver,
    },
    participants: [
      { userId: 'host', state: 'active', arrivedAtMs: null },
      { userId: 'me', state: 'active', arrivedAtMs: null },
    ],
    ...over,
  };
}

describe('lateCloseMs', () => {
  it('마감 = 전액 몰수 시각 + 30분 꼬리(보통 프리셋이면 45 + 30 = 75분 뒤)', () => {
    assert.equal(fullForfeitAtMs(POLICY, MEET), MEET + 45 * MIN);
    assert.equal(CLOSE, MEET + 75 * MIN);
  });

  it('엔진의 closeAtMs 와 같은 값이고, 약속 시각이 쓰레기면 NaN', () => {
    assert.equal(lateCloseMs(POLICY, MEET), closeAtMs(POLICY, MEET));
    assert.ok(Number.isNaN(lateCloseMs(POLICY, Number.NaN)));
  });

  it('내기가 없으면 마감은 약속 60분 뒤, 전액까지 너무 오래 걸리면 180분에서 자른다', () => {
    assert.equal(lateCloseMs({ ...POLICY, stake: 0 }, MEET), MEET + 60 * MIN);
    assert.equal(lateCloseMs({ ...POLICY, penaltyPerUnit: 0 }, MEET), MEET + 60 * MIN);
    assert.equal(lateCloseMs({ ...POLICY, stake: 300, unitMinutes: 60, penaltyPerUnit: 1 }, MEET), MEET + 180 * MIN);
  });
});

describe('phase', () => {
  it('시작 전이면 시각과 무관하게 대기실(waiting) — 약속 시각이 코앞이어도', () => {
    assert.equal(phase(live({}, { startedAtMs: null }), MEET - 3 * 60 * MIN), 'waiting');
    assert.equal(phase(live({}, { startedAtMs: null }), MEET - MIN), 'waiting');
    assert.equal(phase(live({}, { startedAtMs: null }), MEET), 'waiting');
  });

  it('시작 시각부터 약속 시각까지는 live (양끝 포함)', () => {
    assert.equal(phase(live(), STARTED_AT), 'live');
    assert.equal(phase(live(), MEET), 'live');
    // 약속 3분 전에 시작해도 그 순간부터 live
    assert.equal(phase(live({}, { startedAtMs: MEET - 3 * MIN }), MEET - 3 * MIN), 'live');
  });

  it('약속 시각을 1ms라도 넘기면 overtime, 마감 시각까지', () => {
    assert.equal(phase(live(), MEET + 1), 'overtime');
    assert.equal(phase(live(), CLOSE), 'overtime');
  });

  it('봐주는 시간 안에는 아직 live', () => {
    const p: LatePolicy = { ...POLICY, graceMinutes: 5 };
    const l = live({}, { policy: p, closeMs: lateCloseMs(p, MEET) });
    assert.equal(onTimeUntilMs(l.appointment), MEET + 5 * MIN);
    assert.equal(phase(l, MEET + 5 * MIN), 'live');
    assert.equal(phase(l, MEET + 5 * MIN + 1), 'overtime');
  });

  it('마감을 넘기거나 서버가 settlePending 을 주면 settling', () => {
    assert.equal(phase(live(), CLOSE + 1), 'settling');
    assert.equal(phase(live({ settlePending: true }), CLOSE), 'settling');
  });

  it('내가 도착했으면 arrived — 시작 뒤 어느 때든, 마감 전까지', () => {
    const arrived = live({
      participants: [
        { userId: 'host', state: 'active', arrivedAtMs: null },
        { userId: 'me', state: 'active', arrivedAtMs: MEET - 6 * MIN },
      ],
    });
    assert.equal(phase(arrived, MEET - 5 * MIN), 'arrived');
    assert.equal(phase(arrived, MEET + 10 * MIN), 'arrived');
    assert.equal(phase(arrived, CLOSE + 1), 'settling');
  });

  it('다른 사람의 도착은 내 단계를 바꾸지 않는다', () => {
    const l = live({
      participants: [
        { userId: 'host', state: 'active', arrivedAtMs: MEET - MIN },
        { userId: 'me', state: 'active', arrivedAtMs: null },
      ],
    });
    assert.equal(phase(l, MEET - 30_000), 'live');
  });

  it('닫힌 약속은 서버 status 가 가장 먼저다 (시작 안 한 채 무효가 된 약속도 voided)', () => {
    for (const status of ['settled', 'voided', 'canceled'] as const) {
      const l = live({ settlePending: true }, { status });
      assert.equal(phase(l, CLOSE + 999), status);
      assert.equal(isClosedPhase(phase(l, 0)), true);
    }
    assert.equal(phase(live({}, { status: 'voided', startedAtMs: null }), MEET + 1), 'voided');
  });

  it('현재 시각이 쓰레기면 시각 비교 없이 서버 플래그로만 고른다: 시작 전 waiting, 시작 뒤 live', () => {
    assert.equal(phase(live({}, { startedAtMs: null }), Number.NaN), 'waiting');
    assert.equal(phase(live(), Number.NaN), 'live');
    assert.equal(phase(live({ settlePending: true }), Number.NaN), 'settling');
  });

  it('참가자 목록에 내가 없어도 죽지 않는다', () => {
    const l = live({ participants: [] });
    assert.equal(myParticipant(l), null);
    assert.equal(phase(l, MEET), 'live');
  });
});

describe('시작·체크인 창·위치 공개', () => {
  it('시작 여부는 startedAtMs 유무로만 정해진다(시각과 무관)', () => {
    assert.equal(isStarted({ startedAtMs: null }), false);
    assert.equal(isStarted({ startedAtMs: STARTED_AT }), true);
    assert.equal(isStarted({ startedAtMs: Number.NaN }), false);
  });

  it('체크인 창 = 시작 시각 ~ 마감(양끝 포함), 열린 약속에서만, 시작 전에는 항상 닫힘', () => {
    const a = live().appointment;
    assert.equal(isCheckInOpen(a, STARTED_AT - 1), false);
    assert.equal(isCheckInOpen(a, STARTED_AT), true);
    assert.equal(isCheckInOpen(a, CLOSE), true);
    assert.equal(isCheckInOpen(a, CLOSE + 1), false);
    assert.equal(isCheckInOpen({ ...a, status: 'canceled' }, MEET), false);
    assert.equal(isCheckInOpen({ ...a, startedAtMs: null }, MEET), false);
  });

  it('남의 위치는 시작 뒤 ∧ 마감 전에만 보인다 — 주최자가 [시작하기]를 누르는 순간 뜬다', () => {
    const before = live({}, { startedAtMs: null }).appointment;
    assert.equal(isLocationVisible(before, MEET - MIN), false);
    assert.equal(isLocationVisible({ ...before, startedAtMs: MEET - MIN }, MEET - MIN), true);
    assert.equal(isLocationVisible(live().appointment, CLOSE + 1), false);
  });
});

describe('pollIntervalMs', () => {
  it('대기실은 10초, 시작 뒤·정산 대기는 5초, 끝났으면 멈춤', () => {
    assert.equal(pollIntervalMs('waiting'), 10_000);
    for (const p of ['live', 'overtime', 'arrived', 'settling'] as const) {
      assert.equal(pollIntervalMs(p), 5_000);
    }
    for (const p of ['settled', 'voided', 'canceled'] as const) assert.equal(pollIntervalMs(p), null);
  });
});

describe('allActiveArrived', () => {
  it('활성 전원이 도착해야 참, 활성이 없으면 거짓', () => {
    assert.equal(allActiveArrived([]), false);
    assert.equal(allActiveArrived([{ userId: 'a', state: 'active', arrivedAtMs: 1 }]), true);
    assert.equal(
      allActiveArrived([
        { userId: 'a', state: 'active', arrivedAtMs: 1 },
        { userId: 'b', state: 'active', arrivedAtMs: null },
      ]),
      false,
    );
  });
});
