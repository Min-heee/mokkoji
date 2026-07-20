import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { entriesByFriend, friendBalance, type LedgerEntry } from './friends';

const entry = (
  id: string,
  friendId: string,
  type: 'send' | 'receive',
  amount: number,
): LedgerEntry => ({
  id,
  friendId,
  type,
  amount,
  memo: '',
  createdAt: '2026-07-18T00:00:00.000Z',
});

describe('friendBalance', () => {
  it('보낼 돈·받을 돈을 합산하고 순액을 계산한다', () => {
    const b = friendBalance([
      entry('e1', 'f1', 'send', 30000),
      entry('e2', 'f1', 'receive', 50000),
      entry('e3', 'f1', 'send', 5000),
    ]);
    assert.equal(b.send, 35000);
    assert.equal(b.receive, 50000);
    assert.equal(b.net, 15000);
  });

  it('비어 있으면 전부 0', () => {
    assert.deepEqual(friendBalance([]), { send: 0, receive: 0, net: 0 });
  });

  it('0·음수·NaN 금액은 무시한다', () => {
    const b = friendBalance([
      entry('e1', 'f1', 'send', 0),
      entry('e2', 'f1', 'receive', -100),
      entry('e3', 'f1', 'receive', NaN),
      entry('e4', 'f1', 'receive', 7000),
    ]);
    assert.deepEqual(b, { send: 0, receive: 7000, net: 7000 });
  });
});

describe('entriesByFriend', () => {
  it('friendId별로 묶는다', () => {
    const grouped = entriesByFriend([
      entry('e1', 'f1', 'send', 1000),
      entry('e2', 'f2', 'receive', 2000),
      entry('e3', 'f1', 'receive', 3000),
    ]);
    assert.deepEqual(Object.keys(grouped).sort(), ['f1', 'f2']);
    assert.equal(grouped.f1.length, 2);
    assert.equal(grouped.f2.length, 1);
  });
});
