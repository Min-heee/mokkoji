import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canReadLocation, toPermissionState, toReporterPermission, UNAVAILABLE_PERMISSION } from './permissionRule';

describe('permissionRule 권한 해석', () => {
  it('허용 + 안드로이드 fine → 정확, coarse → 대략적, iOS(정보 없음) → precise null', () => {
    assert.deepEqual(toPermissionState({ status: 'granted', granted: true, canAskAgain: true, android: { accuracy: 'fine' } }), {
      status: 'granted',
      precise: true,
      canAskAgain: true,
    });
    assert.equal(toPermissionState({ status: 'granted', granted: true, canAskAgain: true, android: { accuracy: 'coarse' } }).precise, false);
    assert.equal(toPermissionState({ status: 'granted', granted: true, canAskAgain: true, ios: { scope: 'whenInUse' } }).precise, null);
  });

  it('거부: 다시 물을 수 있으면 denied, 없으면 blocked', () => {
    assert.equal(toPermissionState({ status: 'denied', granted: false, canAskAgain: true }).status, 'denied');
    assert.equal(toPermissionState({ status: 'denied', granted: false, canAskAgain: false }).status, 'blocked');
  });

  it('아직 안 물음 → undetermined (다시 물을 수 없으면 blocked)', () => {
    assert.equal(toPermissionState({ status: 'undetermined', granted: false, canAskAgain: true }).status, 'undetermined');
    assert.equal(toPermissionState({ status: 'undetermined', granted: false, canAskAgain: false }).status, 'blocked');
  });

  it('응답이 없으면 unavailable', () => {
    assert.deepEqual(toPermissionState(null), UNAVAILABLE_PERMISSION);
    assert.equal(canReadLocation(UNAVAILABLE_PERMISSION), false);
  });

  it('화면용 한 단어: blocked 는 denied 로 접고, 대략적 위치·샘플 1000m 초과는 coarse', () => {
    assert.equal(toReporterPermission({ status: 'granted', precise: true, canAskAgain: true }), 'granted');
    assert.equal(toReporterPermission({ status: 'granted', precise: null, canAskAgain: true }), 'granted');
    assert.equal(toReporterPermission({ status: 'granted', precise: false, canAskAgain: true }), 'coarse');
    assert.equal(toReporterPermission({ status: 'granted', precise: null, canAskAgain: true }, true), 'coarse');
    assert.equal(toReporterPermission({ status: 'blocked', precise: null, canAskAgain: false }), 'denied');
    assert.equal(toReporterPermission({ status: 'denied', precise: null, canAskAgain: true }), 'denied');
    assert.equal(toReporterPermission({ status: 'undetermined', precise: null, canAskAgain: true }), 'undetermined');
    assert.equal(toReporterPermission(UNAVAILABLE_PERMISSION), 'unsupported');
    assert.equal(toReporterPermission(null), 'undetermined');
  });

  it('위치를 읽어도 되는 것은 허용(정확·대략)뿐', () => {
    assert.equal(canReadLocation({ status: 'granted', precise: false, canAskAgain: true }), true);
    assert.equal(canReadLocation({ status: 'denied', precise: null, canAskAgain: true }), false);
    assert.equal(canReadLocation(null), false);
  });
});
