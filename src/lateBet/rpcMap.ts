/**
 * 약속 내기 — Supabase 응답(jsonb·테이블 행) → DTO(types.ts) 매퍼와 오류 매핑. 순수 함수(React/RN/supabase-js import 없음).
 *
 * 응답 모양은 supabase/migrations/20260918000000_late_bet.sql 의 jsonb_build_object 를 그대로 읽어 맞췄다.
 * - RPC jsonb 는 전부 camelCase(lb_appointment_json·lb_get_live·lb_peek_invite·lb_claim_slot·lb_report_location·lb_ping).
 *   시각은 private.lb_ms(= floor(epoch*1000)) 라 JSON number(ms) 다.
 *   홈 목록·원장도 RPC(lb_list_my_appointments·lb_list_ledger, camelCase jsonb)다 — RLS select 로는 내보내진 약속의 제목을 못 보고
 *   게으른 정산도 못 하기 때문(마이그레이션 15.5·15.6).
 * - 예외: lb_ensure_profile 은 `returns public.profiles`(복합 타입) → PostgREST 가 테이블 행 그대로(snake_case:
 *   user_id·nickname·balance·created_at) 객체 하나로 준다. getMyProfile 의 RLS select(profiles)도 같은 snake_case 행.
 *
 * 검증: 필수 필드가 없거나 타입이 다르면 LB_BAD_RESPONSE 를 던진다. 조용히 NaN·undefined 를 만들지 않는다.
 * nullable 필드는 null 과 '키 없음'(jsonb 에서 null 이 빠지는 경우 대비)을 같은 null 로 받는다.
 */
import { LateBetError, isLateBetErrorCode, toLateBetError, type LateBetErrorCode } from './errors';
import type {
  LatePolicy,
  LbAppointment,
  LbAppointmentChange,
  LbAppointmentSnapshot,
  LbArrivalMethod,
  LbInvitee,
  LbInvitePreview,
  LbJoinResult,
  LbLedgerEntry,
  LbLedgerKind,
  LbLedgerReason,
  LbLive,
  LbLiveLocation,
  LbLiveParticipant,
  LbMyAppointment,
  LbPing,
  LbProfile,
  LbReportReason,
  LbReportResult,
  LbResultStatus,
  LbVoidReason,
  LateAppointmentStatus,
} from './types';

// ───────────────────────── 검증 도구 ─────────────────────────

type Obj = Record<string, unknown>;

function bad(path: string, why: string): LateBetError {
  return new LateBetError('LB_BAD_RESPONSE', `${path}: ${why}`);
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function asObj(v: unknown, path: string): Obj {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw bad(path, `객체가 아니다(${describe(v)})`);
  return v as Obj;
}

function asArr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw bad(path, `배열이 아니다(${describe(v)})`);
  return v;
}

function num(o: Obj, k: string, path: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${path}.${k}`, `유한한 숫자가 아니다(${describe(v)})`);
  return v;
}

function numOrNull(o: Obj, k: string, path: string): number | null {
  const v = o[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${path}.${k}`, `숫자·null 이 아니다(${describe(v)})`);
  return v;
}

function int(o: Obj, k: string, path: string): number {
  const v = num(o, k, path);
  if (!Number.isInteger(v)) throw bad(`${path}.${k}`, '정수가 아니다');
  return v;
}

/** PostgREST 는 bigint 를 숫자로 주지만, 안전 범위를 넘으면 문자열이 될 수 있다 → 정수 문자열도 받는다 */
function bigintNum(o: Obj, k: string, path: string): number {
  const v = o[k];
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n)) return n;
  }
  return int(o, k, path);
}

function str(o: Obj, k: string, path: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw bad(`${path}.${k}`, `문자열이 아니다(${describe(v)})`);
  return v;
}

function strOrNull(o: Obj, k: string, path: string): string | null {
  const v = o[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw bad(`${path}.${k}`, `문자열·null 이 아니다(${describe(v)})`);
  return v;
}

function bool(o: Obj, k: string, path: string): boolean {
  const v = o[k];
  if (typeof v !== 'boolean') throw bad(`${path}.${k}`, `불리언이 아니다(${describe(v)})`);
  return v;
}

function oneOf<T extends string>(o: Obj, k: string, path: string, allowed: readonly T[]): T {
  const v = str(o, k, path);
  if (!(allowed as readonly string[]).includes(v)) throw bad(`${path}.${k}`, `알 수 없는 값 '${v}'`);
  return v as T;
}

function oneOfOrNull<T extends string>(o: Obj, k: string, path: string, allowed: readonly T[]): T | null {
  const v = strOrNull(o, k, path);
  if (v === null) return null;
  if (!(allowed as readonly string[]).includes(v)) throw bad(`${path}.${k}`, `알 수 없는 값 '${v}'`);
  return v as T;
}

const STATUSES: readonly LateAppointmentStatus[] = ['open', 'settled', 'voided', 'canceled'];
const VOID_REASONS: readonly LbVoidReason[] = ['noStake', 'noWinner', 'invalidDeadline', 'notStarted'];
const ARRIVAL_METHODS: readonly LbArrivalMethod[] = ['gps', 'vouch'];
const RESULT_STATUSES: readonly LbResultStatus[] = ['onTime', 'late', 'noShow'];
const LEDGER_KINDS: readonly LbLedgerKind[] = ['grant', 'relief', 'hold', 'refund', 'payout'];
const LEDGER_REASONS: readonly LbLedgerReason[] = [
  'signup',
  'topup',
  'leave',
  'canceled',
  'kicked',
  'policy_change',
  'notStarted',
];
const REPORT_REASONS: readonly LbReportReason[] = [
  'closed',
  'already_arrived',
  'not_open',
  'bad_position',
  'mocked',
  'low_accuracy',
  'outside',
];

/** state 는 'active' 하나뿐(수락제 없음) */
function memberState(o: Obj, k: string, path: string): 'active' {
  return oneOf(o, k, path, ['active'] as const);
}

// ───────────────────────── RPC jsonb → DTO ─────────────────────────

/** lb_policy_json: {stake, radiusM, unitMinutes, penaltyPerUnit, graceMinutes} */
export function mapPolicy(v: unknown, path = 'policy'): LatePolicy {
  const o = asObj(v, path);
  return {
    stake: int(o, 'stake', path),
    radiusM: int(o, 'radiusM', path),
    unitMinutes: int(o, 'unitMinutes', path),
    penaltyPerUnit: int(o, 'penaltyPerUnit', path),
    graceMinutes: int(o, 'graceMinutes', path),
  };
}

/** lb_invitees_json 의 한 칸: {name, claimedByUserId, claimedAtMs} */
export function mapInvitee(v: unknown, path: string): LbInvitee {
  const o = asObj(v, path);
  return {
    name: str(o, 'name', path),
    claimedByUserId: strOrNull(o, 'claimedByUserId', path),
    claimedAtMs: numOrNull(o, 'claimedAtMs', path),
  };
}

/** lb_snapshot: {localAt, tz, meetAtMs, placeName, placeLat, placeLng, policy} */
export function mapSnapshot(v: unknown, path: string): LbAppointmentSnapshot {
  const o = asObj(v, path);
  return {
    localAt: str(o, 'localAt', path),
    tz: str(o, 'tz', path),
    meetAtMs: num(o, 'meetAtMs', path),
    placeName: str(o, 'placeName', path),
    placeLat: num(o, 'placeLat', path),
    placeLng: num(o, 'placeLng', path),
    policy: mapPolicy(o.policy, `${path}.policy`),
  };
}

/** changes 한 건: {version, atMs, before, after} */
export function mapChange(v: unknown, path: string): LbAppointmentChange {
  const o = asObj(v, path);
  return {
    version: int(o, 'version', path),
    atMs: num(o, 'atMs', path),
    before: mapSnapshot(o.before, `${path}.before`),
    after: mapSnapshot(o.after, `${path}.after`),
  };
}

/** lb_appointment_json (lb_create_appointment·lb_start·lb_edit_appointment·lb_edit_invitees·lb_get_live.appointment) */
export function mapAppointment(v: unknown, path = 'appointment'): LbAppointment {
  const o = asObj(v, path);
  return {
    id: str(o, 'id', path),
    inviteCode: str(o, 'inviteCode', path),
    hostId: str(o, 'hostId', path),
    // 주최자 참가자 행이 없을 수는 없지만(자동 참여), 있더라도 화면이 죽지 않게 null 은 빈 문자열이 아니라 오류로 본다
    hostNickname: str(o, 'hostNickname', path),
    title: str(o, 'title', path),
    localAt: str(o, 'localAt', path),
    tz: str(o, 'tz', path),
    meetAtMs: num(o, 'meetAtMs', path),
    startedAtMs: numOrNull(o, 'startedAtMs', path),
    closeMs: num(o, 'closeMs', path),
    placeName: str(o, 'placeName', path),
    placeNote: str(o, 'placeNote', path),
    placeLat: num(o, 'placeLat', path),
    placeLng: num(o, 'placeLng', path),
    status: oneOf(o, 'status', path, STATUSES),
    voidReason: oneOfOrNull(o, 'voidReason', path, VOID_REASONS),
    version: int(o, 'version', path),
    policy: mapPolicy(o.policy, `${path}.policy`),
    invitees: asArr(o.invitees, `${path}.invitees`).map((x, i) => mapInvitee(x, `${path}.invitees[${i}]`)),
    changes: asArr(o.changes, `${path}.changes`).map((x, i) => mapChange(x, `${path}.changes[${i}]`)),
  };
}

/** lb_ping: {serverNowMs, minBuild, iosUrl, androidUrl} */
export function mapPing(v: unknown): LbPing {
  const path = 'lb_ping';
  const o = asObj(v, path);
  return {
    serverNowMs: num(o, 'serverNowMs', path),
    minBuild: int(o, 'minBuild', path),
    iosUrl: str(o, 'iosUrl', path),
    androidUrl: str(o, 'androidUrl', path),
  };
}

/**
 * lb_ensure_profile: `returns public.profiles` → 행 그대로 {user_id, nickname, balance, created_at}.
 * (PostgREST 설정에 따라 한 칸짜리 배열로 올 수도 있어 둘 다 받는다)
 */
export function mapProfileRow(v: unknown, path = 'profiles'): LbProfile {
  const row = Array.isArray(v) ? (v.length === 1 ? v[0] : undefined) : v;
  const o = asObj(row, path);
  return {
    userId: str(o, 'user_id', path),
    nickname: str(o, 'nickname', path),
    balance: int(o, 'balance', path),
  };
}

/** lb_peek_invite */
export function mapInvitePreview(v: unknown): LbInvitePreview {
  const path = 'lb_peek_invite';
  const o = asObj(v, path);
  return {
    id: str(o, 'id', path),
    title: str(o, 'title', path),
    hostNickname: str(o, 'hostNickname', path),
    localAt: str(o, 'localAt', path),
    tz: str(o, 'tz', path),
    meetAtMs: num(o, 'meetAtMs', path),
    startedAtMs: numOrNull(o, 'startedAtMs', path),
    closeMs: num(o, 'closeMs', path),
    placeName: str(o, 'placeName', path),
    placeNote: str(o, 'placeNote', path),
    placeLat: num(o, 'placeLat', path),
    placeLng: num(o, 'placeLng', path),
    status: oneOf(o, 'status', path, STATUSES),
    version: int(o, 'version', path),
    serverNowMs: num(o, 'serverNowMs', path),
    policy: mapPolicy(o.policy, `${path}.policy`),
    memberCount: int(o, 'memberCount', path),
    invitees: asArr(o.invitees, `${path}.invitees`).map((x, i) => {
      const p = `${path}.invitees[${i}]`;
      const it = asObj(x, p);
      return { name: str(it, 'name', p), claimed: bool(it, 'claimed', p), mine: bool(it, 'mine', p) };
    }),
    myState: o.myState === null || o.myState === undefined ? null : memberState(o, 'myState', path),
    myBalance: numOrNull(o, 'myBalance', path),
  };
}

/** lb_claim_slot: {appointmentId, state, started} */
export function mapJoinResult(v: unknown): LbJoinResult {
  const path = 'lb_claim_slot';
  const o = asObj(v, path);
  return {
    appointmentId: str(o, 'appointmentId', path),
    state: memberState(o, 'state', path),
    started: bool(o, 'started', path),
  };
}

/** lb_report_location: {arrived, reason, arrivedAtMs, distanceM, serverNowMs} */
export function mapReportResult(v: unknown): LbReportResult {
  const path = 'lb_report_location';
  const o = asObj(v, path);
  const arrived = bool(o, 'arrived', path);
  const reason = oneOfOrNull(o, 'reason', path, REPORT_REASONS);
  // already_arrived 는 arrived=true 인 채로 reason 이 붙는다(SQL: 'arrived', me.arrived_at is not null)
  if (!arrived && reason === null) throw bad(path, 'arrived=false 인데 reason 이 없다');
  return {
    arrived,
    reason,
    arrivedAtMs: numOrNull(o, 'arrivedAtMs', path),
    distanceM: numOrNull(o, 'distanceM', path),
    serverNowMs: num(o, 'serverNowMs', path),
  };
}

function mapLiveLocation(v: unknown, path: string): LbLiveLocation | null {
  if (v === null || v === undefined) return null;
  const o = asObj(v, path);
  return {
    lat: num(o, 'lat', path),
    lng: num(o, 'lng', path),
    accuracyM: numOrNull(o, 'accuracyM', path),
    updatedAtMs: num(o, 'updatedAtMs', path),
    distanceM: num(o, 'distanceM', path),
  };
}

function mapLiveParticipant(v: unknown, path: string): LbLiveParticipant {
  const o = asObj(v, path);
  return {
    userId: str(o, 'userId', path),
    nickname: str(o, 'nickname', path),
    state: memberState(o, 'state', path),
    joinedAtMs: num(o, 'joinedAtMs', path),
    arrivedAtMs: numOrNull(o, 'arrivedAtMs', path),
    arrivalMethod: oneOfOrNull(o, 'arrivalMethod', path, ARRIVAL_METHODS),
    arrivalDistanceM: numOrNull(o, 'arrivalDistanceM', path),
    arrivalAccuracyM: numOrNull(o, 'arrivalAccuracyM', path),
    vouchedBy: strOrNull(o, 'vouchedBy', path),
    resultStatus: oneOfOrNull(o, 'resultStatus', path, RESULT_STATUSES),
    forfeited: numOrNull(o, 'forfeited', path),
    received: numOrNull(o, 'received', path),
    lastSeenMs: numOrNull(o, 'lastSeenMs', path),
    location: mapLiveLocation(o.location, `${path}.location`),
  };
}

/** lb_get_live */
export function mapLive(v: unknown): LbLive {
  const path = 'lb_get_live';
  const o = asObj(v, path);
  return {
    serverNowMs: num(o, 'serverNowMs', path),
    myUserId: str(o, 'myUserId', path),
    myState: memberState(o, 'myState', path),
    myBalance: int(o, 'myBalance', path),
    settlePending: bool(o, 'settlePending', path),
    appointment: mapAppointment(o.appointment, `${path}.appointment`),
    participants: asArr(o.participants, `${path}.participants`).map((x, i) =>
      mapLiveParticipant(x, `${path}.participants[${i}]`),
    ),
  };
}

/** void RPC(lb_leave·lb_kick·lb_update_memo·lb_cancel·lb_stop_sharing·lb_vouch): PostgREST 는 null(또는 빈 본문)을 준다 */
export function mapVoid(v: unknown): void {
  if (v === null || v === undefined || v === '') return;
  throw bad('void', `빈 응답이 아니다(${describe(v)})`);
}

/** getMyProfile: profiles RLS select(maybeSingle, snake_case 행). 행이 없으면 null */
export function mapMaybeProfileRow(v: unknown): LbProfile | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v) && v.length === 0) return null;
  return mapProfileRow(v);
}

/** lb_list_my_appointments 한 줄 */
function mapMyAppointment(v: unknown, path: string): LbMyAppointment {
  const o = asObj(v, path);
  return {
    id: str(o, 'id', path),
    title: str(o, 'title', path),
    localAt: str(o, 'localAt', path),
    tz: str(o, 'tz', path),
    meetAtMs: num(o, 'meetAtMs', path),
    startedAtMs: numOrNull(o, 'startedAtMs', path),
    closeMs: num(o, 'closeMs', path),
    placeName: str(o, 'placeName', path),
    status: oneOf(o, 'status', path, STATUSES),
    policy: mapPolicy(o.policy, `${path}.policy`),
    hostId: str(o, 'hostId', path),
    isHost: bool(o, 'isHost', path),
    myState: memberState(o, 'myState', path),
    memberCount: int(o, 'memberCount', path),
    unclaimedCount: int(o, 'unclaimedCount', path),
  };
}

/** lb_list_my_appointments: 서버가 이미 열린(가까운 순) → 끝난(최근 순)으로 정렬해 준다. 순서는 그대로 둔다 */
export function mapMyAppointments(v: unknown): LbMyAppointment[] {
  const path = 'lb_list_my_appointments';
  return asArr(v, path).map((x, i) => mapMyAppointment(x, `${path}[${i}]`));
}

/** lb_list_ledger: [{id, kind, amount, balanceAfter, appointmentId, appointmentTitle, reason, reliefFor, createdAtMs}] 최신순 */
export function mapLedger(v: unknown): LbLedgerEntry[] {
  const root = 'lb_list_ledger';
  return asArr(v, root).map((x, i): LbLedgerEntry => {
    const path = `${root}[${i}]`;
    const o = asObj(x, path);
    const kind = oneOf(o, 'kind', path, LEDGER_KINDS);
    // meta.reason 은 자유 jsonb 라 모르는 값이 올 수 있다 → 오류 대신 null(표시만 기본 문구로)
    const reasonRaw = strOrNull(o, 'reason', path);
    const reason =
      reasonRaw !== null && (LEDGER_REASONS as readonly string[]).includes(reasonRaw) ? (reasonRaw as LbLedgerReason) : null;
    return {
      id: bigintNum(o, 'id', path),
      kind,
      amount: int(o, 'amount', path),
      balanceAfter: int(o, 'balanceAfter', path),
      appointmentId: strOrNull(o, 'appointmentId', path),
      appointmentTitle: strOrNull(o, 'appointmentTitle', path),
      reason,
      reliefFor: kind === 'relief' ? strOrNull(o, 'reliefFor', path) : null,
      createdAtMs: num(o, 'createdAtMs', path),
    };
  });
}

// ───────────────────────── 오류 매핑 ─────────────────────────

/** 이 코드만 message 에서 찾는다. details 는 닉네임 같은 사용자 입력이 실리므로 코드 검색에 쓰지 않는다 */
const LB_CODE_AT_START = /^LB_[A-Z_]+/;

export interface MapErrorOptions {
  /** 우리 타임아웃으로 끊었는가 */
  aborted?: boolean;
}

/**
 * PostgREST·GoTrue·fetch 오류 → LateBetError.
 * - plpgsql `raise exception 'LB_X'` → SQLSTATE P0001, message = 'LB_X'. `using detail = …` 은 details 에 실린다
 *   (lb_edit_appointment 의 LB_INSUFFICIENT_POINTS → details = 모자란 참가자 닉네임). 그 값은 LateBetError.detail 로 옮긴다.
 * - 23514(CHECK) → LB_CHECK_VIOLATION, 22P02·22003(형식·범위) → LB_CHECK_VIOLATION
 * - 40P01·40001 → LB_RETRYABLE (supabaseApi 가 조용히 1회 재시도)
 * - 57014(statement_timeout) → LB_TIMEOUT
 * - PGRST301/302/303·401·GoTrue refresh 토큰 무효 → LB_NOT_SIGNED_IN (세션 만료·무효. supabaseApi 가 refresh 1회 뒤 재시도)
 * - PGRST202(함수 없음 = 마이그레이션 미적용·시그니처 불일치), 익명 로그인 꺼짐, 5xx → LB_NOT_CONFIGURED
 * - 429·rate limit → LB_RATE_LIMITED, 중단(AbortError) → LB_TIMEOUT, status 0·네트워크 실패 → LB_OFFLINE
 */
export function mapRpcError(e: unknown, opts: MapErrorOptions = {}): LateBetError {
  if (e instanceof LateBetError) return e;
  if (opts.aborted) return new LateBetError('LB_TIMEOUT', errText(e));
  const o = (e && typeof e === 'object' ? e : {}) as Obj;
  const message = typeof o.message === 'string' ? o.message : typeof e === 'string' ? e : '';
  const details = typeof o.details === 'string' && o.details !== '' ? o.details : null;
  const code = typeof o.code === 'string' ? o.code : typeof o.code === 'number' ? String(o.code) : '';
  const status = typeof o.status === 'number' ? o.status : null;
  const name = typeof o.name === 'string' ? o.name : '';

  const m = LB_CODE_AT_START.exec(message.trim());
  if (m) {
    const lb = m[0];
    return isLateBetErrorCode(lb) ? new LateBetError(lb, details ?? message) : new LateBetError('LB_UNKNOWN', message);
  }
  const pick = (c: LateBetErrorCode) => new LateBetError(c, message || details || null);
  switch (code) {
    case '23514':
    case '22P02':
    case '22003':
      return pick('LB_CHECK_VIOLATION');
    case '40P01':
    case '40001':
      return pick('LB_RETRYABLE');
    case '57014':
      return pick('LB_TIMEOUT');
    case 'PGRST301':
    case 'PGRST302':
    case 'PGRST303':
    // GoTrue: 세션·refresh 토큰이 무효(재사용 감지·계정/세션 정리) — 이 세션으로는 더 갈 수 없다
    case 'refresh_token_not_found':
    case 'refresh_token_already_used':
    case 'session_not_found':
    case 'session_expired':
    case 'bad_jwt':
    case 'user_not_found':
      return pick('LB_NOT_SIGNED_IN');
    case 'PGRST202':
    case 'anonymous_provider_disabled':
    case 'signup_disabled':
      return pick('LB_NOT_CONFIGURED');
    default:
      break;
  }
  if (status === 429 || /rate.?limit/i.test(code) || /rate limit/i.test(message)) return pick('LB_RATE_LIMITED');
  if (name === 'AbortError' || /^AbortError\b/.test(message)) return pick('LB_TIMEOUT');
  if (
    name === 'AuthRetryableFetchError' ||
    status === 0 ||
    /network request failed|failed to fetch|fetch failed|network ?error|offline/i.test(message)
  ) {
    return pick('LB_OFFLINE');
  }
  if (status === 401 || /jwt expired|invalid jwt|invalid refresh token|refresh token not found/i.test(message)) return pick('LB_NOT_SIGNED_IN');
  if (status !== null && status >= 500) return pick('LB_NOT_CONFIGURED');
  return toLateBetError(e);
}

function errText(e: unknown): string | null {
  if (e && typeof e === 'object' && typeof (e as Obj).message === 'string') return (e as Obj).message as string;
  return typeof e === 'string' ? e : null;
}
