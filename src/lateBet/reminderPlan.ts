/**
 * 약속 로컬 알림 계획 — 순수 계산(설계서 §6 알림, §0-1 오너 확정 흐름 반영).
 *
 * '위치 공개 시작'은 시각이 아니라 주최자가 [시작하기]를 누르는 순간이라 로컬로 예약할 수 없다.
 * 그래서 계획은 약속 시각을 기준으로 한 네 가지뿐이다.
 *
 *   host-start  약속 30분 전   주최자 ∧ 아직 시작 안 함   "친구들이 모였으면 [시작하기]를 눌러 주세요"
 *   before-15   약속 15분 전   활성 참가자 전원
 *   before-5    약속 5분 전    활성 참가자 전원            "곧 약속 시간이에요. 도착했으면 앱을 열어 체크인하세요"
 *   at-meet     약속 시각      활성 참가자 전원            "약속 시간이 됐어요. 지금부터 늦으면 N분마다 −MP예요"
 *
 * - 이미 지난 시각·이미 도착·취소·정산됨(열린 약속이 아님)·아직 참여 전이면 계획이 없다(빈 배열).
 * - 키 = 약속 id + version + 종류. 시간을 미루면 version 이 올라 키가 전부 바뀌고, 옛 키는 동기화 때 취소된다.
 * - 계획의 시각은 **서버 시계 기준**이다. OS 에 예약할 때는 toDeviceFrame 으로 기기 시계로 옮긴다
 *   (가짜 서버의 '시간 빨리 감기'나 틀린 기기 시계에서도 약속 기준으로 울리게).
 * - 문구에는 친구 닉네임·장소를 넣지 않는다(잠금 화면에 보인다). 제목은 약속 제목뿐이다. 이모지 없음.
 *
 * React·RN·expo 를 import 하지 않는다(node:test 로 검증한다).
 */
import { formatLoss, formatMinutes } from '../domain/latePresets';

import type { LbAppointment, LbLive } from './types';

const MINUTE_MS = 60_000;

export type ReminderKind = 'host-start' | 'before-15' | 'before-5' | 'at-meet';

/** 약속 시각에서 몇 분 전에 울리는가 */
export const REMINDER_LEAD_MINUTES: Readonly<Record<ReminderKind, number>> = {
  'host-start': 30,
  'before-15': 15,
  'before-5': 5,
  'at-meet': 0,
};

/**
 * 지금부터 이보다 가까운 시각은 **새로** 예약하지 않는다(diffReminders 의 notBeforeMs) — iOS 는 0초 이하 예약을 거부한다.
 * 이미 예약해 둔 것은 곧 울릴 차례여도 그대로 둔다(계획에서 빼면 울리기 직전에 취소돼 버린다).
 */
export const MIN_LEAD_MS = 10_000;

/** 이미 예약된 알림과 새 계획의 시각 차이가 이 안이면 같은 것으로 본다(서버 시계 오프셋의 흔들림을 흡수) */
export const REMINDER_TIME_TOLERANCE_MS = 30_000;

/** 알림 data 에 붙이는 표식. 이 표식이 없는 알림은 절대 건드리지 않는다 */
export const REMINDER_SOURCE = 'lateBet';

/** 안드로이드 알림 채널 id */
export const REMINDER_CHANNEL_ID = 'late';

/** 제목 길이 상한(잠금 화면 한 줄) */
const TITLE_MAX = 40;

export interface ReminderItem {
  /** = OS 알림 identifier. `late:<약속 id>:v<version>:<종류>` */
  key: string;
  appointmentId: string;
  kind: ReminderKind;
  /** 울릴 시각(epoch ms). planReminders 는 서버 시계, toDeviceFrame 뒤에는 기기 시계 */
  fireAtMs: number;
  title: string;
  body: string;
}

/** planReminders 가 읽는 약속 필드 */
export type ReminderAppointment = Pick<
  LbAppointment,
  'id' | 'version' | 'title' | 'status' | 'meetAtMs' | 'startedAtMs' | 'closeMs' | 'policy' | 'hostId'
>;

/** 내 참가자 행(없으면 아직 참여 전) */
export interface ReminderMe {
  userId: string;
  arrivedAtMs: number | null;
}

export function reminderKey(appointmentId: string, version: number, kind: ReminderKind): string {
  return `late:${appointmentId}:v${version}:${kind}`;
}

function isFiniteMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function reminderTitle(title: string): string {
  const t = (title ?? '').replace(/\s+/g, ' ').trim();
  if (t === '') return '약속';
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** 정시 알림 문구 — 정책에서 계산한다(숫자를 적어 두지 않는다) */
export function meetBody(policy: ReminderAppointment['policy'], started: boolean): string {
  // 아직 시작 전에 계획한 알림이면, 울릴 때 주최자가 시작했는지(아니면 무효인지) 모른다 → 중립 문구
  if (!started) return '약속 시간이 됐어요. 앱을 열어 약속 상태를 확인해 주세요.';
  const stake = Math.max(0, Math.floor(policy.stake));
  if (stake === 0) return '약속 시간이 됐어요. 도착했으면 앱을 열어 체크인하세요.';
  const perUnit = Math.min(stake, Math.max(0, Math.floor(policy.penaltyPerUnit)));
  if (perUnit === 0) return `약속 시간이 됐어요. 늦어도 괜찮지만 끝까지 오지 않으면 ${stake}P를 모두 잃어요.`;
  const every = `${policy.unitMinutes}분마다 ${formatLoss(perUnit)}예요.`;
  if (policy.graceMinutes > 0) {
    return `약속 시간이 됐어요. ${formatMinutes(policy.graceMinutes)}까지는 봐주고, 그 뒤로는 ${every}`;
  }
  return `약속 시간이 됐어요. 지금부터 늦으면 ${every}`;
}

function bodyFor(kind: ReminderKind, appointment: ReminderAppointment, isHost: boolean, started: boolean): string {
  const hostWaiting = isHost && !started;
  switch (kind) {
    case 'host-start':
      return '30분 뒤 약속이에요. 친구들이 모였으면 [시작하기]를 눌러 주세요. 약속 시각까지 시작하지 않으면 무효가 돼요.';
    case 'before-15':
      if (hostWaiting) return '15분 뒤 약속이에요. 아직 [시작하기]를 누르지 않았어요. 누르면 서로 위치가 보여요.';
      return started
        ? '15분 뒤 약속이에요. 앱을 열면 친구들이 어디쯤인지 보여요.'
        : '15분 뒤 약속이에요. 도착하면 앱을 열어 체크인하세요.';
    case 'before-5':
      if (hostWaiting) return '곧 약속 시간이에요. 약속 시각까지 [시작하기]를 누르지 않으면 무효가 돼요.';
      return '곧 약속 시간이에요. 도착했으면 앱을 열어 체크인하세요.';
    case 'at-meet':
      return meetBody(appointment.policy, started);
  }
}

/**
 * 이 약속에서 나에게 예약할 알림(서버 시계 기준, 울릴 시각 순).
 * nowMs 도 서버 시계(serverNow())다.
 */
export function planReminders(
  appointment: ReminderAppointment,
  me: ReminderMe | null,
  nowMs: number,
): ReminderItem[] {
  if (!me) return [];
  if (appointment.status !== 'open') return [];
  if (me.arrivedAtMs !== null) return [];
  if (!isFiniteMs(nowMs) || !isFiniteMs(appointment.meetAtMs)) return [];
  if (isFiniteMs(appointment.closeMs) && nowMs > appointment.closeMs) return [];

  const started = appointment.startedAtMs !== null;
  const isHost = me.userId === appointment.hostId;
  const kinds: ReminderKind[] = [];
  if (isHost && !started) kinds.push('host-start');
  kinds.push('before-15', 'before-5');
  // 시작 안 한 주최자에게 정시 알림은 없다 — 그 시각에 약속은 무효가 된다(주최자는 앱 안에서 시작하므로 계획이 곧바로 다시 짜인다)
  if (!(isHost && !started)) kinds.push('at-meet');

  const title = reminderTitle(appointment.title);
  const items: ReminderItem[] = [];
  for (const kind of kinds) {
    const fireAtMs = appointment.meetAtMs - REMINDER_LEAD_MINUTES[kind] * MINUTE_MS;
    // 지난 시각만 뺀다. 곧 울릴 것은 남겨 둬야 이미 예약된 것을 취소하지 않는다(새 예약 여부는 diffReminders 가 정한다)
    if (fireAtMs <= nowMs) continue;
    items.push({
      key: reminderKey(appointment.id, appointment.version, kind),
      appointmentId: appointment.id,
      kind,
      fireAtMs,
      title,
      body: bodyFor(kind, appointment, isHost, started),
    });
  }
  return items.sort((a, b) => a.fireAtMs - b.fireAtMs);
}

/** lb_get_live 응답으로 계획을 짠다. 정산 확인 중(settlePending)이거나 내 행이 없으면 빈 배열 */
export function planForLive(
  live: Pick<LbLive, 'myUserId' | 'settlePending' | 'appointment'> & {
    participants: readonly { userId: string; arrivedAtMs: number | null }[];
  },
  nowMs: number,
): ReminderItem[] {
  if (live.settlePending) return [];
  const row = live.participants.find((p) => p.userId === live.myUserId);
  const me: ReminderMe | null = row ? { userId: row.userId, arrivedAtMs: row.arrivedAtMs } : null;
  return planReminders(live.appointment, me, nowMs);
}

/**
 * 서버 시계 기준 계획 → 기기 시계 기준(OS 예약용).
 * offset = serverNow − deviceNow 이므로 기기 시각 = 서버 시각 − offset.
 */
export function toDeviceFrame(items: readonly ReminderItem[], serverOffsetMs: number): ReminderItem[] {
  const offset = isFiniteMs(serverOffsetMs) ? serverOffsetMs : 0;
  return items.map((i) => ({ ...i, fireAtMs: i.fireAtMs - offset }));
}

// ───────────────────────── 예약 목록 대조 ─────────────────────────

/** 알림 data 에 싣는 값(탭 → 약속 화면, 동기화 대조). expo 의 `data: Record<string, unknown>` 에 그대로 들어가게 type 으로 둔다 */
export type ReminderData = {
  source: typeof REMINDER_SOURCE;
  appointmentId: string;
  key: string;
  kind: ReminderKind;
  /** 기기 시계 기준 예약 시각 */
  fireAtMs: number;
};

export function reminderData(item: ReminderItem): ReminderData {
  return { source: REMINDER_SOURCE, appointmentId: item.appointmentId, key: item.key, kind: item.kind, fireAtMs: item.fireAtMs };
}

/** 약속 id 로 받아들이는 모양. 알림 data 는 기기 밖에서 온 값처럼 다룬다(라우트에 넣기 전에 거른다) */
const APPOINTMENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KINDS: ReadonlySet<string> = new Set(Object.keys(REMINDER_LEAD_MINUTES));

/** 알림 data → 우리 알림이면 그 값, 아니면 null */
export function readReminderData(data: unknown): ReminderData | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.source !== REMINDER_SOURCE) return null;
  if (typeof d.appointmentId !== 'string' || !APPOINTMENT_ID_RE.test(d.appointmentId)) return null;
  if (typeof d.key !== 'string' || typeof d.kind !== 'string' || !KINDS.has(d.kind)) return null;
  return {
    source: REMINDER_SOURCE,
    appointmentId: d.appointmentId,
    key: d.key,
    kind: d.kind as ReminderKind,
    fireAtMs: isFiniteMs(d.fireAtMs) ? d.fireAtMs : Number.NaN,
  };
}

/** 알림을 탭했을 때 열 약속 id. 우리 알림이 아니면 null */
export function appointmentIdFromData(data: unknown): string | null {
  return readReminderData(data)?.appointmentId ?? null;
}

/** OS 에 이미 예약돼 있는 우리 알림 한 건 */
export interface ScheduledReminder {
  key: string;
  /** 모르면 NaN(→ 다시 예약한다) */
  fireAtMs: number;
  title: string | null;
  body: string | null;
}

export interface ReminderDiff {
  /** 취소할 identifier(= key) */
  cancel: string[];
  /** 새로(또는 다시) 예약할 것 */
  schedule: ReminderItem[];
}

export interface DiffOptions {
  /** 새로 예약할 것은 이 시각보다 뒤여야 한다(보통 기기 now + MIN_LEAD_MS). 이미 예약된 것은 이 값과 무관하게 유지 */
  notBeforeMs?: number;
  toleranceMs?: number;
}

/**
 * 이미 예약된 것과 원하는 계획을 대조한다.
 * - 계획에 없는 키, 문구가 달라진 키, 시각이 tolerance 넘게 어긋난 키는 취소
 * - 계획 중 (취소 뒤) 예약돼 있지 않고 notBeforeMs 뒤인 것만 예약
 * 같은 계획으로 두 번 부르면 두 번째는 아무것도 하지 않는다.
 */
export function diffReminders(
  current: readonly ScheduledReminder[],
  desired: readonly ReminderItem[],
  options: DiffOptions = {},
): ReminderDiff {
  const toleranceMs = options.toleranceMs ?? REMINDER_TIME_TOLERANCE_MS;
  const notBeforeMs = options.notBeforeMs ?? Number.NEGATIVE_INFINITY;
  const want = new Map<string, ReminderItem>();
  for (const d of desired) if (!want.has(d.key)) want.set(d.key, d);

  const cancel: string[] = [];
  const kept = new Set<string>();
  for (const c of current) {
    // identifier 는 OS 안에서 유일하다. 혹시 같은 키가 또 오면 앞의 판정을 따른다
    if (kept.has(c.key) || cancel.includes(c.key)) continue;
    const d = want.get(c.key);
    const same =
      d !== undefined &&
      c.title === d.title &&
      c.body === d.body &&
      isFiniteMs(c.fireAtMs) &&
      Math.abs(c.fireAtMs - d.fireAtMs) <= toleranceMs;
    if (same) kept.add(c.key);
    else cancel.push(c.key);
  }
  const schedule = [...want.values()].filter((d) => !kept.has(d.key) && isFiniteMs(d.fireAtMs) && d.fireAtMs > notBeforeMs);
  return { cancel, schedule };
}

/** 계획 한 건을 '예약돼 있는 것' 모양으로 */
export function asScheduled(item: ReminderItem): ScheduledReminder {
  return { key: item.key, fireAtMs: item.fireAtMs, title: item.title, body: item.body };
}

/** 두 계획이 (시각 허용 범위 안에서) 같은가 — 약속 화면이 폴링마다 네이티브를 부르지 않게 */
export function sameReminderPlan(prev: readonly ReminderItem[], next: readonly ReminderItem[]): boolean {
  if (prev.length !== next.length) return false;
  const d = diffReminders(prev.map(asScheduled), next);
  return d.cancel.length === 0 && d.schedule.length === 0;
}

// ───────────────────────── 웹·네이티브 공통 계약 ─────────────────────────

export type NotificationPermission = 'granted' | 'denied' | 'undetermined' | 'unsupported';

/** @deprecated P0 계약의 예약 대상. 예약은 이제 약속 화면이 lb_get_live 로 짠 계획(syncReminders)으로만 한다 */
export interface LateNotificationTarget {
  id: string;
  version: number;
  title: string;
  tz: string;
  meetAtMs: number;
  closeMs: number;
}

export interface SyncRemindersResult {
  /** 동기화 시점의 알림 권한. granted 가 아니면 새로 예약하지 않고 취소만 한다 */
  permission: NotificationPermission;
  scheduled: number;
  canceled: number;
  /** 예약·취소 중 실패한 것이 있었다(다음 동기화에서 다시 맞춘다) */
  failed: boolean;
}

/**
 * notifications.ts(웹·무동작) 와 notifications.native.ts(expo-notifications) 가 똑같이 내보내는 것.
 * 두 파일은 맨 아래에서 `satisfies LateNotificationsApi` 로 모양을 컴파일 때 맞춘다.
 */
export interface LateNotificationsApi {
  NOTIFICATIONS_SUPPORTED: boolean;
  /** 현재 권한(묻지 않는다) */
  getPermission(): Promise<NotificationPermission>;
  /** 안드로이드 'late' 채널 생성(iOS·웹은 무동작). 권한 요청·예약보다 반드시 먼저 */
  ensureChannel(): Promise<void>;
  /** 채널 생성 → OS 권한 프롬프트 */
  requestPermission(): Promise<NotificationPermission>;
  /** 이 약속의 예약을 계획(기기 시계 기준 — toDeviceFrame 뒤)에 맞춘다 */
  syncReminders(appointmentId: string, plan: readonly ReminderItem[]): Promise<SyncRemindersResult>;
  /** 이 약속의 예약을 전부 취소(도착·취소·정산·나가기·내보내짐) */
  cancelAll(appointmentId: string): Promise<void>;
  /** keepAppointmentIds 에 없는 약속의 예약을 전부 취소(홈 목록 새로고침 뒤 — 내가 안 본 사이 취소·정산된 약속) */
  pruneReminders(keepAppointmentIds: readonly string[]): Promise<void>;
  /**
   * 앱 시작 때 1회 마운트(LateBetProvider 안, 모드 on 일 때만). 아무것도 그리지 않는다.
   * 포그라운드에서도 배너가 뜨게 하고(setNotificationHandler), 알림을 탭하면 그 약속 화면으로 간다.
   */
  LateNotificationRouting(): null;

  // ── P0 계약(호출 지점 호환용) ──
  /** @deprecated 묻지 않는다 — 현재 권한만 돌려준다. OS 프롬프트는 약속 화면의 '알림 켜기' 카드(requestPermission)에서만 */
  ensureNotificationPermission(): Promise<NotificationPermission>;
  /** 안드로이드 12+ 정확 알람 가능 여부. 0.4.0 은 SCHEDULE_EXACT_ALARM 을 선언하지 않아 안드로이드 12+ 는 항상 false(부정확 알람, best-effort) */
  canScheduleExactAlarms(): Promise<boolean>;
  /** @deprecated 무동작. 약속 화면이 lb_get_live 로 계획을 짜 syncReminders 한다 */
  scheduleLateNotifications(target: LateNotificationTarget): Promise<void>;
  /** = cancelAll */
  cancelLateNotifications(appointmentId: string): Promise<void>;
}
