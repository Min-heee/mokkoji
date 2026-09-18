import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { presetPolicy } from '../domain/latePresets';
import {
  heldPoints,
  HOME_BADGE_LABEL,
  homeBadge,
  homeMetaLine,
  homeTimeLine,
  homeUnclaimedLine,
  ledgerAmount,
  ledgerCaption,
  ledgerLabel,
  ledgerLoss,
  ledgerStake,
  splitHomeAppointments,
} from './homeModel';
import type { LbLedgerEntry, LbMyAppointment } from './types';

const MIN = 60_000;
const MEET = Date.UTC(2026, 8, 25, 10, 30); // 2026-09-25 19:30 KST
const TZ = 'Asia/Seoul';

function mine(over: Partial<LbMyAppointment> = {}): LbMyAppointment {
  return {
    id: 'appt-1',
    title: '금요일 곱창',
    localAt: '2026-09-25T19:30',
    tz: TZ,
    meetAtMs: MEET,
    startedAtMs: null,
    closeMs: MEET + 75 * MIN,
    placeName: '강남역 2번 출구 곱창',
    status: 'open',
    policy: presetPolicy('normal'),
    hostId: 'u-me',
    isHost: true,
    myState: 'active',
    memberCount: 4,
    unclaimedCount: 0,
    ...over,
  };
}

describe('homeBadge — 한 카드에 하나: 끝남 > 정산 확인 중 > 진행 중 > 모이는 중', () => {
  it('끝난 약속은 status 와 무관하게 [끝남]', () => {
    assert.equal(homeBadge(mine({ status: 'settled' }), MEET - 5 * MIN), 'ended');
    assert.equal(homeBadge(mine({ status: 'voided' }), MEET - 5 * MIN), 'ended');
    assert.equal(homeBadge(mine({ status: 'canceled', unclaimedCount: 2 }), MEET - 5 * MIN), 'ended');
    assert.equal(HOME_BADGE_LABEL.ended, '끝남');
  });

  it('마감이 지난 열린 약속은 [정산 확인 중], 주최자가 시작했으면 [진행 중], 시작 전이면 [모이는 중]', () => {
    assert.equal(homeBadge(mine(), MEET + 76 * MIN), 'settling');
    assert.equal(homeBadge(mine({ startedAtMs: MEET - 30 * MIN }), MEET + 76 * MIN), 'settling');
    assert.equal(homeBadge(mine({ startedAtMs: MEET - 30 * MIN }), MEET - 20 * MIN), 'inProgress');
    assert.equal(homeBadge(mine({ startedAtMs: MEET - 30 * MIN, unclaimedCount: 2 }), MEET - 20 * MIN), 'inProgress');
    assert.equal(homeBadge(mine({ unclaimedCount: 2 }), MEET - 3 * 60 * MIN), 'gathering');
    assert.equal(homeBadge(mine(), MEET - 2 * 24 * 60 * MIN), 'gathering'); // 빈 이름이 없어도 시작 전이면 모이는 중
    assert.equal(HOME_BADGE_LABEL.gathering, '모이는 중');
    assert.equal(HOME_BADGE_LABEL.inProgress, '진행 중');
  });

  it('서버 시각을 모르면(NaN) 시각 배지는 건너뛰고 시작 여부로만 고른다', () => {
    assert.equal(homeBadge(mine({ unclaimedCount: 1 }), Number.NaN), 'gathering');
    assert.equal(homeBadge(mine({ startedAtMs: MEET - MIN }), Number.NaN), 'inProgress');
  });
});

describe('homeTimeLine · homeMetaLine · homeUnclaimedLine', () => {
  it('"9월 25일 (금) 오후 7:30 · 2시간 뒤", 마감이 지나면 남은 시간 없음, 취소·무효는 꼬리에 표시', () => {
    assert.equal(homeTimeLine(mine(), MEET - 2 * 60 * MIN), '9월 25일 (금) 오후 7:30 · 2시간 뒤');
    assert.equal(homeTimeLine(mine(), MEET + 76 * MIN), '9월 25일 (금) 오후 7:30');
    assert.equal(homeTimeLine(mine({ status: 'canceled' }), MEET - 2 * 60 * MIN), '9월 25일 (금) 오후 7:30 · 취소됨');
    assert.equal(homeTimeLine(mine({ status: 'voided' }), MEET + 200 * MIN), '9월 25일 (금) 오후 7:30 · 무효');
    assert.equal(homeTimeLine(mine({ status: 'settled' }), MEET + 200 * MIN), '9월 25일 (금) 오후 7:30');
  });

  it('한국이 아닌 시간대면 라벨을 끼운다', () => {
    const line = homeTimeLine(mine({ tz: 'Asia/Tokyo' }), MEET - 2 * 60 * MIN);
    assert.equal(line.split(' · ').length, 3);
    assert.match(line, / · 2시간 뒤$/);
  });

  it('"강남역 2번 출구 곱창 · 4명 · 100P 내기", 내기 없음이면 "위치만 공유"', () => {
    assert.equal(homeMetaLine(mine()), '강남역 2번 출구 곱창 · 4명 · 100P 내기');
    assert.equal(homeMetaLine(mine({ policy: { ...presetPolicy('normal'), stake: 0 }, memberCount: 0, placeName: ' ' })), '위치만 공유');
  });

  it('아직 안 들어온 친구 수는 주최자의 열린 약속에만 (시작 뒤에도 약속 시각까지는 들어올 수 있어 계속 보인다)', () => {
    assert.equal(homeUnclaimedLine(mine({ unclaimedCount: 2 })), '아직 안 들어온 친구 2명');
    assert.equal(homeUnclaimedLine(mine({ unclaimedCount: 2, startedAtMs: MEET - 30 * MIN })), '아직 안 들어온 친구 2명');
    assert.equal(homeUnclaimedLine(mine({ unclaimedCount: 2, isHost: false })), '');
    assert.equal(homeUnclaimedLine(mine({ unclaimedCount: 2, status: 'canceled' })), '');
    assert.equal(homeUnclaimedLine(mine()), '');
  });
});

describe('splitHomeAppointments · heldPoints', () => {
  it('열린 약속은 전부, 끝난 약속은 limit 개만 보이고 나머지 수를 알려 준다', () => {
    const list = [
      mine({ id: 'o1' }),
      mine({ id: 'o2' }),
      mine({ id: 'e1', status: 'settled' }),
      mine({ id: 'e2', status: 'canceled' }),
      mine({ id: 'e3', status: 'voided' }),
    ];
    const r = splitHomeAppointments(list, 2);
    assert.deepEqual(
      r.shown.map((a) => a.id),
      ['o1', 'o2', 'e1', 'e2'],
    );
    assert.equal(r.hiddenEnded, 1);
    assert.equal(splitHomeAppointments(list, 0).hiddenEnded, 3);
    assert.equal(splitHomeAppointments(list, list.length).hiddenEnded, 0);
  });

  it('걸어 둔 포인트 = 내가 활성으로 참여한 열린 약속의 건 포인트 합', () => {
    const list = [
      mine({ id: 'o1' }),
      mine({ id: 'o2', policy: { ...presetPolicy('spicy') } }),
      mine({ id: 'o3', policy: { ...presetPolicy('normal'), stake: 0 } }),
      mine({ id: 'e1', status: 'settled' }),
    ];
    assert.deepEqual(heldPoints(list), { points: 400, count: 2 });
    assert.deepEqual(heldPoints([]), { points: 0, count: 0 });
  });
});

describe('원장 문구', () => {
  const entry = (over: Partial<LbLedgerEntry>): LbLedgerEntry => ({
    id: 1,
    kind: 'hold',
    amount: -100,
    balanceAfter: 900,
    appointmentId: 'appt-1',
    appointmentTitle: '금요일 곱창',
    reason: null,
    reliefFor: null,
    createdAtMs: MEET - 180 * MIN,
    ...over,
  });

  it('ledgerLabel: 시작 포인트 / 모자란 포인트 채움 / 제목 · 건 포인트 / 제목 · 돌려받음 사유 / 제목 · 결과', () => {
    assert.equal(ledgerLabel(entry({ kind: 'grant', amount: 1000, appointmentId: null, appointmentTitle: null, reason: 'signup' })), '시작 포인트');
    assert.equal(ledgerLabel(entry({ kind: 'relief', amount: 20, appointmentId: null, appointmentTitle: null, reason: 'topup' })), '모자란 포인트 채움');
    assert.equal(ledgerLabel(entry({})), '금요일 곱창 · 건 포인트');
    assert.equal(ledgerLabel(entry({ appointmentTitle: null })), '건 포인트');
    assert.equal(ledgerLabel(entry({ kind: 'refund', amount: 100, reason: 'leave' })), '금요일 곱창 · 나가서 돌려받음');
    assert.equal(ledgerLabel(entry({ kind: 'refund', amount: 100, reason: 'canceled' })), '금요일 곱창 · 약속 취소로 돌려받음');
    assert.equal(ledgerLabel(entry({ kind: 'refund', amount: 100, reason: 'kicked' })), '금요일 곱창 · 내보내져 돌려받음');
    assert.equal(ledgerLabel(entry({ kind: 'refund', amount: 50, reason: 'policy_change' })), '금요일 곱창 · 조건 변경으로 돌려받음');
    assert.equal(ledgerLabel(entry({ kind: 'refund', amount: 100, reason: 'notStarted' })), '금요일 곱창 · 시작하지 않아 돌려받음');
    assert.equal(ledgerLabel(entry({ kind: 'payout', amount: 160 })), '금요일 곱창 · 결과');
  });

  it('ledgerAmount: "+1,000" · "−100"(U+2212) · "0"', () => {
    assert.equal(ledgerAmount(1000), '+1,000');
    assert.equal(ledgerAmount(-100), '−100');
    assert.equal(ledgerAmount(0), '0');
    assert.equal(ledgerAmount(Number.NaN), '0');
  });

  it('ledgerCaption: payout 은 같은 약속의 직전 hold 와 짝지어 잃은·더 받은·그대로 로 풀어 쓴다', () => {
    const hold = entry({ id: 3 });
    const list = (payoutAmount: number) => {
      const payout = entry({ id: 5, kind: 'payout', amount: payoutAmount, balanceAfter: 900 + payoutAmount });
      return { payout, entries: [payout, hold] as LbLedgerEntry[] };
    };
    let x = list(160);
    assert.equal(ledgerCaption(x.payout, x.entries), '건 100P에 60P를 더 받았어요');
    assert.equal(ledgerLoss(x.payout, x.entries), 0);
    x = list(80);
    assert.equal(ledgerCaption(x.payout, x.entries), '건 100P 중 20P를 잃었어요');
    assert.equal(ledgerLoss(x.payout, x.entries), 20);
    x = list(100);
    assert.equal(ledgerCaption(x.payout, x.entries), '건 100P를 그대로 돌려받았어요');
    assert.equal(ledgerLoss(x.payout, x.entries), 0);
    x = list(0);
    assert.equal(ledgerCaption(x.payout, x.entries), '건 100P를 모두 잃었어요');
    assert.equal(ledgerLoss(x.payout, x.entries), 100);
  });

  it('ledgerCaption · ledgerLoss: 시작 전 걸 포인트를 올려 차액 hold(policy_change)가 한 줄 더 있으면 합산한 걸 포인트로 푼다', () => {
    // 100P 로 참여 → 주최자가 300P 로 올림(차액 200P hold) → 7분 지각(-60P) → payout +240
    const first = entry({ id: 3, amount: -100, balanceAfter: 900 });
    const diff = entry({ id: 4, amount: -200, balanceAfter: 700, reason: 'policy_change' });
    const payout = entry({ id: 7, kind: 'payout', amount: 240, balanceAfter: 940 });
    const entries = [payout, diff, first] as LbLedgerEntry[];
    assert.equal(ledgerStake(payout, entries), 300);
    assert.equal(ledgerCaption(payout, entries), '건 300P 중 60P를 잃었어요');
    assert.equal(ledgerLoss(payout, entries), 60);
    // 안 잃은 사람: payout 이 걸 포인트보다 크면 더 받은 것
    const winner = entry({ id: 7, kind: 'payout', amount: 360, balanceAfter: 1060 });
    assert.equal(ledgerCaption(winner, [winner, diff, first]), '건 300P에 60P를 더 받았어요');
    assert.equal(ledgerLoss(winner, [winner, diff, first]), 0);
  });

  it('ledgerCaption · ledgerLoss: 시작 전 걸 포인트를 내려 refund(policy_change)가 끼면 돌려받은 만큼 뺀 걸 포인트로 푼다', () => {
    // 200P 로 참여 → 주최자가 100P 로 내림(100P refund) → 둘 다 제시간 → payout +100
    const first = entry({ id: 3, amount: -200, balanceAfter: 800 });
    const back = entry({ id: 4, kind: 'refund', amount: 100, balanceAfter: 900, reason: 'policy_change' });
    const payout = entry({ id: 7, kind: 'payout', amount: 100, balanceAfter: 1000 });
    const entries = [payout, back, first] as LbLedgerEntry[];
    assert.equal(ledgerStake(payout, entries), 100);
    assert.equal(ledgerCaption(payout, entries), '건 100P를 그대로 돌려받았어요');
    assert.equal(ledgerLoss(payout, entries), 0);
    const lost = entry({ id: 7, kind: 'payout', amount: 80, balanceAfter: 980 });
    assert.equal(ledgerCaption(lost, [lost, back, first]), '건 100P 중 20P를 잃었어요');
    assert.equal(ledgerLoss(lost, [lost, back, first]), 20);
  });

  it('ledgerStake: 나갔다 다시 참여한 약속(hold · refund(leave) · hold)은 마지막에 걸려 있던 100P, payout 뒤의 hold 는 세지 않는다', () => {
    const a = entry({ id: 3, amount: -100, balanceAfter: 900 });
    const out = entry({ id: 4, kind: 'refund', amount: 100, balanceAfter: 1000, reason: 'leave' });
    const b = entry({ id: 5, amount: -100, balanceAfter: 900 });
    const payout = entry({ id: 8, kind: 'payout', amount: 130, balanceAfter: 1030 });
    const later = entry({ id: 12, amount: -500, balanceAfter: 530 });
    const entries = [later, payout, b, out, a] as LbLedgerEntry[];
    assert.equal(ledgerStake(payout, entries), 100);
    assert.equal(ledgerCaption(payout, entries), '건 100P에 30P를 더 받았어요');
    // 다른 약속의 hold 는 섞이지 않는다
    const other = entry({ id: 2, amount: -300, balanceAfter: 700, appointmentId: 'appt-9' });
    assert.equal(ledgerStake(payout, [...entries, other]), 100);
    // hold 없이 refund 만 보이면(목록이 잘림) 모른다 → 0 / ''
    assert.equal(ledgerStake(payout, [payout, out]), 0);
    assert.equal(ledgerCaption(payout, [payout, out]), '');
  });

  it('ledgerCaption: relief 는 고정 문구, 짝을 못 찾은 payout·그 외는 빈 문자열', () => {
    const relief = entry({ id: 2, kind: 'relief', amount: 20, appointmentId: null, appointmentTitle: null, reason: 'topup', reliefFor: 'appt-1' });
    assert.equal(ledgerCaption(relief, [relief]), '참여할 때 모자란 만큼 채워 드렸어요');
    const orphan = entry({ id: 9, kind: 'payout', amount: 80 });
    assert.equal(ledgerCaption(orphan, [orphan]), '');
    assert.equal(ledgerLoss(orphan, [orphan]), 0);
    // 더 최신(id 가 큰) hold 는 짝이 아니다 — 같은 약속에 다시 걸었을 때
    const laterHold = entry({ id: 12 });
    assert.equal(ledgerCaption(orphan, [laterHold, orphan]), '');
    assert.equal(ledgerCaption(entry({}), [entry({})]), '');
  });
});
