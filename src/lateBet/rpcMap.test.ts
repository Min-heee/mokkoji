import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LateBetError } from './errors';
import {
  mapAppointment,
  mapInvitePreview,
  mapJoinResult,
  mapLedger,
  mapLive,
  mapMaybeProfileRow,
  mapMyAppointments,
  mapPing,
  mapProfileRow,
  mapReportResult,
  mapRpcError,
  mapVoid,
} from './rpcMap';

// 마이그레이션의 jsonb_build_object 를 그대로 옮긴 표본(키 이름·null 위치가 SQL 과 같아야 한다)
const HOST = '11111111-1111-4111-8111-111111111111';
const GUEST = '22222222-2222-4222-8222-222222222222';
const APPT = '33333333-3333-4333-8333-333333333333';

const policy = { stake: 100, radiusM: 100, unitMinutes: 5, penaltyPerUnit: 20, graceMinutes: 0 };
const snapshot = {
  localAt: '2026-09-20T19:00',
  tz: 'Asia/Seoul',
  meetAtMs: 1_790_000_000_000,
  placeName: '강남역',
  placeLat: 37.49,
  placeLng: 127.02,
  policy,
};

/** private.lb_appointment_json */
function appointmentJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: APPT,
    inviteCode: 'ABCDEFGH',
    hostId: HOST,
    hostNickname: '민희',
    title: '저녁',
    localAt: '2026-09-20T19:00',
    tz: 'Asia/Seoul',
    meetAtMs: 1_790_000_000_000,
    startedAtMs: null,
    closeMs: 1_790_000_000_000 + 45 * 60_000,
    placeName: '강남역',
    placeNote: '',
    placeLat: 37.49,
    placeLng: 127.02,
    status: 'open',
    voidReason: null,
    version: 1,
    policy,
    invitees: [
      { name: '철수', claimedByUserId: GUEST, claimedAtMs: 1_789_999_000_000 },
      { name: '영희', claimedByUserId: null, claimedAtMs: null },
    ],
    changes: [],
    ...over,
  };
}

/** lb_get_live */
function liveJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serverNowMs: 1_789_999_500_000,
    myUserId: HOST,
    myState: 'active',
    myBalance: 900,
    settlePending: false,
    appointment: appointmentJson({ startedAtMs: 1_789_999_400_000 }),
    participants: [
      {
        userId: HOST,
        nickname: '민희',
        state: 'active',
        joinedAtMs: 1_789_990_000_000,
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
      {
        userId: GUEST,
        nickname: '철수',
        state: 'active',
        joinedAtMs: 1_789_999_000_000,
        arrivedAtMs: null,
        arrivalMethod: null,
        arrivalDistanceM: null,
        arrivalAccuracyM: null,
        vouchedBy: null,
        resultStatus: null,
        forfeited: null,
        received: null,
        lastSeenMs: 1_789_999_490_000,
        location: { lat: 37.5, lng: 127.03, accuracyM: 12.5, updatedAtMs: 1_789_999_490_000, distanceM: 1400 },
      },
    ],
    ...over,
  };
}

/** lb_peek_invite */
function previewJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    version: 2,
    serverNowMs: 1_789_999_000_000,
    policy,
    memberCount: 2,
    invitees: [{ name: '영희', claimed: false, mine: false }],
    myState: null,
    myBalance: null,
    ...over,
  };
}

function throwsCode(fn: () => unknown, code: string, pathPart?: string) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof LateBetError, String(e));
    assert.equal(e.code, code);
    if (pathPart) assert.ok(String(e.detail).includes(pathPart), `detail '${e.detail}' 에 '${pathPart}' 가 없다`);
    return true;
  });
}

describe('rpcMap — RPC jsonb', () => {
  it('lb_appointment_json 을 LbAppointment 로 옮긴다(명단·변경 이력 포함)', () => {
    const change = { version: 2, atMs: 1_789_999_100_000, before: snapshot, after: { ...snapshot, meetAtMs: 1_790_001_800_000 } };
    const a = mapAppointment(appointmentJson({ version: 2, changes: [change] }));
    assert.equal(a.id, APPT);
    assert.equal(a.startedAtMs, null);
    assert.equal(a.voidReason, null);
    assert.deepEqual(a.policy, policy);
    assert.deepEqual(a.invitees[1], { name: '영희', claimedByUserId: null, claimedAtMs: null });
    assert.equal(a.changes[0].after.meetAtMs, 1_790_001_800_000);
    assert.deepEqual(a.changes[0].before.policy, policy);
  });

  it('jsonb 에서 null 키가 빠져 와도 nullable 필드는 null 로 받는다', () => {
    const raw = appointmentJson();
    delete raw.startedAtMs;
    delete raw.voidReason;
    const a = mapAppointment(raw);
    assert.equal(a.startedAtMs, null);
    assert.equal(a.voidReason, null);
  });

  it('필수 필드 누락·타입 불일치·모르는 enum 은 LB_BAD_RESPONSE (NaN 을 만들지 않는다)', () => {
    const noMeet = appointmentJson();
    delete noMeet.meetAtMs;
    throwsCode(() => mapAppointment(noMeet), 'LB_BAD_RESPONSE', 'meetAtMs');
    throwsCode(() => mapAppointment(appointmentJson({ meetAtMs: '1790000000000' })), 'LB_BAD_RESPONSE', 'meetAtMs');
    throwsCode(() => mapAppointment(appointmentJson({ status: 'locked' })), 'LB_BAD_RESPONSE', 'status');
    throwsCode(() => mapAppointment(appointmentJson({ version: 1.5 })), 'LB_BAD_RESPONSE', 'version');
    throwsCode(
      () => mapAppointment(appointmentJson({ policy: { ...policy, radiusM: null } })),
      'LB_BAD_RESPONSE',
      'policy.radiusM',
    );
    throwsCode(() => mapAppointment(appointmentJson({ invitees: null })), 'LB_BAD_RESPONSE', 'invitees');
    throwsCode(() => mapAppointment(null), 'LB_BAD_RESPONSE');
  });

  it('lb_get_live: 참가자·위치를 옮기고, 위치 모양이 틀리면 거부한다', () => {
    const live = mapLive(liveJson());
    assert.equal(live.myBalance, 900);
    assert.equal(live.appointment.startedAtMs, 1_789_999_400_000);
    assert.equal(live.participants.length, 2);
    assert.equal(live.participants[0].location, null);
    assert.deepEqual(live.participants[1].location, {
      lat: 37.5,
      lng: 127.03,
      accuracyM: 12.5,
      updatedAtMs: 1_789_999_490_000,
      distanceM: 1400,
    });
    const broken = liveJson();
    (broken.participants as Record<string, unknown>[])[1].location = { lat: 37.5 };
    throwsCode(() => mapLive(broken), 'LB_BAD_RESPONSE', 'participants[1].location');
    throwsCode(() => mapLive(liveJson({ myState: 'pending' })), 'LB_BAD_RESPONSE', 'myState');
  });

  it('정산 뒤 참가자 결과(resultStatus·forfeited·received)와 보증 도착을 옮긴다', () => {
    const raw = liveJson();
    const p = (raw.participants as Record<string, unknown>[])[1];
    Object.assign(p, {
      arrivedAtMs: 1_790_000_100_000,
      arrivalMethod: 'vouch',
      vouchedBy: HOST,
      resultStatus: 'late',
      forfeited: 20,
      received: 0,
      location: null,
      lastSeenMs: null,
    });
    const live = mapLive({ ...raw, appointment: appointmentJson({ status: 'settled' }) });
    assert.equal(live.participants[1].arrivalMethod, 'vouch');
    assert.equal(live.participants[1].resultStatus, 'late');
    assert.equal(live.participants[1].forfeited, 20);
    throwsCode(
      () => mapLive({ ...raw, participants: [{ ...p, resultStatus: 'absent' }] }),
      'LB_BAD_RESPONSE',
      'resultStatus',
    );
  });

  it('lb_peek_invite: 명단(claimed·mine)·myState null·myBalance null', () => {
    const v = mapInvitePreview(previewJson());
    assert.equal(v.myState, null);
    assert.equal(v.myBalance, null);
    assert.deepEqual(v.invitees, [{ name: '영희', claimed: false, mine: false }]);
    assert.equal(mapInvitePreview(previewJson({ myState: 'active', myBalance: 700 })).myState, 'active');
    throwsCode(() => mapInvitePreview(previewJson({ invitees: [{ name: '영희', claimed: 'no', mine: false }] })), 'LB_BAD_RESPONSE');
  });

  it('lb_claim_slot·lb_ping·lb_report_location', () => {
    assert.deepEqual(mapJoinResult({ appointmentId: APPT, state: 'active', started: true }), {
      appointmentId: APPT,
      state: 'active',
      started: true,
    });
    throwsCode(() => mapJoinResult({ appointmentId: APPT, state: 'active' }), 'LB_BAD_RESPONSE', 'started');
    assert.deepEqual(mapPing({ serverNowMs: 5, minBuild: 7, iosUrl: '', androidUrl: 'x' }), {
      serverNowMs: 5,
      minBuild: 7,
      iosUrl: '',
      androidUrl: 'x',
    });
    // 도착: reason null
    assert.equal(
      mapReportResult({ arrived: true, reason: null, arrivedAtMs: 9, distanceM: 30, serverNowMs: 10 }).arrived,
      true,
    );
    // 이미 도착: arrived=true 인 채로 reason 이 붙는다(SQL 그대로)
    assert.equal(
      mapReportResult({ arrived: true, reason: 'already_arrived', arrivedAtMs: 9, distanceM: null, serverNowMs: 10 }).reason,
      'already_arrived',
    );
    // 좌표를 안 본 거절: distanceM null
    assert.equal(
      mapReportResult({ arrived: false, reason: 'not_open', arrivedAtMs: null, distanceM: null, serverNowMs: 10 }).distanceM,
      null,
    );
    throwsCode(
      () => mapReportResult({ arrived: false, reason: null, arrivedAtMs: null, distanceM: 5, serverNowMs: 10 }),
      'LB_BAD_RESPONSE',
    );
    throwsCode(
      () => mapReportResult({ arrived: false, reason: 'pending', arrivedAtMs: null, distanceM: 5, serverNowMs: 10 }),
      'LB_BAD_RESPONSE',
      'reason',
    );
  });

  it('lb_ensure_profile 은 profiles 행(snake_case) 그대로 — 객체든 한 칸 배열이든', () => {
    const row = { user_id: HOST, nickname: '민희', balance: 1000, created_at: '2026-09-19T00:00:00+00:00' };
    assert.deepEqual(mapProfileRow(row), { userId: HOST, nickname: '민희', balance: 1000 });
    assert.deepEqual(mapProfileRow([row]), { userId: HOST, nickname: '민희', balance: 1000 });
    throwsCode(() => mapProfileRow({ userId: HOST, nickname: '민희', balance: 1000 }), 'LB_BAD_RESPONSE', 'user_id');
    throwsCode(() => mapProfileRow([]), 'LB_BAD_RESPONSE');
  });

  it('void RPC 는 null·빈 본문만 받는다', () => {
    assert.equal(mapVoid(null), undefined);
    assert.equal(mapVoid(''), undefined);
    assert.equal(mapVoid(undefined), undefined);
    throwsCode(() => mapVoid({ ok: true }), 'LB_BAD_RESPONSE');
  });
});

describe('rpcMap — 조회', () => {
  it('getMyProfile(RLS select profiles, snake_case 행): 행이 없으면 null', () => {
    assert.equal(mapMaybeProfileRow(null), null);
    assert.equal(mapMaybeProfileRow([]), null);
    assert.equal(mapMaybeProfileRow({ user_id: HOST, nickname: 'a', balance: 3 })?.balance, 3);
  });

  it('lb_list_my_appointments: camelCase 한 줄을 그대로 옮기고 서버 순서를 지킨다', () => {
    const row = {
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
      hostId: GUEST,
      isHost: false,
      myState: 'active',
      memberCount: 2,
      unclaimedCount: 1,
    };
    const later = { ...row, id: 'later', status: 'settled', startedAtMs: 1_789_999_000_000, isHost: true };
    const list = mapMyAppointments([row, later]);
    assert.deepEqual(list[0], row);
    assert.equal(list[1].id, 'later');
    assert.equal(list[1].startedAtMs, 1_789_999_000_000);
    assert.deepEqual(mapMyAppointments([]), []);
    throwsCode(() => mapMyAppointments([{ ...row, memberCount: '2' }]), 'LB_BAD_RESPONSE', 'memberCount');
    throwsCode(() => mapMyAppointments([{ ...row, isHost: null }]), 'LB_BAD_RESPONSE', 'isHost');
    throwsCode(() => mapMyAppointments(null), 'LB_BAD_RESPONSE');
  });

  it('lb_list_ledger: reason(모르는 값은 null)·reliefFor(relief 만)·appointmentTitle, bigint 문자열 id 허용', () => {
    const rows = [
      {
        id: '3',
        kind: 'hold',
        amount: -100,
        balanceAfter: 900,
        appointmentId: APPT,
        appointmentTitle: '저녁',
        reason: null,
        reliefFor: null,
        createdAtMs: 3,
      },
      {
        id: 2,
        kind: 'relief',
        amount: 50,
        balanceAfter: 1050,
        appointmentId: null,
        appointmentTitle: null,
        reason: 'topup',
        reliefFor: APPT,
        createdAtMs: 2,
      },
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
      {
        id: 0,
        kind: 'payout',
        amount: 120,
        balanceAfter: 1120,
        appointmentId: APPT,
        appointmentTitle: null,
        reason: 'someday_new_reason',
        reliefFor: 'ignored',
        createdAtMs: 0,
      },
    ];
    const out = mapLedger(rows);
    assert.deepEqual(
      out.map((l) => l.id),
      [3, 2, 1, 0],
    );
    assert.equal(out[0].appointmentTitle, '저녁');
    assert.equal(out[0].reason, null);
    assert.equal(out[1].reliefFor, APPT);
    assert.equal(out[1].reason, 'topup');
    assert.equal(out[2].reason, 'signup');
    assert.equal(out[3].reason, null);
    assert.equal(out[3].reliefFor, null);
    throwsCode(() => mapLedger([{ ...rows[0], kind: 'bonus' }]), 'LB_BAD_RESPONSE', 'kind');
    throwsCode(() => mapLedger([{ ...rows[0], balanceAfter: null }]), 'LB_BAD_RESPONSE', 'balanceAfter');
  });
});

describe('rpcMap — 오류 매핑', () => {
  it("raise exception 'LB_X' 는 message 에 실린다 → 그 코드. using detail 은 detail 로", () => {
    const e = mapRpcError({ code: 'P0001', message: 'LB_SLOT_TAKEN', details: null, hint: null });
    assert.equal(e.code, 'LB_SLOT_TAKEN');
    const ins = mapRpcError({ code: 'P0001', message: 'LB_INSUFFICIENT_POINTS', details: '철수', hint: null });
    assert.equal(ins.code, 'LB_INSUFFICIENT_POINTS');
    assert.equal(ins.detail, '철수');
  });

  it('details(사용자 입력)에 LB_ 글자가 있어도 코드로 읽지 않는다', () => {
    const e = mapRpcError({ code: '23514', message: 'new row violates check constraint', details: 'LB_NOT_HOST' });
    assert.equal(e.code, 'LB_CHECK_VIOLATION');
  });

  it('모르는 LB_ 코드(LB_LEDGER_IMMUTABLE 등)는 LB_UNKNOWN', () => {
    assert.equal(mapRpcError({ code: 'P0001', message: 'LB_LEDGER_IMMUTABLE' }).code, 'LB_UNKNOWN');
  });

  it('SQLSTATE: 23514·22P02 → 설정 값, 40P01·40001 → 재시도, 57014 → 타임아웃, PGRST301 → 세션, PGRST202 → 미구성', () => {
    assert.equal(mapRpcError({ code: '23514', message: 'x' }).code, 'LB_CHECK_VIOLATION');
    assert.equal(mapRpcError({ code: '22P02', message: 'invalid input syntax' }).code, 'LB_CHECK_VIOLATION');
    assert.equal(mapRpcError({ code: '40P01', message: 'deadlock detected' }).code, 'LB_RETRYABLE');
    assert.equal(mapRpcError({ code: '40001', message: 'could not serialize' }).code, 'LB_RETRYABLE');
    assert.equal(mapRpcError({ code: '57014', message: 'canceling statement due to statement timeout' }).code, 'LB_TIMEOUT');
    assert.equal(mapRpcError({ code: 'PGRST301', message: 'JWT expired' }).code, 'LB_NOT_SIGNED_IN');
    // GoTrue refresh 토큰 무효 → 세션 무효(LB_UNKNOWN 이 아니다 — 컨텍스트가 userId 를 버려야 한다)
    assert.equal(mapRpcError({ name: 'AuthApiError', status: 400, code: 'refresh_token_already_used', message: 'Invalid Refresh Token: Already Used' }).code, 'LB_NOT_SIGNED_IN');
    assert.equal(mapRpcError({ name: 'AuthApiError', status: 400, code: 'refresh_token_not_found', message: 'Invalid Refresh Token: Refresh Token Not Found' }).code, 'LB_NOT_SIGNED_IN');
    assert.equal(mapRpcError({ name: 'AuthApiError', status: 400, message: 'Invalid Refresh Token: Already Used' }).code, 'LB_NOT_SIGNED_IN');
    assert.equal(mapRpcError({ status: 401, code: 'PGRST303', message: 'JWT expired' }).code, 'LB_NOT_SIGNED_IN');
    assert.equal(mapRpcError({ code: 'PGRST202', message: 'Could not find the function' }).code, 'LB_NOT_CONFIGURED');
  });

  it('네트워크: 중단 → 타임아웃, 전송 실패(status 0) → 오프라인, 429 → 레이트 리밋, 5xx → 서버 없음', () => {
    assert.equal(mapRpcError({ message: 'AbortError: Aborted', code: '' }).code, 'LB_TIMEOUT');
    assert.equal(mapRpcError({ message: 'x' }, { aborted: true }).code, 'LB_TIMEOUT');
    assert.equal(mapRpcError({ message: 'TypeError: Network request failed', code: '' }).code, 'LB_OFFLINE');
    assert.equal(mapRpcError({ name: 'AuthRetryableFetchError', message: 'x', status: 0 }).code, 'LB_OFFLINE');
    assert.equal(mapRpcError({ name: 'AuthApiError', message: 'Request rate limit reached', status: 429, code: 'over_request_rate_limit' }).code, 'LB_RATE_LIMITED');
    assert.equal(mapRpcError({ name: 'AuthApiError', message: 'Anonymous sign-ins are disabled', status: 422, code: 'anonymous_provider_disabled' }).code, 'LB_NOT_CONFIGURED');
    assert.equal(mapRpcError({ message: 'Bad gateway', status: 502, code: '' }).code, 'LB_NOT_CONFIGURED');
    assert.equal(mapRpcError(new TypeError('Network request failed')).code, 'LB_OFFLINE');
    const same = new LateBetError('LB_FULL');
    assert.equal(mapRpcError(same), same);
  });
});
