/**
 * 약속 내기 — 주최자 조건 변경 배너 문구 (순수 함수).
 *
 * useLive.unseenChanges(마지막으로 본 version 뒤의 변경들)를 한 줄로 만든다:
 *   "주최자가 약속을 바꿨어요: 오후 7:30 → 오후 8:00 · 건 포인트 100P → 200P"
 * 여러 건이면 첫 before 와 마지막 after 를 비교한다(중간 값은 보여 주지 않는다).
 * React/RN 을 import 하지 않는다(node 테스트).
 */
import { formatKoreanDateTime, formatKoreanTime, isSameLocalDay } from '../domain/tzGuard';
import type { LbAppointmentChange, LbAppointmentSnapshot } from './types';

export const CHANGE_BANNER_PREFIX = '주최자가 약속을 바꿨어요';

/** 바뀐 항목만 "전 → 후" 조각으로. 아무것도 안 바뀌었으면 [] */
export function changeParts(before: LbAppointmentSnapshot, after: LbAppointmentSnapshot, tz: string): string[] {
  const out: string[] = [];
  if (before.meetAtMs !== after.meetAtMs || before.tz !== after.tz) {
    const sameDay = isSameLocalDay(before.meetAtMs, after.meetAtMs, tz);
    const fmt = (ms: number) => (sameDay ? formatKoreanTime(ms, tz) : formatKoreanDateTime(ms, tz));
    out.push(`${fmt(before.meetAtMs)} → ${fmt(after.meetAtMs)}`);
  }
  if (before.placeName !== after.placeName) out.push(`${before.placeName} → ${after.placeName}`);
  else if (before.placeLat !== after.placeLat || before.placeLng !== after.placeLng) out.push('핀 위치가 바뀌었어요');
  const b = before.policy;
  const a = after.policy;
  if (b.stake !== a.stake) out.push(`건 포인트 ${b.stake}P → ${a.stake}P`);
  if (b.unitMinutes !== a.unitMinutes || b.penaltyPerUnit !== a.penaltyPerUnit) {
    out.push(`지각 ${b.unitMinutes}분마다 ${b.penaltyPerUnit}P → ${a.unitMinutes}분마다 ${a.penaltyPerUnit}P`);
  }
  if (b.graceMinutes !== a.graceMinutes) out.push(`봐주는 시간 ${b.graceMinutes}분 → ${a.graceMinutes}분`);
  if (b.radiusM !== a.radiusM) out.push(`도착 인정 ${b.radiusM}m → ${a.radiusM}m`);
  return out;
}

/** 배너 한 줄. changes 가 비었거나 실질 변화가 없으면 '' */
export function describeChanges(changes: readonly LbAppointmentChange[], tz: string): string {
  if (changes.length === 0) return '';
  const first = changes[0].before;
  const last = changes[changes.length - 1].after;
  const parts = changeParts(first, last, tz);
  return parts.length === 0 ? '' : `${CHANGE_BANNER_PREFIX}: ${parts.join(' · ')}`;
}
