-- 로컬 PG16 에서 Supabase 흉내: 롤·auth 스키마·기본 권한(Supabase 는 public 에 ALL 을 기본 부여한다)
-- postgres 롤: Homebrew 클러스터의 슈퍼유저는 보통 macOS 계정명이라 없을 수 있다. 마이그레이션은 test-sql.sh 가 `set role postgres` 로 돌려
-- 마이그레이션 0절의 기본 권한 회수가 실제 생성 객체에 적용되게 한다(없으면 하드닝이 검증되지 않은 채 통과한다).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'postgres') then create role postgres superuser nologin; end if;
end $$;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), is_anonymous boolean default true, created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
alter default privileges for role postgres in schema public grant all on tables to authenticated, anon, service_role;
alter default privileges for role postgres in schema public grant execute on functions to authenticated, anon, service_role;
