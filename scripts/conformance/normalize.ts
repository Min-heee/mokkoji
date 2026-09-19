/**
 * Conformance — 응답 정규화와 비교.
 *
 * - 시각(…Ms, atMs) → 가상 시각(SQL 은 +offset) − 시나리오 원점, 초 단위. 비교는 ±TIME_TOL_S 허용(두 백엔드의 호출 사이 수 ms).
 * - serverNowMs·원장 createdAtMs·원장 id 는 뺀다(원장은 불변이라 시간 여행으로 옮길 수 없다. 순서는 배열 순서로 남는다).
 * - 약속 id·사용자 id → 라벨, inviteCode → '<code>'(형식만 확인), localAt → meetAtMs·tz 와 맞는지만('ok' / 'BAD:…').
 * - 오류 → { error: 코드 } (+ LB_INSUFFICIENT_POINTS 는 detail = 닉네임).
 */
import { msToLocalAt } from '../../src/domain/tzGuard';
import { LateBetError } from '../../src/lateBet/errors';

export const TIME_TOL_S = 3;
const TIME_KEYS = new Set([
  'meetAtMs',
  'startedAtMs',
  'startMeetAtMs',
  'startableAtMs',
  'closeMs',
  'claimedAtMs',
  'atMs',
  'joinedAtMs',
  'arrivedAtMs',
  'lastSeenMs',
  'updatedAtMs',
]);
const DROP_KEYS = new Set(['serverNowMs', 'createdAtMs']);
const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

export interface NormCtx {
  /** 원본 ms → 가상 ms */
  toVirtual(ms: number): number;
  originMs: number;
  /** 실제 id → 라벨 */
  labels: Map<string, string>;
}

export function normalizeError(e: unknown): unknown {
  if (e instanceof LateBetError) {
    return e.code === 'LB_INSUFFICIENT_POINTS' ? { error: e.code, detail: e.detail } : { error: e.code };
  }
  return { error: 'THROWN', message: e instanceof Error ? e.message : String(e) };
}

export function normalize(v: unknown, ctx: NormCtx, parentKey = ''): unknown {
  if (v === undefined) return 'void';
  if (v === null) return null;
  if (Array.isArray(v)) return v.map((x) => normalize(x, ctx, parentKey));
  if (typeof v === 'string') return ctx.labels.get(v) ?? v;
  if (typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) {
    const x = o[k];
    if (DROP_KEYS.has(k)) continue;
    if (k === 'id' && typeof x === 'number') continue; // 원장 id
    if (TIME_KEYS.has(k) && typeof x === 'number') {
      out[k] = Math.round((ctx.toVirtual(x) - ctx.originMs) / 100) / 10;
      continue;
    }
    if (k === 'inviteCode' && typeof x === 'string') {
      out[k] = CODE_RE.test(x) ? '<code>' : `BAD:${x}`;
      continue;
    }
    if (k === 'localAt' && typeof x === 'string') {
      const meet = o.meetAtMs;
      const tz = o.tz;
      out[k] = typeof meet === 'number' && typeof tz === 'string' && msToLocalAt(meet, tz) === x ? 'ok' : `BAD:${x}`;
      continue;
    }
    out[k] = normalize(x, ctx, k);
  }
  return out;
}

export interface Mismatch {
  path: string;
  fake: unknown;
  sql: unknown;
}

const isTimePath = (path: string) => {
  const last = path.split('.').pop() ?? '';
  return TIME_KEYS.has(last.replace(/\[\d+\]$/, ''));
};

export function compare(fake: unknown, sql: unknown, path = '$', out: Mismatch[] = []): Mismatch[] {
  if (typeof fake === 'number' && typeof sql === 'number' && isTimePath(path)) {
    if (Math.abs(fake - sql) > TIME_TOL_S) out.push({ path, fake, sql });
    return out;
  }
  if (Array.isArray(fake) && Array.isArray(sql)) {
    if (fake.length !== sql.length) {
      out.push({ path: `${path}.length`, fake: fake.length, sql: sql.length });
    }
    const n = Math.min(fake.length, sql.length);
    for (let i = 0; i < n; i++) compare(fake[i], sql[i], `${path}[${i}]`, out);
    return out;
  }
  if (fake && sql && typeof fake === 'object' && typeof sql === 'object' && !Array.isArray(fake) && !Array.isArray(sql)) {
    const f = fake as Record<string, unknown>;
    const s = sql as Record<string, unknown>;
    for (const k of new Set([...Object.keys(f), ...Object.keys(s)])) {
      if (!(k in f)) out.push({ path: `${path}.${k}`, fake: '(없음)', sql: s[k] });
      else if (!(k in s)) out.push({ path: `${path}.${k}`, fake: f[k], sql: '(없음)' });
      else compare(f[k], s[k], `${path}.${k}`, out);
    }
    return out;
  }
  if (JSON.stringify(fake) !== JSON.stringify(sql)) out.push({ path, fake, sql });
  return out;
}

export function short(v: unknown, max = 70): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
