-- supabase/migrations/20260918000000_late_bet.sql
-- 약속 내기(late bet) 1차: 테이블 + RLS + RPC. Edge Function·Realtime·pg_cron 없음.
-- 원칙: 클라이언트는 테이블에 직접 쓰지 못한다(SELECT 정책만). 모든 쓰기는 아래 RPC.
--
-- 오너 확정 흐름(2026-09-18, '주최자 [시작하기]' 모델) 반영본 — 설계서 부록 A 보다 이 파일이 우선한다.
--  주최자가 약속을 만들고 친구를 초대 → 친구들이 명단에서 자기 이름을 골라 포인트를 건다 → 주최자가 [시작하기]를 한 번 누르면
--  그 순간부터 전원 위치가 서로 보인다 → 도착·지각 판정 → 정산.
--  1. 수락제 폐지 → 초대 명단(public.invitees). 참여 = 명단에서 자기 이름을 고르는 것(lb_claim_slot). 약속 시각(meet_at)까지 언제든(시작 후에도).
--     pending 상태·lb_approve·참여 요청·참여 마감(join_closed)·'위치 공개 시점(N분 전)' 설정은 없다.
--  2. 시작(started_at) = 주최자가 [시작하기]를 누른 서버 시각(lb_start). 주최자만, 약속 시각 전이면 언제든(인원 조건 없음), 되돌릴 수 없다.
--     위치 공개 창 = started_at ~ close_at. 남의 위치는 시작됨 ∧ 창 안 ∧ 대상 미도착 ∧ 3분 내 갱신일 때만. 체크인도 시작~close_at.
--     시작 전: 참여·나가기(환불)·내보내기(환불)·명단 편집·조건 전부 변경(version+1, 걸 포인트 차액은 전원 자동 에스크로/환불) 가능.
--     시작 후: 나가기·명단 편집 불가. 변경은 시간 뒤로 미루기·장소만(lb_edit_appointment).
--  4. 공정성 규칙(오너 결정 2026-09-19 — 주최자가 친구 포인트를 부당하게 가져가는 경로 4개 차단. 판정은 전부 서버 시계, 약속 행 FOR UPDATE 아래):
--     R1 시작 후 미루기는 지금 약속 시각 전에만, 시작하던 순간의 약속 시각(start_meet_at) + 180분까지 누적(LB_POSTPONE_AFTER_MEET / LB_POSTPONE_TOO_FAR).
--     R2 시작 후 새 핀은 시작하던 순간의 핀에서 500m 이내(누적, LB_MOVE_TOO_FAR). 장소 이름만은 자유.
--     R3 참가자가 있을 때 시각·시간대·핀·정책을 바꾸면(시작 전) 5분 동안 시작 불가(material_changed_at, LB_START_COOLDOWN).
--     R4 시작 후에도 '시작 뒤에 들어온 사람'은 정산 전까지 내보낼 수 있다(환불·좌표 삭제·차단·이름 칸 비움). 시작 전부터 있던 사람은 LB_KICK_CLOSED.
--     상수: 클라이언트 POSTPONE_MAX_MINUTES_AFTER_START=180, MOVE_AFTER_START_MAX_M=500, START_COOLDOWN_MS=5분과 같은 값이어야 한다.
--  3. 정산: 시작이 안 된 약속은 약속 시각에 자동 무효(void_reason 'notStarted', 전원 환불). 약속 시각까지 안 들어온 이름은 자동 삭제(환불 없음).
--     체크인·위치 공개 마감(close_at) = 전액 몰수 시각 + 30분 꼬리(상한 약속 + 180분). 전액 몰수 시각이 없으면 약속 + 60분.

-- ───────────────────────── 0. 기본 권한 잠그기 (Supabase 'Hardening the Data API' 문서의 문장 그대로) ─────────────────────────
alter default privileges for role postgres in schema public revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke usage, select on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke execute on functions from public;
-- 위 한 줄은 효과가 없다: PUBLIC 의 함수 EXECUTE 는 '전역' 기본 권한이고, 스키마별 기본 권한은 전역 위에 더하기만 한다(PG 문서 ALTER DEFAULT PRIVILEGES).
-- 그래서 전역으로 한 번 더 회수한다 — 이후 postgres 가 만드는 새 함수(어느 스키마든)는 anon·authenticated 가 PUBLIC 경유로 부를 수 없다.
-- (로컬 PG16 에서 확인: 이 줄이 없으면 새 public 함수의 proacl 이 null = PUBLIC 실행 가능.) 새 RPC 는 맨 끝 do-block 을 다시 돌려 authenticated 에만 준다.
alter default privileges for role postgres revoke execute on functions from public;

create schema if not exists private;
grant usage on schema private to authenticated;   -- RLS 정책이 private.lb_is_member 를 부르기 때문. 함수 EXECUTE 는 맨 끝에서 개별 통제.

-- ───────────────────────── 0.5 닉네임 정규화 (invitees.name_key 생성 컬럼이 쓰므로 테이블보다 먼저) ─────────────────────────
-- 닉네임: 보이지 않는 문자를 지우고 양끝 공백 제거(저장값) / 비교 키 = NFKC + 공백 제거 + 소문자
create function private.lb_clean_nick(p text) returns text language sql immutable as $$
  select btrim(regexp_replace(coalesce(p, ''), '[­​-‏ - ⁠-⁤﻿]', '', 'g'));
$$;
create function private.lb_nick_key(p text) returns text language sql immutable as $$
  select lower(regexp_replace(normalize(private.lb_clean_nick(p), NFKC), '\s', '', 'g'));
$$;

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
  meet_at          timestamptz not null,             -- 약속 시각 = 정산 기준 = 참여 마감 = 시작 마감(이 시각까지 안 들어온 이름은 자동 삭제, 시작 안 됐으면 자동 무효)
  place_name       text not null check (char_length(place_name) between 1 and 60),
  place_note       text not null default '' check (char_length(place_note) <= 200),
  place_lat        double precision not null check (place_lat between -90 and 90),
  place_lng        double precision not null check (place_lng between -180 and 180),
  stake            integer not null check (stake between 0 and 300),
  radius_m         integer not null default 100 check (radius_m between 30 and 1000),
  unit_minutes     integer not null default 5 check (unit_minutes between 1 and 60),
  penalty_per_unit integer not null default 0 check (penalty_per_unit between 0 and 300),
  grace_minutes    integer not null default 0 check (grace_minutes between 0 and 30),
  started_at       timestamptz,                      -- 주최자가 [시작하기]를 누른 서버 시각 = 위치 공개·체크인 개시. null = 아직 시작 전(대기실). 되돌릴 수 없다
  close_at         timestamptz not null,             -- 체크인·위치 공개 종료 = 전액 몰수 시각 + 30분 꼬리(상한 meet_at + 180분). 이 시각을 넘겨 도착하면 노쇼와 같은 금액
  changes          jsonb not null default '[]'::jsonb,  -- 조건 변경 이력 [{version, atMs, before, after}] 최근 20건. 참가자 화면의 "주최자가 약속을 바꿨어요" 배너용
  status           text not null default 'open' check (status in ('open','settled','voided','canceled')),
  void_reason      text,                             -- noStake | noWinner (엔진) | notStarted (약속 시각까지 주최자가 시작하지 않음)
  constraint started_before_meet check (started_at is null or started_at < meet_at),   -- 미루기는 meet_at 을 뒤로만 옮기므로 유지된다
  -- 공정성 규칙(오너 결정 2026-09-19). 시작하던 순간의 약속 시각·핀을 박제해 두고 시작 후 변경의 누적 한도를 이 값 기준으로 잰다
  start_meet_at    timestamptz,                      -- R1: 시작 후 미루기 상한 = start_meet_at + 180분(반복 미루기로 늘어나지 않는다)
  start_place_lat  double precision,                 -- R2: 시작 후 새 핀은 이 점에서 500m 이내(여러 번 옮겨도 누적 기준)
  start_place_lng  double precision,
  material_changed_at timestamptz,                   -- R3: 주최자 말고 참가자가 있을 때 시각·시간대·핀·정책 5개가 실제로 바뀐 마지막 서버 시각. 이후 5분간 lb_start 거부
  settled_at       timestamptz,
  version          integer not null default 1,       -- 제목·메모·명단 외의 어떤 값이든 바뀌면 +1 (peek→claim 사이 변경 감지, 수정 RPC 의 낙관적 잠금)
  created_at       timestamptz not null default now(),
  request_id       uuid,                             -- 생성 멱등 키(클라이언트가 폼 제출마다 만든 uuid). 타임아웃 뒤 [만들기] 재시도가 약속·에스크로를 두 번 만들지 않게
  constraint policy_reaches_full_within_cap check (  -- "179분 지각 −179P, 181분 지각 전액" 같은 절벽 금지
    penalty_per_unit = 0 or stake = 0 or
    (ceil(stake::numeric / penalty_per_unit) - 1) * unit_minutes + grace_minutes <= 180)
);
create index appointments_open_close_idx on public.appointments (close_at) where status = 'open';
create index appointments_host_open_idx  on public.appointments (host_id) where status = 'open';
create unique index appointments_host_request_uq on public.appointments (host_id, request_id) where request_id is not null;

create table public.participants (                   -- 참가자 = 주최자 + 명단에서 자기 이름을 고른 사람. 상태는 active 하나(수락제 없음)
  appointment_id uuid not null references public.appointments(id) on delete restrict,
  user_id        uuid not null references public.profiles(user_id),
  nickname       text not null check (char_length(nickname) between 1 and 12),   -- = 명단의 이름(주최자는 프로필 닉네임)
  joined_at      timestamptz not null default now(), -- (joined_at, user_id) = 엔진 participantIds 순서
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
  check ((arrived_at is null) = (arrival_method is null))
);
create index participants_user_idx on public.participants (user_id);

create table public.invitees (                       -- 초대 명단: 주최자가 적은 이름 한 줄 = 자리 하나. 주최자 본인은 명단에 없다(자동 참가)
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 12),      -- 주최자가 적은 표기 = 그 사람의 이 약속 닉네임
  name_key       text not null generated always as (private.lb_nick_key(name)) stored,  -- 비교 키(NFKC·공백·보이지 않는 문자 제거·소문자)
  claimed_by     uuid references public.profiles(user_id),                      -- 이 이름을 고른 계정. null = 아직 안 들어옴
  claimed_at     timestamptz,
  seq            bigint not null generated always as identity,                  -- 표시 순서 = 적은 순서
  constraint invitees_pkey primary key (appointment_id, name_key),
  constraint invitees_one_slot_per_user unique (appointment_id, claimed_by),
  check ((claimed_by is null) = (claimed_at is null))
);
create index invitees_claimed_idx on public.invitees (claimed_by);

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
  meta           jsonb not null default '{}'::jsonb, -- reason: signup | topup | leave | canceled | kicked | policy_change | notStarted, anon: 익명 계정 여부
  created_at     timestamptz not null default now(),
  check ((kind in ('grant','relief')) = (appointment_id is null)),
  check ((kind = 'hold') = (amount < 0))
);
create index ledger_user_idx on public.ledger (user_id, id desc);
create index ledger_appt_idx on public.ledger (appointment_id);
create unique index ledger_one_payout on public.ledger (appointment_id, user_id) where kind = 'payout';
create unique index ledger_one_grant  on public.ledger (user_id) where kind = 'grant';

create table private.lb_bans (                       -- 내보내며 차단한 계정
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
alter table public.invitees     enable row level security;
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

create policy profiles_select_own        on public.profiles     for select to authenticated using (user_id = (select auth.uid()));
create policy appointments_select_member on public.appointments for select to authenticated using ((select private.lb_is_member(id)));
create policy participants_select_member on public.participants for select to authenticated using ((select private.lb_is_member(appointment_id)));
create policy invitees_select_member     on public.invitees     for select to authenticated using ((select private.lb_is_member(appointment_id)));
create policy ledger_select_own          on public.ledger       for select to authenticated using (user_id = (select auth.uid()));
-- locations 와 private.* 테이블: 정책 없음 = 직접 조회 불가. 명단은 멤버가 아니어도 lb_peek_invite 로만 본다(자기 이름을 골라야 하므로).

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

-- 스테이크(또는 걸 포인트 인상분) 걸기. 잔액이 모자라면 '가진 것 전부(잔액 + 열린 약속들에 이미 걸려 있는 포인트)'가 1000 미만일 때에 한해 부족분만 채워 준다.
-- 걸려 있는 포인트는 원장에서 센다(이 약속에 이미 걸린 옛 스테이크도 재산이다 — 인상분 추가 에스크로 때 정확해야 한다).
create function private.lb_hold(p_user uuid, p_appt uuid, p_stake int, p_meta jsonb default '{}'::jsonb) returns void
language plpgsql volatile set search_path = '' as $$
declare v_bal int; v_escrow int;
begin
  if p_stake <= 0 then return; end if;
  select balance into v_bal from public.profiles where user_id = p_user for update;
  if not found then raise exception 'LB_NO_PROFILE'; end if;
  if v_bal < p_stake then
    select coalesce(-sum(l.amount), 0) into v_escrow
      from public.ledger l join public.appointments a on a.id = l.appointment_id
     where l.user_id = p_user and a.status = 'open';
    if v_bal + v_escrow >= 1000 then raise exception 'LB_INSUFFICIENT_POINTS'; end if;
    perform private.lb_post(p_user, null, 'relief', p_stake - v_bal, jsonb_build_object('reason', 'topup', 'for', p_appt));
  end if;
  perform private.lb_post(p_user, p_appt, 'hold', -p_stake, p_meta);
end $$;

-- 체크인·위치 공개 마감. lateBet.ts locationShareWindow().endMs(= latePhase.lateTimes().closeMs)와 같은 식이어야 한다(패리티).
-- 내기 없음·단위 차감 0 → 약속 + 60분. 그 외 → min(약속 + 180분, 전액 몰수 시각 + 30분 꼬리).
-- 전액 몰수 시각 = 약속 + 봐주는 시간 + (ceil(stake/ppu) − 1) × 단위. 꼬리 30 = SHARE_TAIL_AFTER_FULL_FORFEIT_MINUTES(오너 결정 변경 3:
-- 전액을 잃은 뒤에도 오고 있는 사람을 30분 더 보여 준다. 꼬리 안에 온 사람은 '오지 않음'이 아니라 '지각(전액)'으로 남는다).
create function private.lb_close_at(p_meet timestamptz, p_stake int, p_unit int, p_ppu int, p_grace int)
returns timestamptz language sql immutable as $$
  select case when p_stake = 0 or p_ppu = 0 then p_meet + interval '60 minutes'
    else least(p_meet + interval '180 minutes',
               p_meet + make_interval(mins => p_grace + (ceil(p_stake::numeric / p_ppu)::int - 1) * p_unit + 30)) end;
$$;

-- 타임존이 장소 경도(경도/15)와 1.5시간 넘게 어긋나면 확인 없이는 거부(여행 약속 사고 방지)
create function private.lb_check_tz(p_meet timestamptz, p_tz text, p_lng float8, p_tz_confirmed boolean) returns void
language plpgsql stable set search_path = '' as $$
declare v_off_h numeric;
begin
  v_off_h := extract(epoch from ((p_meet at time zone p_tz) - (p_meet at time zone 'UTC'))) / 3600.0;
  if abs(v_off_h - p_lng / 15.0) > 1.5 and not coalesce(p_tz_confirmed, false) then raise exception 'LB_TZ_SUSPECT'; end if;
end $$;

-- 벽시계+타임존 → 절대 시각. 지금+5분 ~ 90일, 시간대 의심 검사 포함
create function private.lb_resolve_meet(p_local_at text, p_tz text, p_lng float8, p_tz_confirmed boolean)
returns timestamptz language plpgsql stable set search_path = '' as $$
declare v_meet timestamptz;
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz) then raise exception 'LB_BAD_TZ'; end if;
  if p_local_at is null or p_local_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$' then raise exception 'LB_BAD_TIME'; end if;
  begin
    v_meet := (replace(p_local_at, 'T', ' ')::timestamp) at time zone p_tz;
  exception when others then raise exception 'LB_BAD_TIME';
  end;
  if v_meet <= now() + interval '5 minutes' then raise exception 'LB_TIME_IN_PAST'; end if;
  if v_meet > now() + interval '90 days' then raise exception 'LB_TIME_TOO_FAR'; end if;
  perform private.lb_check_tz(v_meet, p_tz, p_lng, p_tz_confirmed);
  return v_meet;
end $$;

-- 페이로드 조각. 키 이름은 클라이언트 DTO(src/lateBet/types.ts)와 같다. 정책 5개(위치 공개 시점 설정은 없다 — 공개는 [시작하기]부터).
create function private.lb_policy_json(a public.appointments) returns jsonb language sql immutable as $$
  select jsonb_build_object('stake', a.stake, 'radiusM', a.radius_m, 'unitMinutes', a.unit_minutes,
    'penaltyPerUnit', a.penalty_per_unit, 'graceMinutes', a.grace_minutes);
$$;
-- 조건 변경 전후 스냅샷(LbAppointmentSnapshot)
create function private.lb_snapshot(a public.appointments) returns jsonb language sql immutable as $$
  select jsonb_build_object('localAt', a.local_at, 'tz', a.tz, 'meetAtMs', private.lb_ms(a.meet_at),
    'placeName', a.place_name, 'placeLat', a.place_lat, 'placeLng', a.place_lng, 'policy', private.lb_policy_json(a));
$$;
-- 변경 이력에 1건 붙이고 최근 20건만 남긴다
create function private.lb_append_change(p_changes jsonb, p_change jsonb) returns jsonb language sql immutable as $$
  select coalesce((select jsonb_agg(s.e order by s.o)
                     from (select t.e, t.o
                             from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb) || jsonb_build_array(p_change)) with ordinality as t(e, o)
                            order by t.o desc limit 20) s), '[]'::jsonb);
$$;
-- 명단(멤버 화면용 LbInvitee[]): 이름·고른 계정·고른 시각, 적은 순서
create function private.lb_invitees_json(p_appt uuid) returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', i.name, 'claimedByUserId', i.claimed_by,
           'claimedAtMs', private.lb_ms(i.claimed_at)) order by i.seq), '[]'::jsonb)
    from public.invitees i where i.appointment_id = p_appt;
$$;
-- 약속 본문(LbAppointment). lb_create_appointment·lb_start·lb_edit_appointment·lb_edit_invitees·lb_get_live 가 같은 모양을 낸다.
-- startedAtMs = 위치 공개·체크인 시작 시각(null = 시작 전). 공개 창 = [startedAtMs, closeMs].
create function private.lb_appointment_json(a public.appointments) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', a.id, 'inviteCode', a.invite_code, 'hostId', a.host_id,
    'hostNickname', (select p.nickname from public.participants p where p.appointment_id = a.id and p.user_id = a.host_id),
    'title', a.title, 'localAt', a.local_at, 'tz', a.tz, 'meetAtMs', private.lb_ms(a.meet_at),
    'startedAtMs', private.lb_ms(a.started_at), 'closeMs', private.lb_ms(a.close_at),
    'placeName', a.place_name, 'placeNote', a.place_note, 'placeLat', a.place_lat, 'placeLng', a.place_lng,
    'status', a.status, 'voidReason', a.void_reason, 'version', a.version,
    'policy', private.lb_policy_json(a),
    'invitees', private.lb_invitees_json(a.id),
    'changes', a.changes,
    -- 공정성 규칙: 시작하던 순간의 약속 시각·핀(시작 전 null) + 시작 가능 시각(R3 쿨다운이 아직 안 끝났을 때만, 서버 시계 기준)
    'startMeetAtMs', private.lb_ms(a.start_meet_at),
    'startPlaceLat', a.start_place_lat, 'startPlaceLng', a.start_place_lng,
    'startableAtMs', case when a.material_changed_at is not null
                           and a.material_changed_at + interval '5 minutes' > clock_timestamp()   -- START_COOLDOWN_MS(계약: 아직 미래일 때만. 화면은 시작 전에만 쓴다)
                          then private.lb_ms(a.material_changed_at + interval '5 minutes') end);
$$;

-- 명단에 이름 추가. 보이지 않는 문자 제거 후 1~12자(아니면 LB_BAD_NICKNAME). 주최자 이름·이미 있는 이름(비교 키 기준)은 조용히 건너뛴다.
-- 명단은 19명까지(주최자 포함 20명 = participants 상한).
create function private.lb_add_invitees(p_appt uuid, p_names text[], p_host_nick text) returns void
language plpgsql volatile set search_path = '' as $$
declare v_raw text; v_name text;
begin
  foreach v_raw in array coalesce(p_names, '{}'::text[]) loop
    v_name := private.lb_clean_nick(v_raw);
    if char_length(v_name) not between 1 and 12 then raise exception 'LB_BAD_NICKNAME'; end if;
    if private.lb_nick_key(v_name) = private.lb_nick_key(p_host_nick) then continue; end if;
    insert into public.invitees (appointment_id, name) values (p_appt, v_name) on conflict on constraint invitees_pkey do nothing;
  end loop;
  if (select count(*) from public.invitees where appointment_id = p_appt) > 19 then raise exception 'LB_FULL'; end if;
end $$;

-- 참여 마감(멱등): 약속 시각이 지났으면 그때까지 안 들어온 이름을 명단에서 지운다(포인트를 건 적이 없으니 환불 없음).
-- lb_get_live 가 게으르게, lb_settle 이 확정적으로 부른다. 약속 시각 전에는 no-op.
create function private.lb_close_roster(p_appt uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare a public.appointments;
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found or a.status <> 'open' or now() < a.meet_at then return; end if;
  delete from public.invitees where appointment_id = p_appt and claimed_by is null;
end $$;

-- 정산(멱등). 약속 행 잠금 + status 검사 + payout 유니크 + 끝에서 합계 0 단언.
-- 두 갈래: (a) 시작이 안 된 약속은 약속 시각에 자동 무효(void_reason 'notStarted', 전원 refund). 체크인이 열린 적이 없으니 전원 '오지 않음'(forfeited·received 0)
--         (b) 시작된 약속은 close_at + 15초가 지났거나 (전원 도착 ∧ 약속 시각 이후)일 때 엔진(lb_settle_preview)으로 정산
create function private.lb_settle(p_appt uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare a public.appointments; v_arrivals jsonb; v_res jsonb; p jsonb; v_all_arrived boolean; r record;
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found or a.status <> 'open' then return; end if;               -- 두 번째 트리거는 no-op

  if a.started_at is null then                                          -- (a) 주최자가 약속 시각까지 [시작하기]를 누르지 않았다
    if now() < a.meet_at then return; end if;
    delete from public.invitees where appointment_id = p_appt and claimed_by is null;   -- 안 들어온 이름 삭제(환불 없음)
    for r in select user_id from public.participants where appointment_id = p_appt order by user_id loop   -- 교착 방지: 항상 user_id 순
      update public.participants set result_status = 'noShow', forfeited = 0, received = 0
       where appointment_id = p_appt and user_id = r.user_id;
      if a.stake > 0 then perform private.lb_post(r.user_id, p_appt, 'refund', a.stake, '{"reason":"notStarted"}'); end if;
    end loop;
    update public.appointments                                            -- 내기 없음(stake 0)이면 무효가 아니라 그냥 끝남(엔진의 noStake 와 같은 규칙)
       set status = case when a.stake > 0 then 'voided' else 'settled' end, void_reason = 'notStarted', settled_at = now()
     where id = p_appt;
    delete from public.locations where appointment_id = p_appt;
    if (select coalesce(sum(amount), 0) from public.ledger where appointment_id = p_appt) <> 0 then
      raise exception 'LB_INVARIANT_ESCROW_NONZERO';
    end if;
    return;
  end if;

  select coalesce(bool_and(arrived_at is not null), false) into v_all_arrived
    from public.participants where appointment_id = p_appt;
  -- close_at + 15초: close_at 직전에 시작한 체크인 트랜잭션(문장 타임아웃 8초)이 반드시 먼저 끝나게 하는 여유
  if not (now() > a.close_at + interval '15 seconds' or (v_all_arrived and now() >= a.meet_at)) then return; end if;

  perform private.lb_close_roster(p_appt);   -- 약속 시각까지 안 들어온 이름 삭제. 두 정산 조건 모두 now() >= meet_at 을 함의한다

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

-- 2) 약속 생성(초대 명단 + 주최자 자동 참여 + 스테이크 에스크로). 시작 전(started_at null) 상태로 만들어진다.
--    p_request_id(선택) = 멱등 키: 같은 주최자가 같은 키로 다시 부르면 새로 만들지 않고 그때 만든 약속을 그대로 돌려준다
--    (8초 타임아웃 뒤 서버는 커밋했는데 클라이언트가 [만들기]를 다시 누른 경우 — 약속·에스크로·초대 코드가 두 번 생기지 않게).
--    검사(동의·열린 약속 10개 등)보다 먼저 본다 — 첫 요청이 이미 통과했으므로. 같은 키 동시 요청은 advisory lock 으로 줄 세운다.
create function public.lb_create_appointment(
  p_title text, p_local_at text, p_tz text,
  p_place_name text, p_place_note text, p_lat float8, p_lng float8,
  p_policy jsonb, p_invitees text[], p_consent boolean, p_tz_confirmed boolean default false,
  p_request_id uuid default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.lb_uid(); v_me public.profiles; a public.appointments; v_meet timestamptz;
  v_stake int := coalesce((p_policy->>'stake')::int, 0);
  v_radius int := coalesce((p_policy->>'radiusM')::int, 100);
  v_unit int := coalesce((p_policy->>'unitMinutes')::int, 5);
  v_ppu int := coalesce((p_policy->>'penaltyPerUnit')::int, 0);
  v_grace int := coalesce((p_policy->>'graceMinutes')::int, 0);
begin
  select * into v_me from public.profiles where user_id = v_uid;
  if not found then raise exception 'LB_NO_PROFILE'; end if;
  if p_request_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('lb_create:' || v_uid::text || ':' || p_request_id::text, 0));
    select * into a from public.appointments where host_id = v_uid and request_id = p_request_id;
    if found then return private.lb_appointment_json(a); end if;   -- 재시도: 같은 약속(에스크로 추가 없음)
  end if;
  if not coalesce(p_consent, false) then raise exception 'LB_CONSENT_REQUIRED'; end if;
  if (select count(*) from public.appointments where host_id = v_uid and status = 'open') >= 10 then
    raise exception 'LB_TOO_MANY_OPEN';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'LB_BAD_POSITION';                                  -- 범위 밖 핀도 CHECK(23514) 가 아니라 위치 오류(수정·fakeApi 와 같다)
  end if;
  v_meet := private.lb_resolve_meet(p_local_at, p_tz, p_lng, p_tz_confirmed);

  insert into public.appointments (invite_code, host_id, title, local_at, tz, meet_at,
      place_name, place_note, place_lat, place_lng,
      stake, radius_m, unit_minutes, penalty_per_unit, grace_minutes, close_at, request_id)
  values (private.lb_new_invite_code(), v_uid, btrim(p_title),
      to_char(v_meet at time zone p_tz, 'YYYY-MM-DD"T"HH24:MI'), p_tz, v_meet,   -- DST 로 없는 시각을 넣어도 표시와 판정이 일치하도록 서버가 다시 쓴다
      btrim(p_place_name), btrim(coalesce(p_place_note, '')), p_lat, p_lng,   -- 메모도 제목·장소처럼 양끝 공백을 지운다
      v_stake, v_radius, v_unit, v_ppu, v_grace,
      private.lb_close_at(v_meet, v_stake, v_unit, v_ppu, v_grace), p_request_id)
  returning * into a;   -- 범위 위반은 CHECK 제약이 거른다(23514)

  insert into public.participants (appointment_id, user_id, nickname) values (a.id, v_uid, v_me.nickname);
  perform private.lb_hold(v_uid, a.id, a.stake);
  perform private.lb_add_invitees(a.id, p_invitees, v_me.nickname);
  return private.lb_appointment_json(a);
end $$;

-- 3) 초대 코드 미리보기(참여 전 조건 확인용). 명단은 멤버가 아니어도 보인다(자기 이름을 골라야 하므로) — 누가 골랐는지는 claimed 로만.
--    약속 시각이 지났으면 여기서도 게으른 참여 마감(안 들어온 이름 삭제)·시작 안 된 약속의 자동 무효를 먼저 한다(fakeApi 의 tick 과 같은 타이밍 —
--    약속 시각이 지난 초대장에 고를 수 있는 빈 이름이 남아 보이지 않게).
create function public.lb_peek_invite(p_code text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid(); a public.appointments; v_member boolean;
begin
  select * into a from public.appointments where invite_code = upper(btrim(coalesce(p_code, '')));
  if not found or exists (select 1 from private.lb_bans where appointment_id = a.id and user_id = v_uid) then
    raise exception 'LB_INVITE_NOT_FOUND';
  end if;
  if a.status = 'open' and now() >= a.meet_at then
    perform private.lb_close_roster(a.id);
    if a.started_at is null or now() > a.close_at + interval '15 seconds' then perform private.lb_try_settle(a.id); end if;
    select * into a from public.appointments where id = a.id;
  end if;
  v_member := exists (select 1 from public.participants where appointment_id = a.id and user_id = v_uid);
  return jsonb_build_object(
    'id', a.id, 'title', a.title,
    'hostNickname', (select nickname from public.participants where appointment_id = a.id and user_id = a.host_id),
    'localAt', a.local_at, 'tz', a.tz, 'meetAtMs', private.lb_ms(a.meet_at),
    'startedAtMs', private.lb_ms(a.started_at), 'closeMs', private.lb_ms(a.close_at),
    'placeName', a.place_name, 'placeNote', a.place_note, 'placeLat', a.place_lat, 'placeLng', a.place_lng,
    'status', a.status, 'version', a.version,
    'serverNowMs', private.lb_ms(clock_timestamp()),
    'policy', private.lb_policy_json(a),
    'memberCount', (select count(*) from public.participants where appointment_id = a.id),
    'invitees', (select coalesce(jsonb_agg(jsonb_build_object('name', i.name, 'claimed', i.claimed_by is not null,
                   'mine', coalesce(i.claimed_by = v_uid, false)) order by i.seq), '[]'::jsonb)
                   from public.invitees i where i.appointment_id = a.id),
    'myState', case when v_member then 'active' end,
    'myBalance', (select balance from public.profiles where user_id = v_uid));
end $$;

-- 4) 참여 = 명단에서 내 이름 고르기(멱등). 약속 시각 전이면 언제든(시작 후에도 — 들어오면 그때부터 위치 공개·판정 대상). 즉시 에스크로.
--    명단에 없는 이름 → LB_NOT_INVITED, 남이 이미 고른 이름 → LB_SLOT_TAKEN. 약속 시각이 지났거나 닫힌 약속 → LB_JOIN_CLOSED.
--    반환 started = 이미 시작된 약속에 들어왔다(클라이언트는 대기실이 아니라 live 화면으로).
create function public.lb_claim_slot(p_appt uuid, p_name text, p_version int, p_consent boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.lb_uid(); a public.appointments; inv public.invitees;
  v_name text := private.lb_clean_nick(p_name);
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found or exists (select 1 from private.lb_bans where appointment_id = a.id and user_id = v_uid) then
    raise exception 'LB_INVITE_NOT_FOUND';
  end if;
  if exists (select 1 from public.participants where appointment_id = a.id and user_id = v_uid) then
    return jsonb_build_object('appointmentId', a.id, 'state', 'active', 'started', a.started_at is not null);   -- 이미 멤버
  end if;

  if a.status <> 'open' or clock_timestamp() >= a.meet_at then raise exception 'LB_JOIN_CLOSED'; end if;   -- 락을 잡은 뒤 다시 본다
  if p_version is distinct from a.version then raise exception 'LB_APPT_CHANGED'; end if;
  if not coalesce(p_consent, false) then raise exception 'LB_CONSENT_REQUIRED'; end if;
  if not exists (select 1 from public.profiles where user_id = v_uid) then raise exception 'LB_NO_PROFILE'; end if;
  if char_length(v_name) not between 1 and 12 then raise exception 'LB_BAD_NICKNAME'; end if;
  select * into inv from public.invitees where appointment_id = a.id and name_key = private.lb_nick_key(v_name);
  if not found then raise exception 'LB_NOT_INVITED'; end if;
  if inv.claimed_by is not null then raise exception 'LB_SLOT_TAKEN'; end if;
  if exists (select 1 from public.participants
              where appointment_id = a.id and private.lb_nick_key(nickname) = inv.name_key) then
    raise exception 'LB_NICKNAME_TAKEN';                                -- 주최자 이름과 겹치는 경우(명단 추가 때 걸러지지만 이중 방어)
  end if;
  if (select count(*) from public.participants where appointment_id = a.id) >= 20 then raise exception 'LB_FULL'; end if;

  insert into public.participants (appointment_id, user_id, nickname) values (a.id, v_uid, inv.name);   -- 표기는 주최자가 적은 그대로
  update public.invitees set claimed_by = v_uid, claimed_at = now() where appointment_id = a.id and name_key = inv.name_key;
  perform private.lb_hold(v_uid, a.id, a.stake);   -- 부족하고 채워줄 수도 없으면 예외 → 전체 롤백
  return jsonb_build_object('appointmentId', a.id, 'state', 'active', 'started', a.started_at is not null);
end $$;

-- 4.5) 시작하기(주최자): 이 순간부터 전원 위치가 서로 보이고 체크인이 열린다. 약속 시각 전이면 언제든(참여 인원 조건 없음 — 혼자여도 된다).
--    이미 시작됐으면 LB_ALREADY_STARTED(되돌릴 수 없다 — 취소는 별개). 약속 시각이 지났거나 닫힌 약속 → LB_START_CLOSED.
--    started_at = 이 트랜잭션의 now()(도착 시각과 같은 기준). 락을 잡은 뒤 clock_timestamp() 로 약속 시각을 다시 본다.
--    R3: 참가자가 있을 때 조건을 바꿨다면(material_changed_at) 그 뒤 5분(START_COOLDOWN_MS)이 지나야 시작할 수 있다(LB_START_COOLDOWN).
--    시작하는 순간의 약속 시각·핀을 start_meet_at·start_place_* 에 박제한다(R1·R2 누적 한도의 기준).
create function public.lb_start(p_appt uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid(); a public.appointments;
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found or a.host_id <> v_uid then raise exception 'LB_NOT_HOST'; end if;
  if a.started_at is not null then raise exception 'LB_ALREADY_STARTED'; end if;
  if a.status <> 'open' or clock_timestamp() >= a.meet_at then raise exception 'LB_START_CLOSED'; end if;
  if a.material_changed_at is not null and clock_timestamp() < a.material_changed_at + interval '5 minutes' then
    raise exception 'LB_START_COOLDOWN';                                -- 친구들이 바뀐 내용을 볼 시간
  end if;
  update public.appointments
     set started_at = date_trunc('milliseconds', now()),
         start_meet_at = meet_at, start_place_lat = place_lat, start_place_lng = place_lng
   where id = p_appt returning * into a;
  return private.lb_appointment_json(a);
end $$;

-- 5) 명단 편집(주최자, 시작 전): 이름 추가 + 아직 안 들어온 이름 삭제. 들어온 이름은 지울 수 없다(LB_INVITEE_JOINED → 내보내기를 쓴다).
--    시작 후에는 LB_EDIT_FROZEN(안 들어온 이름은 약속 시각까지 스스로 들어오거나 그때 자동 삭제된다). 명단은 조건이 아니므로 version 을 올리지 않는다.
create function public.lb_edit_invitees(p_appt uuid, p_add text[] default null, p_remove text[] default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid(); a public.appointments; v_raw text; v_key text; v_host_nick text;
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found or a.host_id <> v_uid then raise exception 'LB_NOT_HOST'; end if;
  if a.status <> 'open' then raise exception 'LB_EDIT_CLOSED'; end if;
  if a.started_at is not null then raise exception 'LB_EDIT_FROZEN'; end if;
  if clock_timestamp() >= a.meet_at then raise exception 'LB_EDIT_CLOSED'; end if;   -- 시작 없이 약속 시각이 지남 = 곧 자동 무효
  foreach v_raw in array coalesce(p_remove, '{}'::text[]) loop
    v_key := private.lb_nick_key(v_raw);
    if exists (select 1 from public.invitees where appointment_id = p_appt and name_key = v_key and claimed_by is not null) then
      raise exception 'LB_INVITEE_JOINED';
    end if;
    delete from public.invitees where appointment_id = p_appt and name_key = v_key;   -- 없는 이름은 무시
  end loop;
  select nickname into v_host_nick from public.participants where appointment_id = p_appt and user_id = v_uid;
  perform private.lb_add_invitees(p_appt, p_add, v_host_nick);
  return private.lb_appointment_json(a);
end $$;

-- 6) 나가기: 시작 전까지만(전액 환불). 명단의 내 자리는 비워져 다시 들어올 수 있다. 주최자는 불가.
create function public.lb_leave(p_appt uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid(); a public.appointments;
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found then raise exception 'LB_NOT_FOUND'; end if;
  if not exists (select 1 from public.participants where appointment_id = p_appt and user_id = v_uid) then return; end if;
  if a.host_id = v_uid then raise exception 'LB_HOST_CANNOT_LEAVE'; end if;
  if a.status <> 'open' or a.started_at is not null then raise exception 'LB_LEAVE_CLOSED'; end if;
  delete from public.participants where appointment_id = p_appt and user_id = v_uid;   -- 좌표는 FK cascade
  update public.invitees set claimed_by = null, claimed_at = null where appointment_id = p_appt and claimed_by = v_uid;
  if a.stake > 0 then perform private.lb_post(v_uid, p_appt, 'refund', a.stake, '{"reason":"leave"}'); end if;
end $$;

-- 7) 내보내기(주최자, 정산 전까지). 전액 환불 + 좌표 즉시 삭제(FK cascade) + p_ban 이면 같은 계정의 재참여 금지.
--    - 시작 전: 누구든. 명단에서도 그 이름을 뺀다(주최자가 명단 편집으로 다시 넣을 수 있다).
--    - 시작 후(R4, 오너 결정 2026-09-19): '시작 뒤에 들어온 사람'(invitees.claimed_at > started_at)만, 마감(close_at) 전까지. 초대 코드가 새서 남의 이름으로
--      들어온 낯선 사람 대처용이라, 이름 칸은 지우지 않고 비운다(명단 편집이 막힌 뒤라 진짜 그 사람이 약속 시각 전까지 다시 고를 수 있게).
--      시작 전부터 있던 참가자는 LB_KICK_CLOSED(정산 직전 당첨자를 빼서 주최자 몫을 키우는 악용 방지).
create function public.lb_kick(p_appt uuid, p_target uuid, p_ban boolean default true) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid(); a public.appointments; v_claimed_at timestamptz;
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found or a.host_id <> v_uid then raise exception 'LB_NOT_HOST'; end if;
  if p_target = v_uid then raise exception 'LB_HOST_CANNOT_LEAVE'; end if;
  if not exists (select 1 from public.participants where appointment_id = p_appt and user_id = p_target) then return; end if;
  if a.status <> 'open' then raise exception 'LB_KICK_CLOSED'; end if;
  if a.started_at is not null then
    -- 정산이 시작된 뒤(now > close_at — 결과가 이미 정해진 뒤, 게으른 정산이 아직 안 돌았어도)에는 못 내보낸다. 화면의 settlePending 과 같은 기준
    if clock_timestamp() > a.close_at then raise exception 'LB_KICK_CLOSED'; end if;
    select claimed_at into v_claimed_at from public.invitees where appointment_id = p_appt and claimed_by = p_target;
    -- ms 로 비교한다: started_at 은 ms 절삭, claimed_at 은 μs 라 시작 직전 같은 ms 에 고른 사람이 '시작 뒤'로 잘못 잡히지 않게(애매하면 못 내보내는 쪽)
    if v_claimed_at is null or private.lb_ms(v_claimed_at) <= private.lb_ms(a.started_at) then raise exception 'LB_KICK_CLOSED'; end if;
  end if;
  delete from public.participants where appointment_id = p_appt and user_id = p_target;
  if a.started_at is null then
    delete from public.invitees where appointment_id = p_appt and claimed_by = p_target;
  else
    update public.invitees set claimed_by = null, claimed_at = null where appointment_id = p_appt and claimed_by = p_target;
  end if;
  if a.stake > 0 then perform private.lb_post(p_target, p_appt, 'refund', a.stake, '{"reason":"kicked"}'); end if;
  if coalesce(p_ban, true) then
    insert into private.lb_bans (appointment_id, user_id) values (p_appt, p_target) on conflict do nothing;
  end if;
end $$;

-- 9) 제목·메모 수정(주최자, 열려 있는 동안 언제든). 조건이 아니므로 version 을 올리지 않는다.
create function public.lb_update_memo(p_appt uuid, p_title text, p_place_note text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid();
begin
  update public.appointments set title = btrim(p_title), place_note = btrim(coalesce(p_place_note, ''))
   where id = p_appt and host_id = v_uid and status = 'open';
  if not found then raise exception 'LB_NOT_HOST'; end if;
end $$;

-- 10) 조건 수정(주최자). p_patch 는 바꿀 필드만: {localAt, tz, placeName, lat, lng, policy{…}, tzConfirmed}. p_version = 마지막으로 본 version.
--    - 시작 전: 전부. 걸 포인트가 오르면 참가자 전원에게 차액 추가 에스크로(부족분 자동 채움, 안 되면 LB_INSUFFICIENT_POINTS + detail=닉네임),
--      내리면 전원 차액 환불. 항상 user_id 오름차순(교착 방지).
--    - 시작 후: 시간은 뒤로 미루기만(LB_POSTPONE_ONLY), 장소(이름·핀)는 변경 가능. 걸 포인트·지각 규칙·반경이 바뀌면 LB_EDIT_FROZEN. 이미 찍힌 도착은 유지.
--      공정성 규칙(오너 결정 2026-09-19, 판정은 전부 서버 시계·약속 행 잠금 아래):
--      R1 미루기는 지금 약속 시각 전에만(LB_POSTPONE_AFTER_MEET), 한도는 시작하던 순간의 약속 시각(start_meet_at) + 180분 누적
--         (POSTPONE_MAX_MINUTES_AFTER_START, 넘으면 LB_POSTPONE_TOO_FAR).
--      R2 새 핀은 시작하던 순간의 핀(start_place_*)에서 500m 이내(MOVE_AFTER_START_MAX_M, 서버 haversine, 넘으면 LB_MOVE_TOO_FAR). 이름만 바꾸는 건 자유.
--    - R3: 주최자 말고 참가자가 있을 때 시각·시간대·핀·정책 5개 중 하나라도 실제로 바뀌면 material_changed_at = now()
--      (이후 5분간 lb_start 거부). 혼자일 때·장소 이름만 바꾼 건 기록하지 않는다.
--    - 정산이 시작된 뒤(now > close_at)·시작 없이 약속 시각이 지남(곧 자동 무효)·닫힌 약속은 LB_EDIT_CLOSED.
--    무엇이든 바뀌면 version+1 + changes 에 전후 스냅샷. 마감(전액 몰수 + 꼬리)은 새 값으로 재계산.
create function public.lb_edit_appointment(p_appt uuid, p_patch jsonb, p_version int) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.lb_uid(); a public.appointments; b public.appointments; r record;
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb); v_pol jsonb;
  v_started boolean; v_confirmed boolean; v_meet timestamptz;
  v_local_at text; v_tz text; v_place_name text; v_lat float8; v_lng float8;
  v_stake int; v_radius int; v_unit int; v_ppu int; v_grace int; v_diff int; v_changed boolean; v_material boolean;
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found or a.host_id <> v_uid then raise exception 'LB_NOT_HOST'; end if;
  if a.status <> 'open' or clock_timestamp() > a.close_at then raise exception 'LB_EDIT_CLOSED'; end if;   -- 정산이 시작된 뒤에는 아무것도 못 바꾼다
  if a.started_at is null and clock_timestamp() >= a.meet_at then raise exception 'LB_EDIT_CLOSED'; end if;   -- 시작 없이 약속 시각이 지남 = 곧 자동 무효
  if p_version is distinct from a.version then raise exception 'LB_APPT_CHANGED'; end if;
  v_started := a.started_at is not null;
  v_pol := coalesce(v_patch->'policy', '{}'::jsonb);
  v_confirmed := coalesce((v_patch->>'tzConfirmed')::boolean, false);

  v_local_at   := coalesce(v_patch->>'localAt', a.local_at);
  v_tz         := coalesce(v_patch->>'tz', a.tz);
  v_place_name := btrim(coalesce(v_patch->>'placeName', a.place_name));
  v_lat        := coalesce((v_patch->>'lat')::float8, a.place_lat);
  v_lng        := coalesce((v_patch->>'lng')::float8, a.place_lng);
  if (v_patch ? 'lat') <> (v_patch ? 'lng') then raise exception 'LB_BAD_POSITION'; end if;   -- 핀은 lat·lng 둘 다(fakeApi 와 같다)
  v_stake  := coalesce((v_pol->>'stake')::int, a.stake);
  v_radius := coalesce((v_pol->>'radiusM')::int, a.radius_m);
  v_unit   := coalesce((v_pol->>'unitMinutes')::int, a.unit_minutes);
  v_ppu    := coalesce((v_pol->>'penaltyPerUnit')::int, a.penalty_per_unit);
  v_grace  := coalesce((v_pol->>'graceMinutes')::int, a.grace_minutes);
  if v_lat not between -90 and 90 or v_lng not between -180 and 180 then raise exception 'LB_BAD_POSITION'; end if;

  -- R1: 시작 후 시각 변경은 지금 약속 시각 전에만. '지금+5분' 검사(LB_TIME_IN_PAST)보다 먼저 본다(약속 시각이 지난 뒤의 미루기가 엉뚱한 오류로 막히지 않게)
  if v_started and (v_local_at <> a.local_at or v_tz <> a.tz) and clock_timestamp() >= a.meet_at then
    raise exception 'LB_POSTPONE_AFTER_MEET';
  end if;

  if v_local_at <> a.local_at or v_tz <> a.tz then
    v_meet := private.lb_resolve_meet(v_local_at, v_tz, v_lng, v_confirmed);   -- 시각이 바뀔 때만 '지금+5분~90일' 검사(지각 중 장소만 바꾸는 경우를 막지 않게)
  else
    v_meet := a.meet_at;
    if v_lng <> a.place_lng then perform private.lb_check_tz(v_meet, v_tz, v_lng, v_confirmed); end if;
  end if;

  if v_started then
    if v_stake <> a.stake or v_radius <> a.radius_m or v_unit <> a.unit_minutes or v_ppu <> a.penalty_per_unit
       or v_grace <> a.grace_minutes then
      raise exception 'LB_EDIT_FROZEN';
    end if;
    if v_meet < a.meet_at then raise exception 'LB_POSTPONE_ONLY'; end if;
    if v_meet > coalesce(a.start_meet_at, a.meet_at) + interval '180 minutes' then   -- R1: 시작 시점 기준 누적 한도
      raise exception 'LB_POSTPONE_TOO_FAR';
    end if;
    if (v_lat <> a.place_lat or v_lng <> a.place_lng)                                 -- R2: 시작 시점 핀 기준 누적 거리
       and private.lb_haversine_m(coalesce(a.start_place_lat, a.place_lat), coalesce(a.start_place_lng, a.place_lng), v_lat, v_lng) > 500 then
      raise exception 'LB_MOVE_TOO_FAR';
    end if;
  end if;

  v_changed := v_meet <> a.meet_at or v_tz <> a.tz or v_place_name <> a.place_name or v_lat <> a.place_lat or v_lng <> a.place_lng
            or v_stake <> a.stake or v_radius <> a.radius_m or v_unit <> a.unit_minutes or v_ppu <> a.penalty_per_unit
            or v_grace <> a.grace_minutes;
  if not v_changed then return private.lb_appointment_json(a); end if;
  -- R3: 조건(시각·시간대·핀·정책)이 실제로 바뀌었고 주최자 말고 참가자가 있다 → 쿨다운 기록(시작 후에도 기록은 하지만 lb_start 가 다시 불릴 일이 없어 무해)
  v_material := (v_meet <> a.meet_at or v_tz <> a.tz or v_lat <> a.place_lat or v_lng <> a.place_lng
                 or v_stake <> a.stake or v_radius <> a.radius_m or v_unit <> a.unit_minutes or v_ppu <> a.penalty_per_unit
                 or v_grace <> a.grace_minutes)
            and exists (select 1 from public.participants where appointment_id = p_appt and user_id <> a.host_id);

  v_diff := v_stake - a.stake;   -- 시작 후에는 0 (위에서 동결 검사)
  if v_diff <> 0 then
    for r in select user_id, nickname from public.participants where appointment_id = p_appt order by user_id loop
      if v_diff > 0 then
        begin
          perform private.lb_hold(r.user_id, p_appt, v_diff, '{"reason":"policy_change"}');
        exception when others then
          if sqlerrm like 'LB_INSUFFICIENT_POINTS%' then
            raise exception 'LB_INSUFFICIENT_POINTS' using detail = r.nickname;   -- 주최자 화면: "포인트가 모자란 친구가 있어 걸 포인트를 올릴 수 없어요"
          end if;
          raise;
        end;
      else
        perform private.lb_post(r.user_id, p_appt, 'refund', -v_diff, '{"reason":"policy_change"}');
      end if;
    end loop;
  end if;

  b := a;   -- 변경 전 스냅샷
  update public.appointments set
    local_at = to_char(v_meet at time zone v_tz, 'YYYY-MM-DD"T"HH24:MI'), tz = v_tz, meet_at = v_meet,
    place_name = v_place_name, place_lat = v_lat, place_lng = v_lng,
    stake = v_stake, radius_m = v_radius, unit_minutes = v_unit, penalty_per_unit = v_ppu, grace_minutes = v_grace,
    close_at = private.lb_close_at(v_meet, v_stake, v_unit, v_ppu, v_grace),   -- 새 값으로 다시 계산(공개 창 끝 = 체크인 마감)
    material_changed_at = case when v_material then date_trunc('milliseconds', now()) else a.material_changed_at end,
    version = a.version + 1
  where id = p_appt returning * into a;                                -- 범위 위반은 CHECK 제약이 거른다(23514)
  update public.appointments
     set changes = private.lb_append_change(changes, jsonb_build_object(
           'version', a.version, 'atMs', private.lb_ms(now()), 'before', private.lb_snapshot(b), 'after', private.lb_snapshot(a)))
   where id = p_appt returning * into a;
  if v_lat <> b.place_lat or v_lng <> b.place_lng then                 -- 옛 장소 근처에 있었다는 기록은 새 장소의 근거가 못 된다
    update public.participants set first_near_at = null where appointment_id = p_appt and arrived_at is null;
  end if;
  return private.lb_appointment_json(a);
end $$;

-- 11) 취소(주최자): 다른 참가자가 있으면 시작 전까지만, 혼자면 언제든. 전원 환불. (시작은 되돌릴 수 없지만 취소는 별개의 길)
create function public.lb_cancel(p_appt uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid(); a public.appointments; r record;
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found or a.host_id <> v_uid then raise exception 'LB_NOT_HOST'; end if;
  if a.status <> 'open' then raise exception 'LB_CANCEL_CLOSED'; end if;
  if a.started_at is not null
     and exists (select 1 from public.participants where appointment_id = p_appt and user_id <> v_uid) then
    raise exception 'LB_CANCEL_CLOSED';
  end if;
  if a.stake > 0 then
    for r in select user_id from public.participants where appointment_id = p_appt order by user_id loop
      perform private.lb_post(r.user_id, p_appt, 'refund', a.stake, '{"reason":"canceled"}');
    end loop;
  end if;
  update public.appointments set status = 'canceled', settled_at = now() where id = p_appt;
  delete from public.locations where appointment_id = p_appt;
end $$;

-- 12) 위치 보고 = 도착 판정. 시각은 서버 now(), 거리는 서버가 계산. p_share=false 면 좌표를 저장하지 않는다(판정만).
--     체크인은 주최자가 시작한 뒤(started_at ~ close_at)에만 열린다. 시작 전에는 not_open(좌표도 저장하지 않는다).
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
  if a.status = 'open' and a.started_at is null and now() >= a.meet_at then   -- 시작 없이 약속 시각이 지남 → 자동 무효(게으른 정산)
    perform private.lb_try_settle(p_appt);
    select * into a from public.appointments where id = p_appt;
  end if;

  if a.status <> 'open' then v_reason := 'closed';
  elsif me.arrived_at is not null then v_reason := 'already_arrived';
  elsif a.started_at is null or v_now < a.started_at then v_reason := 'not_open';
  elsif v_now > a.close_at then perform private.lb_try_settle(p_appt); v_reason := 'closed';
  elsif p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then v_reason := 'bad_position';
  end if;
  if v_reason is not null then
    return jsonb_build_object('arrived', me.arrived_at is not null, 'reason', v_reason,
      'arrivedAtMs', private.lb_ms(me.arrived_at), 'distanceM', null,
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
    perform private.lb_try_settle(p_appt);                                           -- 전원 도착 ∧ 약속 시각 이후면 즉시 정산(아니면 no-op)
    return jsonb_build_object('arrived', true, 'reason', null, 'arrivedAtMs', private.lb_ms(v_now),
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
  return jsonb_build_object('arrived', false, 'reason', v_reason, 'arrivedAtMs', null, 'distanceM', round(v_dist),
                            'serverNowMs', private.lb_ms(clock_timestamp()));
end $$;

-- 13) 위치 공유 끄기: 내 좌표 행을 즉시 지운다(화면 이탈·백그라운드 전환·토글 OFF 때 호출)
create function public.lb_stop_sharing(p_appt uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid();
begin
  delete from public.locations where appointment_id = p_appt and user_id = v_uid;
end $$;

-- 14) 보증 도착: GPS 로 도착한 사람이 "같이 있어요". 시각 = 대상의 first_near_at(있으면) 아니면 누른 순간. 시작 전 LB_NOT_STARTED, 창 밖 LB_CLOSED.
create function public.lb_vouch(p_appt uuid, p_target uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid(); a public.appointments; v_now timestamptz := date_trunc('milliseconds', now());
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found or a.status <> 'open' then raise exception 'LB_CLOSED'; end if;
  if a.started_at is null then raise exception 'LB_NOT_STARTED'; end if;
  if v_now < a.started_at or v_now > a.close_at then raise exception 'LB_CLOSED'; end if;
  if p_target = v_uid then raise exception 'LB_CANNOT_VOUCH_SELF'; end if;
  if not exists (select 1 from public.participants
                 where appointment_id = p_appt and user_id = v_uid and arrival_method = 'gps') then
    raise exception 'LB_VOUCHER_NOT_ARRIVED';                          -- 보증의 연쇄 금지
  end if;
  update public.participants
     set arrived_at = coalesce(first_near_at, v_now), arrival_method = 'vouch', vouched_by = v_uid
   where appointment_id = p_appt and user_id = p_target and arrived_at is null;
  if not found then return; end if;
  delete from public.locations where appointment_id = p_appt and user_id = p_target;
  perform private.lb_try_settle(p_appt);
end $$;

-- 15) 화면 전체 상태 1방 조회(폴링 대상). 약속 시각이 지났으면 여기서 게으른 참여 마감(안 들어온 이름 삭제)·
--     시작 안 된 약속의 자동 무효, 정산 조건이 됐으면 게으른 정산.
create function public.lb_get_live(p_appt uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid(); a public.appointments; me public.participants; v_share_open boolean;
begin
  if not exists (select 1 from public.participants where appointment_id = p_appt and user_id = v_uid) then
    raise exception 'LB_NOT_MEMBER';
  end if;
  select * into a from public.appointments where id = p_appt;          -- 평소 폴링은 행 락을 잡지 않는다
  if a.status = 'open' and now() >= a.meet_at
     and exists (select 1 from public.invitees where appointment_id = p_appt and claimed_by is null) then
    perform private.lb_close_roster(p_appt);                           -- 약속 시각까지 안 들어온 이름 삭제(환불 없음)
  end if;
  if a.status = 'open' and (
       (a.started_at is null and now() >= a.meet_at)                   -- 시작 없이 약속 시각 → 자동 무효
    or now() > a.close_at + interval '15 seconds'
    or (now() >= a.meet_at and not exists (select 1 from public.participants
                                            where appointment_id = p_appt and arrived_at is null))
  ) then
    perform private.lb_try_settle(p_appt);
    select * into a from public.appointments where id = p_appt;
  end if;
  perform private.lb_purge_stale_locations();

  select * into me from public.participants where appointment_id = p_appt and user_id = v_uid;
  if not found then raise exception 'LB_NOT_MEMBER'; end if;
  -- 남의 위치가 보이는 조건: 약속 open ∧ 시작됨 ∧ 공개 창 안(started_at ≤ now ≤ close_at). 대상 미도착 ∧ 3분 내 갱신은 행마다 본다.
  v_share_open := a.status = 'open' and a.started_at is not null and now() >= a.started_at and now() <= a.close_at;

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
    'myUserId', v_uid, 'myState', 'active',
    'myBalance', (select balance from public.profiles where user_id = v_uid),
    'settlePending', a.status = 'open' and (now() > a.close_at or (a.started_at is null and now() >= a.meet_at)),   -- 클라이언트는 이때 '정산 확인 중'을 그린다
    'appointment', private.lb_appointment_json(a),
    'participants', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'userId', p.user_id, 'nickname', p.nickname, 'state', 'active', 'joinedAtMs', private.lb_ms(p.joined_at),
        'arrivedAtMs', private.lb_ms(p.arrived_at),
        'arrivalMethod', p.arrival_method, 'arrivalDistanceM', p.arrival_distance_m, 'arrivalAccuracyM', p.arrival_accuracy_m,
        'vouchedBy', p.vouched_by,
        -- R4: 시작 뒤에 이름을 고른 사람(시작 후에도 내보낼 수 있다). 시작 전·주최자는 false
        'joinedAfterStart', coalesce(a.started_at is not null and p.user_id <> a.host_id
          and (select private.lb_ms(i.claimed_at) from public.invitees i where i.appointment_id = p.appointment_id and i.claimed_by = p.user_id)
              > private.lb_ms(a.started_at), false),                      -- lb_kick 과 같은 ms 비교
        'resultStatus', p.result_status, 'forfeited', p.forfeited, 'received', p.received,
        'lastSeenMs', case when v_share_open and p.arrived_at is null and l.user_id is not null then private.lb_ms(l.updated_at) end,
        -- 좌표는 (시작됨 ∧ 공개 창 안) ∧ (미도착) ∧ (3분 안에 갱신됨) 일 때만
        'location', case when v_share_open and p.arrived_at is null and l.user_id is not null
                          and l.updated_at > now() - interval '3 minutes' then
           jsonb_build_object('lat', l.lat, 'lng', l.lng, 'accuracyM', l.accuracy_m, 'updatedAtMs', private.lb_ms(l.updated_at),
             'distanceM', round(private.lb_haversine_m(l.lat, l.lng, a.place_lat, a.place_lng)))
           end
      ) order by p.joined_at, p.user_id), '[]'::jsonb)
      from public.participants p
      left join public.locations l on l.appointment_id = p.appointment_id and l.user_id = p.user_id
      where p.appointment_id = p_appt));
end $$;

-- 15.5) 홈 목록(LbMyAppointment[]): 내가 멤버인 약속. 열린 약속(약속 시각 가까운 순) → 끝난 약속(최근 순).
--      약속 시각이 지난 열린 약속은 여기서 게으른 참여 마감·정산을 먼저 한다(lb_get_live 와 같은 조건 — 홈만 열어도 무효·정산이 확정된다).
create function public.lb_list_my_appointments() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid(); r record;
begin
  for r in select a.id, a.started_at, a.meet_at, a.close_at
             from public.appointments a join public.participants p on p.appointment_id = a.id and p.user_id = v_uid
            where a.status = 'open' and now() >= a.meet_at
            order by a.id loop
    perform private.lb_close_roster(r.id);
    if r.started_at is null or now() > r.close_at + interval '15 seconds'
       or not exists (select 1 from public.participants x where x.appointment_id = r.id and x.arrived_at is null) then
      perform private.lb_try_settle(r.id);
    end if;
  end loop;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'title', a.title, 'localAt', a.local_at, 'tz', a.tz, 'meetAtMs', private.lb_ms(a.meet_at),
             'startedAtMs', private.lb_ms(a.started_at), 'closeMs', private.lb_ms(a.close_at), 'placeName', a.place_name,
             'status', a.status, 'policy', private.lb_policy_json(a), 'hostId', a.host_id, 'isHost', a.host_id = v_uid,
             'myState', 'active',
             'memberCount', (select count(*) from public.participants x where x.appointment_id = a.id),
             'unclaimedCount', (select count(*) from public.invitees i where i.appointment_id = a.id and i.claimed_by is null))
           order by (a.status <> 'open'),
                    case when a.status = 'open' then a.meet_at end asc,
                    case when a.status <> 'open' then a.meet_at end desc,
                    a.created_at, a.id)                                  -- 같은 약속 시각끼리는 만든 순서
      from public.appointments a join public.participants p on p.appointment_id = a.id and p.user_id = v_uid), '[]'::jsonb);
end $$;

-- 15.6) 내 원장(LbLedgerEntry[], 최신순). RLS select 로도 읽을 수 있지만 내보내진 약속의 제목은 RLS 로 못 보므로 여기서 붙인다.
--      p_limit 는 1~500(기본 100).
create function public.lb_list_ledger(p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.lb_uid();
begin
  return (select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'kind', l.kind, 'amount', l.amount, 'balanceAfter', l.balance_after,
           'appointmentId', l.appointment_id, 'appointmentTitle', a.title,
           'reason', l.meta->>'reason', 'reliefFor', l.meta->>'for', 'createdAtMs', private.lb_ms(l.created_at))
         order by l.id desc), '[]'::jsonb)
    from (select * from public.ledger
           where user_id = v_uid
           order by id desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) l
    left join public.appointments a on a.id = l.appointment_id);
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
  select 'open appointment escrow != stake * members', a.id::text, coalesce(-sum(l.amount), 0)::text
    from public.appointments a left join public.ledger l on l.appointment_id = a.id
   where a.status = 'open' group by a.id, a.stake
  having coalesce(-sum(l.amount), 0) <> a.stake * (select count(*) from public.participants x where x.appointment_id = a.id)
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
   where x.balance_after <> x.prev + x.amount
  union all
  select 'claimed invitee without participant', i.appointment_id::text, i.name
    from public.invitees i
   where i.claimed_by is not null
     and not exists (select 1 from public.participants p where p.appointment_id = i.appointment_id and p.user_id = i.claimed_by)
  union all
  select 'guest participant without claimed slot', p.appointment_id::text, p.user_id::text
    from public.participants p join public.appointments a on a.id = p.appointment_id
   where p.user_id <> a.host_id
     and not exists (select 1 from public.invitees i where i.appointment_id = p.appointment_id and i.claimed_by = p.user_id)
  union all
  select 'settled/voided appointment with unclaimed invitee', a.id::text, i.name   -- 정산·무효 때 안 들어온 이름은 지워져야 한다
    from public.appointments a join public.invitees i on i.appointment_id = a.id
   where a.status in ('settled', 'voided') and i.claimed_by is null
  union all
  select 'arrival without start', p.appointment_id::text, p.user_id::text          -- 체크인은 시작 뒤에만 열린다
    from public.participants p join public.appointments a on a.id = p.appointment_id
   where p.arrived_at is not null and (a.started_at is null or p.arrived_at < a.started_at)
  union all
  select 'notStarted void with started_at', a.id::text, a.started_at::text
    from public.appointments a where a.void_reason = 'notStarted' and a.started_at is not null
  union all
  select 'start snapshot mismatch', a.id::text, coalesce(a.start_meet_at::text, 'null')             -- 시작했으면 시작 시점 약속 시각·핀이 박제돼 있어야 한다
    from public.appointments a
   where (a.started_at is null) <> (a.start_meet_at is null)
      or (a.started_at is null) <> (a.start_place_lat is null) or (a.started_at is null) <> (a.start_place_lng is null);
$$;

-- ───────────────────────── 6. 권한 (맨 끝에서 일괄) ─────────────────────────
revoke all on all tables    in schema public  from public, anon, authenticated;
revoke all on all tables    in schema private from public, anon, authenticated;
revoke all on all sequences in schema public  from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;
grant select on public.profiles, public.appointments, public.participants, public.invitees, public.ledger to authenticated;

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
grant execute on function private.lb_is_member(uuid) to authenticated;   -- RLS 정책이 부른다
grant execute on function public.lb_ping() to anon;                      -- keepalive 전용
