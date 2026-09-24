import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyPickedPlace,
  appointmentDirectionsUrl,
  appointmentPlaceLabel,
  appointmentPoint,
  appointmentStatus,
  buildAppointment,
  buildLocalAt,
  editPlaceName,
  EMPTY_PLACE_FORM,
  pinAfterTextOnlyEdit,
  placeFormFromAppointment,
  PINNED_PLACE_FALLBACK_NAME,
  compareByAppointment,
  formatAppointmentTime,
  formatCountdown,
  hasAppointment,
  mapSearchUrl,
  normalizeAppointment,
  parseAppointmentInput,
  toLocalInputValue,
} from './appointment';
import { mapRouteUrl } from './mapRoute';
import type { Appointment, Session } from './types';

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

// ───────────────────────── 지도 핀 (2026-09-24: 모임 약속 장소도 지도로) ─────────────────────────

const GANGNAM = { lat: 37.4979, lng: 127.0276 };
/** 강남역에서 북쪽으로 약 55m (위도 0.0005도) */
const GANGNAM_NEAR = { lat: 37.4984, lng: 127.0276 };
/** 강남역에서 약 3km 떨어진 곳 */
const FAR = { lat: 37.5249, lng: 127.0276 };

const appt = (over: Partial<Appointment> = {}): Appointment => ({ at: null, place: '', placeNote: '', ...over });

describe('normalizeAppointment · 핀 좌표', () => {
  it('유효한 위도·경도 한 쌍은 그대로 싣는다', () => {
    const a = normalizeAppointment({ place: '강남역', placeLat: GANGNAM.lat, placeLng: GANGNAM.lng });
    assert.equal(a.placeLat, GANGNAM.lat);
    assert.equal(a.placeLng, GANGNAM.lng);
    assert.deepEqual(appointmentPoint(a), GANGNAM);
  });

  it('옛 데이터(좌표 필드 없음)는 핀 없음 — 모양도 예전 그대로', () => {
    const a = normalizeAppointment({ at: null, place: '곱창집', placeNote: '' });
    assert.deepEqual(a, { at: null, place: '곱창집', placeNote: '' });
    assert.equal(appointmentPoint(a), null);
  });

  it('쓰레기 좌표(범위 밖·NaN·문자열·한쪽만·null)는 버린다', () => {
    const cases: unknown[] = [
      { placeLat: 91, placeLng: 127 },
      { placeLat: 37.5, placeLng: 181 },
      { placeLat: Number.NaN, placeLng: 127 },
      { placeLat: Number.POSITIVE_INFINITY, placeLng: 127 },
      { placeLat: '37.5', placeLng: '127' },
      { placeLat: 37.5 },
      { placeLat: null, placeLng: null },
    ];
    for (const raw of cases) {
      const a = normalizeAppointment({ place: 'x', ...(raw as object) });
      assert.equal(a.placeLat ?? null, null, JSON.stringify(raw));
      assert.equal(a.placeLng ?? null, null, JSON.stringify(raw));
      assert.equal(appointmentPoint(a), null);
    }
  });

  it('저장 → 읽기 왕복에서 핀이 살아남는다', () => {
    const saved = buildAppointment({ at: wall(2026, 9, 25, 19, 30), placeName: ' 강남역 ', pin: GANGNAM });
    const read = normalizeAppointment(JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(read, { at: '2026-09-25T19:30', place: '강남역', placeNote: '', placeLat: GANGNAM.lat, placeLng: GANGNAM.lng });
  });

  it('핀을 지우고 저장하면(null) 읽을 때 핀 없음', () => {
    const saved = buildAppointment({ at: null, placeName: '강남역', pin: null });
    assert.equal(saved.placeLat, null);
    assert.equal(saved.placeLng, null);
    assert.equal(appointmentPoint(normalizeAppointment(JSON.parse(JSON.stringify(saved)))), null);
  });
});

describe('appointmentPlaceLabel · hasAppointment (핀만 있는 장소)', () => {
  it('이름이 있으면 이름', () => {
    assert.equal(appointmentPlaceLabel(appt({ place: ' 곱창집 ', placeLat: 37.5, placeLng: 127 })), '곱창집');
  });

  it('이름 없이 핀만 있으면 "지도에서 정한 장소", 그래서 약속이 있는 것으로 본다', () => {
    const a = appt({ placeLat: 37.5, placeLng: 127 });
    assert.equal(appointmentPlaceLabel(a), PINNED_PLACE_FALLBACK_NAME);
    assert.equal(hasAppointment(a), true);
  });

  it('둘 다 없으면 빈 문자열', () => {
    assert.equal(appointmentPlaceLabel(appt()), '');
    assert.equal(appointmentPlaceLabel(null), '');
    assert.equal(hasAppointment(appt({ placeLat: 999, placeLng: 127 })), false);
  });
});

describe('appointmentDirectionsUrl (길찾기)', () => {
  it('핀이 있으면 좌표 길찾기(카카오맵 link/to)', () => {
    const a = appt({ place: '강남역', placeLat: GANGNAM.lat, placeLng: GANGNAM.lng });
    assert.equal(appointmentDirectionsUrl(a), mapRouteUrl('강남역', GANGNAM.lat, GANGNAM.lng));
    assert.ok(appointmentDirectionsUrl(a)?.startsWith('https://map.kakao.com/link/to/'));
  });

  it('핀만 있고 이름이 없어도 좌표 길찾기("약속 장소")', () => {
    const url = appointmentDirectionsUrl(appt({ placeLat: GANGNAM.lat, placeLng: GANGNAM.lng }));
    assert.equal(url, mapRouteUrl('', GANGNAM.lat, GANGNAM.lng));
    assert.ok(url?.includes(encodeURIComponent('약속 장소')));
  });

  it('핀이 없으면 예전처럼 이름 검색, 이름도 없으면 null', () => {
    assert.equal(appointmentDirectionsUrl(appt({ place: '강남역 곱창' })), mapSearchUrl('강남역 곱창'));
    assert.equal(appointmentDirectionsUrl(appt({ place: '강남역', placeLat: Number.NaN, placeLng: 127 })), mapSearchUrl('강남역'));
    assert.equal(appointmentDirectionsUrl(appt()), null);
    assert.equal(appointmentDirectionsUrl(null), null);
  });
});

describe('applyPickedPlace (지도에서 돌아왔을 때 이름 채우기)', () => {
  it('처음 정할 때: 검색 결과·주소 이름으로 채운다', () => {
    const s = applyPickedPlace(EMPTY_PLACE_FORM, { ...GANGNAM, name: '  강남역  2호선 ', nameSource: 'search' });
    assert.deepEqual(s, { name: '강남역 2호선', pin: GANGNAM, nameEdited: false });
    const t = applyPickedPlace(EMPTY_PLACE_FORM, { ...GANGNAM, name: '서울 강남구 역삼동 858', nameSource: 'address' });
    assert.equal(t.name, '서울 강남구 역삼동 858');
  });

  it('이름을 못 얻으면(none) 이름은 비고 핀만', () => {
    assert.deepEqual(applyPickedPlace(EMPTY_PLACE_FORM, { ...GANGNAM, nameSource: 'none' }), {
      name: '',
      pin: GANGNAM,
      nameEdited: false,
    });
    // nameSource 가 none 이면 name 이 실려 와도 쓰지 않는다
    assert.equal(applyPickedPlace(EMPTY_PLACE_FORM, { ...GANGNAM, name: '무시', nameSource: 'none' }).name, '');
  });

  it('사람이 고친 이름은 같은 장소(100m 안)에서 핀을 다듬어도 지킨다', () => {
    const edited = editPlaceName(applyPickedPlace(EMPTY_PLACE_FORM, { ...GANGNAM, name: '강남역', nameSource: 'search' }), '우리 아지트');
    const s = applyPickedPlace(edited, { ...GANGNAM_NEAR, name: '서울 강남구 어딘가', nameSource: 'address' });
    assert.deepEqual(s, { name: '우리 아지트', pin: GANGNAM_NEAR, nameEdited: true });
  });

  it('자동으로 채운 이름은 같은 장소에서 새 이름이 오면 바꾸고, 이름이 안 오면 둔다', () => {
    const auto = applyPickedPlace(EMPTY_PLACE_FORM, { ...GANGNAM, name: '강남역', nameSource: 'search' });
    assert.equal(applyPickedPlace(auto, { ...GANGNAM_NEAR, name: '강남역 11번 출구', nameSource: 'search' }).name, '강남역 11번 출구');
    assert.equal(applyPickedPlace(auto, { ...GANGNAM_NEAR, nameSource: 'none' }).name, '강남역');
  });

  it('먼 곳으로 옮기면 고친 이름도 새 결과로 바꾼다, 결과 이름이 없으면 비운다', () => {
    const edited = { name: '우리 아지트', pin: GANGNAM, nameEdited: true };
    assert.deepEqual(applyPickedPlace(edited, { ...FAR, name: '압구정역', nameSource: 'search' }), {
      name: '압구정역',
      pin: FAR,
      nameEdited: false,
    });
    assert.deepEqual(applyPickedPlace(edited, { ...FAR, nameSource: 'none' }), { name: '', pin: FAR, nameEdited: false });
  });

  it('핀 없이 이름만 있던 옛 약속: 결과 이름이 있으면 그걸로, 없으면 적어둔 이름 유지', () => {
    const legacy = placeFormFromAppointment(appt({ place: '강남역 곱창집' }));
    assert.deepEqual(legacy, { name: '강남역 곱창집', pin: null, nameEdited: true });
    assert.equal(applyPickedPlace(legacy, { ...GANGNAM, name: 'OO곱창 강남점', nameSource: 'search' }).name, 'OO곱창 강남점');
    assert.deepEqual(applyPickedPlace(legacy, { ...GANGNAM, nameSource: 'none' }), {
      name: '강남역 곱창집',
      pin: GANGNAM,
      nameEdited: true,
    });
  });

  it('폴백 이름 칸에서 확정한 이름(nameConfirmed)은 고친 이름·같은 장소 규칙보다 앞선다', () => {
    const edited = { name: '우리 아지트', pin: GANGNAM, nameEdited: true };
    // 같은 장소에서 다듬었어도 폴백 화면에서 적은 이름으로 바뀐다
    assert.deepEqual(applyPickedPlace(edited, { ...GANGNAM_NEAR, name: '강남 곱창 2층', nameSource: 'search', nameConfirmed: true }), {
      name: '강남 곱창 2층',
      pin: GANGNAM_NEAR,
      nameEdited: true,
    });
    // 이름 칸을 비우고 확정했으면 비운다
    assert.deepEqual(applyPickedPlace(edited, { ...GANGNAM_NEAR, nameSource: 'none', nameConfirmed: true }), {
      name: '',
      pin: GANGNAM_NEAR,
      nameEdited: false,
    });
  });

  it('쓰레기 좌표 결과는 무시한다', () => {
    const prev = { name: '강남역', pin: GANGNAM, nameEdited: false };
    assert.equal(applyPickedPlace(prev, { lat: Number.NaN, lng: 127, name: 'x' }), prev);
  });
});

describe('placeFormFromAppointment', () => {
  it('저장된 약속의 이름·핀을 입력 상태로', () => {
    assert.deepEqual(placeFormFromAppointment(appt({ place: '강남역', placeLat: GANGNAM.lat, placeLng: GANGNAM.lng })), {
      name: '강남역',
      pin: GANGNAM,
      nameEdited: true,
    });
    assert.deepEqual(placeFormFromAppointment(null), EMPTY_PLACE_FORM);
    assert.deepEqual(placeFormFromAppointment(appt({ placeLat: GANGNAM.lat, placeLng: GANGNAM.lng })), {
      name: '',
      pin: GANGNAM,
      nameEdited: false,
    });
  });
});

describe('pinAfterTextOnlyEdit (지도 없는 기기에서 이름만 고칠 때)', () => {
  const pinned = appt({ place: '강남역  곱창', placeLat: GANGNAM.lat, placeLng: GANGNAM.lng });

  it('이름이 그대로면(공백 차이 무시) 다른 기기에서 정한 핀을 지킨다', () => {
    assert.deepEqual(pinAfterTextOnlyEdit(pinned, ' 강남역 곱창 '), GANGNAM);
  });

  it('이름을 바꾸면 핀을 버린다 — 옛 핀으로 길찾기가 열리지 않게', () => {
    assert.equal(pinAfterTextOnlyEdit(pinned, '압구정 곱창'), null);
    assert.equal(pinAfterTextOnlyEdit(pinned, ''), null);
  });

  it('원래 핀이 없으면 null', () => {
    assert.equal(pinAfterTextOnlyEdit(appt({ place: '강남역' }), '강남역'), null);
    assert.equal(pinAfterTextOnlyEdit(null, '강남역'), null);
  });
});

describe('buildAppointment', () => {
  it('이름·메모를 다듬고, 쓰레기 핀은 null 로', () => {
    assert.deepEqual(buildAppointment({ at: null, placeName: ' 곱창 ', pin: { lat: 91, lng: 0 }, placeNote: ' 2번 출구 ' }), {
      at: null,
      place: '곱창',
      placeNote: '2번 출구',
      placeLat: null,
      placeLng: null,
    });
  });
});
