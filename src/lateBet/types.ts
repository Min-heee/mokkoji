/**
 * 약속 내기 — 서버 DTO (설계서 §2.3 RPC 16개의 입출력을 그대로 본뜬 타입).
 *
 * - 서버(plpgsql)가 jsonb 로 돌려주는 camelCase 키와 같은 이름을 쓴다. 테이블 행을 돌려주는 RPC
 *   (lb_ensure_profile, lb_create_appointment, lb_update_appointment)는 api 구현이 camelCase 로 옮긴다.
 * - 시각은 전부 epoch ms(서버 기준). 기기 시계는 표시에만 쓴다(serverClock.ts).
 * - LbLive 는 src/domain/latePhase.ts 의 LatePhaseInput, toSession.ts 의 ToSessionLive 를 구조적으로 만족한다.
 * - 이 파일은 React/RN 을 import 하지 않는다(fakeApi 테스트가 node 에서 돈다).
 */
import type { LatePolicy } from '../domain/lateBet';
import type { LateAppointmentStatus, LateMemberState } from '../domain/latePhase';

export type { LatePolicy, LateAppointmentStatus, LateMemberState };

/** 정산 무효 사유 (lb_settle_preview.voidReason) */
export type LbVoidReason = 'noStake' | 'noWinner' | 'invalidDeadline';
export type LbArrivalMethod = 'gps' | 'vouch';
export type LbResultStatus = 'onTime' | 'late' | 'noShow';
export type LbLedgerKind = 'grant' | 'relief' | 'hold' | 'refund' | 'payout';
/** 원장 meta.reason */
export type LbLedgerReason = 'signup' | 'topup' | 'leave' | 'canceled' | 'kicked' | 'policy_change';

/** #0 lb_ping */
export interface LbPing {
  serverNowMs: number;
  /** 이 값이 현재 빌드 번호보다 크면 "새 버전을 설치해 주세요" */
  minBuild: number;
  iosUrl: string;
  androidUrl: string;
}

/** #1 lb_ensure_profile (profiles 행) */
export interface LbProfile {
  userId: string;
  nickname: string;
  /** 보유 포인트(원장의 캐시). 걸어 둔 포인트는 빠져 있다 */
  balance: number;
}

/** 약속 본문. lb_get_live.appointment / lb_create_appointment / lb_update_appointment 공통 */
export interface LbAppointment {
  id: string;
  /** 활성 멤버에게만 내려온다(승인 대기자에게는 null) */
  inviteCode: string | null;
  hostId: string;
  title: string;
  /** 서버가 다시 쓴 벽시계 'YYYY-MM-DDTHH:mm' (tz 기준) */
  localAt: string;
  /** IANA 시간대 */
  tz: string;
  /** 약속 시각 = 마감 = 참여·승인 마감 */
  meetAtMs: number;
  /** 위치 공개 시작 = 체크인 개시 = 잠금 */
  shareStartMs: number;
  /** 체크인·위치 공개 종료. 이 시각을 넘겨 도착하면 전액을 잃는다 */
  closeMs: number;
  placeName: string;
  placeNote: string;
  placeLat: number;
  placeLng: number;
  status: LateAppointmentStatus;
  voidReason: LbVoidReason | null;
  /** 제목·메모 외의 값이 바뀌면 +1. 미리보기에서 본 값을 lb_join 에 그대로 넘긴다 */
  version: number;
  joinClosed: boolean;
  policy: LatePolicy;
}

/** #2 lb_create_appointment 입력 */
export interface LbCreateInput {
  title: string;
  /** 'YYYY-MM-DDTHH:mm' */
  localAt: string;
  tz: string;
  placeName: string;
  placeNote: string;
  lat: number;
  lng: number;
  policy: LatePolicy;
  /** 위치 제공 동의 + 만 14세 이상. false 면 LB_CONSENT_REQUIRED */
  consent: boolean;
  /** LB_TZ_SUSPECT 를 받은 뒤 시간대 시트에서 고르고 다시 보낼 때 true */
  tzConfirmed?: boolean;
}

/** #10 lb_update_appointment 입력 (주최자 혼자일 때만) */
export interface LbUpdateInput {
  localAt: string;
  tz: string;
  placeName: string;
  lat: number;
  lng: number;
  policy: LatePolicy;
  tzConfirmed?: boolean;
}

/** #3 lb_peek_invite */
export interface LbInvitePreview {
  id: string;
  title: string;
  localAt: string;
  tz: string;
  meetAtMs: number;
  shareStartMs: number;
  closeMs: number;
  placeName: string;
  placeNote: string;
  placeLat: number;
  placeLng: number;
  status: LateAppointmentStatus;
  version: number;
  joinClosed: boolean;
  /** 잠금 뒤인가. true 면 버튼이 [참여 요청 보내기] */
  needsApproval: boolean;
  serverNowMs: number;
  policy: LatePolicy;
  /** 활성 참가자 수 */
  memberCount: number;
  /** 내가 활성 멤버일 때만 채워진다. 아니면 [] */
  nicknames: string[];
  /** 이미 멤버면 그 상태, 아니면 null */
  myState: LateMemberState | null;
  /** 프로필이 아직 없으면 null */
  myBalance: number | null;
}

/** #4 lb_join */
export interface LbJoinResult {
  appointmentId: string;
  state: LateMemberState;
}

/** #12 lb_report_location 입력 */
export interface LbReportInput {
  lat: number;
  lng: number;
  /** 수평 오차(m). 모르면 null (엔진과 같이 정확도 검사를 건너뛴다) */
  accuracyM: number | null;
  /** 안드로이드 모의 위치 */
  mocked?: boolean;
  /** false 면 판정만 받고 좌표는 저장하지 않는다([위치 공유 끄기] 상태의 [도착 확인]) */
  share?: boolean;
}

/**
 * 체크인 결과 코드 (설계서 §2.3 판정표). arrived=true 면 reason 은 null.
 * closed·pending·already_arrived·not_open·bad_position 은 좌표를 보지 않고 끝난 경우라 distanceM 이 없다.
 */
export type LbReportReason =
  | 'closed'
  | 'pending'
  | 'already_arrived'
  | 'not_open'
  | 'bad_position'
  | 'mocked'
  | 'low_accuracy'
  | 'outside';

/** #12 lb_report_location 결과 */
export interface LbReportResult {
  arrived: boolean;
  reason: LbReportReason | null;
  /** 도착이 찍혀 있으면 그 시각(already_arrived 포함) */
  arrivedAtMs: number | null;
  /** 목적지까지 거리(m, 반올림). 좌표를 보지 않은 경우 null */
  distanceM: number | null;
  serverNowMs: number;
}

/** lb_get_live.participants[].location — 조건이 맞을 때만(공개 창 ∧ 보는 사람 활성 ∧ 미도착 ∧ 3분 안) */
export interface LbLiveLocation {
  lat: number;
  lng: number;
  accuracyM: number | null;
  updatedAtMs: number;
  /** 목적지까지 거리(m, 반올림) — 서버가 계산 */
  distanceM: number;
}

/** lb_get_live.participants[] */
export interface LbLiveParticipant {
  userId: string;
  nickname: string;
  state: LateMemberState;
  joinedAtMs: number;
  arrivedAtMs: number | null;
  arrivalMethod: LbArrivalMethod | null;
  arrivalDistanceM: number | null;
  arrivalAccuracyM: number | null;
  vouchedBy: string | null;
  /** 정산 뒤에만 */
  resultStatus: LbResultStatus | null;
  forfeited: number | null;
  received: number | null;
  /** 좌표가 서버에 남아 있으면 마지막 갱신 시각(3분이 지나 location 은 null 이어도). "4분 전까지 공유" */
  lastSeenMs: number | null;
  location: LbLiveLocation | null;
}

/** #15 lb_get_live */
export interface LbLive {
  serverNowMs: number;
  myUserId: string;
  myState: LateMemberState;
  myBalance: number;
  /** open ∧ now > close_at. '결과를 확정하는 중이에요' */
  settlePending: boolean;
  appointment: LbAppointment;
  /** (joinedAt, userId) 순. 승인 대기자에게는 자기 행만 */
  participants: LbLiveParticipant[];
}

/** 홈 '약속' 섹션의 한 줄 (live 모드: RLS select appointments + participants) */
export interface LbMyAppointment {
  id: string;
  title: string;
  localAt: string;
  tz: string;
  meetAtMs: number;
  shareStartMs: number;
  closeMs: number;
  placeName: string;
  status: LateAppointmentStatus;
  policy: LatePolicy;
  hostId: string;
  isHost: boolean;
  myState: LateMemberState;
  /** 활성 참가자 수. 승인 대기 중이면 알 수 없어 0 */
  memberCount: number;
  /** 주최자에게만: 수락을 기다리는 요청 수 */
  pendingCount: number;
}

/** 포인트 원장 한 줄 (live 모드: RLS select ledger, 최신순) */
export interface LbLedgerEntry {
  id: number;
  kind: LbLedgerKind;
  /** 부호 있는 포인트. hold 는 음수 */
  amount: number;
  balanceAfter: number;
  appointmentId: string | null;
  /** 약속 제목(없으면 null — grant·relief, 또는 더는 볼 수 없는 약속) */
  appointmentTitle: string | null;
  reason: LbLedgerReason | null;
  /** relief(topup) 일 때: 어느 약속에 참여하느라 채워 줬는가 (meta.for). "포인트가 모자라 20P를 채워 드렸어요" 토스트용 */
  reliefFor: string | null;
  createdAtMs: number;
}
