import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { presetPolicy } from '../domain/latePresets';
import { msToLocalAt } from '../domain/tzGuard';
import { FakeServer } from './fakeApi';
import { getSeenVersion, resetSeenVersionsForTest, seedSeenVersion, setSeenVersion, unseenChanges } from './seenVersions';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 25, 3, 0, 0);
const TZ = 'Asia/Seoul';

describe('seenVersions — 참여 직후 동의한 version 이 첫 getLive 응답에 덮이지 않는다', () => {
  beforeEach(() => resetSeenVersionsForTest());

  it('setSeenVersion 뒤의 seedSeenVersion 은 덮지 않고, 기록이 없으면 심는다', () => {
    assert.equal(getSeenVersion('a'), null);
    assert.equal(seedSeenVersion('a', 3), 3);
    assert.equal(seedSeenVersion('a', 5), 3);
    setSeenVersion('a', 5);
    assert.equal(getSeenVersion('a'), 5);
    setSeenVersion('', 9);
    setSeenVersion('b', Number.NaN);
    assert.equal(getSeenVersion('b'), null);
  });

  it('unseenChanges: 본 version 뒤의 것만, 주최자·기록 없음은 []', () => {
    const c = (version: number) => ({ version, atMs: 0, before: {} as never, after: {} as never });
    assert.deepEqual(unseenChanges([c(2), c(3)], 1, false).map((x) => x.version), [2, 3]);
    assert.deepEqual(unseenChanges([c(2), c(3)], 2, false).map((x) => x.version), [3]);
    assert.deepEqual(unseenChanges([c(2), c(3)], 1, true), []);
    assert.deepEqual(unseenChanges([c(2), c(3)], null, false), []);
  });

  it('게스트가 version 1 로 참여한 뒤 첫 getLive 전에 주최자가 시간·걸 포인트를 바꾸면 배너 2건이 뜬다(가짜 서버)', () => {
    const clock = { t: T0 };
    const server = new FakeServer({ now: () => clock.t, random: () => 0.5 });
    server.ensureProfile('host', '지수');
    server.ensureProfile('guest', '민병희');
    const a = server.createAppointment('host', {
      title: '금요일 곱창',
      localAt: msToLocalAt(T0 + 180 * MIN, TZ),
      tz: TZ,
      placeName: '강남역 2번 출구 곱창',
      placeNote: '',
      lat: 37.49808,
      lng: 127.02761,
      policy: presetPolicy('normal'),
      invitees: ['민병희'],
      consent: true,
    });
    const preview = server.peekInvite('guest', a.inviteCode);
    server.claimSlot('guest', a.id, '민병희', preview.version, true);
    // 참여 화면: 동의한 version 을 먼저 심는다
    setSeenVersion(a.id, preview.version);

    // 그 사이 주최자가 두 번 바꾼다(걸 포인트 인상 → 차액 자동 hold, 30분 미루기)
    const up = server.edit('host', a.id, { policy: { ...a.policy, stake: 300 } }, a.version);
    server.edit('host', a.id, { localAt: msToLocalAt(a.meetAtMs + 30 * MIN, TZ) }, up.version);

    // 게스트의 첫 getLive: seed 는 덮지 않는다 → 두 변경이 전부 unseen
    const live = server.getLive('guest', a.id);
    const seen = seedSeenVersion(a.id, live.appointment.version);
    assert.equal(seen, 1);
    const unseen = unseenChanges(live.appointment.changes, seen, live.appointment.hostId === live.myUserId);
    assert.deepEqual(unseen.map((c) => c.version), [2, 3]);
    assert.equal(live.myBalance, 700); // 차액 200P 가 걸렸으니 배너로 알려야 한다

    // 대조: 심지 않았다면 첫 응답 version(3)이 기준이 되어 배너가 없다(옛 결함)
    resetSeenVersionsForTest();
    assert.deepEqual(unseenChanges(live.appointment.changes, seedSeenVersion(a.id, live.appointment.version), false), []);
  });
});
