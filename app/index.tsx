import { useRouter } from 'expo-router';
import React from 'react';
import { Alert, StyleSheet, Text } from 'react-native';

import { formatKrw } from '@/domain/format';
import { roundBaseTotal } from '@/domain/settlement';
import type { Session } from '@/domain/types';
import { useSessions } from '@/state/SessionsContext';
import {
  Card,
  EmptyState,
  LoadingState,
  PrimaryButton,
  Screen,
} from '@/ui/components';
import { colors, fontSize } from '@/ui/theme';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}.${m}.${day}`;
}

function peopleSummary(session: Session): string {
  const names = session.people.map((p) => p.name);
  const count = names.length;
  if (count === 0) return '참가자 없음';
  if (count > 4) {
    return `${names.slice(0, 3).join(', ')} 외 ${count - 3}명 · ${count}명`;
  }
  return `${names.join(', ')} · ${count}명`;
}

export default function HomeScreen() {
  const router = useRouter();
  const { sessions, loading, deleteSession } = useSessions();

  if (loading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  const confirmDelete = (session: Session) => {
    Alert.alert('모임 삭제', `'${session.title}' 모임을 삭제할까요?`, [
      { text: '취소', style: 'cancel' },
      {
        text: '삭제',
        style: 'destructive',
        onPress: () => deleteSession(session.id),
      },
    ]);
  };

  return (
    <Screen
      footer={
        <PrimaryButton
          label="새 모임 만들기"
          onPress={() => router.push('/session/new')}
        />
      }
    >
      {sessions.length === 0 ? (
        <EmptyState
          emoji="🧾"
          title="아직 모임이 없어요"
          hint="새 모임을 만들어 정산을 시작해보세요"
        />
      ) : (
        sessions.map((s) => {
          const total = s.rounds.reduce((sum, r) => sum + roundBaseTotal(r), 0);
          return (
            <Card
              key={s.id}
              onPress={() => router.push('/session/' + s.id)}
              onLongPress={() => confirmDelete(s)}
            >
              <Text style={styles.title}>
                {s.type === 'travel' ? '✈️ ' : ''}
                {s.title}
              </Text>
              <Text style={styles.meta}>{formatDate(s.createdAt)}</Text>
              <Text style={styles.meta}>{peopleSummary(s)}</Text>
              <Text style={styles.meta}>
                차수 {s.rounds.length}개 · {formatKrw(total)}
              </Text>
            </Card>
          );
        })
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
  },
  meta: {
    fontSize: fontSize.sm,
    color: colors.subtext,
  },
});
