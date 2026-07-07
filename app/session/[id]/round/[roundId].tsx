import React from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { formatKrw, genId, parseAmount } from '@/domain/format';
import { roundTotal } from '@/domain/settlement';
import { KIND_EMOJI, KIND_LABEL } from '@/domain/shareText';
import type { Item, PersonId, Round, RoundKind, RoundMode } from '@/domain/types';
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
import { colors, fontSize, spacing } from '@/ui/theme';

const KINDS: RoundKind[] = ['cafe', 'meal', 'drinks', 'etc'];

export default function RoundEditScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; roundId: string }>();
  const { loading, getSession, updateSession } = useSessions();

  const sessionId = typeof params.id === 'string' ? params.id : '';
  const roundId = typeof params.roundId === 'string' ? params.roundId : '';

  const session = sessionId ? getSession(sessionId) : undefined;
  const round = session?.rounds.find((r) => r.id === roundId);

  if (loading) {
    return (
      <Screen scroll={false}>
        <LoadingState />
      </Screen>
    );
  }

  if (!session || !round) {
    return (
      <Screen scroll={false}>
        <EmptyState
          emoji="🔍"
          title="차수를 찾을 수 없어요"
          hint="모임 화면으로 돌아가서 다시 선택해 주세요."
        />
      </Screen>
    );
  }

  const patchRound = (updater: (r: Round) => Round) => {
    updateSession(sessionId, (s) => ({
      ...s,
      rounds: s.rounds.map((r) => (r.id === roundId ? updater(r) : r)),
    }));
  };

  const patchItem = (itemId: string, updater: (it: Item) => Item) => {
    patchRound((r) => ({
      ...r,
      items: r.items.map((it) => (it.id === itemId ? updater(it) : it)),
    }));
  };

  const nameOf = (pid: PersonId) =>
    session.people.find((p) => p.id === pid)?.name ?? '?';

  const setKind = (kind: RoundKind) => patchRound((r) => ({ ...r, kind }));
  const setMode = (mode: RoundMode) => patchRound((r) => ({ ...r, mode }));
  const setPayer = (payerId: PersonId) => patchRound((r) => ({ ...r, payerId }));

  const toggleParticipant = (pid: PersonId) => {
    patchRound((r) => {
      if (r.participantIds.includes(pid)) {
        // 마지막 1명은 해제할 수 없어요
        if (r.participantIds.length <= 1) return r;
        return {
          ...r,
          participantIds: r.participantIds.filter((x) => x !== pid),
          exemptIds: r.exemptIds.filter((x) => x !== pid),
          items: r.items.map((it) => ({
            ...it,
            eaterIds: it.eaterIds.filter((x) => x !== pid),
          })),
        };
      }
      return { ...r, participantIds: [...r.participantIds, pid] };
    });
  };

  const toggleExempt = (pid: PersonId) => {
    patchRound((r) =>
      r.exemptIds.includes(pid)
        ? { ...r, exemptIds: r.exemptIds.filter((x) => x !== pid) }
        : { ...r, exemptIds: [...r.exemptIds, pid] },
    );
  };

  const toggleEater = (itemId: string, pid: PersonId) => {
    patchItem(itemId, (it) =>
      it.eaterIds.includes(pid)
        ? { ...it, eaterIds: it.eaterIds.filter((x) => x !== pid) }
        : { ...it, eaterIds: [...it.eaterIds, pid] },
    );
  };

  const addItem = () => {
    patchRound((r) => ({
      ...r,
      items: [
        ...r.items,
        { id: genId('i'), name: '', unitPrice: 0, quantity: 1, eaterIds: [] },
      ],
    }));
  };

  const removeItem = (itemId: string) => {
    patchRound((r) => ({
      ...r,
      items: r.items.filter((it) => it.id !== itemId),
    }));
  };

  const confirmDeleteRound = () => {
    Alert.alert('차수 삭제', `'${round.title}' 차수를 삭제할까요?`, [
      { text: '취소', style: 'cancel' },
      {
        text: '삭제',
        style: 'destructive',
        onPress: () => {
          updateSession(sessionId, (s) => ({
            ...s,
            rounds: s.rounds.filter((r) => r.id !== roundId),
          }));
          router.back();
        },
      },
    ]);
  };

  return (
    <>
      <Stack.Screen options={{ title: round.title || '차수' }} />
      <Screen
        footer={
          <>
            <PrimaryButton label="완료" onPress={() => router.back()} />
            <PrimaryButton
              label="차수 삭제"
              variant="danger"
              onPress={confirmDeleteRound}
            />
          </>
        }
      >
        <SectionTitle>이름</SectionTitle>
        <TextField
          value={round.title}
          onChangeText={(t) => patchRound((r) => ({ ...r, title: t }))}
          placeholder="예: 1차 카페"
        />

        <SectionTitle>종류</SectionTitle>
        <Row>
          {KINDS.map((k) => (
            <Chip
              key={k}
              label={`${KIND_EMOJI[k]} ${KIND_LABEL[k]}`}
              selected={round.kind === k}
              onPress={() => setKind(k)}
            />
          ))}
        </Row>

        <SectionTitle>결제한 사람</SectionTitle>
        <Row>
          {session.people.map((p) => (
            <Chip
              key={p.id}
              label={p.name}
              selected={round.payerId === p.id}
              onPress={() => setPayer(p.id)}
            />
          ))}
        </Row>

        <SectionTitle>함께한 사람</SectionTitle>
        <Row>
          {session.people.map((p) => (
            <Chip
              key={p.id}
              label={p.name}
              selected={round.participantIds.includes(p.id)}
              onPress={() => toggleParticipant(p.id)}
            />
          ))}
        </Row>

        <SectionTitle>정산 방식</SectionTitle>
        <Row>
          <Chip
            label="균등 n빵"
            selected={round.mode === 'even'}
            onPress={() => setMode('even')}
          />
          <Chip
            label="항목별로"
            selected={round.mode === 'itemized'}
            onPress={() => setMode('itemized')}
          />
        </Row>

        {round.mode === 'even' ? (
          <TextField
            label="총 금액"
            value={round.totalAmount ? String(round.totalAmount) : ''}
            onChangeText={(t) =>
              patchRound((r) => ({ ...r, totalAmount: parseAmount(t) }))
            }
            keyboardType="number-pad"
            suffix="원"
            placeholder="0"
          />
        ) : (
          <>
            {round.items.map((item) => (
              <Card key={item.id} style={{ gap: spacing.sm }}>
                <Row>
                  <View style={{ flex: 1 }}>
                    <TextField
                      value={item.name}
                      onChangeText={(t) =>
                        patchItem(item.id, (it) => ({ ...it, name: t }))
                      }
                      placeholder="메뉴 이름"
                    />
                  </View>
                  <Text style={styles.itemTotal}>
                    {formatKrw(item.unitPrice * item.quantity)}
                  </Text>
                </Row>
                <Row>
                  <View style={{ flex: 2 }}>
                    <TextField
                      label="단가"
                      value={item.unitPrice ? String(item.unitPrice) : ''}
                      onChangeText={(t) =>
                        patchItem(item.id, (it) => ({
                          ...it,
                          unitPrice: parseAmount(t),
                        }))
                      }
                      keyboardType="number-pad"
                      suffix="원"
                      placeholder="0"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <TextField
                      label="수량"
                      value={item.quantity ? String(item.quantity) : ''}
                      onChangeText={(t) =>
                        patchItem(item.id, (it) => ({
                          ...it,
                          quantity: parseAmount(t),
                        }))
                      }
                      keyboardType="number-pad"
                      placeholder="0"
                    />
                  </View>
                </Row>
                <Text style={styles.fieldLabel}>먹은 사람</Text>
                <Row>
                  {round.participantIds.map((pid) => (
                    <Chip
                      key={pid}
                      label={nameOf(pid)}
                      selected={item.eaterIds.includes(pid)}
                      onPress={() => toggleEater(item.id, pid)}
                    />
                  ))}
                </Row>
                <Text style={styles.hint}>아무도 선택 안 하면 전원이 나눠요</Text>
                <PrimaryButton
                  label="항목 삭제"
                  variant="danger"
                  onPress={() => removeItem(item.id)}
                />
              </Card>
            ))}
            <PrimaryButton label="+ 항목 추가" variant="ghost" onPress={addItem} />
          </>
        )}

        <SectionTitle>열외 (돈 안 내는 사람)</SectionTitle>
        <Row>
          {round.participantIds.map((pid) => (
            <Chip
              key={pid}
              label={nameOf(pid)}
              selected={round.exemptIds.includes(pid)}
              onPress={() => toggleExempt(pid)}
            />
          ))}
        </Row>
        <Text style={styles.hint}>생일자 등 — 이 사람 몫은 나머지가 나눠 내요</Text>

        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.totalLabel}>이 차수 합계</Text>
            <Text style={styles.totalValue}>{formatKrw(roundTotal(round))}</Text>
          </Row>
        </Card>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  hint: {
    fontSize: fontSize.xs,
    color: colors.subtext,
  },
  fieldLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.subtext,
  },
  itemTotal: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.text,
  },
  totalLabel: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
  },
  totalValue: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.primary,
  },
});
