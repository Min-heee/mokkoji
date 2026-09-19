/**
 * 로컬 알림 — 웹·폴백 구현(무동작). iOS·안드로이드는 Metro 가 notifications.native.ts 를 고른다.
 *
 * 웹·앱인토스 번들에 expo-notifications 가 섞이지 않게 이 파일은 네이티브 모듈을 import 하지 않는다.
 * 모양(내보내는 이름·타입)은 reminderPlan.LateNotificationsApi 로 네이티브 구현과 맞춘다(맨 아래 satisfies).
 * 계획(언제 무엇을 울릴지)은 순수 모듈 reminderPlan.ts 에 있다.
 */
import type {
  LateNotificationsApi,
  LateNotificationTarget,
  NotificationPermission,
  ReminderItem,
  SyncRemindersResult,
} from './reminderPlan';

export type { LateNotificationTarget, NotificationPermission, SyncRemindersResult } from './reminderPlan';

export const NOTIFICATIONS_SUPPORTED: boolean = false;

export async function getPermission(): Promise<NotificationPermission> {
  return 'unsupported';
}

export async function ensureChannel(): Promise<void> {
  // 웹에는 알림 채널이 없다
}

export async function requestPermission(): Promise<NotificationPermission> {
  return 'unsupported';
}

export async function syncReminders(_appointmentId: string, _plan: readonly ReminderItem[]): Promise<SyncRemindersResult> {
  return { permission: 'unsupported', scheduled: 0, canceled: 0, failed: false };
}

export async function cancelAll(_appointmentId: string): Promise<void> {
  // 예약한 것이 없다
}

export async function pruneReminders(_keepAppointmentIds: readonly string[]): Promise<void> {
  // 예약한 것이 없다
}

/** 웹: 아무것도 하지 않는다 */
export function LateNotificationRouting(): null {
  return null;
}

// ── P0 계약(호출 지점 호환용) ──

/** @deprecated 묻지 않는다. 웹은 항상 'unsupported' */
export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  return 'unsupported';
}

/** 웹: 경고를 띄우지 않도록 true */
export async function canScheduleExactAlarms(): Promise<boolean> {
  return true;
}

/** @deprecated 무동작 */
export async function scheduleLateNotifications(_target: LateNotificationTarget): Promise<void> {
  // 약속 화면이 계획을 짜 syncReminders 한다
}

export async function cancelLateNotifications(_appointmentId: string): Promise<void> {
  // 예약한 것이 없다
}

// 네이티브 구현과 같은 모양인지 컴파일 때 확인한다
void ({
  NOTIFICATIONS_SUPPORTED,
  getPermission,
  ensureChannel,
  requestPermission,
  syncReminders,
  cancelAll,
  pruneReminders,
  LateNotificationRouting,
  ensureNotificationPermission,
  canScheduleExactAlarms,
  scheduleLateNotifications,
  cancelLateNotifications,
} satisfies LateNotificationsApi);
