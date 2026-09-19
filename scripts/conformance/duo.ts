/**
 * Conformance — 같은 시나리오를 두 백엔드에 한 걸음씩(lockstep) 돌리는 러너.
 *
 * 시간 모델
 * - 가상 시각 V = 실제 시각 + offset. SQL 쪽 now() 는 실제 시각이라, 시간 여행은 이 시나리오의 약속들을 conf.shift 로
 *   통째로 과거로 옮기고 offset 을 같은 만큼 올리는 것이다(저장된 시각들의 가상 값은 그대로, '지금'만 앞으로 간다).
 * - 옮기는 양은 60초 배수다: 약속 시각(meet_at)이 분 단위로 유지돼야 localAt 왕복(미루기 등)이 정확하다.
 *   그래서 travelTo(V) 뒤의 실제 가상 시각은 V ± 30초다 — 시나리오는 경계에서 1분 넘게 떨어진 시각만 쓴다.
 * - fakeApi 의 시계는 매 호출 직전에 max(직전 + 3ms, 실제 시각 + offset) 로 맞춘다 → 같은 걸음의 SQL 호출과 수 ms 차이.
 *   (+3ms: 같은 걸음 안의 호출 순서가 joinedAt 동률로 뒤섞이지 않게. SQL 은 트랜잭션마다 now() 가 다르다)
 * - 한 걸음 = SQL 먼저, 그다음 fake. 결과를 정규화해 비교하고 차이를 모은다.
 */
import { createFakeApi, FakeServer } from '../../src/lateBet/fakeApi';
import type { LateBetApi } from '../../src/lateBet/api';
import { createSupabaseApi } from '../../src/lateBet/supabaseApi';
import { msToLocalAt } from '../../src/domain/tzGuard';
import { compare, normalize, normalizeError, type Mismatch } from './normalize';
import type { PgHarness } from './pgBackend';

const MIN = 60_000;

export interface Side {
  kind: 'fake' | 'sql';
  api(user: string): LateBetApi;
  /** 약속 라벨 → 이 백엔드의 id */
  appt(label: string): string;
  code(label: string): string;
  /** createAppointment 결과를 라벨에 묶는다 */
  bind(label: string, a: { id: string; inviteCode: string }): void;
  /** 가상 ms → 이 백엔드가 받을 'YYYY-MM-DDTHH:mm' */
  localAt(virtualMs: number, tz?: string): string;
  /** 이 백엔드의 ms → 가상 ms */
  toVirtual(ms: number): number;
  uid(user: string): string;
  /** 존재하지 않는 약속 id(형식은 이 백엔드의 것) */
  missingAppt: string;
}

export interface StepRecord {
  scenario: string;
  step: string;
  mismatches: Mismatch[];
  fake: unknown;
  sql: unknown;
}

export class Duo {
  offset = 0;
  private fakeNow: number;
  readonly originMs: number;
  readonly server: FakeServer;
  readonly records: StepRecord[] = [];
  private readonly users = new Map<string, string>();
  private readonly sqlAppts = new Map<string, { id: string; code: string }>();
  private readonly fakeAppts = new Map<string, { id: string; code: string }>();
  private readonly sqlApis = new Map<string, LateBetApi>();
  private readonly fakeApis = new Map<string, LateBetApi>();
  readonly fake: Side;
  readonly sql: Side;
  verbose = false;

  constructor(
    readonly name: string,
    readonly scenarioNo: number,
    readonly pg: PgHarness,
  ) {
    this.fakeNow = Date.now();
    this.originMs = Math.floor(Date.now() / MIN) * MIN;
    this.server = new FakeServer({ now: () => this.fakeNow });
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.fake = {
      kind: 'fake',
      api: (u) => self.fakeApi(u),
      appt: (l) => self.get(self.fakeAppts, l).id,
      code: (l) => self.get(self.fakeAppts, l).code,
      bind: (l, a) => self.fakeAppts.set(l, { id: a.id, code: a.inviteCode }),
      localAt: (v, tz = 'Asia/Seoul') => msToLocalAt(v, tz),
      toVirtual: (ms) => ms,
      uid: (u) => self.uid(u),
      missingAppt: 'appt-zzzz',
    };
    this.sql = {
      kind: 'sql',
      api: (u) => self.sqlApi(u),
      appt: (l) => self.get(self.sqlAppts, l).id,
      code: (l) => self.get(self.sqlAppts, l).code,
      bind: (l, a) => self.sqlAppts.set(l, { id: a.id, code: a.inviteCode }),
      localAt: (v, tz = 'Asia/Seoul') => msToLocalAt(v - self.offset, tz),
      toVirtual: (ms) => ms + self.offset,
      uid: (u) => self.uid(u),
      missingAppt: '00000000-0000-4000-8000-00000000dead',
    };
  }

  private get(map: Map<string, { id: string; code: string }>, label: string) {
    const v = map.get(label);
    if (!v) throw new Error(`약속 라벨 ${label} 없음`);
    return v;
  }

  /** 사용자 라벨 → 두 백엔드가 같이 쓰는 uuid */
  uid(label: string): string {
    const u = this.users.get(label);
    if (!u) throw new Error(`사용자 ${label} 없음`);
    return u;
  }

  async addUsers(labels: string[]): Promise<void> {
    for (const l of labels) {
      const idx = this.users.size + 1;
      const id = `c0f00000-0000-4000-8000-${this.scenarioNo.toString(16).padStart(4, '0')}${idx.toString(16).padStart(8, '0')}`;
      this.users.set(l, id);
    }
    await this.pg.createUsers([...this.users.values()]);
  }

  private fakeApi(user: string): LateBetApi {
    let api = this.fakeApis.get(user);
    if (!api) {
      const inner = createFakeApi(this.server, this.uid(user));
      // 매 호출 직전에 가짜 시계를 SQL 과 같은 가상 시각으로
      api = new Proxy(inner, {
        get: (target, prop) => {
          const f = (target as unknown as Record<string | symbol, unknown>)[prop];
          if (typeof f !== 'function') return f;
          return (...args: unknown[]) => {
            this.fakeNow = Math.max(this.fakeNow + 3, Date.now() + this.offset);
            return (f as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      this.fakeApis.set(user, api);
    }
    return api;
  }

  private sqlApi(user: string): LateBetApi {
    let api = this.sqlApis.get(user);
    if (!api) {
      api = createSupabaseApi({ ...this.pg.backendFor(this.uid(user)), clock: null, timeoutMs: 20_000 });
      this.sqlApis.set(user, api);
    }
    return api;
  }

  /** 지금의 가상 시각 */
  vnow(): number {
    return Date.now() + this.offset;
  }

  /** 가상 시각 v 이후 첫 분 경계 */
  minuteAfter(v: number): number {
    return Math.ceil(v / MIN) * MIN;
  }

  /** 가상 시각을 target 근처(±30초)로. 뒤로는 가지 않는다 */
  async travelTo(target: number): Promise<void> {
    const need = target - this.vnow();
    const shift = Math.max(0, Math.round(need / MIN) * MIN);
    if (shift === 0) return;
    await this.pg.shift([...this.sqlAppts.values()].map((a) => a.id), shift);
    this.offset += shift;
  }

  private labelMap(side: 'fake' | 'sql'): Map<string, string> {
    const m = new Map<string, string>();
    for (const [label, v] of side === 'fake' ? this.fakeAppts : this.sqlAppts) m.set(v.id, label);
    for (const [label, uid] of this.users) m.set(uid, label);
    return m;
  }

  /**
   * 한 걸음: SQL → fake 순서로 같은 동작. 결과(또는 오류)를 정규화해 비교한다.
   * fn 이 값을 돌려주면 그 값을, 던지면 오류 코드를 비교한다. 두 백엔드의 원시 결과를 돌려준다.
   */
  async step<T>(label: string, fn: (s: Side) => Promise<T>): Promise<{ fake: T | undefined; sql: T | undefined }> {
    const run = async (s: Side) => {
      try {
        const v = await fn(s);
        return { ok: true as const, v, n: normalize(v, { toVirtual: s.toVirtual, originMs: this.originMs, labels: this.labelMap(s.kind) }) };
      } catch (e) {
        return { ok: false as const, v: undefined, n: normalizeError(e) };
      }
    };
    const sql = await run(this.sql);
    const fake = await run(this.fake);
    const mismatches = compare(fake.n, sql.n);
    this.records.push({ scenario: this.name, step: label, mismatches, fake: fake.n, sql: sql.n });
    if (this.verbose || process.env.CONF_VERBOSE) {
      console.log(`[${this.name}] ${label}: ${mismatches.length === 0 ? 'same' : `${mismatches.length} diff`}`);
      if (process.env.CONF_VERBOSE === '2') console.log('  fake', JSON.stringify(fake.n), '\n  sql ', JSON.stringify(sql.n));
    }
    return { fake: fake.v, sql: sql.v };
  }

  /** 끝: 두 백엔드의 불변식 감사가 비어 있어야 한다 */
  async audits(): Promise<void> {
    const fakeProblems = this.server.audit().map((p) => `${p.problem} ${p.detail}`);
    const sqlProblems = await this.pg.audit();
    const sqlSettle = await this.pg.settleErrors();
    const fakeSettle = this.server.settleErrors().map((x) => x.message);
    const mismatches: Mismatch[] = [];
    if (fakeProblems.length > 0 || sqlProblems.length > 0) mismatches.push({ path: 'audit', fake: fakeProblems, sql: sqlProblems });
    if (fakeSettle.length > 0 || sqlSettle.length > 0) mismatches.push({ path: 'settleErrors', fake: fakeSettle, sql: sqlSettle });
    this.records.push({ scenario: this.name, step: '감사(audit·settle_errors)', mismatches, fake: fakeProblems, sql: sqlProblems });
  }
}
