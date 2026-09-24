/**
 * 친구 탭(URL '/friends'): 친구 목록 + 잔액 요약. 누르면 친구 장부(/friends/[id]).
 * 추가는 헤더 오른쪽 위 '친구 추가'((tabs)/_layout) → /friends/add (목록 안의 입력칸은 없앴다).
 */
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatKrw } from '@/domain/format';
import { friendBalance, type Friend } from '@/domain/friends';
import { useFriends } from '@/state/FriendsContext';
import { confirmDialog } from '@/ui/dialogs';
import { Card, EmptyState, LoadingState, Screen } from '@/ui/components';
import { colors, fontSize, spacing } from '@/ui/theme';

export default function FriendsScreen() {
  const router = useRouter();
  const { friends, loading, removeFriend, entriesOf } = useFriends();

  if (loading) {
    return (
      <Screen aboveTabBar>
        <LoadingState />
      </Screen>
    );
  }

  const confirmDelete = (friend: Friend) => {
    confirmDialog(
      '친구 삭제',
      `'${friend.name}' 친구와 주고받을 돈 기록이 함께 지워져요. 삭제할까요?`,
      () => removeFriend(friend.id),
      { confirmText: '삭제', destructive: true },
    );
  };

  return (
    <Screen aboveTabBar>
      {friends.length === 0 ? (
        <EmptyState
          title="아직 친구가 없어요"
          hint="오른쪽 위 '친구 추가'로 친구를 넣어 보세요"
        />
      ) : (
        friends.map((friend) => {
          const balance = friendBalance(entriesOf(friend.id));
          return (
            <Card key={friend.id} onPress={() => router.push('/friends/' + friend.id)}>
              <View style={styles.headerRow}>
                <Text style={styles.name} numberOfLines={1}>
                  {friend.name}
                </Text>
                <Pressable
                  onPress={() => confirmDelete(friend)}
                  hitSlop={12}
                  style={({ pressed }) => [
                    styles.deleteButton,
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  <Text style={styles.deleteLabel}>삭제</Text>
                </Pressable>
              </View>
              {balance.send === 0 && balance.receive === 0 ? (
                <Text style={styles.noBalance}>주고받을 돈 없음</Text>
              ) : (
                <View style={styles.balanceRow}>
                  {balance.send > 0 ? (
                    <Text style={styles.sendText}>
                      보낼 돈 {formatKrw(balance.send)}
                    </Text>
                  ) : null}
                  {balance.receive > 0 ? (
                    <Text style={styles.receiveText}>
                      받을 돈 {formatKrw(balance.receive)}
                    </Text>
                  ) : null}
                </View>
              )}
            </Card>
          );
        })
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  name: {
    flex: 1,
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
  },
  deleteButton: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: colors.dangerDim,
  },
  deleteLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.danger,
  },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    flexWrap: 'wrap',
  },
  sendText: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.danger,
  },
  receiveText: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.text,
  },
  noBalance: {
    fontSize: fontSize.sm,
    color: colors.subtext,
  },
});
