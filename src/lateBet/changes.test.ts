import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { presetPolicy } from '../domain/latePresets';
import { changeParts, describeChanges } from './changes';
import type { LbAppointmentChange, LbAppointmentSnapshot } from './types';

const MIN = 60_000;
const MEET = Date.UTC(2026, 8, 25, 10, 30); // 2026-09-25 19:30 KST
const TZ = 'Asia/Seoul';

const snap = (over: Partial<LbAppointmentSnapshot> = {}): LbAppointmentSnapshot => ({
  localAt: '2026-09-25T19:30',
  tz: TZ,
  meetAtMs: MEET,
  placeName: '강남역 2번 출구 곱창',
  placeLat: 37.49808,
  placeLng: 127.02761,
  policy: presetPolicy('normal'),
  ...over,
});

const change = (version: number, before: LbAppointmentSnapshot, after: LbAppointmentSnapshot): LbAppointmentChange => ({
  version,
  atMs: MEET - 60 * MIN,
  before,
  after,
});

describe('describeChanges', () => {
  it('시간과 건 포인트가 바뀌면 "오후 7:30 → 오후 8:00 · 건 포인트 100P → 200P"', () => {
    const c = change(2, snap(), snap({ meetAtMs: MEET + 30 * MIN, policy: { ...presetPolicy('normal'), stake: 200 } }));
    assert.equal(describeChanges([c], TZ), '주최자가 약속을 바꿨어요: 오후 7:30 → 오후 8:00 · 건 포인트 100P → 200P');
  });

  it('여러 건이면 첫 before 와 마지막 after 만 비교하고, 원래대로 돌아왔으면 빈 문자열', () => {
    const a = change(2, snap(), snap({ placeName: '강남역 3번 출구' }));
    const b = change(3, snap({ placeName: '강남역 3번 출구' }), snap({ placeName: '강남역 5번 출구' }));
    assert.equal(describeChanges([a, b], TZ), '주최자가 약속을 바꿨어요: 강남역 2번 출구 곱창 → 강남역 5번 출구');
    const back = change(3, snap({ placeName: '강남역 3번 출구' }), snap());
    assert.equal(describeChanges([a, back], TZ), '');
    assert.equal(describeChanges([], TZ), '');
  });

  it('날짜가 바뀌면 날짜까지, 핀만 옮기면 "핀 위치가 바뀌었어요", 정책 항목은 각각 한 조각', () => {
    const nextDay = change(2, snap(), snap({ meetAtMs: MEET + 24 * 60 * MIN }));
    assert.match(describeChanges([nextDay], TZ), /9월 25일 .* → 9월 26일 /);
    const pin = change(2, snap(), snap({ placeLat: 37.5 }));
    assert.deepEqual(changeParts(pin.before, pin.after, TZ), ['핀 위치가 바뀌었어요']);
    const policy = change(2, snap(), snap({ policy: { ...presetPolicy('normal'), radiusM: 200, graceMinutes: 5, unitMinutes: 1 } }));
    assert.deepEqual(changeParts(policy.before, policy.after, TZ), [
      '지각 5분마다 10P → 1분마다 10P',
      '봐주는 시간 0분 → 5분',
      '도착 인정 100m → 200m',
    ]);
  });
});
