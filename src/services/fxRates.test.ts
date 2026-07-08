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

describe('formatFxTimestamp (한국시간 고정)', () => {
  // API 고시: 2026-07-08 00:02 UTC = 한국시간 7/8 09:02
  const published = Date.UTC(2026, 6, 8, 0, 2, 32);

  it('같은 날(KST)이면 "오늘 09:02"', () => {
    const now = Date.UTC(2026, 6, 8, 11, 21); // KST 7/8 20:21
    assert.equal(formatFxTimestamp(published, now), '오늘 09:02');
  });

  it('하루 지나면 "어제 09:02"', () => {
    const now = Date.UTC(2026, 6, 9, 3, 0); // KST 7/9 12:00
    assert.equal(formatFxTimestamp(published, now), '어제 09:02');
  });

  it('더 오래되면 "7/8 09:02"', () => {
    const now = Date.UTC(2026, 6, 12, 3, 0);
    assert.equal(formatFxTimestamp(published, now), '7/8 09:02');
  });

  it('날짜 경계는 기기 시간대가 아니라 KST 기준', () => {
    // UTC 7/8 16:30 = KST 7/9 01:30 — UTC 기준으론 아직 7/8이지만 KST로는 다음날
    const lateNight = Date.UTC(2026, 6, 8, 16, 30);
    const now = Date.UTC(2026, 6, 8, 17, 0); // KST 7/9 02:00
    assert.equal(formatFxTimestamp(lateNight, now), '오늘 01:30');
  });

  it('잘못된 값은 빈 문자열', () => {
    assert.equal(formatFxTimestamp(NaN, Date.UTC(2026, 6, 8)), '');
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
