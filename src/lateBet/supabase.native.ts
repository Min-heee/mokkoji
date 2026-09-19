/**
 * 약속 내기 live 백엔드 — iOS/Android. 실제 Supabase 클라이언트(supabase-js, 순수 JS)를 LbLiveBackend 로 감싼다.
 *
 * - 클라이언트는 처음 필요할 때 한 번만 만든다(모듈 로드 시 부작용 없음). api.ts 는 모드가 live 일 때만 이 파일을 require 한다
 *   → off·fake 에서는 클라이언트도, AsyncStorage 세션 읽기도, AppState 구독도 생기지 않는다.
 * - 세션 토큰은 AsyncStorage(설계서 §8: 가상 포인트라 수용, 카카오 연결 때 SecureStore 로).
 * - 포그라운드일 때만 토큰 자동 갱신(AppState active ↔ startAutoRefresh/stopAutoRefresh — Supabase RN 가이드).
 * - URL·URLSearchParams 는 Expo SDK 54 가 WHATWG 구현을 전역에 깐다(expo/src/winter) → react-native-url-polyfill 불필요.
 *   익명 로그인(POST /auth/v1/signup)은 crypto.subtle 을 쓰지 않는다(PKCE 는 OAuth·OTP 의 pkce 흐름에서만).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, type AppStateStatus } from 'react-native';

import { createAuthSession, type AuthPort, type AuthSession } from './authSession';
import { LateBetError } from './errors';
import { RPC_TIMEOUT_MS, type LbLiveBackend, type LbWireResult } from './supabaseApi';

// 번들 시점 치환을 위해 정적으로 적는다
const URL_ENV = process.env.EXPO_PUBLIC_SUPABASE_URL;
const KEY_ENV = process.env.EXPO_PUBLIC_SUPABASE_KEY;

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;
  const url = typeof URL_ENV === 'string' ? URL_ENV.trim() : '';
  const key = typeof KEY_ENV === 'string' ? KEY_ENV.trim() : '';
  if (!url || !key) throw new LateBetError('LB_NOT_CONFIGURED', 'EXPO_PUBLIC_SUPABASE_URL/KEY 없음');
  const c = createClient(url, key, {
    auth: {
      storage: AsyncStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  const sync = (state: AppStateStatus) => {
    if (state === 'active') void c.auth.startAutoRefresh();
    else void c.auth.stopAutoRefresh();
  };
  AppState.addEventListener('change', sync);
  sync(AppState.currentState);
  client = c;
  return c;
}

/**
 * 세션 규칙은 authSession.ts(순수 로직, node:test 로 경주 검증):
 * - 익명 가입은 ensureSession(= api.ensureSignedIn, 약속 기능 진입)에서만. 일반 RPC 는 requireSession(없으면 LB_NOT_SIGNED_IN)
 * - 진행 중인 익명 가입은 8초 타임아웃이 나도 버리지 않는다(재시도가 두 번째 계정을 만들어 세션을 덮어쓰지 않게)
 * - 서버가 JWT 를 거부하면 supabaseApi 가 refreshSession 을 한 번 부르고 같은 호출을 다시 한다
 */
let auth: AuthSession | null = null;
function getAuth(): AuthSession {
  if (auth) return auth;
  const port: AuthPort = {
    getSession: () => getClient().auth.getSession(),
    signInAnonymously: () => getClient().auth.signInAnonymously(),
    refreshSession: () => getClient().auth.refreshSession(),
    signOut: () => getClient().auth.signOut({ scope: 'local' }),
  };
  auth = createAuthSession(port, { timeoutMs: RPC_TIMEOUT_MS });
  return auth;
}

const wire = (p: PromiseLike<{ data: unknown; error: unknown }>): PromiseLike<LbWireResult> => p;

export function getLiveBackend(): LbLiveBackend {
  return {
    rpc: (fn, args, signal) => wire(getClient().rpc(fn, args).abortSignal(signal)),
    ensureSession: () => getAuth().ensureSession(),
    requireSession: () => getAuth().requireSession(),
    restoreSession: () => getAuth().restoreSession(),
    refreshSession: () => getAuth().refreshSession(),
    query: {
      profile: (signal) =>
        wire(getClient().from('profiles').select('user_id,nickname,balance').abortSignal(signal).maybeSingle()),
    },
  };
}
