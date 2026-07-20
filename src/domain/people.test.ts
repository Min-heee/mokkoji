import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addFriendPerson, addNamedPerson } from './people';
import type { Person, Session } from './types';

const makeSession = (people: Person[]): Session => ({
  id: 's1',
  title: '테스트 모임',
  createdAt: '2026-07-18T00:00:00.000Z',
  people,
  rounds: [],
  settings: { roundingUnit: 100, baseCurrency: 'KRW' },
  lastFxRates: {},
});

describe('addFriendPerson', () => {
  it('친구를 friendId 연결과 함께 참가자로 추가한다', () => {
    const next = addFriendPerson(makeSession([]), { id: 'f1', name: '민수' });
    assert.equal(next.people.length, 1);
    assert.equal(next.people[0].name, '민수');
    assert.equal(next.people[0].friendId, 'f1');
  });

  it('더블탭 회귀: 같은 친구로 두 번 적용돼도 한 명만 추가된다', () => {
    // 더블탭 시 두 press 핸들러의 업데이터가 최신 상태에 연달아 적용되는
    // 상황을 그대로 재현: 가드가 업데이터 안에 있어야 두 번째가 무효가 된다
    const friend = { id: 'f1', name: '민수' };
    const once = addFriendPerson(makeSession([]), friend);
    const twice = addFriendPerson(once, friend);
    assert.equal(twice.people.length, 1);
    assert.equal(twice, once); // 변경 없으면 같은 객체 반환 (불필요한 리렌더 방지)
  });

  it('이름이 같아도 friendId가 다르면 다른 사람이므로 추가한다', () => {
    const withFirst = addFriendPerson(makeSession([]), { id: 'f1', name: '민수' });
    const withBoth = addFriendPerson(withFirst, { id: 'f2', name: '민수' });
    assert.equal(withBoth.people.length, 2);
    assert.deepEqual(
      withBoth.people.map((p) => p.friendId),
      ['f1', 'f2'],
    );
  });

  it('직접 입력한 동명 참가자가 있어도 친구 추가를 막지 않는다', () => {
    const session = makeSession([{ id: 'p1', name: '민수' }]);
    const next = addFriendPerson(session, { id: 'f1', name: '민수' });
    assert.equal(next.people.length, 2);
  });
});

describe('addNamedPerson', () => {
  it('이름을 다듬어(trim) 참가자로 추가한다', () => {
    const next = addNamedPerson(makeSession([]), '  지수  ');
    assert.equal(next.people.length, 1);
    assert.equal(next.people[0].name, '지수');
    assert.equal(next.people[0].friendId, undefined);
  });

  it('이중 submit 회귀: 같은 이름으로 두 번 적용돼도 한 명만 추가된다', () => {
    const once = addNamedPerson(makeSession([]), '지수');
    const twice = addNamedPerson(once, '지수');
    assert.equal(twice.people.length, 1);
    assert.equal(twice, once);
  });

  it('빈 이름·공백만인 이름은 무시한다', () => {
    const session = makeSession([]);
    assert.equal(addNamedPerson(session, ''), session);
    assert.equal(addNamedPerson(session, '   '), session);
  });

  it('이미 같은 이름의 참가자가 있으면 세션을 그대로 반환한다', () => {
    const session = makeSession([{ id: 'p1', name: '민수', friendId: 'f1' }]);
    assert.equal(addNamedPerson(session, '민수'), session);
  });
});
