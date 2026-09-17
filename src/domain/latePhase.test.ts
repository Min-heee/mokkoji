import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_LATE_POLICY, locationShareWindow, type LatePolicy } from './lateBet';
import {
  allActiveArrived,
  isCheckInOpen,
  isClosedPhase,
  isLocked,
  lateTimes,
  locksImmediately,
  myParticipant,
  onTimeUntilMs,
  phase,
  pollIntervalMs,
  type LatePhaseInput,
} from './latePhase';

const MIN = 60_000;
const MEET = Date.UTC(2026, 8, 25, 10, 30); // 2026-09-25 19:30 KST
const POLICY: LatePolicy = { ...DEFAULT_LATE_POLICY, stake: 100, unitMinutes: 5, penaltyPerUnit: 10 };
const { shareStartMs: SHARE, closeMs: CLOSE } = lateTimes(POLICY, MEET);

function live(over: Partial<LatePhaseInput> = {}, apptOver: Partial<LatePhaseInput['appointment']> = {}): LatePhaseInput {
  return {
    myUserId: 'me',
    myState: 'active',
    settlePending: false,
    appointment: { status: 'open', meetAtMs: MEET, shareStartMs: SHARE, closeMs: CLOSE, policy: POLICY, ...apptOver },
    participants: [
      { userId: 'host', state: 'active', arrivedAtMs: null },
      { userId: 'me', state: 'active', arrivedAtMs: null },
    ],
    ...over,
  };
}

describe('lateTimes', () => {
  it('잠금 = 약속 1시간 전, 마감 = 전액 몰수 시각(보통 프리셋이면 45분 뒤)', () => {
    assert.equal(SHARE, MEET - 60 * MIN);
    assert.equal(CLOSE, MEET + 45 * MIN);
  });

  it('엔진의 위치 공개 창과 같은 값이다', () => {
    const w = locationShareWindow(POLICY, MEET);
    assert.deepEqual(lateTimes(POLICY, MEET), { shareStartMs: w.startMs, closeMs: w.endMs });
  });

  it('내기가 없으면 마감은 약속 60분 뒤, 전액까지 너무 오래 걸리면 180분에서 자른다', () => {
    assert.equal(lateTimes({ ...POLICY, stake: 0 }, MEET).closeMs, MEET + 60 * MIN);
    assert.equal(lateTimes({ ...POLICY, penaltyPerUnit: 0 }, MEET).closeMs, MEET + 60 * MIN);
    assert.equal(lateTimes({ ...POLICY, stake: 300, unitMinutes: 60, penaltyPerUnit: 1 }, MEET).closeMs, MEET + 180 * MIN);
  });

  it('약속까지 남은 시간이 공개 시점보다 짧으면 만들자마자 잠긴다', () => {
    assert.equal(locksImmediately(POLICY, MEET, MEET - 61 * MIN), false);
    assert.equal(locksImmediately(POLICY, MEET, MEET - 60 * MIN), true);
    assert.equal(locksImmediately(POLICY, MEET, MEET - 20 * MIN), true);
    assert.equal(locksImmediately(POLICY, MEET, Number.NaN), false);
  });
});

describe('phase', () => {
  it('잠금 전에는 대기실', () => {
    assert.equal(phase(live(), SHARE - 1), 'waiting');
  });

  it('잠금 시각부터 약속 시각까지는 live (양끝 포함)', () => {
    assert.equal(phase(live(), SHARE), 'live');
    assert.equal(phase(live(), MEET), 'live');
  });

  it('약속 시각을 1ms라도 넘기면 overtime, 마감 시각까지', () => {
    assert.equal(phase(live(), MEET + 1), 'overtime');
    assert.equal(phase(live(), CLOSE), 'overtime');
  });

  it('봐주는 시간 안에는 아직 live', () => {
    const p: LatePolicy = { ...POLICY, graceMinutes: 5 };
    const t = lateTimes(p, MEET);
    const l = live({}, { policy: p, shareStartMs: t.shareStartMs, closeMs: t.closeMs });
    assert.equal(onTimeUntilMs(l.appointment), MEET + 5 * MIN);
    assert.equal(phase(l, MEET + 5 * MIN), 'live');
    assert.equal(phase(l, MEET + 5 * MIN + 1), 'overtime');
  });

  it('마감을 넘기거나 서버가 settlePending 을 주면 settling', () => {
    assert.equal(phase(live(), CLOSE + 1), 'settling');
    assert.equal(phase(live({ settlePending: true }), CLOSE), 'settling');
  });

  it('내가 도착했으면 arrived — 잠금 뒤 어느 때든, 마감 전까지', () => {
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

  it('승인 대기는 시각과 무관하게 pending', () => {
    const l = live({ myState: 'pending', participants: [{ userId: 'me', state: 'pending', arrivedAtMs: null }] });
    assert.equal(phase(l, SHARE + 1), 'pending');
    assert.equal(phase(l, MEET + 1), 'pending');
  });

  it('닫힌 약속은 서버 status 가 가장 먼저다', () => {
    for (const status of ['settled', 'voided', 'canceled'] as const) {
      const l = live({ myState: 'pending', settlePending: true }, { status });
      assert.equal(phase(l, CLOSE + 999), status);
      assert.equal(isClosedPhase(phase(l, 0)), true);
    }
  });

  it('현재 시각이 쓰레기면 시각 비교 없이 대기실로 둔다', () => {
    assert.equal(phase(live(), Number.NaN), 'waiting');
    assert.equal(phase(live({ settlePending: true }), Number.NaN), 'settling');
  });

  it('참가자 목록에 내가 없어도 죽지 않는다', () => {
    const l = live({ participants: [] });
    assert.equal(myParticipant(l), null);
    assert.equal(phase(l, MEET), 'live');
  });
});

describe('잠금·체크인 창', () => {
  it('잠금은 공개 시작 시각부터(포함)', () => {
    assert.equal(isLocked({ shareStartMs: SHARE }, SHARE - 1), false);
    assert.equal(isLocked({ shareStartMs: SHARE }, SHARE), true);
  });

  it('체크인 창은 양끝 포함, 열린 약속에서만', () => {
    const a = live().appointment;
    assert.equal(isCheckInOpen(a, SHARE - 1), false);
    assert.equal(isCheckInOpen(a, SHARE), true);
    assert.equal(isCheckInOpen(a, CLOSE), true);
    assert.equal(isCheckInOpen(a, CLOSE + 1), false);
    assert.equal(isCheckInOpen({ ...a, status: 'canceled' }, MEET), false);
  });
});

describe('pollIntervalMs', () => {
  it('대기실은 30초, 공개 창·승인 대기·정산 대기는 5초, 끝났으면 멈춤', () => {
    assert.equal(pollIntervalMs('waiting'), 30_000);
    for (const p of ['pending', 'live', 'overtime', 'arrived', 'settling'] as const) {
      assert.equal(pollIntervalMs(p), 5_000);
    }
    for (const p of ['settled', 'voided', 'canceled'] as const) assert.equal(pollIntervalMs(p), null);
  });
});

describe('allActiveArrived', () => {
  it('활성 전원이 도착해야 참, 승인 대기는 세지 않는다, 활성이 없으면 거짓', () => {
    assert.equal(allActiveArrived([]), false);
    assert.equal(allActiveArrived([{ userId: 'a', state: 'pending', arrivedAtMs: null }]), false);
    assert.equal(
      allActiveArrived([
        { userId: 'a', state: 'active', arrivedAtMs: 1 },
        { userId: 'b', state: 'pending', arrivedAtMs: null },
      ]),
      true,
    );
    assert.equal(
      allActiveArrived([
        { userId: 'a', state: 'active', arrivedAtMs: 1 },
        { userId: 'b', state: 'active', arrivedAtMs: null },
      ]),
      false,
    );
  });
});
