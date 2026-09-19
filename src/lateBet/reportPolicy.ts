/**
 * 위치 보고 정책 — '이 샘플을 지금 보낼까, 다음 전송까지 얼마나 기다릴까'를 정하는 순수 함수 모음.
 * 설계서 §3.3(적응형 전송), §3.4(도착 체크인), §5.4(실패 상태), 원칙 5(좌표는 분 단위 수명).
 *
 * useArrivalReporter(.native) 가 1초 틱과 새 샘플마다 decideReport 를 부르고, 전송 뒤 afterReport 로 상태를 넘긴다.
 * 시각은 전부 인자로 받는다(Date.now() 를 읽지 않는다). 거리는 기기 haversine — 표시·간격용일 뿐 판정은 서버가 한다.
 *
 * 규칙
 * - 샘플 품질: 정확도 1000m 초과·쓰레기 값·좌표 오류 → 버린다(서버도 1000m 넘는 좌표는 저장하지 않는다).
 *   100m 초과(geo.MAX_ARRIVAL_ACCURACY_M) → 보내되 '부정확'(도착 인정은 안 되지만 서버가 '근처에 온 시각'을 기록한다).
 * - 간격(목적지까지 거리): 2km 이상 30초 · 300m~2km 10초 · 300m 안 3초. 거리를 모르면 10초.
 * - 반경 추정 진입(거리 − min(정확도, 300) ≤ 반경): 직전 전송이 밖이었으면 간격을 무시하고 즉시, 계속 안이면 3초.
 * - 제자리(20m 안에서 60초 넘게): 간격을 60초로 늘린다. 친구 화면의 3분 공개 창 안에 머물 만큼만(반경 추정 안은 예외).
 * - 모의 위치: 보낸다(서버가 'mocked' 로 거부 → 사유 표시). 첫 번째는 즉시, 그 뒤 30초. 모의 위치가 꺼지면 즉시 한 번.
 * - 서버가 not_open 을 주면 30초(주최자 시작 전 — 루프는 원래 시작 뒤에만 돈다).
 * - 연속 실패: 3초 → 6초 → 12초 → 24초 → 30초(상한). 실패 중에는 거리 간격 대신 이 백오프를 따른다.
 * - closed · already_arrived 를 받으면 더 보내지 않는다(stop).
 * - 샘플이 10분보다 오래되면 보내지 않는다(watch 가 멈춘 채 옛 좌표를 계속 보내지 않게). 제자리라 새 이벤트가 없는 것은
 *   10분 안이면 같은 좌표를 다시 보내 친구 화면에서 사라지지 않게 한다.
 */
import { haversineMeters, isValidGeoPoint, MAX_ARRIVAL_ACCURACY_M, type GeoPoint } from '@/domain/geo';

import type { LbReportReason } from './types';

// ───────────────────────── 상수 ─────────────────────────

/** 이보다 나쁜 정확도는 버린다(서버도 저장하지 않는다) — '대략적인 위치' */
export const MAX_REPORT_ACCURACY_M = 1000;
/** 이보다 나쁘면 '부정확' — 도착 인정 안 됨(geo.MAX_ARRIVAL_ACCURACY_M 과 같은 값) */
export const INACCURATE_ACCURACY_M = MAX_ARRIVAL_ACCURACY_M;

export const FAR_DISTANCE_M = 2000;
export const NEAR_DISTANCE_M = 300;
export const FAR_INTERVAL_MS = 30_000;
export const MID_INTERVAL_MS = 10_000;
export const NEAR_INTERVAL_MS = 3_000;
/** 거리를 모를 때 */
export const UNKNOWN_INTERVAL_MS = MID_INTERVAL_MS;

/** 제자리 판정 반경·시간과 그때의 간격 */
export const STILL_RADIUS_M = 20;
export const STILL_AFTER_MS = 60_000;
export const STILL_INTERVAL_MS = 60_000;

/** 모의 위치·not_open 을 받은 뒤의 간격 */
export const SLOW_INTERVAL_MS = 30_000;

/** 연속 실패 백오프 */
export const BACKOFF_BASE_MS = 3_000;
export const BACKOFF_MAX_MS = 30_000;

/** 이보다 오래된 샘플은 보내지 않는다 */
export const MAX_SAMPLE_AGE_MS = 10 * 60_000;

/** 반경 추정에서 정확도를 빼 주는 상한(서버 first_near_at 규칙과 같은 300m) */
export const NEAR_ACCURACY_CAP_M = 300;

// ───────────────────────── 타입 ─────────────────────────

/** 기기 위치 한 점 */
export interface ReportSample {
  lat: number;
  lng: number;
  /** 수평 오차(m). 모르면 null */
  accuracyM: number | null;
  /** 안드로이드 모의 위치(iOS 는 항상 false) */
  mocked: boolean;
  /** 샘플을 얻은 기기 시각(ms) */
  atMs: number;
}

export interface ReportTarget {
  lat: number;
  lng: number;
  radiusM: number;
}

/** ok = 도착 판정 가능 / inaccurate = 보내지만 도착 인정 안 됨 / coarse = 버림(대략적 위치) / invalid = 버림(좌표 오류) */
export type SampleQuality = 'ok' | 'inaccurate' | 'coarse' | 'invalid';

export interface ReportState {
  /** 마지막으로 보낸(성공이든 실패든 시도한) 시각 */
  lastAttemptAtMs: number | null;
  /** 마지막으로 서버에 닿은 시각 */
  lastSentAtMs: number | null;
  /** 마지막으로 서버에 닿은 샘플이 반경 추정 안이었는가 */
  lastSentInside: boolean;
  /** 마지막 서버 판정 사유 */
  lastReason: LbReportReason | null;
  /** 연속 실패 횟수 */
  failures: number;
  /** 제자리 판정 기준점과 그 자리에 들어온 시각 */
  stillAnchor: GeoPoint | null;
  stillSinceMs: number | null;
  /** 더 보내지 않는다(closed · already_arrived) */
  stopped: boolean;
}

export const INITIAL_REPORT_STATE: ReportState = Object.freeze({
  lastAttemptAtMs: null,
  lastSentAtMs: null,
  lastSentInside: false,
  lastReason: null,
  failures: 0,
  stillAnchor: null,
  stillSinceMs: null,
  stopped: false,
});

export type ReportWhy =
  | 'first' // 처음
  | 'entered' // 반경 추정 진입
  | 'due' // 간격이 됐다
  | 'retry' // 실패 뒤 백오프가 끝났다
  | 'mockedFirst'; // 모의 위치를 처음 봤다

export type HoldWhy =
  | 'wait' // 간격이 아직
  | 'backoff' // 실패 뒤 대기
  | 'noSample' // 위치 없음
  | 'stale' // 샘플이 너무 오래됨
  | 'coarse' // 정확도 1000m 초과
  | 'invalid' // 좌표 오류
  | 'stopped'; // 도착·닫힘

export type ReportDecision =
  | { send: true; why: ReportWhy; quality: SampleQuality; distanceM: number | null; nextInMs: number }
  | { send: false; why: HoldWhy; quality: SampleQuality | null; distanceM: number | null; nextInMs: number | null };

// ───────────────────────── 순수 함수 ─────────────────────────

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** 샘플 품질. 정확도를 모르면(null) 서버와 같이 검사를 건너뛴다(ok) */
export function sampleQuality(s: Pick<ReportSample, 'lat' | 'lng' | 'accuracyM'>): SampleQuality {
  if (!isValidGeoPoint({ lat: s.lat, lng: s.lng })) return 'invalid';
  if (s.accuracyM === null) return 'ok';
  if (!isFiniteNumber(s.accuracyM) || s.accuracyM < 0) return 'invalid';
  if (s.accuracyM > MAX_REPORT_ACCURACY_M) return 'coarse';
  if (s.accuracyM > INACCURATE_ACCURACY_M) return 'inaccurate';
  return 'ok';
}

/** 목적지까지 거리(m, 반올림). 좌표가 틀리면 null */
export function distanceToTarget(s: Pick<ReportSample, 'lat' | 'lng'>, target: Pick<ReportTarget, 'lat' | 'lng'>): number | null {
  if (!isValidGeoPoint({ lat: s.lat, lng: s.lng }) || !isValidGeoPoint({ lat: target.lat, lng: target.lng })) return null;
  const d = haversineMeters({ lat: s.lat, lng: s.lng }, { lat: target.lat, lng: target.lng });
  return Number.isFinite(d) ? Math.round(d) : null;
}

/** 거리별 기본 간격 */
export function intervalForDistance(distanceM: number | null): number {
  if (distanceM === null || !isFiniteNumber(distanceM) || distanceM < 0) return UNKNOWN_INTERVAL_MS;
  if (distanceM >= FAR_DISTANCE_M) return FAR_INTERVAL_MS;
  if (distanceM >= NEAR_DISTANCE_M) return MID_INTERVAL_MS;
  return NEAR_INTERVAL_MS;
}

/**
 * 반경 안으로 추정되는가 — 오차를 빼 주면 반경 안(서버의 '근처에 온 시각' 규칙과 같은 식).
 * 정확도를 모르면 거리만 본다.
 */
export function likelyInside(distanceM: number | null, accuracyM: number | null, radiusM: number): boolean {
  if (distanceM === null || !isFiniteNumber(distanceM) || !isFiniteNumber(radiusM) || radiusM < 0) return false;
  const slack = isFiniteNumber(accuracyM) && accuracyM > 0 ? Math.min(accuracyM, NEAR_ACCURACY_CAP_M) : 0;
  return distanceM - slack <= radiusM;
}

/** 연속 실패 n 번 뒤 기다릴 시간: 3 → 6 → 12 → 24 → 30초(상한). n ≤ 0 이면 0 */
export function backoffMs(failures: number): number {
  if (!isFiniteNumber(failures) || failures <= 0) return 0;
  const exp = Math.min(failures - 1, 10);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exp);
}

/** 제자리 상태 갱신: 기준점에서 20m 안이면 유지, 벗어나면 새 기준점 */
export function trackStill(state: ReportState, s: ReportSample): ReportState {
  const here = { lat: s.lat, lng: s.lng };
  if (!isValidGeoPoint(here)) return state;
  if (state.stillAnchor && haversineMeters(state.stillAnchor, here) <= STILL_RADIUS_M) return state;
  return { ...state, stillAnchor: here, stillSinceMs: s.atMs };
}

/** 지금 제자리인가(60초 넘게 20m 안) */
export function isStill(state: ReportState, nowMs: number): boolean {
  return state.stillSinceMs !== null && nowMs - state.stillSinceMs >= STILL_AFTER_MS;
}

/**
 * 이번 틱에 보낼지. sample 이 null 이면 위치를 모른다.
 * state 의 제자리 추적은 호출자가 새 샘플마다 trackStill 로 갱신해 둔다.
 */
export function decideReport(state: ReportState, sample: ReportSample | null, target: ReportTarget, nowMs: number): ReportDecision {
  if (state.stopped) return { send: false, why: 'stopped', quality: null, distanceM: null, nextInMs: null };
  if (!sample) return { send: false, why: 'noSample', quality: null, distanceM: null, nextInMs: null };

  const quality = sampleQuality(sample);
  if (quality === 'invalid') return { send: false, why: 'invalid', quality, distanceM: null, nextInMs: null };
  const distanceM = distanceToTarget(sample, target);
  if (quality === 'coarse') return { send: false, why: 'coarse', quality, distanceM, nextInMs: null };
  if (nowMs - sample.atMs > MAX_SAMPLE_AGE_MS) return { send: false, why: 'stale', quality, distanceM, nextInMs: null };

  // 실패 중: 거리 간격 대신 백오프
  if (state.failures > 0 && state.lastAttemptAtMs !== null) {
    const due = state.lastAttemptAtMs + backoffMs(state.failures);
    if (nowMs >= due) return { send: true, why: 'retry', quality, distanceM, nextInMs: backoffMs(state.failures + 1) };
    return { send: false, why: 'backoff', quality, distanceM, nextInMs: due - nowMs };
  }

  if (state.lastSentAtMs === null && state.lastAttemptAtMs === null) {
    return { send: true, why: sample.mocked ? 'mockedFirst' : 'first', quality, distanceM, nextInMs: intervalFor(state, sample, target, distanceM, nowMs) };
  }

  // 모의 위치를 처음 봤다 — 서버의 'mocked' 사유를 바로 받아 보여 준다
  if (sample.mocked && state.lastReason !== 'mocked') {
    return { send: true, why: 'mockedFirst', quality, distanceM, nextInMs: SLOW_INTERVAL_MS };
  }

  // 모의 위치를 껐다 — 30초를 기다리지 않고 바로 다시 판정받는다
  if (!sample.mocked && state.lastReason === 'mocked') {
    return { send: true, why: 'due', quality, distanceM, nextInMs: intervalFor(state, sample, target, distanceM, nowMs) };
  }

  const inside = !sample.mocked && likelyInside(distanceM, sample.accuracyM, target.radiusM);
  // 시작 전(not_open)에는 반경에 들어와도 판정이 안 되므로 서두르지 않는다
  if (inside && !state.lastSentInside && state.lastReason !== 'not_open') {
    return { send: true, why: 'entered', quality, distanceM, nextInMs: NEAR_INTERVAL_MS };
  }

  const interval = intervalFor(state, sample, target, distanceM, nowMs);
  const last = state.lastSentAtMs ?? state.lastAttemptAtMs ?? 0;
  const due = last + interval;
  if (nowMs >= due) return { send: true, why: 'due', quality, distanceM, nextInMs: interval };
  return { send: false, why: 'wait', quality, distanceM, nextInMs: due - nowMs };
}

/** 지금 상태의 전송 간격(모의·not_open 30초 > 반경 추정 안 3초 > 제자리 60초 > 거리별) */
function intervalFor(state: ReportState, sample: ReportSample, target: ReportTarget, distanceM: number | null, nowMs: number): number {
  if (sample.mocked || state.lastReason === 'not_open') return SLOW_INTERVAL_MS;
  if (likelyInside(distanceM, sample.accuracyM, target.radiusM)) return NEAR_INTERVAL_MS;
  if (isStill(state, nowMs)) return STILL_INTERVAL_MS;
  return intervalForDistance(distanceM);
}

/** 전송을 시작하는 순간(응답 전). 겹쳐 보내지 않게 시도 시각을 먼저 적는다 */
export function beforeReport(state: ReportState, nowMs: number): ReportState {
  return { ...state, lastAttemptAtMs: nowMs };
}

/**
 * 전송 결과 반영.
 * - ok: 서버 판정 사유(reason)와 그 샘플이 반경 추정 안이었는지. closed · already_arrived · 도착이면 stop
 * - 실패: failures + 1
 */
export function afterReport(
  state: ReportState,
  outcome: { ok: true; reason: LbReportReason | null; arrived: boolean; inside: boolean } | { ok: false },
  nowMs: number,
): ReportState {
  if (!outcome.ok) return { ...state, lastAttemptAtMs: nowMs, failures: state.failures + 1 };
  const stop = outcome.arrived || outcome.reason === 'closed' || outcome.reason === 'already_arrived';
  return {
    ...state,
    lastAttemptAtMs: nowMs,
    lastSentAtMs: nowMs,
    lastSentInside: outcome.inside,
    lastReason: outcome.reason,
    failures: 0,
    stopped: state.stopped || stop,
  };
}

// ───────────────────────── watch 옵션 ─────────────────────────

export type WatchTier = 'far' | 'mid' | 'near';

/** 300m 경계의 이력 폭(m): near 는 270m 밑으로 들어와야, mid 는 330m 를 넘어야 바뀐다 */
export const NEAR_TIER_HYSTERESIS_M = 30;
/** 2km 경계의 이력 폭(m): far 는 2100m 를 넘어야, mid 는 1900m 밑으로 들어와야 바뀐다 */
export const FAR_TIER_HYSTERESIS_M = 100;

function plainTier(distanceM: number | null): WatchTier {
  const interval = intervalForDistance(distanceM);
  if (interval === FAR_INTERVAL_MS) return 'far';
  if (interval === NEAR_INTERVAL_MS) return 'near';
  return 'mid';
}

/**
 * 거리 구간. 모르면 mid.
 * current(지금 구간)를 주면 경계 근처에서 이력(hysteresis)을 둔다 — 경계에 서 있을 때 GPS 흔들림(±10m)마다 구간이 뒤집혀
 * watchPositionAsync 구독을 계속 끊고 다시 만드는 것을 막는다.
 */
export function watchTier(distanceM: number | null, current?: WatchTier): WatchTier {
  const next = plainTier(distanceM);
  if (current === undefined || next === current || distanceM === null || !isFiniteNumber(distanceM) || distanceM < 0) {
    return next;
  }
  if (current === 'near' && next === 'mid' && distanceM < NEAR_DISTANCE_M + NEAR_TIER_HYSTERESIS_M) return 'near';
  if (current === 'mid' && next === 'near' && distanceM > NEAR_DISTANCE_M - NEAR_TIER_HYSTERESIS_M) return 'mid';
  if (current === 'mid' && next === 'far' && distanceM < FAR_DISTANCE_M + FAR_TIER_HYSTERESIS_M) return 'mid';
  if (current === 'far' && next === 'mid' && distanceM > FAR_DISTANCE_M - FAR_TIER_HYSTERESIS_M) return 'far';
  return next;
}

/**
 * watchPositionAsync 의 distanceInterval(m)·timeInterval(ms, 안드로이드만).
 * 전송 간격보다 촘촘하게 샘플을 받되, 멀리 있을 때는 배터리를 아낀다.
 * 제자리라 이벤트가 끊겨도(iOS distanceInterval) 마지막 샘플을 10분까지 다시 보내므로 친구 화면에서 사라지지 않는다.
 */
export function watchOptionsFor(tier: WatchTier): { distanceIntervalM: number; timeIntervalMs: number } {
  switch (tier) {
    case 'far':
      return { distanceIntervalM: 50, timeIntervalMs: 15_000 };
    case 'near':
      return { distanceIntervalM: 3, timeIntervalMs: 2_000 };
    default:
      return { distanceIntervalM: 15, timeIntervalMs: 5_000 };
  }
}
