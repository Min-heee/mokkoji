/**
 * 약속 내기 — 홈 '약속' 카드(§5.3-A)와 포인트 화면(§5.3-H)의 표시 모델 (순수 함수). 담당: [result]
 * React/RN 을 import 하지 않는다(node 테스트). 시각은 전부 '서버 기준 지금'을 인자로 받는다.
 */
import { formatFromNow, formatKoreanDateTime, SEOUL_TZ, tzLabel } from '../domain/tzGuard';
import type { LbLedgerEntry, LbMyAppointment } from './types';

/**
 * 홈 카드 배지(오너 확정 2026-09-18). 한 카드에 하나: 끝남 > 정산 확인 중 > 진행 중(주최자가 시작함) > 모이는 중(시작 전).
 * 열린 약속에는 항상 배지가 하나 붙는다.
 */
export type HomeBadge = 'ended' | 'settling' | 'inProgress' | 'gathering';

export const HOME_BADGE_LABEL: Record<HomeBadge, string> = {
  ended: '끝남',
  settling: '정산 확인 중',
  inProgress: '진행 중',
  gathering: '모이는 중',
};

export function homeBadge(a: LbMyAppointment, serverNowMs: number): HomeBadge {
  if (a.status !== 'open') return 'ended';
  if (Number.isFinite(serverNowMs) && serverNowMs > a.closeMs) return 'settling';
  return a.startedAtMs !== null ? 'inProgress' : 'gathering';
}

/** 둘째 줄: '9월 25일 (금) 오후 7:30 · 2시간 뒤' (한국이 아니면 시간대 라벨을 붙인다) */
export function homeTimeLine(a: LbMyAppointment, serverNowMs: number): string {
  const when = formatKoreanDateTime(a.meetAtMs, a.tz);
  const zone = a.tz === SEOUL_TZ ? '' : tzLabel(a.tz);
  let tail = '';
  if (a.status === 'canceled') tail = '취소됨';
  else if (a.status === 'voided') tail = '무효';
  else if (a.status === 'settled') tail = '';
  else if (Number.isFinite(serverNowMs) && serverNowMs <= a.closeMs) tail = formatFromNow(a.meetAtMs - serverNowMs);
  return [when, zone, tail].filter((s) => s !== '').join(' · ');
}

/** 셋째 줄: '강남역 2번 출구 곱창 · 4명 · 100P 내기' */
export function homeMetaLine(a: LbMyAppointment): string {
  const place = a.placeName.trim();
  const count = a.memberCount > 0 ? `${a.memberCount}명` : '';
  const stake = a.policy.stake > 0 ? `${a.policy.stake.toLocaleString('ko-KR')}P 내기` : '위치만 공유';
  return [place, count, stake].filter((s) => s !== '').join(' · ');
}

/** 주최자에게만: 명단에서 아직 안 들어온 친구 수 (푸시가 없어 홈에서 알려 준다). 시작 뒤에도 약속 시각까지는 들어올 수 있어 계속 보여 준다 */
export function homeUnclaimedLine(a: LbMyAppointment): string {
  if (!a.isHost || a.status !== 'open' || a.unclaimedCount <= 0) return '';
  return `아직 안 들어온 친구 ${a.unclaimedCount}명`;
}

/** 열린 약속은 전부, 끝난 약속은 최근 limit 개만 (목록은 이미 열린 것 → 끝난 것 순으로 온다) */
export function splitHomeAppointments(
  list: readonly LbMyAppointment[],
  endedLimit: number,
): { shown: LbMyAppointment[]; hiddenEnded: number } {
  const open = list.filter((a) => a.status === 'open');
  const ended = list.filter((a) => a.status !== 'open');
  const keep = Math.max(0, endedLimit);
  return { shown: [...open, ...ended.slice(0, keep)], hiddenEnded: Math.max(0, ended.length - keep) };
}

/** 열린 약속에 걸어 둔 포인트 합 */
export function heldPoints(list: readonly LbMyAppointment[]): { points: number; count: number } {
  let points = 0;
  let count = 0;
  for (const a of list) {
    if (a.status !== 'open' || a.myState !== 'active' || a.policy.stake <= 0) continue;
    points += a.policy.stake;
    count += 1;
  }
  return { points, count };
}

// ───────────────────────── 원장 ─────────────────────────

const REFUND_LABEL: Record<string, string> = {
  leave: '나가서 돌려받음',
  canceled: '약속 취소로 돌려받음',
  kicked: '내보내져 돌려받음',
  policy_change: '조건 변경으로 돌려받음',
  notStarted: '시작하지 않아 돌려받음',
};

/** 원장 한 줄의 이름: '금요일 곱창 · 건 포인트' · '모자란 포인트 채움' · '시작 포인트' */
export function ledgerLabel(e: LbLedgerEntry): string {
  const title = (e.appointmentTitle ?? '').trim();
  const withTitle = (what: string) => (title ? `${title} · ${what}` : what);
  switch (e.kind) {
    case 'grant':
      return '시작 포인트';
    case 'relief':
      return '모자란 포인트 채움';
    case 'hold':
      return withTitle('건 포인트');
    case 'refund':
      return withTitle(REFUND_LABEL[e.reason ?? ''] ?? '돌려받음');
    case 'payout':
      return withTitle('결과');
    default:
      return withTitle('포인트');
  }
}

/** 원장 금액: '+1,000' · '−100'(U+2212) · '0' */
export function ledgerAmount(amount: number): string {
  if (!Number.isFinite(amount) || amount === 0) return '0';
  const abs = Math.abs(amount).toLocaleString('ko-KR');
  return amount > 0 ? `+${abs}` : `−${abs}`;
}

/**
 * payout 시점에 그 약속에 실제로 걸려 있던 포인트. 같은 약속의 payout 이전 hold(음수)·refund(양수)를 전부 합산한다.
 * 시작 전 걸 포인트 변경은 원래 hold 를 대체하지 않고 차액 hold(policy_change) 또는 refund(policy_change) 를
 * 한 줄 더 쓰므로(fakeApi.edit · SQL lb_edit_appointment) '가장 최근 hold 한 줄'로는 틀린다. 나갔다 다시 참여한
 * 경우(hold · refund(leave) · hold)도 같은 식으로 맞아떨어진다. 짝을 못 찾으면(목록이 잘렸을 때) 0.
 */
export function ledgerStake(e: LbLedgerEntry, entries: readonly LbLedgerEntry[]): number {
  if (e.kind !== 'payout' || e.appointmentId === null) return 0;
  let held = 0;
  let found = false;
  for (const x of entries) {
    if (x.appointmentId !== e.appointmentId || x.id >= e.id) continue;
    if (x.kind === 'hold') {
      held -= x.amount;
      found = true;
    } else if (x.kind === 'refund') {
      held -= x.amount;
    }
  }
  if (!found || !(held > 0)) return 0;
  return held;
}

/**
 * 원장 한 줄의 보조 설명. payout 은 같은 약속에 실제로 걸려 있던 포인트(ledgerStake)와 짝지어 풀어 쓴다:
 * '건 100P 중 20P를 잃었어요' · '건 100P에 60P를 더 받았어요' · '건 100P를 그대로 돌려받았어요'.
 * entries 는 최신순(listLedger 그대로). 짝을 못 찾으면(목록이 잘렸을 때) ''.
 */
export function ledgerCaption(e: LbLedgerEntry, entries: readonly LbLedgerEntry[]): string {
  if (e.kind === 'relief') return '참여할 때 모자란 만큼 채워 드렸어요';
  if (e.kind !== 'payout' || e.appointmentId === null) return '';
  const stake = ledgerStake(e, entries);
  if (!(stake > 0)) return '';
  const p = (n: number) => `${n.toLocaleString('ko-KR')}P`;
  if (e.amount === stake) return `건 ${p(stake)}를 그대로 돌려받았어요`;
  if (e.amount > stake) return `건 ${p(stake)}에 ${p(e.amount - stake)}를 더 받았어요`;
  if (e.amount <= 0) return `건 ${p(stake)}를 모두 잃었어요`;
  return `건 ${p(stake)} 중 ${p(stake - e.amount)}를 잃었어요`;
}

/** payout 에서 잃은 포인트(실제로 걸려 있던 포인트 기준). 잃지 않았거나 모르면 0 — 원장에서 브릭색을 쓸지 정한다 */
export function ledgerLoss(e: LbLedgerEntry, entries: readonly LbLedgerEntry[]): number {
  const stake = ledgerStake(e, entries);
  if (!(stake > 0)) return 0;
  return Math.max(0, stake - e.amount);
}
