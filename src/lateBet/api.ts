/**
 * 약속 내기 — 서버 인터페이스.
 *
 * 화면·훅은 이 인터페이스만 안다. 구현은 둘이다.
 * - fakeApi.ts   메모리 가짜 서버 (모드 fake: 개발 번들, 또는 beta 채널 네이티브 빌드)
 * - supabaseApi  RPC 래퍼 + 타임아웃 8초 + 40P01/40001 1회 재시도 — P2 에서 만든다.
 *                그때까지 live/off 모드의 getLateBetApi() 는 모든 호출이 LB_NOT_CONFIGURED 로 실패하는 자리표시자다.
 *
 * 규칙: 모든 메서드는 Promise 이고, 실패는 항상 LateBetError(code) 로 던진다(errors.ts). 낙관적 업데이트는 하지 않는다.
 */
import { LateBetError } from './errors';
import { LATEBET_MODE } from './mode';
import type {
  LbAppointment,
  LbCreateInput,
  LbEditPatch,
  LbInvitePreview,
  LbInviteesPatch,
  LbJoinResult,
  LbLedgerEntry,
  LbLive,
  LbMyAppointment,
  LbPing,
  LbProfile,
  LbReportInput,
  LbReportResult,
} from './types';

/**
 * 오너 확정 흐름(2026-09-18) 뒤의 RPC 표. 수락제(approve·참여 요청·참여 마감)는 없다.
 * 참여 = 초대 명단에서 자기 이름을 고르는 것(claimSlot). 시작 = 주최자의 [시작하기](start) — 그 순간부터 위치 공개·체크인.
 * '전원 참여 시 자동 잠금'은 없다. 시작 전/후 규칙은 각 메서드 주석에.
 */
export interface LateBetApi {
  // ── 세션(익명 로그인) ──
  /** 저장된 세션이 있으면 userId, 없으면 null. 새로 로그인하지 않는다(홈 진입 때) */
  restoreSession(): Promise<string | null>;
  /** 세션이 없으면 조용히 익명 로그인. 약속 기능에 처음 들어올 때만 부른다 */
  ensureSignedIn(): Promise<string>;

  // ── RPC (설계서 §2.3 의 번호. 5·8 은 폐지, 4·10 은 교체, 16·17 은 신설) ──
  /** #0 lb_ping */
  ping(): Promise<LbPing>;
  /** #1 lb_ensure_profile — 없으면 생성 + 1,000P, 있으면 닉네임만 갱신 */
  ensureProfile(nickname: string): Promise<LbProfile>;
  /**
   * #2 lb_create_appointment — 초대 명단(input.invitees)과 함께 만든다. 주최자 자동 참여 + 에스크로.
   * LB_TZ_SUSPECT 면 시간대 시트 뒤 tzConfirmed=true 로 재시도
   */
  createAppointment(input: LbCreateInput): Promise<LbAppointment>;
  /** #3 lb_peek_invite — 명단(누가 골랐는지 포함)·조건·version. 차단된 계정에는 LB_INVITE_NOT_FOUND */
  peekInvite(code: string): Promise<LbInvitePreview>;
  /**
   * #4 lb_claim_slot — 명단에서 내 이름을 골라 참여(+에스크로). version 은 미리보기에서 본 값.
   * 이미 멤버면 그대로(멱등). 명단에 없으면 LB_NOT_INVITED, 남이 이미 골랐으면 LB_SLOT_TAKEN,
   * 약속 시각이 지났거나 닫혔으면 LB_JOIN_CLOSED. 주최자가 이미 시작한 뒤에도 약속 시각까지는 들어올 수 있다
   * (result.started = true → 바로 live 화면, 그때부터 위치 공개·판정 대상)
   */
  claimSlot(appointmentId: string, name: string, version: number, consent: boolean): Promise<LbJoinResult>;
  /**
   * #17 lb_start (주최자) — [시작하기]. 그 순간부터 전원 위치가 서로 보이고 체크인이 열린다. 되돌릴 수 없다.
   * 약속 시각 전이면 언제든(참여 인원 조건 없음 — 혼자면 화면이 confirmDialog 로 한 번 묻는다).
   * 약속 시각이 지났거나 닫혔으면 LB_START_CLOSED, 이미 시작했으면 LB_ALREADY_STARTED
   */
  start(appointmentId: string): Promise<LbAppointment>;
  /** #16 lb_edit_invitees (주최자, 시작 전) — 이름 추가·아직 안 들어온 이름 삭제. 들어온 이름 삭제는 LB_INVITEE_JOINED. 시작 후 LB_EDIT_FROZEN */
  editInvitees(appointmentId: string, patch: LbInviteesPatch): Promise<LbAppointment>;
  /** #6 lb_leave — 시작 전까지(전액 환불, 이름은 명단에 빈 칸으로 남는다). 주최자는 불가. 시작 후 LB_LEAVE_CLOSED */
  leave(appointmentId: string): Promise<void>;
  /** #7 lb_kick (주최자) — 시작 전까지(전액 환불 + 명단에서도 제거). ban 기본 true. 시작 후 LB_KICK_CLOSED */
  kick(appointmentId: string, targetUserId: string, ban?: boolean): Promise<void>;
  /** #9 lb_update_memo (주최자) — 제목·장소 메모만. 열려 있는 동안 언제든. version 안 올림 */
  updateMemo(appointmentId: string, title: string, placeNote: string): Promise<void>;
  /**
   * #10 lb_edit_appointment (주최자) — 부분 갱신. version 은 마지막으로 본 값(어긋나면 LB_APPT_CHANGED).
   * - 시작 전: 시간·장소·정책 전부. 걸 포인트 차액은 전원 자동 추가 에스크로/환불. version+1
   * - 시작 후: 시간 뒤로 미루기(최대 +3시간)·장소만. 그 외가 바뀌면 LB_EDIT_FROZEN, 앞당기면 LB_POSTPONE_ONLY,
   *   3시간 넘게 미루면 LB_POSTPONE_TOO_FAR. 마감·정산 시각은 새 시각 기준으로 재계산(시작 시각은 그대로)
   * - 마감(closeMs)이 지났거나 닫혔으면 LB_EDIT_CLOSED
   */
  edit(appointmentId: string, patch: LbEditPatch, version: number): Promise<LbAppointment>;
  /** #11 lb_cancel (주최자) — 시작 전까지(혼자면 언제든). 전원 환불. 시작 후 LB_CANCEL_CLOSED */
  cancel(appointmentId: string): Promise<void>;
  /** #12 lb_report_location — 위치 보고 = 도착 판정. 시작 시각부터 마감까지(시작 전 not_open). 던지지 않고 reason 으로 답한다(멤버가 아니면 LB_NOT_MEMBER) */
  reportLocation(appointmentId: string, input: LbReportInput): Promise<LbReportResult>;
  /** #13 lb_stop_sharing — 내 좌표 즉시 삭제. best-effort 로 부른다 */
  stopSharing(appointmentId: string): Promise<void>;
  /** #14 lb_vouch — GPS 로 도착한 사람만. [같이 있어요]. 시작 전 LB_NOT_STARTED, 마감 뒤 LB_CLOSED */
  vouch(appointmentId: string, targetUserId: string): Promise<void>;
  /**
   * #15 lb_get_live — 폴링 대상. 조건이 되면 서버가 여기서 정산한다(약속 시각까지 시작 안 됨 → notStarted 무효 포함).
   * 남의 위치는 시작됨 ∧ 마감 전 ∧ 미도착 ∧ 3분 안일 때만. 멤버가 아니면 LB_NOT_MEMBER
   */
  getLive(appointmentId: string): Promise<LbLive>;

  // ── 조회(live 모드에서는 RLS select) ──
  /** 프로필이 아직 없으면 null (닉네임을 받아 ensureProfile 을 불러야 한다) */
  getMyProfile(): Promise<LbProfile | null>;
  /** 홈 '약속' 섹션. 열린 약속(가까운 순) → 끝난 약속(최근 순) */
  listMyAppointments(): Promise<LbMyAppointment[]>;
  /** 포인트 원장, 최신순 */
  listLedger(limit?: number): Promise<LbLedgerEntry[]>;
}

const notConfigured = (): Promise<never> => Promise.reject(new LateBetError('LB_NOT_CONFIGURED'));

/** live 구현(P2)이 들어오기 전까지의 자리표시자. 저장된 세션도 없다고 답한다 */
const placeholderApi: LateBetApi = {
  restoreSession: () => Promise.resolve(null),
  ensureSignedIn: notConfigured,
  ping: notConfigured,
  ensureProfile: notConfigured,
  createAppointment: notConfigured,
  peekInvite: notConfigured,
  claimSlot: notConfigured,
  start: notConfigured,
  editInvitees: notConfigured,
  leave: notConfigured,
  kick: notConfigured,
  updateMemo: notConfigured,
  edit: notConfigured,
  cancel: notConfigured,
  reportLocation: notConfigured,
  stopSharing: notConfigured,
  vouch: notConfigured,
  getLive: notConfigured,
  getMyProfile: notConfigured,
  listMyAppointments: notConfigured,
  listLedger: notConfigured,
};

let cached: LateBetApi | null = null;

/**
 * 모드에 맞는 구현. fake 구현은 번들 env 가 fake 일 때만 require 된다(개발 번들, 또는 beta 채널 네이티브 빌드).
 * 웹 릴리스(앱인토스)는 modeRule 상 fake 가 될 수 없으므로 개발 번들에서만 싣는다.
 * __DEV__·EXPO_OS·env 비교는 이 자리에 정적으로 적어야 번들 시점에 치환돼, 해당 없는 번들(production·웹 릴리스)에서
 * require 가 통째로 빠진다. 실제로 켜지는지는 LATEBET_MODE(modeRule: 채널 'beta' 정확히 일치) 가 한 번 더 막는다.
 * FakeDevPanel.tsx 의 fakeModule 조건과 같은 식이어야 한다.
 */
export function getLateBetApi(): LateBetApi {
  if (cached) return cached;
  if (
    (__DEV__ || process.env.EXPO_OS !== 'web') &&
    process.env.EXPO_PUBLIC_LATEBET_MODE === 'fake' &&
    LATEBET_MODE === 'fake'
  ) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fake = require('./fakeApi') as typeof import('./fakeApi');
    cached = fake.getFakeApi();
  } else {
    cached = placeholderApi;
  }
  return cached;
}
