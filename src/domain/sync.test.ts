import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mergeSyncState,
  pruneTombstones,
  sortItems,
  type SyncState,
} from './sync';

interface Doc {
  id: string;
  updatedAt: number;
  title: string;
}

function state(
  items: Doc[],
  tombstones: { id: string; deletedAt: number }[] = [],
): SyncState<Doc> {
  return { items, tombstones };
}

const doc = (id: string, updatedAt: number, title = id): Doc => ({ id, updatedAt, title });

function ids(items: Doc[]): string[] {
  return items.map((i) => i.id).sort();
}

describe('mergeSyncState', () => {
  it('겹치지 않는 항목은 모두 합쳐진다', () => {
    const merged = mergeSyncState(state([doc('a', 1)]), state([doc('b', 2)]));
    assert.deepEqual(ids(merged.items), ['a', 'b']);
  });

  it('같은 id는 더 최근 수정이 이긴다', () => {
    const merged = mergeSyncState(
      state([doc('a', 1, 'old')]),
      state([doc('a', 5, 'new')]),
    );
    assert.equal(merged.items.length, 1);
    assert.equal(merged.items[0].title, 'new');
  });

  it('삭제(tombstone)가 더 최근이면 항목이 사라진다', () => {
    const merged = mergeSyncState(
      state([doc('a', 3)]),
      state([], [{ id: 'a', deletedAt: 5 }]),
    );
    assert.equal(merged.items.length, 0);
    assert.deepEqual(merged.tombstones, [{ id: 'a', deletedAt: 5 }]);
  });

  it('삭제 후 더 최근에 다시 수정되면 항목이 되살아나고 tombstone은 버려진다', () => {
    const merged = mergeSyncState(
      state([], [{ id: 'a', deletedAt: 3 }]),
      state([doc('a', 5, 'revived')]),
    );
    assert.equal(merged.items.length, 1);
    assert.equal(merged.items[0].title, 'revived');
    assert.equal(merged.tombstones.length, 0);
  });

  it('수정과 삭제가 동시각이면 삭제가 이긴다 (되살아남 방지)', () => {
    const merged = mergeSyncState(
      state([doc('a', 5)]),
      state([], [{ id: 'a', deletedAt: 5 }]),
    );
    assert.equal(merged.items.length, 0);
    assert.equal(merged.tombstones.length, 1);
  });

  it('오래된 기기가 삭제된 항목을 되살리지 못한다', () => {
    // 서버: a 삭제됨(deletedAt 10). 오프라인이던 기기: a를 updatedAt 4에 들고 있음
    const server = state([], [{ id: 'a', deletedAt: 10 }]);
    const staleDevice = state([doc('a', 4)]);
    const merged = mergeSyncState(server, staleDevice);
    assert.equal(merged.items.length, 0);
  });

  it('교환법칙: 합치는 순서가 결과를 바꾸지 않는다', () => {
    const x = state(
      [doc('a', 5, 'A5'), doc('b', 2)],
      [{ id: 'c', deletedAt: 9 }],
    );
    const y = state(
      [doc('a', 3, 'A3'), doc('c', 4)],
      [{ id: 'b', deletedAt: 1 }],
    );
    const ab = mergeSyncState(x, y);
    const ba = mergeSyncState(y, x);
    assert.deepEqual(ids(ab.items), ids(ba.items));
    assert.deepEqual(
      ab.tombstones.map((t) => t.id).sort(),
      ba.tombstones.map((t) => t.id).sort(),
    );
    // a는 최신(5)이 이기고, b는 항목(2) > 삭제(1)라 살아있고, c는 삭제(9) > 항목(4)라 죽는다
    assert.deepEqual(ids(ab.items), ['a', 'b']);
    assert.equal(ab.items.find((i) => i.id === 'a')?.title, 'A5');
    assert.deepEqual(
      ab.tombstones.map((t) => t.id),
      ['c'],
    );
  });

  it('멱등성: 이미 병합된 상태를 다시 병합해도 그대로다', () => {
    const merged = mergeSyncState(
      state([doc('a', 5)], [{ id: 'b', deletedAt: 3 }]),
      state([doc('a', 5)], [{ id: 'b', deletedAt: 3 }]),
    );
    assert.deepEqual(ids(merged.items), ['a']);
    assert.deepEqual(merged.tombstones, [{ id: 'b', deletedAt: 3 }]);
  });
});

describe('sortItems', () => {
  it('updatedAt 내림차순, 동률이면 id 오름차순', () => {
    const sorted = sortItems([doc('b', 1), doc('a', 5), doc('c', 5)]);
    assert.deepEqual(
      sorted.map((i) => i.id),
      ['a', 'c', 'b'],
    );
  });
});

describe('pruneTombstones', () => {
  it('horizon보다 오래된 삭제 표식만 버린다', () => {
    const now = 1000;
    const kept = pruneTombstones(
      [
        { id: 'old', deletedAt: 100 },
        { id: 'fresh', deletedAt: 900 },
      ],
      now,
      500,
    );
    assert.deepEqual(
      kept.map((t) => t.id),
      ['fresh'],
    );
  });
});
