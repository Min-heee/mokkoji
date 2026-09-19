/**
 * 약속 내기 live — 익명 세션 관리(순수 로직). supabase.native.ts 가 supabase-js 의 auth 를 AuthPort 로 꽂는다.
 * React/RN·supabase-js 를 import 하지 않는다(node:test 로 경주를 재현한다).
 *
 * 규칙
 * - ensureSession: 세션이 없으면 익명 가입. **약속 기능에 명시적으로 들어올 때만**(api.ensureSignedIn) 부른다.
 * - requireSession: 일반 RPC 경로. 세션이 없으면 LB_NOT_SIGNED_IN — 몰래 새 익명 계정으로 갈아타지 않는다.
 * - 진행 중인 익명 가입은 타임아웃이 나도 버리지 않는다. 8초 상한은 부른 쪽의 기다림에만 걸고, 가입 요청 자체는 끝날 때까지
 *   하나로 붙잡아 둔다(원래 promise 가 끝날 때만 비운다). 다음 호출은 새로 가입하지 않고 그 요청을 다시 기다린다
 *   → 느린 망에서 재시도해도 익명 계정이 두 개 생기거나, 늦게 끝난 가입이 세션을 덮어써 프로필·포인트가 고아가 되지 않는다.
 * - refreshSession: 서버가 JWT 를 거부했을 때(기기 시계가 늦어 기기는 유효로 보는 토큰 등) supabaseApi 가 한 번 부른다.
 *   같은 계정의 토큰만 새로 받는다. refresh 토큰이 무효면 로컬 세션을 지우고(signOut local) LB_NOT_SIGNED_IN.
 */
import { LateBetError, type LateBetErrorCode } from './errors';
import { mapRpcError } from './rpcMap';

interface SessionLike {
  user?: { id?: string | null } | null;
}

/** supabase-js auth 의 필요한 부분({ data, error } 모양 그대로) */
export interface AuthPort {
  getSession(): Promise<{ data: { session: SessionLike | null }; error: unknown }>;
  signInAnonymously(): Promise<{ data: { user?: { id?: string | null } | null; session?: SessionLike | null }; error: unknown }>;
  refreshSession(): Promise<{ data: { user?: { id?: string | null } | null; session?: SessionLike | null }; error: unknown }>;
  /** 로컬 세션 지우기(scope local) */
  signOut(): Promise<{ error: unknown }>;
}

export interface AuthSession {
  ensureSession(): Promise<string>;
  requireSession(): Promise<string>;
  restoreSession(): Promise<string | null>;
  refreshSession(): Promise<string>;
}

/** 이 코드들은 '세션이 무효'가 아니라 '지금 확인할 수 없음' — 세션을 지우거나 새로 가입하지 않는다 */
const TRANSIENT: ReadonlySet<LateBetErrorCode> = new Set(['LB_OFFLINE', 'LB_TIMEOUT', 'LB_RATE_LIMITED', 'LB_NOT_CONFIGURED']);

function authError(e: unknown): LateBetError {
  const m = mapRpcError(e);
  if (TRANSIENT.has(m.code) || m.code === 'LB_NOT_SIGNED_IN') return m;
  return new LateBetError('LB_NOT_SIGNED_IN', m.detail ?? m.message);
}

export function createAuthSession(port: AuthPort, opts: { timeoutMs: number }): AuthSession {
  /** 부른 쪽의 기다림에만 상한을 건다. 원래 promise 는 계속 간다 */
  function withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LateBetError('LB_TIMEOUT', 'auth')), opts.timeoutMs);
    });
    return Promise.race([p, t]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  /** 끝날 때까지 하나만: 끝나면(성공·실패 모두) 스스로 비운다. 타임아웃으로는 비우지 않는다 */
  function singleFlight(start: () => Promise<string>): { run: () => Promise<string>; pending: () => boolean } {
    let current: Promise<string> | null = null;
    return {
      run: () => {
        if (!current) {
          const p = start();
          current = p;
          const clear = () => {
            if (current === p) current = null;
          };
          p.then(clear, clear);
        }
        return current;
      },
      pending: () => current !== null,
    };
  }

  /** 세션 확인 + (없으면) 익명 가입을 한 덩어리로. 가입 요청이 끝날 때까지 다음 호출은 이것을 기다린다 */
  const ensure = singleFlight(async () => {
    const { data, error } = await port.getSession();
    if (error) throw authError(error);
    const existing = data.session?.user?.id ?? null;
    if (existing) return existing;
    const res = await port.signInAnonymously();
    if (res.error) throw mapRpcError(res.error);
    const id = res.data.user?.id ?? res.data.session?.user?.id ?? null;
    if (!id) throw new LateBetError('LB_NOT_SIGNED_IN', '익명 로그인 응답에 user 없음');
    return id;
  });

  const refresh = singleFlight(async () => {
    const { data, error } = await port.refreshSession();
    const id = error ? null : (data.session?.user?.id ?? data.user?.id ?? null);
    if (id) return id;
    const err = error ? authError(error) : new LateBetError('LB_NOT_SIGNED_IN', 'refresh 응답에 세션 없음');
    if (err.code === 'LB_NOT_SIGNED_IN') {
      // 이 세션으로는 더 갈 수 없다 → 로컬 세션을 지운다(다음 ensureSignedIn 이 새로 로그인). 실패해도 오류는 그대로
      await withTimeout(Promise.resolve().then(() => port.signOut())).catch(() => undefined);
    }
    throw err;
  });

  /** 저장된 세션의 userId. 진행 중인 ensure(익명 가입 포함)가 있으면 그것부터 기다린다 */
  async function current(): Promise<string | null> {
    if (ensure.pending()) return withTimeout(ensure.run());
    const { data, error } = await withTimeout(port.getSession());
    if (error) throw authError(error);
    return data.session?.user?.id ?? null;
  }

  return {
    ensureSession: () => withTimeout(ensure.run()),
    async requireSession() {
      const id = await current();
      if (!id) throw new LateBetError('LB_NOT_SIGNED_IN', '세션 없음');
      return id;
    },
    async restoreSession() {
      try {
        return await current();
      } catch (e) {
        // 세션이 무효(refresh 토큰 폐기 등)면 '없음'. 연결 문제는 그대로 던진다
        if (e instanceof LateBetError && e.code === 'LB_NOT_SIGNED_IN') return null;
        throw e;
      }
    },
    refreshSession: () => withTimeout(refresh.run()),
  };
}
