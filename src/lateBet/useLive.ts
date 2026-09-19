/**
 * 약속 화면의 상태 1개를 폴링으로 유지한다 (lb_get_live).
 *
 * - 주기: latePhase.pollIntervalMs — 대기실 10초(주최자의 [시작하기]를 게스트가 곧 봐야 한다), 시작 뒤·정산 대기 5초, 끝났으면 멈춤.
 * - 화면이 포커스를 잃거나 앱이 백그라운드로 가면 멈추고, 돌아오면 즉시 1회 읽는다.
 * - 마지막 상태 캐시: 오류가 나도 마지막으로 본 내용을 계속 그린다(stale=true).
 *   live 모드는 AsyncStorage 'yaho.late.cache.v1' 에도 남긴다. fake 모드는 메모리만(가짜 서버가 메모리라 id 가 매번 바뀐다).
 * - phase 는 1초마다 다시 계산하지만 값이 바뀔 때만 상태를 바꾼다(화면 전체가 매초 다시 그려지지 않는다).
 * - 변경 배너: 마지막으로 본 version(seenVersion)보다 큰 appointment.changes 를 unseenChanges 로 내려 준다.
 *   화면은 [확인]에 ackChanges() 를 부른다. live 모드는 캐시와 함께 AsyncStorage 에 남는다.
 *   참여 화면은 claimSlot 성공 직후 markSeenVersion(id, preview.version) 으로 '동의한 version' 을 먼저 심는다
 *   (그 뒤 첫 getLive 사이에 주최자가 바꾼 조건이 배너 없이 묻히지 않게).
 * - 변경 RPC 뒤의 refresh() 는 진행 중인 폴링 응답(변경 전 스냅샷일 수 있다)을 돌려주지 않고 그 뒤에 한 번 더 읽는다(refreshGate).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { myParticipant, phase as computePhase, pollIntervalMs, type LatePhase } from '@/domain/latePhase';

import { LateBetError, isNotMemberError, toLateBetError } from './errors';
import { useLateBet } from './LateBetContext';
import type { LateBetMode } from './mode';
import { createRefreshGate } from './refreshGate';
import { getSeenVersion, seedSeenVersion, setSeenVersion as storeSeenVersion, unseenChanges as pickUnseen } from './seenVersions';
import { serverClock } from './serverClock';
import type { LbAppointmentChange, LbLive, LbLiveParticipant } from './types';

const CACHE_KEY = 'yaho.late.cache.v1';
const CACHE_MAX = 8;
const SETTLE_DELAY_MS = 60_000;

const memoryCache = new Map<string, LbLive>();

/** live 는 첫 getLive 전에 markSeenVersion 만 불렸을 때 비어 있다 */
type StoredCache = Record<string, { at: number; live?: LbLive; seenVersion?: number }>;

async function readStored(id: string): Promise<{ live: LbLive | null; seenVersion: number | null } | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as StoredCache;
    const entry = all?.[id];
    if (!entry || typeof entry !== 'object') return null;
    const hit = entry.live;
    const live = hit && typeof hit === 'object' && hit.appointment?.id === id ? hit : null;
    const seen = entry.seenVersion;
    const seenVersion = typeof seen === 'number' ? seen : null;
    if (live === null && seenVersion === null) return null;
    return { live, seenVersion };
  } catch {
    return null;
  }
}

async function writeStored(id: string, live: LbLive | null, seenVersion: number | undefined): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    const all = (raw ? JSON.parse(raw) : {}) as StoredCache;
    // 좌표는 캐시에 남기지 않는다(기기에 친구 위치를 쌓지 않는다)
    const safe: LbLive | undefined = live
      ? { ...live, participants: live.participants.map((p) => ({ ...p, location: null, lastSeenMs: null })) }
      : all[id]?.live;
    all[id] = { at: Date.now(), live: safe, seenVersion };
    const keep = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, CACHE_MAX);
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    // 캐시는 없어도 된다
  }
}

/**
 * '이 version 의 조건에 동의했다' 를 첫 getLive 전에 기록한다. 참여 화면이 claimSlot 성공 직후 preview.version 으로 부른다
 * (claimSlot 은 version 이 현재와 같아야 성공하므로 이 값이 그 시점의 최신이다). 이 뒤에 주최자가 바꾼 조건은
 * 첫 getLive 에서 그대로 unseenChanges 로 올라와 배너가 뜬다. live 모드는 캐시에도 남긴다(앱을 껐다 켜도 유지).
 */
export function markSeenVersion(appointmentId: string, version: number, mode: LateBetMode): void {
  if (!appointmentId || !Number.isFinite(version)) return;
  storeSeenVersion(appointmentId, version);
  if (mode === 'live') void writeStored(appointmentId, null, version);
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
  /** LB_NOT_MEMBER: 주최자가 내보냈다 → errors.REMOVED_MESSAGE */
  removed: boolean;
  /** settlePending 이 1분 넘게 이어진다 → SETTLE_DELAYED_NOTICE */
  settleDelayed: boolean;
  /**
   * 마지막으로 본 version 뒤에 주최자가 바꾼 조건(오래된 순). 비어 있지 않으면 화면 상단에
   * "주최자가 약속을 바꿨어요: …" 배너를 그리고 [확인]에 ackChanges() 를 부른다. 주최자 본인에게는 항상 [].
   */
  unseenChanges: LbAppointmentChange[];
  /** 배너 [확인] — 지금 version 을 본 것으로 기록한다 */
  ackChanges(): void;
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
  const [removed, setRemoved] = useState(false);
  const [settleDelayed, setSettleDelayed] = useState(false);
  const [seenVersion, setSeenVersion] = useState<number | null>(() => (id ? getSeenVersion(id) : null));
  const [focused, setFocused] = useState(true);
  const [appActive, setAppActive] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');

  const liveRef = useRef<LbLive | null>(live);
  const phaseRef = useRef<LatePhase | null>(phase);
  const settlePendingSince = useRef<number | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // 읽기 창구: 폴링은 진행 중인 읽기를 재사용, 변경 RPC 뒤의 refresh 는 그 뒤에 한 번 더 읽는다(옛 스냅샷을 돌려주지 않는다)
  const gate = useMemo(() => {
    if (!id) return null;
    return createRefreshGate<LbLive>({
      read: () => api.getLive(id), // 시계 샘플은 api 가 rpc 왕복으로 넣는다(여기서 또 재지 않는다)
      onValue: (next) => {
        memoryCache.set(id, next);
        // 처음 보는 약속은 지금 version 을 '본 것'으로 삼는다(만든·참여한 직후의 조건이 기준).
        // 참여 화면이 markSeenVersion 으로 먼저 심어 뒀으면 그것이 남는다(그 사이 변경은 배너로)
        const seen = seedSeenVersion(id, next.appointment.version);
        if (alive.current) setSeenVersion(seen);
        if (mode === 'live') void writeStored(id, next, seen);
        if (!alive.current) return;
        liveRef.current = next;
        setLive(next);
        setPhase(computePhase(next, serverClock.now()));
        setError(null);
        setFailCount(0);
        setRemoved(false);
        applyBalance(next.myBalance);
        if (next.settlePending) {
          settlePendingSince.current = settlePendingSince.current ?? Date.now();
        } else {
          settlePendingSince.current = null;
          setSettleDelayed(false);
        }
      },
      onError: (e) => {
        const err = toLateBetError(e);
        if (!alive.current) return;
        if (isNotMemberError(err)) {
          setRemoved(true);
          memoryCache.delete(id);
        }
        setError(err);
        setFailCount((n) => n + 1);
      },
    });
  }, [api, applyBalance, id, mode]);

  /** 폴링용(진행 중인 읽기 재사용) */
  const poll = useCallback((): Promise<LbLive | null> => (gate ? gate.poll() : Promise.resolve(null)), [gate]);
  /** 변경 RPC 뒤용(진행 중인 읽기 뒤에 한 번 더 읽는다) */
  const refresh = useCallback((): Promise<LbLive | null> => (gate ? gate.refresh() : Promise.resolve(null)), [gate]);

  // 약속이 바뀌면 처음부터
  useEffect(() => {
    const cached = id ? memoryCache.get(id) ?? null : null;
    liveRef.current = cached;
    setLive(cached);
    setPhase(cached ? computePhase(cached, serverClock.now()) : null);
    setError(null);
    setFailCount(0);
    setRemoved(false);
    setSettleDelayed(false);
    setSeenVersion(id ? getSeenVersion(id) : null);
    settlePendingSince.current = null;
    if (id && !cached && mode === 'live') {
      void readStored(id).then((stored) => {
        if (!stored || !alive.current) return;
        if (stored.seenVersion !== null) setSeenVersion(seedSeenVersion(id, stored.seenVersion));
        if (stored.live !== null && liveRef.current === null) {
          liveRef.current = stored.live;
          setLive(stored.live);
          setPhase(computePhase(stored.live, serverClock.now()));
        }
      });
    }
  }, [id, mode]);

  const ackChanges = useCallback(() => {
    const cur = liveRef.current;
    if (!id || !cur) return;
    storeSeenVersion(id, cur.appointment.version);
    setSeenVersion(cur.appointment.version);
    if (mode === 'live') void writeStored(id, cur, cur.appointment.version);
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
    void poll();
    if (interval === null) return undefined;
    const timer = setInterval(() => void poll(), interval);
    return () => clearInterval(timer);
  }, [id, focused, appActive, interval, poll]);

  // phase 는 시각에 따라 혼자 넘어간다(라이브 → 지각 → 정산 대기). 대기실 → 라이브는 주최자의 [시작하기]라 서버 응답으로만 바뀐다.
  // 값이 바뀔 때만 다시 그린다
  const meetPassedAsked = useRef(false);
  useEffect(() => {
    if (!live || !focused || !appActive) return undefined;
    meetPassedAsked.current = false;
    const recompute = () => {
      const now = serverClock.now();
      const next = computePhase(live, now);
      const prev = phaseRef.current;
      phaseRef.current = next;
      setPhase(next);
      // 경계(마감)를 넘는 순간에는 서버에 바로 물어본다
      if (prev !== null && prev !== next && next === 'settling') void poll();
      // 시작 없이 약속 시각을 넘긴 대기실: 서버가 무효(notStarted)로 닫았을 것이다 → 한 번 바로 읽는다
      if (next === 'waiting' && Number.isFinite(now) && now >= live.appointment.meetAtMs && !meetPassedAsked.current) {
        meetPassedAsked.current = true;
        void poll();
      }
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
  }, [live, focused, appActive, poll]);

  return useMemo<UseLiveResult>(() => {
    const me = live ? myParticipant(live) : null;
    const isHost = !!live && live.appointment.hostId === live.myUserId;
    const unseenChanges = live ? pickUnseen(live.appointment.changes, seenVersion, isHost) : [];
    return {
      live,
      phase,
      me,
      isHost,
      loading: !!id && live === null && error === null,
      error,
      stale: live !== null && error !== null,
      failCount,
      removed,
      settleDelayed,
      unseenChanges,
      ackChanges,
      refresh,
    };
  }, [live, phase, id, error, failCount, removed, settleDelayed, seenVersion, ackChanges, refresh]);
}
