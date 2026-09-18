/**
 * 약속 내기 — 앱 전역 상태: 익명 세션·프로필·잔액·내 약속 목록·lb_ping 결과.
 *
 * - 모드가 off 면 Provider 는 고정값만 내려 주고 아무 일도 하지 않는다(effect·네트워크·스토리지 접근 0).
 *   화면은 `enabled` 가 false 면 약속 내기 UI 를 그리지 않는다.
 * - 익명 로그인은 약속 기능에 처음 들어올 때만 한다(ensureReady). 홈은 저장된 세션이 있을 때만 목록을 읽는다(refresh).
 * - 낙관적 업데이트 없음. 포인트·목록은 서버 응답 뒤에만 바뀐다.
 */
import Constants from 'expo-constants';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { getLateBetApi, type LateBetApi } from './api';
import { LateBetError, toLateBetError } from './errors';
import { LATEBET_ENABLED, LATEBET_FAKE, LATEBET_MODE, type LateBetMode } from './mode';
import { serverClock, withClockSample } from './serverClock';
import type { LbMyAppointment, LbPing, LbProfile } from './types';

export type LateBetStatus =
  /** 모드 off */
  | 'off'
  /** 세션이 아직 없다(약속 기능에 들어온 적 없음). 홈에는 버튼만 보인다 */
  | 'idle'
  | 'loading'
  | 'ready'
  /** 마지막 새로고침이 실패했다. 이전에 받은 목록은 그대로 둔다(stale) */
  | 'error';

export interface LateBetContextValue {
  mode: LateBetMode;
  /** false 면 약속 내기 UI 를 어디에도 그리지 않는다 */
  enabled: boolean;
  /** 가짜 서버 모드(FakeDevPanel 노출 조건) */
  fake: boolean;
  /** off 모드에서는 모든 호출이 LB_NOT_CONFIGURED 로 실패하는 자리표시자 */
  api: LateBetApi;
  status: LateBetStatus;
  userId: string | null;
  /** null = 아직 프로필이 없다 → 닉네임을 받아 ensureProfile 을 부른다(NicknameGate) */
  profile: LbProfile | null;
  /** 보유 포인트(걸어 둔 포인트 제외). 모르면 null */
  balance: number | null;
  /** 열린 약속(가까운 순) → 끝난 약속(최근 순) */
  appointments: LbMyAppointment[];
  ping: LbPing | null;
  /** lb_ping.minBuild 가 현재 빌드보다 크다 → "새 버전을 설치해 주세요 [설치]" */
  needsUpdate: boolean;
  /** 플랫폼에 맞는 설치 링크(없으면 '') */
  installUrl: string;
  /** 마지막 새로고침 오류 */
  error: LateBetError | null;
  /** 연속 실패 횟수. 3 이상이면 REPEATED_FAILURE_MESSAGE 를 덧붙인다 */
  failCount: number;
  /** 오류가 났지만 이전 목록을 보여 주는 중 */
  stale: boolean;
  /** 프로필·잔액·목록 다시 읽기(홈 포커스, 변경 RPC 뒤). 세션이 없으면 아무것도 안 한다. 던지지 않는다 */
  refresh(): Promise<void>;
  /** 약속 기능 진입: 익명 로그인 → ping → refresh. 프로필(없으면 null)을 돌려준다. 실패하면 LateBetError 를 던진다 */
  ensureReady(): Promise<LbProfile | null>;
  /** 닉네임으로 프로필 생성(+1,000P)·변경 */
  ensureProfile(nickname: string): Promise<LbProfile>;
  /** lb_get_live·lb_peek_invite 가 준 myBalance 를 칩에 바로 반영 */
  applyBalance(balance: number | null | undefined): void;
}

const OFF_VALUE: LateBetContextValue = {
  mode: 'off',
  enabled: false,
  fake: false,
  api: getLateBetApi(),
  status: 'off',
  userId: null,
  profile: null,
  balance: null,
  appointments: [],
  ping: null,
  needsUpdate: false,
  installUrl: '',
  error: null,
  failCount: 0,
  stale: false,
  refresh: () => Promise.resolve(),
  ensureReady: () => Promise.reject(new LateBetError('LB_NOT_CONFIGURED')),
  ensureProfile: () => Promise.reject(new LateBetError('LB_NOT_CONFIGURED')),
  applyBalance: () => undefined,
};

const LateBetContext = createContext<LateBetContextValue>(OFF_VALUE);

function currentBuildNumber(): number {
  const n = Number(Constants.nativeBuildVersion ?? '');
  return Number.isFinite(n) ? n : 0;
}

function ActiveProvider({ children }: { children: React.ReactNode }) {
  const api = useMemo(() => getLateBetApi(), []);
  const [status, setStatus] = useState<LateBetStatus>('loading');
  const [userId, setUserId] = useState<string | null>(null);
  const [profile, setProfile] = useState<LbProfile | null>(null);
  const [appointments, setAppointments] = useState<LbMyAppointment[]>([]);
  const [ping, setPing] = useState<LbPing | null>(null);
  const [error, setError] = useState<LateBetError | null>(null);
  const [failCount, setFailCount] = useState(0);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const userIdRef = useRef<string | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const doPing = useCallback(async () => {
    const res = await withClockSample(() => api.ping());
    if (alive.current) setPing(res);
  }, [api]);

  const load = useCallback(
    async (signIn: boolean): Promise<LbProfile | null> => {
      let uid = userIdRef.current;
      if (!uid) uid = signIn ? await api.ensureSignedIn() : await api.restoreSession();
      if (!uid) {
        if (alive.current) setStatus('idle');
        return null;
      }
      userIdRef.current = uid;
      if (alive.current) setUserId(uid);
      if (!serverClock.hasSample()) await doPing();

      let [me, list] = await Promise.all([api.getMyProfile(), api.listMyAppointments()]);
      // 마감이 지난 열린 약속(그리고 시작 없이 약속 시각을 넘긴 약속)은 한 번 열어 준다 — 서버가 그때 정산·무효 처리한다(§3.5)
      const now = serverClock.now();
      const overdue = list.filter(
        (a) => a.status === 'open' && (a.closeMs < now || (a.startedAtMs === null && a.meetAtMs <= now)),
      );
      if (overdue.length > 0) {
        await Promise.allSettled(overdue.map((a) => api.getLive(a.id)));
        [me, list] = await Promise.all([api.getMyProfile(), api.listMyAppointments()]);
      }
      if (alive.current) {
        setProfile(me);
        setAppointments(list);
        setLoadedOnce(true);
        setError(null);
        setFailCount(0);
        setStatus('ready');
      }
      return me;
    },
    [api, doPing],
  );

  const fail = useCallback((e: unknown): LateBetError => {
    const err = toLateBetError(e);
    if (alive.current) {
      setError(err);
      setFailCount((n) => n + 1);
      setStatus('error');
    }
    return err;
  }, []);

  const refresh = useCallback((): Promise<void> => {
    if (inflight.current) return inflight.current;
    const p = load(false)
      .then(() => undefined)
      .catch((e: unknown) => {
        fail(e);
      })
      .finally(() => {
        inflight.current = null;
      });
    inflight.current = p;
    return p;
  }, [load, fail]);

  const ensureReady = useCallback(async (): Promise<LbProfile | null> => {
    try {
      if (inflight.current) await inflight.current;
      return await load(true);
    } catch (e) {
      throw fail(e);
    }
  }, [load, fail]);

  const ensureProfile = useCallback(
    async (nickname: string): Promise<LbProfile> => {
      try {
        if (!userIdRef.current) {
          userIdRef.current = await api.ensureSignedIn();
          if (alive.current) setUserId(userIdRef.current);
        }
        const me = await api.ensureProfile(nickname);
        if (alive.current) setProfile(me);
        return me;
      } catch (e) {
        throw toLateBetError(e);
      }
    },
    [api],
  );

  const applyBalance = useCallback((balance: number | null | undefined) => {
    if (typeof balance !== 'number' || !Number.isFinite(balance)) return;
    setProfile((prev) => (prev && prev.balance !== balance ? { ...prev, balance } : prev));
  }, []);

  // 첫 진입: 저장된 세션이 있으면 읽는다(새로 로그인하지 않는다)
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 포그라운드 복귀마다 서버 시계를 다시 잰다
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && userIdRef.current) void doPing().catch(() => undefined);
    });
    return () => sub.remove();
  }, [doPing]);

  const value = useMemo<LateBetContextValue>(() => {
    const installUrl = ping ? (Platform.OS === 'ios' ? ping.iosUrl : Platform.OS === 'android' ? ping.androidUrl : '') : '';
    return {
      mode: LATEBET_MODE,
      enabled: true,
      fake: LATEBET_FAKE,
      api,
      status,
      userId,
      profile,
      balance: profile?.balance ?? null,
      appointments,
      ping,
      needsUpdate: !!ping && ping.minBuild > 0 && Platform.OS !== 'web' && ping.minBuild > currentBuildNumber(),
      installUrl,
      error,
      failCount,
      stale: status === 'error' && loadedOnce,
      refresh,
      ensureReady,
      ensureProfile,
      applyBalance,
    };
  }, [api, status, userId, profile, appointments, ping, error, failCount, loadedOnce, refresh, ensureReady, ensureProfile, applyBalance]);

  return <LateBetContext.Provider value={value}>{children}</LateBetContext.Provider>;
}

export function LateBetProvider({ children }: { children: React.ReactNode }) {
  // LATEBET_ENABLED 는 번들 시점 상수라 분기가 렌더마다 바뀌지 않는다
  if (!LATEBET_ENABLED) return <>{children}</>;
  return <ActiveProvider>{children}</ActiveProvider>;
}

/** Provider 밖이거나 모드가 off 면 enabled=false 인 고정값 */
export function useLateBet(): LateBetContextValue {
  return useContext(LateBetContext);
}
