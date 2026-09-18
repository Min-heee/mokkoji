/**
 * 목록형 지도 자리 — 웹(MapPane.tsx)과, 네이티브에서 지도를 못 띄울 때(안드로이드 키 없음·로딩 실패)의 폴백.
 * 네이티브 모듈을 import 하지 않는다. 지도는 장식이고 기준 데이터는 참가자 리스트다 — 이것만으로 화면이 성립한다.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatDistance, mapAccessibilityLabel, markerInitial } from './mapGeometry';
import type { MapPaneFallbackReason, MapPaneProps } from './mapPaneTypes';
import { colors, fontSize, radius, spacing } from './theme';

const REASON_LABEL: Record<MapPaneFallbackReason, string> = {
  placeholder: '지도 자리',
  unavailable: '지도를 표시할 수 없어 목록으로 보여드려요',
};

export function MapPaneFallback({
  destination,
  radiusM,
  markers = [],
  readonly = false,
  height,
  style,
  onPress,
  accessibilityLabel,
  reason = 'placeholder',
}: MapPaneProps & { reason?: MapPaneFallbackReason }) {
  const h = height ?? (readonly ? 140 : 220);
  const visibleCount = markers.filter((m) => !m.isMe && m.lat !== null && m.lng !== null).length;
  const label = accessibilityLabel ?? mapAccessibilityLabel(destination.name, radiusM, visibleCount);
  const body = (
    <View style={[styles.map, { minHeight: h }]} accessible accessibilityLabel={label}>
      <Text style={styles.mapLabel}>{REASON_LABEL[reason]}</Text>
      <View style={styles.ring}>
        <View style={styles.pin} />
      </View>
      <Text style={styles.placeName} numberOfLines={1}>
        {destination.name}
      </Text>
      <Text style={styles.sub}>
        도착 인정 거리 {radiusM}m · {destination.lat.toFixed(5)}, {destination.lng.toFixed(5)}
      </Text>
    </View>
  );
  return (
    <View style={[styles.wrap, style]}>
      {onPress ? (
        <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => pressed && { opacity: 0.7 }}>
          {body}
        </Pressable>
      ) : (
        body
      )}
      {!readonly && markers.length > 0 ? (
        <View style={styles.list}>
          {markers.map((m) => (
            <View key={m.id} style={styles.row}>
              <View style={[styles.initial, m.arrived && styles.initialArrived]}>
                <Text style={[styles.initialText, m.arrived && styles.initialTextArrived]}>{markerInitial(m.label)}</Text>
              </View>
              <Text style={styles.name} numberOfLines={1}>
                {m.label}
                {m.isMe ? ' (나)' : ''}
              </Text>
              <Text style={styles.dist} numberOfLines={1}>
                {[m.arrived ? '' : formatDistance(m.distanceM), m.caption ?? ''].filter((s) => s !== '').join(' · ') || '위치 없음'}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  map: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.cardAlt,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  mapLabel: { fontSize: fontSize.xs, color: colors.subtext, textAlign: 'center' },
  ring: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.text,
    backgroundColor: colors.primaryDim,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: spacing.xs,
  },
  pin: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: colors.text },
  placeName: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  sub: { fontSize: fontSize.xs, color: colors.subtext },
  list: { padding: spacing.md, gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  initial: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: colors.cardAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initialArrived: { backgroundColor: colors.primary },
  initialText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text },
  initialTextArrived: { color: colors.onPrimary },
  name: { flexShrink: 1, fontSize: fontSize.sm, fontWeight: '600', color: colors.text },
  dist: { marginLeft: 'auto', fontSize: fontSize.sm, color: colors.subtext },
});
