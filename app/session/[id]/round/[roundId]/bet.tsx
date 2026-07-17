import { useLocalSearchParams, useRouter } from 'expo-router';

import { roundTotal } from '@/domain/settlement';
import type { PersonId } from '@/domain/types';
import { BetFlow } from '@/features/betFlow';
import { useSessions } from '@/state/SessionsContext';
import { EmptyState, Screen } from '@/ui/components';

export default function BetScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; roundId: string; itemId?: string }>();
  const sessionId = typeof params.id === 'string' ? params.id : '';
  const roundId = typeof params.roundId === 'string' ? params.roundId : '';
  const itemId = typeof params.itemId === 'string' ? params.itemId : '';
  const { getSession, updateSession } = useSessions();

  const session = sessionId ? getSession(sessionId) : undefined;
  const round = session?.rounds.find((r) => r.id === roundId);
  const item = itemId ? round?.items.find((it) => it.id === itemId) : undefined;

  if (!session || !round || (itemId && !item)) {
    return (
      <Screen scroll={false}>
        <EmptyState title="내기를 열 수 없어요" hint="차수로 돌아가 주세요." />
      </Screen>
    );
  }

  const nameOf = (pid: PersonId) =>
    session.people.find((p) => p.id === pid)?.name ?? '?';
  const currency = round.currency || 'KRW';

  if (item) {
    return (
      <BetFlow
        title={`${item.name || '항목'} 내기`}
        players={item.eaterIds.length > 0 ? item.eaterIds : round.participantIds}
        nameOf={nameOf}
        currency={currency}
        totalAmount={item.unitPrice * item.quantity}
        editable={false}
        emptyHint="이 항목을 '먹은 사람'이 2명 이상이어야 해요."
        onApply={(loserId) => {
          updateSession(sessionId, (s) => ({
            ...s,
            rounds: s.rounds.map((r) =>
              r.id === roundId
                ? {
                    ...r,
                    items: r.items.map((it) =>
                      it.id === itemId ? { ...it, betLoserId: loserId } : it,
                    ),
                  }
                : r,
            ),
          }));
          router.back();
        }}
      />
    );
  }

  return (
    <BetFlow
      title={`${round.title} 내기`}
      players={round.participantIds}
      nameOf={nameOf}
      currency={currency}
      totalAmount={roundTotal(round)}
      editable
      emptyHint="차수에서 '함께한 사람'을 먼저 골라주세요."
      onApply={(loserId, amount) => {
        updateSession(sessionId, (s) => ({
          ...s,
          rounds: s.rounds.map((r) =>
            r.id === roundId ? { ...r, bet: { loserId, amount } } : r,
          ),
        }));
        router.back();
      }}
    />
  );
}
