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

  it('채널 없는 릴리스 번들에서 fake 는 무조건 off 로 떨어진다', () => {
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

describe('resolveLateBetMode — beta 채널 (P1)', () => {
  const base = { raw: 'fake', isDev: false, isWeb: false, hasKeys: false } as const;

  it('네이티브 릴리스에서 채널이 정확히 beta 면 fake 가 켜진다', () => {
    assert.equal(resolveLateBetMode({ ...base, channel: 'beta' }), 'fake');
    assert.equal(resolveLateBetMode({ ...base, raw: ' Fake ', channel: 'beta' }), 'fake');
  });

  it('불변식: beta 가 아닌 모든 릴리스에서 fake 는 off 다 (production 포함)', () => {
    for (const channel of [
      'production', 'Production', 'PRODUCTION', 'preview', 'development', 'main', 'default',
      'Beta', 'BETA', ' beta', 'beta ', 'beta\n', 'betas', 'beta-2', 'prod-beta', '', null, undefined,
    ]) {
      assert.equal(resolveLateBetMode({ ...base, channel }), 'off', `channel=${JSON.stringify(channel)}`);
      assert.equal(resolveLateBetMode({ ...base, hasKeys: true, channel }), 'off', `channel=${JSON.stringify(channel)} hasKeys`);
    }
  });

  it('웹 릴리스는 채널이 beta 라고 해도 fake 가 아니다 (웹은 __DEV__ 만)', () => {
    assert.equal(resolveLateBetMode({ ...base, isWeb: true, channel: 'beta' }), 'off');
  });

  it('beta 채널이어도 raw 가 fake 가 아니면 fake 가 되지 않는다', () => {
    for (const raw of [undefined, null, '', 'off', 'on', 'FAKEE']) {
      assert.equal(resolveLateBetMode({ ...base, raw, channel: 'beta' }), 'off');
    }
  });

  it('live 규칙은 채널과 무관하다', () => {
    assert.equal(resolveLateBetMode({ ...base, raw: 'live', hasKeys: true, channel: 'beta' }), 'live');
    assert.equal(resolveLateBetMode({ ...base, raw: 'live', hasKeys: false, channel: 'beta' }), 'off');
    assert.equal(resolveLateBetMode({ ...base, raw: 'live', hasKeys: true, channel: 'production' }), 'live');
  });

  it('개발 번들은 채널과 무관하게 fake 를 허용한다 (개발 빌드의 채널은 null)', () => {
    assert.equal(resolveLateBetMode({ ...base, isDev: true, channel: null }), 'fake');
    assert.equal(resolveLateBetMode({ ...base, isDev: true, channel: 'production' }), 'fake');
  });
});
