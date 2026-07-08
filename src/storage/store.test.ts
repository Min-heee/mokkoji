import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeSession, normalizeStoredSessions } from './store';

const healthy = (id: string) => ({
  id,
  title: `모임 ${id}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  type: 'moim',
  people: [{ id: 'p1', name: '가' }],
  rounds: [
    {
      id: 'r1',
      title: '1차',
      kind: 'meal',
      payerId: 'p1',
      mode: 'even',
      participantIds: ['p1'],
      totalAmount: 10000,
      items: [],
      exemptIds: [],
      currency: 'KRW',
      fxRate: null,
      billedBaseAmount: null,
    },
  ],
  settings: { roundingUnit: 100, baseCurrency: 'KRW' },
  lastFxRates: {},
});

describe('normalizeStoredSessions', () => {
  it('손상된 레코드 하나가 있어도 나머지 세션은 살아남는다', () => {
    // rounds가 객체(배열 아님)인 손상 레코드 — 예전엔 전체 로드가 []로 무너졌고,
    // 이후 디바운스 저장이 빈 목록을 덮어써 멀쩡한 세션까지 사라졌다
    const stored = [healthy('s1'), { id: 's2', rounds: { oops: 1 } }, healthy('s3')];
    const result = normalizeStoredSessions(stored);
    assert.equal(result.length, 3);
    assert.deepEqual(
      result.map((s) => s.id),
      ['s1', 's2', 's3'],
    );
    // 손상 레코드는 안전한 형태로 복구된다
    assert.deepEqual(result[1].rounds, []);
  });

  it('정말 정규화가 불가능한 레코드만 건너뛰고 나머지는 유지한다', () => {
    // createdAt에 toString이 터지는 값 등 어떤 이유로든 normalizeSession이
    // 던지더라도 레코드 단위로 격리된다
    const throwing = {
      id: 's2',
      get title(): string {
        throw new Error('corrupted');
      },
    };
    const result = normalizeStoredSessions([healthy('s1'), throwing, healthy('s3')]);
    assert.deepEqual(
      result.map((s) => s.id),
      ['s1', 's3'],
    );
  });

  it('id 없는 레코드·배열 아닌 입력은 조용히 무시된다', () => {
    assert.deepEqual(normalizeStoredSessions('zzz'), []);
    assert.deepEqual(normalizeStoredSessions({ oops: 1 }), []);
    assert.deepEqual(normalizeStoredSessions(null), []);
    const result = normalizeStoredSessions([null, { title: 'no-id' }, healthy('s1')]);
    assert.deepEqual(
      result.map((s) => s.id),
      ['s1'],
    );
  });
});

describe('normalizeSession', () => {
  it('배열이어야 할 필드가 아니면 빈 배열로 복구해 렌더 크래시를 막는다', () => {
    const s = normalizeSession({
      id: 's1',
      people: { oops: 1 },
      rounds: [
        {
          id: 'r1',
          items: 'zzz',
          participantIds: 42,
          exemptIds: null,
        },
      ],
    } as never);
    assert.deepEqual(s.people, []);
    assert.deepEqual(s.rounds[0].items, []);
    assert.deepEqual(s.rounds[0].participantIds, []);
    assert.deepEqual(s.rounds[0].exemptIds, []);
  });

  it('구버전(통화 개념 이전) 데이터는 KRW/moim으로 정규화된다', () => {
    const s = normalizeSession({
      id: 's1',
      title: '옛 모임',
      people: [{ id: 'p1', name: '가' }],
      rounds: [
        {
          id: 'r1',
          title: '1차',
          payerId: 'p1',
          mode: 'even',
          participantIds: ['p1'],
          totalAmount: 30000,
          items: [],
          exemptIds: [],
        },
      ],
    } as never);
    assert.equal(s.type, 'moim');
    assert.equal(s.settings.roundingUnit, 100);
    assert.equal(s.settings.baseCurrency, 'KRW');
    assert.equal(s.rounds[0].currency, 'KRW');
    assert.equal(s.rounds[0].fxRate, null);
    assert.equal(s.rounds[0].billedBaseAmount, null);
    assert.equal(s.rounds[0].totalAmount, 30000);
  });
});
