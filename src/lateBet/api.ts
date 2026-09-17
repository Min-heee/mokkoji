/**
 * 약속 내기 — 서버 인터페이스.
 *
 * 화면·훅은 이 인터페이스만 안다. 구현은 둘이다.
 * - fakeApi.ts   메모리 가짜 서버 (모드 fake, 개발 번들 전용)
 * - supabaseApi  RPC 래퍼 16개 + 타임아웃 8초 + 40P01/40001 1회 재시도 — P2 에서 만든다.
 *                그때까지 live/off 모드의 getLateBetApi() 는 모든 호출이 LB_NOT_CONFIGURED 로 실패하는 자리표시자다.
 *
 * 규칙: 모든 메서드는 Promise 이고, 실패는 항상 LateBetError(code) 로 던진다(errors.ts). 낙관적 업데이트는 하지 않는다.
 */
import { LateBetError } from './errors';
import { LATEBET_MODE } from './mode';
import type {
  LbAppointment,
  LbCreateInput,
  LbInvitePreview,
  LbJoinResult,
  LbLedgerEntry,
  LbLive,
  LbMyAppointment,
  LbPing,
  LbProfile,
  LbReportInput,
  LbReportResult,
  LbUpdateInput,
} from './types';

export interface LateBetApi {
  // ── 세션(익명 로그인) ──
  /** 저장된 세션이 있으면 userId, 없으면 null. 새로 로그인하지 않는다(홈 진입 때) */
  restoreSession(): Promise<string | null>;
  /** 세션이 없으면 조용히 익명 로그인. 약속 기능에 처음 들어올 때만 부른다 */
  ensureSignedIn(): Promise<string>;

  // ── RPC 16개 (설계서 §2.3 의 번호) ──
  /** #0 lb_ping */
  ping(): Promise<LbPing>;
  /** #1 lb_ensure_profile — 없으면 생성 + 1,000P, 있으면 닉네임만 갱신 */
  ensureProfile(nickname: string): Promise<LbProfile>;
  /** #2 lb_create_appointment — 주최자 자동 참여 + 에스크로. LB_TZ_SUSPECT 면 시간대 시트 뒤 tzConfirmed=true 로 재시도 */
  createAppointment(input: LbCreateInput): Promise<LbAppointment>;
  /** #3 lb_peek_invite */
  peekInvite(code: string): Promise<LbInvitePreview>;
  /** #4 lb_join — version 은 미리보기에서 본 값. 잠금 전 active(+에스크로) / 잠금 후 pending. 이미 멤버면 그대로(멱등) */
  join(code: string, nickname: string, version: number, consent: boolean): Promise<LbJoinResult>;
  /** #5 lb_approve (주최자) — 대상 포인트가 모자라면 LB_INSUFFICIENT_POINTS */
  approve(appointmentId: string, targetUserId: string): Promise<void>;
  /** #6 lb_leave — pending 은 언제든(요청 취소), active 는 잠금 전까지(환불) */
  leave(appointmentId: string): Promise<void>;
  /** #7 lb_kick (주최자) — active 는 잠금 전까지(환불), pending 은 언제든(거절). ban 기본 true */
  kick(appointmentId: string, targetUserId: string, ban?: boolean): Promise<void>;
  /** #8 lb_set_join_closed (주최자) */
  setJoinClosed(appointmentId: string, closed: boolean): Promise<void>;
  /** #9 lb_update_memo (주최자) — 제목·장소 메모만. 언제든 */
  updateMemo(appointmentId: string, title: string, placeNote: string): Promise<void>;
  /** #10 lb_update_appointment (주최자, 혼자일 때만) — 아니면 LB_EDIT_LOCKED */
  updateAppointment(appointmentId: string, input: LbUpdateInput): Promise<LbAppointment>;
  /** #11 lb_cancel (주최자) — 다른 활성 참가자가 있으면 잠금 전까지, 혼자면 언제든. 전원 환불 */
  cancel(appointmentId: string): Promise<void>;
  /** #12 lb_report_location — 위치 보고 = 도착 판정. 던지지 않고 reason 으로 답한다(멤버가 아니면 LB_NOT_MEMBER) */
  reportLocation(appointmentId: string, input: LbReportInput): Promise<LbReportResult>;
  /** #13 lb_stop_sharing — 내 좌표 즉시 삭제. best-effort 로 부른다 */
  stopSharing(appointmentId: string): Promise<void>;
  /** #14 lb_vouch — GPS 로 도착한 사람만. [같이 있어요] */
  vouch(appointmentId: string, targetUserId: string): Promise<void>;
  /** #15 lb_get_live — 폴링 대상. 조건이 되면 서버가 여기서 정산한다. 멤버가 아니면 LB_NOT_MEMBER */
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
  join: notConfigured,
  approve: notConfigured,
  leave: notConfigured,
  kick: notConfigured,
  setJoinClosed: notConfigured,
  updateMemo: notConfigured,
  updateAppointment: notConfigured,
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

/** 모드에 맞는 구현. fake 구현은 개발 번들에서만 require 된다(릴리스 번들에 가짜 서버가 실리지 않게) */
export function getLateBetApi(): LateBetApi {
  if (cached) return cached;
  if (__DEV__ && LATEBET_MODE === 'fake') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fake = require('./fakeApi') as typeof import('./fakeApi');
    cached = fake.getFakeApi();
  } else {
    cached = placeholderApi;
  }
  return cached;
}
