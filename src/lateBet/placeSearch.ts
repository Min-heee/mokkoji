/**
 * 장소 검색 (설계서 §5.3-C, §5.1 placeSearch) — 순수 로직 + 주입 가능한 입출력.
 *
 * searchPlaces(query, near?, deps):
 * 1. 카카오 REST 키(EXPO_PUBLIC_KAKAO_REST_KEY)가 있으면 카카오 로컬 키워드 검색으로 상호·장소를 찾는다.
 *    - near(지도 중심)가 있으면 '근처 20km 거리순'과 '전국 정확도순'을 같이 물어 근처 결과를 앞에 둔다
 *      (근처만 물으면 부산에서 '서울역'을 찾을 때 엉뚱한 가게만 나온다).
 *    - 헤더 Authorization: KakaoAK {키}. 키는 URL 에 싣지 않는다. 요청마다 6초 타임아웃.
 * 2. 키가 없거나, 카카오가 실패했거나, 카카오 결과가 0건이면 주입된 geocoder(네이티브: expo-location geocodeAsync —
 *    주소 위주)로 한 번 더 찾는다. 안드로이드 geocodeAsync 는 위치 권한이 있어야 하므로 실패하면 조용히 빈 결과다.
 * 3. 둘 다 실패하면 []. 이 함수는 던지지 않는다.
 *
 * 결과는 이름·주소·좌표·출처로 정규화하고, 좌표가 이상하면(범위 밖·NaN·빈 문자열·0,0) 버리고, 중복을 뺀다.
 *
 * 이 파일은 react-native·expo 모듈을 import 하지 않는다(node:test 로 돈다). 네이티브 geocoder 는 부르는 쪽
 * (src/ui/PlacePicker.native.tsx)이 deps.geocode 로 넣는다. 웹 번들에서는 import 하지 않는다(카카오 키가 웹 번들에 실리지 않게).
 */
import { haversineMeters, isValidGeoPoint, type GeoPoint } from '../domain/geo';

/** 번들 시점에 글자 그대로 치환되므로 반드시 이렇게 정적으로 적는다 */
const ENV_KAKAO_REST_KEY = (process.env.EXPO_PUBLIC_KAKAO_REST_KEY ?? '').trim();

export const KAKAO_KEYWORD_URL = 'https://dapi.kakao.com/v2/local/search/keyword.json';
/** 카카오 요청 하나의 타임아웃 */
export const PLACE_SEARCH_TIMEOUT_MS = 6_000;
/** 카카오 radius 상한(m). '근처' 검색의 반경 */
export const NEAR_RADIUS_M = 20_000;
/** 카카오 size 상한 */
const KAKAO_PAGE_SIZE = 15;
/** 합친 결과 중 근처 결과를 최대 몇 개까지 앞에 둘지(전국 결과가 밀려나지 않게) */
const NEAR_MAX = 10;
/** 돌려주는 결과 최대 수 */
export const MAX_PLACE_RESULTS = 15;
/** 검색어 최대 길이(글자). 넘으면 자른다 */
export const MAX_QUERY_LENGTH = 100;

export type PlaceSource = 'kakao' | 'geocoder';

export interface PlaceSearchResult {
  /** 목록 key·중복 제거용. 'kakao:<id>' 또는 'geo:<lat>,<lng>' */
  id: string;
  /** 표시 이름. 카카오는 상호명, geocoder 는 검색어 */
  name: string;
  /** 도로명 주소(없으면 지번). geocoder 결과는 '' */
  address: string;
  lat: number;
  lng: number;
  source: PlaceSource;
  /** near 에서의 거리(m). near 가 없으면 null */
  distanceM: number | null;
}

/** expo-location geocodeAsync 결과의 필요한 부분(LocationGeocodedLocation) */
export interface GeocodedPoint {
  latitude: number;
  longitude: number;
}

/** fetch 의 필요한 부분만(테스트에서 가짜를 넣기 쉽게) */
export type FetchLike = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface PlaceSearchDeps {
  /** 카카오 REST 키. undefined 면 EXPO_PUBLIC_KAKAO_REST_KEY, null·'' 이면 카카오를 쓰지 않는다 */
  kakaoKey?: string | null;
  /** 기본 globalThis.fetch */
  fetch?: FetchLike | null;
  /** 주소 → 좌표. 네이티브는 expo-location geocodeAsync. 없으면(null) 폴백 없음 */
  geocode?: ((query: string) => Promise<readonly GeocodedPoint[]>) | null;
  /** 카카오 요청 하나의 타임아웃(ms). 기본 6초 */
  timeoutMs?: number;
}

/** 이 빌드에 카카오 키가 있는가(검색창 표시 규칙용) */
export function hasKakaoKey(key: string | null | undefined = ENV_KAKAO_REST_KEY): boolean {
  return typeof key === 'string' && key.trim() !== '';
}

/** 검색어 정리: 앞뒤 공백·연속 공백 정리, 길이 제한. 비면 '' */
export function normalizeQuery(query: unknown): string {
  if (typeof query !== 'string') return '';
  const t = query.replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, MAX_QUERY_LENGTH).join('');
}

/**
 * 좌표로 쓸 수 있는가: 유한수·범위 안이고 (0,0)이 아닐 것.
 * (0,0)은 실제 약속 장소일 리 없고 파싱 실패의 흔한 흔적이라 버린다.
 */
export function isUsablePoint(p: unknown): p is GeoPoint {
  return isValidGeoPoint(p) && !(p.lat === 0 && p.lng === 0);
}

/** 카카오의 문자열 좌표 → 숫자. 빈 문자열·숫자 아닌 글자는 NaN(Number('') 이 0 이 되는 함정을 피한다) */
function parseCoordText(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return Number.NaN;
  const t = v.trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : Number.NaN;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

function distanceFrom(near: GeoPoint | null, lat: number, lng: number): number | null {
  if (!near) return null;
  const d = haversineMeters(near, { lat, lng });
  return Number.isFinite(d) ? Math.round(d) : null;
}

/** 카카오 응답 → 정규화된 결과(이상한 행은 버린다). 응답 모양이 틀리면 [] */
export function parseKakaoDocuments(body: unknown, near: GeoPoint | null): PlaceSearchResult[] {
  if (!body || typeof body !== 'object') return [];
  const docs = (body as { documents?: unknown }).documents;
  if (!Array.isArray(docs)) return [];
  const out: PlaceSearchResult[] = [];
  for (const d of docs) {
    if (!d || typeof d !== 'object') continue;
    const doc = d as Record<string, unknown>;
    const name = str(doc.place_name);
    const lat = parseCoordText(doc.y);
    const lng = parseCoordText(doc.x);
    if (name === '' || !isUsablePoint({ lat, lng })) continue;
    const rawId = str(doc.id);
    out.push({
      id: rawId !== '' ? `kakao:${rawId}` : `kakao:${lat.toFixed(6)},${lng.toFixed(6)}`,
      name,
      address: str(doc.road_address_name) || str(doc.address_name),
      lat,
      lng,
      source: 'kakao',
      distanceM: distanceFrom(near, lat, lng),
    });
  }
  return out;
}

/** geocoder 결과 → 정규화(이름은 검색어). near 가 있으면 가까운 순 */
export function fromGeocoded(points: unknown, query: string, near: GeoPoint | null): PlaceSearchResult[] {
  if (!Array.isArray(points)) return [];
  const out: PlaceSearchResult[] = [];
  for (const p of points) {
    if (!p || typeof p !== 'object') continue;
    const { latitude, longitude } = p as Partial<GeocodedPoint>;
    const lat = typeof latitude === 'number' ? latitude : Number.NaN;
    const lng = typeof longitude === 'number' ? longitude : Number.NaN;
    if (!isUsablePoint({ lat, lng })) continue;
    out.push({
      id: `geo:${lat.toFixed(6)},${lng.toFixed(6)}`,
      name: query,
      address: '',
      lat,
      lng,
      source: 'geocoder',
      distanceM: distanceFrom(near, lat, lng),
    });
  }
  if (near) {
    // 같은 거리면 원래 순서(정렬은 안정적이다)
    out.sort((a, b) => (a.distanceM ?? Number.POSITIVE_INFINITY) - (b.distanceM ?? Number.POSITIVE_INFINITY));
  }
  return out;
}

/** 같은 id, 또는 같은 이름 + 약 1m 안의 같은 좌표면 중복. 앞의 것을 남긴다 */
export function dedupePlaces(list: readonly PlaceSearchResult[]): PlaceSearchResult[] {
  const seen = new Set<string>();
  const out: PlaceSearchResult[] = [];
  for (const r of list) {
    const spot = `${r.name}|${r.lat.toFixed(5)}|${r.lng.toFixed(5)}`;
    if (seen.has(r.id) || seen.has(spot)) continue;
    seen.add(r.id);
    seen.add(spot);
    out.push(r);
  }
  return out;
}

/** 카카오 요청 URL. 좌표는 near 가 유효할 때만 싣는다 */
export function kakaoKeywordUrl(query: string, near: GeoPoint | null): string {
  const params: [string, string][] = [
    ['query', query],
    ['size', String(KAKAO_PAGE_SIZE)],
  ];
  if (near) {
    params.push(['x', near.lng.toFixed(6)], ['y', near.lat.toFixed(6)], ['radius', String(NEAR_RADIUS_M)], ['sort', 'distance']);
  } else {
    params.push(['sort', 'accuracy']);
  }
  // RN 의 URLSearchParams 는 불완전하다 — 직접 인코딩한다
  return `${KAKAO_KEYWORD_URL}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

/** 요청 하나. 실패(네트워크·HTTP 오류·타임아웃·JSON 파싱)는 던진다 */
async function fetchKakao(
  fetchFn: FetchLike,
  key: string,
  query: string,
  near: GeoPoint | null,
  timeoutMs: number,
): Promise<PlaceSearchResult[]> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error('kakao timeout'));
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      fetchFn(kakaoKeywordUrl(query, near), {
        method: 'GET',
        headers: { Authorization: `KakaoAK ${key}` },
        ...(controller ? { signal: controller.signal } : {}),
      }),
      timeout,
    ]);
    if (!res || !res.ok) throw new Error(`kakao http ${res?.status}`);
    const body = await Promise.race([res.json(), timeout]);
    if (!body || typeof body !== 'object' || !Array.isArray((body as { documents?: unknown }).documents)) {
      throw new Error('kakao bad body');
    }
    return parseKakaoDocuments(body, near);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 카카오 키워드 검색. near 가 있으면 근처(거리순)·전국(정확도순)을 같이 물어 근처를 앞에 둔다.
 * 둘 다 실패하면 null(= 폴백하라), 하나라도 성공하면 결과(0건일 수 있음).
 */
async function searchKakao(
  fetchFn: FetchLike,
  key: string,
  query: string,
  near: GeoPoint | null,
  timeoutMs: number,
): Promise<PlaceSearchResult[] | null> {
  const attempt = (n: GeoPoint | null) =>
    fetchKakao(fetchFn, key, query, n, timeoutMs).then(
      (r) => ({ ok: true as const, r }),
      () => ({ ok: false as const, r: [] as PlaceSearchResult[] }),
    );
  if (!near) {
    const all = await attempt(null);
    return all.ok ? all.r : null;
  }
  const [nearby, all] = await Promise.all([attempt(near), attempt(null)]);
  if (!nearby.ok && !all.ok) return null;
  // 전국 결과에도 near 기준 거리를 붙인다(목록에 거리를 같이 보여 준다)
  const allWithDistance = all.r.map((r) => ({ ...r, distanceM: distanceFrom(near, r.lat, r.lng) }));
  return dedupePlaces([...nearby.r.slice(0, NEAR_MAX), ...allWithDistance]);
}

async function searchGeocoder(
  geocode: PlaceSearchDeps['geocode'],
  query: string,
  near: GeoPoint | null,
): Promise<PlaceSearchResult[]> {
  if (!geocode) return [];
  try {
    return dedupePlaces(fromGeocoded(await geocode(query), query, near));
  } catch {
    return [];
  }
}

/**
 * 장소 검색. 던지지 않는다 — 실패는 빈 배열이다(화면은 "찾지 못했어요. 지도를 움직여 핀을 맞춰주세요").
 * near 는 지금 지도 중심(없으면 null). 좌표가 이상하면 무시한다.
 */
export async function searchPlaces(
  query: string,
  near?: GeoPoint | null,
  deps: PlaceSearchDeps = {},
): Promise<PlaceSearchResult[]> {
  const q = normalizeQuery(query);
  if (q === '') return [];
  const center = isUsablePoint(near) ? { lat: near.lat, lng: near.lng } : null;
  const key = deps.kakaoKey === undefined ? ENV_KAKAO_REST_KEY : (deps.kakaoKey ?? '').trim();
  const fetchFn: FetchLike | null =
    deps.fetch === undefined
      ? typeof globalThis.fetch === 'function'
        ? (globalThis.fetch.bind(globalThis) as unknown as FetchLike)
        : null
      : deps.fetch;
  const timeoutMs =
    typeof deps.timeoutMs === 'number' && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
      ? deps.timeoutMs
      : PLACE_SEARCH_TIMEOUT_MS;

  if (key !== '' && fetchFn) {
    const kakao = await searchKakao(fetchFn, key, q, center, timeoutMs);
    if (kakao && kakao.length > 0) return kakao.slice(0, MAX_PLACE_RESULTS);
    // 실패했거나 0건 — 주소일 수 있으니 geocoder 로 한 번 더
  }
  return (await searchGeocoder(deps.geocode, q, center)).slice(0, MAX_PLACE_RESULTS);
}

/** 목록에 보일 거리: 850 → '850m', 1234 → '1.2km', 25000 → '25km'. 모르면 '' */
export function formatPlaceDistance(m: number | null | undefined): string {
  if (typeof m !== 'number' || !Number.isFinite(m) || m < 0) return '';
  if (m < 1000) return `${Math.round(m)}m`;
  if (m < 10_000) return `${(m / 1000).toFixed(1)}km`;
  return `${Math.round(m / 1000)}km`;
}
