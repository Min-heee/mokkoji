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

// ───────────────────────── 도착 인정 거리 칩(지도 아래) ─────────────────────────

/** 위치 정하기 화면의 기본 거리 칩(m) */
export const RADIUS_PICKER_CHOICES: readonly number[] = [50, 100, 200, 300, 500];
/** 원이 없을 때(모임 약속) 지도 확대 수준을 잡는 기준 반경 — 동네 몇 블록 */
export const FRAMING_RADIUS_M = 100;
/** 원 지름이 지도 짧은 변의 이 비율을 넘으면 원이 잘려 보인다 → 줌 아웃 */
export const CIRCLE_FIT_MAX_SHARE = 0.8;
/** 원 지름이 지도 짧은 변의 이 비율보다 작으면 점처럼 보인다 → 줌 인 */
export const CIRCLE_FIT_MIN_SHARE = 0.1;

/** 칩·원으로 쓸 수 있는 반경인가(양의 정수) */
export function isUsableRadius(m: unknown): m is number {
  return typeof m === 'number' && Number.isInteger(m) && m > 0;
}

/**
 * 칩 목록: 기본 목록 + 현재 값(목록에 없으면 끼운다). 오름차순·중복 없음·이상한 값 제외.
 * 현재 값이 없거나 이상하면 기본 목록만
 */
export function radiusChipList(base: readonly number[], current: number | null | undefined): number[] {
  const set = new Set<number>();
  for (const m of base) if (isUsableRadius(m)) set.add(m);
  if (isUsableRadius(current)) set.add(current);
  return [...set].sort((a, b) => a - b);
}

/** 칩 하나를 눌렀을 때의 새 반경. 잠겨 있거나 이상한 값이면 지금 값 그대로 */
export function pickRadius(locked: boolean | undefined, current: number, picked: number): number {
  if (locked) return current;
  return isUsableRadius(picked) ? picked : current;
}

/** 지도 영역의 짧은 변(m). 이상하면 null */
export function regionShortSideM(region: MapRegion | null | undefined): number | null {
  if (!region) return null;
  const { latitude, latitudeDelta, longitudeDelta } = region;
  if (![latitude, latitudeDelta, longitudeDelta].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  if (latitudeDelta <= 0 || longitudeDelta <= 0) return null;
  const heightM = latitudeDelta * METERS_PER_DEG_LAT;
  const widthM = longitudeDelta * METERS_PER_DEG_LAT * Math.cos((latitude * Math.PI) / 180);
  const short = Math.min(heightM, widthM);
  return short > 0 ? short : null;
}

/**
 * 반경을 바꾼 뒤 지도를 다시 맞출 영역. 지금 보이는 영역에 원이 알맞게 들어 있으면 null(움직이지 않는다).
 * - 원 지름이 짧은 변의 80%를 넘으면(잘림) 또는 10%보다 작으면(점) → regionAround(center, radiusM):
 *   원 지름이 짧은 변의 40% = 중심에서 반경의 2.5배까지 보인다.
 * - 지금 영역을 모르면 맞춘다
 */
export function radiusRefitRegion(
  current: MapRegion | null | undefined,
  center: GeoPoint,
  radiusM: number | null | undefined,
): MapRegion | null {
  if (!isUsableRadius(radiusM)) return null;
  const short = regionShortSideM(current);
  if (short === null) return regionAround(center, radiusM);
  const share = (2 * radiusM) / short;
  if (share > CIRCLE_FIT_MAX_SHARE || share < CIRCLE_FIT_MIN_SHARE) return regionAround(center, radiusM);
  return null;
}

/** 칩 아래 한 줄 */
export function radiusSentence(radiusM: number): string {
  return `핀에서 ${radiusM}m 안에 들어오면 도착이에요`;
}

// ───────────────────────── 약속 잡기 폼의 장소 이름 채우기 ─────────────────────────

export interface FillPlaceNameInput {
  /** 지금 폼에 적힌 이름 */
  current: string;
  /** 사용자가 이름 칸을 직접 고친 적이 있는가(저장된 약속에서 불러온 이름도 사용자 것으로 본다) */
  edited: boolean;
  /** 위치 정하기 화면이 돌려준 이름·출처 */
  name?: string | null;
  nameSource?: 'search' | 'address' | 'none' | null;
  /**
   * 위치 정하기 화면의 이름 칸에 보이던 그대로인가(지도 없는 폴백). true 면 edited 와 상관없이 이 이름으로 바꾼다 —
   * 사용자가 그 화면에서 보고 적은(고른) 이름이라 '고친 이름 지키기'로 버리면 조용히 사라진다
   */
  nameConfirmed?: boolean | null;
  /** 이름 최대 글자 수(넘으면 자른다) */
  maxChars: number;
}

/**
 * 지도에서 돌아왔을 때 폼의 장소 이름.
 * - 위치 정하기 화면의 이름 칸에서 확정한 이름(nameConfirmed)이면 그대로 쓴다(비어 있으면 비운다)
 * - 사용자가 고친 적이 있으면(그리고 칸이 비어 있지 않으면) 건드리지 않는다
 * - 아니면 결과 이름으로 덮는다. nameSource 'none'(또는 이름 없음)이면 칸을 비워 사용자가 적게 한다
 * - 칸을 고쳤다가 다 지웠으면 고치지 않은 것과 같다(빈 칸은 채운다)
 */
export function fillPlaceName({ current, edited, name, nameSource, nameConfirmed, maxChars }: FillPlaceNameInput): string {
  if (!nameConfirmed && edited && current.trim() !== '') return current;
  const picked = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  if (nameSource === 'none' || picked === '') return '';
  const chars = Array.from(picked);
  return chars.length > maxChars ? chars.slice(0, maxChars).join('').trim() : picked;
}

/**
 * 지도 핀의 이름 출처 올리기: 지도를 움직여 'none' 으로 보낸 핀에 역지오코딩 주소가 도착하면 'address' 로 다시 보낸다.
 * 보낼 것이 없으면 null(검색 이름·이미 같은 주소·주소 없음)
 */
export function upgradeWithAddress<
  T extends { lat: number; lng: number; name?: string; nameSource?: 'search' | 'address' | 'none' },
>(
  value: T | null | undefined,
  address: string,
): (T & { name: string; nameSource: 'address' }) | null {
  if (!value || address.trim() === '') return null;
  if (value.nameSource !== 'none') return null;
  return { ...value, name: address.trim(), nameSource: 'address' };
}

/** 주소를 아직 찾는 중인 핀인가(이 동안은 확정하지 않는다 — 확정하면 빈 이름이 폼에 들어간다) */
export function isNamePending<T extends { nameSource?: 'search' | 'address' | 'none'; namePending?: boolean }>(
  value: T | null | undefined,
): boolean {
  return !!value && value.nameSource === 'none' && value.namePending === true;
}

/**
 * 지도를 움직인 핀의 이름 정리 — 가장 가까운 주소 조회가 끝났을 때(또는 주소를 찾을 수 없게 됐을 때) 다시 보낼 값.
 * - 주소가 왔으면: 'address' 로(찾는 중 표시를 뗀다)
 * - 조회가 끝났는데 주소가 없거나(실패·빈 결과), 주소를 찾을 수 없게 됐으면(권한): 찾는 중 표시만 뗀 'none'
 * - 보낼 것이 없으면 null(검색 이름·이미 주소·아직 찾는 중)
 * lookup.settled = 이 핀 좌표에 대한 조회가 끝났는가(성공·실패 모두)
 */
export function settleNearestName<
  T extends { lat: number; lng: number; name?: string; nameSource?: 'search' | 'address' | 'none'; namePending?: boolean },
>(value: T | null | undefined, lookup: { text: string; settled: boolean }, addressPossible: boolean): T | null {
  if (!value || value.nameSource !== 'none') return null;
  const { namePending: _pending, ...rest } = value;
  if (lookup.text.trim() !== '') {
    const up = upgradeWithAddress(rest as T, lookup.text);
    if (up) return up;
  }
  if (value.namePending === true && (lookup.settled || !addressPossible)) return rest as T;
  return null;
}

// ───────────────────────── 도착 인정 거리 직접 적기 ─────────────────────────

/** 직접 적은 거리: 정수이고 [min, max] 안이면 그 값, 아니면 null(서버 CHECK 와 같은 범위) */
export function parseRadiusText(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/**
 * [완료](또는 키보드가 내려감)를 눌렀을 때 직접 적기 줄을 닫을지.
 * 비었거나 올바른 값이면 닫는다(값은 적는 동안 이미 반영됐다). 이상한 값이면 열어 두고 경고를 보인다 —
 * 닫으면 칩으로 고른 옛 값이 말없이 저장된다
 */
export function shouldCloseCustomRadius(text: string, min: number, max: number): boolean {
  return text.trim() === '' || parseRadiusText(text, min, max) !== null;
}
