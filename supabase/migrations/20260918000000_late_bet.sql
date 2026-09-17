-- supabase/migrations/20260918000000_late_bet.sql
-- 약속 내기(late bet) 1차: 테이블 + RLS + RPC. Edge Function·Realtime·pg_cron 없음.
-- 원칙: 클라이언트는 테이블에 직접 쓰지 못한다(SELECT 정책만). 모든 쓰기는 아래 RPC.

-- ───────────────────────── 0. 기본 권한 잠그기 (Supabase 'Hardening the Data API' 문서의 문장 그대로) ─────────────────────────
alter default privileges for role postgres in schema public revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke usage, select on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke execute on functions from public;

create schema if not exists private;
grant usage on schema private to authenticated;   -- RLS 정책이 private.lb_is_member 를 부르기 때문. 함수 EXECUTE 는 맨 끝에서 개별 통제.

-- ───────────────────────── 1. 테이블 ─────────────────────────
create table public.profiles (
  user_id    uuid primary key references auth.users(id) on delete restrict,   -- 원장 보존: 계정 삭제는 lb_delete_me(P6)로만
  nickname   text not null check (char_length(nickname) between 1 and 12),
  balance    integer not null default 0 check (balance >= 0),                 -- 원장의 캐시. 음수는 DB가 거부
  created_at timestamptz not null default now()
);

create table public.appointments (
  id               uuid primary key default gen_random_uuid(),
  invite_code      text not null unique,             -- 31자 알파벳(0/O/1/I/L 제외) × 8
  host_id          uuid not null references public.profiles(user_id),
  title            text not null check (char_length(title) between 1 and 40),
  local_at         text not null check (local_at ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),  -- 표시용 벽시계. 서버가 meet_at 에서 다시 써 넣는다
  tz               text not null,                    -- IANA
  meet_at          timestamptz not null,             -- 마감 = 참여·승인 마감
  place_name       text not null check (char_length(place_name) between 1 and 60),
  place_note       text not null default '' check (char_length(place_note) <= 200),
  place_lat        double precision not null check (place_lat between -90 and 90),
  place_lng        double precision not null check (place_lng between -180 and 180),
  stake            integer not null check (stake between 0 and 300),
  radius_m         integer not null default 100 check (radius_m between 30 and 1000),
  unit_minutes     integer not null default 5 check (unit_minutes between 1 and 60),
  penalty_per_unit integer not null default 0 check (penalty_per_unit between 0 and 300),
  grace_minutes    integer not null default 0 check (grace_minutes between 0 and 30),
  share_minutes_before integer not null default 60 check (share_minutes_before between 30 and 360),
  share_start_at   timestamptz not null,             -- 위치 공개 시작 = 체크인 개시 = 잠금
  close_at         timestamptz not null,             -- 이 시각을 넘겨 도착하면 전액 몰수(=노쇼와 같은 금액). 체크인·위치 공개 종료
  join_closed      boolean not null default false,   -- 주최자가 '참여 마감'을 눌렀는가
  status           text not null default 'open' check (status in ('open','settled','voided','canceled')),
  void_reason      text,
  settled_at       timestamptz,
  version          integer not null default 1,       -- 제목·메모 외의 어떤 값이든 바뀌면 +1 (peek→join 사이 변경 감지)
  created_at       timestamptz not null default now(),
  constraint policy_reaches_full_within_cap check (  -- "179분 지각 −179P, 181분 지각 전액" 같은 절벽 금지
    penalty_per_unit = 0 or stake = 0 or
    (ceil(stake::numeric / penalty_per_unit) - 1) * unit_minutes + grace_minutes <= 180)
);
create index appointments_open_close_idx on public.appointments (close_at) where status = 'open';
create index appointments_host_open_idx  on public.appointments (host_id) where status = 'open';

create table public.participants (
  appointment_id uuid not null references public.appointments(id) on delete restrict,
  user_id        uuid not null references public.profiles(user_id),
  nickname       text not null check (char_length(nickname) between 1 and 12),
  state          text not null default 'active' check (state in ('active','pending')),  -- pending = 잠금 후 참여 요청(주최자 승인 전). hold 없음·위치 열람 없음
  joined_at      timestamptz not null default now(), -- (joined_at, user_id) = 엔진 participantIds 순서. 승인 시 승인 시각으로 갱신
  consented_at   timestamptz not null default now(), -- 위치 제공 동의 + 만 14세 이상 확인 시각
  first_near_at  timestamptz,                        -- 정확도 미달이지만 '오차를 빼면 반경 안'이었던 첫 서버 시각(보증 도착의 시각 근거)
  arrived_at     timestamptz,                        -- 서버 now(), ms 절삭. 최초 1회
  arrival_method text check (arrival_method in ('gps','vouch')),
  arrival_distance_m integer,
  arrival_accuracy_m integer,
  vouched_by     uuid,
  result_status  text check (result_status in ('onTime','late','noShow')),
  forfeited      integer,
  received       integer,
  primary key (appointment_id, user_id),
  check ((arrived_at is null) = (arrival_method is null)),
  check (state = 'active' or arrived_at is null)
);
create index participants_user_idx on public.participants (user_id);

create table public.locations (                      -- 사람당 최신 1행. 궤적 없음. 직접 조회 불가
  appointment_id uuid not null,
  user_id        uuid not null,
  lat            double precision not null,
  lng            double precision not null,
  accuracy_m     real,
  updated_at     timestamptz not null default now(),
  primary key (appointment_id, user_id),
  foreign key (appointment_id, user_id) references public.participants(appointment_id, user_id) on delete cascade
);
create index locations_updated_idx on public.locations (updated_at);

create table public.ledger (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references public.profiles(user_id) on delete restrict,
  appointment_id uuid references public.appointments(id) on delete restrict,
  kind           text not null check (kind in ('grant','relief','hold','refund','payout')),
  amount         integer not null,
  balance_after  integer not null check (balance_after >= 0),
  meta           jsonb not null default '{}'::jsonb, -- reason: signup | topup | leave | canceled | kicked | policy_change, anon: 익명 계정 여부
  created_at     timestamptz not null default now(),
  check ((kind in ('grant','relief')) = (appointment_id is null)),
  check ((kind = 'hold') = (amount < 0))
);
create index ledger_user_idx on public.ledger (user_id, id desc);
create index ledger_appt_idx on public.ledger (appointment_id);
create unique index ledger_one_payout on public.ledger (appointment_id, user_id) where kind = 'payout';
create unique index ledger_one_grant  on public.ledger (user_id) where kind = 'grant';

create table private.lb_bans (                       -- 강퇴·거절하며 차단한 계정
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  user_id        uuid not null,
  at             timestamptz not null default now(),
  primary key (appointment_id, user_id)
);

create table private.lb_share_log (                  -- 위치 제공 사실 기록(좌표 없음): 누가(subject) 누구에게(viewer) 언제
  appointment_id uuid not null,
  viewer_id      uuid not null,
  subject_id     uuid not null,
  first_at       timestamptz not null default now(),
  last_at        timestamptz not null default now(),
  primary key (appointment_id, viewer_id, subject_id)
);

create table private.lb_settle_errors (              -- 정산 시도가 실패하면 여기에 남는다(조회·도착 기록은 계속 성공)
  id bigint generated always as identity primary key,
  appointment_id uuid, message text, at timestamptz not null default now()
);

create table private.lb_config (                     -- 1행짜리: keepalive 흔적 + 설치 링크·최소 빌드
  id           int primary key default 1 check (id = 1),
  heartbeat_at timestamptz not null default now(),
  min_build    int  not null default 0,
  ios_url      text not null default '',
  android_url  text not null default ''
);
insert into private.lb_config (id) values (1);

create function private.lb_forbid() returns trigger language plpgsql as
$$ begin raise exception 'LB_LEDGER_IMMUTABLE'; end $$;
create trigger ledger_no_mutation before update or delete on public.ledger for each row       execute function private.lb_forbid();
create trigger ledger_no_truncate before truncate          on public.ledger for each statement execute function private.lb_forbid();

-- ───────────────────────── 2. RLS ─────────────────────────
alter table public.profiles     enable row level security;
alter table public.appointments enable row level security;
alter table public.participants enable row level security;
alter table public.locations    enable row level security;
alter table public.ledger       enable row level security;
alter table private.lb_bans          enable row level security;
alter table private.lb_share_log     enable row level security;
alter table private.lb_settle_errors enable row level security;
alter table private.lb_config        enable row level security;

create function private.lb_is_member(p_appt uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.participants
                 where appointment_id = p_appt and user_id = (select auth.uid()));
$$;
create function private.lb_is_active_member(p_appt uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.participants
                 where appointment_id = p_appt and user_id = (select auth.uid()) and state = 'active');
$$;

create policy profiles_select_own        on public.profiles     for select to authenticated using (user_id = (select auth.uid()));
create policy appointments_select_member on public.appointments for select to authenticated using ((select private.lb_is_member(id)));
create policy participants_select_member on public.participants for select to authenticated
  using (user_id = (select auth.uid()) or (select private.lb_is_active_member(appointment_id)));
create policy ledger_select_own          on public.ledger       for select to authenticated using (user_id = (select auth.uid()));
-- locations 와 private.* 테이블: 정책 없음 = 직접 조회 불가.

-- ───────────────────────── 3. 순수 함수(엔진의 SQL 쌍둥이) ─────────────────────────
create function private.lb_haversine_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
returns float8 language sql immutable as $$
  select 2 * 6371008.8 * asin(sqrt(least(1, greatest(0,
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))));
$$;

create function private.lb_late_units(p_unit_min int, p_grace_min int, p_deadline_ms bigint, p_arrived_ms bigint)
returns bigint language sql immutable as $$
  select case when p_arrived_ms - p_deadline_ms - p_grace_min::bigint * 60000 <= 0 then 0
              else ceil((p_arrived_ms - p_deadline_ms - p_grace_min::bigint * 60000)::numeric
                        / (p_unit_min::bigint * 60000))::bigint end;
$$;

-- lateBet.ts settleLateBet 과 같은 결과를 내야 한다(패리티 테스트 대상). 실제 정산도 이 함수를 그대로 부른다.
-- p_policy: {stake, unitMinutes, penaltyPerUnit, graceMinutes} / p_arrivals: [{id, arrivedAtMs|null}] (배열 순서 = 동률 타이브레이크)
create function public.lb_settle_preview(p_policy jsonb, p_deadline_ms bigint, p_arrivals jsonb)
returns jsonb language sql immutable security definer set search_path = '' as $$
  with pol as (
    select (p_policy->>'stake')::int as stake, (p_policy->>'unitMinutes')::int as unit_min,
           (p_policy->>'penaltyPerUnit')::int as ppu, (p_policy->>'graceMinutes')::int as grace_min
  ), a as (
    select e->>'id' as id, ord, (e->>'arrivedAtMs')::bigint as arrived_ms
    from jsonb_array_elements(p_arrivals) with ordinality as t(e, ord)
  ), b as (
    select a.*, case when a.arrived_ms is null then 0
                     else private.lb_late_units(pol.unit_min, pol.grace_min, p_deadline_ms, a.arrived_ms) end as units
    from a, pol
  ), c as (
    select b.*,
      case when arrived_ms is null then 'noShow' when units > 0 then 'late' else 'onTime' end as status,
      case when arrived_ms is null then pol.stake
           when pol.ppu = 0 then 0
           else least(pol.stake::bigint, units * pol.ppu)::int end as forfeited
    from b, pol
  ), tot as (
    select coalesce(sum(forfeited), 0)::bigint as pot,
           count(*) filter (where status = 'onTime')::int as winners from c
  ), v as (
    select case when pol.stake = 0 then 'noStake'
                when tot.pot > 0 and tot.winners = 0 then 'noWinner' end as void_reason
    from pol, tot
  ), w as (
    select id, row_number() over (order by arrived_ms, ord) as rn from c where status = 'onTime'
  ), r as (
    select c.id, c.ord, c.status,
      case when v.void_reason is not null then 0 else c.forfeited end as forfeited,
      case when v.void_reason is not null or w.rn is null or tot.pot = 0 then 0
           else (tot.pot / tot.winners)::int + (case when w.rn <= tot.pot % tot.winners then 1 else 0 end) end as received
    from c cross join tot cross join v left join w on w.id = c.id
  )
  select jsonb_build_object(
    'voided', (select void_reason is not null from v),
    'voidReason', (select void_reason from v),
    'pot', (select case when v.void_reason is not null then 0 else tot.pot end from tot, v),
    'persons', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'status', status, 'forfeited', forfeited, 'received', received,
        'net', received - forfeited) order by ord) from r), '[]'::jsonb));
$$;

-- ───────────────────────── 4. 내부 헬퍼 ─────────────────────────
create function private.lb_uid() returns uuid language plpgsql stable set search_path = '' as $$
declare v uuid := auth.uid();
begin
  if v is null then raise exception 'LB_NOT_SIGNED_IN'; end if;
  return v;
end $$;

create function private.lb_ms(p timestamptz) returns bigint language sql immutable as $$
  select floor(extract(epoch from p) * 1000)::bigint;
$$;

-- 닉네임: 보이지 않는 문자를 지우고 양끝 공백 제거(저장값) / 비교 키 = NFKC + 공백 제거 + 소문자
create function private.lb_clean_nick(p text) returns text language sql immutable as $$
  select btrim(regexp_replace(coalesce(p, ''), '[­​-‏ - ⁠-⁤﻿]', '', 'g'));
$$;
create function private.lb_nick_key(p text) returns text language sql immutable as $$
  select lower(regexp_replace(normalize(private.lb_clean_nick(p), NFKC), '\s', '', 'g'));
$$;

create function private.lb_new_invite_code() returns text language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  raw bytea; code text; i int;
begin
  loop
    raw := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
    code := '';
    for i in 0..7 loop  -- uuid 의 버전/변형 비트가 없는 바이트만 쓴다
      code := code || substr(alphabet, (get_byte(raw, (array[0,1,2,3,4,5,16,17])[i + 1]) % 31) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.appointments where invite_code = code);
  end loop;
  return code;
end $$;

-- 포인트 이동의 유일한 통로: 잔액 갱신 + 원장 1행. meta.anon = 그 시점에 익명 계정이었는가(나중에 소급할 수 없는 정보)
create function private.lb_post(p_user uuid, p_appt uuid, p_kind text, p_amount int, p_meta jsonb default '{}'::jsonb)
returns int language plpgsql volatile set search_path = '' as $$
declare v_after int; v_anon boolean;
begin
  update public.profiles set balance = balance + p_amount
   where user_id = p_user and balance + p_amount >= 0
   returning balance into v_after;
  if not found then raise exception 'LB_INSUFFICIENT_POINTS'; end if;
  select coalesce(u.is_anonymous, false) into v_anon from auth.users u where u.id = p_user;
  insert into public.ledger (user_id, appointment_id, kind, amount, balance_after, meta)
  values (p_user, p_appt, p_kind, p_amount, v_after, coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('anon', coalesce(v_anon, false)));
  return v_after;
end $$;

-- 스테이크 걸기. 잔액이 모자라면 '가진 것 전부(잔액 + 다른 열린 약속에 걸린 포인트)'가 1000 미만일 때에 한해 부족분만 채워 준다.
create function private.lb_hold(p_user uuid, p_appt uuid, p_stake int) returns void
language plpgsql volatile set search_path = '' as $$
declare v_bal int; v_escrow int;
begin
  if p_stake <= 0 then return; end if;
  select balance into v_bal from public.profiles where user_id = p_user for update;
  if not found then raise exception 'LB_NO_PROFILE'; end if;
  if v_bal < p_stake then
    select coalesce(sum(a.stake), 0) into v_escrow
      from public.participants p join public.appointments a on a.id = p.appointment_id
     where p.user_id = p_user and p.state = 'active' and a.status = 'open' and a.id <> p_appt;
    if v_bal + v_escrow >= 1000 then raise exception 'LB_INSUFFICIENT_POINTS'; end if;
    perform private.lb_post(p_user, null, 'relief', p_stake - v_bal, jsonb_build_object('reason', 'topup', 'for', p_appt));
  end if;
  perform private.lb_post(p_user, p_appt, 'hold', -p_stake);
end $$;

create function private.lb_close_at(p_meet timestamptz, p_stake int, p_unit int, p_ppu int, p_grace int)
returns timestamptz language sql immutable as $$
  select case when p_stake = 0 or p_ppu = 0 then p_meet + interval '60 minutes'
    else least(p_meet + interval '180 minutes',
               p_meet + make_interval(mins => p_grace + (ceil(p_stake::numeric / p_ppu)::int - 1) * p_unit)) end;
$$;

-- 벽시계+타임존 → 절대 시각. 타임존이 장소 경도(경도/15)와 1.5시간 넘게 어긋나면 확인 없이는 거부(여행 약속 사고 방지)
create function private.lb_resolve_meet(p_local_at text, p_tz text, p_lng float8, p_tz_confirmed boolean)
returns timestamptz language plpgsql stable set search_path = '' as $$
declare v_meet timestamptz; v_off_h numeric;
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz) then raise exception 'LB_BAD_TZ'; end if;
  if p_local_at is null or p_local_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$' then raise exception 'LB_BAD_TIME'; end if;
  begin
    v_meet := (replace(p_local_at, 'T', ' ')::timestamp) at time zone p_tz;
  exception when others then raise exception 'LB_BAD_TIME';
  end;
  if v_meet <= now() + interval '5 minutes' then raise exception 'LB_TIME_IN_PAST'; end if;
  if v_meet > now() + interval '90 days' then raise exception 'LB_TIME_TOO_FAR'; end if;
  v_off_h := extract(epoch from ((v_meet at time zone p_tz) - (v_meet at time zone 'UTC'))) / 3600.0;
  if abs(v_off_h - p_lng / 15.0) > 1.5 and not coalesce(p_tz_confirmed, false) then raise exception 'LB_TZ_SUSPECT'; end if;
  return v_meet;
end $$;

-- 정산(멱등). 약속 행 잠금 + status 검사 + payout 유니크 + 끝에서 합계 0 단언.
create function private.lb_settle(p_appt uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare a public.appointments; v_arrivals jsonb; v_res jsonb; p jsonb; v_all_arrived boolean;
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found or a.status <> 'open' then return; end if;               -- 두 번째 트리거는 no-op

  select coalesce(bool_and(arrived_at is not null), false) into v_all_arrived
    from public.participants where appointment_id = p_appt and state = 'active';
  -- close_at + 15초: close_at 직전에 시작한 체크인 트랜잭션(문장 타임아웃 8초)이 반드시 먼저 끝나게 하는 여유
  if not (now() > a.close_at + interval '15 seconds' or (v_all_arrived and now() >= a.meet_at)) then return; end if;

  delete from public.participants where appointment_id = p_appt and state = 'pending';   -- 승인 안 된 요청은 hold 가 없으므로 그냥 지운다

  select coalesce(jsonb_agg(jsonb_build_object('id', user_id,
           'arrivedAtMs', case when arrived_at is null then null else private.lb_ms(arrived_at) end)
           order by joined_at, user_id), '[]'::jsonb)
    into v_arrivals from public.participants where appointment_id = p_appt;

  v_res := public.lb_settle_preview(
    jsonb_build_object('stake', a.stake, 'unitMinutes', a.unit_minutes,
                       'penaltyPerUnit', a.penalty_per_unit, 'graceMinutes', a.grace_minutes),
    private.lb_ms(a.meet_at), v_arrivals);

  for p in select e from jsonb_array_elements(v_res->'persons') e order by (e->>'id')::uuid loop   -- 교착 방지: 항상 user_id 순
    update public.participants
       set result_status = p->>'status', forfeited = (p->>'forfeited')::int, received = (p->>'received')::int
     where appointment_id = p_appt and user_id = (p->>'id')::uuid;
    if a.stake > 0 then
      perform private.lb_post((p->>'id')::uuid, p_appt, 'payout',
        a.stake - (p->>'forfeited')::int + (p->>'received')::int,
        jsonb_build_object('status', p->>'status', 'forfeited', p->'forfeited', 'received', p->'received'));
    end if;
  end loop;

  update public.appointments
     set status = case when (v_res->>'voided')::boolean and a.stake > 0 then 'voided' else 'settled' end,
         void_reason = v_res->>'voidReason', settled_at = now()
   where id = p_appt;
  delete from public.locations where appointment_id = p_appt;

  if (select coalesce(sum(amount), 0) from public.ledger where appointment_id = p_appt) <> 0 then
    raise exception 'LB_INVARIANT_ESCROW_NONZERO';                       -- 어긋나면 전체 롤백, status 는 open 유지
  end if;
end $$;

-- 정산 시도. 실패해도 호출한 쪽(도착 기록·조회)은 성공해야 하므로 서브트랜잭션으로 격리하고 기록만 남긴다.
create function private.lb_try_settle(p_appt uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  begin
    perform private.lb_settle(p_appt);
  exception when others then
    insert into private.lb_settle_errors (appointment_id, message) values (p_appt, sqlstate || ' ' || sqlerrm);
  end;
end $$;

-- 오래된 좌표 폐기(어느 약속이든). 누가 앱을 열기만 해도 전체가 청소된다.
create function private.lb_purge_stale_locations() returns void
language sql volatile security definer set search_path = '' as $$
  delete from public.locations where updated_at < now() - interval '10 minutes';
$$;

-- ───────────────────────── 5. 공개 RPC (전부 security definer. 권한은 맨 끝에서 일괄 설정) ─────────────────────────
-- 0) 핑: keepalive(GitHub Actions, anon) + 앱 시작 시 서버 시계·최소 빌드·설치 링크. 입력 인자 없음.
create function public.lb_ping() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c private.lb_config;
begin
  update private.lb_config set heartbeat_at = now() where id = 1 and heartbeat_at < now() - interval '1 hour';
  perform private.lb_purge_stale_locations();
  select * into c from private.lb_config where id = 1;
  return jsonb_build_object('serverNowMs', private.lb_ms(clock_timestamp()), 'minBuild', c.min_build,
                            'iosUrl', c.ios_url, 'androidUrl', c.android_url);
end $$;

-- 1) 프로필 보장: 없으면 만들고 시작 포인트 지급, 있으면 닉네임만 갱신
create function public.lb_ensure_profile(p_nickname text) returns public.profiles
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid(); v public.profiles; v_nick text := private.lb_clean_nick(p_nickname);
begin
  if char_length(v_nick) not between 1 and 12 then raise exception 'LB_BAD_NICKNAME'; end if;
  insert into public.profiles (user_id, nickname) values (v_uid, v_nick) on conflict (user_id) do nothing;
  if found then
    perform private.lb_post(v_uid, null, 'grant', 1000, '{"reason":"signup"}');
  else
    update public.profiles set nickname = v_nick where user_id = v_uid;
  end if;
  select * into v from public.profiles where user_id = v_uid;
  return v;
end $$;

-- 2) 약속 생성(주최자 자동 참여 + 스테이크 에스크로)
create function public.lb_create_appointment(
  p_title text, p_local_at text, p_tz text,
  p_place_name text, p_place_note text, p_lat float8, p_lng float8,
  p_policy jsonb, p_consent boolean, p_tz_confirmed boolean default false
) returns public.appointments
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.lb_uid(); v_me public.profiles; a public.appointments; v_meet timestamptz;
  v_stake int := coalesce((p_policy->>'stake')::int, 0);
  v_radius int := coalesce((p_policy->>'radiusM')::int, 100);
  v_unit int := coalesce((p_policy->>'unitMinutes')::int, 5);
  v_ppu int := coalesce((p_policy->>'penaltyPerUnit')::int, 0);
  v_grace int := coalesce((p_policy->>'graceMinutes')::int, 0);
  v_share int := coalesce((p_policy->>'shareLocationMinutesBefore')::int, 60);
begin
  select * into v_me from public.profiles where user_id = v_uid;
  if not found then raise exception 'LB_NO_PROFILE'; end if;
  if not coalesce(p_consent, false) then raise exception 'LB_CONSENT_REQUIRED'; end if;
  if (select count(*) from public.appointments where host_id = v_uid and status = 'open') >= 10 then
    raise exception 'LB_TOO_MANY_OPEN';
  end if;
  if p_lat is null or p_lng is null then raise exception 'LB_BAD_POSITION'; end if;
  v_meet := private.lb_resolve_meet(p_local_at, p_tz, p_lng, p_tz_confirmed);

  insert into public.appointments (invite_code, host_id, title, local_at, tz, meet_at,
      place_name, place_note, place_lat, place_lng,
      stake, radius_m, unit_minutes, penalty_per_unit, grace_minutes, share_minutes_before,
      share_start_at, close_at)
  values (private.lb_new_invite_code(), v_uid, btrim(p_title),
      to_char(v_meet at time zone p_tz, 'YYYY-MM-DD"T"HH24:MI'), p_tz, v_meet,   -- DST 로 없는 시각을 넣어도 표시와 판정이 일치하도록 서버가 다시 쓴다
      btrim(p_place_name), coalesce(p_place_note, ''), p_lat, p_lng,
      v_stake, v_radius, v_unit, v_ppu, v_grace, v_share,
      v_meet - make_interval(mins => v_share),
      private.lb_close_at(v_meet, v_stake, v_unit, v_ppu, v_grace))
  returning * into a;   -- 범위 위반은 CHECK 제약이 거른다(23514)

  insert into public.participants (appointment_id, user_id, nickname) values (a.id, v_uid, v_me.nickname);
  perform private.lb_hold(v_uid, a.id, a.stake);
  return a;
end $$;

-- 3) 초대 코드 미리보기(참여 전 조건 확인용). 멤버가 아니면 닉네임 대신 인원수만.
create function public.lb_peek_invite(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid(); a public.appointments; v_state text;
begin
  select * into a from public.appointments where invite_code = upper(btrim(coalesce(p_code, '')));
  if not found or exists (select 1 from private.lb_bans where appointment_id = a.id and user_id = v_uid) then
    raise exception 'LB_INVITE_NOT_FOUND';
  end if;
  select state into v_state from public.participants where appointment_id = a.id and user_id = v_uid;
  return jsonb_build_object(
    'id', a.id, 'title', a.title, 'localAt', a.local_at, 'tz', a.tz, 'meetAtMs', private.lb_ms(a.meet_at),
    'shareStartMs', private.lb_ms(a.share_start_at), 'closeMs', private.lb_ms(a.close_at),
    'placeName', a.place_name, 'placeNote', a.place_note, 'placeLat', a.place_lat, 'placeLng', a.place_lng,
    'status', a.status, 'version', a.version, 'joinClosed', a.join_closed,
    'needsApproval', now() >= a.share_start_at,
    'serverNowMs', private.lb_ms(clock_timestamp()),
    'policy', jsonb_build_object('stake', a.stake, 'radiusM', a.radius_m, 'unitMinutes', a.unit_minutes,
       'penaltyPerUnit', a.penalty_per_unit, 'graceMinutes', a.grace_minutes,
       'shareLocationMinutesBefore', a.share_minutes_before),
    'memberCount', (select count(*) from public.participants where appointment_id = a.id and state = 'active'),
    'nicknames', case when v_state = 'active' then
        (select coalesce(jsonb_agg(nickname order by joined_at), '[]'::jsonb)
           from public.participants where appointment_id = a.id and state = 'active') else '[]'::jsonb end,
    'myState', v_state,
    'myBalance', (select balance from public.profiles where user_id = v_uid));
end $$;

-- 4) 참여(멱등). 잠금 전 = 즉시 참여 + 에스크로 / 잠금 후 = 참여 요청(pending, 주최자 승인 때 에스크로)
create function public.lb_join(p_code text, p_nickname text, p_version int, p_consent boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.lb_uid(); a public.appointments; v_nick text := private.lb_clean_nick(p_nickname);
  v_state text; v_pending boolean;
begin
  select * into a from public.appointments where invite_code = upper(btrim(coalesce(p_code, ''))) for update;
  if not found or exists (select 1 from private.lb_bans where appointment_id = a.id and user_id = v_uid) then
    raise exception 'LB_INVITE_NOT_FOUND';
  end if;
  select state into v_state from public.participants where appointment_id = a.id and user_id = v_uid;
  if found then return jsonb_build_object('appointmentId', a.id, 'state', v_state); end if;

  if a.status <> 'open' or a.join_closed or clock_timestamp() >= a.meet_at then raise exception 'LB_JOIN_CLOSED'; end if;
  if p_version is distinct from a.version then raise exception 'LB_APPT_CHANGED'; end if;
  if not coalesce(p_consent, false) then raise exception 'LB_CONSENT_REQUIRED'; end if;
  if not exists (select 1 from public.profiles where user_id = v_uid) then raise exception 'LB_NO_PROFILE'; end if;
  if char_length(v_nick) not between 1 and 12 then raise exception 'LB_BAD_NICKNAME'; end if;
  if exists (select 1 from public.participants
              where appointment_id = a.id and private.lb_nick_key(nickname) = private.lb_nick_key(v_nick)) then
    raise exception 'LB_NICKNAME_TAKEN';
  end if;

  v_pending := clock_timestamp() >= a.share_start_at;
  if v_pending then
    if (select count(*) from public.participants where appointment_id = a.id and state = 'pending') >= 10 then raise exception 'LB_FULL'; end if;
    insert into public.participants (appointment_id, user_id, nickname, state) values (a.id, v_uid, v_nick, 'pending');
    return jsonb_build_object('appointmentId', a.id, 'state', 'pending');
  end if;
  if (select count(*) from public.participants where appointment_id = a.id and state = 'active') >= 20 then raise exception 'LB_FULL'; end if;
  insert into public.participants (appointment_id, user_id, nickname) values (a.id, v_uid, v_nick);
  perform private.lb_hold(v_uid, a.id, a.stake);   -- 부족하고 채워줄 수도 없으면 예외 → 전체 롤백
  return jsonb_build_object('appointmentId', a.id, 'state', 'active');
end $$;

-- 5) 승인: 잠금 후 들어온 참여 요청을 주최자가 받아준다. 이때 에스크로가 잡힌다.
create function public.lb_approve(p_appt uuid, p_target uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid(); a public.appointments;
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found or a.host_id <> v_uid then raise exception 'LB_NOT_HOST'; end if;
  if a.status <> 'open' or clock_timestamp() >= a.meet_at then raise exception 'LB_JOIN_CLOSED'; end if;
  if (select count(*) from public.participants where appointment_id = p_appt and state = 'active') >= 20 then raise exception 'LB_FULL'; end if;
  update public.participants set state = 'active', joined_at = now()
   where appointment_id = p_appt and user_id = p_target and state = 'pending';
  if not found then return; end if;                                   -- 이미 승인됐거나 요청을 거둔 경우: no-op
  perform private.lb_hold(p_target, p_appt, a.stake);                 -- 대상의 포인트가 모자라면 LB_INSUFFICIENT_POINTS 로 롤백
end $$;

-- 6) 나가기: 활성 참가자는 잠금 전까지만(환불). 승인 대기 중인 요청은 언제든 거둘 수 있다.
create function public.lb_leave(p_appt uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid(); a public.appointments; me public.participants;
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found then raise exception 'LB_NOT_FOUND'; end if;
  select * into me from public.participants where appointment_id = p_appt and user_id = v_uid;
  if not found then return; end if;
  if me.state = 'pending' then
    delete from public.participants where appointment_id = p_appt and user_id = v_uid;
    return;
  end if;
  if a.host_id = v_uid then raise exception 'LB_HOST_CANNOT_LEAVE'; end if;
  if a.status <> 'open' or clock_timestamp() >= a.share_start_at then raise exception 'LB_LEAVE_CLOSED'; end if;
  delete from public.participants where appointment_id = p_appt and user_id = v_uid;
  if a.stake > 0 then perform private.lb_post(v_uid, p_appt, 'refund', a.stake, '{"reason":"leave"}'); end if;
end $$;

-- 7) 내보내기/거절: 활성 참가자는 잠금 전까지만(전액 환불). 승인 대기 요청은 언제든 거절. p_ban 이면 같은 계정의 재참여를 막는다.
create function public.lb_kick(p_appt uuid, p_target uuid, p_ban boolean default true) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid(); a public.appointments; t public.participants;
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found or a.host_id <> v_uid then raise exception 'LB_NOT_HOST'; end if;
  if p_target = v_uid then raise exception 'LB_HOST_CANNOT_LEAVE'; end if;
  select * into t from public.participants where appointment_id = p_appt and user_id = p_target;
  if not found then return; end if;
  if t.state = 'active' then
    if a.status <> 'open' or clock_timestamp() >= a.share_start_at then raise exception 'LB_KICK_CLOSED'; end if;
    delete from public.participants where appointment_id = p_appt and user_id = p_target;
    if a.stake > 0 then perform private.lb_post(p_target, p_appt, 'refund', a.stake, '{"reason":"kicked"}'); end if;
  else
    delete from public.participants where appointment_id = p_appt and user_id = p_target;
  end if;
  if coalesce(p_ban, true) then
    insert into private.lb_bans (appointment_id, user_id) values (p_appt, p_target) on conflict do nothing;
  end if;
end $$;

-- 8) 참여 마감 토글(주최자)
create function public.lb_set_join_closed(p_appt uuid, p_closed boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid();
begin
  update public.appointments set join_closed = coalesce(p_closed, true)
   where id = p_appt and host_id = v_uid and status = 'open';
  if not found then raise exception 'LB_NOT_HOST'; end if;
end $$;

-- 9) 제목·메모 수정(주최자, 열려 있는 동안 언제든). 조건이 아니므로 version 을 올리지 않는다.
create function public.lb_update_memo(p_appt uuid, p_title text, p_place_note text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid();
begin
  update public.appointments set title = btrim(p_title), place_note = coalesce(p_place_note, '')
   where id = p_appt and host_id = v_uid and status = 'open';
  if not found then raise exception 'LB_NOT_HOST'; end if;
end $$;

-- 10) 조건 수정(시간·장소·정책): 주최자 혼자일 때만(승인 대기 요청도 없어야 한다). 옛 스테이크 환불 → 새 스테이크 에스크로.
create function public.lb_update_appointment(
  p_appt uuid, p_local_at text, p_tz text, p_place_name text, p_lat float8, p_lng float8,
  p_policy jsonb, p_tz_confirmed boolean default false
) returns public.appointments
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.lb_uid(); a public.appointments; v_meet timestamptz;
  v_stake int; v_radius int; v_unit int; v_ppu int; v_grace int; v_share int;
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found or a.host_id <> v_uid then raise exception 'LB_NOT_HOST'; end if;
  if a.status <> 'open' then raise exception 'LB_EDIT_CLOSED'; end if;
  if exists (select 1 from public.participants where appointment_id = p_appt and (user_id <> v_uid or arrived_at is not null)) then
    raise exception 'LB_EDIT_LOCKED';                                  -- 다른 사람이 있으면 취소하고 새로 만들어야 한다
  end if;
  if p_lat is null or p_lng is null then raise exception 'LB_BAD_POSITION'; end if;
  v_meet := private.lb_resolve_meet(p_local_at, p_tz, p_lng, p_tz_confirmed);
  v_stake  := coalesce((p_policy->>'stake')::int, a.stake);
  v_radius := coalesce((p_policy->>'radiusM')::int, a.radius_m);
  v_unit   := coalesce((p_policy->>'unitMinutes')::int, a.unit_minutes);
  v_ppu    := coalesce((p_policy->>'penaltyPerUnit')::int, a.penalty_per_unit);
  v_grace  := coalesce((p_policy->>'graceMinutes')::int, a.grace_minutes);
  v_share  := coalesce((p_policy->>'shareLocationMinutesBefore')::int, a.share_minutes_before);

  if a.stake > 0 then perform private.lb_post(v_uid, p_appt, 'refund', a.stake, '{"reason":"policy_change"}'); end if;
  update public.appointments set
    local_at = to_char(v_meet at time zone p_tz, 'YYYY-MM-DD"T"HH24:MI'), tz = p_tz, meet_at = v_meet,
    place_name = btrim(p_place_name), place_lat = p_lat, place_lng = p_lng,
    stake = v_stake, radius_m = v_radius, unit_minutes = v_unit, penalty_per_unit = v_ppu,
    grace_minutes = v_grace, share_minutes_before = v_share,
    share_start_at = v_meet - make_interval(mins => v_share),          -- 새 정책 값으로 다시 계산
    close_at = private.lb_close_at(v_meet, v_stake, v_unit, v_ppu, v_grace),
    version = a.version + 1
  where id = p_appt returning * into a;
  perform private.lb_hold(v_uid, p_appt, a.stake);
  delete from public.locations where appointment_id = p_appt;
  return a;
end $$;

-- 11) 취소(주최자): 다른 참가자가 있으면 잠금 전까지만, 혼자면 언제든. 전원 환불.
create function public.lb_cancel(p_appt uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid(); a public.appointments; r record;
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found or a.host_id <> v_uid then raise exception 'LB_NOT_HOST'; end if;
  if a.status <> 'open' then raise exception 'LB_CANCEL_CLOSED'; end if;
  if clock_timestamp() >= a.share_start_at
     and exists (select 1 from public.participants where appointment_id = p_appt and state = 'active' and user_id <> v_uid) then
    raise exception 'LB_CANCEL_CLOSED';
  end if;
  delete from public.participants where appointment_id = p_appt and state = 'pending';
  if a.stake > 0 then
    for r in select user_id from public.participants where appointment_id = p_appt order by user_id loop
      perform private.lb_post(r.user_id, p_appt, 'refund', a.stake, '{"reason":"canceled"}');
    end loop;
  end if;
  update public.appointments set status = 'canceled', settled_at = now() where id = p_appt;
  delete from public.locations where appointment_id = p_appt;
end $$;

-- 12) 위치 보고 = 도착 판정. 시각은 서버 now(), 거리는 서버가 계산. p_share=false 면 좌표를 저장하지 않는다(판정만).
create function public.lb_report_location(
  p_appt uuid, p_lat float8, p_lng float8, p_accuracy_m float8,
  p_mocked boolean default false, p_share boolean default true
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.lb_uid(); a public.appointments; me public.participants;
  v_dist float8; v_reason text := null; v_now timestamptz := date_trunc('milliseconds', now());
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found then raise exception 'LB_NOT_FOUND'; end if;
  select * into me from public.participants where appointment_id = p_appt and user_id = v_uid;
  if not found then raise exception 'LB_NOT_MEMBER'; end if;

  if a.status <> 'open' then v_reason := 'closed';
  elsif me.state = 'pending' then v_reason := 'pending';
  elsif me.arrived_at is not null then v_reason := 'already_arrived';
  elsif v_now < a.share_start_at then v_reason := 'not_open';
  elsif v_now > a.close_at then perform private.lb_try_settle(p_appt); v_reason := 'closed';
  elsif p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then v_reason := 'bad_position';
  end if;
  if v_reason is not null then
    return jsonb_build_object('arrived', me.arrived_at is not null, 'reason', v_reason,
      'arrivedAtMs', case when me.arrived_at is null then null else private.lb_ms(me.arrived_at) end,
      'serverNowMs', private.lb_ms(clock_timestamp()));
  end if;

  v_dist := private.lb_haversine_m(p_lat, p_lng, a.place_lat, a.place_lng);
  if coalesce(p_mocked, false) then v_reason := 'mocked';
  elsif p_accuracy_m is not null and (p_accuracy_m < 0 or p_accuracy_m > 100) then v_reason := 'low_accuracy';
  elsif v_dist > a.radius_m then v_reason := 'outside';
  end if;

  if v_reason is null then
    update public.participants set arrived_at = v_now, arrival_method = 'gps',
           arrival_distance_m = round(v_dist)::int, arrival_accuracy_m = round(p_accuracy_m)::int
     where appointment_id = p_appt and user_id = v_uid;
    delete from public.locations where appointment_id = p_appt and user_id = v_uid;   -- 도착하면 위치 공개 종료
    perform private.lb_try_settle(p_appt);                                           -- 전원 도착 ∧ 마감 이후면 즉시 정산(아니면 no-op)
    return jsonb_build_object('arrived', true, 'arrivedAtMs', private.lb_ms(v_now),
                              'distanceM', round(v_dist), 'serverNowMs', private.lb_ms(clock_timestamp()));
  end if;

  -- 정확도 미달이지만 오차를 빼면 반경 안: '근처에 있었다'는 첫 서버 시각을 남긴다(보증 도착 때 도착 시각으로 쓴다)
  if v_reason = 'low_accuracy' and p_accuracy_m > 0 and me.first_near_at is null
     and v_dist - least(p_accuracy_m, 300) <= a.radius_m then
    update public.participants set first_near_at = v_now where appointment_id = p_appt and user_id = v_uid;
  end if;

  if coalesce(p_share, true) and v_reason <> 'mocked' and (p_accuracy_m is null or p_accuracy_m <= 1000) then
    insert into public.locations (appointment_id, user_id, lat, lng, accuracy_m, updated_at)
    values (p_appt, v_uid, p_lat, p_lng, p_accuracy_m, v_now)
    on conflict (appointment_id, user_id) do update
      set lat = excluded.lat, lng = excluded.lng, accuracy_m = excluded.accuracy_m, updated_at = excluded.updated_at;
  else
    delete from public.locations where appointment_id = p_appt and user_id = v_uid;
  end if;
  return jsonb_build_object('arrived', false, 'reason', v_reason, 'distanceM', round(v_dist),
                            'serverNowMs', private.lb_ms(clock_timestamp()));
end $$;

-- 13) 위치 공유 끄기: 내 좌표 행을 즉시 지운다(화면 이탈·백그라운드 전환·토글 OFF 때 호출)
create function public.lb_stop_sharing(p_appt uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid();
begin
  delete from public.locations where appointment_id = p_appt and user_id = v_uid;
end $$;

-- 14) 보증 도착: GPS 로 도착한 사람이 "같이 있어요". 시각 = 대상의 first_near_at(있으면) 아니면 누른 순간.
create function public.lb_vouch(p_appt uuid, p_target uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid(); a public.appointments; v_now timestamptz := date_trunc('milliseconds', now());
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found or a.status <> 'open' then raise exception 'LB_CLOSED'; end if;
  if v_now < a.share_start_at or v_now > a.close_at then raise exception 'LB_CLOSED'; end if;
  if p_target = v_uid then raise exception 'LB_CANNOT_VOUCH_SELF'; end if;
  if not exists (select 1 from public.participants
                 where appointment_id = p_appt and user_id = v_uid and arrival_method = 'gps') then
    raise exception 'LB_VOUCHER_NOT_ARRIVED';                          -- 보증의 연쇄 금지
  end if;
  update public.participants
     set arrived_at = coalesce(first_near_at, v_now), arrival_method = 'vouch', vouched_by = v_uid
   where appointment_id = p_appt and user_id = p_target and state = 'active' and arrived_at is null;
  if not found then return; end if;
  delete from public.locations where appointment_id = p_appt and user_id = p_target;
  perform private.lb_try_settle(p_appt);
end $$;

-- 15) 화면 전체 상태 1방 조회(폴링 대상). 정산 조건이 됐으면 여기서 게으른 정산.
create function public.lb_get_live(p_appt uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid(); a public.appointments; me public.participants; v_share_open boolean;
begin
  if not exists (select 1 from public.participants where appointment_id = p_appt and user_id = v_uid) then
    raise exception 'LB_NOT_MEMBER';
  end if;
  select * into a from public.appointments where id = p_appt;          -- 평소 폴링은 행 락을 잡지 않는다
  if a.status = 'open' and (
       now() > a.close_at + interval '15 seconds'
    or (now() >= a.meet_at and not exists (select 1 from public.participants
                                            where appointment_id = p_appt and state = 'active' and arrived_at is null))
  ) then
    perform private.lb_try_settle(p_appt);
    select * into a from public.appointments where id = p_appt;
  end if;
  perform private.lb_purge_stale_locations();

  select * into me from public.participants where appointment_id = p_appt and user_id = v_uid;
  if not found then raise exception 'LB_NOT_MEMBER'; end if;          -- 정산이 승인 대기 요청을 지운 경우
  v_share_open := a.status = 'open' and me.state = 'active' and now() >= a.share_start_at and now() <= a.close_at;

  if v_share_open then                                                 -- 위치 제공 사실 기록(좌표 없음). 쌍당 5분에 한 번만 갱신
    insert into private.lb_share_log (appointment_id, viewer_id, subject_id)
    select p_appt, v_uid, l.user_id
      from public.locations l join public.participants p on p.appointment_id = l.appointment_id and p.user_id = l.user_id
     where l.appointment_id = p_appt and l.user_id <> v_uid and p.arrived_at is null
       and l.updated_at > now() - interval '3 minutes'
    on conflict (appointment_id, viewer_id, subject_id) do update set last_at = now()
      where private.lb_share_log.last_at < now() - interval '5 minutes';
  end if;

  return jsonb_build_object(
    'serverNowMs', private.lb_ms(clock_timestamp()),
    'myUserId', v_uid, 'myState', me.state,
    'myBalance', (select balance from public.profiles where user_id = v_uid),
    'settlePending', a.status = 'open' and now() > a.close_at,         -- 클라이언트는 이때 '정산 확인 중'을 그린다
    'appointment', jsonb_build_object(
      'id', a.id, 'inviteCode', case when me.state = 'active' then a.invite_code end, 'hostId', a.host_id, 'title', a.title,
      'localAt', a.local_at, 'tz', a.tz, 'meetAtMs', private.lb_ms(a.meet_at),
      'shareStartMs', private.lb_ms(a.share_start_at), 'closeMs', private.lb_ms(a.close_at),
      'placeName', a.place_name, 'placeNote', a.place_note, 'placeLat', a.place_lat, 'placeLng', a.place_lng,
      'status', a.status, 'voidReason', a.void_reason, 'version', a.version, 'joinClosed', a.join_closed,
      'policy', jsonb_build_object('stake', a.stake, 'radiusM', a.radius_m, 'unitMinutes', a.unit_minutes,
        'penaltyPerUnit', a.penalty_per_unit, 'graceMinutes', a.grace_minutes,
        'shareLocationMinutesBefore', a.share_minutes_before)),
    'participants', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'userId', p.user_id, 'nickname', p.nickname, 'state', p.state, 'joinedAtMs', private.lb_ms(p.joined_at),
        'arrivedAtMs', case when p.arrived_at is null then null else private.lb_ms(p.arrived_at) end,
        'arrivalMethod', p.arrival_method, 'arrivalDistanceM', p.arrival_distance_m, 'arrivalAccuracyM', p.arrival_accuracy_m,
        'vouchedBy', p.vouched_by,
        'resultStatus', p.result_status, 'forfeited', p.forfeited, 'received', p.received,
        'lastSeenMs', case when v_share_open and p.arrived_at is null and l.user_id is not null then private.lb_ms(l.updated_at) end,
        -- 좌표는 (공개 창 안) ∧ (보는 사람이 활성 멤버) ∧ (미도착) ∧ (3분 안에 갱신됨) 일 때만
        'location', case when v_share_open and p.arrived_at is null and l.user_id is not null
                          and l.updated_at > now() - interval '3 minutes' then
           jsonb_build_object('lat', l.lat, 'lng', l.lng, 'accuracyM', l.accuracy_m, 'updatedAtMs', private.lb_ms(l.updated_at),
             'distanceM', round(private.lb_haversine_m(l.lat, l.lng, a.place_lat, a.place_lng)))
           end
      ) order by p.joined_at, p.user_id), '[]'::jsonb)
      from public.participants p
      left join public.locations l on l.appointment_id = p.appointment_id and l.user_id = p.user_id
      where p.appointment_id = p_appt
        and (me.state = 'active' or p.user_id = v_uid)));              -- 승인 대기자는 자기 행만 본다
end $$;

-- 16) 감사(오너가 SQL 에디터에서): 0행이면 정상
create function private.lb_audit() returns table (problem text, ref text, detail text)
language sql stable security definer set search_path = '' as $$
  select 'balance != ledger sum', p.user_id::text, p.balance || ' vs ' || coalesce(sum(l.amount), 0)
    from public.profiles p left join public.ledger l on l.user_id = p.user_id
   group by p.user_id, p.balance having p.balance <> coalesce(sum(l.amount), 0)
  union all
  select 'closed appointment ledger sum != 0', a.id::text, sum(l.amount)::text
    from public.appointments a join public.ledger l on l.appointment_id = a.id
   where a.status <> 'open' group by a.id having sum(l.amount) <> 0
  union all
  select 'open appointment escrow != stake * active members', a.id::text, coalesce(-sum(l.amount), 0)::text
    from public.appointments a left join public.ledger l on l.appointment_id = a.id
   where a.status = 'open' group by a.id, a.stake
  having coalesce(-sum(l.amount), 0) <> a.stake * (select count(*) from public.participants x where x.appointment_id = a.id and x.state = 'active')
  union all
  select 'global: balances + open escrow != minted', '-', g.have || ' vs ' || g.minted
    from (select (select coalesce(sum(balance), 0) from public.profiles)
               + (select coalesce(-sum(l.amount), 0) from public.ledger l join public.appointments a on a.id = l.appointment_id where a.status = 'open') as have,
                 (select coalesce(sum(amount), 0) from public.ledger where kind in ('grant','relief')) as minted) g
   where g.have <> g.minted
  union all
  select 'settled: received != forfeited or forfeited > stake', a.id::text, sum(p.received) || ' vs ' || sum(p.forfeited)
    from public.appointments a join public.participants p on p.appointment_id = a.id
   where a.status in ('settled','voided') group by a.id, a.stake
  having sum(p.received) <> sum(p.forfeited) or max(p.forfeited) > a.stake
  union all
  select 'ledger running balance broken', x.user_id::text, x.id::text
    from (select id, user_id, amount, balance_after,
                 lag(balance_after, 1, 0) over (partition by user_id order by id) as prev from public.ledger) x
   where x.balance_after <> x.prev + x.amount;
$$;

-- ───────────────────────── 6. 권한 (맨 끝에서 일괄) ─────────────────────────
revoke all on all tables    in schema public  from public, anon, authenticated;
revoke all on all tables    in schema private from public, anon, authenticated;
revoke all on all sequences in schema public  from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;
grant select on public.profiles, public.appointments, public.participants, public.ledger to authenticated;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, n.nspname, p.proname
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname = 'public' and p.proname like 'lb\_%') or n.nspname = 'private' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.nspname = 'public' then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
grant execute on function private.lb_is_member(uuid), private.lb_is_active_member(uuid) to authenticated;  -- RLS 정책이 부른다
grant execute on function public.lb_ping() to anon;                                                        -- keepalive 전용
