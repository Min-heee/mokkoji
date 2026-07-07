import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams } from 'expo-router';
import React, { useMemo } from 'react';
import { Alert, Share, StyleSheet, Text, View } from 'react-native';

import { formatKrw } from '@/domain/format';
import { computeSettlement } from '@/domain/settlement';
import { buildShareText, KIND_EMOJI } from '@/domain/shareText';
import type { PersonId, SessionSettings } from '@/domain/types';
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
} from '@/ui/components';
import { colors, fontSize, spacing } from '@/ui/theme';

const ROUNDING_OPTIONS: { unit: SessionSettings['roundingUnit']; label: string }[] = [
  { unit: 1, label: '1원' },
  { unit: 10, label: '10원' },
  { unit: 100, label: '100원' },
  { unit: 1000, label: '1,000원' },
];

export default function ResultScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { loading, getSession, updateSession } = useSessions();

  const session = typeof id === 'string' ? getSession(id) : undefined;

  const result = useMemo(
    () => (session ? computeSettlement(session) : null),
    [session],
  );

  if (loading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  if (!session || !result) {
    return (
      <Screen>
        <EmptyState
          emoji="🤔"
          title="모임을 찾을 수 없어요"
          hint="목록으로 돌아가서 다시 선택해 주세요"
        />
      </Screen>
    );
  }

  const nameOf = (personId: PersonId) =>
    session.people.find((p) => p.id === personId)?.name ?? '?';

  const involvedPersons = result.persons.filter(
    (p) => p.consumed > 0 || p.paid > 0,
  );

  const selectRounding = (unit: SessionSettings['roundingUnit']) => {
    updateSession(session.id, (s) => ({
      ...s,
      settings: { ...s.settings, roundingUnit: unit },
    }));
  };

  const onShare = async () => {
    try {
      await Share.share({ message: buildShareText(session, result) });
    } catch {
      // 사용자가 공유를 취소한 경우 등은 무시해요.
    }
  };

  const onCopy = async () => {
    await Clipboard.setStringAsync(buildShareText(session, result));
    Alert.alert('복사했어요', '카톡에 붙여넣어 공유하세요');
  };

  return (
    <Screen
      footer={
        <>
          <PrimaryButton label="공유하기" onPress={onShare} />
          <PrimaryButton label="텍스트 복사" variant="ghost" onPress={onCopy} />
        </>
      }
    >
      <Card>
        <Text style={styles.summaryLabel}>총 지출</Text>
        <Text style={styles.summaryTotal}>{formatKrw(result.grandTotal)}</Text>
        <Text style={styles.summarySub}>
          차수 {session.rounds.length}개 · 참가자 {session.people.length}명
        </Text>
      </Card>

      <SectionTitle>💸 이렇게 보내세요</SectionTitle>
      {result.transfers.length === 0 ? (
        <EmptyState emoji="🎉" title="주고받을 돈이 없어요" />
      ) : (
        result.transfers.map((t, index) => (
          <Card key={`${t.fromId}-${t.toId}-${index}`}>
            <View style={styles.rowBetween}>
              <Text style={styles.transferNames}>
                {nameOf(t.fromId)} → {nameOf(t.toId)}
              </Text>
              <Text style={styles.transferAmount}>{formatKrw(t.amount)}</Text>
            </View>
          </Card>
        ))
      )}

      <SectionTitle>반올림 단위</SectionTitle>
      <Row>
        {ROUNDING_OPTIONS.map((opt) => (
          <Chip
            key={opt.unit}
            label={opt.label}
            selected={session.settings.roundingUnit === opt.unit}
            onPress={() => selectRounding(opt.unit)}
          />
        ))}
      </Row>
      <Text style={styles.hint}>자투리는 가장 많이 받을 사람이 부담해요</Text>

      <SectionTitle>사람별 상세</SectionTitle>
      {involvedPersons.map((p) => (
        <Card key={p.personId}>
          <View style={styles.rowBetween}>
            <View style={styles.personLeft}>
              <Text style={styles.personName}>{nameOf(p.personId)}</Text>
              <Text style={styles.personDetail}>
                부담 {formatKrw(p.consumed)} · 결제 {formatKrw(p.paid)}
              </Text>
            </View>
            {Math.abs(p.net) < 1 ? (
              <Text style={styles.netDone}>정산 끝</Text>
            ) : p.net > 0 ? (
              <Text style={styles.netReceive}>+{formatKrw(p.net)} 받아요</Text>
            ) : (
              <Text style={styles.netSend}>{formatKrw(-p.net)} 보내요</Text>
            )}
          </View>
        </Card>
      ))}

      <SectionTitle>차수별 지출</SectionTitle>
      {result.perRound.map((r) => (
        <Card key={r.roundId} style={styles.roundCard}>
          <View style={styles.rowBetween}>
            <View style={styles.personLeft}>
              <Text style={styles.roundTitle}>
                {KIND_EMOJI[r.kind]} {r.title}
              </Text>
              <Text style={styles.personDetail}>{nameOf(r.payerId)} 결제</Text>
            </View>
            <Text style={styles.roundTotal}>{formatKrw(r.total)}</Text>
          </View>
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  summaryLabel: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.subtext,
  },
  summaryTotal: {
    fontSize: fontSize.xl,
    fontWeight: '800',
    color: colors.text,
  },
  summarySub: {
    fontSize: fontSize.sm,
    color: colors.subtext,
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  transferNames: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.text,
    flexShrink: 1,
  },
  transferAmount: {
    fontSize: fontSize.lg,
    fontWeight: '800',
    color: colors.primary,
  },
  hint: {
    fontSize: fontSize.xs,
    color: colors.subtext,
  },
  personLeft: {
    flexShrink: 1,
    gap: spacing.xs,
  },
  personName: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
  },
  personDetail: {
    fontSize: fontSize.sm,
    color: colors.subtext,
  },
  netReceive: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.success,
  },
  netSend: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.danger,
  },
  netDone: {
    fontSize: fontSize.sm,
    color: colors.subtext,
  },
  roundCard: {
    padding: spacing.md,
  },
  roundTitle: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.text,
  },
  roundTotal: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
  },
});
