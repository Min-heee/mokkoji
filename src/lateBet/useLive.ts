/**
 * 약속 화면의 상태 1개를 폴링으로 유지한다 (lb_get_live).
 *
 * - 주기: latePhase.pollIntervalMs — 대기실 30초, 공개 창·승인 대기·정산 대기 5초, 끝났으면 멈춤.
 * - 화면이 포커스를 잃거나 앱이 백그라운드로 가면 멈추고, 돌아오면 즉시 1회 읽는다.
 * - 마지막 상태 캐시: 오류가 나도 마지막으로 본 내용을 계속 그린다(stale=true).
 *   live 모드는 AsyncStorage 'yaho.late.cache.v1' 에도 남긴다. fake 모드는 메모리만(가짜 서버가 메모리라 id 가 매번 바뀐다).
 * - phase 는 1초마다 다시 계산하지만 값이 바뀔 때만 상태를 바꾼다(화면 전체가 매초 다시 그려지지 않는다).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { myParticipant, phase as computePhase, pollIntervalMs, type LatePhase } from '@/domain/latePhase';

import { LateBetError, isNotMemberError, toLateBetError } from './errors';
import { useLateBet } from './LateBetContext';
import { serverClock, withClockSample } from './serverClock';
import type { LbLive, LbLiveParticipant } from './types';

const CACHE_KEY = 'yaho.late.cache.v1';
const CACHE_MAX = 8;
const SETTLE_DELAY_MS = 60_000;

const memoryCache = new Map<string, LbLive>();

type StoredCache = Record<string, { at: number; live: LbLive }>;

async function readStored(id: string): Promise<LbLive | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as StoredCache;
    const hit = all?.[id]?.live;
    return hit && typeof hit === 'object' && hit.appointment?.id === id ? hit : null;
  } catch {
    return null;
  }
}

async function writeStored(id: string, live: LbLive): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    const all = (raw ? JSON.parse(raw) : {}) as StoredCache;
    // 좌표는 캐시에 남기지 않는다(기기에 친구 위치를 쌓지 않는다)
    const safe: LbLive = { ...live, participants: live.participants.map((p) => ({ ...p, location: null, lastSeenMs: null })) };
    all[id] = { at: Date.now(), live: safe };
    const keep = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, CACHE_MAX);
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    // 캐시는 없어도 된다
  }
}

export interface UseLiveResult {
  /** 마지막으로 받은 상태(캐시 포함). 첫 응답 전에는 null */
  live: LbLive | null;
  /** live 가 있으면 항상 값이 있다 */
  phase: LatePhase | null;
  /** 내 참가자 행 */
  me: LbLiveParticipant | null;
  isHost: boolean;
  /** 첫 응답을 기다리는 중(캐시도 없음) */
  loading: boolean;
  /** 마지막 폴링 오류. 성공하면 null 로 돌아간다 */
  error: LateBetError | null;
  /** 오류가 나서 마지막으로 본 내용을 그리는 중 */
  stale: boolean;
  /** 연속 실패 횟수 */
  failCount: number;
  /** LB_NOT_MEMBER: 내보내졌거나 요청이 거절됐다. wasPending 으로 문구를 고른다(errors.removedMessage) */
  removed: { wasPending: boolean } | null;
  /** settlePending 이 1분 넘게 이어진다 → SETTLE_DELAYED_NOTICE */
  settleDelayed: boolean;
  /** 즉시 다시 읽는다(변경 RPC 뒤에 반드시 부른다). 실패해도 던지지 않고 null */
  refresh(): Promise<LbLive | null>;
}

export function useLive(appointmentId: string | null | undefined): UseLiveResult {
  const { api, enabled, mode, applyBalance } = useLateBet();
  const id = enabled && typeof appointmentId === 'string' && appointmentId !== '' ? appointmentId : null;

  const [live, setLive] = useState<LbLive | null>(() => (id ? memoryCache.get(id) ?? null : null));
  const [phase, setPhase] = useState<LatePhase | null>(() => (live ? computePhase(live, serverClock.now()) : null));
  const [error, setError] = useState<LateBetError | null>(null);
  const [failCount, setFailCount] = useState(0);
  const [removed, setRemoved] = useState<{ wasPending: boolean } | null>(null);
  const [settleDelayed, setSettleDelayed] = useState(false);
  const [focused, setFocused] = useState(true);
  const [appActive, setAppActive] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');

  const liveRef = useRef<LbLive | null>(live);
  const phaseRef = useRef<LatePhase | null>(phase);
  const inflight = useRef<Promise<LbLive | null> | null>(null);
  const settlePendingSince = useRef<number | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback((): Promise<LbLive | null> => {
    if (!id) return Promise.resolve(null);
    if (inflight.current) return inflight.current;
    const p = withClockSample(() => api.getLive(id))
      .then((next) => {
        memoryCache.set(id, next);
        if (mode === 'live') void writeStored(id, next);
        if (!alive.current) return next;
        liveRef.current = next;
        setLive(next);
        setPhase(computePhase(next, serverClock.now()));
        setError(null);
        setFailCount(0);
        setRemoved(null);
        applyBalance(next.myBalance);
        if (next.settlePending) {
          settlePendingSince.current = settlePendingSince.current ?? Date.now();
        } else {
          settlePendingSince.current = null;
          setSettleDelayed(false);
        }
        return next;
      })
      .catch((e: unknown) => {
        const err = toLateBetError(e);
        if (alive.current) {
          if (isNotMemberError(err)) {
            setRemoved({ wasPending: liveRef.current?.myState === 'pending' });
            memoryCache.delete(id);
          }
          setError(err);
          setFailCount((n) => n + 1);
        }
        return null;
      })
      .finally(() => {
        inflight.current = null;
      });
    inflight.current = p;
    return p;
  }, [api, applyBalance, id, mode]);

  // 약속이 바뀌면 처음부터
  useEffect(() => {
    const cached = id ? memoryCache.get(id) ?? null : null;
    liveRef.current = cached;
    setLive(cached);
    setPhase(cached ? computePhase(cached, serverClock.now()) : null);
    setError(null);
    setFailCount(0);
    setRemoved(null);
    setSettleDelayed(false);
    settlePendingSince.current = null;
    if (id && !cached && mode === 'live') {
      void readStored(id).then((stored) => {
        if (stored && alive.current && liveRef.current === null) {
          liveRef.current = stored;
          setLive(stored);
          setPhase(computePhase(stored, serverClock.now()));
        }
      });
    }
  }, [id, mode]);

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

  // 폴링: 보이는 동안만. 켜지는 순간 즉시 1회
  const interval = removed ? null : phase === null ? 5_000 : pollIntervalMs(phase);
  useEffect(() => {
    if (!id || !focused || !appActive) return undefined;
    void refresh();
    if (interval === null) return undefined;
    const timer = setInterval(() => void refresh(), interval);
    return () => clearInterval(timer);
  }, [id, focused, appActive, interval, refresh]);

  // phase 는 시각에 따라 혼자 넘어간다(대기실 → 라이브 → 지각 → 정산 대기). 값이 바뀔 때만 다시 그린다
  useEffect(() => {
    if (!live || !focused || !appActive) return undefined;
    const recompute = () => {
      const next = computePhase(live, serverClock.now());
      const prev = phaseRef.current;
      phaseRef.current = next;
      setPhase(next);
      // 경계(잠금·마감)를 넘는 순간에는 서버에 바로 물어본다
      if (prev !== null && prev !== next && (next === 'settling' || prev === 'waiting')) void refresh();
      const since = settlePendingSince.current;
      if (since !== null && Date.now() - since > SETTLE_DELAY_MS) setSettleDelayed(true);
    };
    recompute();
    const timer = setInterval(recompute, 1000);
    const off = serverClock.subscribe(recompute);
    return () => {
      clearInterval(timer);
      off();
    };
  }, [live, focused, appActive, refresh]);

  return useMemo<UseLiveResult>(() => {
    const me = live ? myParticipant(live) : null;
    return {
      live,
      phase,
      me,
      isHost: !!live && live.appointment.hostId === live.myUserId,
      loading: !!id && live === null && error === null,
      error,
      stale: live !== null && error !== null,
      failCount,
      removed,
      settleDelayed,
      refresh,
    };
  }, [live, phase, id, error, failCount, removed, settleDelayed, refresh]);
}
