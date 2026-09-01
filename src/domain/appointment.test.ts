import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appointmentStatus,
  buildLocalAt,
  compareByAppointment,
  formatAppointmentTime,
  formatCountdown,
  hasAppointment,
  mapSearchUrl,
  normalizeAppointment,
  parseAppointmentInput,
  toLocalInputValue,
} from './appointment';
import type { Session } from './types';

const pad = (n: number) => `${n}`.padStart(2, '0');

/** 저장 형식 = 타임존 없는 벽시계 문자열 */
const wall = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`;

/** 예전 저장 형식 = 절대 시각 ISO */
const legacyIso = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).toISOString();

/** 기기 타임존을 바꿔놓고 실행 (끝나면 원복) */
function withTz<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

function session(id: string, at: string | null, createdAt = '2026-01-01'): Session {
  return {
    id,
    title: id,
    createdAt,
    people: [],
    rounds: [],
    settings: { roundingUnit: 100, baseCurrency: 'KRW' },
    appointment: { at, place: '', placeNote: '' },
  };
}

describe('normalizeAppointment', () => {
  it('없거나 깨진 값은 빈 약속으로', () => {
    assert.deepEqual(normalizeAppointment(null), { at: null, place: '', placeNote: '' });
    assert.deepEqual(normalizeAppointment('nope'), { at: null, place: '', placeNote: '' });
    assert.equal(normalizeAppointment({ at: 'not-a-date' }).at, null);
  });

  it('정상 값은 유지', () => {
    const at = wall(2026, 8, 3, 19, 30);
    const a = normalizeAppointment({ at, place: '곱창집', placeNote: '2번 출구' });
    assert.equal(a.at, at);
    assert.equal(a.place, '곱창집');
    assert.equal(a.placeNote, '2번 출구');
  });

  it('예전 절대 시각 ISO는 그 기기의 벽시계 문자열로 옮겨 적는다', () => {
    // 서울에서 저장된 예전 데이터(절대 시각)를 서울에서 읽으면 19:30 그대로
    const saved = withTz('Asia/Seoul', () => legacyIso(2026, 8, 3, 19, 30));
    assert.equal(
      withTz('Asia/Seoul', () => normalizeAppointment({ at: saved }).at),
      '2026-08-03T19:30',
    );
  });
});

describe('hasAppointment', () => {
  it('시간이나 장소 중 하나만 있어도 true', () => {
    assert.equal(hasAppointment(null), false);
    assert.equal(hasAppointment({ at: null, place: '', placeNote: '메모' }), false);
    assert.equal(hasAppointment({ at: null, place: '곱창집', placeNote: '' }), true);
    assert.equal(hasAppointment({ at: wall(2026, 8, 3), place: '', placeNote: '' }), true);
  });
});

describe('appointmentStatus', () => {
  const now = new Date(2026, 7, 3, 12, 0).getTime(); // 8/3 정오

  it('같은 날 미래는 today', () => {
    assert.equal(
      appointmentStatus({ at: wall(2026, 8, 3, 19, 0), place: '', placeNote: '' }, now),
      'today',
    );
  });

  it('다른 날 미래는 upcoming, 지난 건 past', () => {
    assert.equal(
      appointmentStatus({ at: wall(2026, 8, 5, 19, 0), place: '', placeNote: '' }, now),
      'upcoming',
    );
    assert.equal(
      appointmentStatus({ at: wall(2026, 8, 3, 9, 0), place: '', placeNote: '' }, now),
      'past',
    );
  });

  it('시간이 없으면 none', () => {
    assert.equal(appointmentStatus({ at: null, place: '곱창집', placeNote: '' }, now), 'none');
  });
});

describe('formatAppointmentTime', () => {
  it('요일과 오전/오후를 붙인다', () => {
    // 2026-08-03은 월요일
    assert.equal(formatAppointmentTime(wall(2026, 8, 3, 19, 30)), '8월 3일 (월) 오후 7:30');
    assert.equal(formatAppointmentTime(wall(2026, 8, 3, 9, 5)), '8월 3일 (월) 오전 9:05');
    // 정오·자정 경계
    assert.equal(formatAppointmentTime(wall(2026, 8, 3, 12, 0)), '8월 3일 (월) 오후 12:00');
    assert.equal(formatAppointmentTime(wall(2026, 8, 3, 0, 0)), '8월 3일 (월) 오전 12:00');
  });

  it('없거나 깨진 값은 빈 문자열', () => {
    assert.equal(formatAppointmentTime(null), '');
    assert.equal(formatAppointmentTime('nope'), '');
  });
});

describe('formatCountdown', () => {
  const now = new Date(2026, 7, 3, 12, 0).getTime();

  it('오늘·내일·N일 뒤', () => {
    assert.equal(formatCountdown(wall(2026, 8, 3, 19, 0), now), '7시간 뒤');
    assert.equal(formatCountdown(wall(2026, 8, 3, 12, 30), now), '30분 뒤');
    assert.equal(formatCountdown(wall(2026, 8, 4, 19, 0), now), '내일');
    assert.equal(formatCountdown(wall(2026, 8, 6, 19, 0), now), '3일 뒤');
  });

  it('지난 약속', () => {
    assert.equal(formatCountdown(wall(2026, 8, 3, 9, 0), now), '오늘 (지남)');
    assert.equal(formatCountdown(wall(2026, 8, 2, 19, 0), now), '어제');
    assert.equal(formatCountdown(wall(2026, 7, 31, 19, 0), now), '3일 전');
  });
});

describe('compareByAppointment', () => {
  const now = new Date(2026, 7, 3, 12, 0).getTime();

  it('다가오는 약속 → 시간 없음 → 지난 약속 순', () => {
    const soon = session('soon', wall(2026, 8, 3, 19, 0));
    const later = session('later', wall(2026, 8, 10, 19, 0));
    const none = session('none', null);
    const past = session('past', wall(2026, 8, 1, 19, 0));
    const sorted = [past, none, later, soon]
      .sort((a, b) => compareByAppointment(a, b, now))
      .map((s) => s.id);
    assert.deepEqual(sorted, ['soon', 'later', 'none', 'past']);
  });

  it('지난 약속끼리는 최근에 지난 순', () => {
    const old = session('old', wall(2026, 7, 20, 19, 0));
    const recent = session('recent', wall(2026, 8, 2, 19, 0));
    const sorted = [old, recent]
      .sort((a, b) => compareByAppointment(a, b, now))
      .map((s) => s.id);
    assert.deepEqual(sorted, ['recent', 'old']);
  });

  it('시간 없는 것끼리는 최근 생성 순', () => {
    const older = session('older', null, '2026-01-01');
    const newer = session('newer', null, '2026-06-01');
    const sorted = [older, newer]
      .sort((a, b) => compareByAppointment(a, b, now))
      .map((s) => s.id);
    assert.deepEqual(sorted, ['newer', 'older']);
  });
});

describe('buildLocalAt / toLocalInputValue', () => {
  it('왕복 변환', () => {
    const at = buildLocalAt(2026, 8, 3, 19, 30);
    assert.equal(at, '2026-08-03T19:30');
    assert.equal(toLocalInputValue(at), '2026-08-03T19:30');
  });

  it('존재하지 않는 날짜는 null', () => {
    assert.equal(buildLocalAt(2026, 2, 31, 12, 0), null);
    assert.equal(buildLocalAt(2026, 13, 1, 12, 0), null);
  });

  it('시·분 범위를 벗어나면 null (19:99가 20:39로 굴러가면 안 된다)', () => {
    assert.equal(buildLocalAt(2026, 8, 3, 19, 99), null);
    assert.equal(buildLocalAt(2026, 8, 3, 19, 60), null);
    assert.equal(buildLocalAt(2026, 8, 3, 22, 99), null);
    assert.equal(buildLocalAt(2026, 8, 3, 24, 0), null);
    assert.equal(buildLocalAt(2026, 8, 3, 25, 0), null);
    assert.equal(buildLocalAt(2026, 8, 3, -1, 0), null);
    // 경계는 통과
    assert.equal(buildLocalAt(2026, 8, 3, 23, 59), '2026-08-03T23:59');
    assert.equal(buildLocalAt(2026, 8, 3, 0, 0), '2026-08-03T00:00');
  });

  it('없는 값은 빈 문자열', () => {
    assert.equal(toLocalInputValue(null), '');
  });
});

describe('parseAppointmentInput', () => {
  it('둘 다 비었으면 empty (시간 미정으로 저장해도 되는 상태)', () => {
    assert.deepEqual(parseAppointmentInput('', ''), { status: 'empty', at: null });
    assert.deepEqual(parseAppointmentInput('  ', ' '), { status: 'empty', at: null });
  });

  it('한쪽만 적었으면 incomplete — 적어둔 값을 조용히 버리지 않는다', () => {
    assert.deepEqual(parseAppointmentInput('2026-08-03', ''), {
      status: 'incomplete',
      at: null,
    });
    assert.deepEqual(parseAppointmentInput('', '19:30'), {
      status: 'incomplete',
      at: null,
    });
  });

  it('형식·범위가 틀리면 invalid', () => {
    assert.equal(parseAppointmentInput('2026-02-31', '19:30').status, 'invalid');
    assert.equal(parseAppointmentInput('2026-08-03', '19:99').status, 'invalid');
    assert.equal(parseAppointmentInput('2026-08-03', '25:00').status, 'invalid');
    assert.equal(parseAppointmentInput('8/3', '19:30').status, 'invalid');
    assert.equal(parseAppointmentInput('2026-08-03', '오후 7시').status, 'invalid');
  });

  it('둘 다 맞으면 ok + 벽시계 문자열', () => {
    assert.deepEqual(parseAppointmentInput('2026-08-03', '19:30'), {
      status: 'ok',
      at: '2026-08-03T19:30',
    });
    // 한 자리 월·일·시도 받아준다
    assert.deepEqual(parseAppointmentInput('2026-8-3', '9:05'), {
      status: 'ok',
      at: '2026-08-03T09:05',
    });
  });
});

describe('기기 타임존이 바뀌어도 약속 벽시계는 그대로', () => {
  it('서울에서 잡은 19:30은 방콕에서도 19:30', () => {
    const at = withTz('Asia/Seoul', () => buildLocalAt(2026, 8, 3, 19, 30));
    assert.equal(at, '2026-08-03T19:30');

    const seoul = withTz('Asia/Seoul', () => formatAppointmentTime(at));
    const bangkok = withTz('Asia/Bangkok', () => formatAppointmentTime(at));
    const honolulu = withTz('Pacific/Honolulu', () => formatAppointmentTime(at));
    assert.equal(seoul, '8월 3일 (월) 오후 7:30');
    assert.equal(bangkok, seoul);
    assert.equal(honolulu, seoul);

    // 편집기에 다시 채워 넣는 값도 그대로여야 왕복 저장이 시각을 밀지 않는다
    assert.equal(
      withTz('Asia/Bangkok', () => toLocalInputValue(at)),
      '2026-08-03T19:30',
    );
  });

  it('당일 카운트다운·지남 판정도 현지 시계 기준', () => {
    const at = wall(2026, 8, 3, 19, 30);
    const appointment = { at, place: '', placeNote: '' };
    // 두 도시 각각의 '그 지역 18:00'에서 본다
    const check = (tz: string) =>
      withTz(tz, () => {
        const now = new Date(2026, 7, 3, 18, 0).getTime();
        return {
          status: appointmentStatus(appointment, now),
          label: formatCountdown(at, now),
        };
      });
    assert.deepEqual(check('Asia/Seoul'), { status: 'today', label: '2시간 뒤' });
    assert.deepEqual(check('Asia/Bangkok'), { status: 'today', label: '2시간 뒤' });
  });
});

describe('mapSearchUrl', () => {
  it('장소 이름으로 지도 검색 URL을 만든다', () => {
    assert.equal(
      mapSearchUrl('강남역 곱창'),
      'https://map.kakao.com/?q=%EA%B0%95%EB%82%A8%EC%97%AD%20%EA%B3%B1%EC%B0%BD',
    );
    assert.ok(mapSearchUrl('강남역', 'naver')?.startsWith('https://map.naver.com/p/search/'));
  });

  it('빈 장소는 null', () => {
    assert.equal(mapSearchUrl('   '), null);
  });
});
