/**
 * 위치 보고 루프 — P0 구현(플랫폼 무관 단일 파일).
 *
 * P1 에서 .native.ts(expo-location watch) / .web.ts(no-op) 로 갈라진다. 반환 타입(ArrivalReporter)과 인자는 그대로 간다.
 * P0 에서는 진짜 GPS 대신 '가짜 기기 위치'(fakeDevice)를 읽는다. fake 모드에서 FakeDevPanel 이 그 값을 바꾼다.
 * fake 모드가 아니면 아무것도 보고하지 않는다(permission='unsupported').
 *
 * 규칙(설계서 §3.3):
 * - 도는 조건: 화면 포커스 ∧ 앱 active ∧ 공개 창 안 ∧ 나는 활성·미도착 ∧ 공유 토글 ON
 * - 조건이 깨지면(blur·백그라운드·토글 OFF) lb_stop_sharing 을 best-effort 로 부른다
 * - 토글 OFF 여도 [도착 확인](checkInNow)은 share=false 로 판정만 받는다
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { haversineMeters } from '@/domain/geo';
import { isCheckInOpen } from '@/domain/latePhase';

import { LateBetError, toLateBetError } from './errors';
import { useLateBet } from './LateBetContext';
import { serverClock, withClockSample } from './serverClock';
import type { LbLive, LbReportResult } from './types';

const REPORT_INTERVAL_MS = 5_000;

// ───────────────────────── 가짜 기기 위치 (P0) ─────────────────────────

export interface FakeDevicePosition {
  lat: number;
  lng: number;
  accuracyM: number | null;
  mocked: boolean;
}

let fakePosition: FakeDevicePosition | null = null;
const fakeListeners = new Set<() => void>();

export const fakeDevice = {
  get: (): FakeDevicePosition | null => fakePosition,
  /** null = 위치를 모른다(권한 거부와 비슷한 상태) */
  set(next: FakeDevicePosition | null): void {
    fakePosition = next;
    fakeListeners.forEach((fn) => fn());
  },
  subscribe(listener: () => void): () => void {
    fakeListeners.add(listener);
    return () => {
      fakeListeners.delete(listener);
    };
  },
};

/** 약속별 [위치 공유 끄기] — P0 는 메모리(P1: AsyncStorage 'yaho.late.shareOff.v1') */
const shareOff = new Set<string>();

// ───────────────────────── 훅 ─────────────────────────

export type LocationPermission = 'granted' | 'coarse' | 'denied' | 'undetermined' | 'unsupported';

export interface ArrivalReporter {
  /** P0: fake 모드 'granted', 그 외 'unsupported' */
  permission: LocationPermission;
  /** 위치 공유 토글(약속별). 기본 켬 */
  sharing: boolean;
  setSharing(on: boolean): void;
  /** 지금 보고 루프가 돌고 있는가 */
  running: boolean;
  /** 내 위치에서 목적지까지(기기에서 계산, 표시용). 모르면 null */
  myDistanceM: number | null;
  myAccuracyM: number | null;
  /** 마지막 서버 판정 */
  lastResult: LbReportResult | null;
  /** 마지막 보고 오류(연결 끊김 등). 성공하면 null */
  error: LateBetError | null;
  /** [도착 확인] 진행 중 */
  checking: boolean;
  /** [도착 확인]: 현재 위치 1회로 판정. 위치를 모르면 null. 던지지 않는다 */
  checkInNow(): Promise<LbReportResult | null>;
  /** OS 위치 권한 요청(LocationPrimer 의 [위치 허용하기]). P0: 현재 permission 을 그대로 돌려준다 */
  requestPermission(): Promise<LocationPermission>;
}

export interface UseArrivalReporterOptions {
  /** 도착이 찍힌 순간(자동·수동 모두) — 도착 연출 + refresh */
  onArrived?: (result: LbReportResult) => void;
}

export function useArrivalReporter(live: LbLive | null, options: UseArrivalReporterOptions = {}): ArrivalReporter {
  const { api, fake } = useLateBet();
  const appointmentId = live?.appointment.id ?? null;

  const [sharing, setSharingState] = useState(() => (appointmentId ? !shareOff.has(appointmentId) : true));
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
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    setSharingState(appointmentId ? !shareOff.has(appointmentId) : true);
    setLastResult(null);
    setError(null);
  }, [appointmentId]);

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
      try {
        const res = await withClockSample(() =>
          api.reportLocation(appointmentId, { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracyM, mocked: pos.mocked, share }),
        );
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

  // P0: 가짜 기기 위치가 아직 없으면 목적지에서 북쪽으로 약 1.5km 에 둔다
  const placeLat = appointment?.placeLat ?? null;
  const placeLng = appointment?.placeLng ?? null;
  useEffect(() => {
    if (!fake || placeLat === null || placeLng === null || fakeDevice.get() !== null) return;
    fakeDevice.set({ lat: Math.min(89, placeLat + 0.0135), lng: placeLng, accuracyM: 12, mocked: false });
  }, [fake, placeLat, placeLng]);

  // 보고 루프: 켜지는 순간 1회 + 5초마다 + 위치가 바뀌면 즉시
  useEffect(() => {
    if (!running) return undefined;
    void send(true);
    const timer = setInterval(() => void send(true), REPORT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running, send, position]);

  // 루프가 꺼지면(blur·백그라운드·토글 OFF·화면 이탈) 내 좌표를 바로 지운다
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running && appointmentId) void api.stopSharing(appointmentId).catch(() => undefined);
    wasRunning.current = running;
  }, [running, api, appointmentId]);
  useEffect(
    () => () => {
      if (wasRunning.current && appointmentId) void api.stopSharing(appointmentId).catch(() => undefined);
    },
    [api, appointmentId],
  );

  const setSharing = useCallback(
    (on: boolean) => {
      if (appointmentId) {
        if (on) shareOff.delete(appointmentId);
        else shareOff.add(appointmentId);
      }
      setSharingState(on);
    },
    [appointmentId],
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

  return useMemo<ArrivalReporter>(() => {
    const myDistanceM =
      position && appointment
        ? Math.round(haversineMeters(position, { lat: appointment.placeLat, lng: appointment.placeLng }))
        : null;
    return {
      permission,
      sharing,
      setSharing,
      running,
      myDistanceM: myDistanceM !== null && Number.isFinite(myDistanceM) ? myDistanceM : null,
      myAccuracyM: position?.accuracyM ?? null,
      lastResult,
      error,
      checking,
      checkInNow,
      requestPermission,
    };
  }, [permission, sharing, setSharing, running, position, appointment, lastResult, error, checking, checkInNow, requestPermission]);
}
