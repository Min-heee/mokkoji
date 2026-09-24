/**
 * 지도 — iOS/Android 구현(react-native-maps). Metro 가 네이티브에서만 이 파일을 고른다.
 *
 * - iOS: 애플 지도(PROVIDER_DEFAULT, 키 불필요)
 * - Android: 구글 지도(PROVIDER_GOOGLE). 바이너리에 키가 없으면(내장 설정 extra.hasGoogleMapsKey !== true) 지도를 띄우지 않고
 *   목록형 폴백을 그린다 — 키 없이 구글 지도를 만들면 앱이 죽는다. 키 유무는 OTA 매니페스트가 아니라 바이너리 내장 설정에서
 *   읽는다(googleMapsKeyRule.ts 참고).
 * - 지도 로딩 실패(렌더 예외, 15초 안에 준비 신호 없음)도 목록형 폴백으로 내린다.
 * - 권한은 요청하지 않는다. 기기 위치 점(showsUserLocation)은 호출자가 locationGranted 로 알려줄 때만 켠다.
 *
 * react-native-maps 1.20.1 은 Fabric 네이티브 컴포넌트가 아니라 RN 의 레거시 뷰 interop 레이어로 돈다(SDK 54 번들 버전).
 * 그래서 interop 에서 불안정한 기능(사용자 정의 마커의 tracksViewChanges 를 바로 끄기, Callout 자식 뷰,
 * animateMarkerToCoordinate(안드로이드 전용 명령))은 쓰지 않는다. 마커 이동은 JS 보간으로 좌표 prop 만 바꾼다.
 * 안드로이드 사용자 정의 마커는 interop 에서 자기 크기를 받지 못해 늘 100x100px 비트맵에 왼쪽 위 기준으로 그려진다.
 * 그래서 모든 사용자 정의 마커(목적지 핀·내 점·친구 원)를 100px 정사각형 상자 가운데에 두고(MarkerBox),
 * 마운트·모양 변경 직후 잠깐 tracksViewChanges 를 켜 레이아웃 뒤 비트맵을 다시 그리게 한다(useTrackViewChanges).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PixelRatio, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Circle, Marker, PROVIDER_DEFAULT, PROVIDER_GOOGLE, type Details, type Region } from 'react-native-maps';

import { HAS_EMBEDDED_GOOGLE_MAPS_KEY } from './googleMapsKey';
import { MapPaneFallback } from './MapPaneFallback';
import {
  androidMarkerBoxDp,
  drawnRadiusM,
  easeOutCubic,
  fitMarkerContentDp,
  isUserMove,
  lerpLatLng,
  mapAccessibilityLabel,
  markerInitial,
  mePlan,
  needsRefit,
  NO_RADIUS_FRAMING_M,
  regionForPoints,
  sameLatLng,
  visibleMarkerSignature,
  type LatLngLike,
  type MapRegion,
} from './mapGeometry';
import type { MapPaneMarker, MapPaneProps } from './mapPaneTypes';
import { colors, fontSize, radius, spacing } from './theme';

export { formatDistance } from './mapGeometry';
export type { MapPaneDestination, MapPaneMarker, MapPaneMe, MapPaneProps } from './mapPaneTypes';

/** 바이너리에 박힌 키 유무(빌드 시점 값). OTA 로 바뀌지 않는다 — Constants.expoConfig 는 OTA 매니페스트를 따르므로 쓰지 않는다 */
const HAS_GOOGLE_MAPS_KEY = HAS_EMBEDDED_GOOGLE_MAPS_KEY;
/** 이 시간 안에 onMapReady 가 없으면 지도를 포기하고 목록으로 내린다 */
const READY_TIMEOUT_MS = 15_000;
/** 자동 재맞춤 애니메이션 */
const FIT_DURATION_MS = 450;
/** 친구 마커 이동 보간 */
const TWEEN_MS = 600;
const TWEEN_STEP_MS = 50;
/** 안드로이드 사용자 정의 마커: 마운트·모양 변경 뒤 이만큼은 비트맵을 다시 그리게 둔다(바로 끄면 빈 마커가 된다) */
const TRACK_VIEW_MS = 600;
const IS_ANDROID = Platform.OS === 'android';
/** 안드로이드 마커 비트맵(100px)과 같은 크기의 상자(dp) */
const ANDROID_BOX_DP = androidMarkerBoxDp(PixelRatio.get());
/** 마커 내용 크기(dp). 안드로이드 고밀도에서는 100px 상자에 들어가게 줄인다 */
const markerDp = (desired: number) => (IS_ANDROID ? fitMarkerContentDp(desired, PixelRatio.get()) : desired);
const DEST_PIN_DP = markerDp(14);
const ME_DOT_DP = markerDp(16);
const BUBBLE_DP = markerDp(32);

export function MapPane(props: MapPaneProps) {
  if (Platform.OS === 'android' && !HAS_GOOGLE_MAPS_KEY) {
    return <MapPaneFallback {...props} reason="unavailable" />;
  }
  return (
    <MapErrorBoundary fallback={<MapPaneFallback {...props} reason="unavailable" />}>
      <NativeMap {...props} />
    </MapErrorBoundary>
  );
}

// ───────────────────────── 로딩 실패 경계 ─────────────────────────

class MapErrorBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    if (__DEV__) console.warn('[MapPane] 지도 렌더 실패 → 목록으로 대체', error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// ───────────────────────── 지도 본체 ─────────────────────────

/** 좌표를 5자리(약 1m)로 줄인 키 — 같은 값으로 effect 를 다시 돌리지 않게 */
const k = (n: number) => n.toFixed(5);

function NativeMap(props: MapPaneProps) {
  const {
    destination,
    radiusM,
    markers = [],
    me = null,
    readonly = false,
    height,
    style,
    locationGranted = false,
    onPress,
    accessibilityLabel,
  } = props;
  const h = height ?? (readonly ? 140 : 220);
  // 원을 그릴 반경. 없으면(모임 약속) 원 없이 동네 몇 블록 크기로 확대 수준만 잡는다
  const circleM = drawnRadiusM(radiusM);
  const framingM = circleM ?? NO_RADIUS_FRAMING_M;

  const mapRef = useRef<MapView>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [userMoved, setUserMoved] = useState(false);
  const regionRef = useRef<MapRegion | null>(null);
  const lastFitKeyRef = useRef<string | null>(null);
  const touchingRef = useRef(false);
  const lastTouchEndRef = useRef<number | null>(null);

  // 지도에 찍을 친구(좌표 있는 것만). '나' 마커가 좌표를 갖고 있으면 기기 위치(me)는 따로 다루지 않는다
  const visible = useMemo(
    () => markers.filter((m): m is MapPaneMarker & { lat: number; lng: number } => isPlottable(m.lat, m.lng)),
    [markers],
  );
  const meMarkerShown = visible.some((m) => m.isMe === true);
  // 내 위치: 영역 맞춤(meFit)과 그리기(meDot)를 나눈다. OS 파란 점이 그려져도(locationGranted) 영역에는 넣는다
  const plan = mePlan({ me, meMarkerShown, locationGranted });
  const meFit = plan.fit;
  const meDot = plan.drawDot ? meFit : null;

  // 영역에 넣을 점: 목적지 + 친구 + 내 위치(우리가 그리든 OS 가 그리든)
  const pointsKey = [
    `${k(destination.lat)},${k(destination.lng)},${framingM}`,
    ...visible.map((m) => `${m.id}:${k(m.lat)},${k(m.lng)}`),
    meFit ? `me:${k(meFit.lat)},${k(meFit.lng)}` : '',
  ].join('|');
  const points = useMemo<LatLngLike[]>(
    () => [
      { lat: destination.lat, lng: destination.lng },
      ...visible.map((m) => ({ lat: m.lat, lng: m.lng })),
      ...(meFit ? [{ lat: meFit.lat, lng: meFit.lng }] : []),
    ],
    // pointsKey 가 좌표 전부를 담는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pointsKey],
  );
  const target = useMemo(
    () => regionForPoints(points, { circle: { lat: destination.lat, lng: destination.lng, radiusM: framingM } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pointsKey],
  );
  // 목적지·반경·보이는 친구 집합이 바뀌면 무조건 다시 맞춘다(좌표만 움직이면 가장자리로 빠질 때만)
  const fitKey = `${k(destination.lat)},${k(destination.lng)},${framingM}|${visibleMarkerSignature(visible)}|${meFit ? 'me' : ''}`;

  const [initialRegion] = useState<Region | undefined>(() => target ?? undefined);

  // 준비 신호가 끝내 안 오면 목록으로
  useEffect(() => {
    if (ready) return;
    const id = setTimeout(() => setFailed(true), READY_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [ready]);

  const fitAll = useCallback(
    (animated: boolean) => {
      if (!target) return;
      lastFitKeyRef.current = fitKey;
      if (animated) mapRef.current?.animateToRegion(target, FIT_DURATION_MS);
      else mapRef.current?.animateToRegion(target, 0);
    },
    [target, fitKey],
  );

  // 자동 재맞춤 — 사용자가 지도를 움직인 뒤에는 멈춘다
  useEffect(() => {
    if (!ready || userMoved || !target) return;
    const setChanged = lastFitKeyRef.current !== fitKey;
    if (setChanged || needsRefit(regionRef.current, points)) fitAll(lastFitKeyRef.current !== null);
  }, [ready, userMoved, target, fitKey, points, fitAll]);

  const onMapReady = useCallback(() => setReady(true), []);

  const markMaybeUser = useCallback(
    (details: Details | undefined) => {
      if (readonly || userMoved) return;
      if (
        isUserMove({
          isGesture: details?.isGesture,
          touching: touchingRef.current,
          lastTouchEndMs: lastTouchEndRef.current,
          nowMs: Date.now(),
        })
      ) {
        setUserMoved(true);
      }
    },
    [readonly, userMoved],
  );

  const onRegionChangeComplete = useCallback(
    (region: Region, details: Details) => {
      regionRef.current = region;
      markMaybeUser(details);
    },
    [markMaybeUser],
  );

  const onShowAll = useCallback(() => {
    setUserMoved(false);
    lastTouchEndRef.current = null;
    fitAll(true);
  }, [fitAll]);

  if (failed) return <MapPaneFallback {...props} reason="unavailable" />;

  const friendCount = visible.filter((m) => !m.isMe).length;
  const a11y = accessibilityLabel ?? mapAccessibilityLabel(destination.name, radiusM, friendCount);
  const center = { latitude: destination.lat, longitude: destination.lng };

  return (
    <View style={[styles.wrap, style]}>
      <MapView
        ref={mapRef}
        style={{ height: h }}
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        initialRegion={initialRegion}
        onMapReady={onMapReady}
        onRegionChangeComplete={onRegionChangeComplete}
        onRegionChangeStart={(e) => markMaybeUser(e?.nativeEvent)}
        onTouchStart={() => {
          touchingRef.current = true;
        }}
        onTouchEnd={() => {
          touchingRef.current = false;
          lastTouchEndRef.current = Date.now();
        }}
        onTouchCancel={() => {
          touchingRef.current = false;
          lastTouchEndRef.current = Date.now();
        }}
        onPress={!readonly && onPress ? () => onPress() : undefined}
        scrollEnabled={!readonly}
        zoomEnabled={!readonly}
        zoomTapEnabled={!readonly}
        rotateEnabled={false}
        pitchEnabled={false}
        showsUserLocation={locationGranted}
        showsMyLocationButton={false}
        followsUserLocation={false}
        showsCompass={false}
        toolbarEnabled={false}
        moveOnMarkerPress={false}
        showsPointsOfInterest
        userInterfaceStyle="light"
        loadingEnabled
        loadingBackgroundColor={colors.cardAlt}
        loadingIndicatorColor={colors.subtext}
        accessible
        accessibilityLabel={a11y}
      >
        {circleM !== null ? (
          <Circle
            center={center}
            radius={circleM}
            strokeColor={colors.primary}
            strokeWidth={1.5}
            fillColor={colors.primaryDim}
            zIndex={1}
          />
        ) : null}
        <DestinationMarker latitude={destination.lat} longitude={destination.lng} name={destination.name} />
        {meDot ? <MeDotMarker latitude={meDot.lat} longitude={meDot.lng} /> : null}
        {visible.map((m) => (
          <FriendMarker key={m.id} marker={m} />
        ))}
      </MapView>

      {readonly && onPress ? (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={a11y}
        />
      ) : null}

      {!readonly && userMoved ? (
        <Pressable
          onPress={onShowAll}
          accessibilityRole="button"
          accessibilityLabel="전체 보기"
          hitSlop={8}
          style={({ pressed }) => [styles.showAll, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.showAllText}>전체 보기</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function isPlottable(lat: number | null | undefined, lng: number | null | undefined): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

// ───────────────────────── 사용자 정의 마커 공통 ─────────────────────────

/**
 * 안드로이드: 마운트 직후와 key 가 바뀐 직후 TRACK_VIEW_MS 동안만 true.
 * interop 에서는 마커가 레이아웃 전에 비트맵으로 굳으므로, 레이아웃 뒤 다시 그리는 길은 이 추적뿐이다.
 * iOS 애플 지도는 이 prop 을 무시한다.
 */
function useTrackViewChanges(visualKey: string): boolean {
  const [track, setTrack] = useState(true);
  useEffect(() => {
    setTrack(true);
    const id = setTimeout(() => setTrack(false), TRACK_VIEW_MS);
    return () => clearTimeout(id);
  }, [visualKey]);
  return track;
}

/** 안드로이드: 100px 비트맵과 같은 크기의 투명 상자 가운데에 내용을 둔다(anchor 0.5/0.5 와 맞고 잘리지 않는다). iOS: 그대로 */
function MarkerBox({ children }: { children: React.ReactNode }) {
  if (!IS_ANDROID) return <>{children}</>;
  return (
    <View style={styles.androidBox} collapsable={false} pointerEvents="none">
      {children}
    </View>
  );
}

const DestinationMarker = React.memo(function DestinationMarker({
  latitude,
  longitude,
  name,
}: {
  latitude: number;
  longitude: number;
  name: string;
}) {
  const track = useTrackViewChanges('dest');
  return (
    <Marker coordinate={{ latitude, longitude }} anchor={{ x: 0.5, y: 0.5 }} title={name} tracksViewChanges={track} zIndex={2}>
      <MarkerBox>
        <View style={styles.destPin} accessibilityLabel={`목적지 ${name}`} />
      </MarkerBox>
    </Marker>
  );
});

const MeDotMarker = React.memo(function MeDotMarker({ latitude, longitude }: { latitude: number; longitude: number }) {
  const track = useTrackViewChanges('me');
  return (
    <Marker coordinate={{ latitude, longitude }} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={track} zIndex={4}>
      <MarkerBox>
        <View style={styles.meDot} accessibilityLabel="내 위치" />
      </MarkerBox>
    </Marker>
  );
});

// ───────────────────────── 친구 마커 ─────────────────────────

/** 목표 좌표로 부드럽게 따라가는 좌표. 폴링(5초)마다 한 번 600ms 동안 50ms 간격으로만 갱신한다 */
function useTweenedLatLng(target: LatLngLike): LatLngLike {
  const [pos, setPos] = useState<LatLngLike>(target);
  const posRef = useRef<LatLngLike>(target);
  useEffect(() => {
    const from = posRef.current;
    if (sameLatLng(from, target)) return;
    const start = Date.now();
    const id = setInterval(() => {
      const t = (Date.now() - start) / TWEEN_MS;
      const next = t >= 1 ? target : lerpLatLng(from, target, easeOutCubic(t));
      posRef.current = next;
      setPos(next);
      if (t >= 1) clearInterval(id);
    }, TWEEN_STEP_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.lat, target.lng]);
  return pos;
}

const FriendMarker = React.memo(function FriendMarker({ marker }: { marker: MapPaneMarker & { lat: number; lng: number } }) {
  const pos = useTweenedLatLng({ lat: marker.lat, lng: marker.lng });
  const arrived = marker.arrived === true;
  const isMe = marker.isMe === true;
  const stale = marker.stale === true && !arrived;
  const initial = markerInitial(marker.label);

  // 안드로이드: 모양이 바뀔 때만 잠깐 비트맵을 다시 그린다(iOS 애플 지도는 이 prop 을 무시한다)
  const visualKey = `${initial}|${arrived}|${isMe}|${stale}`;
  const track = useTrackViewChanges(visualKey);

  const title = isMe ? `${marker.label} (나)` : marker.label;
  return (
    <Marker
      identifier={marker.id}
      coordinate={{ latitude: pos.lat, longitude: pos.lng }}
      anchor={{ x: 0.5, y: 0.5 }}
      title={title}
      description={marker.caption}
      tracksViewChanges={track}
      zIndex={isMe ? 5 : 3}
      opacity={stale ? 0.45 : 1}
    >
      <MarkerBox>
        <View
          style={[styles.bubble, arrived && styles.bubbleArrived, isMe && styles.bubbleMe]}
          accessibilityLabel={`${title}${arrived ? ', 도착' : ''}${marker.caption ? `, ${marker.caption}` : ''}`}
        >
          <Text style={[styles.bubbleText, arrived && styles.bubbleTextArrived]}>{initial}</Text>
        </View>
      </MarkerBox>
    </Marker>
  );
});

const styles = StyleSheet.create({
  wrap: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.cardAlt,
    overflow: 'hidden',
  },
  androidBox: {
    width: ANDROID_BOX_DP,
    height: ANDROID_BOX_DP,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  destPin: {
    width: DEST_PIN_DP,
    height: DEST_PIN_DP,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    borderWidth: 2,
    borderColor: colors.card,
  },
  meDot: {
    width: ME_DOT_DP,
    height: ME_DOT_DP,
    borderRadius: radius.pill,
    backgroundColor: colors.subtext,
    borderWidth: 3,
    borderColor: colors.card,
  },
  bubble: {
    width: BUBBLE_DP,
    height: BUBBLE_DP,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bubbleArrived: { backgroundColor: colors.primary },
  bubbleMe: { borderWidth: 3 },
  bubbleText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text },
  bubbleTextArrived: { color: colors.onPrimary },
  showAll: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  showAllText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.text },
});
