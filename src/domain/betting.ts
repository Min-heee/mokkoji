/**
 * 내기 게임의 순수 로직 (연출 UI와 분리).
 * 게임은 "참가자 중 누가 당첨(꼴등)인지"만 정하고, 그 결과가 정산으로 흘러간다.
 * 차수 전체든 특정 항목이든 붙일 수 있고, 어떤 게임이든 이 로직을 공유한다.
 */

export type BetGameId = 'draw' | 'bomb' | 'roulette' | 'timer' | 'reaction';

export interface BetGameInfo {
  id: BetGameId;
  label: string;
  desc: string;
}

export const BET_GAMES: BetGameInfo[] = [
  {
    id: 'roulette',
    label: '룰렛',
    desc: '돌림판이 돌다 멈춘 사람이 당첨',
  },
  {
    id: 'draw',
    label: '제비뽑기',
    desc: '카드를 뒤집어 꽝을 뽑은 사람이 당첨',
  },
  {
    id: 'bomb',
    label: '폭탄 돌리기',
    desc: '돌리다 터질 때 들고 있던 사람이 당첨',
  },
  {
    id: 'timer',
    label: '10초 맞히기',
    desc: '10초를 가장 못 맞춘 사람이 당첨',
  },
  {
    id: 'reaction',
    label: '반응 속도',
    desc: '신호에 가장 느리게 누른 사람이 당첨',
  },
];

/** 결정적 테스트·재현을 위한 시드 RNG (mulberry32). [0,1) 반환 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 참가자 중 한 명을 균등 확률로 뽑는다. 비어 있으면 null */
export function pickRandomLoser(
  ids: string[],
  rng: () => number = Math.random,
): string | null {
  if (ids.length === 0) return null;
  const i = Math.floor(rng() * ids.length);
  return ids[Math.min(i, ids.length - 1)];
}

/** 폭탄이 터지기까지의 랜덤 시간(ms). 언제 터질지 몰라야 재밌다 */
export function randomBombDurationMs(
  rng: () => number = Math.random,
  minMs = 3000,
  maxMs = 12000,
): number {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  return Math.floor(lo + rng() * (hi - lo));
}

/** 반응속도 게임에서 '지금!' 신호가 뜨기까지의 랜덤 대기 시간(ms) */
export function randomReactionDelayMs(
  rng: () => number = Math.random,
  minMs = 1500,
  maxMs = 4500,
): number {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  return Math.floor(lo + rng() * (hi - lo));
}

/** 시간 맞히기 게임의 목표 초(정수). 매 판 달라 외우거나 연습할 수 없다 */
export function randomTargetSeconds(
  rng: () => number = Math.random,
  min = 1,
  max = 10,
): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * 여러 판(각자 한 번씩)을 돌린 뒤 점수가 가장 나쁜(큰) 사람이 당첨.
 * 10초 맞히기(오차)·반응속도(느린 ms) 등 턴제 게임의 공통 판정.
 * 동점이면 먼저 나온 사람. 비어 있으면 null.
 */
export function loserByHighestScore(
  scores: { id: string; score: number }[],
): string | null {
  if (scores.length === 0) return null;
  let worst = scores[0];
  for (const s of scores) {
    if (s.score > worst.score) worst = s;
  }
  return worst.id;
}
