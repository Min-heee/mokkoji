-- supabase/tests/scenario.sql — 로컬 PG16(stub.sql + 마이그레이션 적용 후)에서 실행. 출력에 FAIL 이 한 줄도 없어야 한다.
-- 오너 확정 흐름(2026-09-18, '주최자 [시작하기]' 모델): 초대 명단·slot claim(약속 시각까지, 시작 후에도)·시작 전 전부 변경·
-- 시작 후 미루기/장소만·위치 공개는 시작부터·시작 안 된 약속은 약속 시각에 자동 무효·공개 창 30분 꼬리.
--
-- 시간 여행: 운영 SQL 은 서버 now() 만 쓰므로 바꾸지 않는다. 대신 테스트가 슈퍼유저로(`reset role` 상태) 약속의 시각들을 옮긴다.
--   t.at(appt, rel)   = '지금이 약속 시각 + rel 인 세상'으로 그 약속을 통째로 옮긴다. meet_at·started_at·close_at·joined_at·claimed_at·
--                       arrived_at·first_near_at·consented_at·locations.updated_at 를 같은 만큼 평행 이동하고 local_at 을 다시 쓴다
--                       (상대 간격 = 지각 분·공개 창이 보존된다. 예: t.at(x, '-9 min') = 약속 9분 전, t.at(x, '7 min') = 약속 7분 지남)
--   t.travel(appt, meet, started) = meet_at = now()+meet, started_at = now()+started(null 이면 그대로)로 직접 놓는다(local_at·close_at 재계산).
--                       도착 시각 등은 움직이지 않는다 — 도착 시각을 따로 정할 때 쓴다.
-- close_at 만 따로 당겨 정산 여유(15초) 경계를 보는 곳은 update 를 직접 쓴다.
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
create schema if not exists t;
grant usage on schema t to authenticated, anon;
create or replace function t.at(p_appt uuid, p_rel interval) returns void language plpgsql as $$
declare d interval;
begin
  select meet_at - (now() - p_rel) into d from public.appointments where id = p_appt;   -- 모두를 d 만큼 과거로
  update public.appointments set meet_at = meet_at - d, started_at = started_at - d, close_at = close_at - d,
         start_meet_at = start_meet_at - d, material_changed_at = material_changed_at - d,
         local_at = to_char((meet_at - d) at time zone tz, 'YYYY-MM-DD"T"HH24:MI') where id = p_appt;
  update public.participants set joined_at = joined_at - d, consented_at = consented_at - d,
         arrived_at = arrived_at - d, first_near_at = first_near_at - d where appointment_id = p_appt;
  update public.invitees set claimed_at = claimed_at - d where appointment_id = p_appt;
  update public.locations set updated_at = updated_at - d where appointment_id = p_appt;
end $$;
create or replace function t.travel(p_appt uuid, p_meet interval, p_started interval default null) returns void language sql as $$
  update public.appointments set meet_at = now() + p_meet,
         started_at = case when p_started is null then started_at else now() + p_started end,
         local_at = to_char((now() + p_meet) at time zone tz, 'YYYY-MM-DD"T"HH24:MI'),
         close_at = private.lb_close_at(now() + p_meet, stake, unit_minutes, penalty_per_unit, grace_minutes)
   where id = p_appt; $$;
revoke all on function t.at(uuid, interval), t.travel(uuid, interval, interval) from public;
create or replace function t.me(p text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000' || p, false); $$;
create or replace function t.ok(label text, cond boolean) returns text language sql as $$
  select case when cond then 'ok   ' else 'FAIL ' end || label; $$;
create or replace function t.err(label text, q text, want text) returns text language plpgsql as $$
begin
  execute q;
  return 'FAIL ' || label || ' (no error)';
exception when others then
  return case when sqlerrm like want || '%' or sqlstate = want then 'ok   ' else 'FAIL ' end || label || ' -> ' || sqlerrm;
end $$;
-- 오류의 DETAIL 만 꺼낸다(LB_INSUFFICIENT_POINTS 의 detail = 닉네임 등)
create or replace function t.detail(q text) returns text language plpgsql as $$
declare d text;
begin
  execute q;
  return null;
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  return d;
end $$;
-- jsonb 키 집합(정렬, C 콜레이션) — 반환 모양 단언용
create or replace function t.keys(j jsonb) returns text[] language sql immutable as $$
  select array(select k from jsonb_object_keys(j) k order by k collate "C"); $$;
create or replace function t.set(a text[]) returns text[] language sql immutable as $$
  select array(select x from unnest(a) x order by x collate "C"); $$;
-- 권한 매트릭스: 현재 롤(anon/authenticated)로 public·private 의 모든 테이블에 select/insert/update/delete/truncate 를 시도한다.
-- select 는 authenticated 에게 5개 테이블만 허용(RLS 로 남의 행 0) — 이 함수는 프로필도 약속도 없는 사용자로 부른다.
-- 허용돼 버린 쓰기는 예외로 되감는다(서브트랜잭션) — 테스트가 데이터를 망치지 않게.
create or replace function t.table_matrix() returns setof text language plpgsql as $$
declare r record; q text; col text; n bigint; readable boolean;
begin
  for r in select ns.nspname as s, c.relname as t, c.oid
             from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname in ('public', 'private') and c.relkind in ('r', 'p') order by 1, 2 loop
    readable := current_user = 'authenticated' and r.s = 'public' and r.t in ('profiles', 'appointments', 'participants', 'invitees', 'ledger');
    select quote_ident(attname) into col from pg_attribute
     where attrelid = r.oid and attnum > 0 and not attisdropped and attidentity = '' and attgenerated = '' order by attnum limit 1;
    begin
      execute format('select count(*) from %I.%I', r.s, r.t) into n;
      return next case when readable and n = 0 then 'ok   ' else 'FAIL ' end || format('%s select %s.%s -> %s rows (RLS)', current_user, r.s, r.t, n);
    exception when insufficient_privilege then
      return next case when readable then 'FAIL ' else 'ok   ' end || format('%s select %s.%s denied', current_user, r.s, r.t);
    end;
    foreach q in array array[format('insert into %I.%I default values', r.s, r.t),
                             format('update %I.%I set %s = %s where false', r.s, r.t, col, col),
                             format('delete from %I.%I where false', r.s, r.t),
                             format('truncate %I.%I', r.s, r.t)] loop
      begin
        execute q;
        raise exception 'T_ALLOWED';
      exception
        when insufficient_privilege then return next format('ok   %s %s %s.%s denied', current_user, split_part(q, ' ', 1), r.s, r.t);
        when others then return next format('FAIL %s %s -> %s', current_user, q, sqlerrm);
      end;
    end loop;
  end loop;
end $$;
-- 함수 호출 매트릭스: 스키마의 함수를 전부 null 인자로 불러 본다(권한 검사가 실행보다 먼저라 42501 이어야 한다)
create or replace function t.call_all(p_schema text, p_except text[]) returns setof text language plpgsql as $$
declare r record; q text;
begin
  for r in select p.proname,
                  (select string_agg('null::' || format_type(a.t, null), ', ' order by a.o) from unnest(p.proargtypes) with ordinality a(t, o)) as args
             from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = p_schema and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
              and p.proname <> all (p_except) and (p_schema <> 'public' or p.proname like 'lb\_%')
            order by 1 loop
    q := format('select %I.%I(%s)', p_schema, r.proname, coalesce(r.args, ''));
    begin
      execute q;
      raise exception 'T_ALLOWED';
    exception
      when insufficient_privilege then return next format('ok   %s cannot call %s.%s', current_user, p_schema, r.proname);
      when others then return next format('FAIL %s %s -> %s', current_user, q, sqlerrm);
    end;
  end loop;
end $$;
grant execute on function t.me(text), t.ok(text, boolean), t.err(text, text, text), t.detail(text), t.keys(jsonb), t.set(text[]),
  t.table_matrix(), t.call_all(text, text[]) to authenticated, anon;
create or replace function t.soon(p interval) returns text language sql as $$
  select to_char((now() + p) at time zone 'Asia/Seoul', 'YYYY-MM-DD"T"HH24:MI'); $$;
grant execute on function t.soon(interval) to authenticated;
insert into auth.users (id) select ('00000000-0000-0000-0000-0000000000' || x)::uuid from unnest(array['0a','0b','0c','0d','0e','0f','11','12','13','14','15','16','1f','21','22','31','32','33','34']) x;

\set POL '{"stake":100,"radiusM":100,"unitMinutes":5,"penaltyPerUnit":10,"graceMinutes":0}'
set role authenticated;
-- 1. 프로필·가입 지급 1회
select t.me('0a'); select t.ok('grant 1000', (public.lb_ensure_profile('호스트')).balance = 1000);
select t.ok('no double grant', (public.lb_ensure_profile('호스트')).balance = 1000);
select t.me('0b'); select public.lb_ensure_profile('비') is not null;
select t.me('0c'); select public.lb_ensure_profile('씨') is not null;
select t.me('0d'); select public.lb_ensure_profile('디') is not null;
select t.me('0e'); select public.lb_ensure_profile('이') is not null;

-- 2. 생성: 동의·타임존 검사·절벽 정책·초대 명단(중복·주최자 이름은 건너뜀, 19명 상한). 만들면 시작 전(startedAtMs null)
select t.me('0a');
select t.err('consent required', format($q$select public.lb_create_appointment('곱창', %L, 'Asia/Seoul', '강남역', '', 37.4979, 127.0276, %L, '{}'::text[], false)$q$, t.soon('3 hours'), :'POL'), 'LB_CONSENT_REQUIRED');
select t.err('tz suspect (방콕 핀 + 서울 tz)', format($q$select public.lb_create_appointment('여행', %L, 'Asia/Seoul', '방콕', '', 13.75, 100.5, %L, '{}'::text[], true)$q$, t.soon('3 hours'), :'POL'), 'LB_TZ_SUSPECT');
select t.ok('tz confirmed passes then cancel', (public.lb_create_appointment('여행', t.soon('3 hours'), 'Asia/Seoul', '방콕', '', 13.75, 100.5, :'POL', '{}'::text[], true, true)->'policy'->>'stake')::int = 100);
select public.lb_cancel((select id from public.appointments where title = '여행'));
select t.err('cliff policy', format($q$select public.lb_create_appointment('x', %L, 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"unitMinutes":5,"penaltyPerUnit":1}', '{}'::text[], true)$q$, t.soon('3 hours')), '23514');
select t.err('bad invitee name (13 chars)', format($q$select public.lb_create_appointment('x', %L, 'Asia/Seoul', 'p', '', 37.5, 127.0, %L, array['열세글자가넘는이름입니다요'], true)$q$, t.soon('3 hours'), :'POL'), 'LB_BAD_NICKNAME');
select t.err('roster over 19', format($q$select public.lb_create_appointment('x', %L, 'Asia/Seoul', 'p', '', 37.5, 127.0, %L, (select array_agg('n' || g::text) from generate_series(1, 20) g), true)$q$, t.soon('3 hours'), :'POL'), 'LB_FULL');
select (public.lb_create_appointment('곱창', t.soon('3 hours'), 'Asia/Seoul', '강남역', '', 37.4979, 127.0276, :'POL', array['비', '씨', ' 비', '호스트', '디'], true)->>'id') as appt \gset
select invite_code as code from public.appointments where id = :'appt' \gset
select t.ok('host hold 100', (select balance from public.profiles) = 900);
select t.ok('roster: dup + host name skipped', (select array_agg(name order by seq) from public.invitees where appointment_id = :'appt') = array['비', '씨', '디']);
select t.ok('not started at creation', (select j->'appointment'->>'startedAtMs' is null and j->>'settlePending' = 'false' from (select public.lb_get_live(:'appt') j) x));
select t.ok('policy json has 5 keys, no share setting', (select ((j->'appointment'->'policy') ? 'shareLocationMinutesBefore') = false
  and (select count(*) from jsonb_object_keys(j->'appointment'->'policy')) = 5 from (select public.lb_get_live(:'appt') j) x));
select t.ok('close_at = full forfeit(45m) + 30m tail', (select close_at - meet_at = interval '75 minutes' from public.appointments where id = :'appt'));

-- 3. 시작 전 조건 변경: 혼자일 때도, 친구가 들어온 뒤에도. version+1 + 변경 이력. 걸 포인트 차액은 전원 자동 에스크로/환불
select t.me('0b'); select (public.lb_peek_invite(:'code')->>'version')::int as v1 \gset
select t.ok('peek shows roster to non-member', (select jsonb_array_length(j->'invitees') = 3 and (j->>'memberCount')::int = 1
  and j->'invitees'->0->>'claimed' = 'false' and j->>'myState' is null and j->>'startedAtMs' is null from (select public.lb_peek_invite(:'code') j) x));
select t.me('0a');
select t.ok('edit alone: version+1', (public.lb_edit_appointment(:'appt', '{"policy":{"stake":200,"penaltyPerUnit":20,"shareLocationMinutesBefore":30}}', :v1)->>'version')::int = :v1 + 1);
select t.ok('host escrows diff 100', (select balance from public.profiles) = 800);
select t.ok('unknown policy key ignored', (select count(*) from jsonb_object_keys(public.lb_get_live(:'appt')->'appointment'->'policy')) = 5);
select t.ok('close_at = full forfeit(45m) + 30m tail (new policy)', (select close_at - meet_at = interval '75 minutes' from public.appointments where id = :'appt'));
select t.ok('change history recorded', (select jsonb_array_length(changes) = 1 and changes->0->'before'->'policy'->>'stake' = '100'
  and changes->0->'after'->'policy'->>'stake' = '200' and (changes->0->>'version')::int = :v1 + 1 from public.appointments where id = :'appt'));
select t.err('stale version edit', format('select public.lb_edit_appointment(%L, %L, %s)', :'appt', '{"placeName":"홍대"}', :v1), 'LB_APPT_CHANGED');
select t.ok('no-op edit keeps version', (public.lb_edit_appointment(:'appt', '{}', :v1 + 1)->>'version')::int = :v1 + 1);
select t.me('0b');
select t.err('stale version claim', format('select public.lb_claim_slot(%L, %L, %s, true)', :'appt', '비', :v1), 'LB_APPT_CHANGED');
select t.err('claim needs consent', format('select public.lb_claim_slot(%L, %L, %s, false)', :'appt', '비', :v1 + 1), 'LB_CONSENT_REQUIRED');
select t.err('name not on roster', format('select public.lb_claim_slot(%L, %L, %s, true)', :'appt', '영희', :v1 + 1), 'LB_NOT_INVITED');
select t.ok('B claims 비 (before start)', (select j->>'state' = 'active' and j->>'started' = 'false' from (select public.lb_claim_slot(:'appt', '비', :v1 + 1, true) j) x));
select t.ok('claim idempotent', public.lb_claim_slot(:'appt', '비', :v1 + 1, true)->>'state' = 'active');
select t.ok('B hold 200', (select balance from public.profiles) = 800);
select t.me('0c');
select t.err('slot taken', format('select public.lb_claim_slot(%L, %L, %s, true)', :'appt', '비', :v1 + 1), 'LB_SLOT_TAKEN');
select t.err('zero-width name = same slot', format('select public.lb_claim_slot(%L, %L, %s, true)', :'appt', U&'\200B비 ', :v1 + 1), 'LB_SLOT_TAKEN');
select t.ok('C claims 씨', public.lb_claim_slot(:'appt', '씨', :v1 + 1, true)->>'state' = 'active');
select t.ok('peek marks claimed/mine', (select bool_or((e->>'mine')::boolean and e->>'name' = '씨') and count(*) filter (where (e->>'claimed')::boolean) = 2
  from jsonb_array_elements(public.lb_peek_invite(:'code')->'invitees') e));
select t.me('0a');
select t.ok('raise stake with friends: version+1', (public.lb_edit_appointment(:'appt', '{"policy":{"stake":300}}', :v1 + 1)->>'version')::int = :v1 + 2);
select t.ok('A escrows +100 (700)', (select balance from public.profiles) = 700);
select t.me('0b'); select t.ok('B escrows +100 (700)', (select balance from public.profiles) = 700);
select t.me('0c'); select t.ok('C escrows +100 (700)', (select balance from public.profiles) = 700);
select t.me('0a');
select t.ok('lower stake: version+1', (public.lb_edit_appointment(:'appt', '{"policy":{"stake":100}}', :v1 + 2)->>'version')::int = :v1 + 3);
select t.ok('A refunded 200 (900)', (select balance from public.profiles) = 900);
select t.me('0b'); select t.ok('B refunded 200 (900)', (select balance from public.profiles) = 900);
select t.me('0c'); select t.ok('C refunded 200 (900)', (select balance from public.profiles) = 900);
select t.ok('diff ledger rows carry reason policy_change', (select count(*) from public.ledger where appointment_id = :'appt' and meta->>'reason' = 'policy_change') = 2);
select t.me('0a');
select t.ok('time change with friends: version+1', (public.lb_edit_appointment(:'appt', jsonb_build_object('localAt', t.soon('4 hours')), :v1 + 3)->>'version')::int = :v1 + 4);
select :v1 + 4 as v2 \gset
select t.ok('change history keeps 4 entries', (select jsonb_array_length(changes) = 4 from public.appointments where id = :'appt'));
select public.lb_update_memo(:'appt', '금요일 곱창', '2층');
select t.ok('memo edit keeps version', (select version from public.appointments where id = :'appt') = :v2);

-- 4. 나가기(자리 비움)·재참여, 내보내기(+명단 제거·차단), 명단 편집 — 전부 시작 전
select t.me('0c');
select public.lb_leave(:'appt'); select t.ok('leave refund', (select balance from public.profiles) = 1000);
select t.ok('slot released on leave', (select j->'invitees'->1->>'claimed' = 'false' from (select public.lb_peek_invite(:'code') j) x));
select t.ok('C rejoins same slot', public.lb_claim_slot(:'appt', '씨', :v2, true)->>'state' = 'active');
select t.me('0a'); select public.lb_kick(:'appt', '00000000-0000-0000-0000-00000000000c', true);
select t.ok('kick removes name from roster', (select array_agg(name order by seq) from public.invitees where appointment_id = :'appt') = array['비', '디']);
select t.me('0c'); select t.ok('kick refund', (select balance from public.profiles) = 1000);
select t.err('banned cannot claim', format('select public.lb_claim_slot(%L, %L, %s, true)', :'appt', '디', :v2), 'LB_INVITE_NOT_FOUND');
select t.err('banned cannot peek', format('select public.lb_peek_invite(%L)', :'code'), 'LB_INVITE_NOT_FOUND');
select t.me('0a');
select t.err('cannot remove joined name', format($q$select public.lb_edit_invitees(%L, null, array['비'])$q$, :'appt'), 'LB_INVITEE_JOINED');
select t.ok('add name', jsonb_array_length(public.lb_edit_invitees(:'appt', array['철수'], null)->'invitees') = 3);
select t.ok('remove unclaimed name (key match)', jsonb_array_length(public.lb_edit_invitees(:'appt', null, array[' 철수 '])->'invitees') = 2);
select t.ok('roster edit keeps version', (select version from public.appointments where id = :'appt') = :v2);
select t.me('0b');
select t.err('guest cannot edit roster', format($q$select public.lb_edit_invitees(%L, array['x'], null)$q$, :'appt'), 'LB_NOT_HOST');
select t.err('guest cannot edit conditions', format('select public.lb_edit_appointment(%L, %L, %s)', :'appt', '{"placeName":"x"}', :v2), 'LB_NOT_HOST');
select t.err('guest cannot start', format('select public.lb_start(%L)', :'appt'), 'LB_NOT_HOST');

-- 5. 권한: 외부인·직접 쓰기·anon
select t.me('0e');
select t.ok('outsider sees no appointments', (select count(*) from public.appointments) = 0);
select t.ok('outsider sees no participants', (select count(*) from public.participants) = 0);
select t.ok('outsider sees no invitees', (select count(*) from public.invitees) = 0);
select t.err('outsider get_live', format('select public.lb_get_live(%L)', :'appt'), 'LB_NOT_MEMBER');
select t.err('outsider start', format('select public.lb_start(%L)', :'appt'), 'LB_NOT_HOST');
select t.err('outsider claim without roster name', format('select public.lb_claim_slot(%L, %L, %s, true)', :'appt', '이', :v2), 'LB_NOT_INVITED');
select t.err('locations select denied', 'select count(*) from public.locations', '42501');
select t.err('direct update denied', 'update public.profiles set balance = 999999', '42501');
select t.err('direct insert denied', $q$insert into public.ledger(user_id,kind,amount,balance_after) values ('00000000-0000-0000-0000-00000000000e','grant',5,5)$q$, '42501');
select t.err('direct delete denied', 'delete from public.participants', '42501');
select t.err('direct invitee insert denied', format($q$insert into public.invitees(appointment_id, name) values (%L, '이')$q$, :'appt'), '42501');
select t.err('truncate denied', 'truncate public.ledger', '42501');
select t.err('private fn denied', $q$select private.lb_post('00000000-0000-0000-0000-00000000000e', null, 'grant', 5)$q$, '42501');
select t.err('private table denied', 'select * from private.lb_share_log', '42501');
reset role; set role anon;
select t.ok('anon ping ok', public.lb_ping() ? 'serverNowMs');
select t.err('anon rpc denied', $q$select public.lb_ensure_profile('x')$q$, '42501');
select t.err('anon table denied', 'select count(*) from public.appointments', '42501');
reset role;
select t.err('ledger immutable even for owner', 'delete from public.ledger', 'LB_LEDGER_IMMUTABLE');

-- 6. 시간 여행: 약속 10분 전. 시작 전에는 체크인도 위치도 없다. 주최자가 [시작하기] → 그 순간부터 위치가 보이고 체크인이 열린다.
--    아직 안 들어온 디는 시작 후에도 약속 시각까지 들어올 수 있다(들어오면 그때부터 위치 공개·판정 대상).
select t.travel(:'appt', '10 min');
set role authenticated;
select t.me('0b');
select t.ok('before start: check-in not_open', public.lb_report_location(:'appt', 37.5100, 127.0400, 15, false, true)->>'reason' = 'not_open');
reset role; select t.ok('before start: nothing stored', (select count(*) from public.locations) = 0);
set role authenticated; select t.me('0a');
select t.err('before start: vouch = not started', format($q$select public.lb_vouch(%L, '00000000-0000-0000-0000-00000000000b')$q$, :'appt'), 'LB_NOT_STARTED');
select t.ok('before start: host sees no location nor lastSeen', (select count(*) filter (where e->'location' <> 'null'::jsonb) = 0
  and count(*) filter (where e->'lastSeenMs' <> 'null'::jsonb) = 0 from jsonb_array_elements(public.lb_get_live(:'appt')->'participants') e));
-- R3: 친구(B·C)가 있을 때 시각을 바꿨으므로(3절) 5분 쿨다운 중 — 시작 거부, startableAtMs 로 시작 가능 시각이 내려온다
select t.err('R3 start refused right after a material change with friends', format('select public.lb_start(%L)', :'appt'), 'LB_START_COOLDOWN');
select t.ok('R3 startableAtMs = material_changed_at + 5m (future)', (select (j->'appointment'->>'startableAtMs')::bigint > (j->>'serverNowMs')::bigint
  and (j->'appointment'->>'startableAtMs')::bigint - (select floor(extract(epoch from material_changed_at) * 1000)::bigint from public.appointments where id = :'appt') = 300000
  from (select public.lb_get_live(:'appt') j) x));
reset role; update public.appointments set material_changed_at = material_changed_at - interval '5 minutes' where id = :'appt';
set role authenticated; select t.me('0a');
select t.ok('R3 startableAtMs null once cooldown passed', public.lb_get_live(:'appt')->'appointment'->'startableAtMs' = 'null'::jsonb);
select public.lb_start(:'appt')->>'startedAtMs' as started1 \gset
select t.ok('host starts (roster incomplete is fine)', :'started1'::bigint <= floor(extract(epoch from clock_timestamp()) * 1000)::bigint
  and :'started1'::bigint < (public.lb_get_live(:'appt')->'appointment'->>'meetAtMs')::bigint);
select t.err('start twice', format('select public.lb_start(%L)', :'appt'), 'LB_ALREADY_STARTED');
select t.ok('startedAtMs unchanged after second try', (select floor(extract(epoch from started_at) * 1000)::bigint::text = :'started1' from public.appointments where id = :'appt'));
select t.me('0b');
select public.lb_report_location(:'appt', 37.5100, 127.0400, 15, false, true)->>'reason' as r \gset
select t.ok('after start: check-in open, outside stored', :'r' = 'outside');
select t.me('0a');
select t.ok('after start: host sees B location', (select count(*) from jsonb_array_elements(public.lb_get_live(:'appt')->'participants') e where e->'location' <> 'null'::jsonb) = 1);
select t.ok('peek shows startedAtMs', (select j->>'startedAtMs' = :'started1' from (select public.lb_peek_invite(:'code') j) x));
select t.me('0d');
select t.ok('D claims after start -> started=true', (public.lb_claim_slot(:'appt', '디', :v2, true)->>'started')::boolean);
select t.ok('D hold 100', (select balance from public.profiles) = 900);
select t.ok('D check-in open at once', public.lb_report_location(:'appt', 37.5200, 127.0500, 15)->>'reason' = 'outside');
select t.me('0a');
select t.ok('host sees B and D locations', (select count(*) from jsonb_array_elements(public.lb_get_live(:'appt')->'participants') e where e->'location' <> 'null'::jsonb) = 2);
select t.err('R4 no kick after start for a pre-start member', format($q$select public.lb_kick(%L, '00000000-0000-0000-0000-00000000000b')$q$, :'appt'), 'LB_KICK_CLOSED');
select t.err('no cancel after start with others', format('select public.lb_cancel(%L)', :'appt'), 'LB_CANCEL_CLOSED');
select t.err('roster frozen after start', format($q$select public.lb_edit_invitees(%L, array['영희'], null)$q$, :'appt'), 'LB_EDIT_FROZEN');
select t.err('policy frozen after start', format('select public.lb_edit_appointment(%L, %L, %s)', :'appt', '{"policy":{"stake":200}}', :v2), 'LB_EDIT_FROZEN');
select t.err('radius frozen after start', format('select public.lb_edit_appointment(%L, %L, %s)', :'appt', '{"policy":{"radiusM":200}}', :v2), 'LB_EDIT_FROZEN');
select t.err('unit frozen after start', format('select public.lb_edit_appointment(%L, %L, %s)', :'appt', '{"policy":{"unitMinutes":10}}', :v2), 'LB_EDIT_FROZEN');
select t.err('penalty frozen after start', format('select public.lb_edit_appointment(%L, %L, %s)', :'appt', '{"policy":{"penaltyPerUnit":5}}', :v2), 'LB_EDIT_FROZEN');
select t.err('grace frozen after start', format('select public.lb_edit_appointment(%L, %L, %s)', :'appt', '{"policy":{"graceMinutes":3}}', :v2), 'LB_EDIT_FROZEN');
select t.err('frozen check runs even with a place change', format('select public.lb_edit_appointment(%L, %L, %s)', :'appt', '{"placeName":"x","policy":{"stake":100,"penaltyPerUnit":5}}', :v2), 'LB_EDIT_FROZEN');
select t.err('stale version after start', format('select public.lb_edit_appointment(%L, %L, %s)', :'appt', '{"placeName":"x"}', :v2 - 1), 'LB_APPT_CHANGED');
select t.ok('same policy values after start = allowed no-op', (public.lb_edit_appointment(:'appt', '{"policy":{"stake":100,"radiusM":100,"unitMinutes":5,"penaltyPerUnit":20,"graceMinutes":0}}', :v2)->>'version')::int = :v2);
select t.err('postpone only', format('select public.lb_edit_appointment(%L, %L, %s)', :'appt', jsonb_build_object('localAt', t.soon('7 minutes'))::text, :v2), 'LB_POSTPONE_ONLY');
select t.err('postpone too far', format('select public.lb_edit_appointment(%L, %L, %s)', :'appt', jsonb_build_object('localAt', t.soon('4 hours'))::text, :v2), 'LB_POSTPONE_TOO_FAR');
select t.ok('postpone +2h and move pin: ok', (select (j->>'version')::int = :v2 + 1 and j->>'placeName' = '강남역 2번 출구'
  from (select public.lb_edit_appointment(:'appt', jsonb_build_object('localAt', t.soon('2 hours'), 'placeName', '강남역 2번 출구', 'lat', 37.4981, 'lng', 127.0278), :v2) j) x));
select :v2 + 1 as v3 \gset
select t.ok('postpone recomputes close_at from new time (stake100/ppu20/unit5: 4 units + 30m tail = 50m)', (select close_at - meet_at = interval '50 minutes'
  and meet_at > now() + interval '110 minutes' and local_at = to_char(meet_at at time zone tz, 'YYYY-MM-DD"T"HH24:MI') from public.appointments where id = :'appt'));
select t.ok('postpone recorded in change history (before/after meetAtMs)', (select (changes->-1->'after'->>'meetAtMs')::bigint > (changes->-1->'before'->>'meetAtMs')::bigint
  and changes->-1->'after'->>'placeName' = '강남역 2번 출구' from public.appointments where id = :'appt'));
select t.ok('still started after postpone', (select started_at is not null and started_at < meet_at from public.appointments where id = :'appt'));
select t.me('0d'); select t.err('no leave after start', format('select public.lb_leave(%L)', :'appt'), 'LB_LEAVE_CLOSED');
reset role;
select t.ok('share log has (viewer a -> subject b)', exists (select 1 from private.lb_share_log where viewer_id::text like '%0a' and subject_id::text like '%0b'));
select t.err('started_at must precede meet_at (CHECK)', format($q$update public.appointments set meet_at = started_at where id = %L$q$, :'appt'), '23514');
-- 미룬 시각을 다시 약속 10분 전으로 되감는다(시작 시각도 함께)
select t.travel(:'appt', '10 min', '-20 min');

-- 7. 오래된 좌표: 3분 넘으면 좌표 null(lastSeen 만), 10분 넘으면 삭제. p_share=false 는 저장 안 함
update public.locations set updated_at = now() - interval '4 minutes';
set role authenticated; select t.me('0a');
select t.ok('stale >3m: no coords but lastSeen', (select bool_and(e->'location' = 'null'::jsonb) and bool_or(e->'lastSeenMs' <> 'null'::jsonb) from jsonb_array_elements(public.lb_get_live(:'appt')->'participants') e));
reset role; update public.locations set updated_at = now() - interval '11 minutes';
set role authenticated; select public.lb_get_live(:'appt') is not null;
reset role; select t.ok('stale >10m purged', (select count(*) from public.locations) = 0);
set role authenticated; select t.me('0b');
select public.lb_report_location(:'appt', 37.5100, 127.0400, 15, false, false) is not null;
reset role; select t.ok('p_share=false stores nothing', (select count(*) from public.locations) = 0);
set role authenticated; select t.me('0b');
select public.lb_report_location(:'appt', 37.5100, 127.0400, 15) is not null; select public.lb_stop_sharing(:'appt');
reset role; select t.ok('stop_sharing deletes row', (select count(*) from public.locations) = 0);

-- 8. 도착: A gps / B 정확도 미달(근처) → first_near / D mocked
set role authenticated; select t.me('0a');
select t.ok('A outside first (stored)', public.lb_report_location(:'appt', 37.5100, 127.0400, 20)->>'reason' = 'outside');
reset role; select t.ok('A location row exists', (select count(*) from public.locations where user_id::text like '%0a') = 1);
set role authenticated; select t.me('0a');
select t.err('vouch self denied', format($q$select public.lb_vouch(%L, '00000000-0000-0000-0000-00000000000a')$q$, :'appt'), 'LB_CANNOT_VOUCH_SELF');
select t.ok('A arrives', (public.lb_report_location(:'appt', 37.4980, 127.0277, 20)->>'arrived')::boolean);
reset role; select t.ok('arrival deletes A location at once', (select count(*) from public.locations where user_id::text like '%0a') = 0);
select t.ok('arrival stores distance/accuracy only', (select arrival_method = 'gps' and arrival_distance_m between 0 and 100 and arrival_accuracy_m = 20
  from public.participants where appointment_id = :'appt' and user_id::text like '%0a'));
set role authenticated; select t.me('0a');
select t.ok('A second check-in = already', public.lb_report_location(:'appt', 37.4980, 127.0277, 20)->>'reason' = 'already_arrived');
select t.me('0b');
select t.ok('B low accuracy', public.lb_report_location(:'appt', 37.4979, 127.0276, 180)->>'reason' = 'low_accuracy');
reset role; select first_near_at as near from public.participants where user_id::text like '%0b' \gset
select t.ok('B first_near_at recorded', :'near' <> '');
set role authenticated; select t.me('0d');
select t.ok('D outside (stored)', public.lb_report_location(:'appt', 37.5200, 127.0500, 15)->>'reason' = 'outside');
select t.ok('D mocked', public.lb_report_location(:'appt', 37.4979, 127.0276, 10, true)->>'reason' = 'mocked');
reset role; select t.ok('mocked: not arrived and old row deleted', (select count(*) from public.locations where user_id::text like '%0d') = 0
  and (select arrived_at is null from public.participants where appointment_id = :'appt' and user_id::text like '%0d'));
set role authenticated; select t.me('0d');
select t.ok('accuracy > 1000m: judged but not stored', public.lb_report_location(:'appt', 37.5200, 127.0500, 1500)->>'reason' = 'low_accuracy');
reset role; select t.ok('coarse location not stored', (select count(*) from public.locations where user_id::text like '%0d') = 0);
set role authenticated; select t.me('0d');
select t.ok('bad position', public.lb_report_location(:'appt', 95, 127.0, 10)->>'reason' = 'bad_position');
select t.err('non-arrived cannot vouch', format($q$select public.lb_vouch(%L, '00000000-0000-0000-0000-00000000000b')$q$, :'appt'), 'LB_VOUCHER_NOT_ARRIVED');
reset role; select t.ok('still open (all not arrived)', (select status from public.appointments where id = :'appt') = 'open');

-- 9. 약속 12분 후. A 는 15분 전 도착으로, B 의 first_near 는 2분 전(=제시간)으로 되감는다(시작 시각은 그보다 앞으로)
select t.travel(:'appt', '-12 min', '-42 min');
update public.participants set arrived_at = now() - interval '15 min' where arrived_at is not null;
update public.participants set first_near_at = now() - interval '14 min' where first_near_at is not null;
set role authenticated; select t.me('0a');
select public.lb_vouch(:'appt', '00000000-0000-0000-0000-00000000000b');
reset role;
select t.ok('vouch uses first_near_at (on time)', (select arrived_at < a.meet_at from public.participants p join public.appointments a on a.id = p.appointment_id where p.user_id::text like '%0b'));
select t.ok('not settled while D missing', (select status from public.appointments where id = :'appt') = 'open');
-- close_at 직후 15초 안에는 정산하지 않는다
update public.appointments set close_at = now() - interval '5 seconds' where id = :'appt';
set role authenticated; select t.me('0d');
select t.ok('settlePending flag within 15s margin', (public.lb_get_live(:'appt')->>'settlePending')::boolean);
select t.ok('late check-in after close = closed', public.lb_report_location(:'appt', 37.4979, 127.0276, 10)->>'reason' = 'closed');
reset role; select t.ok('still open inside margin', (select status from public.appointments where id = :'appt') = 'open');
update public.appointments set close_at = now() - interval '20 seconds' where id = :'appt';
set role authenticated; select t.me('0d'); select public.lb_get_live(:'appt')->'appointment'->>'status' as st \gset
select t.ok('lazy settle by get_live', :'st' = 'settled');
select t.me('0a'); select t.err('no edit after settle', format('select public.lb_edit_appointment(%L, %L, %s)', :'appt', '{"placeName":"x"}', :v3), 'LB_EDIT_CLOSED');
select t.err('no start after settle (was started)', format('select public.lb_start(%L)', :'appt'), 'LB_ALREADY_STARTED');
reset role;
select private.lb_settle(:'appt');  -- 재실행: no-op
select private.lb_try_settle(:'appt');
select t.ok('payouts: A 150, B 150, D 0 (stake 100, D no-show)', (select array_agg(amount order by user_id) from public.ledger where kind = 'payout' and appointment_id = :'appt') = array[150,150,0]);
select t.ok('balances A1050 B1050 D900', (select array_agg(balance order by user_id) from public.profiles where user_id::text ~ '0[abd]$') = array[1050,1050,900]);
select t.ok('locations wiped', (select count(*) from public.locations) = 0);
select t.ok('audit clean #1', (select count(*) from private.lb_audit()) = 0);

-- 10. 시작이 안 된 약속은 약속 시각에 자동 무효(notStarted, 전원 환불, 안 들어온 이름 삭제). 약속 시각이 지나면 시작·참여·수정 불가
set role authenticated; select t.me('0e');
select (public.lb_create_appointment('노쇼호스트', t.soon('40 minutes'), 'Asia/Seoul', '강남역', '', 37.4979, 127.0276, :'POL', array['비', '고스트'], true)->>'id') as ap1 \gset
select t.me('0b'); select t.ok('B joins (not started)', (public.lb_claim_slot(:'ap1', '비', 1, true)->>'started')::boolean = false);
select t.ok('B hold 100 (950)', (select balance from public.profiles) = 950);
reset role;
select t.travel(:'ap1', '-1 second');
set role authenticated; select t.me('0e');
select t.err('start after meet time', format('select public.lb_start(%L)', :'ap1'), 'LB_START_CLOSED');
select t.err('edit after meet time without start', format('select public.lb_edit_appointment(%L, %L, 1)', :'ap1', '{"placeName":"x"}'), 'LB_EDIT_CLOSED');
select t.err('roster edit after meet time without start', format($q$select public.lb_edit_invitees(%L, array['x'], null)$q$, :'ap1'), 'LB_EDIT_CLOSED');
select t.me('0c'); select t.err('claim after meet time', format('select public.lb_claim_slot(%L, %L, 1, true)', :'ap1', '고스트'), 'LB_JOIN_CLOSED');
select t.me('0b');
select t.ok('check-in on unstarted past-due = closed', public.lb_report_location(:'ap1', 37.4979, 127.0276, 10)->>'reason' = 'closed');
select t.ok('voided notStarted', (select j->'appointment'->>'status' = 'voided' and j->'appointment'->>'voidReason' = 'notStarted'
  and j->>'settlePending' = 'false' and j->'appointment'->>'startedAtMs' is null from (select public.lb_get_live(:'ap1') j) x));
select t.ok('B refunded (1050)', (select balance from public.profiles) = 1050);
select t.me('0e'); select t.ok('E refunded (1000)', (select balance from public.profiles) = 1000);
reset role;
select t.ok('notStarted refunds carry reason', (select count(*) from public.ledger where appointment_id = :'ap1' and kind = 'refund' and meta->>'reason' = 'notStarted') = 2);
select t.ok('notStarted: everyone noShow with 0/0', (select bool_and(result_status = 'noShow' and forfeited = 0 and received = 0) and count(*) = 2 from public.participants where appointment_id = :'ap1'));
select t.ok('notStarted: unclaimed name removed, claimed kept', (select array_agg(name order by seq) from public.invitees where appointment_id = :'ap1') = array['비']);
select t.ok('void escrow sum 0', (select sum(amount) from public.ledger where appointment_id = :'ap1') = 0);

-- 11. 혼자 시작 + 전원 도착이어도 약속 시각 전에는 정산하지 않는다 / 안 들어온 이름은 약속 시각에 자동 삭제 / stake 0→300→0
set role authenticated; select t.me('0e');
select (public.lb_create_appointment('번개', t.soon('40 minutes'), 'Asia/Seoul', '강남역', '', 37.4979, 127.0276, '{"stake":0}', array['고스트'], true)->>'id') as ap2 \gset
select t.ok('stake 0 -> 300 before start', (public.lb_edit_appointment(:'ap2', '{"policy":{"stake":300,"penaltyPerUnit":300,"unitMinutes":1}}', 1)->'policy'->>'stake')::int = 300);
select t.ok('E hold 300', (select balance from public.profiles) = 700);
select t.ok('check-in before start: not_open', public.lb_report_location(:'ap2', 37.4979, 127.0276, 10)->>'reason' = 'not_open');
select t.ok('host starts alone', public.lb_start(:'ap2')->>'startedAtMs' is not null);
select t.ok('E arrives early (check-in open after start)', (public.lb_report_location(:'ap2', 37.4979, 127.0276, 10)->>'arrived')::boolean);
reset role; select t.ok('no early settle before meet_at', (select status from public.appointments where id = :'ap2') = 'open');
update public.appointments set meet_at = now() - interval '1 second', started_at = now() - interval '5 minutes', close_at = now() - interval '1 second' where id = :'ap2';
update public.participants set arrived_at = now() - interval '4 minutes' where appointment_id = :'ap2';
set role authenticated; select t.me('0e'); select public.lb_get_live(:'ap2') is not null;
select t.ok('alone on time: settled, stake back', (select balance from public.profiles) = 1000);
reset role;
select t.ok('settled: unclaimed name auto-removed at meet time', (select count(*) from public.invitees where appointment_id = :'ap2') = 0);
select t.ok('settled keeps started_at', (select started_at is not null and status = 'settled' from public.appointments where id = :'ap2'));
set role authenticated; select t.me('0e');
select (public.lb_create_appointment('혼자', t.soon('3 hours'), 'Asia/Seoul', '강남역', '', 37.4979, 127.0276, '{"stake":300,"penaltyPerUnit":10}', '{}'::text[], true)->>'id') as ap3 \gset
select t.ok('300 -> 0', (public.lb_edit_appointment(:'ap3', '{"policy":{"stake":0}}', 1)->'policy'->>'stake')::int = 0);
select t.ok('300 -> 0 refunds', (select balance from public.profiles) = 1000);
select t.ok('start with empty roster', public.lb_start(:'ap3')->>'startedAtMs' is not null);
select public.lb_cancel(:'ap3');
select t.ok('host alone may cancel even after start', (select status from public.appointments where id = :'ap3') = 'canceled');

-- 12. 시작 전에는 나가기·취소 가능, 시작 후에는 불가. 시작 후 들어온 사람도 나갈 수 없다. 장소는 시작 후에도 고칠 수 있다
select (public.lb_create_appointment('당일', t.soon('3 hours'), 'Asia/Seoul', '강남역', '', 37.4979, 127.0276, :'POL', array['비', '씨'], true)->>'id') as ap4 \gset
select t.me('0b'); select t.ok('B claims: not started', (public.lb_claim_slot(:'ap4', '비', 1, true)->>'started')::boolean = false);
select public.lb_leave(:'ap4');
select t.ok('B may leave before start (refund)', (select balance from public.profiles) = 1050);
select t.ok('B rejoins', public.lb_claim_slot(:'ap4', '비', 1, true)->>'state' = 'active');
select t.me('0e');
select t.ok('unclaimed name visible before start', (select count(*) from jsonb_array_elements(public.lb_get_live(:'ap4')->'appointment'->'invitees') e where e->>'claimedByUserId' is null) = 1);
select t.ok('host starts with one name still open', public.lb_start(:'ap4')->>'startedAtMs' is not null);
select t.me('0c'); select t.ok('C claims after start -> started', (public.lb_claim_slot(:'ap4', '씨', 1, true)->>'started')::boolean);
select t.err('C cannot leave after start', format('select public.lb_leave(%L)', :'ap4'), 'LB_LEAVE_CLOSED');
select t.me('0b'); select t.err('B cannot leave after start', format('select public.lb_leave(%L)', :'ap4'), 'LB_LEAVE_CLOSED');
select t.me('0e');
select t.err('host cannot cancel after start', format('select public.lb_cancel(%L)', :'ap4'), 'LB_CANCEL_CLOSED');
select t.err('host cannot add names after start', format($q$select public.lb_edit_invitees(%L, array['디'], null)$q$, :'ap4'), 'LB_EDIT_FROZEN');
select t.ok('host can still rename place', public.lb_edit_appointment(:'ap4', '{"placeName":"강남역 11번 출구"}', 1)->>'placeName' = '강남역 11번 출구');
select t.ok('everyone sees everyone (3 rows)', jsonb_array_length(public.lb_get_live(:'ap4')->'participants') = 3);

-- 13. 부족분 채워주기: F 는 1000 → 300짜리 약속 4개를 만들면 4번째에서 잔액 100 < 300, 가진 것(100+900)=1000 이라 거부
select t.me('0f'); select public.lb_ensure_profile('에프') is not null;
select public.lb_create_appointment('f1', t.soon('5 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', '{}'::text[], true) is not null;
select public.lb_create_appointment('f2', t.soon('5 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', '{}'::text[], true) is not null;
select public.lb_create_appointment('f3', t.soon('5 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', '{}'::text[], true) is not null;
select t.err('wealth >= 1000: no top-up', format($q$select public.lb_create_appointment('f4', %L, 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', '{}'::text[], true)$q$, t.soon('5 hours')), 'LB_INSUFFICIENT_POINTS');
-- D 는 900. 300짜리 3개로 0 → 네 번째에서 가진 것 0+900=900 < 1000 이라 300 을 채워 준다
select t.me('0d');
select public.lb_create_appointment('d1', t.soon('5 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', '{}'::text[], true) is not null;
select public.lb_create_appointment('d2', t.soon('5 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', '{}'::text[], true) is not null;
select public.lb_create_appointment('d3', t.soon('5 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', '{}'::text[], true) is not null;
select t.ok('D at 0 before top-up', (select balance from public.profiles) = 0);
select public.lb_create_appointment('d4', t.soon('5 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', '{}'::text[], true) is not null;
select t.ok('top-up of 300 then hold', (select balance from public.profiles) = 0 and (select amount from public.ledger where kind = 'relief') = 300);
-- 시작 전 걸 포인트 인상이 참가자의 부족(채움 불가)으로 막히면 LB_INSUFFICIENT_POINTS + detail = 그 닉네임, 전체 롤백
select t.me('0a');
select (public.lb_create_appointment('인상', t.soon('5 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":50,"penaltyPerUnit":10}', array['에프'], true)->>'id') as ap5 \gset
select t.me('0f'); select t.ok('F joins with 50', public.lb_claim_slot(:'ap5', '에프', 1, true)->>'state' = 'active');
select t.me('0a');
select t.err('raise blocked by poor friend', format('select public.lb_edit_appointment(%L, %L, 1)', :'ap5', '{"policy":{"stake":300}}'), 'LB_INSUFFICIENT_POINTS');
select t.ok('failed raise rolled back (host still 50 held)', (select balance from public.profiles) = 1000);
select t.ok('raise failure detail = the short friend''s nickname', t.detail(format('select public.lb_edit_appointment(%L, %L, 1)', :'ap5', '{"policy":{"stake":300}}')) = '에프');
select t.ok('failed raise kept version 1', (public.lb_get_live(:'ap5')->'appointment'->>'version')::int = 1);
-- 14. 제시간·지각·노쇼 섞인 정산(나머지 분배 결정성·멱등). 주최자 11(하나) + 명단 둘·셋·넷·다섯·여섯(12~16)
--     정책 100P / 5분당 10P / 봐주기 0 → 마감 = 약속 + (10−1)×5 + 30 = 75분.
--     16 −9분·11 −8분·12 −3분(제시간), 13 +7분(지각 2단위 = 20P), 14 +60분(지각 전액 100P), 15 안 옴(100P)
--     → 판돈 220 을 제시간 3명이 73씩, 나머지 1P 는 가장 먼저 온 16 에게(가입 순서가 아니라 도착 순서)
set role authenticated;
select t.me('11'); select public.lb_ensure_profile('하나') is not null;
select t.me('12'); select public.lb_ensure_profile('둘') is not null;
select t.me('13'); select public.lb_ensure_profile('셋') is not null;
select t.me('14'); select public.lb_ensure_profile('넷') is not null;
select t.me('15'); select public.lb_ensure_profile('다섯') is not null;
select t.me('16'); select public.lb_ensure_profile('여섯') is not null;
select t.me('11');
select public.lb_create_appointment('정산', t.soon('3 hours'), 'Asia/Seoul', '시청역', '', 37.5657, 126.9769, :'POL', array['둘', '셋', '넷', '다섯', '여섯'], true)::text as createj \gset
select (:'createj')::jsonb->>'id' as m, (:'createj')::jsonb->>'inviteCode' as mcode \gset
select t.err('lat without lng', format('select public.lb_edit_appointment(%L, %L, 1)', :'m', '{"lat":37.5}'), 'LB_BAD_POSITION');
-- Conformance 로 맞춘 것: 범위 밖 핀은 생성도 LB_BAD_POSITION(CHECK 23514 아님), 메모는 양끝 공백을 지운다
select t.err('create lat out of range -> LB_BAD_POSITION', format('select public.lb_create_appointment(%L, %L, %L, %L, %L, 95, 126.97, %L, null, true)',
  'x', t.soon('3 hours'), 'Asia/Seoul', 'x', '', :'POL'), 'LB_BAD_POSITION');
select public.lb_update_memo(:'m', '  정산 ', '  2층  ');
select t.ok('update_memo trims title and place_note', (select title = '정산' and place_note = '2층' from public.appointments where id = :'m'));
select public.lb_edit_appointment(:'m', '{"placeName":"시청역 3번 출구","lat":37.5660,"lng":126.9775,"policy":{"stake":100,"radiusM":150,"unitMinutes":3,"penaltyPerUnit":10,"graceMinutes":2}}', 1)::text as editj \gset
select t.ok('pre-start place + radius + unit + grace edit: version 2, close = 2 + 9×3 + 30 = 59m', (select (j->>'version')::int = 2 and j->>'placeName' = '시청역 3번 출구'
  and (j->'policy'->>'radiusM')::int = 150 and (j->>'closeMs')::bigint - (j->>'meetAtMs')::bigint = 59 * 60000 from (select (:'editj')::jsonb j) x));
select t.ok('back to 5-minute units: version 3, close 75m', (select (j->>'version')::int = 3 and (j->>'closeMs')::bigint - (j->>'meetAtMs')::bigint = 75 * 60000
  from (select public.lb_edit_appointment(:'m', '{"policy":{"stake":100,"radiusM":100,"unitMinutes":5,"penaltyPerUnit":10,"graceMinutes":0}}', 2) j) x));
select t.ok('stake unchanged: no policy_change rows', (select count(*) from public.ledger where appointment_id = :'m' and meta->>'reason' = 'policy_change') = 0);
select t.me('12');
select public.lb_peek_invite(:'mcode')::text as peekj \gset
select t.ok('peek before claim: 5 open names, not mine', (select jsonb_array_length(j->'invitees') = 5 and not bool_or((e->>'claimed')::boolean or (e->>'mine')::boolean)
  from (select (:'peekj')::jsonb j) x, jsonb_array_elements(j->'invitees') e group by j));
select public.lb_claim_slot(:'m', '둘', 3, true)::text as claimj \gset
select t.ok('12 claims 둘', (:'claimj')::jsonb->>'state' = 'active');
select t.ok('claimed name = participant nickname', (select e->>'nickname' = '둘' from jsonb_array_elements(public.lb_get_live(:'m')->'participants') e where e->>'userId' like '%12'));
select t.me('13'); select t.ok('13 claims 셋', public.lb_claim_slot(:'m', '셋', 3, true)->>'state' = 'active');
select t.me('14'); select t.ok('14 claims 넷', public.lb_claim_slot(:'m', '넷', 3, true)->>'state' = 'active');
select t.ok('claiming a second name is a no-op (one slot per account)', public.lb_claim_slot(:'m', '다섯', 3, true)->>'state' = 'active');  -- 멱등: 이미 멤버면 그대로
select t.ok('14 still holds only 넷', (select count(*) from public.invitees where appointment_id = :'m' and claimed_by::text like '%14') = 1
  and (select claimed_by is null from public.invitees where appointment_id = :'m' and name = '다섯'));
select t.me('15'); select t.ok('15 claims 다섯', public.lb_claim_slot(:'m', '다섯', 3, true)->>'state' = 'active');
select t.me('16'); select t.ok('16 claims 여섯', public.lb_claim_slot(:'m', '여섯', 3, true)->>'state' = 'active');
select t.ok('everyone held 100 (900)', (select balance from public.profiles) = 900);
select t.me('11');
select public.lb_start(:'m')::text as startj \gset
select t.ok('host starts: startedAtMs set, version unchanged', (select j->>'startedAtMs' is not null and (j->>'version')::int = 3 from (select (:'startj')::jsonb j) x));
reset role; select t.at(:'m', '-20 min');
-- 정확도 미달 '근처' 기록은 핀을 옮기면 지워진다(옛 장소 근처였다는 건 새 장소의 근거가 못 된다)
set role authenticated; select t.me('12');
select t.ok('12 low accuracy but near', public.lb_report_location(:'m', 37.5660, 126.9775, 150)->>'reason' = 'low_accuracy');
reset role; select t.ok('12 first_near recorded', (select first_near_at is not null from public.participants where appointment_id = :'m' and user_id::text like '%12'));
set role authenticated; select t.me('11');
select t.ok('pin moved after start (version 4)', (public.lb_edit_appointment(:'m', '{"lat":37.5661,"lng":126.9776}', 3)->>'version')::int = 4);
reset role; select t.ok('pin move clears first_near', (select first_near_at is null from public.participants where appointment_id = :'m' and user_id::text like '%12'));
select t.at(:'m', '-9 min');
set role authenticated; select t.me('16');
select public.lb_report_location(:'m', 37.5700, 126.9800, 10)::text as rep1 \gset
select t.ok('16 outside (stored)', (:'rep1')::jsonb->>'reason' = 'outside' and ((:'rep1')::jsonb->>'distanceM')::int > 100);
select t.me('12'); select public.lb_get_live(:'m')::text as live1 \gset
select t.ok('12 sees 16 location with distance', (select e->'location'->>'distanceM' is not null and (e->'location'->>'lat')::float8 = 37.57
  from jsonb_array_elements((:'live1')::jsonb->'participants') e where e->>'userId' like '%16'));
select t.me('16');
select public.lb_report_location(:'m', 37.5661, 126.9776, 10)::text as rep2 \gset
select t.ok('16 arrives first', ((:'rep2')::jsonb->>'arrived')::boolean and (:'rep2')::jsonb->>'reason' is null);
reset role;
select t.ok('16 location deleted on arrival', (select count(*) from public.locations where appointment_id = :'m' and user_id::text like '%16') = 0);
insert into public.locations (appointment_id, user_id, lat, lng, accuracy_m) values (:'m', '00000000-0000-0000-0000-000000000016', 37.5661, 126.9776, 5);
set role authenticated; select t.me('12');
select t.ok('arrived person: no coords, no lastSeen even if a row exists', (select e->'location' = 'null'::jsonb and e->'lastSeenMs' = 'null'::jsonb
  from jsonb_array_elements(public.lb_get_live(:'m')->'participants') e where e->>'userId' like '%16'));
reset role; delete from public.locations where appointment_id = :'m';
select t.at(:'m', '-8 min');
set role authenticated; select t.me('11'); select t.ok('11 arrives', (public.lb_report_location(:'m', 37.5661, 126.9776, 10)->>'arrived')::boolean);
reset role; select t.at(:'m', '-3 min');
set role authenticated; select t.me('12'); select t.ok('12 arrives', (public.lb_report_location(:'m', 37.5661, 126.9776, 10)->>'arrived')::boolean);
reset role; select t.at(:'m', '7 min');
set role authenticated; select t.me('13'); select t.ok('13 arrives 7m late', (public.lb_report_location(:'m', 37.5661, 126.9776, 10)->>'arrived')::boolean);
reset role; select t.at(:'m', '60 min');
set role authenticated; select t.me('14'); select t.ok('14 arrives 60m late (inside 30m tail)', (public.lb_report_location(:'m', 37.5661, 126.9776, 10)->>'arrived')::boolean);
select t.ok('not settled while 15 missing and window open', (public.lb_get_live(:'m')->>'settlePending')::boolean = false
  and public.lb_get_live(:'m')->'appointment'->>'status' = 'open');
reset role; select t.at(:'m', '75 min 20 seconds');
set role authenticated; select t.me('15');
select t.ok('15 late report after close = closed', public.lb_report_location(:'m', 37.5661, 126.9776, 10)->>'reason' = 'closed');
select t.ok('settled lazily', public.lb_get_live(:'m')->'appointment'->>'status' = 'settled');
reset role;
select t.ok('results by user: 11 on 73 / 12 on 73 / 13 late 20 / 14 late 100 / 15 noShow 100 / 16 on 74',
  (select array_agg(result_status || ':' || forfeited || ':' || received order by user_id) from public.participants where appointment_id = :'m')
  = array['onTime:0:73', 'onTime:0:73', 'late:20:0', 'late:100:0', 'noShow:100:0', 'onTime:0:74']);
select t.ok('payouts 173,173,80,0,0,174', (select array_agg(amount order by user_id) from public.ledger where appointment_id = :'m' and kind = 'payout') = array[173, 173, 80, 0, 0, 174]);
select t.ok('mixed settle: escrow sum 0, received = forfeited', (select sum(amount) from public.ledger where appointment_id = :'m') = 0
  and (select sum(received) = sum(forfeited) from public.participants where appointment_id = :'m'));
select t.ok('balances 1073,1073,980,900,900,1074', (select array_agg(balance order by user_id) from public.profiles where user_id::text ~ '00000000001[1-6]$') = array[1073, 1073, 980, 900, 900, 1074]);
select t.ok('settlement equals lb_settle_preview on the same arrivals', (
  select bool_and(p.result_status = e->>'status' and p.forfeited = (e->>'forfeited')::int and p.received = (e->>'received')::int)
    from jsonb_array_elements(public.lb_settle_preview('{"stake":100,"unitMinutes":5,"penaltyPerUnit":10,"graceMinutes":0}',
           (select floor(extract(epoch from meet_at) * 1000)::bigint from public.appointments where id = :'m'),
           (select jsonb_agg(jsonb_build_object('id', user_id, 'arrivedAtMs', floor(extract(epoch from arrived_at) * 1000)::bigint) order by joined_at, user_id)
              from public.participants where appointment_id = :'m'))->'persons') e
    join public.participants p on p.appointment_id = :'m' and p.user_id::text = e->>'id'));
-- 나머지 분배는 입력 순서가 아니라 도착 순서(동시 도착이면 입력 순서 = 가입 순서)로 결정된다
select t.ok('remainder to earliest arrival regardless of input order (pot 105 -> 53/52)', (select e->>'id' = 'late-joiner' and (e->>'received')::int = 53
  from jsonb_array_elements(public.lb_settle_preview('{"stake":100,"unitMinutes":5,"penaltyPerUnit":5,"graceMinutes":0}', 1000000,
    '[{"id":"first","arrivedAtMs":999000},{"id":"late-joiner","arrivedAtMs":900000},{"id":"x","arrivedAtMs":null},{"id":"y","arrivedAtMs":1000001}]')->'persons') e
  where (e->>'received')::int > 52));
select t.ok('tie: remainder to first in order', (select array_agg((e->>'received')::int order by o) = array[51, 50, 0, 0] from jsonb_array_elements(
  public.lb_settle_preview('{"stake":100,"unitMinutes":5,"penaltyPerUnit":1,"graceMinutes":0}', 1000000,
    '[{"id":"a","arrivedAtMs":900000},{"id":"b","arrivedAtMs":900000},{"id":"c","arrivedAtMs":null},{"id":"d","arrivedAtMs":1060001}]')->'persons') with ordinality as x(e, o)));
-- 멱등: 몇 번을 더 불러도 payout 은 사람당 1줄
select private.lb_settle(:'m'); select private.lb_try_settle(:'m');
set role authenticated; select t.me('11'); select public.lb_get_live(:'m') is not null; select public.lb_list_my_appointments() is not null; reset role;
select t.ok('idempotent: 6 payouts for 6 people', (select count(*) from public.ledger where appointment_id = :'m' and kind = 'payout') = 6);
select t.err('second payout blocked by unique index', format($q$insert into public.ledger (user_id, appointment_id, kind, amount, balance_after) values ('00000000-0000-0000-0000-000000000011', %L, 'payout', 1, 1)$q$, :'m'), '23505');
select t.err('ledger update denied even for owner', 'update public.ledger set amount = amount', 'LB_LEDGER_IMMUTABLE');
select t.err('ledger truncate denied even for owner', 'truncate public.ledger', 'LB_LEDGER_IMMUTABLE');
select t.ok('audit clean #3', (select count(*) from private.lb_audit()) = 0);

-- 14.5 참여 때 부족분 자동 채움 + 취소 환불. 15 는 900 → 300짜리 3개를 주최(잔액 0, 걸린 900, 가진 것 900 < 1000)
set role authenticated; select t.me('15');
select public.lb_create_appointment('g1', t.soon('6 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', '{}'::text[], true) is not null;
select public.lb_create_appointment('g2', t.soon('6 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', '{}'::text[], true) is not null;
select public.lb_create_appointment('g3', t.soon('6 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', '{}'::text[], true) is not null;
select t.ok('15 at 0', (select balance from public.profiles) = 0);
select t.me('11');
select (public.lb_create_appointment('보충', t.soon('6 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, :'POL', array['다섯'], true)->>'id') as g4 \gset
select t.me('15');
select t.ok('claim with 0 balance: topped up then held', public.lb_claim_slot(:'g4', '다섯', 1, true)->>'state' = 'active' and (select balance from public.profiles) = 0);
select public.lb_list_ledger(5)::text as ledj \gset
select t.ok('ledger RPC: hold then relief(topup, reliefFor = appointment)', (select j->0->>'kind' = 'hold' and (j->0->>'amount')::int = -100 and j->0->>'appointmentTitle' = '보충'
  and j->1->>'kind' = 'relief' and j->1->>'reason' = 'topup' and j->1->>'reliefFor' = :'g4' and (j->1->>'amount')::int = 100 and j->1->>'appointmentId' is null
  from (select (:'ledj')::jsonb j) x));
select t.me('11'); select public.lb_cancel(:'g4');
select t.ok('cancel refunds host', (select balance from public.profiles) = 1073);
select t.me('15'); select t.ok('cancel refunds guest (relief kept)', (select balance from public.profiles) = 100);
select t.ok('ledger RPC: canceled refund on top', (select j->0->>'kind' = 'refund' and j->0->>'reason' = 'canceled' and j->0->>'appointmentTitle' = '보충' from (select public.lb_list_ledger(1) j) x));
select t.ok('ledger RPC limit', jsonb_array_length(public.lb_list_ledger(2)) = 2);
select t.me('11'); select t.err('cancel twice', format('select public.lb_cancel(%L)', :'g4'), 'LB_CANCEL_CLOSED');
select t.me('0c');
select t.ok('kicked user still sees the appointment title in ledger', (select bool_or(e->>'reason' = 'kicked' and e->>'appointmentTitle' = '금요일 곱창') from jsonb_array_elements(public.lb_list_ledger()) e));
select t.ok('...though RLS hides that appointment', (select count(*) from public.appointments where title = '금요일 곱창') = 0);

-- 15. 게으른 마감: 홈 목록(lb_list_my_appointments)·초대 미리보기(lb_peek_invite)만 불러도 시작 안 된 약속이 무효되고 빈 이름이 지워진다
set role authenticated; select t.me('12');
select (public.lb_create_appointment('게으른목록', t.soon('2 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":50,"penaltyPerUnit":10}', array['유령'], true)->>'id') as l1 \gset
select (public.lb_create_appointment('열린1', t.soon('5 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":0}', '{}'::text[], true)->>'id') as o1 \gset
select (public.lb_create_appointment('열린2', t.soon('4 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":0}', array['새'], true)->>'id') as o2 \gset
select t.ok('list before: l1 open, 1 unclaimed, not started', (select e->>'status' = 'open' and (e->>'unclaimedCount')::int = 1 and e->>'startedAtMs' is null
  and (e->>'isHost')::boolean and (e->>'memberCount')::int = 1 from jsonb_array_elements(public.lb_list_my_appointments()) e where e->>'id' = :'l1'));
select t.me('13');
select (public.lb_create_appointment('게으른초대', t.soon('2 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":0}', array['유령'], true)->>'inviteCode') as l2code \gset
reset role;
select t.travel(:'l1', '-1 second');
select t.travel((select id from public.appointments where invite_code = :'l2code'), '-1 second');
set role authenticated; select t.me('12');
select public.lb_list_my_appointments()::text as listj \gset
select t.ok('list lazily voids unstarted past-due (notStarted, names dropped)', (select e->>'status' = 'voided' and (e->>'unclaimedCount')::int = 0
  from jsonb_array_elements((:'listj')::jsonb) e where e->>'id' = :'l1'));
select t.ok('list order: open by meet asc, then closed by meet desc', (select array_agg(e->>'id' order by o) from jsonb_array_elements((:'listj')::jsonb) with ordinality x(e, o))
  = array[:'o2', :'o1', :'l1', :'m']);
select t.ok('list: non-host row', (select not (e->>'isHost')::boolean and e->>'hostId' like '%11' and e->>'status' = 'settled' and e->>'startedAtMs' is not null
  from jsonb_array_elements((:'listj')::jsonb) e where e->>'id' = :'m'));
select t.ok('peek lazily closes: no names left, stake 0 -> settled', (select jsonb_array_length(j->'invitees') = 0 and j->>'status' = 'settled' and j->>'myState' is null
  from (select public.lb_peek_invite(:'l2code') j) x));
select t.err('claim on it', format('select public.lb_claim_slot((select id from public.appointments limit 0), %L, 1, true)', '유령'), 'LB_INVITE_NOT_FOUND');
select t.ok('edit_invitees returns the appointment', (select jsonb_array_length(j->'invitees') = 2 from (select public.lb_edit_invitees(:'o2', array['둘째'], null) j) x));
reset role;
select t.ok('lazy void refunded l1 host', (select count(*) from public.ledger where appointment_id = :'l1' and kind = 'refund' and meta->>'reason' = 'notStarted') = 1);
select t.ok('audit clean #4', (select count(*) from private.lb_audit()) = 0);
select t.ok('no settle errors so far', (select count(*) from private.lb_settle_errors) = 0);

-- 16. 권한(원칙 1·5·7). 프로필도 약속도 없는 사용자 1f 로: 모든 테이블 직접 읽기/쓰기, private 함수, anon 이 부를 수 있는 RPC
set role authenticated; select t.me('1f');
select * from t.table_matrix();
select * from t.call_all('private', array['lb_is_member']);
select t.ok('authenticated may call lb_is_member (RLS helper) = only own membership', private.lb_is_member(:'m') = false);
reset role; set role anon; select t.me('1f');
select * from t.table_matrix();
select * from t.call_all('private', array[]::text[]);
select * from t.call_all('public', array['lb_ping']);
select t.ok('anon ping works', public.lb_ping() ? 'serverNowMs');
reset role;
select t.ok('anon can execute only public.lb_ping', (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'EXECUTE')) = array['lb_ping']);
select t.ok('authenticated executes no private fn but lb_is_member', (select array_agg(p.proname::text) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'private' and has_function_privilege('authenticated', p.oid, 'EXECUTE')) = array['lb_is_member']);
select t.ok('authenticated executes every public.lb_*', not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname like 'lb\_%' and not has_function_privilege('authenticated', p.oid, 'EXECUTE')));
select t.ok('public RPC count = 19 (16 + ping + settle_preview + list_my_appointments + list_ledger - 1 start is #17)', (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname like 'lb\_%') = 19);
select t.ok('every SECURITY DEFINER fn pins search_path to empty', (select count(*) > 20 and bool_and('search_path=""' = any (coalesce(p.proconfig, '{}')))
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname in ('public', 'private') and p.prosecdef));
select p.oid::regprocedure::text as definer_without_search_path from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
 where ns.nspname in ('public', 'private') and p.prosecdef and not ('search_path=""' = any (coalesce(p.proconfig, '{}')));
select t.ok('every public.lb_* is SECURITY DEFINER except pure helpers', (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname like 'lb\_%' and not p.prosecdef) is null);
select t.ok('RLS on for every table in public/private', not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname in ('public', 'private') and c.relkind = 'r' and not c.relrowsecurity));
select t.ok('only SELECT policies exist', not exists (select 1 from pg_policies where schemaname in ('public', 'private') and cmd <> 'SELECT'));
select t.ok('no policy on locations / private tables', not exists (select 1 from pg_policies where tablename = 'locations' or schemaname = 'private'));
select t.ok('no sequence usable by clients', not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname in ('public', 'private') and c.relkind = 'S' and (has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE') or has_sequence_privilege('authenticated', c.oid, 'USAGE,SELECT,UPDATE'))));
select t.ok('anon has no usage on private schema', not has_schema_privilege('anon', 'private', 'USAGE'));
-- 원칙 1: 이후 마이그레이션이 만드는 새 객체도 기본 권한이 없다(0절의 default privileges 회수)
set role postgres;
create table public.t_new_table (x int);
create function public.lb_t_new_fn() returns int language sql as 'select 1';
reset role;
select t.ok('new table gets no default grants', not has_table_privilege('authenticated', 'public.t_new_table', 'SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('anon', 'public.t_new_table', 'SELECT,INSERT,UPDATE,DELETE'));
select t.ok('new function gets no default execute (anon/authenticated/PUBLIC)', not has_function_privilege('anon', 'public.lb_t_new_fn()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.lb_t_new_fn()', 'EXECUTE'));
drop function public.lb_t_new_fn(); drop table public.t_new_table;

-- 17. 반환 모양(클라이언트 DTO 계약 — src/lateBet/types.ts). 키 집합이 정확히 같아야 한다
set role authenticated; select t.me('12');
select t.ok('shape lb_ping = LbPing', t.keys(public.lb_ping()) = t.set(array['serverNowMs', 'minBuild', 'iosUrl', 'androidUrl']));
select t.ok('shape lb_ensure_profile = profiles row (snake_case)', t.keys(to_jsonb(public.lb_ensure_profile('둘'))) = t.set(array['user_id', 'nickname', 'balance', 'created_at']));
select t.ok('shape LbAppointment (create/edit/start/edit_invitees/live)', (select bool_and(t.keys(j) = t.set(array['id', 'inviteCode', 'hostId', 'hostNickname', 'title', 'localAt', 'tz',
  'meetAtMs', 'startedAtMs', 'closeMs', 'placeName', 'placeNote', 'placeLat', 'placeLng', 'status', 'voidReason', 'version', 'policy', 'invitees', 'changes', 'startMeetAtMs', 'startPlaceLat', 'startPlaceLng', 'startableAtMs']))
  from unnest(array[(:'createj')::jsonb, (:'editj')::jsonb, (:'startj')::jsonb, public.lb_edit_invitees(:'o2', null, array['둘째']), (:'live1')::jsonb->'appointment']) j));
select t.ok('shape LatePolicy', t.keys((:'createj')::jsonb->'policy') = t.set(array['stake', 'radiusM', 'unitMinutes', 'penaltyPerUnit', 'graceMinutes']));
select t.ok('shape LbInvitee', (select bool_and(t.keys(e) = t.set(array['name', 'claimedByUserId', 'claimedAtMs'])) from jsonb_array_elements((:'live1')::jsonb->'appointment'->'invitees') e));
select t.ok('shape LbAppointmentChange + snapshot', (select bool_and(t.keys(e) = t.set(array['version', 'atMs', 'before', 'after'])
  and t.keys(e->'before') = t.set(array['localAt', 'tz', 'meetAtMs', 'placeName', 'placeLat', 'placeLng', 'policy']) and t.keys(e->'after') = t.keys(e->'before'))
  from jsonb_array_elements((:'editj')::jsonb->'changes') e));
select t.ok('shape LbInvitePreview', t.keys((:'peekj')::jsonb) = t.set(array['id', 'title', 'hostNickname', 'localAt', 'tz', 'meetAtMs', 'startedAtMs', 'closeMs', 'placeName',
  'placeNote', 'placeLat', 'placeLng', 'status', 'version', 'serverNowMs', 'policy', 'memberCount', 'invitees', 'myState', 'myBalance'])
  and t.keys((:'peekj')::jsonb->'invitees'->0) = t.set(array['name', 'claimed', 'mine']));
select t.ok('shape LbJoinResult', t.keys((:'claimj')::jsonb) = t.set(array['appointmentId', 'state', 'started']));
select t.ok('shape LbReportResult', t.keys((:'rep1')::jsonb) = t.set(array['arrived', 'reason', 'arrivedAtMs', 'distanceM', 'serverNowMs']) and t.keys((:'rep2')::jsonb) = t.keys((:'rep1')::jsonb));
select t.ok('shape LbLive', t.keys((:'live1')::jsonb) = t.set(array['serverNowMs', 'myUserId', 'myState', 'myBalance', 'settlePending', 'appointment', 'participants']));
select t.ok('shape LbLiveParticipant + LbLiveLocation', (select bool_and(t.keys(e) = t.set(array['userId', 'nickname', 'state', 'joinedAtMs', 'arrivedAtMs', 'arrivalMethod',
  'arrivalDistanceM', 'arrivalAccuracyM', 'vouchedBy', 'joinedAfterStart', 'resultStatus', 'forfeited', 'received', 'lastSeenMs', 'location']))
  and bool_and(e->'location' = 'null'::jsonb or t.keys(e->'location') = t.set(array['lat', 'lng', 'accuracyM', 'updatedAtMs', 'distanceM']))
  and count(*) filter (where e->'location' <> 'null'::jsonb) = 1 from jsonb_array_elements((:'live1')::jsonb->'participants') e));
select t.ok('shape LbMyAppointment', (select bool_and(t.keys(e) = t.set(array['id', 'title', 'localAt', 'tz', 'meetAtMs', 'startedAtMs', 'closeMs', 'placeName', 'status',
  'policy', 'hostId', 'isHost', 'myState', 'memberCount', 'unclaimedCount'])) from jsonb_array_elements((:'listj')::jsonb) e));
select t.ok('shape LbLedgerEntry', (select bool_and(t.keys(e) = t.set(array['id', 'kind', 'amount', 'balanceAfter', 'appointmentId', 'appointmentTitle', 'reason',
  'reliefFor', 'createdAtMs'])) from jsonb_array_elements(public.lb_list_ledger()) e));
select t.ok('void RPCs return null (leave/kick/cancel/update_memo/stop_sharing/vouch)', (select bool_and(format_type(p.prorettype, null) = 'void') from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname = 'public' and p.proname in ('lb_leave', 'lb_kick', 'lb_cancel', 'lb_update_memo', 'lb_stop_sharing', 'lb_vouch')));

-- 18. 생성 멱등 키(p_request_id): 타임아웃 뒤 [만들기] 재시도가 약속·에스크로를 두 번 만들지 않는다
set role authenticated; select t.me('21'); select public.lb_ensure_profile('멱등') is not null;
\set RID '7d4b1c2e-0000-4000-8000-00000000abcd'
select (public.lb_create_appointment('중복', t.soon('3 hours'), 'Asia/Seoul', '강남역', '', 37.4979, 127.0276, '{"stake":300,"penaltyPerUnit":10}', array['친구'], true, false, :'RID'::uuid))::text as idem1 \gset
select (public.lb_create_appointment('중복', t.soon('3 hours'), 'Asia/Seoul', '강남역', '', 37.4979, 127.0276, '{"stake":300,"penaltyPerUnit":10}', array['친구'], true, false, :'RID'::uuid))::text as idem2 \gset
select t.ok('idempotent create: same appointment returned', (:'idem1')::jsonb->>'id' = (:'idem2')::jsonb->>'id' and (:'idem1')::jsonb->>'inviteCode' = (:'idem2')::jsonb->>'inviteCode');
select t.ok('idempotent create: one appointment, one hold (1000 - 300)', (select count(*) from public.appointments where host_id = '00000000-0000-0000-0000-000000000021'::uuid) = 1
  and (select balance from public.profiles) = 700
  and (select count(*) from public.ledger where user_id = '00000000-0000-0000-0000-000000000021'::uuid and kind = 'hold') = 1);
select t.ok('idempotent create: roster not duplicated', (select count(*) from public.invitees where appointment_id = ((:'idem1')::jsonb->>'id')::uuid) = 1);
-- 재시도는 첫 요청이 통과한 검사를 다시 하지 않는다(동의 false 로 와도 같은 약속). 다른 키는 새 약속
select t.ok('idempotent replay skips checks', public.lb_create_appointment('딴거', t.soon('4 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":0}', '{}'::text[], false, false, :'RID'::uuid)->>'id' = (:'idem1')::jsonb->>'id');
select t.ok('different request id -> new appointment', public.lb_create_appointment('중복', t.soon('3 hours'), 'Asia/Seoul', '강남역', '', 37.4979, 127.0276, '{"stake":0}', '{}'::text[], true, false, gen_random_uuid())->>'id' <> (:'idem1')::jsonb->>'id');
select t.ok('null request id -> no dedup', public.lb_create_appointment('중복', t.soon('3 hours'), 'Asia/Seoul', '강남역', '', 37.4979, 127.0276, '{"stake":0}', '{}'::text[], true)->>'id'
  <> public.lb_create_appointment('중복', t.soon('3 hours'), 'Asia/Seoul', '강남역', '', 37.4979, 127.0276, '{"stake":0}', '{}'::text[], true)->>'id');
-- 키는 주최자별: 다른 사람이 같은 키를 써도 남의 약속이 새지 않는다
select t.me('22'); select public.lb_ensure_profile('남') is not null;
select t.ok('request id scoped per host', public.lb_create_appointment('남의것', t.soon('3 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":0}', '{}'::text[], true, false, :'RID'::uuid)->>'id' <> (:'idem1')::jsonb->>'id');
select t.err('rejected create (consent false, fresh key)', format($q$select public.lb_create_appointment('x', %L, 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":0}', '{}'::text[], false, false, 'aaaaaaaa-0000-4000-8000-000000000001'::uuid)$q$, t.soon('3 hours')), 'LB_CONSENT_REQUIRED');
select t.ok('key free after a rejected create', public.lb_create_appointment('재도전', t.soon('3 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":0}', '{}'::text[], true, false, 'aaaaaaaa-0000-4000-8000-000000000001'::uuid)->>'title' = '재도전');

-- 19. 공정성 규칙 R1~R4(오너 결정 2026-09-19). 주최자 31, 친구 32·33·34. 판정은 전부 서버 시계 — 테스트는 슈퍼유저로 약속 행의 시각을 직접 놓는다.
reset role;
-- 시작 시점 핀에서 정북으로 m 미터 옮긴 핀(순수 위도 차이는 haversine = R × Δφ 라 경계를 정확히 잰다)
create or replace function t.pin_north(p_appt uuid, p_m float8) returns text language sql as $$
  select jsonb_build_object('lat', start_place_lat + p_m / (6371008.8 * pi() / 180), 'lng', start_place_lng)::text
    from public.appointments where id = p_appt; $$;
-- 시작 시점 약속 시각 + p 의 벽시계(localAt)
create or replace function t.from_start(p_appt uuid, p interval) returns text language sql as $$
  select jsonb_build_object('localAt', to_char((start_meet_at + p) at time zone tz, 'YYYY-MM-DD"T"HH24:MI'))::text
    from public.appointments where id = p_appt; $$;
create or replace function t.ver(p_appt uuid) returns int language sql as $$ select version from public.appointments where id = p_appt; $$;
create or replace function t.mc(p_appt uuid) returns timestamptz language sql as $$ select material_changed_at from public.appointments where id = p_appt; $$;
grant execute on function t.pin_north(uuid, float8), t.from_start(uuid, interval), t.ver(uuid), t.mc(uuid) to authenticated;
set role authenticated;
select t.me('31'); select public.lb_ensure_profile('삼일') is not null;
select t.me('32'); select public.lb_ensure_profile('삼이') is not null;
select t.me('33'); select public.lb_ensure_profile('삼삼') is not null;
select t.me('34'); select public.lb_ensure_profile('삼사') is not null;

-- 19-1. R3 조건 바꾼 직후 시작 금지
select t.me('31');
select (public.lb_create_appointment('공정', t.soon('3 hours'), 'Asia/Seoul', '광화문', '', 37.5759, 126.9768, '{"stake":50,"penaltyPerUnit":10}', array['삼이', '삼삼'], true)->>'id') as f1 \gset
select t.ok('R3 policy change alone: not recorded, startableAtMs null', (select j->'startableAtMs' = 'null'::jsonb and t.mc(:'f1') is null
  from (select public.lb_edit_appointment(:'f1', '{"policy":{"graceMinutes":1}}', 1) j) x));
select t.me('32'); select t.ok('R3 32 claims', public.lb_claim_slot(:'f1', '삼이', 2, true)->>'state' = 'active');
select t.me('31');
select t.ok('R3 place-name-only change with a friend: no cooldown', (select j->'startableAtMs' = 'null'::jsonb and t.mc(:'f1') is null
  from (select public.lb_edit_appointment(:'f1', '{"placeName":"광화문 광장"}', 2) j) x));
select public.lb_update_memo(:'f1', '공정 약속', '분수대 앞');
select t.ok('R3 roster edit (add/remove) with a friend: no cooldown', jsonb_array_length(public.lb_edit_invitees(:'f1', array['삼사'], array['삼삼'])->'invitees') = 2 and t.mc(:'f1') is null);
select t.ok('R3 memo/title edit: no cooldown', t.mc(:'f1') is null and public.lb_get_live(:'f1')->'appointment'->'startableAtMs' = 'null'::jsonb);
select t.ok('R3 same values re-sent with a friend: no-op, no cooldown', (public.lb_edit_appointment(:'f1', '{"policy":{"graceMinutes":1}}', 3)->>'version')::int = 3 and t.mc(:'f1') is null);
select public.lb_edit_appointment(:'f1', '{"policy":{"graceMinutes":2}}', 3)::text as f1e \gset
select t.ok('R3 policy change with a friend: recorded, startableAtMs = changed + 5m', (select (j->>'startableAtMs')::bigint = floor(extract(epoch from t.mc(:'f1')) * 1000)::bigint + 300000
  and (j->>'startableAtMs')::bigint > floor(extract(epoch from clock_timestamp()) * 1000)::bigint from (select (:'f1e')::jsonb j) x));
select t.err('R3 start right after change', format('select public.lb_start(%L)', :'f1'), 'LB_START_COOLDOWN');
reset role; update public.appointments set material_changed_at = now() - interval '4 minutes 59 seconds' where id = :'f1';
set role authenticated; select t.me('31');
select t.err('R3 start at 4m59s after change', format('select public.lb_start(%L)', :'f1'), 'LB_START_COOLDOWN');
reset role; update public.appointments set material_changed_at = now() - interval '1 hour' where id = :'f1';
set role authenticated; select t.me('31');
select t.ok('R3 pin move with a friend: recorded anew', (public.lb_edit_appointment(:'f1', '{"lat":37.5760,"lng":126.9769}', 4)->>'version')::int = 5
  and t.mc(:'f1') > now() - interval '1 minute');
reset role; update public.appointments set material_changed_at = now() - interval '1 hour' where id = :'f1';
set role authenticated; select t.me('31');
select t.ok('R3 time change with a friend: recorded anew', (public.lb_edit_appointment(:'f1', jsonb_build_object('localAt', t.soon('4 hours')), 5)->>'version')::int = 6
  and t.mc(:'f1') > now() - interval '1 minute');
reset role; update public.appointments set material_changed_at = now() - interval '5 minutes' where id = :'f1';
set role authenticated; select t.me('31');
select t.ok('R3 cooldown shown as null once 5m passed', public.lb_get_live(:'f1')->'appointment'->'startableAtMs' = 'null'::jsonb);
select public.lb_start(:'f1')::text as f1s \gset
select t.ok('R3 start exactly 5m after change: ok', (:'f1s')::jsonb->>'startedAtMs' is not null);
select t.ok('start snapshots meet/pin; startableAtMs null after start', (select (j->>'startMeetAtMs')::bigint = (j->>'meetAtMs')::bigint
  and (j->>'startPlaceLat')::float8 = 37.5760 and (j->>'startPlaceLng')::float8 = 126.9769 and j->'startableAtMs' = 'null'::jsonb from (select (:'f1s')::jsonb j) x));
select t.ok('before start: startMeetAtMs/startPlace null', (select j->'startMeetAtMs' = 'null'::jsonb and j->'startPlaceLat' = 'null'::jsonb and j->'startPlaceLng' = 'null'::jsonb
  from (select (:'f1e')::jsonb j) x));
reset role; update public.appointments set material_changed_at = null where id = :'f1';
set role authenticated; select t.me('31');
select t.ok('R3 pin move after start (friend present): recorded like the fake server (harmless, start is one-shot)', (public.lb_edit_appointment(:'f1', '{"lat":37.5761,"lng":126.9769}', t.ver(:'f1'))->>'startableAtMs') is not null
  and t.mc(:'f1') > now() - interval '1 minute');
reset role; update public.appointments set material_changed_at = now() - interval '1 hour' where id = :'f1';
set role authenticated; select t.me('31');
select public.lb_edit_appointment(:'f1', '{"placeName":"광화문 북측"}', t.ver(:'f1')) is not null;
select t.ok('R3 place-name-only change leaves the record alone', t.mc(:'f1') < now() - interval '59 minutes');

-- 19-2. R1 시작 후 미루기: 지금 약속 시각 전에만, 시작 시점 약속 시각 + 180분 누적
reset role;   -- 약속 1분 전(시작 시점 약속 시각도 같은 값)
update public.appointments set meet_at = now() + interval '1 minute', start_meet_at = now() + interval '1 minute', started_at = now() - interval '10 minutes',
       local_at = to_char((now() + interval '1 minute') at time zone tz, 'YYYY-MM-DD"T"HH24:MI'),
       close_at = private.lb_close_at(now() + interval '1 minute', stake, unit_minutes, penalty_per_unit, grace_minutes) where id = :'f1';
set role authenticated; select t.me('31');
select t.ok('R1 postpone 1 min before meet: ok', (public.lb_edit_appointment(:'f1', jsonb_build_object('localAt', t.soon('30 minutes')), t.ver(:'f1'))->>'meetAtMs')::bigint
  > floor(extract(epoch from now() + interval '25 minutes') * 1000)::bigint);
reset role;   -- 약속 시각이 1분 지남
update public.appointments set meet_at = now() - interval '1 minute', start_meet_at = now() - interval '1 minute', started_at = now() - interval '10 minutes',
       local_at = to_char((now() - interval '1 minute') at time zone tz, 'YYYY-MM-DD"T"HH24:MI'),
       close_at = private.lb_close_at(now() - interval '1 minute', stake, unit_minutes, penalty_per_unit, grace_minutes) where id = :'f1';
set role authenticated; select t.me('31');
select t.err('R1 postpone after meet time', format('select public.lb_edit_appointment(%L, %L, t.ver(%L))', :'f1', jsonb_build_object('localAt', t.soon('30 minutes')), :'f1'), 'LB_POSTPONE_AFTER_MEET');
select t.err('R1 postpone after meet even within cap (tz change too)', format('select public.lb_edit_appointment(%L, %L, t.ver(%L))', :'f1', jsonb_build_object('localAt', t.soon('20 minutes'), 'tz', 'Asia/Tokyo'), :'f1'), 'LB_POSTPONE_AFTER_MEET');
select t.ok('R1 place name change after meet still ok', public.lb_edit_appointment(:'f1', '{"placeName":"광화문 남측"}', t.ver(:'f1'))->>'placeName' = '광화문 남측');
reset role;   -- 약속 30분 전, 시작 시점 약속 시각 = 지금 약속 시각(분 단위로 맞춘다)
update public.appointments set meet_at = date_trunc('minute', now()) + interval '30 minutes', start_meet_at = date_trunc('minute', now()) + interval '30 minutes',
       started_at = now() - interval '10 minutes',
       local_at = to_char((date_trunc('minute', now()) + interval '30 minutes') at time zone tz, 'YYYY-MM-DD"T"HH24:MI'),
       close_at = private.lb_close_at(date_trunc('minute', now()) + interval '30 minutes', stake, unit_minutes, penalty_per_unit, grace_minutes) where id = :'f1';
set role authenticated; select t.me('31');
select t.ok('R1 postpone +120m from start: ok', (select (j->>'meetAtMs')::bigint - (j->>'startMeetAtMs')::bigint = 120 * 60000
  from (select public.lb_edit_appointment(:'f1', t.from_start(:'f1', '120 minutes')::jsonb, t.ver(:'f1')) j) x));
select t.err('R1 earlier than current meet = postpone only', format('select public.lb_edit_appointment(%L, t.from_start(%L, %L)::jsonb, t.ver(%L))', :'f1', :'f1', '60 minutes', :'f1'), 'LB_POSTPONE_ONLY');
select t.err('R1 cumulative +181m from start', format('select public.lb_edit_appointment(%L, t.from_start(%L, %L)::jsonb, t.ver(%L))', :'f1', :'f1', '181 minutes', :'f1'), 'LB_POSTPONE_TOO_FAR');
select t.ok('R1 cumulative exactly +180m from start: ok (second postpone)', (select (j->>'meetAtMs')::bigint - (j->>'startMeetAtMs')::bigint = 180 * 60000
  from (select public.lb_edit_appointment(:'f1', t.from_start(:'f1', '180 minutes')::jsonb, t.ver(:'f1')) j) x));
select t.err('R1 repeated postpone cannot extend the cap (+1m more)', format('select public.lb_edit_appointment(%L, t.from_start(%L, %L)::jsonb, t.ver(%L))', :'f1', :'f1', '181 minutes', :'f1'), 'LB_POSTPONE_TOO_FAR');
select t.ok('R1 startMeetAtMs unchanged by postpones', (select start_meet_at = date_trunc('minute', start_meet_at) and meet_at - start_meet_at = interval '180 minutes' from public.appointments where id = :'f1'));

-- 19-3. R2 시작 후 장소: 시작 시점 핀에서 500m 이내(누적)
select t.ok('R2 move 499m from start pin: ok', (public.lb_edit_appointment(:'f1', t.pin_north(:'f1', 499)::jsonb, t.ver(:'f1'))->>'placeLat')::float8 > 37.5760);
select t.err('R2 move 501m from start pin', format('select public.lb_edit_appointment(%L, t.pin_north(%L, 501)::jsonb, t.ver(%L))', :'f1', :'f1', :'f1'), 'LB_MOVE_TOO_FAR');
select t.ok('R2 back to 300m: ok', (public.lb_edit_appointment(:'f1', t.pin_north(:'f1', 300)::jsonb, t.ver(:'f1'))->>'version') is not null);
select t.err('R2 two 300m hops (600m from start pin) rejected', format($q$select public.lb_edit_appointment(%L, jsonb_build_object('lat', (select place_lat from public.appointments where id = %L) + 300 / (6371008.8 * pi() / 180), 'lng', (select place_lng from public.appointments where id = %L)), t.ver(%L))$q$, :'f1', :'f1', :'f1', :'f1'), 'LB_MOVE_TOO_FAR');
select t.ok('R2 rejected move left the pin at 300m', (select abs(private_dist - 300) < 0.01 from (select 2 * 6371008.8 * asin(sqrt(power(sin(radians(place_lat - start_place_lat) / 2), 2))) as private_dist
  from public.appointments where id = :'f1') x));
select t.ok('R2 name-only change after start: ok', public.lb_edit_appointment(:'f1', '{"placeName":"광화문 새 장소"}', t.ver(:'f1'))->>'placeName' = '광화문 새 장소');
select t.ok('R2 start pin unchanged by moves', (select start_place_lat = 37.5760 and start_place_lng = 126.9769 from public.appointments where id = :'f1'));
select (public.lb_create_appointment('먼곳', t.soon('3 hours'), 'Asia/Seoul', '광화문', '', 37.5759, 126.9768, '{"stake":0}', array['삼이'], true)->>'id') as f2 \gset
select t.me('32'); select public.lb_claim_slot(:'f2', '삼이', 1, true) is not null;
select t.me('31');
select t.ok('R2 before start: 5km move is free', (public.lb_edit_appointment(:'f2', '{"lat":37.5309,"lng":126.9768}', 1)->>'placeLat')::float8 = 37.5309);

-- 19-4. R4 시작 후 내보내기: 시작 뒤에 들어온 사람만, 정산 전까지. 환불·좌표 삭제·차단·이름 칸 비움(다른 사람이 고를 수 있다)
select (public.lb_create_appointment('유출', t.soon('3 hours'), 'Asia/Seoul', '시청역', '', 37.5657, 126.9769, :'POL', array['삼이', '삼삼'], true)->>'id') as f4 \gset
select invite_code as f4code from public.appointments where id = :'f4' \gset
select t.me('32'); select t.ok('R4 32 joins before start', public.lb_claim_slot(:'f4', '삼이', 1, true)->>'state' = 'active');
select t.me('31'); select t.ok('R4 host starts', public.lb_start(:'f4')->>'startedAtMs' is not null);
select t.ok('R4 joinedAfterStart false before anyone joins late', (select bool_and(not (e->>'joinedAfterStart')::boolean) from jsonb_array_elements(public.lb_get_live(:'f4')->'participants') e));
select t.me('33'); select t.ok('R4 33 (a stranger) takes 삼삼 after start', (public.lb_claim_slot(:'f4', '삼삼', 1, true)->>'started')::boolean);
select t.ok('R4 33 hold 100 (900)', (select balance from public.profiles) = 900);
select t.ok('R4 33 shares location', public.lb_report_location(:'f4', 37.5700, 126.9800, 10)->>'reason' = 'outside');
select t.me('31');
select t.ok('R4 joinedAfterStart: host false, 32 false, 33 true', (select array_agg((e->>'joinedAfterStart') order by e->>'userId') = array['false', 'false', 'true']
  from jsonb_array_elements(public.lb_get_live(:'f4')->'participants') e));
select t.err('R4 pre-start member cannot be kicked after start', format($q$select public.lb_kick(%L, '00000000-0000-0000-0000-000000000032')$q$, :'f4'), 'LB_KICK_CLOSED');
select public.lb_kick(:'f4', '00000000-0000-0000-0000-000000000033');
select t.ok('R4 kicked late joiner gone', jsonb_array_length(public.lb_get_live(:'f4')->'participants') = 2);
select t.ok('R4 name slot freed (not removed)', (select e->>'claimedByUserId' is null and e->>'claimedAtMs' is null
  from jsonb_array_elements(public.lb_get_live(:'f4')->'appointment'->'invitees') e where e->>'name' = '삼삼'));
reset role;
select t.ok('R4 kicked location deleted at once', (select count(*) from public.locations where appointment_id = :'f4' and user_id::text like '%33') = 0);
select t.ok('R4 kick refund with reason kicked', (select count(*) from public.ledger where appointment_id = :'f4' and user_id::text like '%33' and kind = 'refund' and meta->>'reason' = 'kicked') = 1);
select t.ok('R4 kicked is banned', exists (select 1 from private.lb_bans where appointment_id = :'f4' and user_id::text like '%33'));
set role authenticated; select t.me('33');
select t.ok('R4 kick refund (1000)', (select balance from public.profiles) = 1000);
select t.err('R4 banned cannot re-claim', format('select public.lb_claim_slot(%L, %L, 1, true)', :'f4', '삼삼'), 'LB_INVITE_NOT_FOUND');
select t.err('R4 banned cannot peek', format('select public.lb_peek_invite(%L)', :'f4code'), 'LB_INVITE_NOT_FOUND');
select t.me('34'); select t.ok('R4 freed slot claimable by someone else (before meet)', (public.lb_claim_slot(:'f4', '삼삼', 1, true)->>'started')::boolean);
select t.me('31');
select t.ok('R4 new claimer is joinedAfterStart', (select (e->>'joinedAfterStart')::boolean from jsonb_array_elements(public.lb_get_live(:'f4')->'participants') e where e->>'userId' like '%34'));
-- 마감(close_at)이 지났지만 게으른 정산이 아직 안 돈 틈: 결과가 정해진 뒤라 못 내보낸다
reset role; select t.at(:'f4', (select close_at - meet_at + interval '1 second' from public.appointments where id = :'f4'));
set role authenticated; select t.me('31');
select t.err('R4 no kick after close_at (before lazy settle)', format($q$select public.lb_kick(%L, '00000000-0000-0000-0000-000000000034')$q$, :'f4'), 'LB_KICK_CLOSED');
reset role;
select t.ok('R4 still open after refused kick', (select status = 'open' from public.appointments where id = :'f4'));
select t.ok('R4 34 still in after refused kick', exists (select 1 from public.participants where appointment_id = :'f4' and user_id::text like '%34'));
select t.at(:'f4', '80 min');
set role authenticated; select t.me('31');
select t.ok('R4 closed by settlement (all no-show -> voided noWinner)', (select j->>'status' = 'voided' and j->>'voidReason' = 'noWinner' from (select public.lb_get_live(:'f4')->'appointment' j) x));
select t.err('R4 no kick after settle', format($q$select public.lb_kick(%L, '00000000-0000-0000-0000-000000000034')$q$, :'f4'), 'LB_KICK_CLOSED');
select t.ok('R4 joinedAfterStart survives settle for late joiner', (select (e->>'joinedAfterStart')::boolean from jsonb_array_elements(public.lb_get_live(:'f4')->'participants') e where e->>'userId' like '%34'));
reset role;
select t.ok('audit clean after fairness rules', (select count(*) from private.lb_audit()) = 0);
select * from private.lb_audit();

reset role;
select t.ok('ledger meta.anon recorded', (select bool_and(meta ? 'anon') from public.ledger));
select t.ok('audit clean #2', (select count(*) from private.lb_audit()) = 0);
select * from private.lb_audit();
select t.ok('no settle errors', (select count(*) from private.lb_settle_errors) = 0);
