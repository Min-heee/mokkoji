/**
 * 클라우드 백업·기기 동기화의 병합 규칙 (순수 로직).
 *
 * 총무 혼자 쓰는 데이터를 여러 기기에서 백업/복원하는 단일 사용자 시나리오라
 * 실시간 공동편집이 아니다. 그래서 세션 단위 "마지막 수정이 이긴다"(LWW)로
 * 충분하고, 삭제는 tombstone(삭제 표식)으로 추적해 오래된 기기의 부활을 막는다.
 *
 * 이 모듈은 백엔드·클라이언트가 같은 의미로 병합하도록 양쪽이 공유한다.
 */

export interface SyncRecord {
  id: string;
  /** 마지막 수정 시각 (ms) */
  updatedAt: number;
}

export interface SyncTombstone {
  id: string;
  /** 삭제 시각 (ms) */
  deletedAt: number;
}

export interface SyncState<T extends SyncRecord> {
  items: T[];
  tombstones: SyncTombstone[];
}

function maxBy<T>(a: T | undefined, b: T | undefined, key: (v: T) => number): T | undefined {
  if (!a) return b;
  if (!b) return a;
  return key(a) >= key(b) ? a : b;
}

/**
 * 두 동기화 상태(예: 로컬 vs 서버)를 병합한다.
 *
 * 각 id에 대해:
 * - 항목의 최신 updatedAt vs tombstone의 최신 deletedAt을 비교
 * - deletedAt >= updatedAt 이면 삭제가 이긴다 (동시각이면 삭제 우선 — 되살아남 방지)
 * - 그렇지 않으면 더 최근에 수정된 항목이 이긴다
 *
 * 삭제가 이긴 id는 tombstone만 남기고, 항목이 이긴 id는 낡은 tombstone을 버린다.
 * 병합은 교환·결합법칙을 만족해 어느 순서로 합쳐도 같은 결과가 된다.
 */
export function mergeSyncState<T extends SyncRecord>(
  a: SyncState<T>,
  b: SyncState<T>,
): SyncState<T> {
  const itemById = new Map<string, T>();
  for (const it of [...a.items, ...b.items]) {
    itemById.set(it.id, maxBy(itemById.get(it.id), it, (v) => v.updatedAt)!);
  }

  const tombById = new Map<string, SyncTombstone>();
  for (const t of [...a.tombstones, ...b.tombstones]) {
    tombById.set(t.id, maxBy(tombById.get(t.id), t, (v) => v.deletedAt)!);
  }

  const items: T[] = [];
  const tombstones: SyncTombstone[] = [];
  const ids = new Set<string>([...itemById.keys(), ...tombById.keys()]);

  for (const id of ids) {
    const item = itemById.get(id);
    const tomb = tombById.get(id);
    if (tomb && (!item || tomb.deletedAt >= item.updatedAt)) {
      tombstones.push(tomb);
    } else if (item) {
      items.push(item);
    }
  }

  return { items, tombstones };
}

/** id가 정해진 순서로 나오도록 정렬 (updatedAt 내림차순, 동률이면 id) — 결정적 비교/저장용 */
export function sortItems<T extends SyncRecord>(items: T[]): T[] {
  return [...items].sort((x, y) => y.updatedAt - x.updatedAt || (x.id < y.id ? -1 : 1));
}

/**
 * tombstone이 무한정 쌓이지 않도록 오래된 것을 정리한다.
 * horizon(ms)보다 오래된 삭제 표식은 버린다 — 그보다 오래 오프라인이던
 * 기기가 삭제된 항목을 되살릴 위험은 실사용상 무시할 수 있다.
 */
export function pruneTombstones(
  tombstones: SyncTombstone[],
  now: number,
  horizonMs: number,
): SyncTombstone[] {
  return tombstones.filter((t) => now - t.deletedAt < horizonMs);
}
