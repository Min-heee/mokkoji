import type {
  PersonId,
  PersonSettlement,
  Round,
  RoundSummary,
  Session,
  SettlementResult,
  Transfer,
} from './types';

import { BASE_CURRENCY } from './currency';

/** 차수 총액 (결제 통화 기준). even이면 입력된 totalAmount, itemized면 항목 합계 */
export function roundTotal(round: Round): number {
  if (round.mode === 'even') return round.totalAmount || 0;
  return round.items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);
}

/**
 * 결제 통화 → 기준통화(원) 환산 계수. null이면 환산 불가(환율 미입력).
 * - KRW 지출: 1
 * - 카드 실청구액이 있으면 그걸로 유효 환율을 유도 (수수료 포함, 총액이 정확히 청구액과 일치)
 * - 아니면 입력된 환율(fxRate)
 */
export function roundFxFactor(round: Round): number | null {
  if ((round.currency || BASE_CURRENCY) === BASE_CURRENCY) return 1;
  const total = roundTotal(round);
  if (round.billedBaseAmount != null && round.billedBaseAmount > 0) {
    return total > 0 ? round.billedBaseAmount / total : null;
  }
  if (round.fxRate != null && round.fxRate > 0) return round.fxRate;
  return null;
}

/** 차수 총액을 기준통화(원)로 환산. 환율 미입력이면 0 */
export function roundBaseTotal(round: Round): number {
  const factor = roundFxFactor(round);
  return factor == null ? 0 : roundTotal(round) * factor;
}

/**
 * 한 차수에서 사람별 부담액을 계산한다 (소수 허용).
 * - even: 면제자를 뺀 참가자끼리 균등 분배
 * - itemized: 항목별로 eaterIds끼리 균등 분배. eaterIds가 비어 있으면 참가자 전원 분배
 * - 면제자(exemptIds)의 몫은 면제가 아닌 참가자들이 균등하게 나눠 부담
 * - 부담할 사람이 아무도 없으면 그 금액은 결제자가 흡수한다 (부담액 0 처리)
 */
export function computeRoundShares(round: Round): Record<PersonId, number> {
  const shares: Record<PersonId, number> = {};
  const participants = round.participantIds;
  const exempt = new Set(round.exemptIds);
  const add = (id: PersonId, amount: number) => {
    shares[id] = (shares[id] ?? 0) + amount;
  };
  participants.forEach((id) => {
    shares[id] = 0;
  });

  if (round.mode === 'even') {
    const total = round.totalAmount || 0;
    const payersOfShare = participants.filter((id) => !exempt.has(id));
    if (total > 0 && payersOfShare.length > 0) {
      const each = total / payersOfShare.length;
      payersOfShare.forEach((id) => add(id, each));
    }
    applyRoundBet(round, shares);
    return shares;
  }

  for (const item of round.items) {
    const line = item.unitPrice * item.quantity;
    if (line <= 0) continue;
    // 내기에 걸린 항목은 진 사람이 전액 부담 (eaterIds 무시).
    // 진 사람이 참가자가 아니면(빠졌으면) 원래 방식으로 되돌린다.
    const betLoser =
      item.betLoserId && participants.includes(item.betLoserId)
        ? item.betLoserId
        : null;
    const eaters = betLoser
      ? [betLoser]
      : item.eaterIds.length > 0
        ? item.eaterIds
        : participants;
    if (eaters.length === 0) continue;
    const each = line / eaters.length;
    eaters.forEach((id) => add(id, each));
  }

  if (exempt.size > 0) {
    const beneficiaries = participants.filter((id) => !exempt.has(id));
    let pool = 0;
    for (const id of Object.keys(shares)) {
      if (exempt.has(id) && shares[id] > 0) {
        pool += shares[id];
        shares[id] = 0;
      }
    }
    if (pool > 0 && beneficiaries.length > 0) {
      const each = pool / beneficiaries.length;
      beneficiaries.forEach((id) => add(id, each));
    }
  }

  applyRoundBet(round, shares);

  return shares;
}

/**
 * 차수 내기를 부담액에 반영한다.
 * 몰빵 금액 A는 진 사람이 전부 내고, 나머지 (총액 - A)는 이미 계산된
 * 부담 비율 그대로 나눈다. 즉 기존 부담액을 (총액-A)/총액로 축소한 뒤
 * 진 사람에게 A를 더한다. A=총액이면 진 사람이 전액을 쓴다.
 */
function applyRoundBet(round: Round, shares: Record<PersonId, number>): void {
  const bet = round.bet;
  if (!bet) return;
  const total = roundTotal(round);
  if (!Number.isFinite(total) || total <= 0) return;
  if (!round.participantIds.includes(bet.loserId)) return;
  if (!Number.isFinite(bet.amount)) return;
  const amount = Math.max(0, Math.min(bet.amount, total));
  if (amount <= 0) return;

  // 부담할 사람이 아무도 없어 사전 부담액 합이 0이면 (전원 면제 등)
  // 나눌 나머지의 담당자가 없어 내기를 반영할 수 없다. 결제자 흡수 계약에
  // 맡기고 내기를 건너뛴다 (면제자를 강제로 물리지 않는다).
  const preBetSum = Object.values(shares).reduce((sum, v) => sum + v, 0);
  if (preBetSum <= 0) return;

  const scale = (total - amount) / total;
  for (const id of Object.keys(shares)) {
    shares[id] *= scale;
  }
  shares[bet.loserId] = (shares[bet.loserId] ?? 0) + amount;
}

/**
 * 순채무(net = paid - consumed)를 반올림 단위로 정리한 뒤
 * 송금 횟수가 최소(≤ 인원-1)가 되도록 채무를 단순화한다.
 *
 * 반올림으로 생기는 자투리는 가장 많이 받을 사람(주 결제자)이 흡수한다.
 * 결과 송금액은 전부 unit의 배수이고, 모든 사람의 잔액이 정확히 0이 된다.
 */
export function computeTransfers(
  persons: PersonSettlement[],
  roundingUnit: number,
): Transfer[] {
  const unit = roundingUnit > 0 ? roundingUnit : 1;
  const rounded = persons.map((p) => ({
    id: p.personId,
    net: Math.round(p.net / unit) * unit,
  }));

  const residual = rounded.reduce((sum, r) => sum + r.net, 0);
  if (residual !== 0 && rounded.length > 0) {
    let target = rounded[0];
    for (const r of rounded) {
      if (r.net > target.net) target = r;
    }
    target.net -= residual;
  }

  const creditors = rounded
    .filter((r) => r.net > 0)
    .map((r) => ({ id: r.id, remaining: r.net }))
    .sort((a, b) => b.remaining - a.remaining);
  const debtors = rounded
    .filter((r) => r.net < 0)
    .map((r) => ({ id: r.id, owe: -r.net }))
    .sort((a, b) => b.owe - a.owe);

  const transfers: Transfer[] = [];
  let ci = 0;
  for (const debtor of debtors) {
    let owe = debtor.owe;
    while (owe > 0 && ci < creditors.length) {
      const creditor = creditors[ci];
      const amount = Math.min(owe, creditor.remaining);
      if (amount > 0) {
        transfers.push({ fromId: debtor.id, toId: creditor.id, amount });
        owe -= amount;
        creditor.remaining -= amount;
      }
      if (creditor.remaining === 0) ci += 1;
    }
  }
  return transfers;
}

export function computeSettlement(session: Session): SettlementResult {
  const paid: Record<PersonId, number> = {};
  const consumed: Record<PersonId, number> = {};
  session.people.forEach((p) => {
    paid[p.id] = 0;
    consumed[p.id] = 0;
  });

  const perRound: RoundSummary[] = session.rounds.map((round) => {
    const currencyShares = computeRoundShares(round);
    const currencyTotal = roundTotal(round);
    const factor = roundFxFactor(round);
    const missingFx = factor == null;

    // 환율 미입력 지출은 결제·부담 모두에서 제외해 잔액 합계 0을 유지한다.
    // (UI가 hasMissingFx로 경고를 띄운다)
    const fx = factor ?? 0;
    const total = currencyTotal * fx;

    // 사람별 부담액을 기준통화로 환산
    const shares: Record<PersonId, number> = {};
    let shared = 0;
    for (const [id, amount] of Object.entries(currencyShares)) {
      const base = amount * fx;
      shares[id] = base;
      consumed[id] = (consumed[id] ?? 0) + base;
      shared += base;
    }

    paid[round.payerId] = (paid[round.payerId] ?? 0) + total;

    // 부담할 사람이 아무도 없어 분배되지 못한 금액은 결제자가 흡수한다
    // (computeRoundShares 계약). 결제자 부담으로 잡아 잔액 합계를 0으로 유지해
    // computeTransfers의 자투리 로직이 순수 반올림 오차만 다루게 한다.
    const unshared = total - shared;
    if (unshared > 1e-6) {
      consumed[round.payerId] = (consumed[round.payerId] ?? 0) + unshared;
    }
    return {
      roundId: round.id,
      title: round.title,
      kind: round.kind,
      payerId: round.payerId,
      total,
      currency: round.currency || 'KRW',
      currencyTotal,
      missingFx,
      shares,
    };
  });

  // 세션 people에서 빠졌더라도 결제/부담 기록이 있는 id는 정산에 포함해
  // 잔액 합계가 항상 0이 되도록 유지한다.
  const ids = new Set<PersonId>([
    ...session.people.map((p) => p.id),
    ...Object.keys(paid),
    ...Object.keys(consumed),
  ]);

  const persons: PersonSettlement[] = [...ids].map((id) => {
    const p = paid[id] ?? 0;
    const c = consumed[id] ?? 0;
    return { personId: id, paid: p, consumed: c, net: p - c };
  });

  const transfers = computeTransfers(persons, session.settings.roundingUnit);
  const grandTotal = perRound.reduce((sum, r) => sum + r.total, 0);
  const hasMissingFx = perRound.some((r) => r.missingFx);

  return { perRound, persons, transfers, grandTotal, hasMissingFx };
}
