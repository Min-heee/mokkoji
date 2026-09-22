/**
 * 약속 내기 — 결과 화면(§5.3-G)의 표시 모델 (순수 함수). 담당: [result]
 *
 * lb_get_live 응답 → 순위 행·머리 문장·공유 문구.
 * - 정산이 끝났으면(settled·voided) 서버가 준 resultStatus·forfeited·received 가 기준이다.
 * - 아직이면(settling) 서버가 준 도착 시각으로 엔진(settleLateBet)을 돌린 '진행 중 순위'를 그린다(provisional).
 * - 끝난 뒤에도 엔진을 한 번 돌려 서버 값과 비교한다(mismatch) — 개발 빌드의 '계산 불일치' 배너용(§4).
 * - 시작하지 않아 무효(voidReason 'notStarted', 오너 확정 2026-09-18 규칙 6): 체크인이 열린 적이 없으므로
 *   순위·도착·'오지 않음'을 그리지 않고 참여한 사람 이름만 남긴다. 건 포인트가 없으면 status 가 settled 여도 같은 문구.
 * - 취소(status canceled)는 컨테이너가 안내를 그리지만 문구는 여기(canceledText)에 둔다.
 * React/RN 을 import 하지 않는다(node 테스트).
 */
import { settleLateBet, type LateBetStatus } from '../domain/lateBet';
import { formatLoss, formatMinutes } from '../domain/latePresets';
import { formatKoreanDateTime, formatKoreanTime, tzLabel } from '../domain/tzGuard';
import type { LbLive, LbLiveParticipant } from './types';

export type ResultKind = 'settling' | 'settled' | 'voided';

export interface ResultRow {
  userId: string;
  nickname: string;
  isMe: boolean;
  /** 화면 순서(1부터). 먼저 온 순, 오지 않은 사람은 참여 순으로 맨 뒤 */
  rank: number;
  arrivedAtMs: number | null;
  status: LateBetStatus;
  /** 약속 시각 기준 지각 분(올림). 제시간·오지 않음은 0 */
  lateMinutes: number;
  /** '오후 7:21' · 오지 않았으면 '' */
  timeText: string;
  /** '제시간' · '7분 지각' · '오지 않음' */
  statusText: string;
  /** 판정 근거: 'GPS ±12m' · 'GPS' · '친구 확인' · 오지 않았으면 '' */
  basisText: string;
  forfeited: number;
  received: number;
  /** received − forfeited */
  net: number;
}

export interface ResultModel {
  kind: ResultKind;
  /** '금요일 곱창 결과' */
  title: string;
  /** 머리 문장 */
  headline: string;
  rows: ResultRow[];
  /** 실제로 오간 포인트 합(무효·내기 없음이면 0) */
  pot: number;
  /** 제시간에 온 사람 수 */
  onTimeCount: number;
  /** 건 포인트가 있는 약속인가 (없으면 증감 열을 그리지 않는다) */
  hasStake: boolean;
  /** 아직 확정 전 — 증감은 '예정' */
  provisional: boolean;
  /** 서버 결과와 엔진 재계산이 다르다(개발 빌드 배너용). 확정 전에는 항상 false */
  mismatch: boolean;
  /** 주최자가 약속 시각까지 시작하지 않아 무효 — 순위·도착·증감이 없다(행은 이름만) */
  notStarted: boolean;
}

export const VOID_NO_WINNER_TEXT = '제시간에 온 사람이 없어 내기는 무효예요. 건 포인트는 모두 돌려드렸어요.';
export const VOID_NOT_STARTED_TEXT = '주최자가 시작하지 않아 내기는 무효예요. 건 포인트는 모두 돌려드렸어요.';
/** 시작하지 않아 무효인데 건 포인트가 없던 약속(status 는 settled, voidReason 은 notStarted) */
export const NOT_STARTED_NO_STAKE_TEXT = '주최자가 시작하지 않아 약속이 무효예요.';
export const VOID_OTHER_TEXT = '내기는 무효예요. 건 포인트는 모두 돌려드렸어요.';
export const SETTLING_TEXT = '결과를 확정하는 중이에요';
export const NO_STAKE_TEXT = '포인트 없이 진행한 약속이에요.';
export const NO_LOSS_TEXT = '잃은 포인트가 없어요. 건 포인트는 모두 돌려드렸어요.';

/** 부호 있는 포인트: '+60P' · '−20P'(U+2212) · '0P' */
export function formatSignedPoints(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0P';
  return n > 0 ? `+${n.toLocaleString('ko-KR')}P` : formatLoss(-n);
}

function statusText(status: LateBetStatus, lateMinutes: number): string {
  if (status === 'noShow') return '오지 않음';
  if (status === 'late') return `${formatMinutes(Math.max(1, lateMinutes))} 지각`;
  return '제시간';
}

function basisText(p: LbLiveParticipant): string {
  if (p.arrivedAtMs === null) return '';
  if (p.arrivalMethod === 'vouch') return '친구 확인';
  if (p.arrivalMethod === 'gps') {
    const acc = p.arrivalAccuracyM;
    return typeof acc === 'number' && Number.isFinite(acc) && acc > 0 ? `GPS ±${Math.round(acc)}m` : 'GPS';
  }
  return '';
}

/** 결과 화면 모델. kind 는 latePhase.phase 의 settling | settled | voided */
export function buildResultModel(live: LbLive, kind: ResultKind): ResultModel {
  const a = live.appointment;
  const active = live.participants.filter((p) => p.state === 'active');
  const engine = settleLateBet(
    a.policy,
    active.map((p) => p.userId),
    active.map((p) => ({ personId: p.userId, arrivedAtMs: p.arrivedAtMs })),
    a.meetAtMs,
  );
  const engineById = new Map(engine.persons.map((r) => [r.personId, r]));
  const provisional = kind === 'settling';
  const hasStake = a.policy.stake > 0;
  // 시작 없이 무효: 확정된 결과에만 있다(정산 전이면 phase 가 waiting 이라 여기 오지 않는다)
  const notStarted = !provisional && a.voidReason === 'notStarted';

  let mismatch = false;
  const unordered = active.map((p, index) => {
    const e = engineById.get(p.userId);
    const serverHas = !provisional && p.resultStatus !== null;
    const status: LateBetStatus = serverHas ? (p.resultStatus as LateBetStatus) : e?.status ?? (p.arrivedAtMs === null ? 'noShow' : 'onTime');
    const forfeited = serverHas ? p.forfeited ?? 0 : e?.forfeited ?? 0;
    const received = serverHas ? p.received ?? 0 : e?.received ?? 0;
    if (serverHas && e && (e.status !== status || e.forfeited !== forfeited || e.received !== received)) mismatch = true;
    const lateMinutes = status === 'late' ? e?.lateMinutes ?? 0 : 0;
    // 기록상 오지 않음이면 시각을 그리지 않는다(마감 뒤에 찍힌 도착이 있어도 결과는 '오지 않음'이다)
    const arrivedAtMs = status === 'noShow' ? null : p.arrivedAtMs;
    return {
      index,
      row: {
        userId: p.userId,
        nickname: p.nickname,
        isMe: p.userId === live.myUserId,
        rank: 0,
        arrivedAtMs,
        status,
        lateMinutes,
        timeText: arrivedAtMs === null ? '' : formatKoreanTime(arrivedAtMs, a.tz),
        // 시작한 적이 없으면 '오지 않음'도 판정이 아니다 — 이름만 남긴다
        statusText: notStarted ? '' : statusText(status, lateMinutes),
        basisText: status === 'noShow' ? '' : basisText(p),
        forfeited,
        received,
        net: received - forfeited,
      } satisfies ResultRow,
    };
  });
  // 무효 여부도 맞아야 한다(서버는 건 포인트가 있을 때만 voided 로 닫는다)
  const engineVoided = engine.voided && hasStake;
  if (!provisional && (kind === 'voided') !== engineVoided) mismatch = true;

  unordered.sort((x, y) => {
    const ax = x.row.arrivedAtMs;
    const ay = y.row.arrivedAtMs;
    if (ax !== null && ay !== null) return ax - ay || x.index - y.index;
    if (ax !== null) return -1;
    if (ay !== null) return 1;
    return x.index - y.index;
  });
  const rows = unordered.map((u, i) => ({ ...u.row, rank: i + 1 }));

  const voided = kind === 'voided';
  const pot = voided || !hasStake ? 0 : rows.reduce((s, r) => s + r.forfeited, 0);
  const winners = rows.filter((r) => r.status === 'onTime');

  let headline: string;
  if (provisional) headline = SETTLING_TEXT;
  else if (notStarted) headline = hasStake ? VOID_NOT_STARTED_TEXT : NOT_STARTED_NO_STAKE_TEXT;
  else if (voided) headline = a.voidReason === 'noWinner' || a.voidReason === null ? VOID_NO_WINNER_TEXT : VOID_OTHER_TEXT;
  else if (!hasStake) headline = NO_STAKE_TEXT;
  else if (pot === 0) headline = NO_LOSS_TEXT;
  else if (winners.length === 1) headline = `모인 포인트 ${pot.toLocaleString('ko-KR')}P → 제시간에 온 ${winners[0].nickname}님이 모두 가졌어요`;
  else headline = `모인 포인트 ${pot.toLocaleString('ko-KR')}P → 제시간에 온 ${winners.length}명이 나눠 가졌어요`;

  return {
    kind,
    title: `${a.title} 결과`,
    headline,
    rows,
    pot,
    onTimeCount: winners.length,
    hasStake,
    provisional,
    mismatch: provisional ? false : mismatch,
    notStarted,
  };
}

/**
 * 취소 안내(status canceled). 주최자 본인과 참가자의 문장이 다르고, 건 포인트가 있었으면 환불 사실을 덧붙인다.
 * 컨테이너(app/late/[id])가 그리는 문구와 같다 — 한 곳에서 관리하려고 여기 둔다.
 */
export function canceledText(live: Pick<LbLive, 'myState' | 'appointment'>, isHost: boolean): string {
  const stake = live.appointment.policy.stake;
  const refund = stake > 0 && live.myState === 'active' ? ` 건 ${stake.toLocaleString('ko-KR')}P는 돌려드렸어요.` : '';
  return `${isHost ? '약속을 취소했어요.' : '주최자가 약속을 취소했어요.'}${refund}`;
}

/** 한 줄의 둘째 줄: '오후 7:21 · 제시간 · GPS ±12m' · '오지 않음' */
export function resultRowDetail(row: ResultRow): string {
  return [row.timeText, row.statusText, row.basisText].filter((s) => s !== '').join(' · ');
}

/** 한 줄의 증감 표기. 무효·내기 없음이면 '' (열 자체를 그리지 않는다) */
export function resultRowDelta(model: ResultModel, row: ResultRow): string {
  if (!model.hasStake || model.kind === 'voided' || model.notStarted) return '';
  const text = formatSignedPoints(row.net);
  return model.provisional && row.net !== 0 ? `${text} 예정` : text;
}

/**
 * [결과 공유] 텍스트.
 *
 *   [모꼬지] 금요일 곱창 결과
 *   9월 25일 (금) 오후 7:30 · 강남역 2번 출구 곱창
 *   모인 포인트 120P → 제시간에 온 2명이 나눠 가졌어요
 *   1. 지수 · 오후 7:21 · 제시간 · GPS ±12m · +60P
 */
export function buildResultShareText(live: LbLive, model: ResultModel): string {
  const a = live.appointment;
  const when = formatKoreanDateTime(a.meetAtMs, a.tz);
  const zone = a.tz === 'Asia/Seoul' ? '' : ` (${tzLabel(a.tz)})`;
  const lines = [`[모꼬지] ${model.title}`, [`${when}${zone}`, a.placeName].filter((s) => s.trim() !== '').join(' · '), model.headline];
  if (model.notStarted) {
    // 순위가 없다 — 들어와 있던 사람 이름만
    if (model.rows.length > 0) lines.push(`참여: ${model.rows.map((r) => r.nickname).join(', ')}`);
    return lines.filter((s) => s !== '').join('\n');
  }
  for (const r of model.rows) {
    const delta = resultRowDelta(model, r);
    lines.push(`${r.rank}. ${[r.nickname, resultRowDetail(r), delta].filter((s) => s !== '').join(' · ')}`);
  }
  return lines.filter((s) => s !== '').join('\n');
}
