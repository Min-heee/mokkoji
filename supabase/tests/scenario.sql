-- supabase/tests/scenario.sql — 로컬 PG16(stub.sql + 마이그레이션 적용 후)에서 실행. 출력에 FAIL 이 한 줄도 없어야 한다.
-- 오너 확정 흐름(2026-09-18, '주최자 [시작하기]' 모델): 초대 명단·slot claim(약속 시각까지, 시작 후에도)·시작 전 전부 변경·
-- 시작 후 미루기/장소만·위치 공개는 시작부터·시작 안 된 약속은 약속 시각에 자동 무효·공개 창 30분 꼬리.
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
create schema if not exists t;
grant usage on schema t to authenticated, anon;
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
grant execute on all functions in schema t to authenticated, anon;
create or replace function t.soon(p interval) returns text language sql as $$
  select to_char((now() + p) at time zone 'Asia/Seoul', 'YYYY-MM-DD"T"HH24:MI'); $$;
grant execute on function t.soon(interval) to authenticated;
insert into auth.users (id) select ('00000000-0000-0000-0000-0000000000' || x)::uuid from unnest(array['0a','0b','0c','0d','0e','0f']) x;

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
update public.appointments set meet_at = now() + interval '10 min',
  close_at = private.lb_close_at(now() + interval '10 min', stake, unit_minutes, penalty_per_unit, grace_minutes) where id = :'appt';
set role authenticated;
select t.me('0b');
select t.ok('before start: check-in not_open', public.lb_report_location(:'appt', 37.5100, 127.0400, 15, false, true)->>'reason' = 'not_open');
reset role; select t.ok('before start: nothing stored', (select count(*) from public.locations) = 0);
set role authenticated; select t.me('0a');
select t.err('before start: vouch = not started', format($q$select public.lb_vouch(%L, '00000000-0000-0000-0000-00000000000b')$q$, :'appt'), 'LB_NOT_STARTED');
select t.ok('before start: host sees no location nor lastSeen', (select count(*) filter (where e->'location' <> 'null'::jsonb) = 0
  and count(*) filter (where e->'lastSeenMs' <> 'null'::jsonb) = 0 from jsonb_array_elements(public.lb_get_live(:'appt')->'participants') e));
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
select t.err('no kick after start', format($q$select public.lb_kick(%L, '00000000-0000-0000-0000-00000000000d')$q$, :'appt'), 'LB_KICK_CLOSED');
select t.err('no cancel after start with others', format('select public.lb_cancel(%L)', :'appt'), 'LB_CANCEL_CLOSED');
select t.err('roster frozen after start', format($q$select public.lb_edit_invitees(%L, array['영희'], null)$q$, :'appt'), 'LB_EDIT_FROZEN');
select t.err('policy frozen after start', format('select public.lb_edit_appointment(%L, %L, %s)', :'appt', '{"policy":{"stake":200}}', :v2), 'LB_EDIT_FROZEN');
select t.err('radius frozen after start', format('select public.lb_edit_appointment(%L, %L, %s)', :'appt', '{"policy":{"radiusM":200}}', :v2), 'LB_EDIT_FROZEN');
select t.err('postpone only', format('select public.lb_edit_appointment(%L, %L, %s)', :'appt', jsonb_build_object('localAt', t.soon('7 minutes'))::text, :v2), 'LB_POSTPONE_ONLY');
select t.err('postpone too far', format('select public.lb_edit_appointment(%L, %L, %s)', :'appt', jsonb_build_object('localAt', t.soon('4 hours'))::text, :v2), 'LB_POSTPONE_TOO_FAR');
select t.ok('postpone +2h and move pin: ok', (select (j->>'version')::int = :v2 + 1 and j->>'placeName' = '강남역 2번 출구'
  from (select public.lb_edit_appointment(:'appt', jsonb_build_object('localAt', t.soon('2 hours'), 'placeName', '강남역 2번 출구', 'lat', 37.4981, 'lng', 127.0278), :v2) j) x));
select :v2 + 1 as v3 \gset
select t.ok('postpone recomputes close_at from new time', (select close_at - meet_at = interval '75 minutes'
  and meet_at > now() + interval '110 minutes' from public.appointments where id = :'appt'));
select t.ok('still started after postpone', (select started_at is not null and started_at < meet_at from public.appointments where id = :'appt'));
select t.me('0d'); select t.err('no leave after start', format('select public.lb_leave(%L)', :'appt'), 'LB_LEAVE_CLOSED');
reset role;
select t.ok('share log has (viewer a -> subject b)', exists (select 1 from private.lb_share_log where viewer_id::text like '%0a' and subject_id::text like '%0b'));
select t.err('started_at must precede meet_at (CHECK)', format($q$update public.appointments set meet_at = started_at where id = %L$q$, :'appt'), '23514');
-- 미룬 시각을 다시 약속 10분 전으로 되감는다(시작 시각도 함께)
update public.appointments set meet_at = now() + interval '10 min', started_at = now() - interval '20 min',
  close_at = private.lb_close_at(now() + interval '10 min', stake, unit_minutes, penalty_per_unit, grace_minutes) where id = :'appt';

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
select t.ok('A arrives', (public.lb_report_location(:'appt', 37.4980, 127.0277, 20)->>'arrived')::boolean);
select t.ok('A second check-in = already', public.lb_report_location(:'appt', 37.4980, 127.0277, 20)->>'reason' = 'already_arrived');
select t.me('0b');
select t.ok('B low accuracy', public.lb_report_location(:'appt', 37.4979, 127.0276, 180)->>'reason' = 'low_accuracy');
reset role; select first_near_at as near from public.participants where user_id::text like '%0b' \gset
select t.ok('B first_near_at recorded', :'near' <> '');
set role authenticated; select t.me('0d');
select t.ok('D mocked', public.lb_report_location(:'appt', 37.4979, 127.0276, 10, true)->>'reason' = 'mocked');
select t.err('non-arrived cannot vouch', format($q$select public.lb_vouch(%L, '00000000-0000-0000-0000-00000000000b')$q$, :'appt'), 'LB_VOUCHER_NOT_ARRIVED');
reset role; select t.ok('still open (all not arrived)', (select status from public.appointments where id = :'appt') = 'open');

-- 9. 약속 12분 후. A 는 15분 전 도착으로, B 의 first_near 는 2분 전(=제시간)으로 되감는다(시작 시각은 그보다 앞으로)
update public.appointments set meet_at = now() - interval '12 min', started_at = now() - interval '42 min',
  close_at = private.lb_close_at(now() - interval '12 min', stake, unit_minutes, penalty_per_unit, grace_minutes) where id = :'appt';
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
update public.appointments set meet_at = now() - interval '1 second', close_at = now() + interval '74 minutes' where id = :'ap1';
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
reset role;
select t.ok('ledger meta.anon recorded', (select bool_and(meta ? 'anon') from public.ledger));
select t.ok('audit clean #2', (select count(*) from private.lb_audit()) = 0);
select * from private.lb_audit();
select t.ok('no settle errors', (select count(*) from private.lb_settle_errors) = 0);
