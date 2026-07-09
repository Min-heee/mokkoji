import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatMoney } from '@/domain/currency';
import { roundBaseTotal, roundFxFactor, roundTotal } from '@/domain/settlement';
import { formatKrw, genId } from '@/domain/format';
import type { Round } from '@/domain/types';
import { useSessions } from '@/state/SessionsContext';
import {
  Card,
  Chip,
  EmptyState,
  LoadingState,
  PrimaryButton,
  Row,
  Screen,
  SectionTitle,
  TextField,
} from '@/ui/components';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

export default function SessionDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : params.id?.[0] ?? '';
  const router = useRouter();
  const { loading, getSession, updateSession, addRound } = useSessions();
  const [newName, setNewName] = useState('');

  if (loading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  const session = getSession(id);
  if (!session) {
    return (
      <Screen>
        <EmptyState title="모임을 찾을 수 없어요" />
      </Screen>
    );
  }

  const nameOf = (personId: string) =>
    session.people.find((p) => p.id === personId)?.name ?? '?';

  const grandTotal = session.rounds.reduce(
    (sum, r) => sum + roundBaseTotal(r),
    0,
  );

  const handleAddPerson = () => {
    const name = newName.trim();
    if (!name) return;
    if (session.people.some((p) => p.name === name)) {
      setNewName('');
      return;
    }
    updateSession(session.id, (s) => ({
      ...s,
      people: [...s.people, { id: genId('p'), name }],
    }));
    setNewName('');
  };

  const handleAddRound = () => {
    const round = addRound(session.id);
    if (round) {
      router.push(`/session/${session.id}/round/${round.id}`);
    }
  };

  const handleDeleteRound = (round: Round) => {
    Alert.alert('차수 삭제', `'${round.title}' 차수를 삭제할까요?`, [
      { text: '취소', style: 'cancel' },
      {
        text: '삭제',
        style: 'destructive',
        onPress: () =>
          updateSession(session.id, (s) => ({
            ...s,
            rounds: s.rounds.filter((r) => r.id !== round.id),
          })),
      },
    ]);
  };

  const cancelRoundBet = (round: Round) => {
    updateSession(session.id, (s) => ({
      ...s,
      rounds: s.rounds.map((r) => (r.id === round.id ? { ...r, bet: null } : r)),
    }));
  };

  return (
    <Screen
      footer={
        <PrimaryButton
          label="정산하기"
          disabled={session.rounds.length === 0}
          onPress={() => router.push(`/session/${session.id}/result`)}
        />
      }
    >
      <Stack.Screen options={{ title: session.title }} />

      <SectionTitle>참가자</SectionTitle>
      <Card>
        <Row>
          {session.people.map((person) => (
            <Chip key={person.id} label={person.name} selected={false} />
          ))}
        </Row>
        <TextField
          label="이름"
          value={newName}
          onChangeText={setNewName}
          placeholder="새 참가자 이름"
          onSubmitEditing={handleAddPerson}
          keepFocusOnSubmit
        />
        <PrimaryButton label="추가" variant="ghost" onPress={handleAddPerson} />
      </Card>

      <SectionTitle>차수</SectionTitle>
      {session.rounds.length === 0 ? (
        <EmptyState
                    title="차수를 추가해보세요"
          hint="1차 카페, 2차 밥, 3차 술, 숙소, 교통..."
        />
      ) : (
        session.rounds.map((round) => (
          <Card
            key={round.id}
            onPress={() => router.push(`/session/${session.id}/round/${round.id}`)}
            onLongPress={() => handleDeleteRound(round)}
          >
            <View style={styles.roundRow}>
              <View style={styles.roundInfo}>
                <Text style={styles.roundTitle}>{round.title}</Text>
                <Text style={styles.roundSubtitle}>
                  결제 {nameOf(round.payerId)} ·{' '}
                  {round.mode === 'even' ? '균등 n빵' : '항목별'}
                </Text>
              </View>
              {(round.currency || 'KRW') === 'KRW' ? (
                <Text style={styles.roundAmount}>
                  {formatKrw(roundBaseTotal(round))}
                </Text>
              ) : (
                <View style={styles.roundAmountCol}>
                  <Text style={styles.roundAmount}>
                    {formatMoney(roundTotal(round), round.currency)}
                  </Text>
                  {roundFxFactor(round) == null ? (
                    <Text style={styles.fxMissing}>환율 필요</Text>
                  ) : (
                    <Text style={styles.fxConverted}>
                      ≈ {formatKrw(roundBaseTotal(round))}
                    </Text>
                  )}
                </View>
              )}
            </View>

            <View style={styles.betRow}>
              {round.bet ? (
                <View style={styles.betBadgeWrap}>
                  <Text style={styles.betBadge}>
                    {nameOf(round.bet.loserId)} 몰빵
                  </Text>
                  <Text style={styles.betCancel} onPress={() => cancelRoundBet(round)}>
                    취소
                  </Text>
                </View>
              ) : (
                <View />
              )}
              <Pressable
                onPress={() =>
                  router.push(`/session/${session.id}/round/${round.id}/bet`)
                }
                style={({ pressed }) => [styles.betPill, pressed && { opacity: 0.6 }]}
              >
                <Text style={styles.betPillText}>
                  {round.bet ? '내기 다시' : '내기'}
                </Text>
              </Pressable>
            </View>
          </Card>
        ))
      )}
      <PrimaryButton label="+ 차수 추가" variant="ghost" onPress={handleAddRound} />

      <Card>
        <Text style={styles.totalLabel}>총 지출</Text>
        <Text style={styles.totalAmount}>{formatKrw(grandTotal)}</Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  roundRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  roundInfo: {
    flex: 1,
    gap: spacing.xs,
  },
  roundTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
  },
  roundSubtitle: {
    fontSize: fontSize.sm,
    color: colors.subtext,
  },
  roundAmount: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
  },
  roundAmountCol: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  betRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  betBadgeWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 1,
  },
  betBadge: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.text,
  },
  betCancel: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.danger,
  },
  betPill: {
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.text,
  },
  betPillText: {
    fontSize: fontSize.sm,
    fontWeight: '800',
    color: colors.text,
  },
  fxMissing: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    color: colors.danger,
  },
  fxConverted: {
    fontSize: fontSize.xs,
    color: colors.subtext,
  },
  totalLabel: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.subtext,
  },
  totalAmount: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.text,
  },
});
