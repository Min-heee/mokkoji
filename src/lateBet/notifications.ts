/**
 * 로컬 알림 — P0 에서는 무동작이다(expo-notifications 는 P1 의 네이티브 빌드에서 들어온다).
 *
 * 시그니처는 P1 과 같게 확정해 둔다. 화면은 지금부터 이 함수들을 부르면 되고, P1 에서 구현만 바뀐다.
 * 키는 (약속 id + version) — 조건이 바뀌면 다시 예약한다.
 */
export type NotificationPermission = 'granted' | 'denied' | 'undetermined' | 'unsupported';

export interface LateNotificationTarget {
  id: string;
  version: number;
  title: string;
  tz: string;
  meetAtMs: number;
  shareStartMs: number;
  closeMs: number;
}

/** P0: 항상 false */
export const NOTIFICATIONS_SUPPORTED = false;

/** 채널 생성 → 권한 요청(안드로이드 13 은 채널이 먼저다). P0: 'unsupported' */
export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  return 'unsupported';
}

/** 안드로이드 정확한 알림 권한. 없으면 대기실에 "알림이 늦게 올 수 있어요 [설정 열기]". P0: true(경고를 띄우지 않는다) */
export async function canScheduleExactAlarms(): Promise<boolean> {
  return true;
}

/** 참여·생성·조건 변경 직후: 공개 시작 / 약속 5분 전 / 마감 임박 알림을 (다시) 예약한다 */
export async function scheduleLateNotifications(_target: LateNotificationTarget): Promise<void> {
  // P1
}

/** 도착·취소·정산·나가기 때 */
export async function cancelLateNotifications(_appointmentId: string): Promise<void> {
  // P1
}
