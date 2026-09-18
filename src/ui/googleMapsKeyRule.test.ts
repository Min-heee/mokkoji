import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { embeddedHasGoogleMapsKey } from './googleMapsKeyRule';

describe('내장 설정의 구글 지도 키 유무', () => {
  it('안드로이드처럼 JSON 문자열로 와도 읽는다', () => {
    assert.equal(embeddedHasGoogleMapsKey(JSON.stringify({ extra: { hasGoogleMapsKey: true } })), true);
    assert.equal(embeddedHasGoogleMapsKey(JSON.stringify({ extra: { hasGoogleMapsKey: false } })), false);
  });

  it('iOS 처럼 객체로 와도 읽는다', () => {
    assert.equal(embeddedHasGoogleMapsKey({ extra: { hasGoogleMapsKey: true } }), true);
    assert.equal(embeddedHasGoogleMapsKey({ extra: {} }), false);
  });

  it('true 가 아닌 값·깨진 값·없는 값은 모두 키 없음(목록 폴백)', () => {
    assert.equal(embeddedHasGoogleMapsKey({ extra: { hasGoogleMapsKey: 'true' } }), false);
    assert.equal(embeddedHasGoogleMapsKey({ extra: { hasGoogleMapsKey: 1 } }), false);
    assert.equal(embeddedHasGoogleMapsKey('{not json'), false);
    assert.equal(embeddedHasGoogleMapsKey(null), false);
    assert.equal(embeddedHasGoogleMapsKey(undefined), false);
    assert.equal(embeddedHasGoogleMapsKey({}), false);
    assert.equal(embeddedHasGoogleMapsKey({ extra: null }), false);
    assert.equal(embeddedHasGoogleMapsKey(42), false);
  });
});
