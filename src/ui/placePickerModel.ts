/**
 * 위치 정하기(PlacePicker.native.tsx)의 판단 로직 — 순수 함수(테스트 있음). react-native·expo 를 import 하지 않는다.
 *
 * - 지도를 쓸지(iOS 애플 지도 / 안드로이드는 구글 지도 키가 있을 때만)
 * - 검색창을 보일지(카카오 키·플랫폼·위치 권한)
 * - 핀(지도 중심) 계산·같은 자리 판정·검색으로 고른 이름을 언제까지 유지할지
 * - 지도 영역(반경 원이 적당히 보이는 확대 수준)
 * - '핀에서 가장 가까운 주소' 한 줄 만들기(reverseGeocodeAsync 결과)
 */
import { haversineMeters, isValidGeoPoint, type GeoPoint } from '../domain/geo';

/** 핀이 아직 없고 현재 위치도 모를 때의 지도 중심 — 서울시청 */
export const DEFAULT_CENTER: GeoPoint = { lat: 37.566535, lng: 126.977969 };
/** 핀이 없을 때의 지도 폭(도) — 구 몇 개가 보이는 정도 */
export const DEFAULT_SPAN_DEG = 0.03;
/** 반경 원 지름이 지도 짧은 변에서 차지할 비율 */
export const CIRCLE_SHARE = 0.4;
const MIN_SPAN_DEG = 0.002;
const MAX_SPAN_DEG = 0.5;
const METERS_PER_DEG_LAT = 111_320;

/** 이보다 덜 움직였으면 같은 자리로 본다(애니메이션 뒤 부동소수 흔들림·첫 로드 이벤트 무시) */
export const SAME_SPOT_M = 2;
/** 검색·프리셋으로 고른 장소에서 이만큼 안에서 핀을 미세 조정하면 그 이름을 유지한다 */
export const KEEP_NAME_WITHIN_M = 100;
/** [현재 위치로]의 정확도가 이보다 나쁘면 "대략적인 위치예요" 안내를 붙인다 */
export const ROUGH_FIX_M = 200;
/** 주소 한 줄 최대 길이(글자) */
const MAX_ADDRESS_CHARS = 80;

/** react-native-maps 의 Region 과 같은 모양 */
export interface MapRegion {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

export type PickerOs = 'ios' | 'android' | 'web' | string;
/** OS 위치 권한을 이 화면이 쓰는 세 값으로 줄인 것 */
export type PickerPermission = 'granted' | 'denied' | 'undetermined';
export type PlaceSearchMode = 'kakao' | 'geocoder' | 'hidden';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** 경도를 [-180, 180) 으로 접는다(날짜변경선을 넘겨 끌면 지도가 범위 밖 값을 줄 수 있다) */
export function wrapLng(lng: number): number {
  if (!Number.isFinite(lng)) return Number.NaN;
  if (lng >= -180 && lng <= 180) return lng;
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** 좌표를 소수 6자리(약 0.1m)로 — 핀 값이 부동소수 꼬리로 흔들리지 않게 */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** 지도 영역의 중심 = 핀. 이상하면 null */
export function regionCenter(region: Partial<MapRegion> | null | undefined): GeoPoint | null {
  if (!region) return null;
  const lat = typeof region.latitude === 'number' ? region.latitude : Number.NaN;
  const lng = typeof region.longitude === 'number' ? wrapLng(region.longitude) : Number.NaN;
  const p = { lat: round6(lat), lng: round6(lng) };
  return isValidGeoPoint(p) ? p : null;
}

/**
 * center 를 가운데 두고 반경 원이 짧은 변의 약 40%를 차지하는 영역. radiusM 이 없거나 이상하면 DEFAULT_SPAN_DEG.
 * 경도 폭은 위도에 따라 늘려서 가로·세로가 같은 땅 거리를 덮게 한다(지도가 화면비에 맞춰 더 넓게 맞춘다).
 */
export function regionAround(center: GeoPoint, radiusM?: number | null): MapRegion {
  const latSpan =
    typeof radiusM === 'number' && Number.isFinite(radiusM) && radiusM > 0
      ? clamp((2 * radiusM) / CIRCLE_SHARE / METERS_PER_DEG_LAT, MIN_SPAN_DEG, MAX_SPAN_DEG)
      : DEFAULT_SPAN_DEG;
  const cos = Math.cos((center.lat * Math.PI) / 180);
  const lngSpan = clamp(latSpan / Math.max(cos, 0.05), MIN_SPAN_DEG, 2 * MAX_SPAN_DEG);
  return { latitude: center.lat, longitude: center.lng, latitudeDelta: latSpan, longitudeDelta: lngSpan };
}

/** 두 점이 tolM 안이면 같은 자리. 한쪽이라도 없으면 false */
export function isSameSpot(a: GeoPoint | null | undefined, b: GeoPoint | null | undefined, tolM = SAME_SPOT_M): boolean {
  if (!a || !b) return false;
  return haversineMeters(a, b) <= tolM;
}

/**
 * 지도가 멈췄을 때 그 중심을 새 핀으로 올려 보낼지.
 * - 사용자가 지도를 만진 뒤에만(첫 로드·코드가 옮긴 이동으로 핀이 저절로 생기지 않게 — 핀 확정은 사용자가 눈으로 보고 한다)
 * - 지금 핀과 같은 자리면 보내지 않는다
 */
export function shouldEmitCenter(interacted: boolean, center: GeoPoint | null, current: GeoPoint | null): boolean {
  if (!interacted || !center) return false;
  return !isSameSpot(center, current);
}

/** 검색·프리셋으로 고른 장소 근처(KEEP_NAME_WITHIN_M)에서 핀을 미세 조정하면 그 이름을 유지한다 */
export function nameForCenter(
  picked: { name: string; lat: number; lng: number } | null | undefined,
  center: GeoPoint,
): string | undefined {
  if (!picked || picked.name.trim() === '') return undefined;
  return haversineMeters(picked, center) <= KEEP_NAME_WITHIN_M ? picked.name : undefined;
}

/** 지도를 쓰는가: iOS 는 애플 지도(키 불필요), 안드로이드는 구글 지도 키가 빌드에 있을 때만. 그 밖(웹)은 아니다 */
export function usesNativeMap(os: PickerOs, hasGoogleMapsKey: boolean): boolean {
  if (os === 'ios') return true;
  if (os === 'android') return hasGoogleMapsKey;
  return false;
}

/**
 * 검색창 모드(설계서 §5.3-C).
 * - 카카오 키가 있으면 상호 검색(kakao). 실패하면 placeSearch 가 geocoder 로 폴백한다.
 * - 키가 없으면 geocoder(주소 위주). iOS 는 권한 없이 된다.
 * - 안드로이드는 geocoder 에 위치 권한이 필요하다 → 거부했으면 검색창을 숨기고 핀 방식만(hidden).
 *   아직 안 물었으면(undetermined) 보이고, 검색할 때 권한을 묻는다.
 */
export function placeSearchMode(os: PickerOs, hasKakaoKey: boolean, permission: PickerPermission): PlaceSearchMode {
  if (hasKakaoKey) return 'kakao';
  if (os === 'android' && permission === 'denied') return 'hidden';
  return 'geocoder';
}

/** 이 OS 에서 geocode·reverseGeocode 를 부르기 전에 위치 권한이 있어야 하는가(안드로이드만) */
export function geocoderNeedsPermission(os: PickerOs, permission: PickerPermission): boolean {
  return os === 'android' && permission !== 'granted';
}

/** expo-location getForegroundPermissionsAsync 결과 → 세 값 */
export function toPickerPermission(res: { status?: unknown; granted?: unknown } | null | undefined): PickerPermission {
  if (!res) return 'undetermined';
  if (res.granted === true || res.status === 'granted') return 'granted';
  if (res.status === 'denied') return 'denied';
  return 'undetermined';
}

/**
 * 공용 권한 모듈(@/lateBet/permissions 의 LocationPermissionState.status) → 세 값.
 * blocked(영구 거부)는 denied 로 접는다 — 다시 물을지는 호출자가 canAskAgain 으로 가른다.
 * unavailable(모듈 없음 등)은 undetermined(권한 상태를 모른다).
 */
export function pickerPermissionFromStatus(status: string | null | undefined): PickerPermission {
  if (status === 'granted') return 'granted';
  if (status === 'denied' || status === 'blocked') return 'denied';
  return 'undetermined';
}

/** reverseGeocodeAsync 결과(LocationGeocodedAddress)의 필요한 부분 */
export interface AddressLike {
  formattedAddress?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  subregion?: string | null;
  district?: string | null;
  street?: string | null;
  streetNumber?: string | null;
  name?: string | null;
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

function clip(text: string): string {
  const chars = Array.from(text);
  return chars.length > MAX_ADDRESS_CHARS ? `${chars.slice(0, MAX_ADDRESS_CHARS - 1).join('')}…` : text;
}

/**
 * '핀에서 가장 가까운 주소' 한 줄. 모르면 ''(화면은 줄을 생략한다).
 * - 안드로이드는 formattedAddress 를 쓰고 앞·뒤의 나라 이름을 뗀다
 * - iOS 는 시도 → 시 → 구 → 동 → 도로명+번지(없으면 name) 순으로 겹치는 조각을 빼고 잇는다
 */
export function formatNearestAddress(a: AddressLike | null | undefined): string {
  if (!a) return '';
  const country = clean(a.country);
  const formatted = clean(a.formattedAddress);
  if (formatted !== '') {
    let t = formatted;
    if (country !== '') {
      if (t.startsWith(`${country} `)) t = t.slice(country.length + 1);
      else if (t.endsWith(`, ${country}`)) t = t.slice(0, -(country.length + 2));
    }
    t = t.trim();
    if (t !== '' && t !== country) return clip(t);
  }
  const parts: string[] = [];
  for (const p of [a.region, a.city, a.subregion, a.district].map(clean)) {
    if (p !== '' && !parts.includes(p)) parts.push(p);
  }
  const street = clean(a.street);
  const number = clean(a.streetNumber);
  const tail = street !== '' ? (number !== '' ? `${street} ${number}` : street) : clean(a.name);
  if (tail !== '' && !parts.includes(tail)) parts.push(tail);
  return clip(parts.join(' '));
}

/**
 * 핀이 옮길 수 있는 한도(시작한 약속의 '처음 핀에서 N m', 공정성 규칙 R2) 안인가.
 * 한도가 없으면(center 없음) 항상 안이다. 거리는 서버와 같은 haversine
 */
export function pinLimitStatus(
  value: GeoPoint | null | undefined,
  center: GeoPoint | null | undefined,
  radiusM: number | null | undefined,
): { distanceM: number | null; over: boolean } {
  if (!value || !center || typeof radiusM !== 'number' || !Number.isFinite(radiusM)) return { distanceM: null, over: false };
  const distanceM = haversineMeters(center, value);
  return { distanceM, over: distanceM > radiusM };
}
