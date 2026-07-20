import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeFriendsState } from './friendsStore';

describe('normalizeFriendsState', () => {
  it('정상 데이터는 그대로 통과한다', () => {
    const state = normalizeFriendsState({
      friends: [{ id: 'f1', name: '철수', createdAt: '2026-01-01' }],
      entries: [
        {
          id: 'e1',
          friendId: 'f1',
          type: 'send',
          amount: 5000,
          memo: '택시비',
          createdAt: '2026-01-02',
        },
      ],
    });
    assert.equal(state.friends.length, 1);
    assert.equal(state.entries.length, 1);
    assert.equal(state.entries[0].type, 'send');
  });

  it('손상된 레코드는 그것만 건너뛴다 (전손 방지)', () => {
    const state = normalizeFriendsState({
      friends: [
        { id: 'f1', name: '철수' },
        { id: 42, name: '깨짐' },
        null,
        { id: 'f2', name: '영희' },
      ],
      entries: [
        { id: 'e1', friendId: 'f1', type: 'receive', amount: 1000 },
        { id: 'e2', friendId: 'f1', type: 'receive', amount: NaN },
        'garbage',
      ],
    });
    assert.deepEqual(
      state.friends.map((f) => f.id),
      ['f1', 'f2'],
    );
    assert.deepEqual(
      state.entries.map((e) => e.id),
      ['e1'],
    );
  });

  it('type이 이상하면 receive로 정규화, 형태가 아예 다르면 빈 상태', () => {
    const state = normalizeFriendsState({
      friends: [],
      entries: [{ id: 'e1', friendId: 'f1', type: 'weird', amount: 100 }],
    });
    assert.equal(state.entries[0].type, 'receive');
    assert.deepEqual(normalizeFriendsState(null), { friends: [], entries: [] });
    assert.deepEqual(normalizeFriendsState('nope'), { friends: [], entries: [] });
  });
});
