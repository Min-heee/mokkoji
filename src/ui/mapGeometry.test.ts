import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ANDROID_MARKER_BITMAP_PX,
  MIN_REGION_DELTA,
  androidMarkerBoxDp,
  drawnRadiusM,
  fitMarkerContentDp,
  mePlan,
  easeOutCubic,
  formatDistance,
  isUserMove,
  lerpLatLng,
  mapAccessibilityLabel,
  markerInitial,
  needsRefit,
  normalizeLng,
  regionForPoints,
  sameLatLng,
  visibleMarkerSignature,
  type MapRegion,
} from './mapGeometry';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

/** 영역 안에 점이 들어 있는지(경도는 짧은 쪽 차이) */
function contains(r: MapRegion, p: { lat: number; lng: number }): boolean {
  const dLng = normalizeLng(p.lng - r.longitude);
  return Math.abs(p.lat - r.latitude) <= r.latitudeDelta / 2 + 1e-12 && Math.abs(dLng) <= r.longitudeDelta / 2 + 1e-12;
}

describe('regionForPoints', () => {
  it('유효한 점이 없으면 null', () => {
    assert.equal(regionForPoints([]), null);
    assert.equal(regionForPoints([null, undefined, { lat: NaN, lng: 1 }, { lat: 91, lng: 0 }, { lat: 0, lng: 181 }]), null);
  });

  it('점 하나면 그 점이 중심이고 최소 델타로 편다', () => {
    const r = regionForPoints([{ lat: 37.4979, lng: 127.0276 }])!;
    near(r.latitude, 37.4979);
    near(r.longitude, 127.0276);
    assert.equal(r.latitudeDelta, MIN_REGION_DELTA);
    assert.equal(r.longitudeDelta, MIN_REGION_DELTA);
  });

  it('같은 점이 여러 개여도 최소 델타(0 으로 줄지 않는다)', () => {
    const p = { lat: 37.5, lng: 127 };
    const r = regionForPoints([p, p, { ...p }])!;
    assert.equal(r.latitudeDelta, MIN_REGION_DELTA);
    assert.equal(r.longitudeDelta, MIN_REGION_DELTA);
    near(r.latitude, 37.5);
  });

  it('여러 점은 모두 감싸고 양쪽에 여백 25% 씩을 더한다', () => {
    const pts = [
      { lat: 37.49, lng: 127.02 },
      { lat: 37.51, lng: 127.06 },
      { lat: 37.5, lng: 127.03 },
    ];
    const r = regionForPoints(pts)!;
    near(r.latitude, 37.5);
    near(r.longitude, 127.04);
    near(r.latitudeDelta, 0.02 * 1.5, 1e-9);
    near(r.longitudeDelta, 0.04 * 1.5, 1e-9);
    for (const p of pts) assert.ok(contains(r, p));
  });

  it('여백 비율을 바꿀 수 있고 null·NaN 점은 무시한다', () => {
    const r = regionForPoints([{ lat: 0, lng: 0 }, null, { lat: 1, lng: 1 }, { lat: Infinity, lng: 3 }], { paddingRatio: 0 })!;
    near(r.latitudeDelta, 1);
    near(r.longitudeDelta, 1);
    near(r.latitude, 0.5);
  });

  it('날짜변경선 양쪽 점은 짧은 쪽(0.2도)으로 감싼다', () => {
    const a = { lat: -17.7, lng: 179.9 };
    const b = { lat: -17.8, lng: -179.9 };
    const r = regionForPoints([a, b], { paddingRatio: 0 })!;
    near(r.longitudeDelta, 0.2, 1e-9);
    assert.ok(Math.abs(Math.abs(r.longitude) - 180) < 1e-9, `중심 경도 ${r.longitude}`);
    assert.ok(r.longitude >= -180 && r.longitude < 180);
    assert.ok(contains(r, a) && contains(r, b));
  });

  it('날짜변경선 근처라도 한쪽에만 있으면 그대로 감싼다', () => {
    const r = regionForPoints([{ lat: 0, lng: 179.1 }, { lat: 0, lng: 179.9 }], { paddingRatio: 0 })!;
    near(r.longitude, 179.5);
    near(r.longitudeDelta, 0.8, 1e-9);
  });

  it('반경 원이 점들의 영역보다 크면 원 전체가 들어가게 넓힌다', () => {
    const dest = { lat: 37.5, lng: 127 };
    const r = regionForPoints([dest], { circle: { ...dest, radiusM: 1000 } })!;
    // 원의 위도 폭 = 2km ≈ 0.01797도 → 여백 포함 1.5배
    near(r.latitudeDelta, ((2 * 1000) / 111_320) * 1.5, 1e-9);
    assert.ok(r.latitudeDelta > MIN_REGION_DELTA);
    // 경도 폭은 cos(위도)만큼 넓다
    assert.ok(r.longitudeDelta > r.latitudeDelta);
    near(r.latitude, 37.5);
    near(r.longitude, 127);
  });

  it('반경이 작으면(30m) 최소 델타가 이긴다', () => {
    const dest = { lat: 37.5, lng: 127 };
    const r = regionForPoints([], { circle: { ...dest, radiusM: 30 } })!;
    assert.equal(r.latitudeDelta, MIN_REGION_DELTA);
    assert.equal(r.longitudeDelta, MIN_REGION_DELTA);
  });

  it('반경이 0·NaN 이면 원 중심만 점으로 쓴다', () => {
    const r = regionForPoints([], { circle: { lat: 10, lng: 20, radiusM: NaN } })!;
    near(r.latitude, 10);
    near(r.longitude, 20);
  });

  it('멀리 떨어진 친구와 목적지 원을 함께 감싼다', () => {
    const dest = { lat: 37.5, lng: 127 };
    const friend = { lat: 37.6, lng: 127.1 };
    const r = regionForPoints([dest, friend], { circle: { ...dest, radiusM: 100 } })!;
    assert.ok(contains(r, dest) && contains(r, friend));
    near(r.latitudeDelta, (0.1 + 100 / 111_320) * 1.5, 1e-6);
  });

  it('델타는 위도 170·경도 360 을 넘지 않는다', () => {
    const r = regionForPoints([{ lat: -89, lng: -179 }, { lat: 89, lng: 0 }, { lat: 0, lng: 179 }])!;
    assert.ok(r.latitudeDelta <= 170);
    assert.ok(r.longitudeDelta <= 360);
    assert.ok(r.latitude >= -85 && r.latitude <= 85);
  });
});

describe('needsRefit', () => {
  const region: MapRegion = { latitude: 37.5, longitude: 127, latitudeDelta: 0.02, longitudeDelta: 0.02 };

  it('영역이 없으면 맞춰야 한다', () => {
    assert.equal(needsRefit(null, [{ lat: 0, lng: 0 }]), true);
  });

  it('안쪽 점만 있으면 그대로 둔다', () => {
    assert.equal(needsRefit(region, [{ lat: 37.5, lng: 127 }, { lat: 37.505, lng: 127.005 }]), false);
  });

  it('가장자리 10% 로 빠진 점이 있으면 다시 맞춘다', () => {
    // 반폭 0.01 의 90% = 0.009 를 넘는 0.0095
    assert.equal(needsRefit(region, [{ lat: 37.5095, lng: 127 }]), true);
    assert.equal(needsRefit(region, [{ lat: 37.5, lng: 126.9905 }]), true);
  });

  it('좌표 없는 점은 무시한다', () => {
    assert.equal(needsRefit(region, [null, undefined, { lat: NaN, lng: 0 }]), false);
  });

  it('날짜변경선을 넘는 경도 차도 짧은 쪽으로 잰다', () => {
    const r: MapRegion = { latitude: 0, longitude: 179.99, latitudeDelta: 0.1, longitudeDelta: 0.1 };
    assert.equal(needsRefit(r, [{ lat: 0, lng: -179.99 }]), false);
    assert.equal(needsRefit(r, [{ lat: 0, lng: -179.9 }]), true);
  });
});

describe('visibleMarkerSignature', () => {
  it('좌표가 있는 마커 id 만, 순서와 무관하게', () => {
    const a = visibleMarkerSignature([
      { id: 'b', lat: 1, lng: 1 },
      { id: 'a', lat: 2, lng: 2 },
      { id: 'c', lat: null, lng: null },
    ]);
    const b = visibleMarkerSignature([
      { id: 'a', lat: 3, lng: 3 },
      { id: 'b', lat: 4, lng: 4 },
    ]);
    assert.equal(a, 'a|b');
    assert.equal(a, b);
  });

  it('좌표가 생기면 서명이 바뀐다', () => {
    assert.notEqual(
      visibleMarkerSignature([{ id: 'c', lat: null, lng: null }]),
      visibleMarkerSignature([{ id: 'c', lat: 1, lng: 1 }]),
    );
  });
});

describe('보간', () => {
  it('lerpLatLng 은 양 끝과 중간을 맞춘다', () => {
    const a = { lat: 0, lng: 0 };
    const b = { lat: 2, lng: 4 };
    assert.deepEqual(lerpLatLng(a, b, 0), a);
    assert.deepEqual(lerpLatLng(a, b, 1), b);
    assert.deepEqual(lerpLatLng(a, b, 0.5), { lat: 1, lng: 2 });
    assert.deepEqual(lerpLatLng(a, b, 7), b);
  });

  it('lerpLatLng 은 날짜변경선을 짧은 쪽으로 넘는다', () => {
    const m = lerpLatLng({ lat: 0, lng: 179 }, { lat: 0, lng: -179 }, 0.5);
    assert.ok(Math.abs(Math.abs(m.lng) - 180) < 1e-9, `${m.lng}`);
  });

  it('easeOutCubic 은 0→0, 1→1, 범위 밖은 자른다', () => {
    assert.equal(easeOutCubic(0), 0);
    assert.equal(easeOutCubic(1), 1);
    assert.equal(easeOutCubic(-1), 0);
    assert.equal(easeOutCubic(2), 1);
    assert.ok(easeOutCubic(0.5) > 0.5);
  });

  it('sameLatLng 은 1m 안팎의 차이를 같다고 본다', () => {
    assert.equal(sameLatLng({ lat: 1, lng: 1 }, { lat: 1.000001, lng: 1 }), true);
    assert.equal(sameLatLng({ lat: 1, lng: 1 }, { lat: 1.001, lng: 1 }), false);
    assert.equal(sameLatLng({ lat: 0, lng: 179.999999 }, { lat: 0, lng: -179.999999 }), true);
    assert.equal(sameLatLng(null, null), true);
    assert.equal(sameLatLng(null, { lat: 0, lng: 0 }), false);
  });

  it('normalizeLng 은 [-180, 180) 으로 접는다', () => {
    assert.equal(normalizeLng(180), -180);
    assert.equal(normalizeLng(190), -170);
    assert.equal(normalizeLng(-190), 170);
    assert.equal(normalizeLng(540), -180);
    assert.equal(normalizeLng(127), 127);
  });
});

describe('isUserMove', () => {
  it('구글맵이 isGesture 를 주면 그대로 따른다', () => {
    assert.equal(isUserMove({ isGesture: true, touching: false, lastTouchEndMs: null, nowMs: 0 }), true);
  });

  it('손가락이 닿아 있으면 사용자 이동', () => {
    assert.equal(isUserMove({ touching: true, lastTouchEndMs: null, nowMs: 0 }), true);
  });

  it('손을 뗀 뒤 1.5초(관성) 안의 변경은 사용자 이동', () => {
    assert.equal(isUserMove({ touching: false, lastTouchEndMs: 1000, nowMs: 2400 }), true);
    assert.equal(isUserMove({ touching: false, lastTouchEndMs: 1000, nowMs: 2600 }), false);
  });

  it('터치 기록이 없으면 코드로 움직인 것(자동 재맞춤)', () => {
    assert.equal(isUserMove({ isGesture: false, touching: false, lastTouchEndMs: null, nowMs: 5 }), false);
    assert.equal(isUserMove({ touching: false, lastTouchEndMs: null, nowMs: 5 }), false);
  });

  it('시계가 거꾸로 가면(음수 차) 사용자 이동으로 보지 않는다', () => {
    assert.equal(isUserMove({ touching: false, lastTouchEndMs: 5000, nowMs: 4000 }), false);
  });
});

describe('표시 문자열', () => {
  it('markerInitial 은 첫 글자(합성 한글·서로게이트 포함)를 대문자로', () => {
    assert.equal(markerInitial('지수'), '지');
    assert.equal(markerInitial('  minhee'), 'M');
    assert.equal(markerInitial('𠀋abc'), '𠀋');
    assert.equal(markerInitial(''), '?');
    assert.equal(markerInitial('   '), '?');
    assert.equal(markerInitial(null), '?');
  });

  it('formatDistance', () => {
    assert.equal(formatDistance(850), '850m');
    assert.equal(formatDistance(849.6), '850m');
    assert.equal(formatDistance(1234), '1.2km');
    assert.equal(formatDistance(-1), '');
    assert.equal(formatDistance(NaN), '');
    assert.equal(formatDistance(null), '');
    assert.equal(formatDistance(undefined), '');
  });

  it('mapAccessibilityLabel', () => {
    assert.equal(mapAccessibilityLabel('강남역 곱창', 100, 0), '강남역 곱창 지도, 도착 인정 거리 100m');
    assert.equal(mapAccessibilityLabel(' ', 100, 2), '약속 장소 지도, 도착 인정 거리 100m, 친구 2명 위치 표시');
    assert.equal(mapAccessibilityLabel('집', NaN, 0), '집 지도');
    assert.equal(mapAccessibilityLabel('모임 장소', null, 0), '모임 장소 지도');
  });

  it('drawnRadiusM: 반경이 없으면(null·0 이하·NaN) 원도 도착 인정 거리 문구도 없다(모임 약속 미리보기)', () => {
    assert.equal(drawnRadiusM(100), 100);
    assert.equal(drawnRadiusM(30), 30);
    assert.equal(drawnRadiusM(null), null);
    assert.equal(drawnRadiusM(undefined), null);
    assert.equal(drawnRadiusM(0), null);
    assert.equal(drawnRadiusM(-5), null);
    assert.equal(drawnRadiusM(Number.NaN), null);
    assert.equal(drawnRadiusM(Number.POSITIVE_INFINITY), null);
  });
});

describe('내 위치: 그리기와 영역 맞춤', () => {
  const me = { lat: 37.518, lng: 127.0 };

  it('OS 파란 점이 그려져도(권한 있음) 내 좌표는 영역 맞춤에 들어간다 — 그리지만 않는다', () => {
    assert.deepEqual(mePlan({ me, meMarkerShown: false, locationGranted: true }), { fit: me, drawDot: false });
  });

  it('권한이 없으면 우리가 점을 그리고 영역에도 넣는다', () => {
    assert.deepEqual(mePlan({ me, meMarkerShown: false, locationGranted: false }), { fit: me, drawDot: true });
  });

  it("'나' 마커가 이미 그려지면 따로 다루지 않는다", () => {
    assert.deepEqual(mePlan({ me, meMarkerShown: true, locationGranted: true }), { fit: null, drawDot: false });
    assert.deepEqual(mePlan({ me, meMarkerShown: true, locationGranted: false }), { fit: null, drawDot: false });
  });

  it('좌표가 없거나 틀리면 아무것도 안 한다', () => {
    assert.deepEqual(mePlan({ me: null, meMarkerShown: false, locationGranted: true }), { fit: null, drawDot: false });
    assert.deepEqual(mePlan({ me: { lat: NaN, lng: 127 }, meMarkerShown: false, locationGranted: false }), {
      fit: null,
      drawDot: false,
    });
    assert.deepEqual(mePlan({ me: { lat: 91, lng: 127 }, meMarkerShown: false, locationGranted: false }), {
      fit: null,
      drawDot: false,
    });
  });

  it('목적지에서 2km 떨어진 내 위치가 맞춘 영역 안에 들어온다(권한 있음)', () => {
    const dest = { lat: 37.5, lng: 127.0 };
    const friend = { lat: 37.5013, lng: 127.0 };
    const plan = mePlan({ me, meMarkerShown: false, locationGranted: true });
    const pts = [dest, friend, ...(plan.fit ? [plan.fit] : [])];
    const r = regionForPoints(pts, { circle: { ...dest, radiusM: 100 } });
    assert.ok(r);
    assert.ok(Math.abs(me.lat - r.latitude) <= r.latitudeDelta / 2);
    assert.ok(Math.abs(me.lng - r.longitude) <= r.longitudeDelta / 2);
  });
});

describe('안드로이드 마커 비트맵 상자', () => {
  it('상자는 100px 비트맵과 같은 dp 크기', () => {
    assert.equal(ANDROID_MARKER_BITMAP_PX, 100);
    assert.equal(androidMarkerBoxDp(2), 50);
    assert.equal(androidMarkerBoxDp(3.5), 100 / 3.5);
    // 밀도를 모르면 1로 본다
    assert.equal(androidMarkerBoxDp(0), 100);
    assert.equal(androidMarkerBoxDp(NaN), 100);
  });

  it('보통 밀도에서는 원래 크기 그대로', () => {
    assert.equal(fitMarkerContentDp(32, 2), 32);
    assert.equal(fitMarkerContentDp(32, 3), 32);
    assert.equal(fitMarkerContentDp(14, 3.5), 14);
  });

  it('고밀도(3.125 초과)에서는 32dp 원을 100px 안에 들어가게 줄인다', () => {
    const d = fitMarkerContentDp(32, 3.5);
    assert.ok(d < 32);
    assert.ok(d * 3.5 <= 100);
    assert.ok(fitMarkerContentDp(32, 4) * 4 <= 100);
  });
});
