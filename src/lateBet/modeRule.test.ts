import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveLateBetMode } from './modeRule';

describe('resolveLateBetMode', () => {
  it('값이 없으면 off — 기존 앱은 달라지지 않는다', () => {
    for (const raw of [undefined, null, '', 'on', 'true', 'FAKEE']) {
      assert.equal(resolveLateBetMode({ raw, isDev: true, isWeb: false, hasKeys: true }), 'off');
    }
  });

  it('fake 는 개발 번들에서만 켜진다 (웹 프리뷰 포함)', () => {
    assert.equal(resolveLateBetMode({ raw: 'fake', isDev: true, isWeb: false, hasKeys: false }), 'fake');
    assert.equal(resolveLateBetMode({ raw: 'fake', isDev: true, isWeb: true, hasKeys: false }), 'fake');
    assert.equal(resolveLateBetMode({ raw: ' FAKE ', isDev: true, isWeb: true, hasKeys: false }), 'fake');
  });

  it('릴리스 번들에서 fake 는 무조건 off 로 떨어진다', () => {
    assert.equal(resolveLateBetMode({ raw: 'fake', isDev: false, isWeb: false, hasKeys: true }), 'off');
    assert.equal(resolveLateBetMode({ raw: 'fake', isDev: false, isWeb: true, hasKeys: true }), 'off');
  });

  it('live 는 웹이 아니고 키가 있을 때만', () => {
    assert.equal(resolveLateBetMode({ raw: 'live', isDev: false, isWeb: false, hasKeys: true }), 'live');
    assert.equal(resolveLateBetMode({ raw: 'live', isDev: true, isWeb: false, hasKeys: true }), 'live');
    assert.equal(resolveLateBetMode({ raw: 'live', isDev: false, isWeb: false, hasKeys: false }), 'off');
    assert.equal(resolveLateBetMode({ raw: 'live', isDev: false, isWeb: true, hasKeys: true }), 'off');
  });
});
