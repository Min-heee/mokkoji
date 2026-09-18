/**
 * 약속 조건 카드와 같이 쓰는 조각 — WaitingView·LiveView·app/j 가 공유한다.
 * (수락제 폐지로 PendingView 가 사라지면서 그 파일에 있던 공유 조각을 여기로 옮겼다. 내용은 그대로다.)
 *
 * export: ConditionCard · FromNowPill · openExternal
 */
import * as Linking from 'expo-linking';
import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { describePolicy, shortPolicyLine } from '@/domain/latePresets';
import { mapPinUrl } from '@/domain/mapRoute';
import { formatFromNow, formatKoreanDateTime, tzLabel } from '@/domain/tzGuard';
import { Card } from '@/ui/components';
import { alertDialog } from '@/ui/dialogs';
import { MapPane } from '@/ui/MapPane';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

import type { LbAppointment } from '../types';
import { useServerNow } from '../useServerNow';

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
 * '위치 공개 시점' 항목은 없다(오너 확정 2026-09-18) — 위치는 주최자가 [시작하기]를 누르는 순간부터 보이고,
 * 그 안내는 대기실(주최자 버튼 아래 설명 / 게스트 "주최자가 시작하면 위치가 보여요")이 따로 말한다.
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

const styles = StyleSheet.create({
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
