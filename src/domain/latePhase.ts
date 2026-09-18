/**
 * 약속 내기 — 화면 단계(phase) 판정 (순수 함수).
 *
 * 서버가 준 live 상태(lb_get_live 응답)와 '서버 기준 현재 시각'으로 지금 어떤 화면을 그릴지 정한다.
 * - Date.now()·기기 타임존에 의존하지 않는다. 시각은 전부 epoch ms 인자다.
 * - 판정 권한은 서버에 있다. 이 모듈은 표시용이다(도착·정산을 여기서 확정하지 않는다).
 *
 * 오너 확정 흐름(2026-09-18):
 * - 참여 = 초대 명단의 이름을 고르는 것(slot claim). 멤버 상태는 active 하나다(수락제 없음).
 * - 시작 = 주최자가 [시작하기]를 누른 서버 시각(startedAtMs). 그 순간부터 전원 위치가 서로 보이고 체크인이 열린다.
 *   시작 전(waiting)에는 명단·조건 변경과 나가기가 되고, 시작 후에는 시간 미루기·장소 변경만 된다.
 *   아직 안 들어온 이름은 시작 뒤에도 약속 시각까지 계속 들어올 수 있다.
 * - 체크인·위치 공개 창 = startedAtMs ~ closeMs. '전원 참여 시 자동 잠금'(lockedAt) 개념은 없다.
 * - 약속 시각까지 시작하지 않은 약속은 무효(voidReason 'notStarted', 전원 환불)로 닫힌다.
 *
 * 입력 타입은 lb_get_live 페이로드의 부분집합이다.
 * src/lateBet/types.ts 의 DTO 는 이 구조 타입을 만족하도록 만든다(필드가 더 있어도 된다).
 */
import { closeAtMs, normalizeLatePolicy, type LatePolicy } from './lateBet';

export type LateAppointmentStatus = 'open' | 'settled' | 'voided' | 'canceled';
/** 멤버 상태. 수락제가 없어 active 하나뿐이다(구조 호환을 위해 필드는 남긴다) */
export type LateMemberState = 'active';

/** phase 판정에 필요한 약속 필드만 */
export interface LatePhaseAppointment {
  status: LateAppointmentStatus;
  /** 약속 시각 = 마감 = 참여 마감 = 시작 마감(이 시각까지 시작하지 않으면 무효, 안 들어온 이름은 삭제) */
  meetAtMs: number;
  /** 주최자가 [시작하기]를 누른 서버 시각. null = 아직 시작 전(대기실) */
  startedAtMs: number | null;
  /** 체크인·위치 공개 종료(전액 몰수 시각 + 30분 꼬리, 상한 마감 + 180분) */
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
 * - waiting  : 시작 전(대기실). 명단·조건 변경, 나가기 가능. 위치는 아무도 못 보고 체크인도 안 열린다
 * - live     : 시작 뒤, 지금 도착하면 전액 돌려받음 (약속 시각 + 봐주는 시간 이내)
 * - overtime : 시작 뒤, 지각 구간 (지금 도착하면 포인트를 잃는다)
 * - arrived  : 나는 도착했고 나머지를 기다리는 중
 * - settling : 체크인이 닫혔고 결과 확정 전
 * - settled · voided · canceled : 서버 status 그대로
 */
export type LatePhase = 'waiting' | 'live' | 'overtime' | 'arrived' | 'settling' | 'settled' | 'voided' | 'canceled';

const MINUTE_MS = 60_000;

const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 내 참가자 행 (없으면 null — 응답이 비정상일 때) */
export function myParticipant<P extends LatePhaseParticipant>(
  live: { myUserId: string; participants: readonly P[] },
): P | null {
  return live.participants.find((p) => p.userId === live.myUserId) ?? null;
}

/** 이 시각(포함)까지 도착하면 전액 돌려받는다 = 약속 시각 + 봐주는 시간 */
export function onTimeUntilMs(appointment: Pick<LatePhaseAppointment, 'meetAtMs' | 'policy'>): number {
  return appointment.meetAtMs + normalizeLatePolicy(appointment.policy).graceMinutes * MINUTE_MS;
}

/**
 * 시작했는가 = 주최자가 [시작하기]를 눌렀는가(서버가 startedAtMs 를 찍는다). 이후 되돌릴 수 없다.
 * 시작 후에는 명단 편집·나가기·내보내기 불가, 조건은 동결되고 시간 미루기·장소 변경만 된다.
 */
export function isStarted(appointment: Pick<LatePhaseAppointment, 'startedAtMs'>): boolean {
  return isMs(appointment.startedAtMs);
}

/** 체크인·위치 공개 창 안인가 (서버: started_at <= now() <= close_at, 양끝 포함). 시작 전에는 항상 false */
export function isCheckInOpen(
  appointment: Pick<LatePhaseAppointment, 'status' | 'startedAtMs' | 'closeMs'>,
  serverNowMs: number,
): boolean {
  return (
    appointment.status === 'open' &&
    isMs(appointment.startedAtMs) &&
    isMs(serverNowMs) &&
    serverNowMs >= appointment.startedAtMs &&
    serverNowMs <= appointment.closeMs
  );
}

/**
 * 남의 위치가 보이는 조건(서버 lb_get_live 와 같은 식) = 체크인 창과 같다(시작됨 ∧ 마감 전).
 * 대상 미도착·3분 내 갱신은 서버가 location 을 null 로 만들어 알려 준다.
 */
export function isLocationVisible(
  appointment: Pick<LatePhaseAppointment, 'status' | 'startedAtMs' | 'closeMs'>,
  serverNowMs: number,
): boolean {
  return isCheckInOpen(appointment, serverNowMs);
}

/**
 * 정책과 약속 시각에서 서버와 같은 식으로 체크인 마감 시각을 구한다 (= lateBet.closeAtMs, SQL private.lb_close_at).
 * 생성 폼의 미리보기와 fakeApi 가 쓴다. live 모드에서는 서버가 준 값을 그대로 쓴다. 약속 시각이 쓰레기면 NaN.
 */
export function lateCloseMs(policy: LatePolicy, meetAtMs: number): number {
  return closeAtMs(policy, meetAtMs) ?? Number.NaN;
}

/**
 * 화면 단계.
 * 우선순위: 닫힌 status → 정산 대기(마감 지남) → 내 도착 → 시작 전(waiting) → 제시간 구간 → 지각 구간.
 * serverNowMs 가 쓰레기면(NaN 등) 시각 비교를 건너뛰고 서버 플래그만으로 가장 보수적인 단계를 고른다
 * (시작했으면 live, 아니면 waiting).
 */
export function phase(live: LatePhaseInput, serverNowMs: number): LatePhase {
  const a = live.appointment;
  if (a.status === 'canceled') return 'canceled';
  if (a.status === 'voided') return 'voided';
  if (a.status === 'settled') return 'settled';

  const nowOk = isMs(serverNowMs);
  if (live.settlePending || (nowOk && serverNowMs > a.closeMs)) return 'settling';

  const me = myParticipant(live);
  if (me && me.arrivedAtMs !== null) return 'arrived';

  if (!isStarted(a)) return 'waiting';
  if (!nowOk) return 'live';
  return serverNowMs <= onTimeUntilMs(a) ? 'live' : 'overtime';
}

/** 끝난 단계인가 (폴링·위치 보고·알림을 멈춰도 되는가) */
export function isClosedPhase(p: LatePhase): boolean {
  return p === 'settled' || p === 'voided' || p === 'canceled';
}

/**
 * 폴링 간격(ms). 시작 뒤·정산 대기 5초, 대기실 10초(주최자의 [시작하기]를 게스트가 곧 봐야 한다), 끝났으면 멈춤(null).
 * 백그라운드 정지는 호출부(useLive)가 한다.
 */
export function pollIntervalMs(p: LatePhase): number | null {
  if (isClosedPhase(p)) return null;
  return p === 'waiting' ? 10_000 : 5_000;
}

/** 활성 참가자 전원이 도착했는가 (한 명도 없으면 false — 서버 bool_and 의 coalesce(false) 와 같다) */
export function allActiveArrived(participants: readonly LatePhaseParticipant[]): boolean {
  const active = participants.filter((p) => p.state === 'active');
  return active.length > 0 && active.every((p) => p.arrivedAtMs !== null);
}
