import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  haversineMeters,
  isValidGeoPoint,
  isWithinRadius,
  MAX_ARRIVAL_ACCURACY_M,
  type GeoPoint,
} from './geo';

const CITY_HALL: GeoPoint = { lat: 37.5663, lng: 126.9779 }; // 서울시청
const GANGNAM: GeoPoint = { lat: 37.4979, lng: 127.0276 }; // 강남역

/** 위도 1도 ≈ 111.195km (평균 반지름 기준) */
const METERS_PER_DEG = 111_195;

/** 기준점에서 북쪽으로 m미터 떨어진 점 */
const northOf = (p: GeoPoint, m: number): GeoPoint => ({ lat: p.lat + m / METERS_PER_DEG, lng: p.lng });

describe('haversineMeters', () => {
  it('서울시청 ↔ 강남역은 약 8.8km', () => {
    const d = haversineMeters(CITY_HALL, GANGNAM);
    assert.ok(d > 8_500 && d < 9_000, `${d}`);
  });

  it('위도 1도 ≈ 111.2km, 적도에서 경도 1도도 같다', () => {
    assert.ok(Math.abs(haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - METERS_PER_DEG) < 5);
    assert.ok(Math.abs(haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - METERS_PER_DEG) < 5);
  });

  it('동일 지점은 0', () => {
    assert.equal(haversineMeters(CITY_HALL, CITY_HALL), 0);
    assert.equal(haversineMeters({ lat: 90, lng: 0 }, { lat: 90, lng: 0 }), 0);
  });

  it('대칭이다', () => {
    assert.equal(haversineMeters(CITY_HALL, GANGNAM), haversineMeters(GANGNAM, CITY_HALL));
  });

  it('날짜변경선을 넘어도 가까운 건 가깝다 (지구 반대편으로 돌지 않는다)', () => {
    const d = haversineMeters({ lat: 0, lng: 179.999 }, { lat: 0, lng: -179.999 });
    assert.ok(Number.isFinite(d));
    assert.ok(Math.abs(d - 0.002 * METERS_PER_DEG) < 1, `${d}`);
    // 경도 180과 -180은 같은 자오선
    assert.ok(haversineMeters({ lat: 10, lng: 180 }, { lat: 10, lng: -180 }) < 1e-6);
  });

  it('극지·대척점에서도 NaN이 나오지 않는다', () => {
    const half = Math.PI * 6_371_008.8; // 지구 반 바퀴
    const cases: [GeoPoint, GeoPoint][] = [
      [{ lat: 90, lng: 0 }, { lat: -90, lng: 77 }],
      [{ lat: 90, lng: 0 }, { lat: 90, lng: 180 }],
      [{ lat: 0, lng: 0 }, { lat: 0, lng: 180 }],
      [{ lat: 37.5, lng: 127 }, { lat: -37.5, lng: -53 }],
      [{ lat: 89.9999, lng: -180 }, { lat: 89.9999, lng: 180 }],
    ];
    for (const [a, b] of cases) {
      const d = haversineMeters(a, b);
      assert.ok(Number.isFinite(d) && d >= 0 && d <= half + 1, `${JSON.stringify([a, b])} → ${d}`);
    }
    // 극점에서는 경도가 달라도 같은 점
    assert.ok(haversineMeters({ lat: 90, lng: 0 }, { lat: 90, lng: 180 }) < 1e-3);
  });

  it('유효하지 않은 좌표는 Infinity (NaN 아님)', () => {
    assert.equal(haversineMeters({ lat: NaN, lng: 0 }, CITY_HALL), Infinity);
    assert.equal(haversineMeters(CITY_HALL, { lat: 91, lng: 0 }), Infinity);
  });
});

describe('isValidGeoPoint', () => {
  it('범위 경계는 유효', () => {
    assert.equal(isValidGeoPoint({ lat: 90, lng: 180 }), true);
    assert.equal(isValidGeoPoint({ lat: -90, lng: -180 }), true);
    assert.equal(isValidGeoPoint({ lat: 0, lng: 0 }), true);
  });

  it('범위 밖·NaN·Infinity·타입 불일치는 무효', () => {
    const bad: unknown[] = [
      { lat: 90.0001, lng: 0 },
      { lat: 0, lng: -180.0001 },
      { lat: NaN, lng: 0 },
      { lat: 0, lng: Infinity },
      { lat: '37.5', lng: 127 },
      { lat: 37.5 },
      null,
      undefined,
      'seoul',
      42,
    ];
    for (const p of bad) assert.equal(isValidGeoPoint(p), false, JSON.stringify(p));
  });
});

describe('isWithinRadius', () => {
  it('반경 경계: 안쪽은 true, 바깥은 false, 같은 지점은 반경 0에서도 true', () => {
    assert.equal(isWithinRadius(northOf(CITY_HALL, 99), CITY_HALL, 100), true);
    assert.equal(isWithinRadius(northOf(CITY_HALL, 101), CITY_HALL, 100), false);
    assert.equal(isWithinRadius(CITY_HALL, CITY_HALL, 0), true);
  });

  it('정확히 경계 거리면 도착 인정 (<=)', () => {
    const pos = northOf(CITY_HALL, 100);
    const d = haversineMeters(pos, CITY_HALL);
    assert.equal(isWithinRadius(pos, CITY_HALL, d), true);
    assert.equal(isWithinRadius(pos, CITY_HALL, d - 0.001), false);
  });

  it('부정확한 GPS로는 도착을 인정하지 않는다', () => {
    assert.equal(isWithinRadius(CITY_HALL, CITY_HALL, 100, MAX_ARRIVAL_ACCURACY_M), true);
    assert.equal(isWithinRadius(CITY_HALL, CITY_HALL, 100, MAX_ARRIVAL_ACCURACY_M + 0.1), false);
    assert.equal(isWithinRadius(CITY_HALL, CITY_HALL, 100, 5), true);
    assert.equal(isWithinRadius(CITY_HALL, CITY_HALL, 1000, 500), false);
  });

  it('정확도가 없으면 검사를 건너뛰고, 쓰레기 정확도(NaN·음수·Infinity)는 거부', () => {
    assert.equal(isWithinRadius(CITY_HALL, CITY_HALL, 100), true);
    assert.equal(isWithinRadius(CITY_HALL, CITY_HALL, 100, null), true);
    assert.equal(isWithinRadius(CITY_HALL, CITY_HALL, 100, NaN), false);
    assert.equal(isWithinRadius(CITY_HALL, CITY_HALL, 100, -1), false);
    assert.equal(isWithinRadius(CITY_HALL, CITY_HALL, 100, Infinity), false);
  });

  it('좌표·반경이 유효하지 않으면 false', () => {
    assert.equal(isWithinRadius({ lat: NaN, lng: 0 }, CITY_HALL, 100), false);
    assert.equal(isWithinRadius(CITY_HALL, { lat: 0, lng: 999 }, 100), false);
    assert.equal(isWithinRadius(CITY_HALL, CITY_HALL, NaN), false);
    assert.equal(isWithinRadius(CITY_HALL, CITY_HALL, -1), false);
    assert.equal(isWithinRadius(CITY_HALL, CITY_HALL, Infinity), false);
  });

  it('날짜변경선 건너편의 가까운 지점도 반경 안으로 본다', () => {
    assert.equal(isWithinRadius({ lat: 0, lng: -179.9999 }, { lat: 0, lng: 179.9999 }, 100), true);
  });
});
