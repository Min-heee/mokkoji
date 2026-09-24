import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkFriendName, entriesByFriend, friendBalance, FRIEND_NAME_INPUT_MAX, FRIEND_NAME_MAX, type LedgerEntry } from './friends';

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

describe('checkFriendName', () => {
  it('앞뒤 공백을 떼고 통과시킨다', () => {
    assert.deepEqual(checkFriendName('  민수 '), { ok: true, name: '민수' });
  });
  it('빈 이름·공백만은 empty', () => {
    assert.deepEqual(checkFriendName(''), { ok: false, reason: 'empty' });
    assert.deepEqual(checkFriendName('   '), { ok: false, reason: 'empty' });
  });
  it('최대 글자 수까지 통과, 넘으면 tooLong', () => {
    const max = '가'.repeat(FRIEND_NAME_MAX);
    assert.deepEqual(checkFriendName(max), { ok: true, name: max });
    assert.deepEqual(checkFriendName(max + '나'), { ok: false, reason: 'tooLong' });
  });
  it('글자 수는 코드 포인트로 센다(서로게이트 쌍 = 1자)', () => {
    const astral = '\u{20BB7}'.repeat(FRIEND_NAME_MAX);
    assert.equal(checkFriendName(astral).ok, true);
  });
  it('내부 공백은 그대로 둔다', () => {
    assert.deepEqual(checkFriendName('김 민수'), { ok: true, name: '김 민수' });
  });
});

describe('FRIEND_NAME_INPUT_MAX(입력칸 maxLength, UTF-16 단위)', () => {
  it('통과하는 이름은 입력칸에서 잘리지 않는다 — 이모지·확장 한자 20자(40 단위) + 앞뒤 공백', () => {
    const astral = '\u{1F600}'.repeat(FRIEND_NAME_MAX); // 이모지 20개
    assert.equal(astral.length, FRIEND_NAME_MAX * 2);
    assert.equal(checkFriendName(astral).ok, true);
    assert.ok(astral.length <= FRIEND_NAME_INPUT_MAX);
    const cjkExt = '\u{20000}'.repeat(FRIEND_NAME_MAX); // 확장 한자 20자
    assert.equal(checkFriendName(cjkExt).ok, true);
    assert.ok(('  ' + cjkExt + '  ').length <= FRIEND_NAME_INPUT_MAX);
  });
  it("21자는 입력칸에 들어가서 '20자까지' 안내(tooLong)에 닿는다", () => {
    const over = '가'.repeat(FRIEND_NAME_MAX + 1);
    assert.ok(over.length <= FRIEND_NAME_INPUT_MAX);
    assert.deepEqual(checkFriendName(over), { ok: false, reason: 'tooLong' });
    const overEmoji = '\u{1F600}'.repeat(FRIEND_NAME_MAX + 1);
    assert.ok(overEmoji.length <= FRIEND_NAME_INPUT_MAX);
    assert.deepEqual(checkFriendName(overEmoji), { ok: false, reason: 'tooLong' });
  });
});
