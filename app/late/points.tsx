/**
 * 포인트 화면 (설계서 §5.3-H). 담당: [result]
 *
 * - 잔액(보유 포인트) + 열린 약속에 걸어 둔 포인트 합 + 내 이름.
 * - 원장(api.listLedger, 최신순): '금요일 곱창 · 건 포인트 −100', '모자란 포인트 채움 +20', 결과 줄에는 잃은/더 받은 포인트 설명.
 *   표시 문구는 src/lateBet/homeModel.ts(순수 함수, 테스트 있음).
 * - 계정 유실 고지: "앱을 지우거나 기기를 바꾸면 포인트와 약속이 사라져요. 계정 연결은 준비 중이에요."
 * - NicknameGate 로 감싼다(프로필이 없으면 이름부터 받는다). 잃는 포인트만 브릭색.
 */
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { formatKoreanDateTime, SEOUL_TZ } from '@/domain/tzGuard';
import { LateBetError, REPEATED_FAILURE_MESSAGE, toLateBetError } from '@/lateBet/errors';
import { heldPoints, ledgerAmount, ledgerCaption, ledgerLabel, ledgerLoss } from '@/lateBet/homeModel';
import { useLateBet } from '@/lateBet/LateBetContext';
import { LateBetUnavailable, NicknameGate } from '@/lateBet/screens/NicknameGate';
import type { LbLedgerEntry } from '@/lateBet/types';
import { Card, EmptyState, LoadingState, PrimaryButton, Screen, SectionTitle } from '@/ui/components';
import { colors, fontSize, spacing } from '@/ui/theme';

const LEDGER_LIMIT = 100;
const ACCOUNT_LOSS_NOTICE = '앱을 지우거나 기기를 바꾸면 포인트와 약속이 사라져요. 계정 연결은 준비 중이에요.';

export default function LatePointsScreen() {
  const { enabled } = useLateBet();
  if (!enabled) return <LateBetUnavailable />;
  return (
    <NicknameGate>
      <PointsInner />
    </NicknameGate>
  );
}

function PointsInner() {
  const { api, profile, balance, appointments, refresh, failCount } = useLateBet();
  const [entries, setEntries] = useState<LbLedgerEntry[] | null>(null);
  const [error, setError] = useState<LateBetError | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 잔액·걸어 둔 포인트(홈 목록)와 원장을 같이 새로 읽는다. refresh 는 던지지 않는다
      const [list] = await Promise.all([api.listLedger(LEDGER_LIMIT), refresh()]);
      setEntries(list);
      setError(null);
    } catch (e) {
      setError(toLateBetError(e));
    } finally {
      setLoading(false);
    }
  }, [api, refresh]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const held = useMemo(() => heldPoints(appointments), [appointments]);
  const shownBalance = balance ?? profile?.balance ?? null;

  return (
    <Screen>
      <Card>
        <Text style={styles.label}>보유 포인트</Text>
        <Text style={styles.balance}>{shownBalance === null ? '-' : `${shownBalance.toLocaleString('ko-KR')}P`}</Text>
        {held.count > 0 ? (
          <Text style={styles.sub}>
            열린 약속 {held.count}개에 {held.points.toLocaleString('ko-KR')}P를 걸어 뒀어요. 약속이 끝나면 결과에 따라 돌아와요.
          </Text>
        ) : null}
        {profile ? <Text style={styles.sub}>이름 {profile.nickname}</Text> : null}
      </Card>
      <Text style={styles.notice}>{ACCOUNT_LOSS_NOTICE}</Text>

      <SectionTitle>내역</SectionTitle>
      {entries === null && loading ? (
        <LoadingState />
      ) : entries === null ? (
        <View style={styles.errorBox}>
          <EmptyState title={error?.message ?? '내역을 불러오지 못했어요.'} hint={failCount >= 3 ? REPEATED_FAILURE_MESSAGE : undefined} />
          <PrimaryButton label="다시 시도" variant="ghost" onPress={() => void load()} disabled={loading} />
        </View>
      ) : entries.length === 0 ? (
        <Text style={styles.sub}>아직 내역이 없어요.</Text>
      ) : (
        <Card style={styles.listCard}>
          {error ? <Text style={styles.staleNote}>{error.message} 마지막으로 본 내역이에요.</Text> : null}
          {entries.map((e, i) => (
            <LedgerRow key={e.id} entry={e} entries={entries} first={i === 0} />
          ))}
        </Card>
      )}
    </Screen>
  );
}

/** 원장 한 줄: 이름 / 설명 · 시각 | 금액 / 잔액. 잃은 포인트가 있을 때만 브릭색 */
function LedgerRow({ entry: e, entries, first }: { entry: LbLedgerEntry; entries: readonly LbLedgerEntry[]; first: boolean }) {
  const caption = ledgerCaption(e, entries);
  const lost = ledgerLoss(e, entries) > 0;
  const when = formatKoreanDateTime(e.createdAtMs, SEOUL_TZ);
  return (
    <View style={[styles.row, !first && styles.rowDivider]}>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel} numberOfLines={2}>
          {ledgerLabel(e)}
        </Text>
        {caption ? <Text style={styles.rowCaption}>{caption}</Text> : null}
        <Text style={styles.rowCaption}>{when}</Text>
      </View>
      <View style={styles.rowAmounts}>
        <Text style={[styles.amount, lost && styles.loss, e.amount === 0 && styles.amountZero]}>{ledgerAmount(e.amount)}</Text>
        <Text style={styles.rowCaption}>잔액 {e.balanceAfter.toLocaleString('ko-KR')}P</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: fontSize.xs, fontWeight: '700', color: colors.subtext },
  balance: { fontSize: fontSize.xl, fontWeight: '800', color: colors.text },
  sub: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  notice: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  errorBox: { gap: spacing.sm },
  staleNote: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text, lineHeight: 20, paddingVertical: spacing.sm },

  listCard: { gap: 0, paddingVertical: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rowBody: { flex: 1, gap: 2 },
  rowLabel: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  rowCaption: { fontSize: fontSize.xs, color: colors.subtext },
  rowAmounts: { alignItems: 'flex-end', gap: 2 },
  amount: { fontSize: fontSize.md, fontWeight: '800', color: colors.text },
  amountZero: { color: colors.subtext },
  loss: { color: colors.danger },
});
