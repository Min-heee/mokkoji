import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openPlaceDraft, readPlaceDraft, setPlaceResult, takePlaceResult } from './placePickerShared';

const GANGNAM = { lat: 37.4979, lng: 127.0276, name: '강남역', nameSource: 'search' as const };

describe('placePickerShared 결과 통로 — 출처(owner)', () => {
  it('모임 위치 화면이 남긴 결과는 약속 잡기 폼이 꺼내지 못한다(다음 약속 잡기에 새지 않게)', () => {
    openPlaceDraft({ value: null, radiusM: null, placeName: '' });
    setPlaceResult({ value: GANGNAM, radiusM: null, owner: 'session' });
    assert.equal(takePlaceResult('late'), null);
    // 모임 화면은 꺼낼 수 있고, 한 번만
    assert.deepEqual(takePlaceResult('session'), { value: GANGNAM, radiusM: null, owner: 'session' });
    assert.equal(takePlaceResult('session'), null);
  });

  it('약속 잡기 위치 화면의 결과는 약속 잡기 폼만 꺼낸다', () => {
    setPlaceResult({ value: GANGNAM, radiusM: 150, owner: 'late' });
    assert.equal(takePlaceResult('session'), null);
    assert.equal(takePlaceResult('late')?.radiusM, 150);
    assert.equal(takePlaceResult('late'), null);
  });

  it('출처 없는 결과는 출처를 주고 꺼내는 쪽이 가져가지 않는다', () => {
    setPlaceResult({ value: GANGNAM, radiusM: null });
    assert.equal(takePlaceResult('late'), null);
    assert.equal(takePlaceResult('session'), null);
    // 출처 없이 부르면(옛 호출) 꺼낸다
    assert.notEqual(takePlaceResult(), null);
  });

  it('새 draft 를 열면 남은 결과는 버린다, draft 에는 반경 칩·잠금이 실린다', () => {
    setPlaceResult({ value: GANGNAM, radiusM: 100, owner: 'late' });
    openPlaceDraft({ value: GANGNAM, radiusM: 200, radiusChoices: [50, 100], radiusLocked: true, radiusLockedReason: '잠김', placeName: '강남' });
    assert.equal(takePlaceResult('late'), null);
    const d = readPlaceDraft();
    assert.equal(d.radiusM, 200);
    assert.deepEqual(d.radiusChoices, [50, 100]);
    assert.equal(d.radiusLocked, true);
  });
});
