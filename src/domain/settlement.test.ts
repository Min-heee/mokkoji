import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeRoundShares, computeSettlement, computeTransfers, roundTotal } from './settlement';
import type { Round, Session, Transfer } from './types';

const A = 'p_a';
const B = 'p_b';
const C = 'p_c';
const D = 'p_d';

function makeSession(rounds: Round[], overrides?: Partial<Session>): Session {
  return {
    id: 's1',
    title: '테스트 모임',
    createdAt: '2026-07-07T00:00:00.000Z',
    people: [
      { id: A, name: '가' },
      { id: B, name: '나' },
      { id: C, name: '다' },
      { id: D, name: '라' },
    ],
    rounds,
    settings: { roundingUnit: 1 },
    ...overrides,
  };
}

function evenRound(partial: Partial<Round>): Round {
  return {
    id: 'r1',
    title: '1차',
    kind: 'meal',
    payerId: A,
    mode: 'even',
    participantIds: [A, B, C],
    totalAmount: 30000,
    items: [],
    exemptIds: [],
    ...partial,
  };
}

function itemizedRound(partial: Partial<Round>): Round {
  return {
    id: 'r1',
    title: '1차',
    kind: 'drinks',
    payerId: A,
    mode: 'itemized',
    participantIds: [A, B, C],
    totalAmount: 0,
    items: [],
    exemptIds: [],
    ...partial,
  };
}

function transferMap(transfers: Transfer[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const t of transfers) map[`${t.fromId}->${t.toId}`] = t.amount;
  return map;
}

describe('roundTotal', () => {
  it('even 모드는 totalAmount, itemized는 항목 합계', () => {
    assert.equal(roundTotal(evenRound({ totalAmount: 45000 })), 45000);
    assert.equal(
      roundTotal(
        itemizedRound({
          items: [
            { id: 'i1', name: '소주', unitPrice: 5000, quantity: 2, eaterIds: [A] },
            { id: 'i2', name: '안주', unitPrice: 30000, quantity: 1, eaterIds: [] },
          ],
        }),
      ),
      40000,
    );
  });
});

describe('computeRoundShares', () => {
  it('even: 참가자 균등 분배', () => {
    const shares = computeRoundShares(evenRound({ totalAmount: 30000 }));
    assert.equal(shares[A], 10000);
    assert.equal(shares[B], 10000);
    assert.equal(shares[C], 10000);
  });

  it('itemized: 항목별 eater 분배 — 술 안 마신 사람은 안주만 부담', () => {
    // 소주 2병(10,000)은 A,B만. 안주 30,000은 셋이 같이.
    const shares = computeRoundShares(
      itemizedRound({
        items: [
          { id: 'i1', name: '소주', unitPrice: 5000, quantity: 2, eaterIds: [A, B] },
          { id: 'i2', name: '안주', unitPrice: 30000, quantity: 1, eaterIds: [A, B, C] },
        ],
      }),
    );
    assert.equal(shares[A], 15000);
    assert.equal(shares[B], 15000);
    assert.equal(shares[C], 10000);
  });

  it('itemized: eaterIds가 비어 있으면 참가자 전원 분배', () => {
    const shares = computeRoundShares(
      itemizedRound({
        items: [{ id: 'i1', name: '전골', unitPrice: 30000, quantity: 1, eaterIds: [] }],
      }),
    );
    assert.equal(shares[A], 10000);
    assert.equal(shares[B], 10000);
    assert.equal(shares[C], 10000);
  });

  it('even + 면제자: 나머지가 나눠 부담', () => {
    const shares = computeRoundShares(
      evenRound({ participantIds: [A, B, C, D], totalAmount: 40000, exemptIds: [D] }),
    );
    assert.equal(shares[D], 0);
    assert.ok(Math.abs(shares[A] - 40000 / 3) < 1e-9);
    assert.ok(Math.abs(shares[A] + shares[B] + shares[C] - 40000) < 1e-9);
  });

  it('itemized + 면제자: 면제자 몫이 나머지 참가자에게 균등 재분배', () => {
    const shares = computeRoundShares(
      itemizedRound({
        participantIds: [A, B, C],
        exemptIds: [C],
        items: [
          { id: 'i1', name: '케이크', unitPrice: 30000, quantity: 1, eaterIds: [A, B, C] },
          { id: 'i2', name: '커피', unitPrice: 4000, quantity: 1, eaterIds: [C] },
        ],
      }),
    );
    // C 몫 = 10000 + 4000 = 14000 → A, B가 7000씩 추가 부담
    assert.equal(shares[C], 0);
    assert.equal(shares[A], 10000 + 7000);
    assert.equal(shares[B], 10000 + 7000);
  });

  it('전원 면제면 부담 0 (결제자 흡수)', () => {
    const shares = computeRoundShares(
      evenRound({ participantIds: [A, B], totalAmount: 20000, exemptIds: [A, B] }),
    );
    assert.equal(shares[A], 0);
    assert.equal(shares[B], 0);
  });
});

describe('computeSettlement', () => {
  it('단일 even 차수: 결제자에게 각자 자기 몫 송금', () => {
    const result = computeSettlement(makeSession([evenRound({})]));
    const map = transferMap(result.transfers);
    assert.equal(map[`${B}->${A}`], 10000);
    assert.equal(map[`${C}->${A}`], 10000);
    assert.equal(result.transfers.length, 2);
    assert.equal(result.grandTotal, 30000);
  });

  it('여러 차수·다른 결제자: 순채무만 오간다', () => {
    // 1차 카페 12,000 (A 결제, A,B,C 균등 → 각 4,000)
    // 2차 술 30,000 (B 결제, 소주 10,000은 A,B / 안주 20,000은 A,B,C)
    const session = makeSession([
      evenRound({ id: 'r1', title: '1차 카페', payerId: A, totalAmount: 12000 }),
      itemizedRound({
        id: 'r2',
        title: '2차 술',
        payerId: B,
        items: [
          { id: 'i1', name: '소주', unitPrice: 5000, quantity: 2, eaterIds: [A, B] },
          { id: 'i2', name: '안주', unitPrice: 20000, quantity: 1, eaterIds: [A, B, C] },
        ],
      }),
    ]);
    const result = computeSettlement(session);
    // 부담: A = 4000 + 5000 + 6666.67 = 15666.67, B = 동일, C = 4000 + 6666.67 = 10666.67
    // 결제: A = 12000, B = 30000
    // 순액: A = -3666.67, B = +14333.33, C = -10666.67
    const map = transferMap(result.transfers);
    assert.equal(result.transfers.length, 2);
    assert.equal(map[`${C}->${B}`], 10667);
    assert.equal(map[`${A}->${B}`], 3667);
  });

  it('결제만 하고 안 먹은 사람도 정산에 포함된다', () => {
    const session = makeSession([
      evenRound({ payerId: D, participantIds: [A, B, C], totalAmount: 30000 }),
    ]);
    const result = computeSettlement(session);
    const map = transferMap(result.transfers);
    assert.equal(map[`${A}->${D}`], 10000);
    assert.equal(map[`${B}->${D}`], 10000);
    assert.equal(map[`${C}->${D}`], 10000);
  });

  it('중간 합류: 참가한 차수만 부담', () => {
    const session = makeSession([
      evenRound({ id: 'r1', payerId: A, participantIds: [A, B], totalAmount: 20000 }),
      evenRound({ id: 'r2', payerId: A, participantIds: [A, B, C], totalAmount: 30000 }),
    ]);
    const result = computeSettlement(session);
    const map = transferMap(result.transfers);
    assert.equal(map[`${B}->${A}`], 20000);
    assert.equal(map[`${C}->${A}`], 10000);
  });
});

describe('computeTransfers 반올림', () => {
  it('100원 단위: 송금액이 전부 100의 배수, 자투리는 최대 채권자가 흡수', () => {
    const session = makeSession([evenRound({ totalAmount: 10000 })], undefined);
    session.settings = { roundingUnit: 100 };
    const result = computeSettlement(session);
    for (const t of result.transfers) {
      assert.equal(t.amount % 100, 0);
    }
    const map = transferMap(result.transfers);
    // 3,333.33 → 3,300씩. A는 6,666.67 받을 자격이지만 6,600만 받고 66.67원 흡수
    assert.equal(map[`${B}->${A}`], 3300);
    assert.equal(map[`${C}->${A}`], 3300);
  });

  it('잔액 합이 정확히 0으로 청산된다 (불변식)', () => {
    const session = makeSession([
      evenRound({ id: 'r1', payerId: A, totalAmount: 17777 }),
      itemizedRound({
        id: 'r2',
        payerId: B,
        participantIds: [A, B, C, D],
        items: [
          { id: 'i1', name: 'x', unitPrice: 3333, quantity: 3, eaterIds: [A, B, D] },
          { id: 'i2', name: 'y', unitPrice: 7777, quantity: 1, eaterIds: [] },
          { id: 'i3', name: 'z', unitPrice: 1234, quantity: 2, eaterIds: [C] },
        ],
      }),
      evenRound({ id: 'r3', payerId: C, participantIds: [B, C, D], totalAmount: 45001 }),
    ]);
    session.settings = { roundingUnit: 10 };
    const result = computeSettlement(session);

    const balance: Record<string, number> = {};
    for (const p of result.persons) {
      balance[p.personId] = Math.round(p.net / 10) * 10;
    }
    // 자투리 흡수 반영: 송금을 적용하면 전원 잔액 0
    const applied: Record<string, number> = Object.fromEntries(
      result.persons.map((p) => [p.personId, 0]),
    );
    for (const t of result.transfers) {
      assert.ok(t.amount > 0);
      assert.equal(t.amount % 10, 0);
      applied[t.fromId] -= t.amount;
      applied[t.toId] += t.amount;
    }
    // 받을 사람(양수 net)은 받은 만큼, 보낼 사람은 보낸 만큼: net 합계와 송금 합계가 일치
    const totalNet = result.persons.reduce((s, p) => s + p.net, 0);
    assert.ok(Math.abs(totalNet) < 1e-6);
    const totalMoved = result.transfers.reduce((s, t) => s + t.amount, 0);
    const totalPositive = Object.values(applied)
      .filter((v) => v > 0)
      .reduce((s, v) => s + v, 0);
    assert.equal(totalMoved, totalPositive);
    // 송금 횟수 최소성(상한): 인원 - 1 이하
    assert.ok(result.transfers.length <= result.persons.length - 1);
  });

  it('아무도 채무가 없으면 송금 없음', () => {
    const session = makeSession([
      evenRound({ id: 'r1', payerId: A, participantIds: [A], totalAmount: 5000 }),
    ]);
    const result = computeSettlement(session);
    assert.equal(result.transfers.length, 0);
  });

  it('결제자 흡수: 전원 열외 차수의 금액은 결제자 부담으로 잡혀 잔액 합이 0', () => {
    // R1: A가 30,000 결제, 셋이 균등. R2: B가 5,000 결제인데 전원 열외 → B가 흡수.
    const session = makeSession([
      evenRound({ id: 'r1', payerId: A, totalAmount: 30000 }),
      evenRound({ id: 'r2', payerId: B, totalAmount: 5000, exemptIds: [A, B, C] }),
    ]);
    const result = computeSettlement(session);
    const totalNet = result.persons.reduce((s, p) => s + p.net, 0);
    assert.ok(Math.abs(totalNet) < 1e-6);
    // B의 케이크 5,000이 A에게 전가되면 안 된다: A는 20,000 전액을 받는다
    const map = transferMap(result.transfers);
    assert.equal(map[`${B}->${A}`], 10000);
    assert.equal(map[`${C}->${A}`], 10000);
    assert.equal(result.transfers.length, 2);
  });

  it('결제자 흡수: 흡수액이 커도 주 결제자가 송금자로 뒤집히지 않는다', () => {
    // A net +200,000인데 B의 전원-열외 250,000이 자투리로 오인되면 A가 돈을 보내게 된다
    const session = makeSession([
      evenRound({ id: 'r1', payerId: A, totalAmount: 300000 }),
      evenRound({ id: 'r2', payerId: B, totalAmount: 250000, exemptIds: [A, B, C] }),
    ]);
    const result = computeSettlement(session);
    const map = transferMap(result.transfers);
    assert.equal(map[`${B}->${A}`], 100000);
    assert.equal(map[`${C}->${A}`], 100000);
    assert.equal(result.transfers.length, 2);
  });

  it('결제자 흡수: 참가자가 없는 even 차수도 결제자가 흡수한다', () => {
    const session = makeSession([
      evenRound({ id: 'r1', payerId: A, totalAmount: 30000 }),
      evenRound({ id: 'r2', payerId: B, participantIds: [], totalAmount: 5000 }),
    ]);
    const result = computeSettlement(session);
    const map = transferMap(result.transfers);
    assert.equal(map[`${B}->${A}`], 10000);
    assert.equal(map[`${C}->${A}`], 10000);
    assert.equal(result.transfers.length, 2);
  });

  it('결제자 흡수: itemized에서 먹은 사람 전원 열외로 pool이 버려져도 결제자가 흡수한다', () => {
    const session = makeSession([
      itemizedRound({
        payerId: A,
        participantIds: [A, B, C],
        exemptIds: [A, B, C],
        items: [
          { id: 'i1', name: '케이크', unitPrice: 30000, quantity: 1, eaterIds: [B] },
        ],
      }),
    ]);
    const result = computeSettlement(session);
    assert.equal(result.transfers.length, 0);
    const payer = result.persons.find((p) => p.personId === A);
    assert.ok(payer);
    assert.equal(payer.consumed, 30000);
    assert.equal(payer.net, 0);
  });

  it('전원 열외 단일 차수: 결제자 net 0 — 사람별 상세와 송금 목록이 모순되지 않는다', () => {
    const session = makeSession([
      evenRound({ payerId: A, totalAmount: 30000, exemptIds: [A, B, C] }),
    ]);
    const result = computeSettlement(session);
    assert.equal(result.transfers.length, 0);
    const payer = result.persons.find((p) => p.personId === A);
    assert.ok(payer);
    assert.equal(payer.paid, 30000);
    assert.equal(payer.consumed, 30000);
    assert.equal(payer.net, 0);
  });

  it('직접 호출: 순채무 단순화가 송금 횟수를 줄인다', () => {
    const transfers = computeTransfers(
      [
        { personId: A, paid: 30000, consumed: 10000, net: 20000 },
        { personId: B, paid: 30000, consumed: 40000, net: -10000 },
        { personId: C, paid: 10000, consumed: 20000, net: -10000 },
        { personId: D, paid: 10000, consumed: 10000, net: 0 },
      ],
      1,
    );
    assert.equal(transfers.length, 2);
    const map = transferMap(transfers);
    assert.equal(map[`${B}->${A}`], 10000);
    assert.equal(map[`${C}->${A}`], 10000);
  });
});
