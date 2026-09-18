/**
 * 약속별 '마지막으로 본(동의한) version' 장부 (순수 모듈, React 없음 — node 테스트).
 *
 * - 참여 화면은 claimSlot 성공 직후 setSeenVersion(id, preview.version) 으로 먼저 심는다(동의한 조건이 기준).
 * - useLive 는 첫 getLive 응답에서 seedSeenVersion 으로 '없을 때만' 심는다 — 이미 심어져 있으면 덮지 않아
 *   참여 ~ 첫 getLive 사이에 주최자가 바꾼 조건이 unseenChanges 로 올라온다.
 * - 배너 [확인] 은 setSeenVersion(id, 지금 version).
 * live 모드의 AsyncStorage 반영은 useLive 가 맡는다(여기는 메모리만).
 */
import type { LbAppointmentChange } from './types';

const seen = new Map<string, number>();

export function getSeenVersion(appointmentId: string): number | null {
  return seen.get(appointmentId) ?? null;
}

/** 동의·확인한 version 을 기록한다(덮어쓴다) */
export function setSeenVersion(appointmentId: string, version: number): void {
  if (!appointmentId || !Number.isFinite(version)) return;
  seen.set(appointmentId, version);
}

/** 아직 기록이 없을 때만 심고, 기록된 version 을 돌려준다(첫 getLive · 캐시 복원용) */
export function seedSeenVersion(appointmentId: string, version: number): number {
  const cur = seen.get(appointmentId);
  if (cur !== undefined) return cur;
  seen.set(appointmentId, version);
  return version;
}

/** 마지막으로 본 version 뒤의 변경(오래된 순). 주최자 본인·기록 없음이면 [] */
export function unseenChanges(
  changes: readonly LbAppointmentChange[],
  seenVersion: number | null,
  isHost: boolean,
): LbAppointmentChange[] {
  if (isHost || seenVersion === null) return [];
  return changes.filter((c) => c.version > seenVersion);
}

/** 테스트용 */
export function resetSeenVersionsForTest(): void {
  seen.clear();
}
