/**
 * 정산 대기·결과·무효 (설계서 §5.3-F settling · §5.3-G). 담당: [result]
 *
 * - 순위·도착 시각·판정 근거(GPS ±Nm / 친구 확인)·증감 포인트. 표시 모델은 ../resultModel.ts(순수 함수, 테스트 있음).
 * - settling: '결과를 확정하는 중이에요' + 진행 중 순위(증감은 '예정').
 * - [정산 시작] → 참가자 확인 시트(전원 체크, '오지 않음'은 라벨만) → startSettlement(멱등) → /session/<id>.
 *   이미 만든 정산이 있으면 '열까요?'.
 * - [결과 공유] 는 텍스트 공유(웹은 공유 시트가 없으면 복사).
 * 헤더 제목·연결 끊김 띠·FakeDevPanel 은 컨테이너(app/late/[id])가 그린다.
 */
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { shortPolicyLine } from '@/domain/latePresets';
import { sessionCandidates, type SessionCandidate } from '@/domain/toSession';
import { formatKoreanDateTime, SEOUL_TZ, tzLabel } from '@/domain/tzGuard';
import { useSessions } from '@/state/SessionsContext';
import { Card, PrimaryButton, Screen } from '@/ui/components';
import { alertDialog, confirmDialog } from '@/ui/dialogs';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

import { SETTLE_DELAYED_NOTICE } from '../errors';
import {
  buildResultModel,
  buildResultShareText,
  formatSignedPoints,
  resultRowDelta,
  resultRowDetail,
  type ResultKind,
  type ResultModel,
  type ResultRow,
} from '../resultModel';
import { findSessionForLateBet, startSettlement } from '../startSettlement';
import type { ResultViewProps } from './props';

export function ResultView({ live, phase, settleDelayed }: ResultViewProps) {
  const router = useRouter();
  const sessions = useSessions();
  const kind: ResultKind = phase === 'settled' ? 'settled' : phase === 'voided' ? 'voided' : 'settling';
  const model = useMemo(() => buildResultModel(live, kind), [live, kind]);
  const candidates = useMemo(() => sessionCandidates(live), [live]);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const a = live.appointment;
  const final = kind !== 'settling';
  const myRow = model.rows.find((r) => r.isMe) ?? null;

  const onStart = () => {
    const existing = findSessionForLateBet(sessions.sessions, a.id);
    if (existing) {
      confirmDialog('이미 만든 정산이 있어요', '열까요?', () => router.replace('/session/' + existing.id), {
        confirmText: '열기',
      });
      return;
    }
    if (candidates.length === 0) {
      alertDialog('정산할 사람이 없어요');
      return;
    }
    // 전원 체크된 상태로 시작한다 — 마감 뒤에 온 사람이 기록상 '오지 않음'일 수 있다(§5.2)
    setSelected(new Set(candidates.map((c) => c.userId)));
    setSheetOpen(true);
  };

  const onConfirm = () => {
    const ids = candidates.filter((c) => selected.has(c.userId)).map((c) => c.userId);
    if (ids.length === 0) return;
    const { sessionId } = startSettlement({ live, selectedUserIds: ids, sessions });
    setSheetOpen(false);
    router.replace('/session/' + sessionId);
  };

  const toggle = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const onShare = async () => {
    const message = buildResultShareText(live, model);
    try {
      await Share.share({ message });
    } catch (e) {
      // 네이티브: 사용자가 공유를 취소한 경우 등은 무시한다
      if (Platform.OS !== 'web') return;
      if (e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError') return;
      // 웹: 공유 시트가 없는 브라우저 → 복사로 대신한다
      try {
        await Clipboard.setStringAsync(message);
        alertDialog('복사했어요', '카톡에 붙여넣어 공유하세요');
      } catch {
        alertDialog('공유할 수 없어요');
      }
    }
  };

  const when = formatKoreanDateTime(a.meetAtMs, a.tz);
  const zone = a.tz === SEOUL_TZ ? '' : tzLabel(a.tz);

  return (
    <>
      <Screen
        footer={
          <>
            <PrimaryButton
              label="정산 시작"
              variant={final ? 'primary' : 'ghost'}
              onPress={onStart}
              disabled={sessions.loading}
            />
            {final ? <PrimaryButton label="결과 공유" variant="ghost" onPress={() => void onShare()} /> : null}
          </>
        }
      >
        <View style={styles.head}>
          <Text style={styles.title}>{model.title}</Text>
          <Text style={styles.sub}>{[when, zone, a.placeName].filter((s) => s.trim() !== '').join(' · ')}</Text>
          <Text style={styles.sub}>{shortPolicyLine(a.policy)}</Text>
        </View>

        <Card>
          <Text style={styles.headline}>{model.headline}</Text>
          {!final ? <Text style={styles.sub}>지금까지의 순위예요. 곧 확정돼요.</Text> : null}
          {!final && settleDelayed ? <Text style={styles.notice}>{SETTLE_DELAYED_NOTICE}</Text> : null}
          {final ? <MyLine model={model} row={myRow} balance={live.myBalance} /> : null}
        </Card>

        {__DEV__ && model.mismatch ? (
          <Card>
            <Text style={styles.notice}>계산 불일치 — 서버 결과와 앱의 재계산이 달라요 (개발 빌드에서만 보여요)</Text>
          </Card>
        ) : null}

        {model.rows.length > 0 ? (
          <Card style={styles.listCard}>
            {model.rows.map((r, i) => (
              <RankRow key={r.userId} model={model} row={r} first={i === 0} />
            ))}
          </Card>
        ) : null}
      </Screen>
      <ConfirmSheet
        visible={sheetOpen}
        candidates={candidates}
        selected={selected}
        onToggle={toggle}
        onConfirm={onConfirm}
        onClose={() => setSheetOpen(false)}
      />
    </>
  );
}

/** 머리 카드의 내 줄: '내 결과 +60P · 보유 1,060P' */
function MyLine({ model, row, balance }: { model: ResultModel; row: ResultRow | null; balance: number }) {
  const parts: React.ReactNode[] = [];
  if (row && model.hasStake && model.kind === 'settled') {
    parts.push(
      <Text key="net" style={styles.myLine}>
        내 결과 <Text style={[styles.myNet, row.net < 0 && styles.loss]}>{formatSignedPoints(row.net)}</Text>
      </Text>,
    );
  }
  if (Number.isFinite(balance)) {
    parts.push(
      <Text key="bal" style={styles.myLine}>
        보유 {balance.toLocaleString('ko-KR')}P
      </Text>,
    );
  }
  if (parts.length === 0) return null;
  return <View style={styles.myRow}>{parts}</View>;
}

function RankRow({ model, row, first }: { model: ResultModel; row: ResultRow; first: boolean }) {
  const delta = resultRowDelta(model, row);
  return (
    <View style={[styles.row, !first && styles.rowDivider]}>
      <Text style={styles.rank}>{row.rank}</Text>
      <View style={styles.rowBody}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {row.nickname}
          </Text>
          {row.isMe ? <Text style={styles.meBadge}>나</Text> : null}
        </View>
        <Text style={styles.detail}>{resultRowDetail(row)}</Text>
      </View>
      {delta !== '' ? (
        <Text style={[styles.delta, row.net < 0 && styles.loss, row.net === 0 && styles.deltaZero]}>{delta}</Text>
      ) : null}
    </View>
  );
}

/** 참가자 확인 시트 — 전원 체크된 상태로 열린다. '오지 않음'은 라벨만 붙인다 */
function ConfirmSheet({
  visible,
  candidates,
  selected,
  onToggle,
  onConfirm,
  onClose,
}: {
  visible: boolean;
  candidates: readonly SessionCandidate[];
  selected: ReadonlySet<string>;
  onToggle: (userId: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const count = candidates.filter((c) => selected.has(c.userId)).length;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetRoot}>
        {/* 새 색을 만들지 않으려고 옵시디언에 투명도를 준 막을 깐다 */}
        <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="닫기" />
        <View style={[styles.sheet, { paddingBottom: Math.max(spacing.xl, insets.bottom + spacing.sm) }]}>
          <Text style={styles.sheetTitle}>함께 정산할 사람을 확인해 주세요</Text>
          <Text style={styles.sub}>
            이름이 그대로 정산 모임에 들어가요. 앱이 없는 친구는 정산 화면에서 추가할 수 있어요.
          </Text>
          <ScrollView style={styles.sheetList} keyboardShouldPersistTaps="handled">
            {candidates.map((c) => {
              const on = selected.has(c.userId);
              return (
                <Pressable
                  key={c.userId}
                  onPress={() => onToggle(c.userId)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  style={({ pressed }) => [styles.checkRow, pressed && { opacity: 0.7 }]}
                >
                  <View style={[styles.box, on && styles.boxOn]}>{on ? <View style={styles.tick} /> : null}</View>
                  <Text style={styles.checkName} numberOfLines={1}>
                    {c.name}
                  </Text>
                  {c.noShow ? <Text style={styles.noShow}>오지 않음</Text> : null}
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.sheetButtons}>
            <PrimaryButton label={`${count}명으로 정산 시작`} onPress={onConfirm} disabled={count === 0} />
            <PrimaryButton label="취소" variant="ghost" onPress={onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  head: { gap: 2 },
  title: { fontSize: fontSize.xl, fontWeight: '800', color: colors.text },
  sub: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  headline: { fontSize: fontSize.md, fontWeight: '700', color: colors.text, lineHeight: 24 },
  notice: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text, lineHeight: 20 },
  myRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.md, rowGap: 2 },
  myLine: { fontSize: fontSize.sm, color: colors.subtext },
  myNet: { fontWeight: '800', color: colors.text },
  loss: { color: colors.danger },

  listCard: { gap: 0, paddingVertical: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rank: { width: 20, fontSize: fontSize.md, fontWeight: '800', color: colors.subtext, textAlign: 'center' },
  rowBody: { flex: 1, gap: 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  name: { flexShrink: 1, fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  meBadge: {
    paddingVertical: 1,
    paddingHorizontal: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.primaryDim,
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.subtext,
    overflow: 'hidden',
  },
  detail: { fontSize: fontSize.sm, color: colors.subtext },
  delta: { fontSize: fontSize.md, fontWeight: '800', color: colors.text },
  deltaZero: { color: colors.subtext },

  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.primary, opacity: 0.4 },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sheetTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  sheetList: { maxHeight: 320 },
  sheetButtons: { gap: spacing.sm, marginTop: spacing.sm },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.cardAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  // 글리프 없이 그린 체크 표시(테두리 두 변을 45도 돌린다)
  tick: {
    width: 6,
    height: 11,
    marginTop: -2,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderColor: colors.onPrimary,
    transform: [{ rotate: '45deg' }],
  },
  checkName: { flex: 1, fontSize: fontSize.md, fontWeight: '600', color: colors.text },
  noShow: { fontSize: fontSize.xs, fontWeight: '700', color: colors.subtext },
});
