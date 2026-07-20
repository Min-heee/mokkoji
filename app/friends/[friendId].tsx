import { Stack, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatKrw } from '@/domain/format';
import { friendBalance, type LedgerEntry, type LedgerType } from '@/domain/friends';
import { useFriends } from '@/state/FriendsContext';
import {
  AmountField,
  Card,
  Chip,
  EmptyState,
  PrimaryButton,
  Row,
  Screen,
  SectionTitle,
  TextField,
} from '@/ui/components';
import { colors, fontSize, spacing } from '@/ui/theme';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}.${m}.${day}`;
}

export default function FriendDetailScreen() {
  const { friendId } = useLocalSearchParams<{ friendId: string }>();
  const { getFriend, entriesOf, addEntry, removeEntry } = useFriends();
  const [type, setType] = React.useState<LedgerType>('receive');
  const [amount, setAmount] = React.useState(0);
  const [memo, setMemo] = React.useState('');

  const friend = friendId ? getFriend(friendId) : undefined;

  if (!friend) {
    return (
      <Screen>
        <EmptyState title="친구를 찾을 수 없어요" />
      </Screen>
    );
  }

  const entries = [...entriesOf(friend.id)].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const balance = friendBalance(entries);

  const handleAdd = () => {
    if (amount <= 0) return;
    addEntry(friend.id, type, amount, memo);
    setAmount(0);
    setMemo('');
  };

  const confirmRemoveEntry = (entry: LedgerEntry) => {
    Alert.alert(
      '기록 삭제',
      `'${entry.memo || '기록'}' ${formatKrw(entry.amount)} 기록을 삭제할까요?`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '삭제',
          style: 'destructive',
          onPress: () => removeEntry(entry.id),
        },
      ],
    );
  };

  const renderEntry = (entry: LedgerEntry) => {
    const date = formatDate(entry.createdAt);
    return (
      <Card key={entry.id} style={styles.entryCard}>
        <View style={styles.entryRow}>
          <View style={styles.entryLeft}>
            <Text style={styles.entryMemo} numberOfLines={1}>
              {entry.memo || '기록'}
            </Text>
            {date ? <Text style={styles.entryDate}>{date}</Text> : null}
          </View>
          <Text
            style={[
              styles.entryAmount,
              entry.type === 'send' ? styles.entrySend : styles.entryReceive,
            ]}
          >
            {entry.type === 'send' ? '-' : '+'}
            {formatKrw(entry.amount)}
          </Text>
          <Pressable
            onPress={() => confirmRemoveEntry(entry)}
            hitSlop={12}
            style={({ pressed }) => pressed && { opacity: 0.6 }}
          >
            <Text style={styles.entryDelete}>삭제</Text>
          </Pressable>
        </View>
      </Card>
    );
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: friend.name }} />

      <Card>
        {balance.net > 0 ? (
          <Text style={styles.netText}>
            {formatKrw(balance.net)} 받을 돈이 더 많아요
          </Text>
        ) : balance.net < 0 ? (
          <Text style={[styles.netText, styles.netSend]}>
            {formatKrw(-balance.net)} 보낼 돈이 더 많아요
          </Text>
        ) : (
          <Text style={[styles.netText, styles.netZero]}>주고받을 돈이 없어요</Text>
        )}
        <Text style={styles.balanceDetail}>
          보낼 돈 {formatKrw(balance.send)} · 받을 돈 {formatKrw(balance.receive)}
        </Text>
      </Card>

      <SectionTitle>기록 추가</SectionTitle>
      <Card>
        <Row>
          <Chip
            label="보낼 돈"
            selected={type === 'send'}
            onPress={() => setType('send')}
          />
          <Chip
            label="받을 돈"
            selected={type === 'receive'}
            onPress={() => setType('receive')}
          />
        </Row>
        <AmountField
          label="금액"
          value={amount}
          onChangeValue={setAmount}
          decimals={0}
          suffix="원"
        />
        <TextField
          label="메모"
          value={memo}
          onChangeText={setMemo}
          placeholder="예: 택시비"
        />
        <PrimaryButton label="추가" variant="ghost" onPress={handleAdd} />
      </Card>

      <SectionTitle>내역</SectionTitle>
      {entries.length === 0 ? (
        <EmptyState title="아직 기록이 없어요" />
      ) : (
        entries.map(renderEntry)
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  netText: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
  },
  netSend: {
    color: colors.danger,
  },
  netZero: {
    color: colors.subtext,
  },
  balanceDetail: {
    fontSize: fontSize.sm,
    color: colors.subtext,
  },
  entryCard: {
    padding: spacing.md,
  },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  entryLeft: {
    flex: 1,
    gap: 2,
  },
  entryMemo: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.text,
  },
  entryDate: {
    fontSize: fontSize.xs,
    color: colors.subtext,
  },
  entryAmount: {
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  entrySend: {
    color: colors.danger,
  },
  entryReceive: {
    color: colors.text,
  },
  entryDelete: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.danger,
  },
});
