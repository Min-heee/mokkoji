/**
 * 약속 내기 — 오류 코드 → 한국어 문구 (설계서 §5.5, §5.3-D, §5.4).
 *
 * 서버는 `raise exception 'LB_XXX'` 로 던진다. 클라이언트는 어떤 모양의 오류든 toLateBetError 로
 * LateBetError(code) 하나로 모은 뒤, 화면은 error.message(한국어)만 그린다.
 * React/RN 을 import 하지 않는다(fakeApi 테스트가 node 에서 돈다).
 */
import { formatKoreanTime } from '../domain/tzGuard';
import type { LbReportReason } from './types';

/** 서버가 던지는 코드 */
export type LbServerErrorCode =
  | 'LB_NOT_SIGNED_IN'
  | 'LB_NO_PROFILE'
  | 'LB_BAD_NICKNAME'
  | 'LB_CONSENT_REQUIRED'
  | 'LB_TOO_MANY_OPEN'
  | 'LB_BAD_POSITION'
  | 'LB_BAD_TZ'
  | 'LB_BAD_TIME'
  | 'LB_TIME_IN_PAST'
  | 'LB_TIME_TOO_FAR'
  | 'LB_TZ_SUSPECT'
  | 'LB_INVITE_NOT_FOUND'
  | 'LB_JOIN_CLOSED'
  | 'LB_APPT_CHANGED'
  | 'LB_NICKNAME_TAKEN'
  | 'LB_FULL'
  | 'LB_INSUFFICIENT_POINTS'
  | 'LB_NOT_HOST'
  | 'LB_NOT_FOUND'
  | 'LB_NOT_MEMBER'
  | 'LB_HOST_CANNOT_LEAVE'
  | 'LB_LEAVE_CLOSED'
  | 'LB_KICK_CLOSED'
  | 'LB_EDIT_CLOSED'
  | 'LB_EDIT_LOCKED'
  | 'LB_CANCEL_CLOSED'
  | 'LB_CLOSED'
  | 'LB_CANNOT_VOUCH_SELF'
  | 'LB_VOUCHER_NOT_ARRIVED'
  | 'LB_INVARIANT_ESCROW_NONZERO';

/** 클라이언트가 만드는 코드 (서버에는 없다) */
export type LbClientErrorCode =
  /** 연결 없음·요청 실패 */
  | 'LB_OFFLINE'
  /** RPC 8초 타임아웃 */
  | 'LB_TIMEOUT'
  /** 모드가 off 이거나 live 구현이 아직 없다(P2) */
  | 'LB_NOT_CONFIGURED'
  /** 익명 로그인 레이트 리밋 */
  | 'LB_RATE_LIMITED'
  /** CHECK 제약 위반(SQLSTATE 23514) */
  | 'LB_CHECK_VIOLATION'
  /** 교착·직렬화 실패(SQLSTATE 40P01·40001) — api 래퍼가 조용히 1회 재시도한다 */
  | 'LB_RETRYABLE'
  | 'LB_UNKNOWN';

export type LateBetErrorCode = LbServerErrorCode | LbClientErrorCode;

const FALLBACK = '잠시 후 다시 시도해 주세요.';

/** 코드 → 문구. 화면 담당은 새 문구를 만들지 말고 여기 것을 쓴다 */
export const LATE_BET_ERROR_MESSAGES: Record<LateBetErrorCode, string> = {
  LB_NOT_SIGNED_IN: '로그인 정보를 다시 확인하는 중이에요. 잠시 후 다시 시도해 주세요.',
  LB_NO_PROFILE: '이름을 먼저 정해 주세요.',
  LB_BAD_NICKNAME: '이름은 1~12자로 적어주세요.',
  LB_CONSENT_REQUIRED: '위치 공유와 연령 확인에 동의해야 참여할 수 있어요.',
  LB_TOO_MANY_OPEN: '열려 있는 약속이 너무 많아요.',
  LB_BAD_POSITION: '장소 위치를 다시 정해 주세요.',
  LB_BAD_TZ: '시간대를 다시 골라 주세요.',
  LB_BAD_TIME: '약속 시각을 다시 확인해 주세요.',
  LB_TIME_IN_PAST: '약속 시각은 지금부터 5분 뒤 이후여야 해요.',
  LB_TIME_TOO_FAR: '90일 안의 약속만 만들 수 있어요.',
  LB_TZ_SUSPECT: '이 장소는 한국과 시간대가 다를 수 있어요. 약속 시각이 어느 시각인지 골라 주세요.',
  LB_INVITE_NOT_FOUND: '초대 코드를 찾을 수 없어요. 코드를 다시 확인해 주세요.',
  LB_JOIN_CLOSED: '지금은 참여할 수 없는 약속이에요. 주최자에게 물어봐 주세요.',
  LB_APPT_CHANGED: '방금 약속이 바뀌었어요. 다시 확인해 주세요.',
  LB_NICKNAME_TAKEN: '이 약속에 같은 이름이 있어요. 다른 이름을 적어주세요.',
  LB_FULL: '참여 인원이 가득 찼어요.',
  LB_INSUFFICIENT_POINTS: '다른 약속에 걸어 둔 포인트가 많아요. 그 약속이 끝나면 참여할 수 있어요.',
  LB_NOT_HOST: '주최자만 할 수 있어요.',
  LB_NOT_FOUND: '약속을 찾을 수 없어요.',
  LB_NOT_MEMBER: '이 약속의 참가자가 아니에요.',
  LB_HOST_CANNOT_LEAVE: '주최자는 나갈 수 없어요. 약속을 취소해 주세요.',
  LB_LEAVE_CLOSED: '위치 공개가 시작돼 지금은 빠질 수 없어요. 못 오면 건 포인트를 잃어요.',
  LB_KICK_CLOSED: '위치 공개가 시작돼 내보낼 수 없어요.',
  LB_EDIT_CLOSED: '끝난 약속은 바꿀 수 없어요.',
  LB_EDIT_LOCKED: '친구가 참여한 뒤에는 바꿀 수 없어요. 취소하고 새로 만들어 주세요.',
  LB_CANCEL_CLOSED: '위치 공개가 시작돼 바꿀 수 없어요.',
  LB_CLOSED: '체크인 시간이 지났어요.',
  LB_CANNOT_VOUCH_SELF: '내 도착은 직접 확인해 줄 수 없어요.',
  LB_VOUCHER_NOT_ARRIVED: '먼저 위치로 도착을 확인한 사람만 눌러 줄 수 있어요.',
  LB_INVARIANT_ESCROW_NONZERO: '결과 확정이 늦어지고 있어요. 포인트는 안전해요.',
  LB_OFFLINE: '연결을 확인해 주세요.',
  LB_TIMEOUT: '연결이 끊겼어요. 다시 연결되면 바로 확인할게요.',
  LB_NOT_CONFIGURED: '지금은 약속 서버에 연결할 수 없어요.',
  LB_RATE_LIMITED: '잠시 후 다시 시도해 주세요.',
  LB_CHECK_VIOLATION: '설정 값을 확인해 주세요.',
  LB_RETRYABLE: FALLBACK,
  LB_UNKNOWN: FALLBACK,
};

/** 수락 실패 때 주최자에게 보여 줄 문구(§4: 대상의 포인트를 채워 줄 수도 없을 때) */
export const APPROVE_INSUFFICIENT_MESSAGE = '이 친구는 포인트가 모자라 수락할 수 없어요.';
/** 서버 오류가 3회 연속일 때 덧붙인다(§5.4) */
export const REPEATED_FAILURE_MESSAGE = '문제가 계속되면 만든 사람에게 알려 주세요.';
/** 오프라인으로 캐시를 보여 줄 때(§5.3-A) */
export const STALE_NOTICE = '연결이 없어 마지막으로 본 내용을 보여드려요.';
/** 서버 장애(§5.3-A) */
export const SERVER_DOWN_NOTICE = '지금은 약속 서버에 연결할 수 없어요.';
/** settlePending 이 1분 넘게 이어질 때(§5.4) */
export const SETTLE_DELAYED_NOTICE = '결과 확정이 늦어지고 있어요. 포인트는 안전해요.';

const KNOWN = new Set<string>(Object.keys(LATE_BET_ERROR_MESSAGES));

export function isLateBetErrorCode(code: unknown): code is LateBetErrorCode {
  return typeof code === 'string' && KNOWN.has(code);
}

/** 코드 → 문구 (모르는 코드는 기본 문구) */
export function errorMessage(code: string | null | undefined): string {
  return isLateBetErrorCode(code) ? LATE_BET_ERROR_MESSAGES[code] : FALLBACK;
}

export class LateBetError extends Error {
  readonly code: LateBetErrorCode;
  /** 디버깅용 원문(화면에 그리지 않는다) */
  readonly detail: string | null;

  constructor(code: LateBetErrorCode, detail?: string | null) {
    super(errorMessage(code));
    this.name = 'LateBetError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

/** 시간대 시트를 띄워야 하는 오류인가 */
export function isTzSuspectError(e: unknown): boolean {
  return e instanceof LateBetError && e.code === 'LB_TZ_SUSPECT';
}

/** 연결 문제인가 (화면은 띠만 띄우고 마지막 상태를 계속 그린다) */
export function isConnectivityError(e: unknown): boolean {
  return e instanceof LateBetError && (e.code === 'LB_OFFLINE' || e.code === 'LB_TIMEOUT');
}

/** 멤버가 아니게 됐는가 (내보내짐·요청 거절·정산이 대기 요청을 지움) */
export function isNotMemberError(e: unknown): boolean {
  return e instanceof LateBetError && e.code === 'LB_NOT_MEMBER';
}

const CODE_IN_TEXT = /LB_[A-Z_]+/;

/**
 * 무엇이 던져졌든 LateBetError 로. PostgREST 오류({ code: SQLSTATE, message })·fetch 실패·AbortError 를 본다.
 */
export function toLateBetError(e: unknown): LateBetError {
  if (e instanceof LateBetError) return e;
  const obj = (e && typeof e === 'object' ? e : {}) as { code?: unknown; message?: unknown; name?: unknown; status?: unknown };
  const message = typeof obj.message === 'string' ? obj.message : typeof e === 'string' ? e : '';
  const sqlstate = typeof obj.code === 'string' ? obj.code : '';

  const m = CODE_IN_TEXT.exec(message);
  if (m && isLateBetErrorCode(m[0])) return new LateBetError(m[0], message);
  if (sqlstate === '23514') return new LateBetError('LB_CHECK_VIOLATION', message);
  if (sqlstate === '40P01' || sqlstate === '40001') return new LateBetError('LB_RETRYABLE', message);
  if (obj.status === 429 || /rate limit/i.test(message)) return new LateBetError('LB_RATE_LIMITED', message);
  if (obj.name === 'AbortError' || /timeout|timed out/i.test(message)) return new LateBetError('LB_TIMEOUT', message);
  if (/network|failed to fetch|fetch failed|offline/i.test(message)) return new LateBetError('LB_OFFLINE', message);
  return new LateBetError('LB_UNKNOWN', message || null);
}

/** 내보내짐·거절 안내(§5.4). wasPending = 마지막으로 본 내 상태가 승인 대기였는가 */
export function removedMessage(wasPending: boolean): string {
  return wasPending ? '주최자가 요청을 받지 않았어요.' : '주최자가 내보냈어요. 건 포인트는 돌려드렸어요.';
}

export interface ReportReasonContext {
  distanceM?: number | null;
  accuracyM?: number | null;
  radiusM: number;
  shareStartMs: number;
  closeMs: number;
  tz: string;
}

/** 체크인 결과 코드 → 문구(§5.4). arrived 면 null */
export function reportReasonMessage(reason: LbReportReason | null, ctx: ReportReasonContext): string | null {
  switch (reason) {
    case null:
    case 'already_arrived':
      return null;
    case 'low_accuracy': {
      const acc = typeof ctx.accuracyM === 'number' && ctx.accuracyM > 0 ? ` (오차 약 ${Math.round(ctx.accuracyM)}m)` : '';
      return `위치가 아직 부정확해요${acc}. 건물 밖이나 창가에서 다시 눌러주세요. 근처에 온 시각은 기록해 뒀어요.`;
    }
    case 'outside': {
      const left = typeof ctx.distanceM === 'number' ? Math.max(1, Math.round(ctx.distanceM - ctx.radiusM)) : null;
      return left === null ? '아직 도착 인정 거리 밖이에요.' : `아직 ${left.toLocaleString('ko-KR')}m 남았어요`;
    }
    case 'not_open':
      return `체크인은 ${formatKoreanTime(ctx.shareStartMs, ctx.tz)}부터예요`;
    case 'mocked':
      return '모의 위치 앱이 켜져 있으면 도착을 확인할 수 없어요.';
    case 'closed':
      return `체크인 시간이 지났어요 (${formatKoreanTime(ctx.closeMs, ctx.tz)}까지였어요).`;
    case 'pending':
      return '주최자가 수락하면 참여돼요.';
    case 'bad_position':
      return '위치를 읽지 못했어요. 다시 눌러주세요.';
    default:
      return FALLBACK;
  }
}
