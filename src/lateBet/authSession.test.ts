import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAuthSession, type AuthPort } from './authSession';
import { LateBetError } from './errors';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** auth-js 흉내: 가입 응답이 오면 무조건 세션을 저장한다(늦게 와도) */
function fakeAuth(opts: { signupDelays?: number[]; stored?: string | null; getSessionError?: unknown; refresh?: () => Promise<unknown> } = {}) {
  const st = {
    stored: opts.stored ?? null,
    signups: 0,
    refreshes: 0,
    signOuts: 0,
    getSessionError: opts.getSessionError ?? null,
  };
  const delays = opts.signupDelays ?? [0];
  const port: AuthPort = {
    getSession: async () => {
      if (st.getSessionError) {
        const error = st.getSessionError;
        // auth-js: 무효 refresh 토큰이면 세션을 지우고 오류를 한 번 돌려준다
        st.getSessionError = null;
        st.stored = null;
        return { data: { session: null }, error };
      }
      return { data: { session: st.stored ? { user: { id: st.stored } } : null }, error: null };
    },
    signInAnonymously: async () => {
      const n = st.signups++;
      await sleep(delays[Math.min(n, delays.length - 1)]);
      const id = `U${n + 1}`;
      st.stored = id;
      return { data: { user: { id }, session: { user: { id } } }, error: null };
    },
    refreshSession: async () => {
      st.refreshes++;
      if (opts.refresh) {
        const r = await opts.refresh();
        return r as Awaited<ReturnType<AuthPort['refreshSession']>>;
      }
      return { data: { session: st.stored ? { user: { id: st.stored } } : null }, error: null };
    },
    signOut: async () => {
      st.signOuts++;
      st.stored = null;
      return { error: null };
    },
  };
  return { st, port };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof LateBetError ? e.code : String(e);
  }
}

describe('authSession — 익명 가입 타임아웃 경주(적대 리뷰 #2)', () => {
  it('가입이 타임아웃돼도 진행 중인 요청을 버리지 않는다: 재시도는 새로 가입하지 않고 그 요청을 기다린다', async () => {
    const { st, port } = fakeAuth({ signupDelays: [60, 10] });
    const auth = createAuthSession(port, { timeoutMs: 30 });
    assert.equal(await code(auth.ensureSession()), 'LB_TIMEOUT'); // 30ms: 1차 실패
    const second = await auth.ensureSession(); // 사용자 재시도 → 1차 요청(60ms)을 다시 기다린다
    assert.equal(second, 'U1');
    await sleep(80);
    assert.equal(st.signups, 1); // 익명 계정은 하나뿐
    assert.equal(st.stored, 'U1'); // 늦게 끝난 가입이 세션을 덮어쓰지 않는다
  });

  it('차례로 재시도(각 단계가 끝난 뒤)해도 두 번째 가입이 생기지 않는다 — 프로필을 만든 계정이 끝까지 저장 세션이다', async () => {
    const { st, port } = fakeAuth({ signupDelays: [100, 20] });
    const auth = createAuthSession(port, { timeoutMs: 40 });
    assert.equal(await code(auth.ensureSession()), 'LB_TIMEOUT'); // t=40
    assert.equal(await code(auth.ensureSession()), 'LB_TIMEOUT'); // t=80, 아직 1차 진행 중
    const uid = await auth.ensureSession(); // t=100 에 1차 도착
    assert.equal(uid, 'U1');
    assert.equal(await auth.requireSession(), 'U1'); // 이 uid 로 lb_ensure_profile 이 나간다
    await sleep(60);
    assert.equal(st.signups, 1);
    assert.equal(await auth.restoreSession(), 'U1');
  });

  it('동시에 여러 화면이 불러도 가입은 한 번', async () => {
    const { st, port } = fakeAuth({ signupDelays: [10] });
    const auth = createAuthSession(port, { timeoutMs: 100 });
    const ids = await Promise.all([auth.ensureSession(), auth.ensureSession(), auth.ensureSession()]);
    assert.deepEqual(ids, ['U1', 'U1', 'U1']);
    assert.equal(st.signups, 1);
  });

  it('가입이 실패로 끝나면 다음 진입에서 다시 시도할 수 있다', async () => {
    const { st, port } = fakeAuth();
    let fail = true;
    const orig = port.signInAnonymously;
    port.signInAnonymously = async () => {
      if (fail) {
        fail = false;
        st.signups++;
        return { data: { user: null }, error: { status: 429, code: 'over_request_rate_limit', message: 'rate limit' } };
      }
      return orig();
    };
    const auth = createAuthSession(port, { timeoutMs: 100 });
    assert.equal(await code(auth.ensureSession()), 'LB_RATE_LIMITED');
    assert.equal(await auth.ensureSession(), 'U2');
  });
});

describe('authSession — 일반 RPC 는 몰래 가입하지 않는다(적대 리뷰 #4)', () => {
  it('세션이 없으면 requireSession 은 LB_NOT_SIGNED_IN, restoreSession 은 null — 가입 0', async () => {
    const { st, port } = fakeAuth();
    const auth = createAuthSession(port, { timeoutMs: 50 });
    assert.equal(await code(auth.requireSession()), 'LB_NOT_SIGNED_IN');
    assert.equal(await auth.restoreSession(), null);
    assert.equal(st.signups, 0);
  });

  it('refresh 토큰이 무효(Already Used)면 세션이 지워지고 LB_NOT_SIGNED_IN — 새 익명 계정으로 갈아타지 않는다', async () => {
    const { st, port } = fakeAuth({
      stored: 'aa',
      getSessionError: { name: 'AuthApiError', status: 400, code: 'refresh_token_already_used', message: 'Invalid Refresh Token: Already Used' },
    });
    const auth = createAuthSession(port, { timeoutMs: 50 });
    assert.equal(await code(auth.requireSession()), 'LB_NOT_SIGNED_IN');
    assert.equal(await code(auth.requireSession()), 'LB_NOT_SIGNED_IN'); // 두 번째도(세션 없음)
    assert.equal(st.signups, 0);
    // 명시적 진입(ensureSignedIn)에서만 새로 가입한다
    assert.equal(await auth.ensureSession(), 'U1');
  });

  it('getSession 이 연결 오류면 세션을 없다고 하지 않는다(LB_OFFLINE)', async () => {
    const { port } = fakeAuth({ stored: 'aa' });
    port.getSession = async () => ({ data: { session: null }, error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' } });
    const auth = createAuthSession(port, { timeoutMs: 50 });
    assert.equal(await code(auth.restoreSession()), 'LB_OFFLINE');
    assert.equal(await code(auth.requireSession()), 'LB_OFFLINE');
  });

  it('진행 중인 가입이 있으면 requireSession 은 그것을 기다린다', async () => {
    const { port } = fakeAuth({ signupDelays: [20] });
    const auth = createAuthSession(port, { timeoutMs: 100 });
    const p = auth.ensureSession();
    assert.equal(await auth.requireSession(), 'U1');
    assert.equal(await p, 'U1');
  });
});

describe('authSession — 토큰 거부 뒤 refresh(적대 리뷰 #3)', () => {
  it('refresh 는 같은 계정 토큰만 새로 받는다(가입 0). 동시에 불러도 한 번', async () => {
    const { st, port } = fakeAuth({ stored: 'aa' });
    const auth = createAuthSession(port, { timeoutMs: 50 });
    assert.deepEqual(await Promise.all([auth.refreshSession(), auth.refreshSession()]), ['aa', 'aa']);
    assert.equal(st.refreshes, 1);
    assert.equal(st.signups, 0);
  });

  it('refresh 토큰이 무효면 로컬 세션을 지우고(signOut) LB_NOT_SIGNED_IN', async () => {
    const { st, port } = fakeAuth({
      stored: 'aa',
      refresh: async () => ({ data: { session: null, user: null }, error: { status: 400, code: 'refresh_token_not_found', message: 'Invalid Refresh Token: Refresh Token Not Found' } }),
    });
    const auth = createAuthSession(port, { timeoutMs: 50 });
    assert.equal(await code(auth.refreshSession()), 'LB_NOT_SIGNED_IN');
    assert.equal(st.signOuts, 1);
    assert.equal(st.stored, null);
  });

  it('refresh 가 연결 오류면 세션을 지우지 않는다(LB_OFFLINE)', async () => {
    const { st, port } = fakeAuth({
      stored: 'aa',
      refresh: async () => ({ data: { session: null }, error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' } }),
    });
    const auth = createAuthSession(port, { timeoutMs: 50 });
    assert.equal(await code(auth.refreshSession()), 'LB_OFFLINE');
    assert.equal(st.signOuts, 0);
    assert.equal(st.stored, 'aa');
  });
});
