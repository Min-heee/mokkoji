import { useLocalSearchParams, useRouter } from 'expo-router';

import { roundBaseTotal } from '@/domain/settlement';
import { BetFlow } from '@/features/betFlow';
import { useSessions } from '@/state/SessionsContext';
import { EmptyState, Screen } from '@/ui/components';

export default function SessionBetScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const sessionId = typeof params.id === 'string' ? params.id : '';
  const { getSession, updateSession } = useSessions();

  const session = sessionId ? getSession(sessionId) : undefined;

  if (!session) {
    return (
      <Screen scroll={false}>
        <EmptyState title="모임을 찾을 수 없어요" />
      </Screen>
    );
  }

  const grandTotal = session.rounds.reduce((s, r) => s + roundBaseTotal(r), 0);

  return (
    <BetFlow
      title={`${session.title} 내기`}
      players={session.people.map((p) => p.id)}
      nameOf={(id) => session.people.find((p) => p.id === id)?.name ?? '?'}
      currency="KRW"
      totalAmount={grandTotal}
      editable
      emptyHint="참가자가 2명 이상 있어야 해요."
      onApply={(loserId, amount) => {
        updateSession(session.id, (s) => ({ ...s, bet: { loserId, amount } }));
        router.back();
      }}
    />
  );
}
