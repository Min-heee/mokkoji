import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { haversineMeters } from '../domain/geo';

import {
  CIRCLE_SHARE,
  DEFAULT_CENTER,
  DEFAULT_SPAN_DEG,
  fillPlaceName,
  formatNearestAddress,
  geocoderNeedsPermission,
  isNamePending,
  parseRadiusText,
  settleNearestName,
  shouldCloseCustomRadius,
  isSameSpot,
  KEEP_NAME_WITHIN_M,
  nameForCenter,
  isUsableRadius,
  pickerPermissionFromStatus,
  pickRadius,
  pinLimitStatus,
  placeSearchMode,
  RADIUS_PICKER_CHOICES,
  radiusChipList,
  radiusRefitRegion,
  radiusSentence,
  regionAround,
  regionCenter,
  regionShortSideM,
  shouldEmitCenter,
  toPickerPermission,
  upgradeWithAddress,
  usesNativeMap,
  wrapLng,
} from './placePickerModel';

const GANGNAM = { lat: 37.49794, lng: 127.02762 };

describe('usesNativeMap', () => {
  it('iOS 는 항상 지도, 안드로이드는 구글 지도 키가 있을 때만, 웹은 아니다', () => {
    assert.equal(usesNativeMap('ios', false), true);
    assert.equal(usesNativeMap('ios', true), true);
    assert.equal(usesNativeMap('android', true), true);
    assert.equal(usesNativeMap('android', false), false);
    assert.equal(usesNativeMap('web', true), false);
  });
});

describe('placeSearchMode', () => {
  it('카카오 키가 있으면 어디서든 kakao', () => {
    assert.equal(placeSearchMode('android', true, 'denied'), 'kakao');
    assert.equal(placeSearchMode('ios', true, 'undetermined'), 'kakao');
  });

  it('안드로이드에서 위치 권한 거부 + 카카오 키 없음이면 검색창을 숨긴다', () => {
    assert.equal(placeSearchMode('android', false, 'denied'), 'hidden');
  });

  it('키가 없어도 iOS 는 권한과 무관하게 geocoder, 안드로이드는 허용·미결정이면 geocoder', () => {
    assert.equal(placeSearchMode('ios', false, 'denied'), 'geocoder');
    assert.equal(placeSearchMode('android', false, 'granted'), 'geocoder');
    assert.equal(placeSearchMode('android', false, 'undetermined'), 'geocoder');
  });
});

describe('geocoderNeedsPermission / toPickerPermission', () => {
  it('안드로이드만 geocoder 전에 위치 권한이 필요하다', () => {
    assert.equal(geocoderNeedsPermission('android', 'undetermined'), true);
    assert.equal(geocoderNeedsPermission('android', 'denied'), true);
    assert.equal(geocoderNeedsPermission('android', 'granted'), false);
    assert.equal(geocoderNeedsPermission('ios', 'denied'), false);
  });

  it('expo-location 권한 응답을 세 값으로 줄인다', () => {
    assert.equal(toPickerPermission({ status: 'granted', granted: true }), 'granted');
    assert.equal(toPickerPermission({ status: 'denied', granted: false }), 'denied');
    assert.equal(toPickerPermission({ status: 'undetermined', granted: false }), 'undetermined');
    assert.equal(toPickerPermission(null), 'undetermined');
    assert.equal(toPickerPermission({ status: 'weird' }), 'undetermined');
  });

  it('공용 권한 모듈의 상태를 세 값으로 줄인다(영구 거부는 거부, 사용 불가는 모름)', () => {
    assert.equal(pickerPermissionFromStatus('granted'), 'granted');
    assert.equal(pickerPermissionFromStatus('denied'), 'denied');
    assert.equal(pickerPermissionFromStatus('blocked'), 'denied');
    assert.equal(pickerPermissionFromStatus('undetermined'), 'undetermined');
    assert.equal(pickerPermissionFromStatus('unavailable'), 'undetermined');
    assert.equal(pickerPermissionFromStatus(null), 'undetermined');
  });
});

describe('regionCenter / wrapLng', () => {
  it('영역 중심을 소수 6자리로 돌려준다', () => {
    assert.deepEqual(
      regionCenter({ latitude: 37.4979412345, longitude: 127.0276298765, latitudeDelta: 0.01, longitudeDelta: 0.01 }),
      { lat: 37.497941, lng: 127.02763 },
    );
  });

  it('범위를 넘은 경도는 접고, 이상한 값은 null', () => {
    assert.equal(wrapLng(190), -170);
    assert.equal(wrapLng(-190), 170);
    assert.equal(wrapLng(540), -180);
    assert.equal(wrapLng(127), 127);
    assert.deepEqual(regionCenter({ latitude: 10, longitude: 370, latitudeDelta: 1, longitudeDelta: 1 }), { lat: 10, lng: 10 });
    assert.equal(regionCenter({ latitude: Number.NaN, longitude: 127 }), null);
    assert.equal(regionCenter({ latitude: 95, longitude: 127 }), null);
    assert.equal(regionCenter(null), null);
    assert.equal(regionCenter({}), null);
  });
});

describe('regionAround', () => {
  it('반경 원 지름이 영역 세로의 약 40%가 되게 확대한다', () => {
    const r = regionAround(GANGNAM, 100);
    assert.equal(r.latitude, GANGNAM.lat);
    assert.equal(r.longitude, GANGNAM.lng);
    const heightM = r.latitudeDelta * 111_320;
    assert.ok(Math.abs(200 / heightM - CIRCLE_SHARE) < 1e-9);
  });

  it('경도 폭은 위도에 맞춰 늘려 가로도 같은 땅 거리를 덮는다', () => {
    const r = regionAround(GANGNAM, 100);
    const widthM = haversineMeters(
      { lat: GANGNAM.lat, lng: GANGNAM.lng - r.longitudeDelta / 2 },
      { lat: GANGNAM.lat, lng: GANGNAM.lng + r.longitudeDelta / 2 },
    );
    const heightM = r.latitudeDelta * 111_320;
    assert.ok(Math.abs(widthM - heightM) / heightM < 0.01);
  });

  it('반경이 없거나 이상하면 기본 폭, 너무 작거나 크면 한도 안으로', () => {
    assert.equal(regionAround(DEFAULT_CENTER).latitudeDelta, DEFAULT_SPAN_DEG);
    assert.equal(regionAround(DEFAULT_CENTER, Number.NaN).latitudeDelta, DEFAULT_SPAN_DEG);
    assert.equal(regionAround(DEFAULT_CENTER, -5).latitudeDelta, DEFAULT_SPAN_DEG);
    assert.equal(regionAround(DEFAULT_CENTER, 1).latitudeDelta, 0.002);
    assert.equal(regionAround(DEFAULT_CENTER, 1_000_000).latitudeDelta, 0.5);
  });

  it('극지방 근처에서도 유한한 값', () => {
    const r = regionAround({ lat: 89.9, lng: 0 }, 100);
    assert.ok(Number.isFinite(r.longitudeDelta) && r.longitudeDelta <= 1);
  });
});

describe('isSameSpot / shouldEmitCenter', () => {
  it('2m 안이면 같은 자리', () => {
    assert.equal(isSameSpot(GANGNAM, { lat: GANGNAM.lat + 0.00001, lng: GANGNAM.lng }), true);
    assert.equal(isSameSpot(GANGNAM, { lat: GANGNAM.lat + 0.0001, lng: GANGNAM.lng }), false);
    assert.equal(isSameSpot(GANGNAM, null), false);
  });

  it('사용자가 지도를 만지기 전(첫 로드·코드 이동)에는 핀을 만들지 않는다', () => {
    assert.equal(shouldEmitCenter(false, GANGNAM, null), false);
  });

  it('만진 뒤에는 새 자리면 보내고, 같은 자리면 보내지 않는다', () => {
    assert.equal(shouldEmitCenter(true, GANGNAM, null), true);
    assert.equal(shouldEmitCenter(true, GANGNAM, { lat: 37.5, lng: 127.03 }), true);
    assert.equal(shouldEmitCenter(true, GANGNAM, { ...GANGNAM }), false);
    assert.equal(shouldEmitCenter(true, null, GANGNAM), false);
  });
});

describe('nameForCenter', () => {
  const picked = { name: '강남역 2번 출구', ...GANGNAM };

  it(`고른 장소에서 ${KEEP_NAME_WITHIN_M}m 안이면 이름을 유지한다`, () => {
    assert.equal(nameForCenter(picked, { lat: GANGNAM.lat + 0.0005, lng: GANGNAM.lng }), '강남역 2번 출구');
  });

  it('멀리 옮기면 이름을 버린다', () => {
    assert.equal(nameForCenter(picked, { lat: GANGNAM.lat + 0.002, lng: GANGNAM.lng }), undefined);
  });

  it('고른 장소가 없거나 이름이 비면 undefined', () => {
    assert.equal(nameForCenter(null, GANGNAM), undefined);
    assert.equal(nameForCenter({ ...picked, name: '  ' }, GANGNAM), undefined);
  });
});

describe('formatNearestAddress', () => {
  it('안드로이드 formattedAddress 는 앞의 나라 이름을 뗀다', () => {
    assert.equal(
      formatNearestAddress({ formattedAddress: '대한민국 서울특별시 강남구 강남대로 396', country: '대한민국' }),
      '서울특별시 강남구 강남대로 396',
    );
  });

  it('영문 formattedAddress 는 뒤의 나라 이름을 뗀다', () => {
    assert.equal(
      formatNearestAddress({ formattedAddress: '396 Gangnam-daero, Gangnam-gu, Seoul, South Korea', country: 'South Korea' }),
      '396 Gangnam-daero, Gangnam-gu, Seoul',
    );
  });

  it('iOS 조각은 큰 단위부터 겹치는 것을 빼고 잇는다', () => {
    assert.equal(
      formatNearestAddress({
        formattedAddress: null,
        country: '대한민국',
        region: '서울특별시',
        city: '서울특별시',
        subregion: '강남구',
        district: '역삼동',
        street: '강남대로',
        streetNumber: '396',
        name: '강남대로 396',
      }),
      '서울특별시 강남구 역삼동 강남대로 396',
    );
  });

  it('도로명이 없으면 name 을 끝에 붙인다', () => {
    assert.equal(formatNearestAddress({ region: '부산광역시', district: '초량동', name: '부산역' }), '부산광역시 초량동 부산역');
  });

  it('모르면 빈 문자열(화면은 줄을 생략한다)', () => {
    assert.equal(formatNearestAddress(null), '');
    assert.equal(formatNearestAddress({}), '');
    assert.equal(formatNearestAddress({ formattedAddress: '대한민국', country: '대한민국' }), '');
    assert.equal(formatNearestAddress({ formattedAddress: '   ' }), '');
  });

  it('너무 길면 80자로 자른다', () => {
    const long = formatNearestAddress({ formattedAddress: '가'.repeat(200) });
    assert.equal(Array.from(long).length, 80);
    assert.ok(long.endsWith('…'));
  });
});

describe('pinLimitStatus', () => {
  const c = { lat: 37.49808, lng: 127.02761 };
  const north = (m: number) => ({ lat: c.lat + m / 111_195, lng: c.lng });
  it('한도가 없으면 항상 안', () => {
    assert.deepEqual(pinLimitStatus(north(900), null, 500), { distanceM: null, over: false });
    assert.deepEqual(pinLimitStatus(null, c, 500), { distanceM: null, over: false });
  });
  it('499m 안, 501m 밖', () => {
    assert.equal(pinLimitStatus(north(499), c, 500).over, false);
    assert.equal(pinLimitStatus(north(501), c, 500).over, true);
    const d = pinLimitStatus(north(300), c, 500).distanceM ?? 0;
    assert.ok(Math.abs(d - haversineMeters(c, north(300))) < 1e-9);
  });
});

describe('radiusChipList', () => {
  it('기본 칩은 50·100·200·300·500m', () => {
    assert.deepEqual(radiusChipList(RADIUS_PICKER_CHOICES, 100), [50, 100, 200, 300, 500]);
  });

  it('지금 값이 목록에 없으면 끼워 넣고 오름차순으로', () => {
    assert.deepEqual(radiusChipList(RADIUS_PICKER_CHOICES, 150), [50, 100, 150, 200, 300, 500]);
    assert.deepEqual(radiusChipList(RADIUS_PICKER_CHOICES, 30), [30, 50, 100, 200, 300, 500]);
    assert.deepEqual(radiusChipList(RADIUS_PICKER_CHOICES, 1000), [50, 100, 200, 300, 500, 1000]);
  });

  it('중복·순서 섞인 기본 목록도 정리한다', () => {
    assert.deepEqual(radiusChipList([200, 50, 200, 100, 50], 100), [50, 100, 200]);
  });

  it('지금 값이 없거나 이상하면 기본 목록만, 이상한 기본 값은 뺀다', () => {
    assert.deepEqual(radiusChipList([50, 100], null), [50, 100]);
    assert.deepEqual(radiusChipList([50, 100], undefined), [50, 100]);
    assert.deepEqual(radiusChipList([50, 100], Number.NaN), [50, 100]);
    assert.deepEqual(radiusChipList([50, 100], 75.5), [50, 100]);
    assert.deepEqual(radiusChipList([0, -10, 50, Number.NaN], 100), [50, 100]);
  });

  it('반경으로 쓸 수 있는 값은 양의 정수뿐', () => {
    assert.equal(isUsableRadius(100), true);
    assert.equal(isUsableRadius(0), false);
    assert.equal(isUsableRadius(-5), false);
    assert.equal(isUsableRadius(12.5), false);
    assert.equal(isUsableRadius('100'), false);
    assert.equal(isUsableRadius(null), false);
  });
});

describe('pickRadius (잠금)', () => {
  it('잠겨 있지 않으면 누른 값', () => {
    assert.equal(pickRadius(false, 100, 300), 300);
    assert.equal(pickRadius(undefined, 100, 50), 50);
  });

  it('잠겨 있으면(시작한 약속 — 정책 동결) 무엇을 눌러도 지금 값', () => {
    assert.equal(pickRadius(true, 100, 300), 100);
    assert.equal(pickRadius(true, 150, 50), 150);
  });

  it('이상한 값을 누르면 지금 값', () => {
    assert.equal(pickRadius(false, 100, 0), 100);
    assert.equal(pickRadius(false, 100, Number.NaN), 100);
  });

  it('칩 아래 문장', () => {
    assert.equal(radiusSentence(200), '핀에서 200m 안에 들어오면 도착이에요');
  });
});

describe('radiusRefitRegion (반경에 맞춘 지도 범위)', () => {
  it('맞춘 영역은 중심에서 반경의 2.5배까지 보인다(짧은 변 = 반경 x 5)', () => {
    for (const r of [50, 100, 300, 500]) {
      const next = radiusRefitRegion(null, GANGNAM, r);
      assert.ok(next);
      const short = regionShortSideM(next) ?? 0;
      assert.ok(Math.abs(short / r - 5) < 0.05, `${r}m → 짧은 변 ${short}m`);
      assert.equal(next.latitude, GANGNAM.lat);
      assert.equal(next.longitude, GANGNAM.lng);
    }
  });

  it('지금 영역에 원이 알맞게 들어 있으면 움직이지 않는다', () => {
    const view = regionAround(GANGNAM, 100); // 짧은 변 500m
    assert.equal(radiusRefitRegion(view, GANGNAM, 100), null);
    assert.equal(radiusRefitRegion(view, GANGNAM, 200), null); // 지름 400m = 80%
    assert.equal(radiusRefitRegion(view, GANGNAM, 50), null); // 지름 100m = 20%
  });

  it('원이 잘리면 줌 아웃, 점처럼 작으면 줌 인', () => {
    const view = regionAround(GANGNAM, 100); // 짧은 변 500m
    const out = radiusRefitRegion(view, GANGNAM, 500);
    assert.ok(out && out.latitudeDelta > view.latitudeDelta);
    const wide = regionAround(GANGNAM, 1000); // 짧은 변 5000m
    const zoomIn = radiusRefitRegion(wide, GANGNAM, 50);
    assert.ok(zoomIn && zoomIn.latitudeDelta < wide.latitudeDelta);
  });

  it('반경이 없으면(원 없음) 맞추지 않는다', () => {
    assert.equal(radiusRefitRegion(null, GANGNAM, null), null);
    assert.equal(radiusRefitRegion(null, GANGNAM, 0), null);
  });

  it('영역의 짧은 변: 이상한 영역은 null', () => {
    assert.equal(regionShortSideM(null), null);
    assert.equal(regionShortSideM({ latitude: 37, longitude: 127, latitudeDelta: 0, longitudeDelta: 0.01 }), null);
    assert.equal(regionShortSideM({ latitude: 37, longitude: 127, latitudeDelta: Number.NaN, longitudeDelta: 0.01 }), null);
    // 좁고 긴 영역은 가로가 짧은 변
    const tall = regionShortSideM({ latitude: 0, longitude: 0, latitudeDelta: 0.02, longitudeDelta: 0.01 }) ?? 0;
    assert.ok(Math.abs(tall - 1113.2) < 1);
  });
});

describe('fillPlaceName (지도에서 돌아올 때 이름 칸)', () => {
  const base = { maxChars: 60 };

  it('고친 적이 없으면 검색 이름·주소로 덮는다', () => {
    assert.equal(fillPlaceName({ ...base, current: '', edited: false, name: '강남역 2번 출구', nameSource: 'search' }), '강남역 2번 출구');
    assert.equal(
      fillPlaceName({ ...base, current: '옛 주소', edited: false, name: '서울특별시 강남구 강남대로 396', nameSource: 'address' }),
      '서울특별시 강남구 강남대로 396',
    );
  });

  it("고친 적이 없고 이름이 없으면(nameSource 'none') 칸을 비운다", () => {
    assert.equal(fillPlaceName({ ...base, current: '옛 주소', edited: false, name: undefined, nameSource: 'none' }), '');
    assert.equal(fillPlaceName({ ...base, current: '옛 주소', edited: false, name: '무시', nameSource: 'none' }), '');
    assert.equal(fillPlaceName({ ...base, current: 'x', edited: false, name: '   ', nameSource: 'search' }), '');
  });

  it('고친 적이 있으면 무엇이 와도 건드리지 않는다', () => {
    for (const nameSource of ['search', 'address', 'none'] as const) {
      assert.equal(fillPlaceName({ ...base, current: '우리 단골 곱창', edited: true, name: '다른 곳', nameSource }), '우리 단골 곱창');
    }
  });

  it('고쳤다가 다 지웠으면 채운다', () => {
    assert.equal(fillPlaceName({ ...base, current: '  ', edited: true, name: '서울역', nameSource: 'search' }), '서울역');
  });

  it('출처를 모르는 옛 값은 이름이 있으면 쓴다', () => {
    assert.equal(fillPlaceName({ ...base, current: '', edited: false, name: '부산역', nameSource: undefined }), '부산역');
    assert.equal(fillPlaceName({ ...base, current: '', edited: false, name: undefined, nameSource: undefined }), '');
  });

  it('공백을 정리하고 최대 글자 수로 자른다', () => {
    assert.equal(fillPlaceName({ ...base, current: '', edited: false, name: '  강남역   2번  ', nameSource: 'search' }), '강남역 2번');
    const long = fillPlaceName({ current: '', edited: false, name: '가'.repeat(80), nameSource: 'address', maxChars: 60 });
    assert.equal(Array.from(long).length, 60);
  });
});

describe('upgradeWithAddress (지도를 움직인 핀에 주소 이름 붙이기)', () => {
  it("이름 없이 보낸 핀('none')에 주소가 오면 'address' 로", () => {
    assert.deepEqual(upgradeWithAddress({ ...GANGNAM, nameSource: 'none' as const }, '서울 강남구 강남대로 396'), {
      ...GANGNAM,
      name: '서울 강남구 강남대로 396',
      nameSource: 'address',
    });
  });

  it('검색 이름·이미 주소·출처 모름·주소 없음이면 보내지 않는다', () => {
    assert.equal(upgradeWithAddress({ ...GANGNAM, name: '강남역', nameSource: 'search' as const }, '주소'), null);
    assert.equal(upgradeWithAddress({ ...GANGNAM, name: '주소', nameSource: 'address' as const }, '주소'), null);
    assert.equal(upgradeWithAddress({ ...GANGNAM }, '주소'), null);
    assert.equal(upgradeWithAddress({ ...GANGNAM, nameSource: 'none' as const }, '  '), null);
    assert.equal(upgradeWithAddress(null, '주소'), null);
  });
});

describe('fillPlaceName — 폴백 이름 칸에서 확정한 이름(nameConfirmed)', () => {
  const base = { maxChars: 60 };

  it('수정·복사 모드처럼 이름을 고친 것으로 보는 폼이어도 폴백에서 적은 이름으로 바꾼다', () => {
    // 재현: 웹 약속 수정 → 폴백에서 '홍대 곱창'으로 고치고 프리셋 고름 → 예전엔 '강남 곱창'이 남았다
    assert.equal(
      fillPlaceName({ ...base, current: '강남 곱창', edited: true, name: '홍대 곱창', nameSource: 'search', nameConfirmed: true }),
      '홍대 곱창',
    );
    // 새로 만들기: 폼에서 이름을 고친 뒤 폴백에서 다시 고친 이름
    assert.equal(
      fillPlaceName({ ...base, current: '강남역 곱창집', edited: true, name: '강남역 곱창집 2층', nameSource: 'search', nameConfirmed: true }),
      '강남역 곱창집 2층',
    );
  });

  it('폴백 이름 칸을 비우고 확정하면 비운다(none)', () => {
    assert.equal(fillPlaceName({ ...base, current: '강남 곱창', edited: true, nameSource: 'none', nameConfirmed: true }), '');
  });

  it('nameConfirmed 가 없으면 예전 규칙 그대로(고친 이름을 지킨다)', () => {
    assert.equal(fillPlaceName({ ...base, current: '강남 곱창', edited: true, name: '홍대 곱창', nameSource: 'search' }), '강남 곱창');
    assert.equal(
      fillPlaceName({ ...base, current: '강남 곱창', edited: true, name: '홍대 곱창', nameSource: 'search', nameConfirmed: false }),
      '강남 곱창',
    );
  });

  it('확정한 이름도 공백 정리·글자 수 자르기는 한다', () => {
    const long = fillPlaceName({ current: 'x', edited: true, name: '가'.repeat(80), nameSource: 'search', nameConfirmed: true, maxChars: 60 });
    assert.equal(Array.from(long).length, 60);
  });
});

describe('settleNearestName / isNamePending (주소 찾는 동안 확정 막기)', () => {
  const pending = { ...GANGNAM, nameSource: 'none' as const, namePending: true };

  it("찾는 중('none'+namePending)만 pending 이다", () => {
    assert.equal(isNamePending(pending), true);
    assert.equal(isNamePending({ ...GANGNAM, nameSource: 'none' as const }), false);
    assert.equal(isNamePending({ ...GANGNAM, name: '주소', nameSource: 'address' as const }), false);
    assert.equal(isNamePending({ ...GANGNAM, name: '강남역', nameSource: 'search' as const, namePending: true }), false);
    assert.equal(isNamePending(null), false);
  });

  it('아직 조회가 안 끝났으면 보내지 않는다(그대로 pending)', () => {
    assert.equal(settleNearestName(pending, { text: '', settled: false }, true), null);
  });

  it("주소가 오면 'address' 로, 찾는 중 표시는 뗀다", () => {
    const next = settleNearestName(pending, { text: '서울 중구 태평로1가', settled: true }, true);
    assert.deepEqual(next, { ...GANGNAM, name: '서울 중구 태평로1가', nameSource: 'address' });
    assert.equal(isNamePending(next), false);
  });

  it("조회가 끝났는데 주소가 없으면(실패) 표시만 뗀 'none'", () => {
    assert.deepEqual(settleNearestName(pending, { text: '', settled: true }, true), { ...GANGNAM, nameSource: 'none' });
  });

  it('주소를 찾을 수 없게 됐으면(권한) 기다리지 않고 표시를 뗀다', () => {
    assert.deepEqual(settleNearestName(pending, { text: '', settled: false }, false), { ...GANGNAM, nameSource: 'none' });
  });

  it('검색 이름·이미 주소·표시 없는 none(주소 없음)은 건드리지 않는다', () => {
    assert.equal(settleNearestName({ ...GANGNAM, name: '강남역', nameSource: 'search' as const }, { text: '주소', settled: true }, true), null);
    assert.equal(settleNearestName({ ...GANGNAM, name: '주소', nameSource: 'address' as const }, { text: '주소', settled: true }, true), null);
    assert.equal(settleNearestName({ ...GANGNAM, nameSource: 'none' as const }, { text: '', settled: true }, true), null);
    assert.equal(settleNearestName(null, { text: '주소', settled: true }, true), null);
  });

  it("표시 없는 'none' 에 주소가 오면 예전처럼 'address' 로 올린다", () => {
    assert.deepEqual(settleNearestName({ ...GANGNAM, nameSource: 'none' as const }, { text: '주소', settled: true }, true), {
      ...GANGNAM,
      name: '주소',
      nameSource: 'address',
    });
  });
});

describe('parseRadiusText / shouldCloseCustomRadius (거리 직접 적기)', () => {
  it('정수이고 범위 안이면 그 값', () => {
    assert.equal(parseRadiusText('150', 30, 1000), 150);
    assert.equal(parseRadiusText(' 30 ', 30, 1000), 30);
    assert.equal(parseRadiusText('1000', 30, 1000), 1000);
  });

  it('범위 밖·소수·글자·빈칸이면 null', () => {
    for (const t of ['15', '1001', '150.5', 'abc', '', '  ', '-50']) assert.equal(parseRadiusText(t, 30, 1000), null, t);
  });

  it('[완료]: 비었거나 올바르면 닫고, 이상한 값이면 열어 둔다', () => {
    assert.equal(shouldCloseCustomRadius('', 30, 1000), true);
    assert.equal(shouldCloseCustomRadius('150', 30, 1000), true);
    assert.equal(shouldCloseCustomRadius('15', 30, 1000), false);
    assert.equal(shouldCloseCustomRadius('5000', 30, 1000), false);
  });
});
