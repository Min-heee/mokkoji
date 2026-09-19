/**
 * 약속 내기 — 서버 DTO (설계서 §2.3 RPC 의 입출력을 그대로 본뜬 타입).
 *
 * 오너 확정 흐름(2026-09-18, 설계서 §0-1) 반영본:
 * - 수락제 폐지 → '초대 명단(invitees)' 방식. pending 상태·승인·참여 요청·참여 마감(joinClosed)이 전부 없다.
 * - 시작 = 주최자가 [시작하기]를 누른 서버 시각(startedAtMs). 그 순간부터 전원 위치가 서로 보이고 체크인이 열린다.
 *   '전원 참여 시 자동 잠금'(rosterCompleteAt·lockedAt)과 '위치 공개 시점(N분 전)' 설정은 없다.
 * - 시작 전에는 주최자가 조건 전부를 바꿀 수 있다(version+1, changes 에 전후가 남는다).
 *   시작 후에는 시간 미루기(최대 +3시간)·장소 변경만. 아직 안 들어온 이름은 시작 뒤에도 약속 시각까지 들어올 수 있다.
 * - 약속 시각까지 시작하지 않은 약속은 무효(voidReason 'notStarted', 전원 환불).
 *
 * - 서버(plpgsql)가 jsonb 로 돌려주는 camelCase 키와 같은 이름을 쓴다.
 * - 시각은 전부 epoch ms(서버 기준). 기기 시계는 표시에만 쓴다(serverClock.ts).
 * - LbLive 는 src/domain/latePhase.ts 의 LatePhaseInput, toSession.ts 의 ToSessionLive 를 구조적으로 만족한다.
 * - 이 파일은 React/RN 을 import 하지 않는다(fakeApi 테스트가 node 에서 돈다).
 */
import type { LatePolicy } from '../domain/lateBet';
import type { LateAppointmentStatus, LateMemberState } from '../domain/latePhase';

export type { LatePolicy, LateAppointmentStatus, LateMemberState };

/** 정산 무효 사유 (lb_settle_preview.voidReason). notStarted = 약속 시각까지 주최자가 시작하지 않아 전원 환불 */
export type LbVoidReason = 'noStake' | 'noWinner' | 'invalidDeadline' | 'notStarted';
export type LbArrivalMethod = 'gps' | 'vouch';
export type LbResultStatus = 'onTime' | 'late' | 'noShow';
export type LbLedgerKind = 'grant' | 'relief' | 'hold' | 'refund' | 'payout';
/** 원장 meta.reason. policy_change 는 시작 전 조건 변경의 차액(추가 hold·refund), notStarted 는 시작 안 된 약속의 무효 환불 */
export type LbLedgerReason = 'signup' | 'topup' | 'leave' | 'canceled' | 'kicked' | 'policy_change' | 'notStarted';

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

/**
 * 초대 명단 한 칸. 주최자가 적은 이름(= 그 사람의 이 약속 닉네임) + 누가 골랐는가.
 * 주최자 본인은 명단에 없다(자동 참가). claimedByUserId 가 있으면 그 사람은 participants 에도 있다.
 */
export interface LbInvitee {
  name: string;
  claimedByUserId: string | null;
  claimedAtMs: number | null;
}

/** 조건 변경 1건의 전후 스냅샷(변경 배너용). version 이 오를 때마다 1건 */
export interface LbAppointmentSnapshot {
  localAt: string;
  tz: string;
  meetAtMs: number;
  placeName: string;
  placeLat: number;
  placeLng: number;
  policy: LatePolicy;
}
export interface LbAppointmentChange {
  /** 이 변경으로 된 version */
  version: number;
  atMs: number;
  before: LbAppointmentSnapshot;
  after: LbAppointmentSnapshot;
}

/** 약속 본문. lb_get_live.appointment / lb_create_appointment / lb_edit_appointment 공통 */
export interface LbAppointment {
  id: string;
  inviteCode: string;
  hostId: string;
  hostNickname: string;
  title: string;
  /** 서버가 다시 쓴 벽시계 'YYYY-MM-DDTHH:mm' (tz 기준) */
  localAt: string;
  /** IANA 시간대 */
  tz: string;
  /** 약속 시각 = 마감 = 참여 마감 = 시작 마감(이 시각까지 시작하지 않으면 무효, 안 들어온 이름은 자동 삭제) */
  meetAtMs: number;
  /** 주최자가 [시작하기]를 누른 서버 시각 = 위치 공개·체크인 시작. null = 아직 시작 전 */
  startedAtMs: number | null;
  /** 시작하던 순간의 약속 시각(R1: 시작 후 미루기 한도 = 이 값 + 180분, 누적). 시작 전 null */
  startMeetAtMs: number | null;
  /** 시작하던 순간의 핀(R2: 시작 후 장소 옮기기는 이 점에서 500m 안, 누적). 시작 전 null */
  startPlaceLat: number | null;
  startPlaceLng: number | null;
  /**
   * R3: 참가자가 있을 때 중요 변경(시각·시간대·핀·정책)을 한 뒤 5분이 지나야 [시작하기] 가능.
   * 그 시각(ms, 서버 시계)이 아직 미래면 그 값, 아니면 null. 서버가 계산해 내려준다(시작 뒤 변경에도 값이 생기지만 화면은 시작 전에만 쓴다)
   */
  startableAtMs: number | null;
  /** 체크인·위치 공개 종료 = 전액 몰수 시각 + 30분 꼬리(상한 마감 + 180분). 이 시각을 넘겨 도착하면 전액을 잃는다 */
  closeMs: number;
  placeName: string;
  placeNote: string;
  placeLat: number;
  placeLng: number;
  status: LateAppointmentStatus;
  voidReason: LbVoidReason | null;
  /** 제목·메모 외의 값이 바뀌면 +1. 변경 RPC 에 마지막으로 본 값을 넘긴다(어긋나면 LB_APPT_CHANGED) */
  version: number;
  policy: LatePolicy;
  /** 초대 명단(주최자 제외). 아직 안 들어온 이름은 약속 시각에 자동 삭제된다 */
  invitees: LbInvitee[];
  /** 조건 변경 이력(오래된 순). 화면은 마지막으로 본 version 보다 큰 것만 배너로 그린다 */
  changes: LbAppointmentChange[];
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
  /**
   * 초대할 친구 이름(닉네임) 명단. 주최자 본인 이름은 넣지 않는다(넣어도 무시).
   * 각 1~12자, 약속 안에서 유일(공백·보이지 않는 문자·대소문자 무시). 빈 배열도 된다(혼자 시작 가능)
   */
  invitees: string[];
  /** 위치 제공 동의 + 만 14세 이상. false 면 LB_CONSENT_REQUIRED */
  consent: boolean;
  /** LB_TZ_SUSPECT 를 받은 뒤 시간대 시트에서 고르고 다시 보낼 때 true */
  tzConfirmed?: boolean;
  /**
   * 생성 멱등 키(uuid). 폼 한 번에 하나 만들고 재시도(타임아웃·오프라인 뒤 [만들기] 다시 누르기)에 같은 값을 쓴다 →
   * 서버가 이미 만들었으면 새로 만들지 않고 그 약속을 돌려준다(약속·에스크로 중복 방지). 없으면 멱등하지 않다
   */
  requestId?: string;
}

/**
 * #10 lb_edit_appointment 입력 — 바꿀 필드만 넣는다(부분 갱신).
 * - 시작 전: 전부. 걸 포인트가 오르면 전원 차액 추가 에스크로(부족분 자동 채움), 내리면 차액 환불
 * - 시작 후: localAt/tz(뒤로 미루기만 — 지금 약속 시각 전에만, 시작하던 순간의 약속 시각 + 3시간까지)·placeName·
 *   lat/lng(시작하던 순간의 핀에서 500m 안) 만. policy 가 있으면 값이 같아야 한다(다르면 LB_EDIT_FROZEN)
 * - 정산이 시작된 뒤(마감 지남·닫힘)에는 LB_EDIT_CLOSED
 */
export interface LbEditPatch {
  localAt?: string;
  tz?: string;
  placeName?: string;
  lat?: number;
  lng?: number;
  policy?: LatePolicy;
  tzConfirmed?: boolean;
}

/** lb_edit_invitees 입력 — 시작 전에만. remove 는 아직 안 들어온 이름만(들어온 사람은 kick) */
export interface LbInviteesPatch {
  add?: string[];
  remove?: string[];
}

/** #3 lb_peek_invite — 초대 링크를 연 사람이 본다(멤버가 아니어도 명단 이름은 보인다: 자기 이름을 골라야 하므로) */
export interface LbInvitePreview {
  id: string;
  title: string;
  hostNickname: string;
  localAt: string;
  tz: string;
  meetAtMs: number;
  /** 주최자가 이미 시작했으면 그 시각. 시작 뒤에도 약속 시각까지는 명단의 빈 이름을 고를 수 있다(들어오면 바로 위치 공개 대상) */
  startedAtMs: number | null;
  closeMs: number;
  placeName: string;
  placeNote: string;
  placeLat: number;
  placeLng: number;
  status: LateAppointmentStatus;
  version: number;
  serverNowMs: number;
  policy: LatePolicy;
  /** 참가자 수(주최자 포함) */
  memberCount: number;
  /** 명단. claimed 면 고를 수 없다. mine 이면 내가 이미 고른 칸(멱등 재진입). 빈 이름이 없으면 참여 불가(LB_NOT_INVITED 안내) */
  invitees: { name: string; claimed: boolean; mine: boolean }[];
  /** 이미 멤버면 'active', 아니면 null */
  myState: LateMemberState | null;
  /** 프로필이 아직 없으면 null */
  myBalance: number | null;
}

/** #4 lb_claim_slot */
export interface LbJoinResult {
  appointmentId: string;
  state: LateMemberState;
  /** 주최자가 이미 시작한 약속에 들어왔는가 → 대기실이 아니라 바로 live 화면(위치 공개·판정 대상) */
  started: boolean;
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
 * closed·already_arrived·not_open·bad_position 은 좌표를 보지 않고 끝난 경우라 distanceM 이 없다.
 */
export type LbReportReason =
  | 'closed'
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

/** lb_get_live.participants[].location — 조건이 맞을 때만(시작됨 ∧ 마감 전 ∧ 미도착 ∧ 3분 안) */
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
  /** = 명단의 이름(주최자는 프로필 닉네임) */
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
  /**
   * 주최자가 시작한 뒤에 들어왔는가(명단 claimedAt > startedAt). 시작 전·주최자는 false.
   * R4: 시작 후에는 이 사람만 내보낼 수 있다(canKickAfterStart)
   */
  joinedAfterStart: boolean;
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
  /** (joinedAt, userId) 순 */
  participants: LbLiveParticipant[];
}

/** 홈 '약속' 섹션의 한 줄 (live 모드: RLS select appointments + participants) */
export interface LbMyAppointment {
  id: string;
  title: string;
  localAt: string;
  tz: string;
  meetAtMs: number;
  /** 주최자가 [시작하기]를 누른 시각. null = 시작 전([모이는 중]) */
  startedAtMs: number | null;
  closeMs: number;
  placeName: string;
  status: LateAppointmentStatus;
  policy: LatePolicy;
  hostId: string;
  isHost: boolean;
  myState: LateMemberState;
  /** 참가자 수(주최자 포함) */
  memberCount: number;
  /** 명단에서 아직 안 들어온 이름 수(약속 시각이 지나면 삭제돼 0) */
  unclaimedCount: number;
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
