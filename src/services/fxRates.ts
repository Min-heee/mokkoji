import AsyncStorage from '@react-native-async-storage/async-storage';

import { CURRENCIES } from '@/domain/currency';

/**
 * 실시간 환율 서비스.
 * open.er-api.com (무료·무키, 일 1회 고시)에서 KRW 기준 환율을 받아
 * "1 외화 = X원" 방향으로 뒤집어 캐시한다. 오프라인이면 캐시로 폴백.
 */

export interface FxSnapshot {
  /** 1 <통화코드> = rates[code] 원 */
  rates: Record<string, number>;
  /** API 고시 시각 (ms) */
  publishedAt: number;
  /** 받아온 시각 (ms) */
  fetchedAt: number;
}

export type FxSource = 'live' | 'cache' | 'none';

export interface FxResult {
  snapshot: FxSnapshot | null;
  source: FxSource;
  /** 신선 기준(12h)을 지난 캐시로 응답했는지 */
  stale: boolean;
}

const CACHE_KEY = 'nbbang.fxRates.v1';
const API_URL = 'https://open.er-api.com/v6/latest/KRW';
const FETCH_TIMEOUT_MS = 8000;

/** API가 일 1회 갱신이므로 12시간이면 충분히 신선하다 */
export const FRESH_MS = 12 * 60 * 60 * 1000;

/** KRW→외화 고시값을 "1 외화 = X원"으로 뒤집는다. 유효하지 않으면 null */
export function invertRate(krwToForeign: unknown): number | null {
  if (typeof krwToForeign !== 'number' || !Number.isFinite(krwToForeign) || krwToForeign <= 0) {
    return null;
  }
  const inverted = 1 / krwToForeign;
  if (!Number.isFinite(inverted)) return null;
  // JPY 9.3691, VND 0.058 같은 값이 자연스럽게 나오도록 유효숫자 5자리
  return Number(inverted.toPrecision(5));
}

/** API 응답 → 스냅샷. 형태가 어긋나면 null (부분 실패는 해당 통화만 제외) */
export function parseApiResponse(json: unknown, now: number): FxSnapshot | null {
  if (!json || typeof json !== 'object') return null;
  const body = json as {
    result?: unknown;
    rates?: Record<string, unknown>;
    time_last_update_unix?: unknown;
  };
  if (body.result !== 'success' || !body.rates || typeof body.rates !== 'object') return null;

  const rates: Record<string, number> = {};
  for (const { code } of CURRENCIES) {
    if (code === 'KRW') continue;
    const inverted = invertRate(body.rates[code]);
    if (inverted != null) rates[code] = inverted;
  }
  if (Object.keys(rates).length === 0) return null;

  const publishedAt =
    typeof body.time_last_update_unix === 'number' && body.time_last_update_unix > 0
      ? body.time_last_update_unix * 1000
      : now;
  return { rates, publishedAt, fetchedAt: now };
}

export function isFresh(snapshot: FxSnapshot, now: number): boolean {
  return now - snapshot.fetchedAt < FRESH_MS;
}

/**
 * 캐시에서 읽은 값 검증: 손상·조작된 캐시가 "영원히 신선"하게 남거나
 * (미래 fetchedAt) 비숫자 환율이 세션 데이터로 흘러들지 않게 한다.
 */
export function sanitizeSnapshot(parsed: unknown, now: number): FxSnapshot | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Partial<FxSnapshot>;
  if (!p.rates || typeof p.rates !== 'object') return null;
  const rates: Record<string, number> = {};
  for (const [code, value] of Object.entries(p.rates)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      rates[code] = value;
    }
  }
  if (Object.keys(rates).length === 0) return null;
  const fetchedAt =
    typeof p.fetchedAt === 'number' && Number.isFinite(p.fetchedAt) && p.fetchedAt <= now
      ? p.fetchedAt
      : null;
  if (fetchedAt == null) return null;
  const publishedAt =
    typeof p.publishedAt === 'number' && Number.isFinite(p.publishedAt)
      ? p.publishedAt
      : fetchedAt;
  return { rates, publishedAt, fetchedAt };
}

export async function loadCachedFx(): Promise<FxSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return sanitizeSnapshot(JSON.parse(raw), Date.now());
  } catch {
    return null;
  }
}

async function saveCachedFx(snapshot: FxSnapshot): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // 캐시 실패는 무시 — 다음 성공 때 다시 저장된다
  }
}

/** 네트워크에서 환율을 받아 캐시까지 저장. 실패 시 throw */
export async function fetchLiveFx(fetchImpl: typeof fetch = fetch): Promise<FxSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(API_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`fx api http ${res.status}`);
    const snapshot = parseApiResponse(await res.json(), Date.now());
    if (!snapshot) throw new Error('fx api malformed response');
    await saveCachedFx(snapshot);
    return snapshot;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 환율 얻기: 신선한 캐시 → 그대로, 아니면 네트워크 → 실패하면 묵은 캐시라도.
 * 어떤 경로였는지(source/stale)를 함께 반환해 UI가 기준 시각을 표시할 수 있게 한다.
 */
export async function getFxRates(options?: { forceRefresh?: boolean }): Promise<FxResult> {
  const cached = await loadCachedFx();
  const now = Date.now();
  if (cached && isFresh(cached, now) && !options?.forceRefresh) {
    return { snapshot: cached, source: 'cache', stale: false };
  }
  try {
    const live = await fetchLiveFx();
    return { snapshot: live, source: 'live', stale: false };
  } catch {
    if (cached) return { snapshot: cached, source: 'cache', stale: !isFresh(cached, now) };
    return { snapshot: null, source: 'none', stale: true };
  }
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 고시 시각 표시용 — 항상 한국시간(KST, UTC+9 고정) 기준.
 * 해외 여행 중 기기 시간대가 바뀌어도 표시가 흔들리지 않는다.
 * 오늘/어제는 "오늘 09:02", 그 이전은 "7/6 09:02".
 */
export function formatFxTimestamp(ms: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(ms)) return '';
  const kst = new Date(ms + KST_OFFSET_MS);
  if (Number.isNaN(kst.getTime())) return '';
  const hh = `${kst.getUTCHours()}`.padStart(2, '0');
  const mm = `${kst.getUTCMinutes()}`.padStart(2, '0');

  const sameKstDay = (a: Date, b: Date) =>
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate();
  const nowKst = new Date(nowMs + KST_OFFSET_MS);
  const yesterdayKst = new Date(nowMs - 24 * 60 * 60 * 1000 + KST_OFFSET_MS);

  const day = sameKstDay(kst, nowKst)
    ? '오늘'
    : sameKstDay(kst, yesterdayKst)
      ? '어제'
      : `${kst.getUTCMonth() + 1}/${kst.getUTCDate()}`;
  return `${day} ${hh}:${mm}`;
}
