import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  dedupePlaces,
  formatPlaceDistance,
  fromGeocoded,
  hasKakaoKey,
  isUsablePoint,
  kakaoKeywordUrl,
  MAX_PLACE_RESULTS,
  normalizeQuery,
  parseKakaoDocuments,
  searchPlaces,
  type FetchLike,
  type GeocodedPoint,
  type PlaceSearchResult,
} from './placeSearch';

const GANGNAM = { lat: 37.49794, lng: 127.02762 };

interface Call {
  url: string;
  headers: Record<string, string>;
  hasSignal: boolean;
}

/** 요청 URL 에 따라 응답을 고르는 가짜 fetch */
function fakeFetch(respond: (url: string) => { ok?: boolean; status?: number; body?: unknown } | 'throw' | 'hang') {
  const calls: Call[] = [];
  const fn: FetchLike = (url, init) => {
    calls.push({ url, headers: init.headers, hasSignal: !!init.signal });
    const r = respond(url);
    if (r === 'throw') return Promise.reject(new Error('network down'));
    if (r === 'hang') {
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return Promise.resolve({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: () => Promise.resolve(r.body),
    });
  };
  return { fn, calls };
}

function fakeGeocoder(points: readonly GeocodedPoint[] | 'throw') {
  const queries: string[] = [];
  const fn = (q: string) => {
    queries.push(q);
    return points === 'throw' ? Promise.reject(new Error('Geocoder unavailable')) : Promise.resolve(points);
  };
  return { fn, queries };
}

const doc = (over: Record<string, unknown> = {}) => ({
  id: '8471235',
  place_name: '강남역 2호선',
  road_address_name: '서울 강남구 강남대로 396',
  address_name: '서울 강남구 역삼동 858',
  x: '127.02762',
  y: '37.49794',
  ...over,
});

const isNear = (url: string) => url.includes('sort=distance');

describe('normalizeQuery', () => {
  it('앞뒤·연속 공백을 정리하고 문자열이 아니면 빈 값', () => {
    assert.equal(normalizeQuery('  강남역   2번 출구 '), '강남역 2번 출구');
    assert.equal(normalizeQuery(''), '');
    assert.equal(normalizeQuery('   '), '');
    assert.equal(normalizeQuery(null), '');
    assert.equal(normalizeQuery(42), '');
  });

  it('100자로 자른다(서로게이트는 한 글자로 센다)', () => {
    assert.equal(Array.from(normalizeQuery('가'.repeat(150))).length, 100);
    assert.equal(Array.from(normalizeQuery('😀'.repeat(120))).length, 100);
  });
});

describe('isUsablePoint', () => {
  it('범위 안의 유한수만, (0,0)은 버린다', () => {
    assert.equal(isUsablePoint(GANGNAM), true);
    assert.equal(isUsablePoint({ lat: 0, lng: 0 }), false);
    assert.equal(isUsablePoint({ lat: 91, lng: 0 }), false);
    assert.equal(isUsablePoint({ lat: 37, lng: 181 }), false);
    assert.equal(isUsablePoint({ lat: Number.NaN, lng: 127 }), false);
    assert.equal(isUsablePoint(null), false);
    assert.equal(isUsablePoint({ lat: '37', lng: '127' }), false);
  });
});

describe('hasKakaoKey', () => {
  it('공백뿐인 키는 없는 것으로 본다', () => {
    assert.equal(hasKakaoKey('abc'), true);
    assert.equal(hasKakaoKey('  '), false);
    assert.equal(hasKakaoKey(''), false);
    assert.equal(hasKakaoKey(null), false);
  });
});

describe('kakaoKeywordUrl', () => {
  it('near 가 있으면 x=경도·y=위도·radius·거리순, 없으면 정확도순', () => {
    const near = kakaoKeywordUrl('강남역 곱창', GANGNAM);
    assert.ok(near.startsWith('https://dapi.kakao.com/v2/local/search/keyword.json?'));
    assert.ok(near.includes(`query=${encodeURIComponent('강남역 곱창')}`));
    assert.ok(near.includes('x=127.027620'));
    assert.ok(near.includes('y=37.497940'));
    assert.ok(near.includes('radius=20000'));
    assert.ok(near.includes('sort=distance'));

    const all = kakaoKeywordUrl('서울역', null);
    assert.ok(all.includes('sort=accuracy'));
    assert.ok(!all.includes('x='));
    assert.ok(!all.includes('radius='));
  });

  it('검색어의 &·# 같은 글자는 인코딩돼 다른 파라미터를 만들지 못한다', () => {
    const url = kakaoKeywordUrl('a&sort=distance#b', null);
    assert.ok(url.includes('query=a%26sort%3Ddistance%23b'));
    assert.ok(!url.includes('#'));
  });
});

describe('parseKakaoDocuments', () => {
  it('이름·도로명 주소(없으면 지번)·숫자 좌표·출처로 정규화한다', () => {
    const [a, b] = parseKakaoDocuments(
      { documents: [doc(), doc({ id: '2', place_name: ' 역삼  곱창 ', road_address_name: '', x: '127.03', y: '37.5' })] },
      null,
    );
    assert.deepEqual(a, {
      id: 'kakao:8471235',
      name: '강남역 2호선',
      address: '서울 강남구 강남대로 396',
      lat: 37.49794,
      lng: 127.02762,
      source: 'kakao',
      distanceM: null,
    });
    assert.equal(b.name, '역삼 곱창');
    assert.equal(b.address, '서울 강남구 역삼동 858');
  });

  it('이상한 좌표(빈 문자열·숫자 아님·범위 밖·0,0)와 이름 없는 행은 버린다', () => {
    const out = parseKakaoDocuments(
      {
        documents: [
          doc({ id: 'a', x: '', y: '' }),
          doc({ id: 'b', x: 'abc', y: '37.5' }),
          doc({ id: 'c', x: '127', y: '95' }),
          doc({ id: 'd', x: '0', y: '0' }),
          doc({ id: 'e', place_name: '   ' }),
          doc({ id: 'f', x: null, y: undefined }),
          null,
          'junk',
          doc({ id: 'ok' }),
        ],
      },
      null,
    );
    assert.deepEqual(
      out.map((r) => r.id),
      ['kakao:ok'],
    );
  });

  it('응답 모양이 틀리면 빈 배열', () => {
    assert.deepEqual(parseKakaoDocuments(null, null), []);
    assert.deepEqual(parseKakaoDocuments({ documents: 'x' }, null), []);
    assert.deepEqual(parseKakaoDocuments({}, null), []);
  });

  it('near 가 있으면 거리(m)를 붙인다', () => {
    const [r] = parseKakaoDocuments({ documents: [doc({ x: '127.03762', y: '37.49794' })] }, GANGNAM);
    assert.ok(r.distanceM !== null && r.distanceM > 870 && r.distanceM < 890);
  });
});

describe('fromGeocoded / dedupePlaces', () => {
  it('geocoder 결과는 검색어를 이름으로, 주소는 빈 값, 이상 좌표는 버리고 near 에서 가까운 순', () => {
    const out = fromGeocoded(
      [
        { latitude: 35.1, longitude: 129.04 },
        { latitude: 0, longitude: 0 },
        { latitude: Number.NaN, longitude: 127 },
        { latitude: 37.5, longitude: 127.03 },
      ],
      '테헤란로 152',
      GANGNAM,
    );
    assert.equal(out.length, 2);
    assert.equal(out[0].lat, 37.5);
    assert.equal(out[0].name, '테헤란로 152');
    assert.equal(out[0].address, '');
    assert.equal(out[0].source, 'geocoder');
    assert.equal(fromGeocoded('nope', 'q', null).length, 0);
  });

  it('같은 id, 또는 같은 이름·같은 자리(약 1m)는 하나만 남긴다', () => {
    const base: PlaceSearchResult = {
      id: 'kakao:1',
      name: '강남역',
      address: '',
      lat: 37.49794,
      lng: 127.02762,
      source: 'kakao',
      distanceM: null,
    };
    const out = dedupePlaces([
      base,
      { ...base },
      { ...base, id: 'kakao:2', lat: 37.497941 },
      { ...base, id: 'kakao:3', name: '강남역 2번 출구' },
    ]);
    assert.deepEqual(
      out.map((r) => r.id),
      ['kakao:1', 'kakao:3'],
    );
  });
});

describe('searchPlaces', () => {
  it('빈 검색어는 아무것도 부르지 않고 []', async () => {
    const f = fakeFetch(() => ({ body: { documents: [doc()] } }));
    const g = fakeGeocoder([{ latitude: 37.5, longitude: 127 }]);
    assert.deepEqual(await searchPlaces('   ', GANGNAM, { kakaoKey: 'k', fetch: f.fn, geocode: g.fn }), []);
    assert.equal(f.calls.length, 0);
    assert.equal(g.queries.length, 0);
  });

  it('키가 있으면 카카오를 KakaoAK 헤더로 부르고 키를 URL 에 싣지 않는다(geocoder 는 안 부른다)', async () => {
    const f = fakeFetch(() => ({ body: { documents: [doc()] } }));
    const g = fakeGeocoder([{ latitude: 37.5, longitude: 127 }]);
    const out = await searchPlaces('강남역', null, { kakaoKey: 'SECRET123', fetch: f.fn, geocode: g.fn });
    assert.equal(out.length, 1);
    assert.equal(out[0].source, 'kakao');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].headers.Authorization, 'KakaoAK SECRET123');
    assert.ok(!f.calls[0].url.includes('SECRET123'));
    assert.ok(f.calls[0].hasSignal);
    assert.equal(g.queries.length, 0);
  });

  it('near 가 있으면 근처·전국 두 번 묻고 근처 결과를 앞에, 중복은 한 번만', async () => {
    const f = fakeFetch((url) =>
      isNear(url)
        ? { body: { documents: [doc({ id: 'near1', place_name: '서울역 곱창 부산점', x: '129.04', y: '35.115' })] } }
        : {
            body: {
              documents: [
                doc({ id: 'far1', place_name: '서울역', x: '126.97062', y: '37.55473' }),
                doc({ id: 'near1', place_name: '서울역 곱창 부산점', x: '129.04', y: '35.115' }),
              ],
            },
          },
    );
    const busan = { lat: 35.11516, lng: 129.04224 };
    const out = await searchPlaces('서울역', busan, { kakaoKey: 'k', fetch: f.fn });
    assert.equal(f.calls.length, 2);
    assert.deepEqual(
      out.map((r) => r.id),
      ['kakao:near1', 'kakao:far1'],
    );
    // 전국 결과에도 near 기준 거리가 붙는다
    assert.ok(out[1].distanceM !== null && out[1].distanceM > 300_000);
  });

  it('근처 요청만 실패해도 전국 결과를 쓴다', async () => {
    const f = fakeFetch((url) => (isNear(url) ? 'throw' : { body: { documents: [doc({ id: 'x' })] } }));
    const g = fakeGeocoder([{ latitude: 37.5, longitude: 127 }]);
    const out = await searchPlaces('강남역', GANGNAM, { kakaoKey: 'k', fetch: f.fn, geocode: g.fn });
    assert.deepEqual(
      out.map((r) => r.id),
      ['kakao:x'],
    );
    assert.equal(g.queries.length, 0);
  });

  it('키가 없으면 카카오를 부르지 않고 geocoder 로 찾는다', async () => {
    const f = fakeFetch(() => ({ body: { documents: [doc()] } }));
    const g = fakeGeocoder([{ latitude: 37.50446, longitude: 127.04896 }]);
    const out = await searchPlaces(' 테헤란로  152 ', GANGNAM, { kakaoKey: null, fetch: f.fn, geocode: g.fn });
    assert.equal(f.calls.length, 0);
    assert.deepEqual(g.queries, ['테헤란로 152']);
    assert.equal(out.length, 1);
    assert.equal(out[0].source, 'geocoder');
    assert.equal(out[0].name, '테헤란로 152');
    assert.ok(out[0].distanceM !== null && out[0].distanceM > 0);
  });

  it('카카오 HTTP 오류(401·500)·네트워크 오류·JSON 모양 오류 → geocoder 로 폴백', async () => {
    const cases: Parameters<typeof fakeFetch>[0][] = [
      () => ({ ok: false, status: 401, body: { errorType: 'AccessDeniedError' } }),
      () => ({ ok: false, status: 500 }),
      () => 'throw',
      () => ({ body: { documents: 'nope' } }),
      () => ({ body: null }),
    ];
    for (const respond of cases) {
      const f = fakeFetch(respond);
      const g = fakeGeocoder([{ latitude: 37.5, longitude: 127.03 }]);
      const out = await searchPlaces('강남역', GANGNAM, { kakaoKey: 'k', fetch: f.fn, geocode: g.fn });
      assert.equal(out.length, 1);
      assert.equal(out[0].source, 'geocoder');
      assert.equal(g.queries.length, 1);
    }
  });

  it('카카오가 6초(여기선 30ms) 안에 답하지 않으면 끊고 geocoder 로 폴백', async () => {
    const f = fakeFetch(() => 'hang');
    const g = fakeGeocoder([{ latitude: 37.5, longitude: 127.03 }]);
    const started = Date.now();
    const out = await searchPlaces('강남역', GANGNAM, { kakaoKey: 'k', fetch: f.fn, geocode: g.fn, timeoutMs: 30 });
    assert.ok(Date.now() - started < 2_000);
    assert.equal(out[0]?.source, 'geocoder');
  });

  it('카카오 결과가 0건이면 주소일 수 있으니 geocoder 도 물어본다', async () => {
    const f = fakeFetch(() => ({ body: { documents: [] } }));
    const g = fakeGeocoder([{ latitude: 37.5, longitude: 127.03 }]);
    const out = await searchPlaces('테헤란로 152', null, { kakaoKey: 'k', fetch: f.fn, geocode: g.fn });
    assert.equal(g.queries.length, 1);
    assert.equal(out[0].source, 'geocoder');
  });

  it('둘 다 실패하면 던지지 않고 []', async () => {
    const f = fakeFetch(() => 'throw');
    const g = fakeGeocoder('throw');
    assert.deepEqual(await searchPlaces('강남역', GANGNAM, { kakaoKey: 'k', fetch: f.fn, geocode: g.fn }), []);
    assert.deepEqual(await searchPlaces('강남역', null, { kakaoKey: null, geocode: null }), []);
    assert.deepEqual(await searchPlaces('강남역', null, { kakaoKey: 'k', fetch: null, geocode: null }), []);
  });

  it('둘 다 빈 결과면 []', async () => {
    const f = fakeFetch(() => ({ body: { documents: [] } }));
    const g = fakeGeocoder([]);
    assert.deepEqual(await searchPlaces('없는장소', GANGNAM, { kakaoKey: 'k', fetch: f.fn, geocode: g.fn }), []);
  });

  it('카카오·geocoder 의 이상 좌표는 걸러지고, 남는 게 없으면 다음 단계로 간다', async () => {
    const f = fakeFetch(() => ({ body: { documents: [doc({ x: '0', y: '0' }), doc({ id: 'z', x: '999', y: '37' })] } }));
    const g = fakeGeocoder([
      { latitude: 0, longitude: 0 },
      { latitude: 37.5, longitude: 127.03 },
    ]);
    const out = await searchPlaces('강남역', null, { kakaoKey: 'k', fetch: f.fn, geocode: g.fn });
    assert.equal(out.length, 1);
    assert.equal(out[0].lat, 37.5);
  });

  it('이상한 near 는 무시하고 전국 검색만 한다', async () => {
    const f = fakeFetch(() => ({ body: { documents: [doc()] } }));
    const out = await searchPlaces('강남역', { lat: Number.NaN, lng: 500 }, { kakaoKey: 'k', fetch: f.fn });
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls[0].url.includes('sort=accuracy'));
    assert.equal(out[0].distanceM, null);
  });

  it(`결과는 최대 ${MAX_PLACE_RESULTS}개`, async () => {
    const many = (prefix: string) =>
      Array.from({ length: 15 }, (_, i) => doc({ id: `${prefix}${i}`, place_name: `${prefix}${i}`, x: `127.0${i}`, y: '37.5' }));
    const f = fakeFetch((url) => ({ body: { documents: many(isNear(url) ? 'n' : 'a') } }));
    const out = await searchPlaces('카페', GANGNAM, { kakaoKey: 'k', fetch: f.fn });
    assert.equal(out.length, MAX_PLACE_RESULTS);
    // 근처는 최대 10개만 앞에 둔다
    assert.equal(out.filter((r) => r.id.startsWith('kakao:n')).length, 10);
  });
});

describe('formatPlaceDistance', () => {
  it('m·km 표기', () => {
    assert.equal(formatPlaceDistance(850), '850m');
    assert.equal(formatPlaceDistance(1234), '1.2km');
    assert.equal(formatPlaceDistance(25_400), '25km');
    assert.equal(formatPlaceDistance(null), '');
    assert.equal(formatPlaceDistance(-1), '');
    assert.equal(formatPlaceDistance(Number.NaN), '');
  });
});
