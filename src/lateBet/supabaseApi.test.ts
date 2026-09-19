import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LateBetError } from './errors';
import { createServerClock } from './serverClock';
import { createSupabaseApi, type LbTableQueries, type LbWireResult, type SupabaseApiDeps } from './supabaseApi';
import type { LateBetApi } from './api';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const APPT = '33333333-3333-4333-8333-333333333333';

const policy = { stake: 100, radiusM: 100, unitMinutes: 5, penaltyPerUnit: 20, graceMinutes: 0 };

// SQL(lb_appointment_json·lb_get_live …) 과 같은 키의 표본
const appointmentJson = {
  id: APPT,
  inviteCode: 'ABCDEFGH',
  hostId: ME,
  hostNickname: '민희',
  title: '저녁',
  localAt: '2026-09-20T19:00',
  tz: 'Asia/Seoul',
  meetAtMs: 1_790_000_000_000,
  startedAtMs: null,
  closeMs: 1_790_002_700_000,
  placeName: '강남역',
  placeNote: '',
  placeLat: 37.49,
  placeLng: 127.02,
  status: 'open',
  voidReason: null,
  version: 3,
  policy,
  invitees: [{ name: '철수', claimedByUserId: null, claimedAtMs: null }],
  changes: [],
};
const liveJson = {
  serverNowMs: 5_000_000,
  myUserId: ME,
  myState: 'active',
  myBalance: 900,
  settlePending: false,
  appointment: appointmentJson,
  participants: [
    {
      userId: ME,
      nickname: '민희',
      state: 'active',
      joinedAtMs: 1,
      arrivedAtMs: null,
      arrivalMethod: null,
      arrivalDistanceM: null,
      arrivalAccuracyM: null,
      vouchedBy: null,
      resultStatus: null,
      forfeited: null,
      received: null,
      lastSeenMs: null,
      location: null,
    },
  ],
};
const previewJson = {
  id: APPT,
  title: '저녁',
  hostNickname: '민희',
  localAt: '2026-09-20T19:00',
  tz: 'Asia/Seoul',
  meetAtMs: 1_790_000_000_000,
  startedAtMs: null,
  closeMs: 1_790_002_700_000,
  placeName: '강남역',
  placeNote: '',
  placeLat: 37.49,
  placeLng: 127.02,
  status: 'open',
  version: 3,
  serverNowMs: 5_000_000,
  policy,
  memberCount: 1,
  invitees: [{ name: '철수', claimed: false, mine: false }],
  myState: null,
  myBalance: 1000,
};
const RESPONSES: Record<string, unknown> = {
  lb_ping: { serverNowMs: 5_000_000, minBuild: 7, iosUrl: 'https://ios', androidUrl: 'https://android' },
  lb_ensure_profile: { user_id: ME, nickname: '민희', balance: 1000, created_at: '2026-09-19T00:00:00+00:00' },
  lb_create_appointment: appointmentJson,
  lb_peek_invite: previewJson,
  lb_claim_slot: { appointmentId: APPT, state: 'active', started: false },
  lb_start: { ...appointmentJson, startedAtMs: 1_789_999_000_000 },
  lb_edit_invitees: appointmentJson,
  lb_leave: null,
  lb_kick: null,
  lb_update_memo: null,
  lb_edit_appointment: { ...appointmentJson, version: 4 },
  lb_cancel: null,
  lb_report_location: { arrived: false, reason: 'outside', arrivedAtMs: null, distanceM: 350, serverNowMs: 5_000_000 },
  lb_stop_sharing: null,
  lb_vouch: null,
  lb_get_live: liveJson,
  lb_list_my_appointments: [
    {
      id: APPT,
      title: '저녁',
      localAt: '2026-09-20T19:00',
      tz: 'Asia/Seoul',
      meetAtMs: 1_790_000_000_000,
      startedAtMs: null,
      closeMs: 1_790_002_700_000,
      placeName: '강남역',
      status: 'open',
      policy,
      hostId: ME,
      isHost: true,
      myState: 'active',
      memberCount: 1,
      unclaimedCount: 1,
    },
  ],
  lb_list_ledger: [
    {
      id: 1,
      kind: 'grant',
      amount: 1000,
      balanceAfter: 1000,
      appointmentId: null,
      appointmentTitle: null,
      reason: 'signup',
      reliefFor: null,
      createdAtMs: 1,
    },
  ],
};

interface Call {
  fn: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
}

type Responder = (fn: string, args: Record<string, unknown>, signal: AbortSignal) => PromiseLike<LbWireResult>;

function harness(opts: { respond?: Responder; deps?: Partial<SupabaseApiDeps> } = {}) {
  const calls: Call[] = [];
  let sessions = 0;
  let signIns = 0;
  const respond: Responder =
    opts.respond ?? ((fn) => Promise.resolve({ data: RESPONSES[fn] ?? null, error: null }));
  const api = createSupabaseApi({
    rpc: (fn, args, signal) => {
      calls.push({ fn, args, signal });
      return respond(fn, args, signal);
    },
    ensureSession: async () => {
      signIns++;
      return ME;
    },
    requireSession: async () => {
      sessions++;
      return ME;
    },
    restoreSession: async () => ME,
    timeoutMs: 50,
    ...opts.deps,
  });
  return { api, calls, sessions: () => sessions, signIns: () => signIns };
}

async function rejectsCode(p: Promise<unknown>, code: string): Promise<LateBetError> {
  let caught: unknown = null;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof LateBetError, `LateBetError 가 아니다: ${String(caught)}`);
  assert.equal(caught.code, code, caught.detail ?? '');
  return caught;
}

/** [메서드 호출, 기대 RPC 이름, 기대 인자(마이그레이션 시그니처의 p_ 이름 그대로)] */
const TABLE: [string, (api: LateBetApi) => Promise<unknown>, string, Record<string, unknown>][] = [
  ['ping', (a) => a.ping(), 'lb_ping', {}],
  ['ensureProfile', (a) => a.ensureProfile('민희'), 'lb_ensure_profile', { p_nickname: '민희' }],
  [
    'createAppointment',
    (a) =>
      a.createAppointment({
        title: '저녁',
        localAt: '2026-09-20T19:00',
        tz: 'Asia/Seoul',
        placeName: '강남역',
        placeNote: '2번 출구',
        lat: 37.49,
        lng: 127.02,
        policy,
        invitees: ['철수', '영희'],
        consent: true,
      }),
    'lb_create_appointment',
    {
      p_title: '저녁',
      p_local_at: '2026-09-20T19:00',
      p_tz: 'Asia/Seoul',
      p_place_name: '강남역',
      p_place_note: '2번 출구',
      p_lat: 37.49,
      p_lng: 127.02,
      p_policy: policy,
      p_invitees: ['철수', '영희'],
      p_consent: true,
      p_tz_confirmed: false,
      p_request_id: null,
    },
  ],
  ['peekInvite', (a) => a.peekInvite('abcd2345'), 'lb_peek_invite', { p_code: 'abcd2345' }],
  [
    'claimSlot',
    (a) => a.claimSlot(APPT, '철수', 3, true),
    'lb_claim_slot',
    { p_appt: APPT, p_name: '철수', p_version: 3, p_consent: true },
  ],
  ['start', (a) => a.start(APPT), 'lb_start', { p_appt: APPT }],
  [
    'editInvitees',
    (a) => a.editInvitees(APPT, { add: ['수지'] }),
    'lb_edit_invitees',
    { p_appt: APPT, p_add: ['수지'], p_remove: [] },
  ],
  ['leave', (a) => a.leave(APPT), 'lb_leave', { p_appt: APPT }],
  ['kick', (a) => a.kick(APPT, OTHER), 'lb_kick', { p_appt: APPT, p_target: OTHER, p_ban: true }],
  [
    'updateMemo',
    (a) => a.updateMemo(APPT, '저녁2', '메모'),
    'lb_update_memo',
    { p_appt: APPT, p_title: '저녁2', p_place_note: '메모' },
  ],
  [
    'edit',
    (a) => a.edit(APPT, { localAt: '2026-09-20T20:00', policy: { ...policy, stake: 200 }, tzConfirmed: true }, 3),
    'lb_edit_appointment',
    {
      p_appt: APPT,
      p_patch: { localAt: '2026-09-20T20:00', policy: { ...policy, stake: 200 }, tzConfirmed: true },
      p_version: 3,
    },
  ],
  ['cancel', (a) => a.cancel(APPT), 'lb_cancel', { p_appt: APPT }],
  [
    'reportLocation',
    (a) => a.reportLocation(APPT, { lat: 37.5, lng: 127.03, accuracyM: null }),
    'lb_report_location',
    { p_appt: APPT, p_lat: 37.5, p_lng: 127.03, p_accuracy_m: null, p_mocked: false, p_share: true },
  ],
  ['stopSharing', (a) => a.stopSharing(APPT), 'lb_stop_sharing', { p_appt: APPT }],
  ['vouch', (a) => a.vouch(APPT, OTHER), 'lb_vouch', { p_appt: APPT, p_target: OTHER }],
  ['getLive', (a) => a.getLive(APPT), 'lb_get_live', { p_appt: APPT }],
  ['listMyAppointments', (a) => a.listMyAppointments(), 'lb_list_my_appointments', {}],
  ['listLedger', (a) => a.listLedger(), 'lb_list_ledger', { p_limit: 100 }],
];

describe('supabaseApi — RPC 18개(계약 16 + 목록·원장)의 이름·인자·응답', () => {
  it('표가 RPC 18개를 전부 덮는다', () => {
    assert.equal(TABLE.length, 18);
    assert.equal(new Set(TABLE.map((r) => r[2])).size, 18);
  });

  for (const [name, invoke, fn, args] of TABLE) {
    it(`${name} → ${fn}(${Object.keys(args).join(', ') || '인자 없음'})`, async () => {
      const h = harness();
      const res = await invoke(h.api);
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].fn, fn);
      assert.deepEqual(h.calls[0].args, args);
      // ping 만 세션 없이(anon 허용 — 핑 때문에 익명 계정을 만들지 않는다)
      assert.equal(h.sessions(), fn === 'lb_ping' ? 0 : 1);
      if (RESPONSES[fn] === null) assert.equal(res, undefined);
      else assert.notEqual(res, undefined);
    });
  }

  it('응답을 DTO 로 바꾼다(프로필은 snake → camel, 약속·live 는 그대로 검증)', async () => {
    const { api } = harness();
    assert.deepEqual(await api.ensureProfile('민희'), { userId: ME, nickname: '민희', balance: 1000 });
    assert.equal((await api.start(APPT)).startedAtMs, 1_789_999_000_000);
    assert.equal((await api.edit(APPT, {}, 3)).version, 4);
    assert.equal((await api.getLive(APPT)).participants[0].nickname, '민희');
    assert.equal((await api.peekInvite('X')).myBalance, 1000);
    assert.equal((await api.reportLocation(APPT, { lat: 1, lng: 2, accuracyM: 5 })).reason, 'outside');
  });

  it('선택 인자: tzConfirmed·mocked·share·ban·remove 를 명시값으로 보낸다', async () => {
    const h = harness();
    await h.api.createAppointment({
      title: 't',
      localAt: '2026-09-20T19:00',
      tz: 'Europe/Paris',
      placeName: 'p',
      placeNote: '',
      lat: 48.8,
      lng: 2.3,
      // 엔진 전용 필드가 섞여도 정책 5개 키만 나간다
      policy: { ...policy, extra: 1 } as typeof policy,
      invitees: [],
      consent: false,
      tzConfirmed: true,
    });
    assert.equal(h.calls[0].args.p_tz_confirmed, true);
    assert.deepEqual(h.calls[0].args.p_policy, policy);
    await h.api.reportLocation(APPT, { lat: 1, lng: 2, accuracyM: 12, mocked: true, share: false });
    assert.deepEqual(h.calls[1].args, {
      p_appt: APPT,
      p_lat: 1,
      p_lng: 2,
      p_accuracy_m: 12,
      p_mocked: true,
      p_share: false,
    });
    await h.api.kick(APPT, OTHER, false);
    assert.equal(h.calls[2].args.p_ban, false);
    await h.api.editInvitees(APPT, { remove: ['영희'] });
    assert.deepEqual(h.calls[3].args, { p_appt: APPT, p_add: [], p_remove: ['영희'] });
    // 바꿀 것만: 빈 패치는 빈 객체(undefined 키가 null 로 새지 않는다)
    await h.api.edit(APPT, { placeName: undefined, lat: 37.1, lng: 127.1 }, 5);
    assert.deepEqual(h.calls[4].args.p_patch, { lat: 37.1, lng: 127.1 });
  });

  it('uuid 가 아닌 약속·대상 id 는 서버에 보내지 않고 LB_NOT_FOUND', async () => {
    const h = harness();
    await rejectsCode(h.api.getLive('not-a-uuid'), 'LB_NOT_FOUND');
    await rejectsCode(h.api.vouch(APPT, 'x'), 'LB_NOT_FOUND');
    assert.equal(h.calls.length, 0);
  });
});

describe('supabaseApi — 오류·재시도·타임아웃', () => {
  it("raise 'LB_X' 는 그 코드로, using detail 은 detail 로", async () => {
    const h = harness({
      respond: (fn) =>
        Promise.resolve(
          fn === 'lb_edit_appointment'
            ? { data: null, error: { code: 'P0001', message: 'LB_INSUFFICIENT_POINTS', details: '철수', hint: null } }
            : { data: null, error: { code: 'P0001', message: 'LB_NOT_HOST', details: null, hint: null } },
        ),
    });
    const e = await rejectsCode(h.api.edit(APPT, { policy: { ...policy, stake: 300 } }, 3), 'LB_INSUFFICIENT_POINTS');
    assert.equal(e.detail, '철수');
    await rejectsCode(h.api.start(APPT), 'LB_NOT_HOST');
    assert.equal(h.calls.length, 2); // LB_ 오류는 재시도하지 않는다
  });

  it('40P01 은 조용히 1회 재시도해 성공한다', async () => {
    let n = 0;
    const h = harness({
      respond: (fn) =>
        Promise.resolve(
          n++ === 0 ? { data: null, error: { code: '40P01', message: 'deadlock detected' } } : { data: RESPONSES[fn], error: null },
        ),
    });
    const live = await h.api.getLive(APPT);
    assert.equal(live.myUserId, ME);
    assert.equal(h.calls.length, 2);
    assert.equal(h.sessions(), 1); // 세션은 호출당 한 번
  });

  it('40001 이 두 번 연속이면 LB_RETRYABLE 로 실패(재시도는 1회뿐)', async () => {
    const h = harness({ respond: () => Promise.resolve({ data: null, error: { code: '40001', message: 'serialize' } }) });
    await rejectsCode(h.api.claimSlot(APPT, '철수', 3, true), 'LB_RETRYABLE');
    assert.equal(h.calls.length, 2);
  });

  it('23514 는 LB_CHECK_VIOLATION, 재시도 없음', async () => {
    const h = harness({ respond: () => Promise.resolve({ data: null, error: { code: '23514', message: 'check' } }) });
    await rejectsCode(h.api.updateMemo(APPT, 'x'.repeat(41), ''), 'LB_CHECK_VIOLATION');
    assert.equal(h.calls.length, 1);
  });

  it('응답이 없으면 타임아웃(8초 → 테스트는 50ms)에 끊고 signal 을 abort 한다. 재시도하지 않는다', async () => {
    const h = harness({ respond: () => new Promise<LbWireResult>(() => undefined) });
    await rejectsCode(h.api.reportLocation(APPT, { lat: 1, lng: 2, accuracyM: 5 }), 'LB_TIMEOUT');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].signal.aborted, true);
  });

  it('signal 에 반응해 AbortError 를 돌려주는 구현도 LB_TIMEOUT', async () => {
    const h = harness({
      respond: (_fn, _args, signal) =>
        new Promise<LbWireResult>((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({ data: null, error: { message: 'AbortError: Aborted', code: '', hint: 'Request was aborted' } }),
          );
        }),
    });
    await rejectsCode(h.api.getLive(APPT), 'LB_TIMEOUT');
  });

  it('전송 실패(throw·status 0)는 LB_OFFLINE', async () => {
    const thrown = harness({ respond: () => Promise.reject(new TypeError('Network request failed')) });
    await rejectsCode(thrown.api.getLive(APPT), 'LB_OFFLINE');
    const wired = harness({
      respond: () => Promise.resolve({ data: null, error: { message: 'TypeError: Network request failed', code: '' } }),
    });
    await rejectsCode(wired.api.leave(APPT), 'LB_OFFLINE');
  });

  it('응답 모양이 계약과 다르면 LB_BAD_RESPONSE (재시도 없음)', async () => {
    const h = harness({ respond: () => Promise.resolve({ data: { ...liveJson, myBalance: 'many' }, error: null }) });
    await rejectsCode(h.api.getLive(APPT), 'LB_BAD_RESPONSE');
    assert.equal(h.calls.length, 1);
    const v = harness({ respond: () => Promise.resolve({ data: { unexpected: true }, error: null }) });
    await rejectsCode(v.api.cancel(APPT), 'LB_BAD_RESPONSE');
  });

  it('세션 확보가 실패하면 RPC 를 부르지 않고 그 오류(레이트 리밋·오프라인)를 낸다', async () => {
    const rate = harness({
      deps: {
        ensureSession: () =>
          Promise.reject({ name: 'AuthApiError', status: 429, code: 'over_request_rate_limit', message: 'rate limit' }),
        requireSession: () =>
          Promise.reject({ name: 'AuthApiError', status: 429, code: 'over_request_rate_limit', message: 'rate limit' }),
      },
    });
    await rejectsCode(rate.api.getLive(APPT), 'LB_RATE_LIMITED');
    await rejectsCode(rate.api.ensureSignedIn(), 'LB_RATE_LIMITED');
    assert.equal(rate.calls.length, 0);
    const off = harness({
      deps: { requireSession: () => Promise.reject({ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' }) },
    });
    await rejectsCode(off.api.start(APPT), 'LB_OFFLINE');
    // ping 은 세션이 없어도 된다
    assert.equal((await off.api.ping()).minBuild, 7);
  });
});

describe('supabaseApi — 서버 시계·세션·조회', () => {
  it('serverNowMs 가 있는 응답은 rpc 왕복(t0·t1)으로 시계를 잰다 — 세션 확보 시간은 빼고', async () => {
    const clock = createServerClock(() => 0);
    let device = 1_000;
    const h = harness({
      deps: {
        clock,
        now: () => device,
        requireSession: async () => {
          device += 5_000; // 느린 세션 확보는 RTT 에 들어가지 않는다
          return ME;
        },
      },
      respond: (fn) => {
        device += 100;
        return Promise.resolve({ data: RESPONSES[fn], error: null });
      },
    });
    await h.api.getLive(APPT);
    // t0 = 6,000, t1 = 6,100 → 가운데 6,050. serverNowMs 5,000,000
    assert.equal(clock.offsetMs(), 5_000_000 - 6_050);
    assert.equal(clock.hasSample(), true);
  });

  it('serverNowMs 가 없는 응답(start 등)은 시계를 건드리지 않는다', async () => {
    const clock = createServerClock(() => 0);
    const h = harness({ deps: { clock } });
    await h.api.start(APPT);
    assert.equal(clock.hasSample(), false);
    await h.api.ping();
    assert.equal(clock.hasSample(), true);
  });

  it('restoreSession 은 저장된 세션만 본다(새로 로그인하지 않는다)', async () => {
    const h = harness({ deps: { restoreSession: async () => null } });
    assert.equal(await h.api.restoreSession(), null);
    assert.equal(h.signIns(), 0);
    assert.equal(await h.api.ensureSignedIn(), ME);
    assert.equal(h.signIns(), 1);
  });

  it('목록·원장은 RPC — 원장 limit 은 1~500 정수로 보낸다', async () => {
    const h = harness();
    const list = await h.api.listMyAppointments();
    assert.equal(list[0].isHost, true);
    assert.equal(list[0].unclaimedCount, 1);
    assert.equal((await h.api.listLedger())[0].reason, 'signup');
    await h.api.listLedger(10_000);
    await h.api.listLedger(0);
    await h.api.listLedger(7.9);
    assert.deepEqual(
      h.calls.filter((c) => c.fn === 'lb_list_ledger').map((c) => c.args.p_limit),
      [100, 500, 1, 7],
    );
  });

  it('getMyProfile 은 RLS select(profiles) — 같은 매핑·재시도를 타고, 어댑터가 없으면 LB_NOT_CONFIGURED', async () => {
    let n = 0;
    const query: LbTableQueries = {
      profile: () =>
        Promise.resolve(
          n++ === 0
            ? { data: null, error: { code: '40P01', message: 'deadlock' } }
            : { data: { user_id: ME, nickname: 'a', balance: 5 }, error: null },
        ),
    };
    const h = harness({ deps: { query } });
    assert.deepEqual(await h.api.getMyProfile(), { userId: ME, nickname: 'a', balance: 5 });
    assert.equal(n, 2);
    assert.equal(h.calls.length, 0); // RPC 가 아니다
    const empty = harness({ deps: { query: { profile: () => Promise.resolve({ data: null, error: null }) } } });
    assert.equal(await empty.api.getMyProfile(), null);
    const expired = harness({
      deps: { query: { profile: () => Promise.resolve({ data: null, error: { code: 'PGRST301', message: 'JWT expired' } }) } },
    });
    await rejectsCode(expired.api.getMyProfile(), 'LB_NOT_SIGNED_IN');
    const none = harness();
    await rejectsCode(none.api.getMyProfile(), 'LB_NOT_CONFIGURED');
  });
});

describe('supabaseApi — 멱등 생성·토큰 거부·세션 없음(적대 리뷰 회귀)', () => {
  const createInput = {
    title: '저녁',
    localAt: '2026-09-20T19:00',
    tz: 'Asia/Seoul',
    placeName: '강남역',
    placeNote: '',
    lat: 37.49,
    lng: 127.02,
    policy,
    invitees: [],
    consent: true,
  };

  it('생성 멱등 키: requestId(uuid)를 p_request_id 로 보내고, 재시도에도 같은 값이다. uuid 가 아니면 null', async () => {
    const h = harness();
    const rid = '7d4b1c2e-0000-4000-8000-00000000abcd';
    await h.api.createAppointment({ ...createInput, requestId: rid });
    await h.api.createAppointment({ ...createInput, requestId: rid });
    await h.api.createAppointment({ ...createInput, requestId: 'not-a-uuid' });
    assert.deepEqual(
      h.calls.map((c) => c.args.p_request_id),
      [rid, rid, null],
    );
  });

  it('서버가 JWT 를 거부(PGRST303)하면 refreshSession 한 번 → 같은 호출을 한 번 더 한다', async () => {
    let refreshes = 0;
    let n = 0;
    const h = harness({
      respond: (fn) =>
        Promise.resolve(
          n++ === 0
            ? { data: null, error: { code: 'PGRST303', message: 'JWT expired' } }
            : { data: RESPONSES[fn], error: null },
        ),
      deps: {
        refreshSession: async () => {
          refreshes++;
          return ME;
        },
      },
    });
    const list = await h.api.listMyAppointments();
    assert.equal(list.length, 1);
    assert.equal(refreshes, 1);
    assert.equal(h.calls.length, 2);
    assert.equal(h.signIns(), 0); // 새 익명 가입 없음
  });

  it('refresh 뒤에도 거부되면 재시도는 한 번뿐 — LB_NOT_SIGNED_IN (무한 루프 없음)', async () => {
    let refreshes = 0;
    const h = harness({
      respond: () => Promise.resolve({ data: null, error: { status: 401, code: 'PGRST301', message: 'JWT expired' } }),
      deps: {
        refreshSession: async () => {
          refreshes++;
          return ME;
        },
      },
    });
    await rejectsCode(h.api.getLive(APPT), 'LB_NOT_SIGNED_IN');
    assert.equal(refreshes, 1);
    assert.equal(h.calls.length, 2);
  });

  it('refresh 자체가 실패하면 그 오류를 낸다(무효 → LB_NOT_SIGNED_IN, 연결 → LB_OFFLINE)', async () => {
    const expired = () => Promise.resolve({ data: null, error: { code: 'PGRST303', message: 'JWT expired' } });
    const revoked = harness({
      respond: expired,
      deps: { refreshSession: () => Promise.reject(new LateBetError('LB_NOT_SIGNED_IN', 'revoked')) },
    });
    await rejectsCode(revoked.api.listMyAppointments(), 'LB_NOT_SIGNED_IN');
    assert.equal(revoked.calls.length, 1);
    const off = harness({
      respond: expired,
      deps: { refreshSession: () => Promise.reject({ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' }) },
    });
    await rejectsCode(off.api.listMyAppointments(), 'LB_OFFLINE');
  });

  it('일반 RPC 는 세션이 없으면 LB_NOT_SIGNED_IN — 몰래 익명 가입하지 않는다(ensureSession 을 부르지 않는다)', async () => {
    const h = harness({
      deps: { requireSession: () => Promise.reject(new LateBetError('LB_NOT_SIGNED_IN', '세션 없음')) },
    });
    await rejectsCode(h.api.listMyAppointments(), 'LB_NOT_SIGNED_IN');
    await rejectsCode(h.api.getLive(APPT), 'LB_NOT_SIGNED_IN');
    assert.equal(h.signIns(), 0);
    assert.equal(h.calls.length, 0);
    // ping 은 세션 없이
    assert.equal((await h.api.ping()).minBuild, 7);
  });
});
