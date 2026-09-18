/**
 * 위치 보고 루프 — 네이티브 구현(expo-location 포그라운드 watch). 웹·가짜는 useArrivalReporter.ts.
 * 설계서 §3.3(위치 공유), §3.4(도착 체크인), §5.3-E·F, §5.4(실패 상태), 원칙 5, 오너 확정 흐름 §0-1(주최자 [시작하기]).
 *
 * 도는 조건(전부 참일 때만 watchPositionAsync 구독):
 *   약속 기능 켜짐 ∧ 약속 open ∧ 주최자가 시작함 ∧ 공개 창 안(isCheckInOpen: 시작 ~ closeMs) ∧ 나는 활성 참가자 ∧ 미도착
 *   ∧ 화면 포커스 ∧ AppState active ∧ 공유 토글 ON ∧ 위치 권한 허용(정확·대략 모두)
 * 조건이 하나라도 깨지면(블러·백그라운드·도착·종료·토글 OFF·권한 회수) 즉시 구독 해제 + lb_stop_sharing 1회(보낸 적이 있을 때).
 *
 * 전송은 reportPolicy(순수, 테스트 있음)가 정한다 — 거리별 간격(30s/10s/3s)·반경 추정 진입 즉시·1000m 초과 버림·
 * 100m 초과 '부정확'·모의 위치·연속 실패 백오프(3s→30s)·제자리 60초. 이 파일은 1초 틱과 새 샘플마다 decideReport 를 부른다.
 *
 * fake 모드에서 FakeDevPanel 이 '내 위치'를 덮어쓰고 있으면(fakeDevice.isOverriding) GPS 대신 그 좌표를 보낸다.
 * 오버라이드를 풀면 실제 GPS 로 돌아간다. 오버라이드 중에는 권한이 없어도 돈다(가짜 서버 체험용).
 *
 * expo-location API(node_modules/expo-location/build/Location.d.ts · Location.types.d.ts):
 *   watchPositionAsync(options: LocationOptions, callback: (LocationObject) => any, errorHandler?: (reason: string) => void)
 *     : Promise<LocationSubscription{ remove() }>
 *   getCurrentPositionAsync(options?: LocationOptions): Promise<LocationObject>
 *   LocationOptions{ accuracy?: Accuracy, timeInterval?(ms, 안드로이드), distanceInterval?(m), mayShowUserSettingsDialog?(안드로이드) }
 *   LocationObject{ coords{ latitude, longitude, accuracy: number | null, ... }, timestamp(ms), mocked?(안드로이드) }
 *   Accuracy.High = 4 · Accuracy.Highest = 5
 * getLastKnownPositionAsync 는 쓰지 않는다(§3.4 — 옛 좌표로 도착하지 않게).
 * 이 파일은 백그라운드 위치를 쓰지 않는다(startLocationUpdatesAsync 없음, app.json 이 백그라운드 권한을 막는다).
 */
import * as Location from 'expo-location';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { isCheckInOpen } from '@/domain/latePhase';

import {
  fakeDevice,
  shareOffStore,
  type ArrivalReporter,
  type ArrivalReporterPosition,
  type LocationPermission,
  type PositionSource,
  type UseArrivalReporterOptions,
} from './arrivalShared';
import { LateBetError, toLateBetError } from './errors';
import { useLateBet } from './LateBetContext';
import { canReadLocation, toReporterPermission, type LocationPermissionState } from './permissionRule';
import { getLocationPermission, openAppSettings, requestLocationPermission } from './permissions';
import {
  afterReport,
  beforeReport,
  decideReport,
  distanceToTarget,
  INITIAL_REPORT_STATE,
  likelyInside,
  sampleQuality,
  trackStill,
  watchOptionsFor,
  watchTier,
  type ReportSample,
  type ReportState,
  type ReportTarget,
  type WatchTier,
} from './reportPolicy';
import { serverClock, withClockSample } from './serverClock';
import type { LbLive, LbReportResult } from './types';

export { fakeDevice, shareOffStore } from './arrivalShared';
export type {
  ArrivalReporter,
  ArrivalReporterPosition,
  FakeDevicePosition,
  LocationPermission,
  PositionSource,
  UseArrivalReporterOptions,
} from './arrivalShared';

/** 정책 틱 */
const TICK_MS = 1_000;
/** [도착 확인]의 1회 측정 제한 시간 */
const CHECK_TIMEOUT_MS = 15_000;
/** [도착 확인]이 측정에 실패했을 때 대신 쓸 수 있는 watch 샘플의 최대 나이 */
const CHECK_FALLBACK_MAX_AGE_MS = 15_000;
/** [도착 확인]이 돌고 있던 전송을 기다리는 최대 시간 */
const CHECK_WAIT_BUSY_MS = 3_000;

function toSample(loc: Location.LocationObject): ReportSample {
  const acc = loc.coords.accuracy;
  return {
    lat: loc.coords.latitude,
    lng: loc.coords.longitude,
    accuracyM: typeof acc === 'number' && Number.isFinite(acc) ? acc : null,
    mocked: loc.mocked === true,
    atMs: typeof loc.timestamp === 'number' && Number.isFinite(loc.timestamp) ? loc.timestamp : Date.now(),
  };
}

function fakeSample(): ReportSample | null {
  const p = fakeDevice.get();
  if (!p) return null;
  return { lat: p.lat, lng: p.lng, accuracyM: p.accuracyM, mocked: p.mocked, atMs: Date.now() };
}

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export function useArrivalReporter(live: LbLive | null, options: UseArrivalReporterOptions = {}): ArrivalReporter {
  const { api, fake, enabled, mode } = useLateBet();
  const appointmentId = live?.appointment.id ?? null;
  const appointment = live?.appointment ?? null;
  const persistShareOff = mode === 'live';

  // ── 권한 (묻지 않고 읽기만. 요청은 requestPermission 에서만)
  const [perm, setPerm] = useState<LocationPermissionState | null>(null);
  // ── 가짜 좌표 오버라이드
  const [overriding, setOverriding] = useState(() => fake && fakeDevice.isOverriding());
  const [fakePos, setFakePos] = useState(() => fakeDevice.get());
  // ── 상태
  const [sharing, setSharingState] = useState(() => (appointmentId ? !shareOffStore.has(appointmentId) : true));
  const [sample, setSample] = useState<ReportSample | null>(null);
  const [positionUnavailable, setPositionUnavailable] = useState(false);
  const [lastResult, setLastResult] = useState<LbReportResult | null>(null);
  const [error, setError] = useState<LateBetError | null>(null);
  const [checking, setChecking] = useState(false);
  const [focused, setFocused] = useState(true);
  // 앱 시작 직후 iOS 는 'unknown' 일 수 있다 — 배경·비활성만 아니면 active 로 본다
  const [appActive, setAppActive] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const [windowOpen, setWindowOpen] = useState(false);
  const [tier, setTier] = useState<WatchTier>('mid');

  const onArrived = useRef(options.onArrived);
  onArrived.current = options.onArrived;
  const alive = useRef(true);
  const busy = useRef(false);
  const policy = useRef<ReportState>(INITIAL_REPORT_STATE);
  const sampleRef = useRef<ReportSample | null>(null);
  const runningRef = useRef(false);
  /** 마지막 lb_stop_sharing 뒤에 share=true 로 좌표를 보냈다 → 멈출 때 한 번 지운다 */
  const sharedSinceStop = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // ── 권한 읽기: 처음 + 포그라운드 복귀마다(설정 앱에서 바꾸고 돌아온 경우). off 모드에서는 아무것도 안 한다
  const refreshPermission = useCallback(async (): Promise<LocationPermissionState | null> => {
    if (!enabled) return null;
    const next = await getLocationPermission();
    if (alive.current) setPerm(next);
    return next;
  }, [enabled]);
  useEffect(() => {
    void refreshPermission();
  }, [refreshPermission]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const active = state === 'active';
      setAppActive(active);
      if (active) void refreshPermission();
    });
    return () => sub.remove();
  }, [refreshPermission]);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  // ── 가짜 좌표 오버라이드 구독(fake 모드만)
  useEffect(() => {
    if (!fake) {
      setOverriding(false);
      setFakePos(null);
      return undefined;
    }
    const sync = () => {
      setOverriding(fakeDevice.isOverriding());
      setFakePos(fakeDevice.get());
    };
    sync();
    return fakeDevice.subscribe(sync);
  }, [fake]);

  // ── 공유 토글(약속별)
  useEffect(() => {
    setSharingState(appointmentId ? !shareOffStore.has(appointmentId) : true);
    setLastResult(null);
    setError(null);
    policy.current = INITIAL_REPORT_STATE;
    if (!appointmentId || !enabled) return undefined;
    const sync = () => setSharingState(!shareOffStore.has(appointmentId));
    void shareOffStore.load(persistShareOff).then(sync);
    return shareOffStore.subscribe(sync);
  }, [appointmentId, enabled, persistShareOff]);

  // ── 공개 창 안인가 — 시각에 따라 혼자 바뀌므로 1초마다 다시 본다(값이 바뀔 때만 다시 그린다)
  useEffect(() => {
    if (!appointment) {
      setWindowOpen(false);
      return undefined;
    }
    const check = () => setWindowOpen(isCheckInOpen(appointment, serverClock.now()));
    check();
    const timer = setInterval(check, 1000);
    const off = serverClock.subscribe(check);
    return () => {
      clearInterval(timer);
      off();
    };
  }, [appointment]);

  const me = live ? live.participants.find((p) => p.userId === live.myUserId) ?? null : null;
  const eligible =
    enabled && !!live && live.myState === 'active' && !!me && me.arrivedAtMs === null && live.appointment.status === 'open';
  const usingFake = fake && overriding;
  const canRead = canReadLocation(perm);
  const running = eligible && windowOpen && focused && appActive && sharing && (usingFake || canRead);
  runningRef.current = running;
  const watching = running && !usingFake;

  const target = useMemo<ReportTarget | null>(
    () => (appointment ? { lat: appointment.placeLat, lng: appointment.placeLng, radiusM: appointment.policy.radiusM } : null),
    [appointment],
  );
  const targetRef = useRef(target);
  targetRef.current = target;

  /** 지금 쓸 샘플: 가짜 오버라이드 > watch 의 마지막 샘플 */
  const currentSample = useCallback((): ReportSample | null => {
    if (fake && fakeDevice.isOverriding()) return fakeSample();
    return sampleRef.current;
  }, [fake]);

  // ── 전송 1회. 루프와 [도착 확인]이 같이 쓴다. 겹치면 호출자가 기다리거나 건너뛴다
  const send = useCallback(
    async (s: ReportSample, share: boolean): Promise<LbReportResult | null> => {
      const t = targetRef.current;
      if (!appointmentId || !t) return null;
      busy.current = true;
      policy.current = beforeReport(policy.current, Date.now());
      if (share) sharedSinceStop.current = true;
      const inside = likelyInside(distanceToTarget(s, t), s.accuracyM, t.radiusM);
      try {
        const res = await withClockSample(() =>
          api.reportLocation(appointmentId, { lat: s.lat, lng: s.lng, accuracyM: s.accuracyM, mocked: s.mocked, share }),
        );
        policy.current = afterReport(policy.current, { ok: true, reason: res.reason, arrived: res.arrived, inside }, Date.now());
        // 응답을 기다리는 사이 루프가 멈췄다 → 방금 올라간 좌표를 다시 지운다
        if (share && !runningRef.current && sharedSinceStop.current) {
          sharedSinceStop.current = false;
          void api.stopSharing(appointmentId).catch(() => undefined);
        }
        if (alive.current) {
          setLastResult(res);
          setError(null);
        }
        if (res.arrived && res.reason === null) onArrived.current?.(res);
        return res;
      } catch (e) {
        policy.current = afterReport(policy.current, { ok: false }, Date.now());
        if (alive.current) setError(toLateBetError(e));
        return null;
      } finally {
        busy.current = false;
      }
    },
    [api, appointmentId],
  );

  /** 정책 한 번 평가 → 보낼 때면 보낸다 */
  const evaluate = useCallback(() => {
    if (!runningRef.current || busy.current) return;
    const t = targetRef.current;
    if (!t) return;
    const s = currentSample();
    const d = decideReport(policy.current, s, t, Date.now());
    if (d.send && s) void send(s, true);
  }, [currentSample, send]);
  const evaluateRef = useRef(evaluate);
  evaluateRef.current = evaluate;

  // ── 루프가 켜질 때마다 정책 상태를 새로(켜지는 순간 즉시 1회) + 1초 틱
  useEffect(() => {
    if (!running) return undefined;
    policy.current = { ...INITIAL_REPORT_STATE };
    evaluateRef.current();
    const timer = setInterval(() => evaluateRef.current(), TICK_MS);
    return () => clearInterval(timer);
  }, [running]);

  // ── 가짜 좌표가 바뀌면 바로 평가(반경 진입 즉시 등)
  useEffect(() => {
    if (!usingFake || !runningRef.current) return;
    const s = fakeSample();
    if (s) policy.current = trackStill(policy.current, s);
    evaluateRef.current();
  }, [usingFake, fakePos]);

  // ── watch 가 멈추면 마지막 샘플을 버린다(다시 켜질 때 몇 분 전 좌표를 먼저 보내지 않게)
  useEffect(() => {
    if (!watching) sampleRef.current = null;
  }, [watching]);

  // ── GPS watch: watching 인 동안만 구독. 거리 구간(tier)이 바뀌면 옵션을 바꿔 다시 구독
  useEffect(() => {
    if (!watching) return undefined;
    let cancelled = false;
    let sub: Location.LocationSubscription | null = null;
    const opts = watchOptionsFor(tier);
    Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        distanceInterval: opts.distanceIntervalM,
        timeInterval: opts.timeIntervalMs,
        // 보고 루프가 설정 대화상자를 반복해 띄우지 않게. [도착 확인]은 기본값(띄움)
        mayShowUserSettingsDialog: false,
      },
      (loc) => {
        if (cancelled) return;
        const s = toSample(loc);
        sampleRef.current = s;
        policy.current = trackStill(policy.current, s);
        const t = targetRef.current;
        if (t) {
          const q = sampleQuality(s);
          // 1000m 넘는 샘플(대략적 위치)로는 구간을 바꾸지 않는다
          // 경계 근처에서는 이력을 둬 흔들림마다 구독을 다시 만들지 않는다(같은 값이면 다시 그리지 않는다)
          if (q === 'ok' || q === 'inaccurate') {
            const d = distanceToTarget(s, t);
            setTier((cur) => watchTier(d, cur));
          }
        }
        setSample(s);
        setPositionUnavailable(false);
        evaluateRef.current();
      },
      () => {
        if (!cancelled) setPositionUnavailable(true);
      },
    )
      .then((s) => {
        if (cancelled) s.remove();
        else sub = s;
      })
      .catch(() => {
        // 위치 서비스 꺼짐·권한 회수 등 — 권한을 다시 읽어 화면이 맞는 안내를 고르게 한다
        if (!cancelled) {
          setPositionUnavailable(true);
          void refreshPermission();
        }
      });
    return () => {
      cancelled = true;
      if (sub) sub.remove();
      sub = null;
    };
  }, [watching, tier, refreshPermission]);

  // ── 루프가 꺼지면(블러·백그라운드·도착·종료·토글 OFF·권한 회수·화면 이탈) 내 좌표를 바로 지운다 — 보낸 뒤 한 번만
  useEffect(() => {
    if (!running && sharedSinceStop.current && appointmentId) {
      sharedSinceStop.current = false;
      void api.stopSharing(appointmentId).catch(() => undefined);
    }
  }, [running, api, appointmentId]);
  useEffect(
    () => () => {
      if (sharedSinceStop.current && appointmentId) {
        sharedSinceStop.current = false;
        void api.stopSharing(appointmentId).catch(() => undefined);
      }
    },
    [api, appointmentId],
  );

  const setSharing = useCallback(
    async (on: boolean): Promise<void> => {
      if (!appointmentId) {
        setSharingState(on);
        return;
      }
      shareOffStore.set(appointmentId, !on, persistShareOff);
      setSharingState(on);
      if (!on) {
        // 사용자가 끈 것 — 루프가 돌지 않던 때 남은 좌표까지 확실히 지운다(루프 쪽 정리와 겹치지 않게 1회)
        sharedSinceStop.current = false;
        await api.stopSharing(appointmentId).catch(() => undefined);
      }
    },
    [api, appointmentId, persistShareOff],
  );

  /** [도착 확인]용 1회 측정: 가짜 오버라이드 > getCurrentPositionAsync(Highest, 15초) > 15초 안의 watch 샘플 */
  const measureOnce = useCallback(async (): Promise<ReportSample | null> => {
    if (fake && fakeDevice.isOverriding()) return fakeSample();
    let state = perm;
    if (!canReadLocation(state)) state = await refreshPermission();
    if (!canReadLocation(state)) return null;
    try {
      const loc = await timeout(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest }), CHECK_TIMEOUT_MS);
      const s = toSample(loc);
      sampleRef.current = s;
      if (alive.current) {
        setSample(s);
        setPositionUnavailable(false);
      }
      return s;
    } catch {
      const recent = sampleRef.current;
      if (recent && Date.now() - recent.atMs <= CHECK_FALLBACK_MAX_AGE_MS) return recent;
      if (alive.current) setPositionUnavailable(true);
      return null;
    }
  }, [fake, perm, refreshPermission]);

  const checkInNow = useCallback(async (): Promise<LbReportResult | null> => {
    if (!enabled || !appointmentId) return null;
    setChecking(true);
    try {
      const s = await measureOnce();
      if (!s) return null;
      // 돌고 있던 전송이 끝나기를 잠깐 기다린다
      for (let waited = 0; busy.current && waited < CHECK_WAIT_BUSY_MS; waited += 100) {
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      if (busy.current) return null;
      return await send(s, sharing);
    } finally {
      if (alive.current) setChecking(false);
    }
  }, [enabled, appointmentId, measureOnce, send, sharing]);

  const sampleCoarse = sample !== null && !usingFake && sampleQuality(sample) === 'coarse';
  const permission: LocationPermission = !enabled
    ? 'unsupported'
    : usingFake && !canRead
      ? 'granted'
      : toReporterPermission(perm, sampleCoarse);

  const requestPermission = useCallback(async (): Promise<LocationPermission> => {
    if (!enabled) return 'unsupported';
    const current = perm ?? (await refreshPermission());
    // 다시 물을 수 없다(영구 거부) → 설정으로
    if (current && current.status === 'blocked') {
      await openAppSettings();
      return toReporterPermission(current);
    }
    if (current && current.status === 'granted') return toReporterPermission(current);
    const next = await requestLocationPermission();
    if (alive.current) setPerm(next);
    return toReporterPermission(next);
  }, [enabled, perm, refreshPermission]);

  const openSettings = useCallback(() => openAppSettings(), []);

  return useMemo<ArrivalReporter>(() => {
    const shown: ReportSample | null = usingFake ? (fakePos ? { ...fakePos, atMs: 0 } : null) : sample;
    const distanceM = shown && target ? distanceToTarget(shown, target) : null;
    const position: ArrivalReporterPosition | null = shown ? { lat: shown.lat, lng: shown.lng, accuracyM: shown.accuracyM } : null;
    const source: PositionSource = usingFake ? (fakePos ? 'fake' : 'none') : sample ? 'gps' : 'none';
    return {
      permission,
      canAskAgain: perm ? perm.canAskAgain : true,
      precise: usingFake ? true : perm?.precise === false || sampleCoarse ? false : (perm?.precise ?? null),
      sharing,
      setSharing,
      running,
      myDistanceM: distanceM,
      myAccuracyM: shown?.accuracyM ?? null,
      myPosition: position,
      source,
      sampleQuality: shown ? sampleQuality(shown) : null,
      mocked: shown?.mocked === true,
      positionUnavailable: !usingFake && positionUnavailable,
      lastResult,
      error,
      checking,
      checkInNow,
      requestPermission,
      openSettings,
    };
  }, [
    usingFake,
    fakePos,
    sample,
    target,
    permission,
    perm,
    sampleCoarse,
    sharing,
    setSharing,
    running,
    positionUnavailable,
    lastResult,
    error,
    checking,
    checkInNow,
    requestPermission,
    openSettings,
  ]);
}
