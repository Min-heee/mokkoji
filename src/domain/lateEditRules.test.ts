import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { haversineMeters } from './geo';
import {
  canKickAfterStart,
  canMovePlace,
  canPostpone,
  cooldownOutlastsMeet,
  formatWaitKo,
  isJoinedAfterStart,
  MOVE_AFTER_START_MAX_M,
  POSTPONE_MAX_MINUTES_AFTER_START,
  postponeChoices,
  postponeLimitMs,
  postponeRemainingMinutes,
  START_COOLDOWN_MS,
  startableAtFrom,
  startCooldownRemainingMs,
  type EditRulesAppointment,
} from './lateEditRules';

const MIN = 60_000;
const MEET = Date.UTC(2026, 8, 25, 10, 30);
const PIN = { lat: 37.49808, lng: 127.02761 };

/** 북쪽으로 distM 떨어진 점 */
const north = (distM: number) => ({ lat: PIN.lat + distM / 111_195, lng: PIN.lng });

const started = (over: Partial<EditRulesAppointment> = {}): EditRulesAppointment => ({
  meetAtMs: MEET,
  startedAtMs: MEET - 60 * MIN,
  startMeetAtMs: MEET,
  placeLat: PIN.lat,
  placeLng: PIN.lng,
  startPlaceLat: PIN.lat,
  startPlaceLng: PIN.lng,
  ...over,
});
const notStarted = (): EditRulesAppointment => ({
  ...started(),
  startedAtMs: null,
  startMeetAtMs: null,
  startPlaceLat: null,
  startPlaceLng: null,
});

describe('상수 (SQL 과 같은 값)', () => {
  it('180분 · 500m · 5분', () => {
    assert.equal(POSTPONE_MAX_MINUTES_AFTER_START, 180);
    assert.equal(MOVE_AFTER_START_MAX_M, 500);
    assert.equal(START_COOLDOWN_MS, 5 * MIN);
  });
});

describe('R1 canPostpone', () => {
  const now = MEET - 30 * MIN;
  it('시작 전에는 자유(앞당기기·먼 미루기 포함)', () => {
    assert.deepEqual(canPostpone(notStarted(), MEET - 20 * MIN, now), { ok: true });
    assert.deepEqual(canPostpone(notStarted(), MEET + 600 * MIN, now), { ok: true });
    assert.equal(postponeLimitMs(notStarted()), null);
  });
  it('시각이 그대로면 약속 시각이 지났어도 된다(미루기가 아니다)', () => {
    assert.deepEqual(canPostpone(started(), MEET, MEET + 10 * MIN), { ok: true });
  });
  it('앞당기기 → LB_POSTPONE_ONLY', () => {
    assert.deepEqual(canPostpone(started(), MEET - MIN, now), { ok: false, code: 'LB_POSTPONE_ONLY' });
  });
  it('약속 시각이 지나면(같은 순간 포함) → LB_POSTPONE_AFTER_MEET', () => {
    assert.deepEqual(canPostpone(started(), MEET + 10 * MIN, MEET), { ok: false, code: 'LB_POSTPONE_AFTER_MEET' });
    assert.deepEqual(canPostpone(started(), MEET + 10 * MIN, MEET - 1), { ok: true });
  });
  it('한도 = 시작하던 순간의 약속 시각 + 180분(경계 포함)', () => {
    assert.equal(postponeLimitMs(started()), MEET + 180 * MIN);
    assert.deepEqual(canPostpone(started(), MEET + 180 * MIN, now), { ok: true });
    assert.deepEqual(canPostpone(started(), MEET + 181 * MIN, now), { ok: false, code: 'LB_POSTPONE_TOO_FAR' });
  });
  it('반복 미루기로 늘리지 못한다: 이미 120분 미룬 뒤에는 61분 더 못 미룬다', () => {
    const a = started({ meetAtMs: MEET + 120 * MIN });
    assert.deepEqual(canPostpone(a, MEET + 180 * MIN, now), { ok: true });
    assert.deepEqual(canPostpone(a, MEET + 181 * MIN, now), { ok: false, code: 'LB_POSTPONE_TOO_FAR' });
  });
});

describe('R2 canMovePlace', () => {
  it('시작 전에는 어디로든', () => {
    assert.deepEqual(canMovePlace(notStarted(), 35, 129), { ok: true, distanceM: null });
  });
  it('시작 후 499m 는 되고 501m 는 LB_MOVE_TOO_FAR', () => {
    const near = north(499);
    const far = north(501);
    assert.equal(canMovePlace(started(), near.lat, near.lng).ok, true);
    const r = canMovePlace(started(), far.lat, far.lng);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, 'LB_MOVE_TOO_FAR');
    assert.ok(Math.abs(r.distanceM! - 501) < 1);
  });
  it('누적 기준: 이미 400m 옮긴 핀에서 400m 더(처음에서 800m)는 안 된다', () => {
    const moved = north(400);
    const a = started({ placeLat: moved.lat, placeLng: moved.lng });
    const next = north(800);
    assert.equal(canMovePlace(a, next.lat, next.lng).ok, false);
    // 처음 핀 쪽으로 되돌리는 건 된다
    assert.equal(canMovePlace(a, PIN.lat, PIN.lng).ok, true);
  });
  it('핀이 그대로면(이름만 바꾸기) 된다', () => {
    const moved = north(450);
    assert.equal(canMovePlace(started({ placeLat: moved.lat, placeLng: moved.lng }), moved.lat, moved.lng).ok, true);
  });
  it('거리는 geo.haversineMeters 와 같다', () => {
    const p = north(300);
    const r = canMovePlace(started(), p.lat, p.lng);
    assert.equal(r.distanceM, haversineMeters(PIN, p));
  });
});

describe('R3 시작 대기', () => {
  it('startableAtFrom: 변경 + 5분이 아직 미래면 그 ms, 아니면 null', () => {
    const t = MEET - 60 * MIN;
    assert.equal(startableAtFrom(null, t), null);
    assert.equal(startableAtFrom(t, t), t + 5 * MIN);
    assert.equal(startableAtFrom(t, t + 5 * MIN - 1), t + 5 * MIN);
    assert.equal(startableAtFrom(t, t + 5 * MIN), null);
  });
  it('startCooldownRemainingMs', () => {
    assert.equal(startCooldownRemainingMs({ startableAtMs: null }, 0), 0);
    assert.equal(startCooldownRemainingMs({ startableAtMs: 1000 }, 400), 600);
    assert.equal(startCooldownRemainingMs({ startableAtMs: 1000 }, 1000), 0);
    assert.equal(startCooldownRemainingMs({ startableAtMs: 1000 }, 5000), 0);
  });
});

describe('R4 시작 후 내보내기', () => {
  it('isJoinedAfterStart: claimedAt > startedAt 만 true', () => {
    assert.equal(isJoinedAfterStart(null, 100), false); // 주최자
    assert.equal(isJoinedAfterStart(50, null), false); // 시작 전
    assert.equal(isJoinedAfterStart(100, 100), false);
    assert.equal(isJoinedAfterStart(101, 100), true);
  });
  it('canKickAfterStart', () => {
    assert.equal(canKickAfterStart({ joinedAfterStart: true }), true);
    assert.equal(canKickAfterStart({ joinedAfterStart: false }), false);
  });
});

describe('화면용 조각', () => {
  it('postponeChoices: 누적 한도(시작 때 약속 시각 + 180분) 안의 것만', () => {
    // 이미 60분 미룬 약속: 남은 한도 120분
    const a = started({ meetAtMs: MEET + 60 * MIN });
    const now = MEET - 30 * MIN;
    const got = postponeChoices(a, now, [15, 30, 60, 120, 180], 5 * MIN).map((c) => c.minutes);
    assert.deepEqual(got, [15, 30, 60, 120]);
    assert.equal(postponeRemainingMinutes(a), 120);
  });
  it('postponeChoices: 약속 시각이 지났으면 빈 배열', () => {
    const a = started();
    assert.deepEqual(postponeChoices(a, MEET, [15, 30], 5 * MIN), []);
    assert.deepEqual(postponeChoices(a, MEET - 1, [15, 30], 0).map((c) => c.minutes), [15, 30]);
  });
  it('postponeChoices: 지금+5분 이하는 뺀다', () => {
    const a = started();
    assert.deepEqual(postponeChoices(a, MEET - 1, [5, 15], 10 * MIN).map((c) => c.minutes), [15]);
  });
  it('postponeRemainingMinutes: 시작 전 null, 다 쓰면 0', () => {
    assert.equal(postponeRemainingMinutes(notStarted()), null);
    assert.equal(postponeRemainingMinutes(started({ meetAtMs: MEET + 180 * MIN })), 0);
  });
  it('cooldownOutlastsMeet', () => {
    assert.equal(cooldownOutlastsMeet({ startableAtMs: null, meetAtMs: MEET }), false);
    assert.equal(cooldownOutlastsMeet({ startableAtMs: MEET - 1, meetAtMs: MEET }), false);
    assert.equal(cooldownOutlastsMeet({ startableAtMs: MEET, meetAtMs: MEET }), true);
  });
  it('formatWaitKo', () => {
    assert.equal(formatWaitKo(START_COOLDOWN_MS), '5분');
    assert.equal(formatWaitKo(4 * MIN + 12_000), '4분 12초');
    assert.equal(formatWaitKo(44_001), '45초');
    assert.equal(formatWaitKo(0), '1초');
  });
});
