import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatFxTimestamp,
  FRESH_MS,
  invertRate,
  isFresh,
  parseApiResponse,
  sanitizeSnapshot,
} from './fxRates';

const NOW = 1_780_000_000_000;

function apiBody(rates: Record<string, unknown>, extra?: Record<string, unknown>) {
  return {
    result: 'success',
    time_last_update_unix: 1_779_990_000,
    rates,
    ...extra,
  };
}

describe('invertRate', () => {
  it('KRW→외화 고시를 1외화=X원으로 뒤집는다', () => {
    assert.equal(invertRate(0.106734), 9.3691);
    assert.equal(invertRate(17.242653), 0.057996);
    assert.equal(invertRate(0.000659), 1517.5);
  });

  it('유효하지 않은 값은 null', () => {
    assert.equal(invertRate(0), null);
    assert.equal(invertRate(-1), null);
    assert.equal(invertRate('9.2'), null);
    assert.equal(invertRate(NaN), null);
    assert.equal(invertRate(Infinity), null);
    assert.equal(invertRate(undefined), null);
  });
});

describe('parseApiResponse', () => {
  it('정상 응답: 지원 통화만 뒤집어 담는다', () => {
    const snap = parseApiResponse(
      apiBody({ JPY: 0.106734, USD: 0.000659, XXX: 1.23, KRW: 1 }),
      NOW,
    );
    assert.ok(snap);
    assert.equal(snap.rates.JPY, 9.3691);
    assert.equal(snap.rates.USD, 1517.5);
    assert.equal('XXX' in snap.rates, false);
    assert.equal('KRW' in snap.rates, false);
    assert.equal(snap.publishedAt, 1_779_990_000 * 1000);
    assert.equal(snap.fetchedAt, NOW);
  });

  it('일부 통화가 깨져도 나머지는 살린다', () => {
    const snap = parseApiResponse(apiBody({ JPY: 'bad', USD: 0.000659 }), NOW);
    assert.ok(snap);
    assert.equal('JPY' in snap.rates, false);
    assert.equal(snap.rates.USD, 1517.5);
  });

  it('실패 응답·형태 오류·전멸이면 null', () => {
    assert.equal(parseApiResponse({ result: 'error' }, NOW), null);
    assert.equal(parseApiResponse(null, NOW), null);
    assert.equal(parseApiResponse('nope', NOW), null);
    assert.equal(parseApiResponse(apiBody({ JPY: -1, USD: 0 }), NOW), null);
  });

  it('고시 시각이 없으면 현재 시각으로', () => {
    const snap = parseApiResponse(
      { result: 'success', rates: { JPY: 0.1 } },
      NOW,
    );
    assert.ok(snap);
    assert.equal(snap.publishedAt, NOW);
  });
});

describe('isFresh', () => {
  const snap = { rates: { JPY: 9.2 }, publishedAt: NOW, fetchedAt: NOW };
  it('12시간 이내면 신선', () => {
    assert.equal(isFresh(snap, NOW + FRESH_MS - 1), true);
    assert.equal(isFresh(snap, NOW + FRESH_MS), false);
  });
});

describe('formatFxTimestamp', () => {
  it('M/D HH:mm 형식', () => {
    const d = new Date(2026, 6, 8, 9, 2); // 7/8 09:02 로컬
    assert.equal(formatFxTimestamp(d.getTime()), '7/8 09:02');
  });
  it('잘못된 값은 빈 문자열', () => {
    assert.equal(formatFxTimestamp(NaN), '');
  });
});

describe('sanitizeSnapshot (캐시 검증)', () => {
  it('정상 캐시는 그대로 통과', () => {
    const snap = { rates: { JPY: 9.2 }, publishedAt: NOW - 1000, fetchedAt: NOW - 1000 };
    assert.deepEqual(sanitizeSnapshot(snap, NOW), snap);
  });

  it('미래 fetchedAt(영원히 신선한 캐시)은 거부', () => {
    assert.equal(
      sanitizeSnapshot({ rates: { JPY: 9.2 }, publishedAt: NOW, fetchedAt: NOW + 1 }, NOW),
      null,
    );
  });

  it('비정상 환율은 걸러지고 전멸이면 null', () => {
    const snap = sanitizeSnapshot(
      { rates: { JPY: 'x', USD: -1, THB: 45.5 }, publishedAt: NOW, fetchedAt: NOW },
      NOW,
    );
    assert.ok(snap);
    assert.deepEqual(Object.keys(snap.rates), ['THB']);
    assert.equal(
      sanitizeSnapshot({ rates: { JPY: NaN }, publishedAt: NOW, fetchedAt: NOW }, NOW),
      null,
    );
  });

  it('publishedAt이 깨졌으면 fetchedAt으로 대체', () => {
    const snap = sanitizeSnapshot({ rates: { JPY: 9.2 }, fetchedAt: NOW - 5 }, NOW);
    assert.ok(snap);
    assert.equal(snap.publishedAt, NOW - 5);
  });
});
