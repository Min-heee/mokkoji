/**
 * 위치 보고 루프 — 웹·가짜 구현(P0 경로 그대로). 네이티브(iOS·Android)는 Metro 가 useArrivalReporter.native.ts(expo-location)를 고른다.
 *
 * 반환 타입(ArrivalReporter)·가짜 기기 위치(fakeDevice)·공유 토글 저장소는 arrivalShared.ts 에 있고 여기서 다시 내보낸다
 * (tsc 와 웹은 이 파일로, 네이티브는 .native 로 resolve 되므로 두 파일의 export 가 같아야 한다).
 * 웹에는 GPS 가 없다 — fake 모드에서 FakeDevPanel 의 '내 위치'(fakeDevice)만 보고한다. fake 가 아니면 아무것도 보고하지 않는다
 * (permission='unsupported'). 웹 번들에 네이티브 모듈이 섞이지 않게 expo-location 을 import 하지 않는다.
 *
 * 규칙(설계서 §3.3, 오너 확정 흐름 2026-09-18):
 * - 도는 조건: 화면 포커스 ∧ 앱 active ∧ 주최자가 시작한 뒤 ∧ 마감 전(isCheckInOpen) ∧ 나는 활성·미도착 ∧ 공유 토글 ON
 *   시작 전(대기실)에는 아무것도 보고하지 않는다 — 위치는 아무도 못 본다
 * - 조건이 깨지면(blur·백그라운드·토글 OFF) lb_stop_sharing 을 best-effort 로 1회 부른다
 * - 토글 OFF 여도 [도착 확인](checkInNow)은 share=false 로 판정만 받는다
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { haversineMeters } from '@/domain/geo';
import { isCheckInOpen } from '@/domain/latePhase';

import {
  fakeDevice,
  shareOffStore,
  type ArrivalReporter,
  type FakeDevicePosition,
  type LocationPermission,
  type UseArrivalReporterOptions,
} from './arrivalShared';
import { LateBetError, toLateBetError } from './errors';
import { sampleQuality } from './reportPolicy';
import { serverClock } from './serverClock';
import { useLateBet } from './LateBetContext';
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

const REPORT_INTERVAL_MS = 5_000;

// ───────────────────────── 훅 ─────────────────────────

export function useArrivalReporter(live: LbLive | null, options: UseArrivalReporterOptions = {}): ArrivalReporter {
  const { api, fake, mode } = useLateBet();
  const appointmentId = live?.appointment.id ?? null;
  const persistShareOff = mode === 'live';

  const [sharing, setSharingState] = useState(() => (appointmentId ? !shareOffStore.has(appointmentId) : true));
  const [position, setPosition] = useState<FakeDevicePosition | null>(() => fakeDevice.get());
  const [lastResult, setLastResult] = useState<LbReportResult | null>(null);
  const [error, setError] = useState<LateBetError | null>(null);
  const [checking, setChecking] = useState(false);
  const [focused, setFocused] = useState(true);
  const [appActive, setAppActive] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const [windowOpen, setWindowOpen] = useState(false);

  const onArrived = useRef(options.onArrived);
  onArrived.current = options.onArrived;
  const busy = useRef(false);
  /** 마지막 lb_stop_sharing 뒤에 share=true 로 좌표를 보냈다 → 멈출 때 한 번 지운다 */
  const sharedSinceStop = useRef(false);
  const runningRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    setSharingState(appointmentId ? !shareOffStore.has(appointmentId) : true);
    setLastResult(null);
    setError(null);
    if (!appointmentId) return undefined;
    const sync = () => setSharingState(!shareOffStore.has(appointmentId));
    void shareOffStore.load(persistShareOff).then(sync);
    return shareOffStore.subscribe(sync);
  }, [appointmentId, persistShareOff]);

  useEffect(() => fakeDevice.subscribe(() => setPosition(fakeDevice.get())), []);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
    return () => sub.remove();
  }, []);

  const me = live ? live.participants.find((p) => p.userId === live.myUserId) ?? null : null;
  const eligible = !!live && live.myState === 'active' && !!me && me.arrivedAtMs === null && live.appointment.status === 'open';

  // 공개 창 안인가 — 시각에 따라 혼자 바뀌므로 1초마다 다시 본다(값이 바뀔 때만 다시 그린다)
  const appointment = live?.appointment ?? null;
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

  const send = useCallback(
    async (share: boolean, wait = false): Promise<LbReportResult | null> => {
      const pos = fakeDevice.get();
      if (!fake || !appointmentId || !pos) return null;
      // [도착 확인]은 돌고 있던 보고가 끝나기를 잠깐 기다린 뒤 보낸다. 루프의 보고는 겹치면 건너뛴다
      for (let i = 0; wait && busy.current && i < 30; i += 1) await new Promise<void>((r) => setTimeout(r, 100));
      if (busy.current) return null;
      busy.current = true;
      if (share) sharedSinceStop.current = true;
      try {
        const res = await api.reportLocation(appointmentId, { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracyM, mocked: pos.mocked, share });
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
        if (alive.current) setError(toLateBetError(e));
        return null;
      } finally {
        busy.current = false;
      }
    },
    [api, appointmentId, fake],
  );

  const running = fake && eligible && windowOpen && focused && appActive && sharing;
  runningRef.current = running;

  // P0: 가짜 기기 위치가 아직 없으면 목적지에서 북쪽으로 약 1.5km 에 둔다
  const placeLat = appointment?.placeLat ?? null;
  const placeLng = appointment?.placeLng ?? null;
  useEffect(() => {
    if (!fake || placeLat === null || placeLng === null || fakeDevice.isOverriding()) return;
    fakeDevice.set({ lat: Math.min(89, placeLat + 0.0135), lng: placeLng, accuracyM: 12, mocked: false });
  }, [fake, placeLat, placeLng]);

  // 보고 루프: 켜지는 순간 1회 + 5초마다 + 위치가 바뀌면 즉시
  useEffect(() => {
    if (!running) return undefined;
    void send(true);
    const timer = setInterval(() => void send(true), REPORT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running, send, position]);

  // 루프가 꺼지면(blur·백그라운드·토글 OFF·도착·화면 이탈) 내 좌표를 바로 지운다 — 보낸 뒤 한 번만
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

  const checkInNow = useCallback(async (): Promise<LbReportResult | null> => {
    setChecking(true);
    try {
      return await send(sharing, true);
    } finally {
      if (alive.current) setChecking(false);
    }
  }, [send, sharing]);

  const permission: LocationPermission = fake ? 'granted' : 'unsupported';
  const requestPermission = useCallback(async (): Promise<LocationPermission> => permission, [permission]);
  const openSettings = useCallback(async (): Promise<boolean> => false, []);

  return useMemo<ArrivalReporter>(() => {
    const myDistanceM =
      position && appointment
        ? Math.round(haversineMeters(position, { lat: appointment.placeLat, lng: appointment.placeLng }))
        : null;
    return {
      permission,
      canAskAgain: true,
      precise: fake ? true : null,
      sharing,
      setSharing,
      running,
      myDistanceM: myDistanceM !== null && Number.isFinite(myDistanceM) ? myDistanceM : null,
      myAccuracyM: position?.accuracyM ?? null,
      myPosition: position ? { lat: position.lat, lng: position.lng, accuracyM: position.accuracyM } : null,
      source: fake && position ? 'fake' : 'none',
      sampleQuality: position ? sampleQuality(position) : null,
      mocked: position?.mocked === true,
      positionUnavailable: false,
      lastResult,
      error,
      checking,
      checkInNow,
      requestPermission,
      openSettings,
    };
  }, [
    permission,
    fake,
    sharing,
    setSharing,
    running,
    position,
    appointment,
    lastResult,
    error,
    checking,
    checkInNow,
    requestPermission,
    openSettings,
  ]);
}
