/**
 * 약속 내기 — live 구현: LateBetApi 를 Supabase RPC(PostgREST)로.
 *
 * supabase-js 를 직접 import 하지 않는다. RPC·세션·select 는 전부 주입(createSupabaseApi(deps)) —
 * 앱은 supabase.native.ts 의 실제 클라이언트를, 테스트·Conformance 는 가짜 rpc 나 로컬 PG 어댑터를 꽂는다.
 *
 * RPC 18개(LateBetApi 의 16개 + 홈 목록 lb_list_my_appointments·원장 lb_list_ledger) + RLS select 1개(getMyProfile).
 *
 * 호출 규칙(설계서 §5.3·§5.5):
 * - 매 호출 전에 requireSession(저장된 세션. 없으면 LB_NOT_SIGNED_IN — 몰래 익명 가입하지 않는다).
 *   익명 가입은 ensureSignedIn(약속 기능 진입)에서만. lb_ping 은 anon 에도 열려 있어 세션을 보지 않는다.
 * - 8초 타임아웃(AbortController → rpc 에 signal 전달 + 자체 경주. 신호를 무시하는 구현이어도 8초에 끊는다) → LB_TIMEOUT.
 *   타임아웃은 재시도하지 않는다(쓰기 RPC 가 서버에서 이미 커밋됐을 수 있다). 생성은 멱등 키(p_request_id)로 다시 눌러도 안전하고,
 *   참여(claim)는 이미 멤버면 멱등, 수정은 version 으로 걸러진다.
 * - 40P01(교착)·40001(직렬화) → 조용히 1회 재시도. 그 트랜잭션은 서버에서 롤백됐으므로 안전하다.
 * - 서버가 JWT 를 거부(PGRST301/303·401 → LB_NOT_SIGNED_IN)하면 refreshSession 1회 → 같은 호출 1회 재시도.
 *   거부된 요청은 실행되지 않았으므로 안전하다. auth-js 는 만료를 기기 시계로만 판단해, 기기 시계가 늦으면 스스로 갱신하지 않는다.
 * - 응답에 serverNowMs 가 있는 호출(ping·peekInvite·reportLocation·getLive)은 rpc 왕복만으로 서버 시계를 잰다.
 *   시계를 재는 곳은 여기 하나다 — 화면은 withClockSample 로 또 감싸지 않는다.
 * - 응답은 rpcMap 이 검증·변환한다(모양이 다르면 LB_BAD_RESPONSE). 오류는 전부 LateBetError.
 */
import type { LateBetApi } from './api';
import { LateBetError } from './errors';
import {
  mapAppointment,
  mapInvitePreview,
  mapJoinResult,
  mapLedger,
  mapLive,
  mapMaybeProfileRow,
  mapMyAppointments,
  mapPing,
  mapProfileRow,
  mapReportResult,
  mapRpcError,
  mapVoid,
} from './rpcMap';
import type { ServerClock } from './serverClock';
import type { LbCreateInput, LbEditPatch, LatePolicy } from './types';

/** supabase-js 의 { data, error } 와 같은 모양. error 는 PostgrestError·AuthError·아무 값 */
export interface LbWireResult {
  data: unknown;
  error: unknown;
}

/** supabase.rpc(fn, args).abortSignal(signal) 와 같은 일 */
export type LbRpc = (fn: string, args: Record<string, unknown>, signal: AbortSignal) => PromiseLike<LbWireResult>;

/**
 * RLS select(live: supabase.from(...).select(...)). 행은 snake_case 원본 그대로 돌려준다(변환은 rpcMap).
 * 홈 목록·원장은 RPC(lb_list_my_appointments·lb_list_ledger)라 여기 없다. 프로필만 — 프로필 조회 RPC 가 없고,
 * lb_ensure_profile 은 닉네임을 바꾸는 쓰기라 '있는지 보기'에 쓸 수 없다.
 */
export interface LbTableQueries {
  /** profiles select user_id,nickname,balance — maybeSingle(없으면 data null). RLS 가 내 행만 보여 준다 */
  profile(signal: AbortSignal): PromiseLike<LbWireResult>;
}

/** 실제 백엔드(supabase.native.ts)나 테스트 어댑터가 채우는 것 */
export interface LbLiveBackend {
  rpc: LbRpc;
  /** 세션이 없으면 익명 로그인(ensureSignedIn 전용). userId 를 돌려준다. 실패는 LateBetError(LB_RATE_LIMITED·LB_OFFLINE·LB_TIMEOUT …) */
  ensureSession(): Promise<string>;
  /** 일반 RPC 앞: 저장된 세션의 userId. 없거나 무효면 LB_NOT_SIGNED_IN. 새로 로그인하지 않는다 */
  requireSession(): Promise<string>;
  /** 저장된 세션의 userId. 없으면 null. 새로 로그인하지 않는다 */
  restoreSession(): Promise<string | null>;
  /**
   * 서버가 토큰을 거부했을 때 한 번: 같은 계정의 토큰을 새로 받는다. refresh 토큰이 무효면 로컬 세션을 지우고 LB_NOT_SIGNED_IN.
   * 없으면 재시도하지 않는다
   */
  refreshSession?(): Promise<string>;
  /** 없으면 getMyProfile 은 LB_NOT_CONFIGURED */
  query?: LbTableQueries;
}

export interface SupabaseApiDeps extends LbLiveBackend {
  /** 기기 시각(RTT 측정). 기본 Date.now */
  now?: () => number;
  /** serverNowMs 샘플을 넣을 시계. null 이면 재지 않는다 */
  clock?: ServerClock | null;
  /** 기본 8000 */
  timeoutMs?: number;
}

export const RPC_TIMEOUT_MS = 8000;
export const DEFAULT_LEDGER_LIMIT = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** p_appt·p_target 은 uuid. 형식이 아니면 서버에 보내지 않고 LB_NOT_FOUND(딥링크 오타 등. 서버는 22P02 를 냈을 것) */
function uuidArg(v: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new LateBetError('LB_NOT_FOUND', `uuid 아님: ${String(v)}`);
  return v;
}

/** 정책은 5개 키만 보낸다(엔진 전용 필드가 섞여도 서버로 새지 않게) */
function policyArg(p: LatePolicy): Record<string, number> {
  return {
    stake: p.stake,
    radiusM: p.radiusM,
    unitMinutes: p.unitMinutes,
    penaltyPerUnit: p.penaltyPerUnit,
    graceMinutes: p.graceMinutes,
  };
}

/** lb_edit_appointment 의 p_patch: 바꿀 키만(undefined 는 뺀다 — 서버는 없는 키를 '그대로'로 읽는다) */
export function editPatchArg(patch: LbEditPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.localAt !== undefined) out.localAt = patch.localAt;
  if (patch.tz !== undefined) out.tz = patch.tz;
  if (patch.placeName !== undefined) out.placeName = patch.placeName;
  if (patch.lat !== undefined) out.lat = patch.lat;
  if (patch.lng !== undefined) out.lng = patch.lng;
  if (patch.policy !== undefined) out.policy = policyArg(patch.policy);
  if (patch.tzConfirmed !== undefined) out.tzConfirmed = patch.tzConfirmed;
  return out;
}

export function createArgs(input: LbCreateInput): Record<string, unknown> {
  return {
    p_title: input.title,
    p_local_at: input.localAt,
    p_tz: input.tz,
    p_place_name: input.placeName,
    p_place_note: input.placeNote,
    p_lat: input.lat,
    p_lng: input.lng,
    p_policy: policyArg(input.policy),
    p_invitees: [...input.invitees],
    p_consent: input.consent,
    p_tz_confirmed: input.tzConfirmed === true,
    // 멱등 키: uuid 형식일 때만(형식이 아니면 22P02 로 생성 자체가 실패하므로 키 없이 보낸다)
    p_request_id: typeof input.requestId === 'string' && UUID_RE.test(input.requestId) ? input.requestId : null,
  };
}

interface CallOptions {
  /** 세션 없이 부른다(lb_ping) */
  noSession?: boolean;
  /** 응답의 serverNowMs 로 시계를 잰다 */
  sample?: boolean;
}

export function createSupabaseApi(deps: SupabaseApiDeps): LateBetApi {
  const now = deps.now ?? Date.now;
  const clock = deps.clock ?? null;
  const timeoutMs = deps.timeoutMs ?? RPC_TIMEOUT_MS;

  async function signIn(): Promise<string> {
    try {
      return await deps.ensureSession();
    } catch (e) {
      throw mapRpcError(e);
    }
  }

  async function session(): Promise<string> {
    try {
      return await deps.requireSession();
    } catch (e) {
      throw mapRpcError(e);
    }
  }

  async function refreshSession(): Promise<void> {
    try {
      await deps.refreshSession?.();
    } catch (e) {
      throw mapRpcError(e);
    }
  }

  /** 한 번의 왕복: 타임아웃·오류 매핑. 성공이면 data */
  async function once(send: (signal: AbortSignal) => PromiseLike<LbWireResult>): Promise<unknown> {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        ac.abort();
        resolve('timeout');
      }, timeoutMs);
    });
    let res: LbWireResult | 'timeout';
    try {
      res = await Promise.race([Promise.resolve(send(ac.signal)), timeout]);
    } catch (e) {
      throw mapRpcError(e, { aborted: ac.signal.aborted });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (res === 'timeout' || ac.signal.aborted) throw new LateBetError('LB_TIMEOUT', `${timeoutMs}ms`);
    if (!res || typeof res !== 'object') throw new LateBetError('LB_BAD_RESPONSE', 'wire result 없음');
    if (res.error !== null && res.error !== undefined) throw mapRpcError(res.error);
    return res.data;
  }

  /** 세션 → (교착·직렬화면 1회 재시도, 토큰 거부면 refresh 뒤 1회 재시도) → 매핑 → 시계 샘플 */
  async function run<T>(
    send: (signal: AbortSignal) => PromiseLike<LbWireResult>,
    map: (data: unknown) => T,
    opts: CallOptions = {},
  ): Promise<T> {
    if (!opts.noSession) await session();
    let retried = false;
    let refreshed = false;
    for (;;) {
      const t0 = now();
      let data: unknown;
      try {
        data = await once(send);
      } catch (e) {
        const err = e instanceof LateBetError ? e : mapRpcError(e);
        if (err.code === 'LB_RETRYABLE' && !retried) {
          retried = true;
          continue;
        }
        if (err.code === 'LB_NOT_SIGNED_IN' && !opts.noSession && !refreshed && deps.refreshSession) {
          refreshed = true;
          await refreshSession(); // 실패하면 그 오류(LB_NOT_SIGNED_IN·LB_OFFLINE …)를 낸다
          continue;
        }
        throw err;
      }
      const t1 = now();
      const value = map(data);
      if (opts.sample && clock) {
        const s = (value as { serverNowMs?: unknown }).serverNowMs;
        if (typeof s === 'number') clock.addSample(s, t0, t1);
      }
      return value;
    }
  }

  const rpc = <T>(fn: string, args: Record<string, unknown>, map: (d: unknown) => T, opts?: CallOptions) =>
    run((signal) => deps.rpc(fn, args, signal), map, opts);

  function requireQuery(): LbTableQueries {
    if (!deps.query) throw new LateBetError('LB_NOT_CONFIGURED', 'query 어댑터 없음');
    return deps.query;
  }

  return {
    // ── 세션 ──
    async restoreSession() {
      try {
        return await deps.restoreSession();
      } catch (e) {
        throw mapRpcError(e);
      }
    },
    ensureSignedIn: () => signIn(),

    // ── RPC 16개 ──
    ping: () => rpc('lb_ping', {}, mapPing, { noSession: true, sample: true }),
    ensureProfile: (nickname) => rpc('lb_ensure_profile', { p_nickname: nickname }, (d) => mapProfileRow(d, 'lb_ensure_profile')),
    createAppointment: (input) => rpc('lb_create_appointment', createArgs(input), (d) => mapAppointment(d, 'lb_create_appointment')),
    peekInvite: (code) => rpc('lb_peek_invite', { p_code: code }, mapInvitePreview, { sample: true }),
    claimSlot: async (appointmentId, name, version, consent) =>
      rpc(
        'lb_claim_slot',
        { p_appt: uuidArg(appointmentId), p_name: name, p_version: version, p_consent: consent },
        mapJoinResult,
      ),
    start: async (appointmentId) =>
      rpc('lb_start', { p_appt: uuidArg(appointmentId) }, (d) => mapAppointment(d, 'lb_start')),
    editInvitees: async (appointmentId, patch) =>
      rpc(
        'lb_edit_invitees',
        { p_appt: uuidArg(appointmentId), p_add: [...(patch.add ?? [])], p_remove: [...(patch.remove ?? [])] },
        (d) => mapAppointment(d, 'lb_edit_invitees'),
      ),
    leave: async (appointmentId) => rpc('lb_leave', { p_appt: uuidArg(appointmentId) }, mapVoid),
    kick: async (appointmentId, targetUserId, ban = true) =>
      rpc('lb_kick', { p_appt: uuidArg(appointmentId), p_target: uuidArg(targetUserId), p_ban: ban }, mapVoid),
    updateMemo: async (appointmentId, title, placeNote) =>
      rpc('lb_update_memo', { p_appt: uuidArg(appointmentId), p_title: title, p_place_note: placeNote }, mapVoid),
    edit: async (appointmentId, patch, version) =>
      rpc(
        'lb_edit_appointment',
        { p_appt: uuidArg(appointmentId), p_patch: editPatchArg(patch), p_version: version },
        (d) => mapAppointment(d, 'lb_edit_appointment'),
      ),
    cancel: async (appointmentId) => rpc('lb_cancel', { p_appt: uuidArg(appointmentId) }, mapVoid),
    reportLocation: async (appointmentId, input) =>
      rpc(
        'lb_report_location',
        {
          p_appt: uuidArg(appointmentId),
          p_lat: input.lat,
          p_lng: input.lng,
          p_accuracy_m: input.accuracyM,
          p_mocked: input.mocked === true,
          p_share: input.share !== false,
        },
        mapReportResult,
        { sample: true },
      ),
    stopSharing: async (appointmentId) => rpc('lb_stop_sharing', { p_appt: uuidArg(appointmentId) }, mapVoid),
    vouch: async (appointmentId, targetUserId) =>
      rpc('lb_vouch', { p_appt: uuidArg(appointmentId), p_target: uuidArg(targetUserId) }, mapVoid),
    getLive: async (appointmentId) => rpc('lb_get_live', { p_appt: uuidArg(appointmentId) }, mapLive, { sample: true }),

    // ── 조회 ──
    getMyProfile: async () => {
      const q = requireQuery();
      return run((signal) => q.profile(signal), mapMaybeProfileRow);
    },
    // 15.5: 약속 시각이 지난 열린 약속은 서버가 여기서 게으른 참여 마감·정산까지 한다
    listMyAppointments: () => rpc('lb_list_my_appointments', {}, mapMyAppointments),
    // 15.6: 서버도 1~500 으로 자르지만, 정수가 아닌 값(22P02)이 나가지 않게 여기서도 맞춘다
    listLedger: (limit = DEFAULT_LEDGER_LIMIT) =>
      rpc(
        'lb_list_ledger',
        { p_limit: Math.max(1, Math.min(500, Math.floor(Number.isFinite(limit) ? limit : DEFAULT_LEDGER_LIMIT))) },
        mapLedger,
      ),
  };
}
