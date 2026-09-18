import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapPinUrl, mapRouteUrl } from './mapRoute';

describe('mapRouteUrl · mapPinUrl', () => {
  it('좌표 길찾기와 핀 보기 링크', () => {
    assert.equal(
      mapRouteUrl('강남역', 37.4979, 127.0276),
      `https://map.kakao.com/link/to/${encodeURIComponent('강남역')},37.4979,127.0276`,
    );
    assert.equal(
      mapPinUrl('강남역', 37.4979, 127.0276),
      `https://map.kakao.com/link/map/${encodeURIComponent('강남역')},37.4979,127.0276`,
    );
  });

  it('이름의 쉼표·슬래시·공백은 인코딩돼 구분자를 오염시키지 않는다', () => {
    const url = mapRouteUrl('곱창, 막창/2호점  강남', 37.5, 127);
    const tail = url.replace('https://map.kakao.com/link/to/', '');
    assert.equal(tail.split(',').length, 3);
    assert.equal(tail.includes('/'), false);
    assert.equal(decodeURIComponent(tail.split(',')[0]), '곱창, 막창/2호점 강남');
  });

  it('좌표는 소수 6자리까지, 지수 표기가 나오지 않는다', () => {
    const url = mapPinUrl('적도', 0.00000012345, -127.123456789);
    assert.ok(url.endsWith(',0,-127.123457'), url);
  });

  it('이름이 비면 "약속 장소"', () => {
    assert.ok(mapRouteUrl('  ', 37.5, 127).includes(encodeURIComponent('약속 장소')));
  });

  it('좌표가 쓰레기면 이름 검색 링크로 떨어진다', () => {
    const expected = `https://map.kakao.com/link/search/${encodeURIComponent('강남역')}`;
    assert.equal(mapRouteUrl('강남역', Number.NaN, 127), expected);
    assert.equal(mapPinUrl('강남역', 91, 127), expected);
    assert.equal(mapRouteUrl('강남역', 37.5, 181), expected);
  });
});
