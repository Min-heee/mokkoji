import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { presetPolicy } from '../domain/latePresets';
import type { LatePolicy } from '../domain/lateBet';
import { msToLocalAt } from '../domain/tzGuard';
import { LateBetError, type LateBetErrorCode } from './errors';
import { FAKE_DEMO_CODES, FakeServer, createFakeApi, offsetPoint } from './fakeApi';
import { ledgerCaption, ledgerLoss } from './homeModel';
import type { LbCreateInput } from './types';

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
  const input = (
    meetInMin: number,
    invitees: string[] = ['현우', '태호'],
    policy: LatePolicy = presetPolicy('normal'),
    title = '금요일 곱창',
  ): LbCreateInput => ({
    title,
    localAt: msToLocalAt(server.nowMs() + meetInMin * MIN, TZ),
    tz: TZ,
    placeName: '강남역 2번 출구 곱창',
    placeNote: '',
    lat: PLACE.lat,
    lng: PLACE.lng,
    policy,
    invitees,
    consent: true,
  });
  const balance = (id: string) => server.getMyProfile(id)?.balance ?? -1;
  const here = { lat: PLACE.lat, lng: PLACE.lng, accuracyM: 10 };
  /** 명단의 이름을 골라 참여 */
  const claim = (id: string, apptId: string, name: string, version?: number) =>
    server.claimSlot(id, apptId, name, version ?? (server.appointmentInfo(apptId)?.version ?? 1), true);
  /** 주최자의 [시작하기] */
  const start = (apptId: string) => server.start(server.appointmentInfo(apptId)?.hostId ?? '', apptId);
  return { clock, server, user, input, balance, here, claim, start };
}

function throwsCode(fn: () => unknown, want: LateBetErrorCode) {
  assert.throws(fn, (e: unknown) => e instanceof LateBetError && e.code === want, `${want} 를 던져야 한다`);
}

describe('fakeApi: 프로필과 에스크로', () => {
  it('프로필을 처음 만들면 1,000P, 닉네임은 보이지 않는 문자·공백을 정리한다', () => {
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

  it('약속을 만들면 주최자도 같은 금액을 걸고, 마감 시각은 정책에서 나온다(마감 = 전액 + 30분 꼬리). 시작 전이다', () => {
    const { server, user, input, balance } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    assert.equal(balance('host'), 900);
    assert.equal(a.closeMs, a.meetAtMs + 75 * MIN); // 보통: 45분 넘게 늦으면 전액, 그 뒤 30분 더 열려 있다
    assert.equal(a.version, 1);
    assert.equal(a.startedAtMs, null);
    assert.equal(a.hostNickname, '지수');
    assert.deepEqual(a.invitees.map((i) => [i.name, i.claimedByUserId]), [['현우', null], ['태호', null]]);
    assert.match(a.inviteCode, /^[2-9A-HJKMNP-Z]{8}$/);
    assert.deepEqual(server.audit(), []);
  });

  it('생성 멱등 키: 같은 주최자·같은 requestId 재시도는 같은 약속(에스크로·명단 한 번). 키가 다르거나 없으면 새 약속', () => {
    const { server, user, input, balance } = setup();
    const host = user('host', '지수');
    const rid = '7d4b1c2e-0000-4000-8000-00000000abcd';
    const a = server.createAppointment(host, { ...input(180), requestId: rid });
    const b = server.createAppointment(host, { ...input(180), requestId: rid });
    assert.equal(b.id, a.id);
    assert.equal(b.inviteCode, a.inviteCode);
    assert.equal(balance('host'), 900);
    assert.equal(server.listMyAppointments('host').length, 1);
    // 재시도는 첫 요청이 통과한 검사를 다시 하지 않는다(SQL 과 같다)
    assert.equal(server.createAppointment(host, { ...input(180), consent: false, requestId: rid }).id, a.id);
    assert.notEqual(server.createAppointment(host, { ...input(180), requestId: 'other' }).id, a.id);
    assert.notEqual(server.createAppointment(host, input(180)).id, a.id);
    // 키는 주최자별
    const other = user('other', '현우');
    assert.notEqual(server.createAppointment(other, { ...input(180), requestId: rid }).id, a.id);
    assert.deepEqual(server.audit(), []);
  });

  it('명단은 주최자 이름·중복을 조용히 빼고, 빈 이름·13자 이름은 거절한다', () => {
    const { server, user, input } = setup();
    user('host', '지수');
    const a = server.createAppointment('host', input(180, ['현우', ' 현우 ', '지수', '태호']));
    assert.deepEqual(a.invitees.map((i) => i.name), ['현우', '태호']);
    throwsCode(() => server.createAppointment('host', input(180, ['열세글자를넘기는아주긴이름'])), 'LB_BAD_NICKNAME');
    throwsCode(() => server.createAppointment('host', input(180, Array.from({ length: 20 }, (_, i) => `친구${i}`))), 'LB_FULL');
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
      () => server.createAppointment('host', input(180, undefined, { ...presetPolicy('normal'), stake: 301 })),
      'LB_CHECK_VIOLATION',
    );
    throwsCode(() => server.createAppointment('nobody', input(180)), 'LB_NO_PROFILE');
    assert.equal(balance('host'), 1000);
    // 시간대를 확인했다고 보내면 통과한다
    const ny = server.createAppointment('host', { ...input(180), lng: -73.98, lat: 40.75, tzConfirmed: true });
    assert.equal(ny.tz, TZ);
  });

  it('포인트가 모자라면 부족분만 채워 주고, 가진 것 전부가 1,000P 이상이면 거절한다', () => {
    const { server, user, input, balance, clock, here, claim } = setup();
    user('w', '지수');
    user('l', '현우');
    // 매운맛(300P)에서 현우가 세 번 연속 오지 않는다 → 1000 → 700 → 400 → 100
    for (let i = 0; i < 3; i += 1) {
      const a = server.createAppointment('w', input(180, ['현우'], presetPolicy('spicy'), `약속 ${i}`));
      claim('l', a.id, '현우');
      clock.t = a.meetAtMs - 5 * MIN;
      server.start('w', a.id);
      assert.equal(server.reportLocation('w', a.id, here).arrived, true);
      clock.t = a.closeMs + 16_000;
      assert.equal(server.getLive('w', a.id).appointment.status, 'settled');
    }
    assert.equal(balance('l'), 100);
    assert.equal(balance('w'), 1900);

    const b = server.createAppointment('w', input(180, ['현우'], presetPolicy('spicy'), '네 번째'));
    claim('l', b.id, '현우');
    assert.equal(balance('l'), 0);
    const relief = server.listLedger('l').find((x) => x.kind === 'relief');
    assert.equal(relief?.amount, 200);
    assert.equal(relief?.reason, 'topup');
    assert.equal(relief?.reliefFor, b.id);
    assert.deepEqual(server.audit(), []);

    // 부자는 채워 주지 않는다: 300P 짜리 약속 3개에 걸어 둔 채(잔액 100 + 걸린 900 = 1000) 네 번째는 거절
    user('r', '태호');
    for (let i = 0; i < 3; i += 1) server.createAppointment('r', input(200 + i, [], presetPolicy('spicy'), `부자 ${i}`));
    assert.equal(balance('r'), 100);
    throwsCode(() => server.createAppointment('r', input(300, [], presetPolicy('spicy'), '부자 4')), 'LB_INSUFFICIENT_POINTS');
    assert.equal(server.listMyAppointments('r').length, 3); // 실패한 생성은 통째로 되돌려진다
    assert.deepEqual(server.audit(), []);
  });
});

describe('fakeApi: 초대 명단으로 참여(slot claim)', () => {
  it('명단의 내 이름을 고르면 즉시 에스크로, 나가면 전액 환불되고 이름이 다시 비어 다시 들어올 수 있다', () => {
    const { server, user, input, balance, claim } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    user('g', '현우');
    assert.deepEqual(claim('g', a.id, '현우'), { appointmentId: a.id, state: 'active', started: false });
    assert.equal(balance('g'), 900);
    // 멱등: 다시 눌러도 한 번만 걸린다
    assert.equal(claim('g', a.id, '현우').state, 'active');
    assert.equal(balance('g'), 900);
    assert.equal(server.getLive('g', a.id).participants.find((p) => p.userId === 'g')?.nickname, '현우');
    server.leave('g', a.id);
    assert.equal(balance('g'), 1000);
    assert.equal(server.peekInvite('g', a.inviteCode).invitees.find((i) => i.name === '현우')?.claimed, false);
    assert.equal(claim('g', a.id, '현우').state, 'active');
    throwsCode(() => server.leave('host', a.id), 'LB_HOST_CANNOT_LEAVE');
    assert.deepEqual(server.audit(), []);
  });

  it('명단에 없는 이름은 LB_NOT_INVITED, 남이 이미 고른 이름은 LB_SLOT_TAKEN (공백·대소문자 무시)', () => {
    const { server, user, input, balance, claim } = setup();
    const a = server.createAppointment(user('host', 'Min Hee'), input(180, ['현우', 'Tae Ho']));
    user('g', '아무개');
    throwsCode(() => claim('g', a.id, '철수'), 'LB_NOT_INVITED');
    throwsCode(() => claim('g', a.id, 'minhee'), 'LB_NOT_INVITED'); // 주최자 이름은 명단이 아니다
    assert.equal(claim('g', a.id, ' 현 우 ').state, 'active');
    user('h', '다른기기');
    throwsCode(() => claim('h', a.id, '현우'), 'LB_SLOT_TAKEN');
    assert.equal(balance('h'), 1000);
    assert.equal(claim('h', a.id, 'taeho').state, 'active');
    assert.equal(server.getLive('h', a.id).participants.find((p) => p.userId === 'h')?.nickname, 'Tae Ho');
    assert.deepEqual(server.audit(), []);
  });

  it('참여 검증: 동의·없는 약속·옛 version·약속 시각 지남', () => {
    const { server, user, input, clock } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    user('g', '현우');
    throwsCode(() => server.claimSlot('g', a.id, '현우', a.version, false), 'LB_CONSENT_REQUIRED');
    throwsCode(() => server.claimSlot('g', 'nope', '현우', 1, true), 'LB_INVITE_NOT_FOUND');
    throwsCode(() => server.claimSlot('g', a.id, '현우', a.version + 1, true), 'LB_APPT_CHANGED');
    clock.t = a.meetAtMs;
    throwsCode(() => server.claimSlot('g', a.id, '현우', a.version, true), 'LB_JOIN_CLOSED');
  });

  it('미리보기: 명단(누가 골랐는지·내 칸)·주최자 이름·시작 시각이 보인다', () => {
    const { server, user, input, claim, start } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    user('g', '현우');
    let p = server.peekInvite('g', a.inviteCode);
    assert.equal(p.hostNickname, '지수');
    assert.deepEqual([p.memberCount, p.myState, p.startedAtMs], [1, null, null]);
    assert.deepEqual(p.invitees, [
      { name: '현우', claimed: false, mine: false },
      { name: '태호', claimed: false, mine: false },
    ]);
    claim('g', a.id, '현우');
    p = server.peekInvite('g', a.inviteCode);
    assert.deepEqual([p.memberCount, p.myState], [2, 'active']);
    assert.deepEqual(p.invitees[0], { name: '현우', claimed: true, mine: true });
    start(a.id);
    assert.equal(server.peekInvite('g', a.inviteCode).startedAtMs, server.nowMs());
    throwsCode(() => server.peekInvite('g', 'ZZZZ9999'), 'LB_INVITE_NOT_FOUND');
  });
});

describe('fakeApi: 시작 = 주최자의 [시작하기]', () => {
  it('주최자만, 약속 시각 전이면 언제든(혼자여도) 시작할 수 있고 startedAtMs = 그 시각. 두 번은 안 된다', () => {
    const { server, user, input, clock, claim } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    throwsCode(() => server.start(user('g', '현우'), a.id), 'LB_NOT_HOST');
    claim('g', a.id, '현우');
    clock.t += 7 * MIN;
    const started = server.start('host', a.id);
    assert.equal(started.startedAtMs, clock.t);
    assert.equal(started.version, 1); // 시작은 조건 변경이 아니다
    assert.equal(server.getLive('g', a.id).appointment.startedAtMs, clock.t);
    throwsCode(() => server.start('host', a.id), 'LB_ALREADY_STARTED');

    // 혼자(명단이 비어 있어도) 시작할 수 있다
    const solo = server.createAppointment('host', input(200, [], presetPolicy('normal'), '혼자'));
    assert.equal(server.start('host', solo.id).startedAtMs, clock.t);
    assert.deepEqual(server.audit(), []);
  });

  it('약속 시각이 지나면 시작할 수 없다(LB_START_CLOSED) — 그 약속은 무효로 닫힌다', () => {
    const { server, user, input, clock } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    clock.t = a.meetAtMs;
    throwsCode(() => server.start('host', a.id), 'LB_START_CLOSED');
    const b = server.createAppointment('host', input(200, [], presetPolicy('normal'), '취소된 것'));
    server.cancel('host', b.id);
    throwsCode(() => server.start('host', b.id), 'LB_START_CLOSED');
  });

  it('시작 전에는 나가기(환불)·내보내기(환불)·명단 편집·취소(전원 환불)가 되고, 시작 뒤에는 전부 막힌다', () => {
    const { server, user, input, balance, claim, start } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    claim(user('g', '현우'), a.id, '현우');
    let b = server.editInvitees('host', a.id, { add: ['민지', '지수', '현우'], remove: ['태호'] });
    assert.deepEqual(b.invitees.map((i) => i.name), ['현우', '민지']);
    throwsCode(() => server.editInvitees('host', a.id, { remove: ['현우'] }), 'LB_INVITEE_JOINED');
    throwsCode(() => server.editInvitees('g', a.id, { add: ['서연'] }), 'LB_NOT_HOST');

    server.kick('host', a.id, 'g'); // 기본 = 차단, 명단에서도 빠진다
    assert.equal(balance('g'), 1000);
    assert.equal(server.listLedger('g')[0].reason, 'kicked');
    throwsCode(() => server.peekInvite('g', a.inviteCode), 'LB_INVITE_NOT_FOUND');
    b = server.appointmentInfo(a.id) as typeof b;
    assert.deepEqual(b.invitees.map((i) => i.name), ['민지']);

    claim(user('m', '민지'), a.id, '민지');
    server.leave('m', a.id);
    assert.equal(balance('m'), 1000);
    assert.equal(server.peekInvite('m', a.inviteCode).invitees.find((i) => i.name === '민지')?.claimed, false);
    claim('m', a.id, '민지');

    start(a.id);
    throwsCode(() => server.leave('m', a.id), 'LB_LEAVE_CLOSED');
    throwsCode(() => server.kick('host', a.id, 'm'), 'LB_KICK_CLOSED');
    throwsCode(() => server.editInvitees('host', a.id, { add: ['서연'] }), 'LB_EDIT_FROZEN');
    throwsCode(() => server.editInvitees('host', a.id, { remove: ['서연'] }), 'LB_EDIT_FROZEN');
    throwsCode(() => server.cancel('host', a.id), 'LB_CANCEL_CLOSED');
    assert.deepEqual(server.audit(), []);

    const c = server.createAppointment('host', input(200, ['현우', '태호'], presetPolicy('normal'), '취소용'));
    claim(user('h', '현우2'), c.id, '현우');
    server.cancel('host', c.id);
    assert.equal(server.getLive('h', c.id).appointment.status, 'canceled');
    assert.equal(balance('h'), 1000);
    throwsCode(() => server.cancel('host', c.id), 'LB_CANCEL_CLOSED');

    // 시작했어도 혼자면 취소할 수 있다
    const d = server.createAppointment('host', input(200, [], presetPolicy('normal'), '혼자 시작'));
    start(d.id);
    server.cancel('host', d.id);
    assert.equal(server.appointmentInfo(d.id)?.status, 'canceled');
    assert.deepEqual(server.audit(), []);
  });

  it('아직 수락 안 한 이름은 시작 뒤에도 약속 시각까지 들어올 수 있다(started = true) — 그때부터 위치가 보이고 판정 대상', () => {
    const { server, user, input, clock, claim, start } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180, ['현우', '태호']));
    claim(user('g', '현우'), a.id, '현우');
    clock.t = a.meetAtMs - 40 * MIN;
    start(a.id);
    clock.t = a.meetAtMs - 20 * MIN;
    const late = claim(user('h', '태호'), a.id, '태호');
    assert.deepEqual(late, { appointmentId: a.id, state: 'active', started: true });
    assert.equal(claim('h', a.id, '태호').started, true); // 멱등
    server.reportLocation('h', a.id, { ...FAR, accuracyM: 10 });
    const seen = server.getLive('host', a.id).participants.find((p) => p.userId === 'h');
    assert.ok(seen?.location, '들어온 순간부터 위치가 보인다');
    clock.t = a.meetAtMs;
    throwsCode(() => claim(user('x', '누군가'), a.id, '태호'), 'LB_JOIN_CLOSED');
    assert.deepEqual(server.audit(), []);
  });

  it('약속 시각까지 수락 안 한 이름은 자동 삭제된다(환불 없음). 시작한 약속은 그대로 진행된다', () => {
    const { server, user, input, clock, claim, start } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180, ['현우', '태호', '철수']));
    claim(user('g', '현우'), a.id, '현우');
    start(a.id);
    clock.t = a.meetAtMs - MIN;
    assert.equal(server.getLive('host', a.id).appointment.invitees.length, 3);
    clock.t = a.meetAtMs + 30_000;
    const live = server.getLive('host', a.id);
    assert.equal(live.appointment.status, 'open');
    assert.deepEqual(live.appointment.invitees.map((i) => i.name), ['현우']);
    assert.equal(server.listMyAppointments('host')[0].unclaimedCount, 0);
    assert.equal(server.listLedger('host').length, 2); // grant + hold — 환불 원장 없음
    assert.deepEqual(server.audit(), []);
  });

  it('약속 시각까지 시작하지 않은 약속은 무효(notStarted)로 닫히고 전원 환불된다', () => {
    const { server, user, input, balance, clock, claim } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180, ['현우', '태호']));
    claim(user('g', '현우'), a.id, '현우');
    assert.deepEqual([balance('host'), balance('g')], [900, 900]);
    clock.t = a.meetAtMs;
    const live = server.getLive('g', a.id);
    assert.deepEqual([live.appointment.status, live.appointment.voidReason], ['voided', 'notStarted']);
    assert.deepEqual(live.appointment.invitees.map((i) => i.name), ['현우']);
    assert.equal(live.participants.find((p) => p.userId === 'g')?.resultStatus, 'noShow');
    assert.deepEqual([balance('host'), balance('g')], [1000, 1000]);
    assert.deepEqual(server.listLedger('g')[0], { ...server.listLedger('g')[0], kind: 'refund', amount: 100, reason: 'notStarted' });
    assert.equal(server.listMyAppointments('host')[0].status, 'voided');
    throwsCode(() => server.start('host', a.id), 'LB_START_CLOSED');
    assert.deepEqual(server.audit(), []);

    // 포인트를 안 건 약속은 원장 없이 settled 로 닫힌다(voidReason 은 notStarted 로 남긴다)
    const b = server.createAppointment('host', input(200, [], { ...presetPolicy('normal'), stake: 0 }, '위치만'));
    clock.t = b.meetAtMs + 1;
    const l2 = server.getLive('host', b.id);
    assert.deepEqual([l2.appointment.status, l2.appointment.voidReason], ['settled', 'notStarted']);
    assert.equal(server.listLedger('host').filter((l) => l.appointmentId === b.id).length, 0);
    assert.deepEqual(server.settleErrors(), []);
  });

  it('시작 없이 약속 시각이 지나면 수정·명단 편집은 LB_EDIT_CLOSED, 위치 보고는 무효 처리 뒤 closed 다(SQL 과 같다)', () => {
    const { server, user, input, clock, claim, here } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180, ['현우', '태호']));
    claim(user('g', '현우'), a.id, '현우');
    clock.t = a.meetAtMs;
    // 정산이 아직 안 돌았어도(getLive 호출 전) 수정은 막힌다
    throwsCode(() => server.edit('host', a.id, { placeName: '다른 곳' }, a.version), 'LB_EDIT_CLOSED');
    throwsCode(() => server.editInvitees('host', a.id, { add: ['민수'] }), 'LB_EDIT_CLOSED');
    // 위치 보고는 게으른 무효를 먼저 하고 closed 를 돌려준다(not_open 이 아니다)
    const r = server.reportLocation('g', a.id, here);
    assert.deepEqual([r.arrived, r.reason], [false, 'closed']);
    const live = server.getLive('g', a.id);
    assert.deepEqual([live.appointment.status, live.appointment.voidReason, live.settlePending], ['voided', 'notStarted', false]);
    assert.deepEqual(server.audit(), []);
  });
});

describe('fakeApi: 시작 전 조건 변경(차액 에스크로)과 시작 후 동결', () => {
  it('시작 전에는 친구가 들어온 뒤에도 전부 바꿀 수 있다: 스테이크가 오르면 전원 차액 hold, 내리면 차액 refund, version+1, changes 기록', () => {
    const { server, user, input, balance, claim } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    claim(user('g', '현우'), a.id, '현우');
    const up = server.edit('host', a.id, { policy: presetPolicy('spicy') }, a.version);
    assert.equal(up.version, 2);
    assert.equal(up.policy.stake, 300);
    assert.deepEqual([balance('host'), balance('g')], [700, 700]);
    assert.equal(up.closeMs, up.meetAtMs + 59 * MIN); // 매운맛 29분 + 30분 꼬리
    assert.deepEqual(server.listLedger('g').map((l) => [l.kind, l.amount, l.reason]).slice(0, 2), [
      ['hold', -200, 'policy_change'],
      ['hold', -100, null],
    ]);
    assert.equal(up.changes.length, 1);
    assert.deepEqual([up.changes[0].version, up.changes[0].before.policy.stake, up.changes[0].after.policy.stake], [2, 100, 300]);

    const next = input(240);
    const down = server.edit('host', a.id, { localAt: next.localAt, policy: { ...presetPolicy('spicy'), stake: 50 } }, up.version);
    assert.equal(down.version, 3);
    assert.deepEqual([balance('host'), balance('g')], [950, 950]);
    assert.equal(server.listLedger('g')[0].reason, 'policy_change');
    assert.equal(down.meetAtMs, a.meetAtMs + 60 * MIN);
    assert.equal(down.changes.length, 2);
    assert.equal(down.changes[1].before.meetAtMs, a.meetAtMs);

    // 옛 version 으로는 못 바꾸고 못 들어온다
    throwsCode(() => server.edit('host', a.id, { placeName: '딴 데' }, 1), 'LB_APPT_CHANGED');
    throwsCode(() => server.claimSlot(user('h', '태호'), a.id, '태호', 1, true), 'LB_APPT_CHANGED');
    assert.equal(server.claimSlot('h', a.id, '태호', down.version, true).state, 'active');
    assert.deepEqual(server.audit(), []);
  });

  it('바뀐 게 없으면 version 을 올리지 않고, 제목·메모(updateMemo)도 version 을 올리지 않는다', () => {
    const { server, user, input } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    assert.equal(server.edit('host', a.id, { placeName: a.placeName, policy: a.policy }, a.version).version, 1);
    server.updateMemo('host', a.id, '금요일 곱창 (변경)', '2층이에요');
    const live = server.getLive('host', a.id);
    assert.equal(live.appointment.title, '금요일 곱창 (변경)');
    assert.equal(live.appointment.version, 1);
    throwsCode(() => server.edit('host', a.id, { lat: 1 }, a.version), 'LB_BAD_POSITION');
  });

  it('스테이크를 올릴 때 채워 줄 수도 없는 친구가 있으면 통째로 실패한다(LB_INSUFFICIENT_POINTS, detail = 닉네임)', () => {
    const { server, user, input, balance, claim } = setup();
    user('rich', '부자');
    for (let i = 0; i < 3; i += 1) server.createAppointment('rich', input(200 + i, [], presetPolicy('spicy'), `부자 ${i}`));
    const a = server.createAppointment(user('host', '지수'), input(180, ['부자', '태호']));
    claim('rich', a.id, '부자'); // 잔액 100 → 0, 걸린 1000
    assert.equal(balance('rich'), 0);
    assert.throws(
      () => server.edit('host', a.id, { policy: presetPolicy('spicy') }, a.version),
      (e: unknown) => e instanceof LateBetError && e.code === 'LB_INSUFFICIENT_POINTS' && e.detail === '부자',
    );
    assert.equal(server.appointmentInfo(a.id)?.version, 1);
    assert.equal(balance('host'), 900);
    assert.deepEqual(server.audit(), []);
  });

  it('시작 후에는 시간을 뒤로 미루기(최대 +3시간)와 장소만 바꿀 수 있고, 미루면 마감이 새 시각 기준이다(시작 시각은 그대로)', () => {
    const { server, user, input, clock, claim, here, start } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180, ['현우']));
    claim(user('g', '현우'), a.id, '현우');
    clock.t = a.meetAtMs - 50 * MIN;
    const startedAt = clock.t;
    start(a.id);
    const v = server.appointmentInfo(a.id)?.version ?? 0;
    throwsCode(() => server.edit('host', a.id, { policy: presetPolicy('spicy') }, v), 'LB_EDIT_FROZEN');
    throwsCode(() => server.edit('host', a.id, { policy: { ...a.policy, radiusM: 200 } }, v), 'LB_EDIT_FROZEN');
    throwsCode(() => server.edit('host', a.id, { localAt: msToLocalAt(a.meetAtMs - 10 * MIN, TZ) }, v), 'LB_POSTPONE_ONLY');
    throwsCode(() => server.edit('host', a.id, { localAt: msToLocalAt(a.meetAtMs + 181 * MIN, TZ) }, v), 'LB_POSTPONE_TOO_FAR');

    // 이미 도착한 사람의 도착은 유지된다
    clock.t = startedAt + MIN;
    assert.equal(server.reportLocation('host', a.id, here).arrived, true);
    const moved = server.edit('host', a.id, { localAt: msToLocalAt(a.meetAtMs + 30 * MIN, TZ), placeName: '강남역 3번 출구' }, v);
    assert.equal(moved.version, v + 1);
    assert.equal(moved.meetAtMs, a.meetAtMs + 30 * MIN);
    assert.equal(moved.closeMs, moved.meetAtMs + 75 * MIN);
    assert.equal(moved.placeName, '강남역 3번 출구');
    assert.equal(moved.startedAtMs, startedAt);
    assert.notEqual(server.getLive('host', a.id).participants.find((p) => p.userId === 'host')?.arrivedAtMs, null);

    // 정산이 시작된 뒤(마감 지남)에는 아무것도 못 바꾼다
    clock.t = moved.closeMs + 1;
    throwsCode(() => server.edit('host', a.id, { placeName: '또 딴 데' }, moved.version), 'LB_EDIT_CLOSED');
    assert.deepEqual(server.audit(), []);
  });
});

describe('fakeApi: 체크인과 좌표 비공개 조건', () => {
  it('판정 순서: 시작 전 → 반경 밖 → 부정확 → 모의 위치 → 도착 → 이미 도착 → 마감 (체크인은 주최자가 시작해야 열린다)', () => {
    const { server, user, input, clock, here, claim, start } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    claim(user('g', '현우'), a.id, '현우');
    assert.equal(server.reportLocation('host', a.id, here).reason, 'not_open');
    clock.t = a.meetAtMs - 5 * MIN; // 약속 시각이 코앞이어도 시작 전이면 안 열린다
    assert.equal(server.reportLocation('host', a.id, here).reason, 'not_open');

    start(a.id);
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

  it('남의 좌표는 시작됨 ∧ 마감 전 ∧ 미도착 ∧ 3분 안일 때만 보이고, 10분 뒤 서버에서 지워진다', () => {
    const { server, user, input, clock, claim, start } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180, ['현우']));
    claim(user('g', '현우'), a.id, '현우');
    const seenByHost = () => server.getLive('host', a.id).participants.find((p) => p.userId === 'g');
    clock.t = a.meetAtMs - 60 * MIN;
    start(a.id);

    clock.t += MIN;
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

  it('시작 전에는 좌표를 보고할 수도 없고(not_open) 남의 좌표도 안 보인다. 주최자가 [시작하기]를 누르는 순간부터 보인다', () => {
    const { server, user, input, clock, claim, start } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180, ['현우', '태호']));
    claim(user('g', '현우'), a.id, '현우');
    clock.t = a.meetAtMs - 30 * MIN;
    assert.equal(server.reportLocation('g', a.id, { ...FAR, accuracyM: 10 }).reason, 'not_open');
    const seenByHost = () => server.getLive('host', a.id).participants.find((p) => p.userId === 'g');
    assert.equal(seenByHost()?.location, null);
    assert.equal(seenByHost()?.lastSeenMs, null);
    assert.equal(server.shareLog().length, 0);

    clock.t += MIN;
    start(a.id);
    server.reportLocation('g', a.id, { ...FAR, accuracyM: 10 });
    assert.equal(seenByHost()?.location?.updatedAtMs, clock.t);
    assert.equal(server.shareLog().length, 1);
    assert.ok(server.getLive('g', a.id).participants.find((p) => p.userId === 'host'), '전원이 전 행을 본다');
  });

  it('마감 뒤에는 시작한 약속이어도 남아 있는 좌표가 내려가지 않는다', () => {
    const { server, user, input, clock, claim, start } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180, ['현우']));
    claim(user('g', '현우'), a.id, '현우');
    start(a.id);
    clock.t = a.closeMs - MIN;
    server.reportLocation('g', a.id, { ...FAR, accuracyM: 10 });
    clock.t = a.closeMs + 1000;
    const live = server.getLive('host', a.id);
    assert.equal(live.settlePending, true);
    assert.equal(live.appointment.status, 'open'); // 15초 여유 전에는 정산하지 않는다
    assert.equal(live.participants.find((p) => p.userId === 'g')?.location, null);
    assert.equal(live.participants.find((p) => p.userId === 'g')?.lastSeenMs, null);
  });

  it('전액 몰수 뒤 30분 꼬리 안에 온 사람은 도착(지각·전액)으로 남고, 위치도 그때까지 보인다', () => {
    const { server, user, input, clock, claim, here, start } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180, ['현우']));
    claim(user('g', '현우'), a.id, '현우');
    clock.t = a.meetAtMs - 5 * MIN;
    start(a.id);
    server.reportLocation('host', a.id, here);
    clock.t = a.meetAtMs + 50 * MIN; // 전액(45분) 뒤, 마감(75분) 전
    server.reportLocation('g', a.id, { ...FAR, accuracyM: 10 });
    assert.ok(server.getLive('host', a.id).participants.find((p) => p.userId === 'g')?.location);
    clock.t = a.meetAtMs + 70 * MIN;
    assert.equal(server.reportLocation('g', a.id, here).arrived, true);
    clock.t = a.closeMs + 16_000;
    const g = server.getLive('host', a.id).participants.find((p) => p.userId === 'g');
    assert.deepEqual([g?.resultStatus, g?.forfeited], ['late', 100]);
    assert.deepEqual(server.audit(), []);
  });

  it('보증 도착: 시작 뒤에만, GPS 로 도착한 사람만, 본인은 안 되고, 시각은 근처에 온 첫 서버 시각', () => {
    const { server, user, input, clock, here, claim, start } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    claim(user('g', '현우'), a.id, '현우');
    claim(user('h', '태호'), a.id, '태호');
    throwsCode(() => server.vouch('host', a.id, 'g'), 'LB_NOT_STARTED');
    clock.t = a.meetAtMs - 20 * MIN;
    start(a.id);
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
    const { server, user, input, balance, clock, here, claim } = setup();
    const a = server.createAppointment(user('a', '지수'), input(180, ['민병희', '현우', '태호']));
    for (const [id, name] of [['b', '민병희'], ['c', '현우'], ['d', '태호']] as const) claim(user(id, name), a.id, name);
    clock.t = a.meetAtMs - 9 * MIN;
    server.start('a', a.id);
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

  it('시작 전 걸 포인트를 올렸다 내린 약속의 payout 은 포인트 화면 설명이 실제 걸려 있던 포인트·손실과 맞는다(원장 두 줄 이상)', () => {
    const { server, user, input, clock, here, claim } = setup();
    // 100P 로 만들고 게스트 참여 → 300P 로 인상(차액 hold) → 시작 → 게스트 7분 지각
    const a = server.createAppointment(user('a', '지수'), input(180, ['민병희']));
    claim(user('b', '민병희'), a.id, '민병희');
    const up = server.edit('a', a.id, { policy: { ...a.policy, stake: 300 } }, a.version);
    assert.equal(up.policy.stake, 300);
    clock.t = a.meetAtMs - 9 * MIN;
    server.start('a', a.id);
    server.reportLocation('a', a.id, here);
    clock.t = a.meetAtMs + 7 * MIN;
    server.reportLocation('b', a.id, here);
    clock.t = a.closeMs + 15_001;
    const live = server.getLive('a', a.id);
    assert.equal(live.appointment.status, 'settled');
    const forfeited = live.participants.find((p) => p.userId === 'b')?.forfeited ?? -1;
    assert.ok(forfeited > 0);
    const ledgerB = server.listLedger('b');
    const payoutB = ledgerB.find((e) => e.kind === 'payout');
    assert.ok(payoutB);
    assert.equal(ledgerB.filter((e) => e.kind === 'hold' && e.appointmentId === a.id).length, 2);
    assert.equal(ledgerCaption(payoutB, ledgerB), `건 300P 중 ${forfeited}P를 잃었어요`);
    assert.equal(ledgerLoss(payoutB, ledgerB), forfeited);
    const ledgerA = server.listLedger('a');
    const payoutA = ledgerA.find((e) => e.kind === 'payout');
    assert.ok(payoutA);
    assert.equal(ledgerCaption(payoutA, ledgerA), `건 300P에 ${forfeited}P를 더 받았어요`);
    assert.equal(ledgerLoss(payoutA, ledgerA), 0);

    // 200P 로 만들고 → 100P 로 인하(refund policy_change) → 둘 다 제시간
    const s2 = setup();
    const b2 = s2.server.createAppointment(s2.user('h', '지수'), s2.input(180, ['현우'], { ...presetPolicy('normal'), stake: 200 }));
    s2.claim(s2.user('g', '현우'), b2.id, '현우');
    s2.server.edit('h', b2.id, { policy: { ...b2.policy, stake: 100 } }, b2.version);
    s2.clock.t = b2.meetAtMs - 5 * MIN;
    s2.server.start('h', b2.id);
    s2.server.reportLocation('h', b2.id, s2.here);
    s2.server.reportLocation('g', b2.id, s2.here);
    s2.clock.t = b2.meetAtMs;
    assert.equal(s2.server.getLive('h', b2.id).appointment.status, 'settled');
    const ledgerG = s2.server.listLedger('g');
    const payoutG = ledgerG.find((e) => e.kind === 'payout');
    assert.ok(payoutG);
    assert.equal(payoutG.amount, 100);
    assert.equal(ledgerCaption(payoutG, ledgerG), '건 100P를 그대로 돌려받았어요');
    assert.equal(ledgerLoss(payoutG, ledgerG), 0);
  });

  it('전원이 도착했고 약속 시각이 지났으면 마감을 기다리지 않고 정산한다', () => {
    const { server, user, input, clock, here, claim } = setup();
    const a = server.createAppointment(user('a', '지수'), input(180, ['현우']));
    claim(user('b', '현우'), a.id, '현우');
    clock.t = a.meetAtMs - 5 * MIN;
    server.start('a', a.id);
    server.reportLocation('a', a.id, here);
    server.reportLocation('b', a.id, here);
    assert.equal(server.getLive('a', a.id).appointment.status, 'open'); // 약속 시각 전에는 열어 둔다
    clock.t = a.meetAtMs;
    assert.equal(server.getLive('a', a.id).appointment.status, 'settled');
    assert.deepEqual(server.audit(), []);
  });

  it('제시간에 온 사람이 없으면 무효 — 전원 환불', () => {
    const { server, user, input, balance, clock, here, claim } = setup();
    const a = server.createAppointment(user('a', '지수'), input(180, ['현우']));
    claim(user('b', '현우'), a.id, '현우');
    clock.t = a.meetAtMs - MIN;
    server.start('a', a.id);
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
    const a = server.createAppointment(user('a', '지수'), input(180, [], { ...presetPolicy('normal'), stake: 0 }));
    assert.equal(a.closeMs, a.meetAtMs + 60 * MIN);
    server.start('a', a.id);
    clock.t = a.closeMs + 20_000;
    assert.equal(server.getLive('a', a.id).appointment.status, 'settled');
    assert.equal(balance('a'), 1000);
    assert.equal(server.listLedger('a').length, 1);
  });
});

describe('fakeApi: 봇과 시간 빨리 감기', () => {
  it('봇은 명단의 빈 이름을 차례로 고른다. 빈 이름이 없으면 시작 전에는 이름을 추가해 들어오고, 시작 뒤에는 명단이 동결이라 못 들어온다', () => {
    const { server, user, input, start } = setup();
    const a = server.createAppointment(user('me', '민병희'), input(180, ['현우', '태호']));
    const first = server.addBot(a.id, 'onTime');
    assert.deepEqual([first.nickname, first.state, first.started], ['현우', 'active', false]);
    const second = server.addBot(a.id, 'late');
    assert.deepEqual([second.nickname, second.started], ['태호', false]);
    const extra = server.addBot(a.id, 'noShow'); // 빈 이름 없음 → 주최자가 이름을 추가해 들어온다
    assert.equal(extra.state, 'active');
    assert.equal(server.appointmentInfo(a.id)?.invitees.length, 3);

    start(a.id);
    throwsCode(() => server.addBot(a.id, 'onTime'), 'LB_EDIT_FROZEN');
    assert.deepEqual(server.audit(), []);
  });

  it('시작 후 봇 수락: 시작 뒤에 들어온 봇은 started = true 이고 그 순간부터 위치가 보인다. postpone 은 주최자 미루기(edit)를 그대로 탄다', () => {
    const { server, user, input, start } = setup();
    const a = server.createAppointment(user('me', '민병희'), input(180, ['현우', '태호', '민지']));
    server.addBot(a.id, 'onTime');
    server.advanceTo(a.meetAtMs - 60 * MIN);
    start(a.id);
    const late = server.addBot(a.id, 'onTime');
    assert.deepEqual([late.nickname, late.started], ['태호', true]);
    server.advance(MIN);
    const seen = server.getLive('me', a.id).participants.find((p) => p.userId === late.userId);
    assert.ok(seen?.location, '시작 뒤에 들어온 봇은 바로 위치가 보인다');

    const moved = server.postpone(a.id, 30);
    assert.equal(moved.meetAtMs, a.meetAtMs + 30 * MIN);
    assert.equal(moved.version, 2);
    throwsCode(() => server.postpone(a.id, 200), 'LB_POSTPONE_TOO_FAR');
    // 미뤄진 약속 시각까지 '민지'는 계속 들어올 수 있다
    server.advanceTo(a.meetAtMs + 10 * MIN);
    assert.equal(server.addBot(a.id, 'onTime').nickname, '민지');
    assert.deepEqual(server.audit(), []);
  });

  it('시작 전에는 봇이 움직이지 않고, 시작한 뒤 빨리 감으면 걸어오고, 계획한 시각으로 도착이 찍히고, 끝까지 감으면 정산된다', () => {
    const { server, user, input, here, start } = setup();
    const a = server.createAppointment(user('me', '민병희'), input(180, ['현우', '태호', '민지', '서연', '도윤']));
    const onTime = server.addBot(a.id, 'onTime');
    const late = server.addBot(a.id, 'late');
    const ghost = server.addBot(a.id, 'ghost');
    const under = server.addBot(a.id, 'needsVouch');
    server.addBot(a.id, 'noShow');

    server.advanceTo(a.meetAtMs - 30 * MIN);
    let live = server.getLive('me', a.id);
    const at = (id: string) => live.participants.find((p) => p.userId === id);
    assert.equal(at(onTime.userId)?.location, null, '시작 전에는 봇도 위치를 보내지 않는다');
    assert.equal(server.hasLocationRow(a.id, onTime.userId), false);

    start(a.id);
    live = server.getLive('me', a.id);
    assert.ok(at(onTime.userId)?.location, '시작하는 순간부터 걸어오는 봇의 위치가 보인다');
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

  it('약속 시각을 5분 앞두고 시작해도 제시간 봇은 시작 시각 이후에 도착이 찍힌다(시작 전으로 소급하지 않는다)', () => {
    const { server, user, input, start } = setup();
    const a = server.createAppointment(user('me', '민병희'), input(180, ['현우']));
    const bot = server.addBot(a.id, 'onTime');
    server.advanceTo(a.meetAtMs - 2 * MIN);
    start(a.id);
    const startedAt = server.nowMs();
    server.advanceTo(a.meetAtMs);
    const p = server.getLive('me', a.id).participants.find((x) => x.userId === bot.userId);
    assert.ok((p?.arrivedAtMs ?? 0) >= startedAt);
  });

  it('arriveBot 은 시작 전에는 not_open, 시작 뒤에는 봇 한 명을 도착시킨다', () => {
    const { server, user, input, start } = setup();
    const a = server.createAppointment(user('me', '민병희'), input(180, []));
    server.addBot(a.id, 'noShow');
    assert.equal(server.arriveBot(a.id)?.result.reason, 'not_open');
    start(a.id);
    server.advance(MIN);
    assert.equal(server.arriveBot(a.id)?.result.arrived, true);
    assert.equal(server.arriveBot(a.id), null);
  });

  it('데모 초대 코드: 빈 이름을 고르면 대기실, 빈 이름이 없으면 못 고르고, 이미 시작한 약속은 고르는 순간 위치가 뜬다', async () => {
    const { server } = setup({ seedDemo: true });
    const api = createFakeApi(server, 'me');
    await api.ensureProfile('민병희');
    const open = await api.peekInvite(FAKE_DEMO_CODES.open);
    assert.deepEqual([open.memberCount, open.myState, open.startedAtMs], [3, null, null]);
    assert.deepEqual(open.invitees.map((i) => [i.name, i.claimed]), [['현우', true], ['태호', true], ['민병희', false], ['병희', false]]);
    assert.equal((await api.claimSlot(open.id, '민병희', open.version, true)).started, false);
    assert.equal((await api.getMyProfile())?.balance, 900);

    const full = await api.peekInvite(FAKE_DEMO_CODES.full);
    assert.equal(full.invitees.filter((i) => !i.claimed).length, 0);
    await assert.rejects(api.claimSlot(full.id, '민병희', full.version, true), { code: 'LB_NOT_INVITED' });

    const started = await api.peekInvite(FAKE_DEMO_CODES.started);
    assert.notEqual(started.startedAtMs, null, '주최자가 이미 시작했다');
    assert.equal((await api.claimSlot(started.id, '민병희', started.version, true)).started, true);
    const live = await api.getLive(started.id);
    assert.ok(live.participants.some((p) => p.userId !== 'me' && p.location !== null), '들어오는 순간 봇 위치가 보인다');

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

describe('fakeApi: SQL 과 맞춘 판정(Conformance 에서 찾은 차이)', () => {
  it('13자 이름으로 수락하면 명단을 보기 전에 LB_BAD_NICKNAME (SQL lb_claim_slot 과 같다)', () => {
    const { server, user, input, claim } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    user('g', '현우');
    throwsCode(() => claim('g', a.id, '가나다라마바사아자차카타파'), 'LB_BAD_NICKNAME');
    throwsCode(() => claim('g', a.id, ' ​ '), 'LB_BAD_NICKNAME');
    throwsCode(() => claim('g', a.id, '철수'), 'LB_NOT_INVITED');
  });

  it('시작 후 약속 직전에 장소만 바꾸며 같은 localAt 을 실어 보내도 된다(시각이 실제로 바뀔 때만 5분 검사)', () => {
    const { server, user, input, clock, claim, start } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180, ['현우']));
    claim(user('g', '현우'), a.id, '현우');
    start(a.id);
    clock.t = a.meetAtMs - 3 * MIN;
    const moved = server.edit('host', a.id, { localAt: a.localAt, tz: a.tz, placeName: '강남역 2층' }, a.version);
    assert.equal(moved.placeName, '강남역 2층');
    assert.equal(moved.meetAtMs, a.meetAtMs);
    assert.equal(moved.version, a.version + 1);
    // 시각이 실제로 바뀌면 그대로 검사한다(5분 안으로는 못 미룬다)
    throwsCode(
      () => server.edit('host', a.id, { localAt: msToLocalAt(a.meetAtMs + 1 * MIN, TZ), tz: TZ }, moved.version),
      'LB_TIME_IN_PAST',
    );
  });

  it('핀을 옮기면 아직 안 온 사람의 first_near 는 지워진다 — 보증 도착 시각은 옛 장소 근처가 아니라 누른 순간', () => {
    const { server, user, input, clock, claim, start, here } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180, ['현우']));
    claim(user('g', '현우'), a.id, '현우');
    start(a.id);
    clock.t = a.meetAtMs - 20 * MIN;
    const near = offsetPoint(PLACE.lat, PLACE.lng, 30, 0);
    assert.equal(server.reportLocation('g', a.id, { ...near, accuracyM: 150 }).reason, 'low_accuracy');
    const pin = offsetPoint(PLACE.lat, PLACE.lng, 40, Math.PI / 2);
    const moved = server.edit('host', a.id, { lat: pin.lat, lng: pin.lng }, a.version);
    clock.t = a.meetAtMs - 10 * MIN;
    assert.equal(server.reportLocation('host', a.id, { ...here, lat: pin.lat, lng: pin.lng }).arrived, true);
    server.vouch('host', a.id, 'g');
    const g = server.getLive('host', a.id).participants.find((p) => p.userId === 'g');
    assert.equal(g?.arrivedAtMs, clock.t);
    assert.equal(moved.version, a.version + 1);
  });

  it('시각을 안 바꾸고 핀만 다른 시간대 경도로 옮기면 LB_TZ_SUSPECT, 확인하면 통과', () => {
    const { server, user, input } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180));
    throwsCode(() => server.edit('host', a.id, { lat: 40.7, lng: -74 }, a.version), 'LB_TZ_SUSPECT');
    assert.equal(server.edit('host', a.id, { lat: 40.7, lng: -74, tzConfirmed: true }, a.version).placeLng, -74);
  });

  it('범위 밖 핀은 생성·수정 모두 LB_BAD_POSITION', () => {
    const { server, user, input } = setup();
    user('host', '지수');
    throwsCode(() => server.createAppointment('host', { ...input(180), lat: 200 }), 'LB_BAD_POSITION');
    const a = server.createAppointment('host', input(180));
    throwsCode(() => server.edit('host', a.id, { lat: 95, lng: PLACE.lng }, a.version), 'LB_BAD_POSITION');
  });

  it('정책은 있는 키만 바꾼다(SQL coalesce): 수정은 지금 값, 생성은 기본값(반경 100·5분·0P·0분)을 채운다', () => {
    const { server, user, input, balance } = setup();
    const a = server.createAppointment(user('host', '지수'), input(180, [], presetPolicy('normal')));
    const e = server.edit('host', a.id, { policy: { stake: 50 } as unknown as LatePolicy }, a.version);
    assert.deepEqual(e.policy, { ...a.policy, stake: 50 });
    assert.equal(balance('host'), 1000 - 50);
    throwsCode(() => server.edit('host', a.id, { policy: { stake: 1.5 } as unknown as LatePolicy }, e.version), 'LB_CHECK_VIOLATION');
    const b = server.createAppointment('host', { ...input(200), policy: { stake: 20 } as unknown as LatePolicy });
    assert.deepEqual(b.policy, { stake: 20, radiusM: 100, unitMinutes: 5, penaltyPerUnit: 0, graceMinutes: 0 });
  });

  it('홈 목록: 약속 시각이 같으면 만든 순서, 원장 조회는 최대 500줄', () => {
    const { server, user, input, clock } = setup();
    user('host', '지수');
    const ids = [0, 1, 2].map((i) => {
      clock.t += 1000;
      return server.createAppointment('host', { ...input(180, [], presetPolicy('normal'), `약속 ${i}`), localAt: msToLocalAt(T0 + 180 * MIN, TZ) }).id;
    });
    assert.deepEqual(server.listMyAppointments('host').map((x) => x.id), ids);
    assert.equal(server.listLedger('host', 10_000).length, 4);
  });
});
