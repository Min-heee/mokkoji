import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { presetPolicy } from '../domain/latePresets';
import {
  appointmentIdFromData,
  diffReminders,
  meetBody,
  MIN_LEAD_MS,
  planForLive,
  planReminders,
  readReminderData,
  reminderData,
  reminderKey,
  sameReminderPlan,
  toDeviceFrame,
  type ReminderAppointment,
  type ReminderItem,
  type ScheduledReminder,
} from './reminderPlan';

const MIN = 60_000;
const MEET = Date.UTC(2026, 8, 25, 10, 30); // 2026-09-25 19:30 KST
const HOST = 'host-1';
const GUEST = 'guest-1';

const appt = (over: Partial<ReminderAppointment> = {}): ReminderAppointment => ({
  id: 'appt-1',
  version: 1,
  title: '금요일 곱창',
  status: 'open',
  meetAtMs: MEET,
  startedAtMs: null,
  closeMs: MEET + 75 * MIN,
  policy: presetPolicy('normal'), // 100P · 5분마다 −10P · 봐주는 시간 0
  hostId: HOST,
  ...over,
});

const guest = { userId: GUEST, arrivedAtMs: null };
const host = { userId: HOST, arrivedAtMs: null };
const kinds = (items: ReminderItem[]) => items.map((i) => i.kind);
const EMOJI = /\p{Extended_Pictographic}/u;

describe('planReminders — 누가 무엇을 받나', () => {
  it('시작 전 주최자: 30분 전 [시작하기] 안내 + 15분·5분 전(시작 재촉), 정시 알림은 없다', () => {
    const plan = planReminders(appt(), host, MEET - 2 * 60 * MIN);
    assert.deepEqual(kinds(plan), ['host-start', 'before-15', 'before-5']);
    assert.equal(plan[0].fireAtMs, MEET - 30 * MIN);
    assert.match(plan[0].body, /\[시작하기\]/);
    assert.match(plan[0].body, /무효/);
    assert.match(plan[2].body, /\[시작하기\]를 누르지 않으면 무효/);
  });

  it('시작 후 주최자: [시작하기] 안내가 빠지고 게스트와 같은 15분·5분 전·정시', () => {
    const plan = planReminders(appt({ startedAtMs: MEET - 60 * MIN }), host, MEET - 50 * MIN);
    assert.deepEqual(kinds(plan), ['before-15', 'before-5', 'at-meet']);
    assert.equal(plan[1].body, '곧 약속 시간이에요. 도착했으면 앱을 열어 체크인하세요.');
  });

  it('게스트: 시작 여부와 관계없이 15분·5분 전·정시, 30분 전 안내는 없다', () => {
    assert.deepEqual(kinds(planReminders(appt(), guest, MEET - 60 * MIN)), ['before-15', 'before-5', 'at-meet']);
    assert.deepEqual(
      kinds(planReminders(appt({ startedAtMs: MEET - 40 * MIN }), guest, MEET - 30 * MIN)),
      ['before-15', 'before-5', 'at-meet'],
    );
  });

  it('시각은 약속 시각 기준 30·15·5·0분 전이고 울릴 순서로 온다', () => {
    const plan = planReminders(appt({ startedAtMs: MEET - 90 * MIN }), guest, MEET - 60 * MIN);
    assert.deepEqual(
      plan.map((i) => i.fireAtMs),
      [MEET - 15 * MIN, MEET - 5 * MIN, MEET],
    );
  });

  it('키 = 약속 id + version + 종류', () => {
    const plan = planReminders(appt({ version: 7 }), guest, MEET - 60 * MIN);
    assert.deepEqual(
      plan.map((i) => i.key),
      ['late:appt-1:v7:before-15', 'late:appt-1:v7:before-5', 'late:appt-1:v7:at-meet'],
    );
    assert.equal(reminderKey('a', 3, 'at-meet'), 'late:a:v3:at-meet');
    assert.ok(plan.every((i) => i.appointmentId === 'appt-1'));
  });
});

describe('planReminders — 계획이 없는 경우', () => {
  it('아직 참여 전(me = null)', () => {
    assert.deepEqual(planReminders(appt(), null, MEET - 60 * MIN), []);
  });

  it('이미 도착', () => {
    assert.deepEqual(planReminders(appt({ startedAtMs: MEET - 60 * MIN }), { userId: GUEST, arrivedAtMs: MEET - 20 * MIN }, MEET - 60 * MIN), []);
  });

  it('취소·정산·무효된 약속', () => {
    for (const status of ['canceled', 'settled', 'voided'] as const) {
      assert.deepEqual(planReminders(appt({ status }), guest, MEET - 60 * MIN), [], status);
    }
  });

  it('이미 지난 시각은 뺀다(곧 울릴 것은 남긴다 — 이미 예약된 것을 취소하지 않게)', () => {
    // 약속 10분 전: 30·15분 전은 지났다
    assert.deepEqual(kinds(planReminders(appt(), guest, MEET - 10 * MIN)), ['before-5', 'at-meet']);
    // 5분 전 알림 시각의 5초 전 → 계획에는 남는다
    assert.deepEqual(kinds(planReminders(appt(), guest, MEET - 5 * MIN - 5_000)), ['before-5', 'at-meet']);
    // 정확히 그 시각이면 지난 것
    assert.deepEqual(kinds(planReminders(appt(), guest, MEET - 5 * MIN)), ['at-meet']);
    // 약속 시각이 지났으면 아무것도 없다
    assert.deepEqual(planReminders(appt({ startedAtMs: MEET - 60 * MIN }), guest, MEET + MIN), []);
  });

  it('마감(closeMs) 뒤·시각이 쓰레기면 없다', () => {
    assert.deepEqual(planReminders(appt(), guest, MEET + 200 * MIN), []);
    assert.deepEqual(planReminders(appt(), guest, Number.NaN), []);
    assert.deepEqual(planReminders(appt({ meetAtMs: Number.NaN }), guest, MEET - 60 * MIN), []);
  });
});

describe('planReminders — 시간 미루기', () => {
  it('version 이 오르면 키가 전부 바뀌고 시각도 새 약속 기준', () => {
    const before = planReminders(appt({ startedAtMs: MEET - 90 * MIN }), guest, MEET - 60 * MIN);
    const after = planReminders(
      appt({ startedAtMs: MEET - 90 * MIN, version: 2, meetAtMs: MEET + 30 * MIN, closeMs: MEET + 105 * MIN }),
      guest,
      MEET - 60 * MIN,
    );
    const oldKeys = new Set(before.map((i) => i.key));
    assert.ok(after.every((i) => !oldKeys.has(i.key)));
    assert.deepEqual(
      after.map((i) => i.fireAtMs),
      [MEET + 15 * MIN, MEET + 25 * MIN, MEET + 30 * MIN],
    );
  });
});

describe('정시 문구(meetBody) — 정책에서 계산', () => {
  it('보통(100P · 5분마다 10P): "지금부터 늦으면 5분마다 −10P예요"', () => {
    assert.equal(meetBody(presetPolicy('normal'), true), '약속 시간이 됐어요. 지금부터 늦으면 5분마다 −10P예요.');
  });

  it('매운맛(300P · 1분마다 10P)', () => {
    assert.equal(meetBody(presetPolicy('spicy'), true), '약속 시간이 됐어요. 지금부터 늦으면 1분마다 −10P예요.');
  });

  it('봐주는 시간이 있으면 그 뒤부터라고 말한다', () => {
    assert.equal(
      meetBody({ ...presetPolicy('normal'), graceMinutes: 10 }, true),
      '약속 시간이 됐어요. 10분까지는 봐주고, 그 뒤로는 5분마다 −10P예요.',
    );
  });

  it('걸 포인트가 0이면 포인트 문구가 없다', () => {
    const body = meetBody({ ...presetPolicy('normal'), stake: 0 }, true);
    assert.equal(body, '약속 시간이 됐어요. 도착했으면 앱을 열어 체크인하세요.');
    assert.doesNotMatch(body, /P/);
  });

  it('단위 차감이 0이면 끝까지 안 올 때만 잃는다고 말한다', () => {
    assert.equal(
      meetBody({ ...presetPolicy('normal'), penaltyPerUnit: 0 }, true),
      '약속 시간이 됐어요. 늦어도 괜찮지만 끝까지 오지 않으면 100P를 모두 잃어요.',
    );
  });

  it('단위 차감이 걸 포인트보다 크면 걸 포인트만큼만 적는다', () => {
    assert.match(meetBody({ ...presetPolicy('normal'), stake: 50, penaltyPerUnit: 80 }, true), /−50P예요/);
  });

  it('시작 전에 계획한 정시 알림은 무효일 수도 있어 포인트를 말하지 않는다', () => {
    const plan = planReminders(appt(), guest, MEET - 60 * MIN);
    const atMeet = plan.find((i) => i.kind === 'at-meet');
    assert.equal(atMeet?.body, '약속 시간이 됐어요. 앱을 열어 약속 상태를 확인해 주세요.');
  });

  it('시작 후 계획한 정시 알림은 포인트 문구', () => {
    const plan = planReminders(appt({ startedAtMs: MEET - 60 * MIN }), guest, MEET - 30 * MIN);
    assert.equal(plan.find((i) => i.kind === 'at-meet')?.body, '약속 시간이 됐어요. 지금부터 늦으면 5분마다 −10P예요.');
  });
});

describe('문구 — 개인정보·이모지', () => {
  it('제목은 약속 제목뿐, 본문에 닉네임·장소가 없고 이모지가 없다', () => {
    const cases = [
      planReminders(appt(), host, MEET - 2 * 60 * MIN),
      planReminders(appt({ startedAtMs: MEET - 90 * MIN }), host, MEET - 60 * MIN),
      planReminders(appt(), guest, MEET - 60 * MIN),
      planReminders(appt({ policy: { ...presetPolicy('normal'), stake: 0 } }), guest, MEET - 60 * MIN),
    ].flat();
    assert.ok(cases.length > 0);
    for (const i of cases) {
      assert.equal(i.title, '금요일 곱창');
      assert.doesNotMatch(i.body, /host-1|guest-1|강남/);
      assert.doesNotMatch(i.title + i.body, EMOJI);
    }
  });

  it('빈 제목은 "약속", 긴 제목은 40자로 자른다', () => {
    assert.equal(planReminders(appt({ title: '   ' }), guest, MEET - 60 * MIN)[0].title, '약속');
    const long = planReminders(appt({ title: '가'.repeat(80) }), guest, MEET - 60 * MIN)[0].title;
    assert.equal(long.length, 40);
    assert.ok(long.endsWith('…'));
  });
});

describe('planForLive', () => {
  const live = (over: { settlePending?: boolean; myUserId?: string; arrivedAtMs?: number | null } = {}) => ({
    myUserId: over.myUserId ?? GUEST,
    settlePending: over.settlePending ?? false,
    appointment: { ...appt(), inviteCode: 'X', hostNickname: '지수', localAt: '', tz: 'Asia/Seoul', placeName: '', placeNote: '', placeLat: 0, placeLng: 0, voidReason: null, invitees: [], changes: [], startMeetAtMs: null, startPlaceLat: null, startPlaceLng: null, startableAtMs: null },
    participants: [
      { userId: HOST, arrivedAtMs: null },
      { userId: GUEST, arrivedAtMs: over.arrivedAtMs ?? null },
    ],
  });

  it('내 행으로 계획을 짠다', () => {
    assert.deepEqual(kinds(planForLive(live(), MEET - 60 * MIN)), ['before-15', 'before-5', 'at-meet']);
    assert.deepEqual(kinds(planForLive(live({ myUserId: HOST }), MEET - 60 * MIN)), ['host-start', 'before-15', 'before-5']);
  });

  it('정산 확인 중·내 행 없음·도착이면 빈 계획', () => {
    assert.deepEqual(planForLive(live({ settlePending: true }), MEET - 60 * MIN), []);
    assert.deepEqual(planForLive(live({ myUserId: 'someone-else' }), MEET - 60 * MIN), []);
    assert.deepEqual(planForLive(live({ arrivedAtMs: MEET - 70 * MIN }), MEET - 60 * MIN), []);
  });
});

describe('toDeviceFrame', () => {
  it('기기 시각 = 서버 시각 − 오프셋(서버가 앞서 있으면 더 일찍)', () => {
    const plan = planReminders(appt(), guest, MEET - 60 * MIN);
    const dev = toDeviceFrame(plan, 10 * MIN);
    assert.deepEqual(
      dev.map((i) => i.fireAtMs),
      plan.map((i) => i.fireAtMs - 10 * MIN),
    );
    assert.deepEqual(
      dev.map((i) => i.key),
      plan.map((i) => i.key),
    );
    // 오프셋이 쓰레기면 그대로
    assert.deepEqual(toDeviceFrame(plan, Number.NaN), plan);
  });
});

describe('알림 data', () => {
  const item = planReminders(appt(), guest, MEET - 60 * MIN)[0];

  it('reminderData ↔ readReminderData 왕복', () => {
    const d = reminderData(item);
    assert.deepEqual(readReminderData(JSON.parse(JSON.stringify(d))), d);
    assert.equal(appointmentIdFromData(d), 'appt-1');
  });

  it('우리 표식이 없거나 모양이 이상하면 null(라우트에 넣지 않는다)', () => {
    assert.equal(readReminderData(null), null);
    assert.equal(readReminderData('x'), null);
    assert.equal(readReminderData({ ...reminderData(item), source: 'other' }), null);
    assert.equal(appointmentIdFromData({ ...reminderData(item), appointmentId: '../../session/1' }), null);
    assert.equal(appointmentIdFromData({ ...reminderData(item), appointmentId: 'a'.repeat(65) }), null);
    assert.equal(appointmentIdFromData({ ...reminderData(item), appointmentId: 42 }), null);
    assert.equal(readReminderData({ ...reminderData(item), kind: 'bogus' }), null);
  });

  it('fireAtMs 가 없으면 NaN 으로 읽는다(→ 다시 예약)', () => {
    const { fireAtMs: _drop, ...rest } = reminderData(item);
    assert.ok(Number.isNaN(readReminderData(rest)?.fireAtMs));
  });
});

describe('diffReminders', () => {
  const plan = planReminders(appt({ startedAtMs: MEET - 90 * MIN }), guest, MEET - 60 * MIN);
  const asScheduled = (items: ReminderItem[]): ScheduledReminder[] =>
    items.map((i) => ({ key: i.key, fireAtMs: i.fireAtMs, title: i.title, body: i.body }));

  it('아무것도 없으면 전부 예약, 같은 계획으로 다시 부르면 아무것도 안 한다', () => {
    assert.deepEqual(diffReminders([], plan), { cancel: [], schedule: plan });
    assert.deepEqual(diffReminders(asScheduled(plan), plan), { cancel: [], schedule: [] });
  });

  it('계획에서 빠진 키는 취소(도착·시작 뒤 [시작하기] 안내 등)', () => {
    const d = diffReminders(asScheduled(plan), plan.slice(1));
    assert.deepEqual(d.cancel, [plan[0].key]);
    assert.deepEqual(d.schedule, []);
    assert.deepEqual(diffReminders(asScheduled(plan), []).cancel, plan.map((i) => i.key));
  });

  it('문구가 바뀌면(같은 키) 취소 뒤 다시 예약', () => {
    const changed = plan.map((i, n) => (n === 0 ? { ...i, body: i.body + ' ' } : i));
    const d = diffReminders(asScheduled(plan), changed);
    assert.deepEqual(d.cancel, [plan[0].key]);
    assert.deepEqual(d.schedule, [changed[0]]);
  });

  it('시각 흔들림은 허용 범위 안이면 그대로, 넘으면 다시 예약(가짜 서버 빨리 감기)', () => {
    const jitter = plan.map((i) => ({ ...i, fireAtMs: i.fireAtMs + 800 }));
    assert.deepEqual(diffReminders(asScheduled(plan), jitter), { cancel: [], schedule: [] });
    const jumped = toDeviceFrame(plan, 10 * MIN);
    const d = diffReminders(asScheduled(plan), jumped);
    assert.deepEqual(d.cancel, plan.map((i) => i.key));
    assert.deepEqual(d.schedule, jumped);
  });

  it('예약 시각을 모르는(NaN) 옛 예약은 다시 예약한다', () => {
    const unknown = asScheduled(plan).map((s) => ({ ...s, fireAtMs: Number.NaN }));
    const d = diffReminders(unknown, plan);
    assert.equal(d.cancel.length, plan.length);
    assert.equal(d.schedule.length, plan.length);
  });

  it('곧 울릴 것(notBeforeMs 이전)은 새로 예약하지 않지만, 이미 예약된 것은 그대로 둔다', () => {
    const notBeforeMs = plan[0].fireAtMs + 1; // 15분 전 알림이 MIN_LEAD_MS 안으로 들어온 상황
    // 아직 아무것도 예약 안 됨 → 15분 전은 건너뛰고 나머지만
    assert.deepEqual(
      diffReminders([], plan, { notBeforeMs }).schedule.map((i) => i.kind),
      ['before-5', 'at-meet'],
    );
    // 이미 예약됨 → 취소하지 않는다
    assert.deepEqual(diffReminders(asScheduled(plan), plan, { notBeforeMs }), { cancel: [], schedule: [] });
    assert.ok(MIN_LEAD_MS > 0);
  });

  it('sameReminderPlan: 허용 범위 안의 흔들림은 같은 계획', () => {
    assert.equal(sameReminderPlan(plan, plan.map((i) => ({ ...i, fireAtMs: i.fireAtMs - 500 }))), true);
    assert.equal(sameReminderPlan(plan, plan.slice(1)), false);
    assert.equal(sameReminderPlan(plan, toDeviceFrame(plan, 5 * MIN)), false);
    assert.equal(sameReminderPlan([], []), true);
  });

  it('version 이 오르면 옛 키 전부 취소 + 새 키 전부 예약', () => {
    const next = planReminders(appt({ startedAtMs: MEET - 90 * MIN, version: 2, meetAtMs: MEET + 30 * MIN, closeMs: MEET + 105 * MIN }), guest, MEET - 60 * MIN);
    const d = diffReminders(asScheduled(plan), next);
    assert.deepEqual(d.cancel, plan.map((i) => i.key));
    assert.deepEqual(d.schedule, next);
  });
});
