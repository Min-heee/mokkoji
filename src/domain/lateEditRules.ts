/**
 * 약속 내기 — 시작 후 공정성 규칙 R1~R4 (오너 결정 2026-09-19). 순수 함수.
 *
 * 주최자가 친구 포인트를 부당하게 가져가는 경로 4개를 막는다. 서버(SQL)가 최종 권위이고,
 * 화면은 이 함수로 버튼을 미리 비활성화·설명하며, 가짜 서버(fakeApi)도 같은 함수로 판정한다.
 *
 * - R1 시작 후 시간 미루기: 지금 약속 시각 전에만(now < meetAt). 한도는 '시작하던 순간의 약속 시각(startMeetAtMs) + 180분' 누적.
 *   앞당기기는 불가. 시작 전에는 자유(여기서 막지 않는다 — '지금+5분~90일'은 서버 resolve_meet 몫).
 * - R2 시작 후 장소 옮기기: 새 핀이 '시작하던 순간의 핀(startPlaceLat/Lng)'에서 500m 이내일 때만(누적). 장소 이름만 바꾸는 건 제한 없음.
 * - R3 조건 바꾼 직후 시작 금지: 시작 전, 주최자 말고 참가자가 있을 때 중요 변경(시각·시간대·핀·정책 5개)이 있었으면 5분 뒤에야 시작.
 *   서버가 startableAtMs(= 변경 시각 + 5분, 이미 지났으면 null)로 내려준다.
 * - R4 시작 후 내보내기: 시작 뒤에 들어온 참가자(joinedAfterStart)만. 시작 전부터 있던 사람은 LB_KICK_CLOSED.
 *
 * 값은 SQL(supabase/migrations/20260918000000_late_bet.sql)과 같아야 한다.
 */
import { haversineMeters } from './geo';

const MINUTE_MS = 60_000;

/** R1: 시작하던 순간의 약속 시각에서 최대 몇 분까지 미룰 수 있는가(누적) */
export const POSTPONE_MAX_MINUTES_AFTER_START = 180;
/** R2: 시작하던 순간의 핀에서 최대 몇 m 안으로만 옮길 수 있는가(누적) */
export const MOVE_AFTER_START_MAX_M = 500;
/** R3: 참가자가 있을 때 중요 변경 뒤 시작까지 기다려야 하는 시간 */
export const START_COOLDOWN_MS = 5 * MINUTE_MS;

export type PostponeBlock = 'LB_POSTPONE_ONLY' | 'LB_POSTPONE_AFTER_MEET' | 'LB_POSTPONE_TOO_FAR';
export type MoveBlock = 'LB_MOVE_TOO_FAR';

/** 판정에 필요한 약속 필드(LbAppointment 가 구조적으로 만족한다) */
export interface EditRulesAppointment {
  meetAtMs: number;
  startedAtMs: number | null;
  /** 시작하던 순간의 약속 시각. 시작 전 null */
  startMeetAtMs: number | null;
  placeLat: number;
  placeLng: number;
  /** 시작하던 순간의 핀. 시작 전 null */
  startPlaceLat: number | null;
  startPlaceLng: number | null;
}

/** 시작 후 미룰 수 있는 가장 늦은 약속 시각(ms). 시작 전이면 null(이 규칙의 한도 없음) */
export function postponeLimitMs(appt: Pick<EditRulesAppointment, 'startedAtMs' | 'startMeetAtMs' | 'meetAtMs'>): number | null {
  if (appt.startedAtMs === null) return null;
  const base = appt.startMeetAtMs ?? appt.meetAtMs;
  return base + POSTPONE_MAX_MINUTES_AFTER_START * MINUTE_MS;
}

/**
 * R1 — 약속 시각을 newMeetMs 로 바꿔도 되는가(서버 시계 nowMs 기준).
 * 시각이 그대로면 항상 된다(미루기가 아니다). 판정 순서는 SQL 과 같다: 앞당기기 → 약속 시각 지남 → 누적 3시간 초과
 */
export function canPostpone(
  appt: Pick<EditRulesAppointment, 'startedAtMs' | 'startMeetAtMs' | 'meetAtMs'>,
  newMeetMs: number,
  nowMs: number,
): { ok: true } | { ok: false; code: PostponeBlock } {
  if (appt.startedAtMs === null || newMeetMs === appt.meetAtMs) return { ok: true };
  if (newMeetMs < appt.meetAtMs) return { ok: false, code: 'LB_POSTPONE_ONLY' };
  if (nowMs >= appt.meetAtMs) return { ok: false, code: 'LB_POSTPONE_AFTER_MEET' };
  const limit = postponeLimitMs(appt) as number;
  if (newMeetMs > limit) return { ok: false, code: 'LB_POSTPONE_TOO_FAR' };
  return { ok: true };
}

/**
 * R2 — 핀을 (lat, lng) 로 옮겨도 되는가. 시작 전이거나 핀이 그대로면 항상 된다.
 * distanceM = 시작하던 순간의 핀에서 새 핀까지(시작 전이면 null)
 */
export function canMovePlace(
  appt: EditRulesAppointment,
  lat: number,
  lng: number,
): { ok: true; distanceM: number | null } | { ok: false; code: MoveBlock; distanceM: number } {
  if (appt.startedAtMs === null) return { ok: true, distanceM: null };
  const origin = {
    lat: appt.startPlaceLat ?? appt.placeLat,
    lng: appt.startPlaceLng ?? appt.placeLng,
  };
  const distanceM = haversineMeters(origin, { lat, lng });
  if (lat === appt.placeLat && lng === appt.placeLng) return { ok: true, distanceM };
  if (distanceM > MOVE_AFTER_START_MAX_M) return { ok: false, code: 'LB_MOVE_TOO_FAR', distanceM };
  return { ok: true, distanceM };
}

/** R3 — 서버가 준 startableAtMs 로, [시작하기]까지 남은 ms(0 = 지금 시작 가능) */
export function startCooldownRemainingMs(appt: { startableAtMs: number | null }, nowMs: number): number {
  if (appt.startableAtMs === null) return 0;
  return Math.max(0, appt.startableAtMs - nowMs);
}

/** R3 — 중요 변경 시각에서 startableAtMs 를 만든다(서버와 같은 식: 아직 미래면 그 ms, 아니면 null) */
export function startableAtFrom(materialChangedAtMs: number | null, nowMs: number): number | null {
  if (materialChangedAtMs === null) return null;
  const at = materialChangedAtMs + START_COOLDOWN_MS;
  return at > nowMs ? at : null;
}

/** R4 — 시작 뒤에 들어왔는가(claimedAt > startedAt). 시작 전·주최자(claimedAt 없음)는 false */
export function isJoinedAfterStart(claimedAtMs: number | null, startedAtMs: number | null): boolean {
  return startedAtMs !== null && claimedAtMs !== null && claimedAtMs > startedAtMs;
}

/** R4 — 시작 후에도 내보낼 수 있는 참가자인가(시작 뒤에 들어온 사람만) */
export function canKickAfterStart(participant: { joinedAfterStart: boolean }): boolean {
  return participant.joinedAfterStart === true;
}

// ───────────────────────── 화면용 조각 ─────────────────────────

/**
 * R1 — 시작 후 [시간 미루기] 선택지. 지금 약속 시각에서 minutes 만큼 뒤인 것 중
 * '지금 + minLeadMs 보다 뒤'(서버 LB_TIME_IN_PAST 규칙)이고 '시작하던 순간의 약속 시각 + 180분' 이하인 것만.
 * 약속 시각이 이미 지났으면(LB_POSTPONE_AFTER_MEET) 빈 배열.
 */
export function postponeChoices(
  appt: Pick<EditRulesAppointment, 'startedAtMs' | 'startMeetAtMs' | 'meetAtMs'>,
  nowMs: number,
  minutesList: readonly number[],
  minLeadMs: number,
): { minutes: number; targetMs: number }[] {
  return minutesList
    .map((minutes) => ({ minutes, targetMs: appt.meetAtMs + minutes * MINUTE_MS }))
    .filter((c) => c.targetMs > nowMs + minLeadMs && canPostpone(appt, c.targetMs, nowMs).ok);
}

/** R1 — 지금 약속 시각에서 더 미룰 수 있는 남은 분(시작 전이면 null, 다 썼으면 0) */
export function postponeRemainingMinutes(
  appt: Pick<EditRulesAppointment, 'startedAtMs' | 'startMeetAtMs' | 'meetAtMs'>,
): number | null {
  const limit = postponeLimitMs(appt);
  if (limit === null) return null;
  return Math.max(0, Math.floor((limit - appt.meetAtMs) / MINUTE_MS));
}

/**
 * R3 — 쿨다운이 끝나는 시각이 약속 시각 이후인가. 그러면 약속 시각까지 시작할 수 없어(LB_START_CLOSED) 약속이 무효가 된다
 */
export function cooldownOutlastsMeet(appt: { startableAtMs: number | null; meetAtMs: number }): boolean {
  return appt.startableAtMs !== null && appt.startableAtMs >= appt.meetAtMs;
}

/** 남은 시간 '4분 12초' · '45초' · '5분' (올림, 최소 1초) */
export function formatWaitKo(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}초`;
  return s === 0 ? `${m}분` : `${m}분 ${s}초`;
}
