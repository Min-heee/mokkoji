import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatAppointmentTime, normalizeAppointment } from './appointment';
import { sessionCandidates, toSessionDraft, type ToSessionLive } from './toSession';

const LIVE: ToSessionLive = {
  appointment: {
    id: 'appt-1',
    title: ' 금요일 곱창 ',
    localAt: '2026-09-25T19:30',
    placeName: '강남역 2번 출구 곱창',
    placeNote: '2번 출구에서 도보 3분',
  },
  participants: [
    { userId: 'u1', nickname: '지수', state: 'active', arrivedAtMs: 1, resultStatus: 'onTime' },
    { userId: 'u2', nickname: '민병희', state: 'active', arrivedAtMs: 2, resultStatus: 'onTime' },
    { userId: 'u3', nickname: '현우', state: 'active', arrivedAtMs: 3, resultStatus: 'late' },
    { userId: 'u4', nickname: '태호', state: 'active', arrivedAtMs: null, resultStatus: 'noShow' },
    { userId: 'u5', nickname: '요청만', state: 'pending', arrivedAtMs: null },
  ],
};

describe('sessionCandidates', () => {
  it('활성 참가자만, 서버 순서 그대로, 오지 않은 사람에 라벨', () => {
    assert.deepEqual(sessionCandidates(LIVE), [
      { userId: 'u1', name: '지수', noShow: false },
      { userId: 'u2', name: '민병희', noShow: false },
      { userId: 'u3', name: '현우', noShow: false },
      { userId: 'u4', name: '태호', noShow: true },
    ]);
  });

  it('정산 전이면 도착 여부로 라벨을 정한다', () => {
    const live: ToSessionLive = {
      ...LIVE,
      participants: [
        { userId: 'u1', nickname: '지수', state: 'active', arrivedAtMs: 1, resultStatus: null },
        { userId: 'u2', nickname: '현우', state: 'active', arrivedAtMs: null },
      ],
    };
    assert.deepEqual(sessionCandidates(live).map((c) => c.noShow), [false, true]);
  });

  it('빈 이름과 같은 이름은 한 번만', () => {
    const live: ToSessionLive = {
      ...LIVE,
      participants: [
        { userId: 'u1', nickname: '지수', state: 'active', arrivedAtMs: 1 },
        { userId: 'u2', nickname: ' 지수 ', state: 'active', arrivedAtMs: 1 },
        { userId: 'u3', nickname: '   ', state: 'active', arrivedAtMs: 1 },
      ],
    };
    assert.deepEqual(sessionCandidates(live).map((c) => c.userId), ['u1']);
  });
});

describe('toSessionDraft', () => {
  it('기본은 전원 — 오지 않은 사람도 포함한다', () => {
    const d = toSessionDraft(LIVE);
    assert.equal(d.title, '금요일 곱창');
    assert.deepEqual(d.people, [{ name: '지수' }, { name: '민병희' }, { name: '현우' }, { name: '태호' }]);
    assert.deepEqual(d.appointment, {
      at: '2026-09-25T19:30',
      place: '강남역 2번 출구 곱창',
      placeNote: '2번 출구에서 도보 3분',
    });
    assert.equal(d.lateBetId, 'appt-1');
  });

  it('시트에서 체크한 사람만 넘긴다(순서는 서버 순서)', () => {
    assert.deepEqual(toSessionDraft(LIVE, ['u3', 'u1', 'u5', 'nobody']).people, [{ name: '지수' }, { name: '현우' }]);
    assert.deepEqual(toSessionDraft(LIVE, []).people, []);
  });

  it('약속 값은 기존 Appointment 정규화를 그대로 통과한다', () => {
    const d = toSessionDraft(LIVE);
    assert.deepEqual(normalizeAppointment(d.appointment), d.appointment);
    assert.equal(formatAppointmentTime(d.appointment.at), '9월 25일 (금) 오후 7:30');
  });

  it('제목이 비면 "새 모임", 시각 형식이 틀리면 null, 메모가 없으면 빈 문자열', () => {
    const d = toSessionDraft({
      appointment: { id: 'a', title: '  ', localAt: '2026-09-25 19:30', placeName: '어딘가', placeNote: null },
      participants: [],
    });
    assert.equal(d.title, '새 모임');
    assert.equal(d.appointment.at, null);
    assert.equal(d.appointment.placeNote, '');
    assert.deepEqual(d.people, []);
  });
});
