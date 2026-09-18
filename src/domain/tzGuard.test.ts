import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatFromNow,
  formatKoreanDate,
  formatKoreanDateTime,
  formatKoreanTime,
  isInKorea,
  isKnownTz,
  isSameLocalDay,
  isTzSuspect,
  msToLocalAt,
  needsTzChoice,
  TZ_CHOICES,
  tzChoices,
  tzLabel,
  tzOffsetMinutes,
  wallClockToMs,
} from './tzGuard';

const MIN = 60_000;
const HOUR = 60 * MIN;
const MEET = Date.UTC(2026, 8, 25, 10, 30); // 2026-09-25 (금) 19:30 KST

const SEOUL = { lat: 37.4979, lng: 127.0276 };
const JEJU = { lat: 33.4996, lng: 126.5312 };
const TOKYO = { lat: 35.6812, lng: 139.7671 };
const BANGKOK = { lat: 13.7563, lng: 100.5018 };
const TAIPEI = { lat: 25.033, lng: 121.5654 };

describe('isInKorea', () => {
  it('서울·제주는 안, 도쿄·방콕·타이베이는 밖', () => {
    assert.ok(isInKorea(SEOUL.lat, SEOUL.lng));
    assert.ok(isInKorea(JEJU.lat, JEJU.lng));
    for (const p of [TOKYO, BANGKOK, TAIPEI]) assert.equal(isInKorea(p.lat, p.lng), false);
  });

  it('경계(위도 33~39, 경도 124~132)는 포함', () => {
    assert.ok(isInKorea(33, 124));
    assert.ok(isInKorea(39, 132));
    assert.equal(isInKorea(32.999, 127), false);
    assert.equal(isInKorea(39.001, 127), false);
    assert.equal(isInKorea(37, 123.999), false);
    assert.equal(isInKorea(37, 132.001), false);
  });

  it('쓰레기 좌표는 밖', () => {
    assert.equal(isInKorea(Number.NaN, 127), false);
    assert.equal(isInKorea(37, Number.POSITIVE_INFINITY), false);
  });
});

describe('needsTzChoice', () => {
  it('기기가 서울이고 핀도 한국이면 시트가 필요 없다', () => {
    assert.equal(needsTzChoice('Asia/Seoul', SEOUL.lat, SEOUL.lng), false);
  });

  it('기기가 서울인데 핀이 한국 밖이면 시트', () => {
    assert.equal(needsTzChoice('Asia/Seoul', TAIPEI.lat, TAIPEI.lng), true);
    assert.equal(needsTzChoice('Asia/Seoul', TOKYO.lat, TOKYO.lng), true);
  });

  it('기기가 서울이 아니면 핀과 무관하게 시트', () => {
    assert.equal(needsTzChoice('Asia/Bangkok', SEOUL.lat, SEOUL.lng), true);
    assert.equal(needsTzChoice('Asia/Tokyo', null, null), true);
  });

  it('핀을 아직 안 정했으면 핀 조건은 건너뛴다, 기기 tz 를 모르면 한국으로 본다', () => {
    assert.equal(needsTzChoice('Asia/Seoul', null, undefined), false);
    assert.equal(needsTzChoice('', SEOUL.lat, SEOUL.lng), false);
    assert.equal(needsTzChoice(undefined, BANGKOK.lat, BANGKOK.lng), true);
  });
});

describe('TZ_CHOICES · tzLabel', () => {
  it('약 15개, 한국이 맨 앞, 중복 없음, 전부 Intl 이 아는 시간대', () => {
    assert.ok(TZ_CHOICES.length >= 14 && TZ_CHOICES.length <= 17, `${TZ_CHOICES.length}`);
    assert.equal(TZ_CHOICES[0].tz, 'Asia/Seoul');
    assert.equal(new Set(TZ_CHOICES.map((c) => c.tz)).size, TZ_CHOICES.length);
    for (const c of TZ_CHOICES) {
      assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: c.tz }), c.tz);
    }
  });

  it('고정 오프셋 표는 1월(표준시)의 Intl 오프셋과 같다', () => {
    const jan = Date.UTC(2026, 0, 15, 12);
    const jul = Date.UTC(2026, 6, 15, 12);
    for (const c of TZ_CHOICES) {
      // 남반구(시드니)는 7월이 표준시
      const at = c.tz === 'Australia/Sydney' ? jul : jan;
      assert.equal(tzOffsetMinutes(at, c.tz), c.standardOffsetMinutes, c.tz);
    }
  });

  it('라벨', () => {
    assert.equal(tzLabel('Asia/Seoul'), '한국 시각');
    assert.equal(tzLabel('Asia/Bangkok'), '방콕 시각');
    assert.equal(tzLabel('America/Sao_Paulo'), 'Sao Paulo 시각');
    assert.equal(tzLabel(''), '한국 시각');
    assert.equal(tzLabel(null), '한국 시각');
  });

  it('기기 tz 가 목록에 없으면 한국 바로 다음에 넣는다', () => {
    assert.equal(tzChoices('Asia/Seoul').length, TZ_CHOICES.length);
    assert.equal(tzChoices(null).length, TZ_CHOICES.length);
    const list = tzChoices('Europe/Berlin');
    assert.equal(list.length, TZ_CHOICES.length + 1);
    assert.equal(list[0].tz, 'Asia/Seoul');
    assert.equal(list[1].tz, 'Europe/Berlin');
    assert.equal(list[1].label, 'Berlin 시각');
  });
});

describe('tzOffsetMinutes · 벽시계 변환', () => {
  it('서울 +540, 방콕 +420, 뉴욕은 서머타임에 따라', () => {
    assert.equal(tzOffsetMinutes(MEET, 'Asia/Seoul'), 540);
    assert.equal(tzOffsetMinutes(MEET, 'Asia/Bangkok'), 420);
    assert.equal(tzOffsetMinutes(Date.UTC(2026, 6, 1), 'America/New_York'), -240);
    assert.equal(tzOffsetMinutes(Date.UTC(2026, 0, 1), 'America/New_York'), -300);
  });

  it('모르는 시간대·쓰레기 시각은 null', () => {
    assert.equal(tzOffsetMinutes(MEET, 'Mars/Olympus'), null);
    assert.equal(tzOffsetMinutes(MEET, 'not a tz'), null);
    assert.equal(tzOffsetMinutes(Number.NaN, 'Asia/Seoul'), null);
    assert.equal(isKnownTz('Mars/Olympus'), false);
    assert.equal(isKnownTz('Asia/Seoul'), true);
  });

  it('벽시계 + 시간대 → 절대 시각', () => {
    assert.equal(wallClockToMs('2026-09-25T19:30', 'Asia/Seoul'), MEET);
    assert.equal(wallClockToMs('2026-09-25T17:30', 'Asia/Bangkok'), MEET);
    assert.equal(wallClockToMs('2026-09-25T06:30', 'America/New_York'), MEET);
    assert.equal(wallClockToMs('2026-01-01T00:00', 'Asia/Seoul'), Date.UTC(2025, 11, 31, 15, 0));
  });

  it('형식 오류·없는 날짜·모르는 시간대는 null', () => {
    for (const bad of ['2026-09-25 19:30', '2026-02-30T10:00', '2026-13-01T10:00', '2026-09-25T24:00', '2026-09-25T10:60', '']) {
      assert.equal(wallClockToMs(bad, 'Asia/Seoul'), null, bad);
    }
    assert.equal(wallClockToMs('2026-09-25T19:30', 'Mars/Olympus'), null);
  });

  it('서머타임으로 없는 시각은 전환 뒤로 민다(02:30 → 03:30)', () => {
    // 2026-03-08 02:00 뉴욕: 02:00~03:00 이 없다
    const ms = wallClockToMs('2026-03-08T02:30', 'America/New_York') as number;
    assert.equal(msToLocalAt(ms, 'America/New_York'), '2026-03-08T03:30');
  });

  it('왕복: ms → 벽시계 → ms', () => {
    for (const tz of ['Asia/Seoul', 'Asia/Bangkok', 'America/Los_Angeles', 'Europe/Paris', 'Australia/Sydney']) {
      for (const at of [MEET, Date.UTC(2026, 0, 1, 0, 0), Date.UTC(2026, 5, 30, 23, 59)]) {
        assert.equal(wallClockToMs(msToLocalAt(at, tz), tz), at, `${tz} ${at}`);
      }
    }
  });
});

describe('한국어 시각 표시', () => {
  it('시간대의 벽시계로 적는다', () => {
    assert.equal(formatKoreanTime(MEET, 'Asia/Seoul'), '오후 7:30');
    assert.equal(formatKoreanTime(MEET, 'Asia/Bangkok'), '오후 5:30');
    assert.equal(formatKoreanDate(MEET, 'Asia/Seoul'), '9월 25일 (금)');
    assert.equal(formatKoreanDateTime(MEET, 'Asia/Seoul'), '9월 25일 (금) 오후 7:30');
  });

  it('자정·정오·날짜 넘김', () => {
    assert.equal(formatKoreanTime(Date.UTC(2026, 8, 25, 15, 0), 'Asia/Seoul'), '오전 12:00');
    assert.equal(formatKoreanTime(Date.UTC(2026, 8, 25, 3, 5), 'Asia/Seoul'), '오후 12:05');
    // UTC 로는 25일이지만 서울은 26일 (토)
    assert.equal(formatKoreanDate(Date.UTC(2026, 8, 25, 16, 0), 'Asia/Seoul'), '9월 26일 (토)');
  });

  it('모르는 시간대는 한국 시각으로, 쓰레기 시각은 빈 문자열', () => {
    assert.equal(formatKoreanTime(MEET, 'Mars/Olympus'), '오후 7:30');
    assert.equal(formatKoreanDateTime(Number.NaN, 'Asia/Seoul'), '');
    assert.equal(msToLocalAt(Number.POSITIVE_INFINITY, 'Asia/Seoul'), '');
  });

  it('같은 날 판정은 시간대 기준', () => {
    const lateNight = Date.UTC(2026, 8, 25, 14, 59); // 서울 23:59
    const nextDay = Date.UTC(2026, 8, 25, 15, 0); // 서울 26일 00:00
    assert.equal(isSameLocalDay(MEET, lateNight, 'Asia/Seoul'), true);
    assert.equal(isSameLocalDay(MEET, nextDay, 'Asia/Seoul'), false);
    assert.equal(isSameLocalDay(MEET, nextDay, 'Asia/Bangkok'), true);
  });
});

describe('formatFromNow', () => {
  it('남은 시간', () => {
    assert.equal(formatFromNow(2 * HOUR + 10 * MIN), '2시간 10분 뒤');
    assert.equal(formatFromNow(2 * HOUR), '2시간 뒤');
    assert.equal(formatFromNow(35 * MIN + 59_000), '35분 뒤');
    assert.equal(formatFromNow(30_000), '곧');
    assert.equal(formatFromNow(28 * HOUR), '1일 4시간 뒤');
    assert.equal(formatFromNow(24 * HOUR), '1일 뒤');
    assert.equal(formatFromNow(3 * 24 * HOUR + 5 * HOUR), '3일 뒤');
  });

  it('지난 시간', () => {
    assert.equal(formatFromNow(-12 * MIN), '12분 지남');
    assert.equal(formatFromNow(-10_000), '방금 지남');
    assert.equal(formatFromNow(Number.NaN), '');
  });
});

describe('isTzSuspect (서버 LB_TZ_SUSPECT 와 같은 식)', () => {
  it('서울 시간대 + 서울 핀은 정상', () => {
    assert.equal(isTzSuspect('Asia/Seoul', SEOUL.lng, MEET), false);
  });

  it('서울 시간대 + 방콕 핀은 의심 (9 − 6.7 = 2.3시간)', () => {
    assert.equal(isTzSuspect('Asia/Seoul', BANGKOK.lng, MEET), true);
    assert.equal(isTzSuspect('Asia/Bangkok', BANGKOK.lng, MEET), false);
  });

  it('1시간 차(타이베이)는 경도로 못 잡는다 — 그래서 needsTzChoice 가 따로 있다', () => {
    assert.equal(isTzSuspect('Asia/Seoul', TAIPEI.lng, MEET), false);
    assert.equal(needsTzChoice('Asia/Seoul', TAIPEI.lat, TAIPEI.lng), true);
  });

  it('모르는 시간대·쓰레기 경도는 확인을 받는 쪽으로', () => {
    assert.equal(isTzSuspect('Mars/Olympus', 127, MEET), true);
    assert.equal(isTzSuspect('Asia/Seoul', Number.NaN, MEET), true);
  });
});
