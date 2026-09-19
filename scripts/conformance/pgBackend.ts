/**
 * Conformance — 로컬 PostgreSQL 에 supabaseApi 를 꽂는 어댑터(PostgREST 흉내).
 *
 * - 호출마다 새 트랜잭션: `set local role authenticated` + `set_config('request.jwt.claim.sub', <uid>, true)`
 *   (supabase/tests/stub.sql 의 auth.uid() 가 읽는 설정) → `select to_jsonb(public.<fn>(p_x => $1::<type>, …))`.
 * - 인자 타입·반환 타입은 pg_proc 에서 읽는다. PostgREST 처럼 없는 함수·없는 인자 이름은 PGRST202.
 * - 오류는 PostgREST 모양 { code, message, details, hint } 로 감싼다 → supabaseApi 의 mapRpcError 가 실제 오류로 검증된다.
 * - 반환: jsonb 는 그대로, 복합 타입(lb_ensure_profile → public.profiles)은 to_jsonb 로 행 객체(snake_case), void 는 null.
 *
 * 시간 여행(shift): 운영 SQL 은 now() 만 쓰므로 바꾸지 않는다. 슈퍼유저 커넥션으로 conf.shift(약속들, d) 가 그 약속들의
 * 모든 시각 컬럼(약속·참가자·명단·좌표·차단·공유 기록·changes jsonb)을 d 만큼 과거로 옮긴다 = 그 약속들에게는 d 만큼 미래로 간 세상.
 * 원장(ledger)은 불변 트리거 때문에 옮기지 않는다(비교에서 createdAtMs 를 뺀다).
 */
import pg from 'pg';
import type { LbLiveBackend, LbRpc, LbWireResult } from '../../src/lateBet/supabaseApi';

export interface ProcMeta {
  args: Map<string, string>;
  /** 'void' | 'jsonb' | 복합 등 */
  ret: string;
  retIsComposite: boolean;
}

export class PgHarness {
  readonly pool: pg.Pool;
  private meta = new Map<string, ProcMeta>();

  constructor() {
    this.pool = new pg.Pool({ max: 4 });
  }

  async init(): Promise<void> {
    const r = await this.pool.query<{ proname: string; names: string[] | null; types: string[]; ret: string; typtype: string }>(
      `select p.proname, p.proargnames as names,
              array(select format_type(t, null) from unnest(p.proargtypes::oid[]) t) as types,
              format_type(p.prorettype, null) as ret, ty.typtype
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_type ty on ty.oid = p.prorettype
        where n.nspname = 'public' and p.proname like 'lb\\_%'`,
    );
    for (const row of r.rows) {
      const args = new Map<string, string>();
      row.types.forEach((t, i) => args.set(row.names?.[i] ?? `$${i + 1}`, t));
      this.meta.set(row.proname, { args, ret: row.ret, retIsComposite: row.typtype === 'c' });
    }
    await this.pool.query(SHIFT_SQL);
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  async createUsers(ids: string[]): Promise<void> {
    await this.pool.query(`insert into auth.users (id, is_anonymous) select unnest($1::uuid[]), true on conflict do nothing`, [ids]);
  }

  /** 슈퍼유저: 약속들의 시각을 ms 만큼 과거로(= 그 약속들에게 시간이 ms 흐름) */
  async shift(apptIds: string[], ms: number): Promise<void> {
    if (apptIds.length === 0 || ms === 0) return;
    await this.pool.query(`select conf.shift($1::uuid[], $2::bigint)`, [apptIds, ms]);
  }

  async audit(): Promise<string[]> {
    const r = await this.pool.query<{ problem: string; ref: string; detail: string }>('select * from private.lb_audit()');
    return r.rows.map((x) => `${x.problem} ${x.ref} ${x.detail}`);
  }

  async settleErrors(): Promise<string[]> {
    const r = await this.pool.query<{ message: string }>('select message from private.lb_settle_errors order by id');
    return r.rows.map((x) => x.message);
  }

  private wrapError(e: unknown): LbWireResult {
    const o = (e ?? {}) as { code?: string; message?: string; detail?: string; hint?: string };
    return { data: null, error: { code: o.code ?? '', message: o.message ?? String(e), details: o.detail ?? null, hint: o.hint ?? null } };
  }

  /** authenticated 롤 + jwt sub 로 한 트랜잭션 */
  private async asUser<T>(uid: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role authenticated');
      await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  rpcFor(uid: string): LbRpc {
    return async (fn, args) => {
      const m = this.meta.get(fn);
      if (!m) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn}`, details: null, hint: null } };
      const parts: string[] = [];
      const values: unknown[] = [];
      for (const [k, v] of Object.entries(args)) {
        const t = m.args.get(k);
        if (!t) return { data: null, error: { code: 'PGRST202', message: `public.${fn} has no argument ${k}`, details: null, hint: null } };
        values.push(v === undefined ? null : t === 'jsonb' || t === 'json' ? (v === null ? null : JSON.stringify(v)) : v);
        parts.push(`${k} => $${values.length}::${t}`);
      }
      const call = `public.${fn}(${parts.join(', ')})`;
      const sql = m.ret === 'void' ? `select ${call}` : `select to_jsonb(${call}) as r`;
      try {
        const data = await this.asUser(uid, async (c) => {
          const res = await c.query(sql, values);
          return m.ret === 'void' ? null : (res.rows[0]?.r ?? null);
        });
        return { data, error: null };
      } catch (e) {
        return this.wrapError(e);
      }
    };
  }

  backendFor(uid: string): LbLiveBackend {
    return {
      rpc: this.rpcFor(uid),
      ensureSession: async () => uid,
      requireSession: async () => uid,
      restoreSession: async () => uid,
      query: {
        profile: async () => {
          try {
            const rows = await this.asUser(uid, async (c) => (await c.query('select user_id, nickname, balance from public.profiles')).rows);
            if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows', details: null, hint: null } };
            return { data: rows[0] ?? null, error: null };
          } catch (e) {
            return this.wrapError(e);
          }
        },
      },
    };
  }
}

/** 테스트 전용 스키마(운영 마이그레이션 밖). 슈퍼유저만 부른다 */
const SHIFT_SQL = `
create schema if not exists conf;
revoke all on schema conf from public;
create or replace function conf.shift_snap(s jsonb, d bigint) returns jsonb language sql immutable as $$
  select case when s is null or s->'meetAtMs' is null then s else
    s || jsonb_build_object('meetAtMs', (s->>'meetAtMs')::bigint - d,
      'localAt', to_char(to_timestamp(((s->>'meetAtMs')::bigint - d) / 1000.0) at time zone (s->>'tz'), 'YYYY-MM-DD"T"HH24:MI')) end $$;
create or replace function conf.shift_changes(c jsonb, d bigint) returns jsonb language sql immutable as $$
  select coalesce((select jsonb_agg(e || jsonb_build_object('atMs', (e->>'atMs')::bigint - d,
                     'before', conf.shift_snap(e->'before', d), 'after', conf.shift_snap(e->'after', d)) order by o)
                     from jsonb_array_elements(c) with ordinality t(e, o)), '[]'::jsonb) $$;
create or replace function conf.shift(p_appts uuid[], p_ms bigint) returns void language plpgsql as $$
declare d interval := make_interval(secs => p_ms / 1000.0);
begin
  update public.appointments set meet_at = meet_at - d, started_at = started_at - d, close_at = close_at - d,
         settled_at = settled_at - d, created_at = created_at - d,
         start_meet_at = start_meet_at - d, material_changed_at = material_changed_at - d,
         local_at = to_char((meet_at - d) at time zone tz, 'YYYY-MM-DD"T"HH24:MI'),
         changes = conf.shift_changes(changes, p_ms)
   where id = any(p_appts);
  update public.participants set joined_at = joined_at - d, consented_at = consented_at - d,
         arrived_at = arrived_at - d, first_near_at = first_near_at - d where appointment_id = any(p_appts);
  update public.invitees set claimed_at = claimed_at - d where appointment_id = any(p_appts);
  update public.locations set updated_at = updated_at - d where appointment_id = any(p_appts);
  update private.lb_bans set at = at - d where appointment_id = any(p_appts);
  update private.lb_share_log set first_at = first_at - d, last_at = last_at - d where appointment_id = any(p_appts);
end $$;
`;
