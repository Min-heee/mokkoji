import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pickStoredRaw } from './legacy';

describe('pickStoredRaw (개명 전 키 인계)', () => {
  it('새 키에 값이 있으면 그걸 쓰고 옮기지 않는다', () => {
    assert.deepEqual(pickStoredRaw('[1]', '[2]'), { raw: '[1]', migrated: false });
  });

  it('새 키가 비었고 옛 키에 값이 있으면 옛 값을 쓰고 옮긴다', () => {
    assert.deepEqual(pickStoredRaw(null, '[2]'), { raw: '[2]', migrated: true });
  });

  it('빈 문자열은 값이 없는 것으로 본다', () => {
    assert.deepEqual(pickStoredRaw('', '[2]'), { raw: '[2]', migrated: true });
    assert.deepEqual(pickStoredRaw('', ''), { raw: null, migrated: false });
  });

  it('둘 다 없으면 null', () => {
    assert.deepEqual(pickStoredRaw(null, null), { raw: null, migrated: false });
  });
});
