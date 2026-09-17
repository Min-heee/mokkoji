/**
 * 좌표·거리 계산 (약속 내기의 '도착 판정'용 순수 로직).
 * 지도 SDK·기기 위치 API와 무관하다 — 서버와 클라이언트가 같은 코드로 판정한다.
 */

export interface GeoPoint {
  /** 위도 (도, -90 ~ 90) */
  lat: number;
  /** 경도 (도, -180 ~ 180) */
  lng: number;
}

/** 지구 평균 반지름 (m) */
const EARTH_RADIUS_M = 6_371_008.8;

/**
 * 이보다 부정확한(수평 오차가 큰) GPS 측정값으로는 도착을 인정하지 않는다.
 * 실내·지하에서 오차 수백 m짜리 좌표가 우연히 반경 안에 찍히는 걸 막는다.
 */
export const MAX_ARRIVAL_ACCURACY_M = 100;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** 유한수이고 위도 [-90,90]·경도 [-180,180] 안인지. 저장/네트워크 데이터라 타입을 믿지 않는다 */
export function isValidGeoPoint(p: unknown): p is GeoPoint {
  if (!p || typeof p !== 'object') return false;
  const { lat, lng } = p as Partial<GeoPoint>;
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * 두 좌표 사이 대권 거리(m, haversine).
 * 좌표가 유효하지 않으면 Infinity — '무한히 멀다'로 취급해 어떤 반경 비교도 통과하지 못하게 한다
 * (NaN은 비교식에서 조용히 false가 되어 버그를 숨기므로 쓰지 않는다).
 */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  if (!isValidGeoPoint(a) || !isValidGeoPoint(b)) return Number.POSITIVE_INFINITY;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  // 경도 차는 sin² 안에 들어가므로 날짜변경선(179° ↔ -179°)을 넘어도 그대로 맞는다
  const dLng = toRad(b.lng - a.lng);
  const sLat = Math.sin(dLat / 2);
  const sLng = Math.sin(dLng / 2);
  const h = sLat * sLat + Math.cos(lat1) * Math.cos(lat2) * sLng * sLng;
  // 부동소수 오차로 h가 [0,1]을 살짝 벗어나면 sqrt/asin이 NaN을 낸다(대척점·극지) → 클램프
  const clamped = Math.min(1, Math.max(0, h));
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(clamped));
}

/**
 * pos가 target 반경 radiusM 안에 있는지 (경계 포함).
 * - 좌표·반경이 유효하지 않으면 false
 * - accuracyM(수평 오차, m)이 주어졌는데 MAX_ARRIVAL_ACCURACY_M보다 크거나
 *   쓰레기 값(NaN·음수 — iOS는 무효 측정에 -1을 준다)이면 신뢰 불가 → false
 * - accuracyM이 없으면(null/undefined) 정확도 검사를 건너뛴다
 */
export function isWithinRadius(
  pos: GeoPoint,
  target: GeoPoint,
  radiusM: number,
  accuracyM?: number | null,
): boolean {
  if (!isValidGeoPoint(pos) || !isValidGeoPoint(target)) return false;
  if (typeof radiusM !== 'number' || !Number.isFinite(radiusM) || radiusM < 0) return false;
  if (accuracyM !== undefined && accuracyM !== null) {
    if (typeof accuracyM !== 'number' || !Number.isFinite(accuracyM) || accuracyM < 0) return false;
    if (accuracyM > MAX_ARRIVAL_ACCURACY_M) return false;
  }
  return haversineMeters(pos, target) <= radiusM;
}
