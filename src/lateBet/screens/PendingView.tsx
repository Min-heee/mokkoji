/**
 * 승인 대기(phase = pending) — "주최자가 수락하면 참여돼요" + 조건 카드 + [요청 취소]
 * 설계서 §3.2-4, §5.3-F. 담당: [waiting]
 *
 * 규칙
 * - 다른 참가자·위치는 절대 그리지 않는다. (서버도 승인 대기자에게는 자기 행만 주지만, 화면도 participants 를 아예 읽지 않는다)
 * - 포인트는 아직 걸리지 않았다 → [요청 취소]에 환불 문구가 없다.
 * - 수락되면 useLive 의 폴링(5초)이 phase 를 바꾸고 컨테이너가 다음 뷰로 넘긴다. 여기서는 아무것도 하지 않는다.
 *
 * 이 파일은 대기실(WaitingView)과 같이 쓰는 조각도 내보낸다: ConditionCard · FromNowPill · openExternal
 */
import * as Linking from 'expo-linking';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { describePolicy, shortPolicyLine } from '@/domain/latePresets';
import { mapPinUrl } from '@/domain/mapRoute';
import { formatFromNow, formatKoreanDateTime, formatKoreanTime, tzLabel } from '@/domain/tzGuard';
import { Card, PrimaryButton, Screen, SectionTitle } from '@/ui/components';
import { alertDialog, confirmDialog } from '@/ui/dialogs';
import { MapPane } from '@/ui/MapPane';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

import { toLateBetError } from '../errors';
import type { LbAppointment } from '../types';
import { useServerNow } from '../useServerNow';
import type { PendingViewProps } from './props';

// ───────────────────────── 같이 쓰는 조각 ─────────────────────────

/** 바깥 링크 열기. 웹(앱인토스 웹뷰)에서는 같은 탭을 갈아치우지 않게 새 탭으로 연다 */
export function openExternal(url: string, failTitle = '지도를 열 수 없어요'): void {
  if (Platform.OS === 'web') {
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) alertDialog(failTitle);
    return;
  }
  Linking.openURL(url).catch(() => alertDialog(failTitle));
}

/** "2시간 10분 뒤" 알약. 30초마다만 다시 그린다(서버 기준 시각) */
export function FromNowPill({ targetMs }: { targetMs: number }) {
  const now = useServerNow(30_000);
  const text = formatFromNow(targetMs - now);
  if (text === '') return null;
  return <Text style={styles.pill}>{text}</Text>;
}

export interface ConditionCardProps {
  appointment: LbAppointment;
  /** 핀 지도 아래 한 줄 — 보는 사람에 따라 다르다 */
  pinHint: string;
}

/**
 * 약속 조건 카드: 시각(+시간대 라벨 상시) · 장소 · 핀 지도(readonly) · 내기 조건 전문.
 * 위치 공개 시각 문장은 넣지 않는다 — 대기실은 하단 잠금 안내가, 승인 대기는 머리 문구가 따로 말한다.
 */
export function ConditionCard({ appointment: a, pinHint }: ConditionCardProps) {
  const d = describePolicy(a.policy, a.meetAtMs, a.tz);
  const lines = [d.stake, d.penalty, d.full, d.grace, d.radius, d.close].filter((s) => s !== '');
  const note = a.placeNote.trim();

  return (
    <Card>
      <View style={styles.timeRow}>
        <Text style={styles.time}>{formatKoreanDateTime(a.meetAtMs, a.tz)}</Text>
        <FromNowPill targetMs={a.meetAtMs} />
      </View>
      <Text style={styles.muted}>{tzLabel(a.tz)} 기준</Text>

      <View style={styles.block}>
        <Text style={styles.place}>{a.placeName}</Text>
        {note !== '' ? <Text style={styles.muted}>{note}</Text> : null}
      </View>

      <MapPane destination={{ name: a.placeName, lat: a.placeLat, lng: a.placeLng }} radiusM={a.policy.radiusM} readonly />
      <View style={styles.pinRow}>
        <Text style={[styles.muted, styles.pinHint]}>{pinHint}</Text>
        <Text style={styles.link} onPress={() => openExternal(mapPinUrl(a.placeName, a.placeLat, a.placeLng))}>
          카카오맵에서 보기
        </Text>
      </View>

      <View style={styles.policy}>
        <Text style={styles.policyHead}>{shortPolicyLine(a.policy)}</Text>
        {lines.map((line) => (
          <Text key={line} style={styles.policyLine}>
            {line}
          </Text>
        ))}
        {d.example !== '' ? (
          <Text style={styles.policyLine}>
            예를 들어 <Text style={styles.loss}>{d.example}</Text>
          </Text>
        ) : null}
      </View>
    </Card>
  );
}

// ───────────────────────── 승인 대기 화면 ─────────────────────────

export function PendingView({ live, me, api, refresh, stale, onLeft }: PendingViewProps) {
  const a = live.appointment;
  const stake = a.policy.stake;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const withdraw = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api.leave(a.id);
      onLeft(); // refresh 대신 — 안 그러면 "주최자가 요청을 받지 않았어요"가 뜬다
    } catch (e) {
      alertDialog('요청을 취소하지 못했어요', toLateBetError(e).message);
      await refresh();
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [a.id, api, onLeft, refresh]);

  const askWithdraw = () => {
    confirmDialog(
      '참여 요청을 취소할까요?',
      '아직 포인트가 걸리지 않았어요. 초대 링크로 다시 요청할 수 있어요.',
      () => void withdraw(),
      { confirmText: '네, 취소할게요', destructive: true },
    );
  };

  return (
    <Screen footer={<PrimaryButton label="요청 취소" variant="ghost" onPress={askWithdraw} disabled={busy || stale} />}>
      <View style={styles.head}>
        <Text style={styles.headTitle}>주최자가 수락하면 참여돼요</Text>
        <Text style={styles.headBody}>
          {stake > 0 ? `수락되는 순간 ${stake}P가 걸려요. ` : ''}
          주최자에게 카톡으로 알려 주세요.
        </Text>
        <Text style={styles.muted}>
          {me ? `'${me.nickname}' 이름으로 요청했어요. ` : ''}
          수락되면 이 화면이 바로 바뀌어요.
        </Text>
      </View>

      <SectionTitle>약속 조건</SectionTitle>
      <ConditionCard appointment={a} pinHint="핀 위치가 맞는지 확인해 주세요" />

      <Text style={styles.muted}>
        수락되기 전에는 다른 참가자와 위치가 보이지 않아요. 약속 시각({formatKoreanTime(a.meetAtMs, a.tz)})까지 수락되지 않으면
        요청은 사라져요.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { gap: spacing.sm, paddingVertical: spacing.sm },
  headTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.text },
  headBody: { fontSize: fontSize.md, color: colors.text, lineHeight: 22 },
  muted: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  time: { fontSize: fontSize.lg, fontWeight: '800', color: colors.text, flexShrink: 1 },
  pill: {
    fontSize: fontSize.xs,
    fontWeight: '800',
    color: colors.text,
    backgroundColor: colors.primaryDim,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 10,
    overflow: 'hidden',
  },
  block: { gap: spacing.xs, marginTop: spacing.xs },
  place: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  pinRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  pinHint: { flex: 1, minWidth: 160 },
  link: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text, textDecorationLine: 'underline' },
  policy: {
    gap: spacing.xs,
    marginTop: spacing.xs,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  policyHead: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  policyLine: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  // 잃는 포인트만 브릭
  loss: { color: colors.danger, fontWeight: '700' },
});
