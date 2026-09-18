/**
 * 지도 표시용 순수 계산 — MapPane(웹·네이티브)이 공유한다.
 * react-native·지도 SDK 를 import 하지 않는다(node:test 로 검증).
 * 판정용 거리 계산은 src/domain/geo.ts 몫이고, 여기는 '어디를 얼마나 보여줄지'만 다룬다.
 */

export interface LatLngLike {
  lat: number;
  lng: number;
}

/** react-native-maps 의 Region 과 같은 모양(의존성 없이 복제) */
export interface MapRegion {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

/** 위도 1도 ≈ 111.32km */
const M_PER_DEG_LAT = 111_320;
/** 최소 델타(도) ≈ 330m — 점 하나·같은 점만 있을 때 너무 확대되지 않게 */
export const MIN_REGION_DELTA = 0.003;
/** 한쪽 여백 비율 — 전체 폭의 25% 씩 양옆에 더한다 */
export const DEFAULT_PADDING_RATIO = 0.25;

function isFiniteLatLng(p: LatLngLike | null | undefined): p is LatLngLike {
  return (
    !!p &&
    typeof p.lat === 'number' &&
    typeof p.lng === 'number' &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lng >= -180 &&
    p.lng <= 180
  );
}

/** 경도를 [-180, 180) 으로 */
export function normalizeLng(lng: number): number {
  const x = (((lng + 180) % 360) + 360) % 360;
  return x - 180;
}

/** a → b 경도 차(가까운 쪽, -180~180) */
function lngDiff(a: number, b: number): number {
  return normalizeLng(b - a);
}

/** 위도 lat 에서 반경 m 가 경도로 몇 도인지(극지방 폭주 방지로 cos 하한 0.01) */
function metersToLngDeg(m: number, lat: number): number {
  const c = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  return m / (M_PER_DEG_LAT * c);
}

/** 경도 목록이 차지하는 최소 구간 {center, span}. 날짜변경선을 넘는 편이 더 좁으면 그쪽을 고른다 */
function lngExtent(lngs: readonly number[]): { center: number; span: number } {
  let min = Infinity;
  let max = -Infinity;
  let min360 = Infinity;
  let max360 = -Infinity;
  for (const l of lngs) {
    min = Math.min(min, l);
    max = Math.max(max, l);
    const w = l < 0 ? l + 360 : l;
    min360 = Math.min(min360, w);
    max360 = Math.max(max360, w);
  }
  const spanA = max - min;
  const spanB = max360 - min360;
  if (spanB < spanA) return { center: normalizeLng((min360 + max360) / 2), span: spanB };
  return { center: (min + max) / 2, span: spanA };
}

export interface RegionOptions {
  /** 목적지 반경 원 — 원 전체가 보이도록 영역에 포함한다 */
  circle?: (LatLngLike & { radiusM: number }) | null;
  /** 한쪽 여백 비율. 기본 0.25 */
  paddingRatio?: number;
  /** 최소 델타(도). 기본 MIN_REGION_DELTA */
  minDelta?: number;
}

/**
 * 점들(+반경 원)을 모두 감싸는 지도 영역. 유효한 점이 하나도 없으면 null.
 * - 좌표가 null·NaN·범위 밖인 점은 버린다(서버 데이터를 믿지 않는다)
 * - 날짜변경선 양쪽 점은 짧은 쪽으로 감싼다
 * - 같은 점만 있거나 반경이 작으면 최소 델타로 편다
 */
export function regionForPoints(
  points: readonly (LatLngLike | null | undefined)[],
  opts: RegionOptions = {},
): MapRegion | null {
  const pad = Math.max(0, opts.paddingRatio ?? DEFAULT_PADDING_RATIO);
  const minDelta = Math.max(0, opts.minDelta ?? MIN_REGION_DELTA);

  const pts: LatLngLike[] = points.filter(isFiniteLatLng);
  const circle = opts.circle;
  if (circle && isFiniteLatLng(circle) && Number.isFinite(circle.radiusM) && circle.radiusM > 0) {
    // 원을 네 방향 끝점으로 바꿔 넣는다 → 반경이 점들의 영역보다 커도 원 전체가 들어간다
    const dLat = circle.radiusM / M_PER_DEG_LAT;
    const dLng = metersToLngDeg(circle.radiusM, circle.lat);
    pts.push(
      { lat: Math.min(90, circle.lat + dLat), lng: circle.lng },
      { lat: Math.max(-90, circle.lat - dLat), lng: circle.lng },
      { lat: circle.lat, lng: normalizeLng(circle.lng + dLng) },
      { lat: circle.lat, lng: normalizeLng(circle.lng - dLng) },
    );
  } else if (circle && isFiniteLatLng(circle)) {
    pts.push({ lat: circle.lat, lng: circle.lng });
  }
  if (pts.length === 0) return null;

  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const p of pts) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
  }
  const { center: lngCenter, span: lngSpan } = lngExtent(pts.map((p) => p.lng));

  const factor = 1 + 2 * pad;
  const latDelta = Math.min(170, Math.max(minDelta, (maxLat - minLat) * factor));
  const lngDelta = Math.min(360, Math.max(minDelta, lngSpan * factor));
  const latCenter = Math.max(-85, Math.min(85, (minLat + maxLat) / 2));

  return { latitude: latCenter, longitude: lngCenter, latitudeDelta: latDelta, longitudeDelta: lngDelta };
}

/**
 * 지금 영역 안쪽(가장자리 margin 비율 제외)에 모든 점이 들어 있지 않으면 true — 자동 재맞춤 신호.
 * 폴링마다 영역을 다시 맞추면 지도가 계속 출렁이므로, 점이 가장자리로 빠질 때만 움직인다.
 */
export function needsRefit(
  region: MapRegion | null | undefined,
  points: readonly (LatLngLike | null | undefined)[],
  marginRatio = 0.1,
): boolean {
  if (!region) return true;
  const m = Math.min(Math.max(marginRatio, 0), 0.49);
  const halfLat = (region.latitudeDelta / 2) * (1 - m);
  const halfLng = (region.longitudeDelta / 2) * (1 - m);
  for (const p of points) {
    if (!isFiniteLatLng(p)) continue;
    if (Math.abs(p.lat - region.latitude) > halfLat) return true;
    if (Math.abs(lngDiff(region.longitude, p.lng)) > halfLng) return true;
  }
  return false;
}

/** 좌표가 있는 마커 id 집합의 서명 — 집합이 바뀌면(누가 새로 보이거나 사라지면) 재맞춤한다 */
export function visibleMarkerSignature(
  markers: readonly { id: string; lat: number | null; lng: number | null }[],
): string {
  return markers
    .filter((m) => m.lat !== null && m.lng !== null && isFiniteLatLng({ lat: m.lat, lng: m.lng }))
    .map((m) => m.id)
    .sort()
    .join('|');
}

/** 0~1 → 0~1 감속 곡선 */
export function easeOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 3;
}

/** 두 좌표 사이 보간(t 0~1). 경도는 날짜변경선을 넘는 짧은 쪽으로 간다 */
export function lerpLatLng(a: LatLngLike, b: LatLngLike, t: number): LatLngLike {
  const x = Math.min(1, Math.max(0, t));
  return {
    lat: a.lat + (b.lat - a.lat) * x,
    lng: normalizeLng(a.lng + lngDiff(a.lng, b.lng) * x),
  };
}

/** 두 좌표가 사실상 같은지(약 1m 이내) — 같은 값으로 애니메이션을 다시 돌리지 않게 */
export function sameLatLng(a: LatLngLike | null | undefined, b: LatLngLike | null | undefined): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(lngDiff(a.lng, b.lng)) < 1e-5;
}

export interface GestureSignal {
  /** 지도 SDK 가 준 isGesture(구글맵만 준다. 애플맵은 undefined) */
  isGesture?: boolean;
  /** 지금 손가락이 지도 위에 있는지 */
  touching: boolean;
  /** 마지막으로 손가락을 뗀 시각(ms). 없으면 null */
  lastTouchEndMs: number | null;
  nowMs: number;
  /** 손을 뗀 뒤 관성 스크롤이 끝날 때까지 사용자 이동으로 보는 시간. 기본 1500ms */
  windowMs?: number;
}

/**
 * 영역 변경이 사용자 제스처였는지. true 면 자동 재맞춤을 멈추고 [전체 보기]를 띄운다.
 * 애플맵은 isGesture 를 주지 않으므로 터치 기록으로 보완한다. 코드로 움직인 변경은 터치가 없어 false.
 */
export function isUserMove(s: GestureSignal): boolean {
  if (s.isGesture === true) return true;
  if (s.touching) return true;
  if (s.lastTouchEndMs === null) return false;
  const win = s.windowMs ?? 1500;
  const dt = s.nowMs - s.lastTouchEndMs;
  return dt >= 0 && dt <= win;
}

/** 마커 원 안에 들어갈 한 글자. 공백만 있으면 '?' */
export function markerInitial(label: string | null | undefined): string {
  const first = Array.from((label ?? '').trim())[0];
  if (!first) return '?';
  return first.toUpperCase();
}

/** 850 → "850m", 1234 → "1.2km" */
export function formatDistance(m: number | null | undefined): string {
  if (typeof m !== 'number' || !Number.isFinite(m) || m < 0) return '';
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

/** 지도 전체의 스크린리더 라벨 */
export function mapAccessibilityLabel(placeName: string, radiusM: number, visibleFriendCount: number): string {
  const name = placeName.trim() || '약속 장소';
  const parts = [`${name} 지도`];
  if (Number.isFinite(radiusM) && radiusM > 0) parts.push(`도착 인정 거리 ${Math.round(radiusM)}m`);
  if (visibleFriendCount > 0) parts.push(`친구 ${visibleFriendCount}명 위치 표시`);
  return parts.join(', ');
}

// ───────────────────────── 내 위치: 그리기와 영역 맞춤 분리 ─────────────────────────

export interface MePlanInput {
  /** 내 좌표(기기 위치 또는 서버가 준 내 좌표). 모르면 null */
  me: LatLngLike | null | undefined;
  /** 친구 마커 목록 안에 '나' 마커가 좌표와 함께 이미 그려지는가 */
  meMarkerShown: boolean;
  /** OS 가 기기 위치 점(showsUserLocation)을 그리는가 */
  locationGranted: boolean;
}

export interface MePlan {
  /** 자동 맞춤 영역에 넣을 내 좌표. '나' 마커가 이미 영역에 들어가면 null */
  fit: LatLngLike | null;
  /** 우리가 따로 점을 그릴지. OS 점이 그려지면(locationGranted) 겹치지 않게 그리지 않는다 */
  drawDot: boolean;
}

function plottable(p: LatLngLike | null | undefined): p is LatLngLike {
  return (
    !!p &&
    typeof p.lat === 'number' &&
    typeof p.lng === 'number' &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}

/**
 * 내 위치를 어떻게 다룰지. 그리는 것(drawDot)과 영역에 넣는 것(fit)은 따로다 —
 * OS 파란 점이 그려져도 영역 계산은 그 점을 모르므로 내 좌표는 fit 에 계속 넣어야 한다.
 */
export function mePlan({ me, meMarkerShown, locationGranted }: MePlanInput): MePlan {
  if (meMarkerShown || !plottable(me)) return { fit: null, drawDot: false };
  return { fit: { lat: me.lat, lng: me.lng }, drawDot: !locationGranted };
}

// ───────────────────────── 안드로이드 사용자 정의 마커 비트맵 ─────────────────────────

/**
 * react-native-maps 1.20.1 은 New Arch 에서 레거시 interop 으로 돌아 안드로이드 마커가 자기 크기를 받지 못한다.
 * 그러면 MapMarker.createDrawable() 이 밀도와 상관없이 100x100px 비트맵에 뷰를 왼쪽 위 기준으로 그린다.
 */
export const ANDROID_MARKER_BITMAP_PX = 100;

/** 100px 비트맵과 같은 크기의 정사각형 상자(dp). 내용을 이 상자 가운데에 두면 anchor 0.5/0.5 가 맞는다 */
export function androidMarkerBoxDp(pixelRatio: number): number {
  const pr = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  return ANDROID_MARKER_BITMAP_PX / pr;
}

/** 상자에 들어가게 줄인 내용 크기(dp). 고밀도(3.125 초과)에서 32dp 원이 100px 을 넘어 잘리지 않게 */
export function fitMarkerContentDp(desiredDp: number, pixelRatio: number): number {
  const box = androidMarkerBoxDp(pixelRatio);
  // 테두리 안티앨리어싱이 잘리지 않게 1dp 여유
  return Math.max(1, Math.min(desiredDp, Math.floor(box - 1)));
}
