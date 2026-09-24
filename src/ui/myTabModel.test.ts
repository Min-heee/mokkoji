import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appInfoRows,
  balanceLine,
  isNativePlatform,
  locationPermissionLabel,
  mySections,
  NO_NICKNAME,
  nicknameLine,
  profileCardState,
  notificationPermissionLabel,
  summaryLine,
} from './myTabModel';

describe('mySections', () => {
  it('모드 off: 이름·포인트·권한 전부 숨긴다(권한 API 호출 0)', () => {
    for (const platform of ['ios', 'android', 'web']) {
      assert.deepEqual(mySections({ lateEnabled: false, lateMode: 'off', platform }), { profile: false, permissions: false });
    }
  });
  it('켜짐 + 네이티브: 이름·포인트·권한 모두', () => {
    assert.deepEqual(mySections({ lateEnabled: true, lateMode: 'live', platform: 'ios' }), { profile: true, permissions: true });
    assert.deepEqual(mySections({ lateEnabled: true, lateMode: 'fake', platform: 'android' }), { profile: true, permissions: true });
  });
  it('켜짐 + 웹(앱인토스 포함): 권한 절은 없다', () => {
    assert.deepEqual(mySections({ lateEnabled: true, lateMode: 'live', platform: 'web' }), { profile: true, permissions: false });
  });
  it('isNativePlatform', () => {
    assert.equal(isNativePlatform('ios'), true);
    assert.equal(isNativePlatform('android'), true);
    assert.equal(isNativePlatform('web'), false);
    assert.equal(isNativePlatform('windows'), false);
  });
});

describe('nicknameLine · balanceLine', () => {
  it('닉네임이 없거나 공백이면 안내 문구', () => {
    assert.equal(nicknameLine(null), NO_NICKNAME);
    assert.equal(nicknameLine(undefined), NO_NICKNAME);
    assert.equal(nicknameLine('  '), NO_NICKNAME);
    assert.equal(nicknameLine(' 민수 '), '민수');
  });
  it('잔액: 숫자면 천 단위 P, 모르면 null', () => {
    assert.equal(balanceLine(1000), '1,000P');
    assert.equal(balanceLine(0), '0P');
    assert.equal(balanceLine(null), null);
    assert.equal(balanceLine(undefined), null);
    assert.equal(balanceLine(Number.NaN), null);
  });
});

describe('권한 라벨', () => {
  it('위치', () => {
    assert.equal(locationPermissionLabel(null), '확인 중');
    assert.equal(locationPermissionLabel({ status: 'granted', precise: true, canAskAgain: true }), '허용됨');
    assert.equal(locationPermissionLabel({ status: 'granted', precise: null, canAskAgain: true }), '허용됨');
    assert.equal(locationPermissionLabel({ status: 'granted', precise: false, canAskAgain: true }), '대략적인 위치만 허용');
    assert.equal(locationPermissionLabel({ status: 'undetermined', precise: null, canAskAgain: true }), '아직 묻지 않았어요');
    assert.equal(locationPermissionLabel({ status: 'denied', precise: null, canAskAgain: true }), '허용 안 함');
    assert.match(locationPermissionLabel({ status: 'blocked', precise: null, canAskAgain: false }), /설정/);
    assert.equal(locationPermissionLabel({ status: 'unavailable', precise: null, canAskAgain: false }), '이 기기에서는 쓸 수 없어요');
  });
  it('알림', () => {
    assert.equal(notificationPermissionLabel(null), '확인 중');
    assert.equal(notificationPermissionLabel('granted'), '허용됨');
    assert.equal(notificationPermissionLabel('undetermined'), '아직 묻지 않았어요');
    assert.equal(notificationPermissionLabel('denied'), '허용 안 함');
    assert.equal(notificationPermissionLabel('unsupported'), '이 기기에서는 쓸 수 없어요');
  });
});

describe('appInfoRows', () => {
  it('버전 + 빌드 + 업데이트 앞 8자', () => {
    assert.deepEqual(appInfoRows({ version: '0.4.0', buildNumber: '7', updateId: 'cb66eb2b-1234-5678-9abc-def012345678' }), [
      { label: '버전', value: '0.4.0 (빌드 7)' },
      { label: '업데이트', value: 'cb66eb2b' },
    ]);
  });
  it('빌드 번호가 숫자여도 된다', () => {
    assert.deepEqual(appInfoRows({ version: '0.4.0', buildNumber: 12, updateId: null }), [{ label: '버전', value: '0.4.0 (빌드 12)' }]);
  });
  it('웹·개발: 빌드·업데이트가 없으면 생략', () => {
    assert.deepEqual(appInfoRows({ version: '0.4.0', buildNumber: null, updateId: null }), [{ label: '버전', value: '0.4.0' }]);
    assert.deepEqual(appInfoRows({ version: '0.4.0', buildNumber: '', updateId: '  ' }), [{ label: '버전', value: '0.4.0' }]);
  });
  it('버전을 모르면 빌드만, 둘 다 모르면 빈 목록', () => {
    assert.deepEqual(appInfoRows({ version: undefined, buildNumber: '7', updateId: undefined }), [{ label: '빌드', value: '7' }]);
    assert.deepEqual(appInfoRows({ version: null, buildNumber: null, updateId: null }), []);
  });
});

describe('summaryLine', () => {
  it('모임·친구 수', () => {
    assert.equal(summaryLine(3, 5), '모임 3개 · 친구 5명');
    assert.equal(summaryLine(0, 0), '모임 0개 · 친구 0명');
  });
});

describe('profileCardState(이름·포인트 카드가 말할 수 있는 것)', () => {
  it('프로필이 있으면 상태와 상관없이 ready', () => {
    for (const status of ['loading', 'ready', 'error', 'idle']) {
      for (const stale of [false, true]) assert.equal(profileCardState({ hasProfile: true, status, stale }), 'ready');
    }
  });
  it("첫 불러오기 중에는 '아직 정하지 않았어요'라고 단정하지 않는다", () => {
    assert.equal(profileCardState({ hasProfile: false, status: 'loading', stale: false }), 'checking');
  });
  it('이번 실행에서 한 번도 못 불러온 채 실패(비행기 모드 콜드 스타트) → 연결 안내, 1,000P 안내 없음', () => {
    assert.equal(profileCardState({ hasProfile: false, status: 'error', stale: false }), 'unreachable');
  });
  it('불러왔는데 프로필이 없다 → 아직 정하지 않았어요', () => {
    assert.equal(profileCardState({ hasProfile: false, status: 'ready', stale: false }), 'none');
    assert.equal(profileCardState({ hasProfile: false, status: 'idle', stale: false }), 'none');
    // 한 번 불러와서 프로필이 없다는 걸 안 뒤의 오류(stale)
    assert.equal(profileCardState({ hasProfile: false, status: 'error', stale: true }), 'none');
  });
});
