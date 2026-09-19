import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { newRequestId } from './requestId';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newRequestId — 생성 멱등 키', () => {
  it('uuid v4 모양(서버 p_request_id uuid 로 캐스트된다)이고 매번 다르다', () => {
    const a = newRequestId();
    const b = newRequestId();
    assert.match(a, UUID_V4);
    assert.match(b, UUID_V4);
    assert.notEqual(a, b);
  });

  it('crypto 가 없는 환경(Math.random 대체)에서도 v4 모양', () => {
    let x = 0;
    const id = newRequestId(() => ((x = (x * 9301 + 49297) % 233280) / 233280));
    assert.match(id, UUID_V4);
  });
});
