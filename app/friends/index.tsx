import { useRouter } from 'expo-router';
import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatKrw } from '@/domain/format';
import { friendBalance, type Friend } from '@/domain/friends';
import { useFriends } from '@/state/FriendsContext';
import {
  Card,
  EmptyState,
  LoadingState,
  PrimaryButton,
  Screen,
  TextField,
} from '@/ui/components';
import { colors, fontSize, spacing } from '@/ui/theme';

export default function FriendsScreen() {
  const router = useRouter();
  const { friends, loading, addFriend, removeFriend, entriesOf } = useFriends();
  const [name, setName] = React.useState('');

  if (loading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  const handleAdd = () => {
    const added = addFriend(name);
    if (added) setName('');
  };

  const confirmDelete = (friend: Friend) => {
    Alert.alert(
      '친구 삭제',
      `'${friend.name}' 친구와 주고받을 돈 기록이 함께 지워져요. 삭제할까요?`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '삭제',
          style: 'destructive',
          onPress: () => removeFriend(friend.id),
        },
      ],
    );
  };

  return (
    <Screen>
      <Card>
        <TextField
          label="이름"
          value={name}
          onChangeText={setName}
          placeholder="친구 이름"
          keepFocusOnSubmit
          onSubmitEditing={handleAdd}
        />
        <PrimaryButton label="추가" variant="ghost" onPress={handleAdd} />
      </Card>

      {friends.length === 0 ? (
        <EmptyState
          title="아직 친구가 없어요"
          hint="친구를 추가하면 모임에 빠르게 넣고 주고받을 돈을 기록할 수 있어요"
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
