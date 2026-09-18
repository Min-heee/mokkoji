import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { haversineMeters } from '../domain/geo';

import {
  CIRCLE_SHARE,
  DEFAULT_CENTER,
  DEFAULT_SPAN_DEG,
  formatNearestAddress,
  geocoderNeedsPermission,
  isSameSpot,
  KEEP_NAME_WITHIN_M,
  nameForCenter,
  pickerPermissionFromStatus,
  placeSearchMode,
  regionAround,
  regionCenter,
  shouldEmitCenter,
  toPickerPermission,
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
