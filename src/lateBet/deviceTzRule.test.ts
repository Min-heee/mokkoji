import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pickDeviceTz } from './deviceTzRule';

describe('pickDeviceTz', () => {
  it('첫 후보가 알려진 IANA 시간대면 그것을 쓴다', () => {
    assert.equal(pickDeviceTz([() => 'America/Los_Angeles', () => 'Asia/Tokyo']), 'America/Los_Angeles');
    assert.equal(pickDeviceTz([() => '  Asia/Tokyo ']), 'Asia/Tokyo');
  });

  it('null·빈 값·던지는 후보는 건너뛰고 다음 후보로 간다', () => {
    assert.equal(pickDeviceTz([() => null, () => 'Europe/Paris']), 'Europe/Paris');
    assert.equal(pickDeviceTz([() => undefined, () => '', () => 'Europe/Paris']), 'Europe/Paris');
    assert.equal(
      pickDeviceTz([
        () => {
          throw new Error('native module missing');
        },
        () => 'Asia/Seoul',
      ]),
      'Asia/Seoul',
    );
  });

  it('모르는 값(GMT+1 같은 비 IANA·엉터리)은 쓰지 않는다', () => {
    assert.equal(pickDeviceTz([() => 'GMT+1', () => 'Asia/Tokyo']), 'Asia/Tokyo');
    assert.equal(pickDeviceTz([() => 'Mars/Olympus', () => 'Asia/Tokyo']), 'Asia/Tokyo');
  });

  it('전부 실패하면 Asia/Seoul', () => {
    assert.equal(pickDeviceTz([]), 'Asia/Seoul');
    assert.equal(pickDeviceTz([() => null, () => 'nope/nope']), 'Asia/Seoul');
  });
});
