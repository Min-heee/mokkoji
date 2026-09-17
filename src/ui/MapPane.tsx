/**
 * 지도 자리 — P0 플레이스홀더 (플랫폼 무관 단일 파일).
 *
 * P1 에서 MapPane.native.tsx(react-native-maps: 목적지 핀 + 반경 원 + 친구 마커) / MapPane.web.tsx 로 바뀐다.
 * props 는 그대로 간다. 지도는 장식이고 기준 데이터는 참가자 리스트다 — 이 컴포넌트가 없어도 화면이 성립해야 한다.
 */
import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, fontSize, radius, spacing } from './theme';

export interface MapPaneDestination {
  name: string;
  lat: number;
  lng: number;
}

export interface MapPaneMarker {
  /** 참가자 userId */
  id: string;
  /** 닉네임(지도에서는 첫 글자 원) */
  label: string;
  /** 좌표를 볼 수 없으면 null — 지도에는 안 찍히고 P0 목록에는 caption 만 나온다 */
  lat: number | null;
  lng: number | null;
  /** 목적지까지 거리(m). 서버가 준 값 */
  distanceM?: number | null;
  /** "40초 전", "4분 전까지 공유", "도착 · 오후 7:21" 같은 한 줄 */
  caption?: string;
  arrived?: boolean;
  isMe?: boolean;
}

export interface MapPaneProps {
  destination: MapPaneDestination;
  /** 도착 인정 반경(m) — 목적지 둘레의 원 */
  radiusM: number;
  /** 친구 마커. readonly 에서는 보통 비운다 */
  markers?: readonly MapPaneMarker[];
  /** 내 위치(기기에서 읽은 값). 모르면 null */
  me?: { lat: number; lng: number; accuracyM?: number | null } | null;
  /** 참여 카드·대기실용: 제스처 없음, 핀과 반경만 */
  readonly?: boolean;
  /** 지도 높이. 기본 readonly 140 / 라이브 220 */
  height?: number;
  style?: StyleProp<ViewStyle>;
}

/** 850 → "850m", 1234 → "1.2km" */
export function formatDistance(m: number | null | undefined): string {
  if (typeof m !== 'number' || !Number.isFinite(m) || m < 0) return '';
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

export function MapPane({ destination, radiusM, markers = [], readonly = false, height, style }: MapPaneProps) {
  const h = height ?? (readonly ? 140 : 220);
  return (
    <View style={[styles.wrap, style]}>
      <View style={[styles.map, { minHeight: h }]}>
        <Text style={styles.mapLabel}>지도 자리</Text>
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
      {!readonly && markers.length > 0 ? (
        <View style={styles.list}>
          {markers.map((m) => (
            <View key={m.id} style={styles.row}>
              <View style={[styles.initial, m.arrived && styles.initialArrived]}>
                <Text style={[styles.initialText, m.arrived && styles.initialTextArrived]}>{Array.from(m.label)[0] ?? ''}</Text>
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
  mapLabel: { fontSize: fontSize.xs, color: colors.subtext },
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
