import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { presetPolicy } from '../domain/latePresets';
import type { LatePolicy } from '../domain/lateBet';
import { msToLocalAt } from '../domain/tzGuard';
import { LateBetError, type LateBetErrorCode } from './errors';
import { FAKE_DEMO_CODES, FakeServer, createFakeApi, offsetPoint } from './fakeApi';
import type { LbAppointment, LbCreateInput } from './types';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 25, 3, 0, 0); // 한국 시각 9월 25일 낮 12:00
const PLACE = { lat: 37.49808, lng: 127.02761 };
const FAR = offsetPoint(PLACE.lat, PLACE.lng, 1500, 1);
const TZ = 'Asia/Seoul';

/** 결정적 난수(LCG) */
function seeded(seed = 7): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function setup(options: { seedDemo?: boolean } = {}) {
  const clock = { t: T0 };
  const server = new FakeServer({ now: () => clock.t, random: seeded(), seedDemo: options.seedDemo });
  const user = (id: string, nickname: string) => {
    server.ensureProfile(id, nickname);
    return id;
  };
  const input = (meetInMin: number, policy: LatePolicy = presetPolicy('normal'), title = '금요일 곱창'): LbCreateInput => ({
    title,
    localAt: msToLocalAt(server.nowMs() + meetInMin * MIN, TZ),
    tz: TZ,
    placeName: '강남역 2번 출구 곱창',
    placeNote: '',
    lat: PLACE.lat,
    lng: PLACE.lng,
    policy,
    consent: true,
  });
  const balance = (id: string) => server.getMyProfile(id)?.balance ?? -1;
  const here = { lat: PLACE.lat, lng: PLACE.lng, accuracyM: 10 };
  return { clock, server, user, input, balance, here };
}

function code(a: LbAppointment): string {
  assert.ok(a.inviteCode);
  return a.inviteCode as string;
}

function throwsCode(fn: () => unknown, want: LateBetErrorCode) {
  assert.throws(fn, (e: unknown) => e instanceof LateBetError && e.code === want, `${want} 를 던져야 한다`);
}

describe('fakeApi: 프로필과 에스크로', () => {
  it('프로필을 처음 만들 때만 1,000P 를 주고, 다시 부르면 이름만 바뀐다', () => {
    const { server, balance } = setup();
    assert.equal(server.getMyProfile('a'), null);
    assert.equal(server.ensureProfile('a', '  민병희 ').nickname, '민병희');
    assert.equal(balance('a'), 1000);
    assert.equal(server.ensureProfile('a', '병희').balance, 1000);
    assert.equal(server.listLedger('a').filter((l) => l.kind === 'grant').length, 1);
    throwsCode(() => server.ensureProfile('b', '   '), 'LB_BAD_NICKNAME');
    throwsCode(() => server.ensureProfile('b', '열세글자를넘기는아주긴이름'), 'LB_BAD_NICKNAME');
    assert.deepEqual(server.audit(), []);
  });

  it('약속을 만들면 주최자도 같은 금액을 걸고, 잠금·마감 시각은 정책에서 나온다', () => {
    const { server, user, input, balance } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    assert.equal(balance('host'), 900);
    assert.equal(a.shareStartMs, a.meetAtMs - 60 * MIN);
    assert.equal(a.closeMs, a.meetAtMs + 45 * MIN); // 보통: 45분 넘게 늦으면 전액
    assert.equal(a.version, 1);
    assert.match(code(a), /^[2-9A-HJKMNP-Z]{8}$/);
    assert.deepEqual(server.audit(), []);
  });

  it('동의가 없거나 시각·정책이 틀리면 만들 수 없고 포인트도 그대로다', () => {
    const { server, user, input, balance } = setup();
    user('host', '지수');
    throwsCode(() => server.createAppointment('host', { ...input(180), consent: false }), 'LB_CONSENT_REQUIRED');
    throwsCode(() => server.createAppointment('host', input(3)), 'LB_TIME_IN_PAST');
    throwsCode(() => server.createAppointment('host', input(91 * 24 * 60)), 'LB_TIME_TOO_FAR');
    throwsCode(() => server.createAppointment('host', { ...input(180), tz: 'Mars/Base' }), 'LB_BAD_TZ');
    throwsCode(() => server.createAppointment('host', { ...input(180), lng: -73.98, lat: 40.75 }), 'LB_TZ_SUSPECT');
    throwsCode(
      () => server.createAppointment('host', input(180, { ...presetPolicy('normal'), stake: 301 })),
      'LB_CHECK_VIOLATION',
    );
    throwsCode(() => server.createAppointment('nobody', input(180)), 'LB_NO_PROFILE');
    assert.equal(balance('host'), 1000);
    // 시간대를 확인했다고 보내면 통과한다
    const ny = server.createAppointment('host', { ...input(180), lng: -73.98, lat: 40.75, tzConfirmed: true });
    assert.equal(ny.tz, TZ);
  });

  it('잠금 전 참여는 즉시 에스크로, 나가면 전액 환불되고 다시 들어올 수 있다', () => {
    const { server, user, input, balance } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    user('g', '현우');
    assert.deepEqual(server.join('g', code(a), '현우', a.version, true), { appointmentId: a.id, state: 'active' });
    assert.equal(balance('g'), 900);
    // 멱등: 다시 눌러도 한 번만 걸린다
    assert.equal(server.join('g', code(a), '현우', a.version, true).state, 'active');
    assert.equal(balance('g'), 900);
    server.leave('g', a.id);
    assert.equal(balance('g'), 1000);
    assert.equal(server.join('g', code(a), '현우', a.version, true).state, 'active');
    throwsCode(() => server.leave('host', a.id), 'LB_HOST_CANNOT_LEAVE');
    assert.deepEqual(server.audit(), []);
  });

  it('참여 검증: 동의·닉네임 중복(공백·대소문자 무시)·참여 마감·없는 코드', () => {
    const { server, user, input } = setup();
    const a = server.createAppointment(user('host', 'Min Hee'), input(180));
    user('g', '현우');
    throwsCode(() => server.join('g', code(a), '현우', a.version, false), 'LB_CONSENT_REQUIRED');
    throwsCode(() => server.join('g', code(a), 'minhee', a.version, true), 'LB_NICKNAME_TAKEN');
    throwsCode(() => server.join('g', 'ZZZZ9999', '현우', 1, true), 'LB_INVITE_NOT_FOUND');
    server.setJoinClosed('host', a.id, true);
    throwsCode(() => server.join('g', code(a), '현우', a.version, true), 'LB_JOIN_CLOSED');
    throwsCode(() => server.setJoinClosed('g', a.id, false), 'LB_NOT_HOST');
  });

  it('포인트가 모자라면 부족분만 채워 주고, 가진 것 전부가 1,000P 이상이면 거절한다', () => {
    const { server, user, input, balance, clock, here } = setup();
    user('w', '지수');
    user('l', '현우');
    // 매운맛(300P)에서 현우가 세 번 연속 오지 않는다 → 1000 → 700 → 400 → 100
    for (let i = 0; i < 3; i += 1) {
      const a = server.createAppointment('w', input(180, presetPolicy('spicy'), `약속 ${i}`));
      server.join('l', code(a), '현우', a.version, true);
      clock.t = a.meetAtMs - 5 * MIN;
      assert.equal(server.reportLocation('w', a.id, here).arrived, true);
      clock.t = a.closeMs + 16_000;
      assert.equal(server.getLive('w', a.id).appointment.status, 'settled');
    }
    assert.equal(balance('l'), 100);
    assert.equal(balance('w'), 1900);

    const b = server.createAppointment('w', input(180, presetPolicy('spicy'), '네 번째'));
    server.join('l', code(b), '현우', b.version, true);
    assert.equal(balance('l'), 0);
    const relief = server.listLedger('l').find((x) => x.kind === 'relief');
    assert.equal(relief?.amount, 200);
    assert.equal(relief?.reason, 'topup');
    assert.equal(relief?.reliefFor, b.id);
    assert.deepEqual(server.audit(), []);

    // 부자는 채워 주지 않는다: 300P 짜리 약속 3개에 걸어 둔 채(잔액 100 + 걸린 900 = 1000) 네 번째는 거절
    user('r', '태호');
    for (let i = 0; i < 3; i += 1) server.createAppointment('r', input(200 + i, presetPolicy('spicy'), `부자 ${i}`));
    assert.equal(balance('r'), 100);
    throwsCode(() => server.createAppointment('r', input(300, presetPolicy('spicy'), '부자 4')), 'LB_INSUFFICIENT_POINTS');
    assert.equal(server.listMyAppointments('r').length, 3); // 실패한 생성은 통째로 되돌려진다
    assert.deepEqual(server.audit(), []);
  });
});

describe('fakeApi: 조건 동결과 version', () => {
  it('혼자일 때는 조건을 바꿀 수 있고, 옛 스테이크 환불 → 새 스테이크 에스크로 → version+1', () => {
    const { server, user, input, balance } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    const next = input(240, presetPolicy('spicy'));
    const b = server.updateAppointment('host', a.id, next);
    assert.equal(b.version, 2);
    assert.equal(b.policy.stake, 300);
    assert.equal(balance('host'), 700);
    assert.equal(b.closeMs, b.meetAtMs + 29 * MIN);
    assert.deepEqual(
      server.listLedger('host').map((l) => [l.kind, l.amount, l.reason]).slice(0, 3),
      [['hold', -300, null], ['refund', 100, 'policy_change'], ['hold', -100, null]],
    );
    // 옛 미리보기를 보고 있던 친구가 누르면 LB_APPT_CHANGED
    user('g', '현우');
    throwsCode(() => server.join('g', code(a), '현우', 1, true), 'LB_APPT_CHANGED');
    assert.equal(server.join('g', code(a), '현우', server.peekInvite('g', code(a)).version, true).state, 'active');
    assert.deepEqual(server.audit(), []);
  });

  it('다른 사람이 생기면(승인 대기 요청만 있어도) 조건이 동결되고 제목·메모만 고칠 수 있다', () => {
    const { server, user, input, clock } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    server.join(user('g', '현우'), code(a), '현우', a.version, true);
    throwsCode(() => server.updateAppointment('host', a.id, input(240)), 'LB_EDIT_LOCKED');
    server.updateMemo('host', a.id, '금요일 곱창 (변경)', '2층이에요');
    const live = server.getLive('g', a.id);
    assert.equal(live.appointment.title, '금요일 곱창 (변경)');
    assert.equal(live.appointment.version, 1); // 메모는 version 을 올리지 않는다

    const solo = server.createAppointment('host', input(30, presetPolicy('normal'), '번개'));
    clock.t += MIN; // 만들자마자 잠겨 있다
    assert.equal(server.join(user('p', '태호'), code(solo), '태호', solo.version, true).state, 'pending');
    throwsCode(() => server.updateAppointment('host', solo.id, input(60)), 'LB_EDIT_LOCKED');
  });
});

describe('fakeApi: 잠금 후 참여는 주최자 수락제', () => {
  it('요청 동안에는 포인트가 안 걸리고 아무것도 안 보인다. 수락되는 순간 걸린다', () => {
    const { server, user, input, balance, clock } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    server.join(user('f', '서연'), code(a), '서연', a.version, true);
    clock.t = a.shareStartMs + MIN;
    server.reportLocation('f', a.id, { ...FAR, accuracyM: 10 });

    user('g', '현우');
    assert.equal(server.peekInvite('g', code(a)).needsApproval, true);
    assert.deepEqual(server.peekInvite('g', code(a)).nicknames, []);
    assert.equal(server.join('g', code(a), '현우', a.version, true).state, 'pending');
    assert.equal(balance('g'), 1000);

    const mine = server.getLive('g', a.id);
    assert.equal(mine.myState, 'pending');
    assert.equal(mine.appointment.inviteCode, null);
    assert.deepEqual(mine.participants.map((p) => p.userId), ['g']);
    assert.equal(mine.participants[0].location, null);
    assert.equal(server.reportLocation('g', a.id, { ...PLACE, accuracyM: 5 }).reason, 'pending');
    assert.equal(server.listMyAppointments('host')[0].pendingCount, 1);

    throwsCode(() => server.approve('f', a.id, 'g'), 'LB_NOT_HOST');
    server.approve('host', a.id, 'g');
    assert.equal(balance('g'), 900);
    const after = server.getLive('g', a.id);
    assert.equal(after.myState, 'active');
    assert.equal(after.participants.length, 3);
    assert.ok(after.participants.find((p) => p.userId === 'f')?.location);
    assert.deepEqual(server.audit(), []);
  });

  it('요청은 언제든 거둘 수 있고, 거절하며 차단하면 같은 계정은 초대를 못 찾는다', () => {
    const { server, user, input, balance, clock } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    clock.t = a.shareStartMs + MIN;
    user('g', '현우');
    server.join('g', code(a), '현우', a.version, true);
    server.leave('g', a.id);
    throwsCode(() => server.getLive('g', a.id), 'LB_NOT_MEMBER');

    server.join('g', code(a), '현우', a.version, true);
    server.kick('host', a.id, 'g'); // 기본 = 차단
    assert.equal(balance('g'), 1000);
    throwsCode(() => server.getLive('g', a.id), 'LB_NOT_MEMBER');
    throwsCode(() => server.peekInvite('g', code(a)), 'LB_INVITE_NOT_FOUND');
    throwsCode(() => server.join('g', code(a), '현우', a.version, true), 'LB_INVITE_NOT_FOUND');

    user('h', '태호');
    server.join('h', code(a), '태호', a.version, true);
    server.kick('host', a.id, 'h', false); // 차단 없이 거절 → 다시 요청 가능
    assert.equal(server.join('h', code(a), '태호', a.version, true).state, 'pending');
  });

  it('약속 시각이 지나면 수락도 참여도 닫힌다. 남은 요청은 정산 때 사라진다', () => {
    const { server, user, input, clock } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    clock.t = a.shareStartMs + MIN;
    server.join(user('g', '현우'), code(a), '현우', a.version, true);
    clock.t = a.meetAtMs;
    throwsCode(() => server.approve('host', a.id, 'g'), 'LB_JOIN_CLOSED');
    throwsCode(() => server.join(user('h', '태호'), code(a), '태호', a.version, true), 'LB_JOIN_CLOSED');
    clock.t = a.closeMs + 16_000;
    assert.equal(server.getLive('host', a.id).appointment.status, 'voided');
    throwsCode(() => server.getLive('g', a.id), 'LB_NOT_MEMBER');
    assert.deepEqual(server.audit(), []);
  });
});

describe('fakeApi: 잠금 뒤에는 판을 엎을 수 없다', () => {
  it('잠금 전에는 내보내기·취소가 되고 전원 환불된다', () => {
    const { server, user, input, balance } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    server.join(user('g', '현우'), code(a), '현우', a.version, true);
    server.join(user('h', '태호'), code(a), '태호', a.version, true);
    server.kick('host', a.id, 'h');
    assert.equal(balance('h'), 1000);
    assert.equal(server.listLedger('h')[0].reason, 'kicked');
    server.cancel('host', a.id);
    assert.equal(balance('host'), 1000);
    assert.equal(balance('g'), 1000);
    assert.equal(server.getLive('g', a.id).appointment.status, 'canceled');
    throwsCode(() => server.cancel('host', a.id), 'LB_CANCEL_CLOSED');
    assert.deepEqual(server.audit(), []);
  });

  it('잠금 후에는 나가기·내보내기·취소가 막힌다. 혼자인 주최자만 언제든 취소할 수 있다', () => {
    const { server, user, input, balance, clock } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    server.join(user('g', '현우'), code(a), '현우', a.version, true);
    const solo = server.createAppointment('host', input(200, presetPolicy('mild'), '혼자'));
    clock.t = a.shareStartMs;
    throwsCode(() => server.leave('g', a.id), 'LB_LEAVE_CLOSED');
    throwsCode(() => server.kick('host', a.id, 'g'), 'LB_KICK_CLOSED');
    throwsCode(() => server.cancel('host', a.id), 'LB_CANCEL_CLOSED');
    clock.t = solo.shareStartMs + MIN;
    server.cancel('host', solo.id);
    assert.equal(balance('host'), 900);
  });
});

describe('fakeApi: 체크인과 좌표 비공개 조건', () => {
  it('판정 순서: 개시 전 → 반경 밖 → 부정확 → 모의 위치 → 도착 → 이미 도착 → 마감', () => {
    const { server, user, input, clock, here } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    server.join(user('g', '현우'), code(a), '현우', a.version, true);
    assert.equal(server.reportLocation('host', a.id, here).reason, 'not_open');

    clock.t = a.shareStartMs;
    const out = server.reportLocation('host', a.id, { ...FAR, accuracyM: 10 });
    assert.equal(out.reason, 'outside');
    assert.ok((out.distanceM ?? 0) > 1400 && (out.distanceM ?? 0) < 1600);
    assert.equal(server.reportLocation('host', a.id, { ...PLACE, accuracyM: 180 }).reason, 'low_accuracy');
    assert.equal(server.reportLocation('host', a.id, { ...PLACE, accuracyM: -1 }).reason, 'low_accuracy');
    assert.equal(server.reportLocation('host', a.id, { lat: 95, lng: 0, accuracyM: 5 }).reason, 'bad_position');
    assert.equal(server.reportLocation('host', a.id, { ...here, mocked: true }).reason, 'mocked');
    assert.equal(server.hasLocationRow(a.id, 'host'), false); // 모의 위치는 있던 좌표도 지운다

    clock.t += 5 * MIN;
    const ok = server.reportLocation('host', a.id, { ...PLACE, accuracyM: null }); // 정확도 모름 = 엔진처럼 통과
    assert.deepEqual([ok.arrived, ok.reason, ok.arrivedAtMs], [true, null, clock.t]);
    clock.t += 5 * MIN;
    const again = server.reportLocation('host', a.id, { ...FAR, accuracyM: 10 });
    assert.deepEqual([again.arrived, again.reason, again.arrivedAtMs], [true, 'already_arrived', ok.arrivedAtMs]);

    clock.t = a.closeMs + 1;
    assert.equal(server.reportLocation('g', a.id, here).reason, 'closed');
    throwsCode(() => server.reportLocation('x', a.id, here), 'LB_NOT_MEMBER');
  });

  it('좌표는 공개 창 안·활성 멤버·미도착·3분 안일 때만 보이고, 10분 뒤 서버에서 지워진다', () => {
    const { server, user, input, clock } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    server.join(user('g', '현우'), code(a), '현우', a.version, true);
    const seenByHost = () => server.getLive('host', a.id).participants.find((p) => p.userId === 'g');

    clock.t = a.shareStartMs + MIN;
    server.reportLocation('g', a.id, { ...FAR, accuracyM: 10 });
    const t1 = clock.t;
    assert.equal(seenByHost()?.location?.updatedAtMs, t1);
    assert.ok((seenByHost()?.location?.distanceM ?? 0) > 1400);
    assert.equal(server.shareLog().length, 1); // 제공 사실 기록(좌표 없음)

    clock.t = t1 + 3 * MIN + 1;
    assert.equal(seenByHost()?.location, null);
    assert.equal(seenByHost()?.lastSeenMs, t1); // "N분 전까지 공유"
    clock.t = t1 + 10 * MIN + 1;
    assert.equal(seenByHost()?.lastSeenMs, null);
    assert.equal(server.hasLocationRow(a.id, 'g'), false);

    // 공유를 끈 채 [도착 확인] = 판정만, 좌표는 저장하지 않는다
    assert.equal(server.reportLocation('g', a.id, { ...FAR, accuracyM: 10, share: false }).reason, 'outside');
    assert.equal(server.hasLocationRow(a.id, 'g'), false);
    // 대략적 위치(1000m 초과)는 저장하지 않는다
    server.reportLocation('g', a.id, { ...FAR, accuracyM: 1500 });
    assert.equal(server.hasLocationRow(a.id, 'g'), false);
    // 화면을 떠나면 즉시 삭제
    server.reportLocation('g', a.id, { ...FAR, accuracyM: 10 });
    server.stopSharing('g', a.id);
    assert.equal(seenByHost()?.location, null);

    // 도착하면 즉시 삭제되고 다시는 안 보인다
    server.reportLocation('g', a.id, { ...FAR, accuracyM: 10 });
    assert.equal(server.reportLocation('g', a.id, { ...PLACE, accuracyM: 8 }).arrived, true);
    assert.equal(server.hasLocationRow(a.id, 'g'), false);
    assert.equal(seenByHost()?.location, null);
    assert.equal(seenByHost()?.arrivalAccuracyM, 8);
  });

  it('공개 창 밖에서는 남아 있는 좌표도 내려가지 않는다', () => {
    const { server, user, input, clock } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    server.join(user('g', '현우'), code(a), '현우', a.version, true);
    clock.t = a.closeMs - MIN;
    server.reportLocation('g', a.id, { ...FAR, accuracyM: 10 });
    clock.t = a.closeMs + 1000;
    const live = server.getLive('host', a.id);
    assert.equal(live.settlePending, true);
    assert.equal(live.appointment.status, 'open'); // 15초 여유 전에는 정산하지 않는다
    assert.equal(live.participants.find((p) => p.userId === 'g')?.location, null);
    assert.equal(live.participants.find((p) => p.userId === 'g')?.lastSeenMs, null);
  });

  it('보증 도착: GPS 로 도착한 사람만, 본인은 안 되고, 시각은 근처에 온 첫 서버 시각', () => {
    const { server, user, input, clock, here } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    server.join(user('g', '현우'), code(a), '현우', a.version, true);
    server.join(user('h', '태호'), code(a), '태호', a.version, true);
    clock.t = a.meetAtMs - 20 * MIN;
    const near = clock.t;
    assert.equal(server.reportLocation('g', a.id, { ...PLACE, accuracyM: 180 }).reason, 'low_accuracy');
    throwsCode(() => server.vouch('h', a.id, 'g'), 'LB_VOUCHER_NOT_ARRIVED');
    clock.t = a.meetAtMs - 10 * MIN;
    server.reportLocation('host', a.id, here);
    throwsCode(() => server.vouch('host', a.id, 'host'), 'LB_CANNOT_VOUCH_SELF');
    clock.t = a.meetAtMs + 10 * MIN; // 늦게 눌러 줘도
    server.vouch('host', a.id, 'g');
    const g = server.getLive('host', a.id).participants.find((p) => p.userId === 'g');
    assert.deepEqual([g?.arrivedAtMs, g?.arrivalMethod, g?.vouchedBy], [near, 'vouch', 'host']);
    // 보증으로 도착한 사람은 남을 보증할 수 없다(연쇄 금지)
    throwsCode(() => server.vouch('g', a.id, 'h'), 'LB_VOUCHER_NOT_ARRIVED');
    // 근처 기록이 없으면 누른 순간
    server.vouch('host', a.id, 'h');
    assert.equal(server.getLive('host', a.id).participants.find((p) => p.userId === 'h')?.arrivedAtMs, clock.t);
  });
});

describe('fakeApi: 정산', () => {
  it('제시간·지각·오지 않음 — 잃은 포인트를 제시간에 온 사람이 나눠 갖고 합계는 0', () => {
    const { server, user, input, balance, clock, here } = setup();
    const a = server.createAppointment(user('a', '지수'), input(180));
    for (const [id, name] of [['b', '민병희'], ['c', '현우'], ['d', '태호']] as const) {
      server.join(user(id, name), code(a), name, a.version, true);
    }
    clock.t = a.meetAtMs - 9 * MIN;
    server.reportLocation('a', a.id, here);
    clock.t = a.meetAtMs - 6 * MIN;
    server.reportLocation('b', a.id, here);
    clock.t = a.meetAtMs + 7 * MIN; // 2단위 지각 = −20P
    server.reportLocation('c', a.id, here);

    clock.t = a.closeMs + 10_000;
    const pending = server.getLive('a', a.id);
    assert.deepEqual([pending.settlePending, pending.appointment.status], [true, 'open']);

    clock.t = a.closeMs + 15_001;
    const live = server.getLive('d', a.id); // 누가 열든 정산된다
    assert.equal(live.appointment.status, 'settled');
    assert.equal(live.settlePending, false);
    const row = (id: string) => live.participants.find((p) => p.userId === id);
    assert.deepEqual([row('a')?.resultStatus, row('a')?.received], ['onTime', 60]);
    assert.deepEqual([row('c')?.resultStatus, row('c')?.forfeited], ['late', 20]);
    assert.deepEqual([row('d')?.resultStatus, row('d')?.forfeited], ['noShow', 100]);
    assert.deepEqual(['a', 'b', 'c', 'd'].map(balance), [1060, 1060, 980, 900]);
    assert.equal(live.myBalance, 900);
    assert.deepEqual(server.audit(), []);

    // 멱등: 다시 조회해도 원장이 늘지 않는다
    const before = server.listLedger('a').length;
    server.getLive('a', a.id);
    server.getLive('b', a.id);
    assert.equal(server.listLedger('a').length, before);
    assert.deepEqual(server.settleErrors(), []);
  });

  it('전원이 도착했고 약속 시각이 지났으면 마감을 기다리지 않고 정산한다', () => {
    const { server, user, input, clock, here } = setup();
    const a = server.createAppointment(user('a', '지수'), input(180));
    server.join(user('b', '현우'), code(a), '현우', a.version, true);
    clock.t = a.meetAtMs - 5 * MIN;
    server.reportLocation('a', a.id, here);
    server.reportLocation('b', a.id, here);
    assert.equal(server.getLive('a', a.id).appointment.status, 'open'); // 약속 시각 전에는 열어 둔다
    clock.t = a.meetAtMs;
    assert.equal(server.getLive('a', a.id).appointment.status, 'settled');
    assert.deepEqual(server.audit(), []);
  });

  it('제시간에 온 사람이 없으면 무효 — 전원 환불', () => {
    const { server, user, input, balance, clock, here } = setup();
    const a = server.createAppointment(user('a', '지수'), input(180));
    server.join(user('b', '현우'), code(a), '현우', a.version, true);
    clock.t = a.meetAtMs + 12 * MIN;
    server.reportLocation('a', a.id, here);
    clock.t = a.closeMs + 20_000;
    const live = server.getLive('b', a.id);
    assert.deepEqual([live.appointment.status, live.appointment.voidReason], ['voided', 'noWinner']);
    assert.deepEqual([balance('a'), balance('b')], [1000, 1000]);
    assert.deepEqual(server.audit(), []);
  });

  it('포인트를 안 건 약속(위치만)은 원장 없이 끝난다', () => {
    const { server, user, input, balance, clock } = setup();
    const a = server.createAppointment(user('a', '지수'), input(180, { ...presetPolicy('normal'), stake: 0 }));
    assert.equal(a.closeMs, a.meetAtMs + 60 * MIN);
    clock.t = a.closeMs + 20_000;
    assert.equal(server.getLive('a', a.id).appointment.status, 'settled');
    assert.equal(balance('a'), 1000);
    assert.equal(server.listLedger('a').length, 1);
  });
});

describe('fakeApi: 봇과 시간 빨리 감기', () => {
  it('봇은 진짜 참여 규칙을 탄다 — 잠금 전에는 바로 참여, 잠금 후에는 참여 요청', () => {
    const { server, user, input, clock } = setup();
    const a = server.createAppointment(user('me', '민병희'), input(180));
    const early = server.addBot(a.id, 'onTime');
    assert.equal(early.state, 'active');
    const forced = server.addBotRequest(a.id, 'late'); // 잠금 전이어도 요청을 만든다(개발 전용)
    assert.equal(forced.state, 'pending');
    clock.t = a.shareStartMs + MIN;
    assert.equal(server.addBot(a.id, 'noShow').state, 'pending');
    assert.equal(server.listMyAppointments('me')[0].pendingCount, 2);
    server.approve('me', a.id, forced.userId);
    assert.deepEqual(server.audit(), []);
  });

  it('빨리 감으면 봇이 걸어오고, 계획한 시각으로 도착이 찍히고, 끝까지 감으면 정산된다', () => {
    const { server, user, input, here } = setup();
    const a = server.createAppointment(user('me', '민병희'), input(180));
    const onTime = server.addBot(a.id, 'onTime');
    const late = server.addBot(a.id, 'late');
    const ghost = server.addBot(a.id, 'ghost');
    const under = server.addBot(a.id, 'needsVouch');
    server.addBot(a.id, 'noShow');

    server.advanceTo(a.meetAtMs - 30 * MIN);
    let live = server.getLive('me', a.id);
    const at = (id: string) => live.participants.find((p) => p.userId === id);
    assert.ok(at(onTime.userId)?.location, '걸어오는 봇은 위치가 보인다');
    assert.ok(at(ghost.userId)?.location);

    server.advanceTo(a.meetAtMs - MIN);
    live = server.getLive('me', a.id);
    assert.ok((at(onTime.userId)?.arrivedAtMs ?? Infinity) <= a.meetAtMs - 3 * MIN);
    assert.equal(at(ghost.userId)?.location, null, '앱을 닫은 봇은 3분 뒤 안 보인다');
    assert.equal(at(under.userId)?.arrivedAtMs, null);
    assert.equal(at(under.userId)?.location?.accuracyM, 180);

    assert.equal(server.reportLocation('me', a.id, here).arrived, true);
    server.vouch('me', a.id, under.userId);
    live = server.getLive('me', a.id);
    assert.ok((at(under.userId)?.arrivedAtMs ?? Infinity) < a.meetAtMs, '근처에 온 시각으로 인정된다');

    server.advanceTo(a.closeMs + 16_000);
    live = server.getLive('me', a.id);
    assert.equal(live.appointment.status, 'settled');
    assert.equal(at(late.userId)?.resultStatus, 'late');
    assert.equal(at(ghost.userId)?.resultStatus, 'noShow');
    assert.ok((at('me')?.received ?? 0) > 0);
    assert.deepEqual(server.audit(), []);
  });

  it('arriveBot 은 체크인 개시 전에는 not_open, 개시 뒤에는 봇 한 명을 도착시킨다', () => {
    const { server, user, input } = setup();
    const a = server.createAppointment(user('me', '민병희'), input(180));
    server.addBot(a.id, 'noShow');
    assert.equal(server.arriveBot(a.id)?.result.reason, 'not_open');
    server.advanceTo(a.shareStartMs + MIN);
    assert.equal(server.arriveBot(a.id)?.result.arrived, true);
    assert.equal(server.arriveBot(a.id), null);
  });

  it('데모 초대 코드: 잠긴 약속에 요청하면 봇 주최자가 잠시 뒤 수락한다', async () => {
    const { server, clock } = setup({ seedDemo: true });
    const api = createFakeApi(server, 'me');
    await api.ensureProfile('민병희');
    const open = await api.peekInvite(FAKE_DEMO_CODES.open);
    assert.deepEqual([open.needsApproval, open.memberCount, open.myState], [false, 3, null]);
    const locked = await api.peekInvite(FAKE_DEMO_CODES.locked);
    assert.equal(locked.needsApproval, true);
    assert.equal((await api.join(FAKE_DEMO_CODES.locked, '민병희', locked.version, true)).state, 'pending');
    clock.t += 9_000;
    const live = await api.getLive(locked.id);
    assert.equal(live.myState, 'active');
    assert.equal((await api.getMyProfile())?.balance, 900);

    await assert.rejects(api.join(FAKE_DEMO_CODES.joinClosed, '민병희', 1, true), { code: 'LB_JOIN_CLOSED' });
    assert.equal((await api.peekInvite(FAKE_DEMO_CODES.canceled)).status, 'canceled');
    await assert.rejects(api.peekInvite('nope'), { code: 'LB_INVITE_NOT_FOUND' });
    assert.deepEqual(server.audit(), []);
  });

  it('연결 끊김을 흉내 내면 LB_OFFLINE 으로 실패한다', async () => {
    const { server } = setup();
    let offline = true;
    const api = createFakeApi(server, 'me', { isOffline: () => offline });
    await assert.rejects(api.ping(), (e: unknown) => e instanceof LateBetError && e.code === 'LB_OFFLINE');
    offline = false;
    assert.equal((await api.ping()).serverNowMs, T0);
  });
});
