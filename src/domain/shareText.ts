import { formatKrw } from './format';
import type { PersonId, RoundKind, Session, SettlementResult } from './types';

export const KIND_EMOJI: Record<RoundKind, string> = {
  cafe: '☕',
  meal: '🍚',
  drinks: '🍻',
  etc: '🧾',
};

export const KIND_LABEL: Record<RoundKind, string> = {
  cafe: '카페',
  meal: '밥',
  drinks: '술',
  etc: '기타',
};

/** 카톡 등에 붙여넣을 정산 요약 텍스트 */
export function buildShareText(session: Session, result: SettlementResult): string {
  const nameOf = (id: PersonId) => session.people.find((p) => p.id === id)?.name ?? '?';
  const lines: string[] = [];

  lines.push(`🧾 ${session.title} 정산`);
  lines.push('');
  for (const r of result.perRound) {
    lines.push(`${KIND_EMOJI[r.kind]} ${r.title} · ${formatKrw(r.total)} (${nameOf(r.payerId)} 결제)`);
  }
  lines.push(`합계 ${formatKrw(result.grandTotal)}`);

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
