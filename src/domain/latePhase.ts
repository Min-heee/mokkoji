/**
 * 약속 내기 — 화면 단계(phase) 판정 (순수 함수).
 *
 * 서버가 준 live 상태(lb_get_live 응답)와 '서버 기준 현재 시각'으로 지금 어떤 화면을 그릴지 정한다.
 * - Date.now()·기기 타임존에 의존하지 않는다. 시각은 전부 epoch ms 인자다.
 * - 판정 권한은 서버에 있다. 이 모듈은 표시용이다(도착·정산을 여기서 확정하지 않는다).
 *
 * 입력 타입은 lb_get_live 페이로드(설계서 부록 A 15번)의 부분집합이다.
 * src/lateBet/types.ts 의 DTO 는 이 구조 타입을 만족하도록 만든다(필드가 더 있어도 된다).
 */
import { locationShareWindow, normalizeLatePolicy, type LatePolicy } from './lateBet';

export type LateAppointmentStatus = 'open' | 'settled' | 'voided' | 'canceled';
export type LateMemberState = 'active' | 'pending';

/** phase 판정에 필요한 약속 필드만 */
export interface LatePhaseAppointment {
  status: LateAppointmentStatus;
  /** 약속 시각 = 마감 = 참여·승인 마감 */
  meetAtMs: number;
  /** 위치 공개 시작 = 체크인 개시 = 잠금 */
  shareStartMs: number;
  /** 체크인·위치 공개 종료. 이 시각을 넘겨 도착하면 전액 몰수 */
  closeMs: number;
  policy: LatePolicy;
}

/** phase 판정에 필요한 참가자 필드만 */
export interface LatePhaseParticipant {
  userId: string;
  state: LateMemberState;
  arrivedAtMs: number | null;
}

/** lb_get_live 응답의 최소 구조 */
export interface LatePhaseInput {
  myUserId: string;
  myState: LateMemberState;
  /** 서버: open ∧ now() > close_at. 정산이 아직 안 돌았거나 실패한 상태 */
  settlePending: boolean;
  appointment: LatePhaseAppointment;
  participants: readonly LatePhaseParticipant[];
}

/**
 * - pending  : 잠금 후 참여 요청을 보냈고 주최자 수락 전 (다른 사람·위치 안 보임)
 * - waiting  : 잠금 전 대기실
 * - live     : 위치 공개 중, 지금 도착하면 전액 돌려받음 (약속 시각 + 봐주는 시간 이내)
 * - overtime : 위치 공개 중, 지각 구간 (지금 도착하면 포인트를 잃는다)
 * - arrived  : 나는 도착했고 나머지를 기다리는 중
 * - settling : 체크인이 닫혔고 결과 확정 전
 * - settled · voided · canceled : 서버 status 그대로
 */
export type LatePhase =
  | 'pending'
  | 'waiting'
  | 'live'
  | 'overtime'
  | 'arrived'
  | 'settling'
  | 'settled'
  | 'voided'
  | 'canceled';

const MINUTE_MS = 60_000;

const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 내 참가자 행 (없으면 null — 승인 대기 중이거나 응답이 비정상일 때) */
export function myParticipant<P extends LatePhaseParticipant>(
  live: { myUserId: string; participants: readonly P[] },
): P | null {
  return live.participants.find((p) => p.userId === live.myUserId) ?? null;
}

/** 이 시각(포함)까지 도착하면 전액 돌려받는다 = 약속 시각 + 봐주는 시간 */
export function onTimeUntilMs(appointment: Pick<LatePhaseAppointment, 'meetAtMs' | 'policy'>): number {
  return appointment.meetAtMs + normalizeLatePolicy(appointment.policy).graceMinutes * MINUTE_MS;
}

/** 잠겼는가 = 위치 공개가 시작됐는가. 이후 나가기·강퇴·취소 불가, 참여는 승인제 (서버: now() >= share_start_at) */
export function isLocked(appointment: Pick<LatePhaseAppointment, 'shareStartMs'>, serverNowMs: number): boolean {
  return isMs(serverNowMs) && serverNowMs >= appointment.shareStartMs;
}

/** 체크인·위치 공개 창 안인가 (서버: share_start_at <= now() <= close_at, 양끝 포함) */
export function isCheckInOpen(
  appointment: Pick<LatePhaseAppointment, 'status' | 'shareStartMs' | 'closeMs'>,
  serverNowMs: number,
): boolean {
  return (
    appointment.status === 'open' &&
    isMs(serverNowMs) &&
    serverNowMs >= appointment.shareStartMs &&
    serverNowMs <= appointment.closeMs
  );
}

/**
 * 정책과 약속 시각에서 서버와 같은 식으로 잠금·마감 시각을 구한다.
 * - shareStartMs = meet − shareLocationMinutesBefore분
 * - closeMs = SQL private.lb_close_at 과 같은 식 (= lateBet.locationShareWindow 의 endMs):
 *   내기 없음·단위 차감 0 → meet+60분, 그 외 min(meet+180분, 전액 몰수 시각)
 * 생성 폼의 미리보기와 fakeApi 가 쓴다. live 모드에서는 서버가 준 값을 그대로 쓴다.
 */
export function lateTimes(policy: LatePolicy, meetAtMs: number): { shareStartMs: number; closeMs: number } {
  const w = locationShareWindow(policy, meetAtMs);
  return { shareStartMs: w.startMs, closeMs: w.endMs };
}

/** 지금 만들면 만들자마자 잠기는가 (폼 경고: "만들면 바로 위치 공개가 시작돼요…") */
export function locksImmediately(policy: LatePolicy, meetAtMs: number, serverNowMs: number): boolean {
  if (!isMs(meetAtMs) || !isMs(serverNowMs)) return false;
  return serverNowMs >= lateTimes(policy, meetAtMs).shareStartMs;
}

/**
 * 화면 단계.
 * 우선순위: 닫힌 status → 승인 대기 → 정산 대기(마감 지남) → 내 도착 → 잠금 전 → 제시간 구간 → 지각 구간.
 * serverNowMs 가 쓰레기면(NaN 등) 시각 비교를 건너뛰고 서버 플래그만으로 가장 보수적인 단계를 고른다.
 */
export function phase(live: LatePhaseInput, serverNowMs: number): LatePhase {
  const a = live.appointment;
  if (a.status === 'canceled') return 'canceled';
  if (a.status === 'voided') return 'voided';
  if (a.status === 'settled') return 'settled';

  if (live.myState === 'pending') return 'pending';

  const nowOk = isMs(serverNowMs);
  if (live.settlePending || (nowOk && serverNowMs > a.closeMs)) return 'settling';

  const me = myParticipant(live);
  if (me && me.arrivedAtMs !== null) return 'arrived';

  if (!nowOk || serverNowMs < a.shareStartMs) return 'waiting';
  return serverNowMs <= onTimeUntilMs(a) ? 'live' : 'overtime';
}

/** 끝난 단계인가 (폴링·위치 보고·알림을 멈춰도 되는가) */
export function isClosedPhase(p: LatePhase): boolean {
  return p === 'settled' || p === 'voided' || p === 'canceled';
}

/**
 * 폴링 간격(ms). 설계서 §3.3: 공개 창·승인 대기·정산 대기 5초, 그 외 30초, 끝났으면 멈춤(null).
 * 백그라운드 정지는 호출부(useLive)가 한다.
 */
export function pollIntervalMs(p: LatePhase): number | null {
  if (isClosedPhase(p)) return null;
  return p === 'waiting' ? 30_000 : 5_000;
}

/** 활성 참가자 전원이 도착했는가 (한 명도 없으면 false — 서버 bool_and 의 coalesce(false) 와 같다) */
export function allActiveArrived(participants: readonly LatePhaseParticipant[]): boolean {
  const active = participants.filter((p) => p.state === 'active');
  return active.length > 0 && active.every((p) => p.arrivedAtMs !== null);
}
