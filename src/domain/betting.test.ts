import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  loserByHighestScore,
  mulberry32,
  pickRandomLoser,
  randomBombDurationMs,
  randomReactionDelayMs,
  randomTargetSeconds,
} from './betting';

describe('pickRandomLoser', () => {
  it('참가자 중 하나를 돌려준다', () => {
    const ids = ['a', 'b', 'c'];
    const loser = pickRandomLoser(ids, mulberry32(1));
    assert.ok(loser !== null && ids.includes(loser));
  });

  it('한 명이면 그 사람이 당첨', () => {
    assert.equal(pickRandomLoser(['solo'], mulberry32(9)), 'solo');
  });

  it('비어 있으면 null', () => {
    assert.equal(pickRandomLoser([], mulberry32(9)), null);
  });

  it('rng이 1에 가까워도 범위를 넘지 않는다', () => {
    // 항상 0.9999를 주는 rng — 인덱스가 배열을 벗어나면 안 됨
    const loser = pickRandomLoser(['a', 'b', 'c'], () => 0.999999);
    assert.equal(loser, 'c');
  });

  it('시드가 같으면 결과도 같다 (재현 가능)', () => {
    const a = pickRandomLoser(['a', 'b', 'c', 'd'], mulberry32(42));
    const b = pickRandomLoser(['a', 'b', 'c', 'd'], mulberry32(42));
    assert.equal(a, b);
  });

  it('대체로 고르게 뽑힌다 (한쪽으로 안 쏠림)', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
    const rng = mulberry32(7);
    const N = 4000;
    for (let i = 0; i < N; i += 1) {
      const loser = pickRandomLoser(ids, rng)!;
      counts[loser] += 1;
    }
    // 기대값 1000, 각 25%. ±40% 안이면 균등으로 본다 (느슨한 상한)
    for (const id of ids) {
      assert.ok(
        counts[id] > (N / ids.length) * 0.6 && counts[id] < (N / ids.length) * 1.4,
        `${id} 편향: ${counts[id]}`,
      );
    }
  });
});

describe('randomBombDurationMs', () => {
  it('지정 범위 안에서만 나온다', () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 200; i += 1) {
      const d = randomBombDurationMs(rng, 3000, 12000);
      assert.ok(d >= 3000 && d < 12000, `범위 밖: ${d}`);
    }
  });

  it('min/max가 뒤집혀 들어와도 안전하다', () => {
    const d = randomBombDurationMs(() => 0.5, 12000, 3000);
    assert.ok(d >= 3000 && d < 12000);
  });
});

describe('randomReactionDelayMs', () => {
  it('지정 범위 안에서만 나온다', () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 200; i += 1) {
      const d = randomReactionDelayMs(rng, 1500, 4500);
      assert.ok(d >= 1500 && d < 4500, `범위 밖: ${d}`);
    }
  });
});

describe('loserByHighestScore', () => {
  it('점수가 가장 큰(나쁜) 사람이 당첨', () => {
    assert.equal(
      loserByHighestScore([
        { id: 'a', score: 120 },
        { id: 'b', score: 800 },
        { id: 'c', score: 300 },
      ]),
      'b',
    );
  });

  it('동점이면 먼저 나온 사람', () => {
    assert.equal(
      loserByHighestScore([
        { id: 'a', score: 500 },
        { id: 'b', score: 500 },
      ]),
      'a',
    );
  });

  it('비어 있으면 null', () => {
    assert.equal(loserByHighestScore([]), null);
  });
});

describe('randomTargetSeconds', () => {
  it('1~10 정수 범위(경계 포함)', () => {
    const rng = mulberry32(11);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) {
      const t = randomTargetSeconds(rng, 1, 10);
      assert.ok(Number.isInteger(t) && t >= 1 && t <= 10, `범위 밖: ${t}`);
      seen.add(t);
    }
    // 경계값 1과 10이 모두 나올 수 있어야 한다
    assert.ok(seen.has(1) && seen.has(10));
  });
});
