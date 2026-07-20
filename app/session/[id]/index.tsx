import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatMoney } from '@/domain/currency';
import type { Friend } from '@/domain/friends';
import { addFriendPerson, addNamedPerson } from '@/domain/people';
import { roundBaseTotal, roundFxFactor, roundTotal } from '@/domain/settlement';
import { formatKrw } from '@/domain/format';
import type { Round } from '@/domain/types';
import { useFriends } from '@/state/FriendsContext';
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
  const { friends } = useFriends();
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

  // 이름이 아니라 friendId로만 거른다 — 새 모임 화면처럼
  // 이름이 같아도 다른 친구면 추가할 수 있어야 한다
  const linkedFriendIds = new Set(
    session.people.map((p) => p.friendId).filter((v): v is string => !!v),
  );
  const availableFriends = friends.filter((f) => !linkedFriendIds.has(f.id));

  const handleAddFriendPerson = (friend: Friend) => {
    // 중복 가드는 업데이터 안(addFriendPerson)에 있어 더블탭에도 안전하다
    updateSession(session.id, (s) => addFriendPerson(s, friend));
  };

  const handleAddPerson = () => {
    const name = newName.trim();
    if (!name) return;
    if (session.people.some((p) => p.name === name)) {
      // 조용히 입력만 지우면 추가된 것처럼 보이므로 명시적으로 알린다
      Alert.alert(
        '같은 이름이 있어요',
        `'${name}' 참가자가 이미 있어요. 다른 사람이라면 구분되는 이름(예: ${name}2)으로 추가해 주세요.`,
      );
      return;
    }
    // 중복 가드는 업데이터 안(addNamedPerson)에도 있어 이중 submit에 안전하다
    updateSession(session.id, (s) => addNamedPerson(s, name));
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

  const cancelSessionBet = () =>
    updateSession(session.id, (s) => ({ ...s, bet: null }));

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
        {availableFriends.length > 0 && (
          <>
            <Text style={styles.friendPickLabel}>친구에서 추가</Text>
            <Row>
              {availableFriends.map((friend) => (
                <Chip
                  key={friend.id}
                  label={friend.name}
                  selected={false}
                  onPress={() => handleAddFriendPerson(friend)}
                />
              ))}
            </Row>
          </>
        )}
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
                  {round.mode === 'even' ? '균등 정산' : '항목별'}
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

      <SectionTitle>모임 내기</SectionTitle>
      <Card>
        {session.bet ? (
          <View style={styles.sessionBetRow}>
            <View style={styles.betBadgeWrap}>
              <Text style={styles.betBadge}>
                {nameOf(session.bet.loserId)} 몰빵 · {formatKrw(session.bet.amount)}
              </Text>
              <Text style={styles.betCancel} onPress={cancelSessionBet}>
                취소
              </Text>
            </View>
            <Pressable
              onPress={() => router.push(`/session/${session.id}/bet`)}
              style={({ pressed }) => [styles.betPill, pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.betPillText}>다시</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => router.push(`/session/${session.id}/bet`)}
            style={({ pressed }) => [
              styles.betPill,
              { alignSelf: 'flex-start' },
              pressed && { opacity: 0.6 },
            ]}
          >
            <Text style={styles.betPillText}>모임 전체 내기</Text>
          </Pressable>
        )}
        <Text style={styles.roundSubtitle}>진 사람이 오늘 전체 중 정한 금액을 몰빵해요</Text>
      </Card>

      <Card>
        <Text style={styles.totalLabel}>총 지출</Text>
        <Text style={styles.totalAmount}>{formatKrw(grandTotal)}</Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  friendPickLabel: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.subtext,
    marginTop: spacing.sm,
  },
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
  sessionBetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
