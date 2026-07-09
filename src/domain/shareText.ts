import { formatMoney } from './currency';
import { formatKrw } from './format';
import type { PersonId, RoundKind, Session, SettlementResult } from './types';

export const KIND_EMOJI: Record<RoundKind, string> = {
  cafe: '☕',
  meal: '🍚',
  drinks: '🍻',
  lodging: '🏨',
  transport: '🚕',
  activity: '🎡',
  shopping: '🛍️',
  etc: '🧾',
};

export const KIND_LABEL: Record<RoundKind, string> = {
  cafe: '카페',
  meal: '밥',
  drinks: '술',
  lodging: '숙소',
  transport: '교통',
  activity: '놀이',
  shopping: '쇼핑',
  etc: '기타',
};

/** 지출 종류 후보 (모임·여행 공통, 자주 쓰는 순) */
export const KINDS: RoundKind[] = [
  'meal',
  'cafe',
  'drinks',
  'lodging',
  'transport',
  'activity',
  'shopping',
  'etc',
];

/** 카톡 등에 붙여넣을 정산 요약 텍스트 */
export function buildShareText(session: Session, result: SettlementResult): string {
  const nameOf = (id: PersonId) => session.people.find((p) => p.id === id)?.name ?? '?';
  const lines: string[] = [];

  lines.push(`🧾 ${session.title} 정산`);
  lines.push('');
  for (const r of result.perRound) {
    if (r.missingFx) {
      lines.push(
        `${KIND_EMOJI[r.kind]} ${r.title} · ${formatMoney(r.currencyTotal, r.currency)} (환율 미입력 — 정산 제외)`,
      );
      continue;
    }
    const amount =
      r.currency === 'KRW'
        ? formatKrw(r.total)
        : `${formatMoney(r.currencyTotal, r.currency)} → ${formatKrw(r.total)}`;
    lines.push(`${KIND_EMOJI[r.kind]} ${r.title} · ${amount} (${nameOf(r.payerId)} 결제)`);
  }
  lines.push(`합계 ${formatKrw(result.grandTotal)}`);
  if (result.hasMissingFx) {
    lines.push('⚠️ 환율이 없는 지출은 합계·정산에서 빠져 있어요');
  }

  const involved = result.persons.filter((p) => p.consumed > 0 || p.paid > 0);
  if (involved.length > 0) {
    lines.push('');
    lines.push('👤 부담액');
    for (const p of involved) {
      lines.push(`${nameOf(p.personId)} ${formatKrw(p.consumed)}`);
    }
  }

  lines.push('');
  lines.push('💸 보낼 돈');
  if (result.transfers.length === 0) {
    lines.push('주고받을 돈이 없어요');
  } else {
    for (const t of result.transfers) {
      lines.push(`${nameOf(t.fromId)} → ${nameOf(t.toId)} ${formatKrw(t.amount)}`);
    }
  }

  return lines.join('\n');
}
