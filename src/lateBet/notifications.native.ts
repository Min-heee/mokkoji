/**
 * 로컬 알림 — iOS·안드로이드 구현(expo-notifications 0.32, 로컬 예약만. 원격 푸시 토큰은 P5).
 *
 * 규칙(설계서 §6, §0-1)
 * - 안드로이드는 반드시 채널('late') 생성 → 권한 요청 순서(안드로이드 13 은 채널이 있어야 프롬프트가 뜬다).
 * - 예약 identifier = reminderPlan 의 키(약속 id + version + 종류). 트리거는 DATE(기기 시계 기준 ms).
 * - 0.4.0 은 SCHEDULE_EXACT_ALARM 을 선언하지 않는다 → 안드로이드 12+ 는 부정확 알람(setAndAllowWhileIdle)으로
 *   몇 분 밀릴 수 있다(best-effort). 최종 안전망은 보증 도착이다.
 * - 우리 알림은 data.source === 'lateBet' 로만 알아본다. 그 표식이 없는 예약은 절대 건드리지 않는다.
 * - 권한이 없으면 새로 예약하지 않고 취소만 한다(권한이 생기면 약속 화면이 다시 동기화한다).
 * - 모드 off 에서는 이 파일의 어떤 함수도 불리지 않는다(부르는 곳이 전부 약속 화면·LateBetProvider 활성 분기 안).
 *   import 만으로는 권한 요청·예약이 일어나지 않는다.
 */
import * as Notifications from 'expo-notifications';
import { router, usePathname, useRootNavigationState } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import {
  appointmentIdFromData,
  diffReminders,
  MIN_LEAD_MS,
  readReminderData,
  REMINDER_CHANNEL_ID,
  reminderData,
  type LateNotificationsApi,
  type LateNotificationTarget,
  type NotificationPermission,
  type ReminderItem,
  type ScheduledReminder,
  type SyncRemindersResult,
} from './reminderPlan';

export type { LateNotificationTarget, NotificationPermission, SyncRemindersResult } from './reminderPlan';

export const NOTIFICATIONS_SUPPORTED: boolean = Platform.OS === 'ios' || Platform.OS === 'android';

// ───────────────────────── 권한·채널 ─────────────────────────

function toPermission(s: Notifications.NotificationPermissionsStatus): NotificationPermission {
  if (s.granted) return 'granted';
  // iOS 임시 허용(조용히 알림 센터로)도 예약은 보인다
  const ios = s.ios?.status;
  if (ios === Notifications.IosAuthorizationStatus.PROVISIONAL || ios === Notifications.IosAuthorizationStatus.EPHEMERAL) {
    return 'granted';
  }
  if (s.status === Notifications.PermissionStatus.UNDETERMINED) return 'undetermined';
  return 'denied';
}

export async function getPermission(): Promise<NotificationPermission> {
  if (!NOTIFICATIONS_SUPPORTED) return 'unsupported';
  try {
    return toPermission(await Notifications.getPermissionsAsync());
  } catch {
    return 'unsupported';
  }
}

let channelReady: Promise<void> | null = null;

/** 안드로이드 'late' 채널(한 번 만들면 이름·설명만 바뀐다). iOS 는 무동작 */
export function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve();
  if (!channelReady) {
    channelReady = Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
      name: '약속 알림',
      description: '약속 시간이 다가오면 알려 드려요',
      // HIGH = 화면 위 배너(헤즈업). 소리·진동은 채널 기본값
      importance: Notifications.AndroidImportance.HIGH,
    })
      .then(() => undefined)
      .catch((e: unknown) => {
        channelReady = null; // 다음에 다시 시도
        throw e;
      });
  }
  return channelReady;
}

/** 채널 생성 → OS 권한 프롬프트('알림 켜기' 카드에서만 부른다) */
export async function requestPermission(): Promise<NotificationPermission> {
  if (!NOTIFICATIONS_SUPPORTED) return 'unsupported';
  try {
    await ensureChannel();
  } catch {
    // 채널이 실패해도 iOS 식 권한 요청은 해 본다(안드로이드 12 이하는 권한이 기본 허용)
  }
  try {
    const current = toPermission(await Notifications.getPermissionsAsync());
    if (current === 'granted') return current;
    const res = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    return toPermission(res);
  } catch {
    return 'unsupported';
  }
}

// ───────────────────────── 예약 ─────────────────────────

/** 동기화·취소가 겹치지 않게 한 줄로 세운다(폴링마다 불려도 목록을 읽고 고치는 사이에 끼어들지 않게) */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/** OS 에 예약된 우리 알림(약속 id 와 함께) */
async function scheduledOurs(): Promise<(ScheduledReminder & { appointmentId: string })[]> {
  const all = await Notifications.getAllScheduledNotificationsAsync();
  const out: (ScheduledReminder & { appointmentId: string })[] = [];
  for (const r of all) {
    const d = readReminderData(r.content.data);
    if (!d) continue;
    out.push({ key: r.identifier, appointmentId: d.appointmentId, fireAtMs: d.fireAtMs, title: r.content.title, body: r.content.body });
  }
  return out;
}

async function cancelKeys(keys: readonly string[]): Promise<{ canceled: number; failed: boolean }> {
  let canceled = 0;
  let failed = false;
  for (const key of keys) {
    try {
      await Notifications.cancelScheduledNotificationAsync(key);
      canceled += 1;
    } catch {
      failed = true;
    }
  }
  return { canceled, failed };
}

/**
 * 이 약속의 예약을 plan 에 맞춘다. plan 의 fireAtMs 는 **기기 시계 기준**(reminderPlan.toDeviceFrame 뒤)이다.
 * 계획에 없는 키·문구나 시각이 바뀐 키는 취소하고, 없는 것만 새로 예약한다. 같은 계획으로 여러 번 불러도 된다.
 */
export function syncReminders(appointmentId: string, plan: readonly ReminderItem[]): Promise<SyncRemindersResult> {
  if (!NOTIFICATIONS_SUPPORTED) {
    return Promise.resolve({ permission: 'unsupported', scheduled: 0, canceled: 0, failed: false });
  }
  return serial(async () => {
    const permission = await getPermission();
    let current: ScheduledReminder[];
    try {
      current = (await scheduledOurs()).filter((r) => r.appointmentId === appointmentId);
    } catch {
      return { permission, scheduled: 0, canceled: 0, failed: true };
    }
    const desired = permission === 'granted' ? plan.filter((i) => i.appointmentId === appointmentId) : [];
    // 곧 울릴 것은 새로 예약하지 않는다(이미 예약된 것은 그대로 둔다)
    const { cancel, schedule } = diffReminders(current, desired, { notBeforeMs: Date.now() + MIN_LEAD_MS });

    const c = await cancelKeys(cancel);
    let failed = c.failed;
    let scheduled = 0;
    if (schedule.length > 0) {
      try {
        await ensureChannel();
      } catch {
        failed = true;
      }
    }
    for (const item of schedule) {
      try {
        await Notifications.scheduleNotificationAsync({
          identifier: item.key,
          content: {
            title: item.title,
            body: item.body,
            data: reminderData(item),
            sound: 'default',
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: item.fireAtMs,
            channelId: REMINDER_CHANNEL_ID,
          },
        });
        scheduled += 1;
      } catch {
        failed = true;
      }
    }
    return { permission, scheduled, canceled: c.canceled, failed };
  });
}

/** 이 약속의 예약 전부 취소(도착·취소·정산·나가기·내보내짐) */
export function cancelAll(appointmentId: string): Promise<void> {
  if (!NOTIFICATIONS_SUPPORTED) return Promise.resolve();
  return serial(async () => {
    try {
      const mine = (await scheduledOurs()).filter((r) => r.appointmentId === appointmentId);
      await cancelKeys(mine.map((r) => r.key));
    } catch {
      // best-effort — 다음 동기화·정리가 다시 맞춘다
    }
  });
}

/** keepAppointmentIds 에 없는 약속의 예약 전부 취소(홈 목록을 새로 읽은 뒤) */
export function pruneReminders(keepAppointmentIds: readonly string[]): Promise<void> {
  if (!NOTIFICATIONS_SUPPORTED) return Promise.resolve();
  const keep = new Set(keepAppointmentIds);
  return serial(async () => {
    try {
      const stale = (await scheduledOurs()).filter((r) => !keep.has(r.appointmentId));
      await cancelKeys(stale.map((r) => r.key));
    } catch {
      // best-effort
    }
  });
}

// ───────────────────────── 포그라운드 표시·탭 이동 ─────────────────────────

let handlerInstalled = false;

/** 앱이 떠 있을 때도 우리 알림은 배너로 보인다(그 외 알림은 기본 동작 = 안 보임) */
function installHandler(): void {
  if (handlerInstalled || !NOTIFICATIONS_SUPPORTED) return;
  handlerInstalled = true;
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const ours = readReminderData(n.request.content.data) !== null;
      return {
        shouldShowBanner: ours,
        shouldShowList: ours,
        // 안드로이드는 소리를 끄면 배너도 안 뜬다
        shouldPlaySound: ours,
        shouldSetBadge: false,
      };
    },
  });
}

/**
 * 앱 시작 때 1회 마운트(LateBetProvider 활성 분기). 아무것도 그리지 않는다.
 * - setNotificationHandler 1회
 * - 알림 탭(앱이 떠 있을 때 = 리스너, 꺼져 있다 켜질 때 = 마지막 응답) → /late/<약속 id>
 *   루트 내비게이션이 준비되기 전에 온 탭은 준비된 뒤에 연다. 이미 그 약속 화면이면 다시 쌓지 않는다.
 */
export function LateNotificationRouting(): null {
  const pathname = usePathname();
  const navState = useRootNavigationState();
  const ready = !!navState?.key;

  const pathRef = useRef(pathname);
  const readyRef = useRef(ready);
  const pending = useRef<string | null>(null);
  const handled = useRef(new Set<string>());

  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);

  const open = (target: string) => {
    if (!readyRef.current) {
      pending.current = target;
      return;
    }
    if (pathRef.current === target) return;
    try {
      router.push(target);
    } catch {
      pending.current = target;
    }
  };

  const onResponse = (response: Notifications.NotificationResponse | null) => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = appointmentIdFromData(response.notification.request.content.data);
    if (!id) return;
    const tag = `${response.notification.request.identifier}@${response.notification.date}`;
    if (handled.current.has(tag)) return;
    handled.current.add(tag);
    try {
      Notifications.clearLastNotificationResponse();
    } catch {
      // 없어도 된다 — 같은 응답은 handled 로 한 번만 연다
    }
    open('/late/' + id);
  };
  const onResponseRef = useRef(onResponse);
  useEffect(() => {
    onResponseRef.current = onResponse;
  });

  useEffect(() => {
    installHandler();
    if (!NOTIFICATIONS_SUPPORTED) return;
    const sub = Notifications.addNotificationResponseReceivedListener((r) => onResponseRef.current(r));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    readyRef.current = ready;
    if (!ready || !NOTIFICATIONS_SUPPORTED) return;
    // 꺼져 있던 앱이 알림 탭으로 켜졌다
    try {
      onResponseRef.current(Notifications.getLastNotificationResponse());
    } catch {
      // 없으면 그만
    }
    const target = pending.current;
    pending.current = null;
    if (target) open(target);
    // ready 가 바뀔 때만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return null;
}

// ── P0 계약(호출 지점 호환용) ──

/** @deprecated 묻지 않는다 — 현재 권한만. OS 프롬프트는 약속 화면의 '알림 켜기' 카드(requestPermission)에서만 */
export function ensureNotificationPermission(): Promise<NotificationPermission> {
  return getPermission();
}

/** 0.4.0 은 SCHEDULE_EXACT_ALARM 을 선언하지 않는다 → 안드로이드 12(API 31)+ 는 부정확 알람 */
export async function canScheduleExactAlarms(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  return typeof Platform.Version === 'number' && Platform.Version < 31;
}

/** @deprecated 무동작 — 계획에 필요한 값(주최자·시작·도착)이 없다. 약속 화면이 lb_get_live 로 계획을 짜 syncReminders 한다 */
export async function scheduleLateNotifications(_target: LateNotificationTarget): Promise<void> {
  // 약속 화면(useLateReminders)이 맞춘다
}

export function cancelLateNotifications(appointmentId: string): Promise<void> {
  return cancelAll(appointmentId);
}

// 웹 구현과 같은 모양인지 컴파일 때 확인한다
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
