-- supabase/tests/scenario.sql — 로컬 PG16(stub.sql + 마이그레이션 적용 후)에서 실행. 출력에 FAIL 이 한 줄도 없어야 한다.
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

\set POL '{"stake":100,"radiusM":100,"unitMinutes":5,"penaltyPerUnit":10,"graceMinutes":0,"shareLocationMinutesBefore":60}'
set role authenticated;
-- 1. 프로필·가입 지급 1회
select t.me('0a'); select t.ok('grant 1000', (public.lb_ensure_profile('호스트')).balance = 1000);
select t.ok('no double grant', (public.lb_ensure_profile('호스트')).balance = 1000);
select t.me('0b'); select public.lb_ensure_profile('비') is not null;
select t.me('0c'); select public.lb_ensure_profile('씨') is not null;
select t.me('0d'); select public.lb_ensure_profile('디') is not null;
select t.me('0e'); select public.lb_ensure_profile('이') is not null;

-- 2. 생성: 동의·타임존 검사·절벽 정책
select t.me('0a');
select t.err('consent required', format($q$select public.lb_create_appointment('곱창', %L, 'Asia/Seoul', '강남역', '', 37.4979, 127.0276, %L, false)$q$, t.soon('3 hours'), :'POL'), 'LB_CONSENT_REQUIRED');
select t.err('tz suspect (방콕 핀 + 서울 tz)', format($q$select public.lb_create_appointment('여행', %L, 'Asia/Seoul', '방콕', '', 13.75, 100.5, %L, true)$q$, t.soon('3 hours'), :'POL'), 'LB_TZ_SUSPECT');
select t.ok('tz confirmed passes then cancel', (public.lb_create_appointment('여행', t.soon('3 hours'), 'Asia/Seoul', '방콕', '', 13.75, 100.5, :'POL', true, true)).stake = 100);
select public.lb_cancel((select id from public.appointments where title = '여행'));
select t.err('cliff policy', format($q$select public.lb_create_appointment('x', %L, 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"unitMinutes":5,"penaltyPerUnit":1}', true)$q$, t.soon('3 hours')), '23514');
select (public.lb_create_appointment('곱창', t.soon('3 hours'), 'Asia/Seoul', '강남역', '', 37.4979, 127.0276, :'POL', true)).id as appt \gset
select invite_code as code from public.appointments where id = :'appt' \gset
select t.ok('host hold 100', (select balance from public.profiles) = 900);

-- 3. 혼자일 때 정책 수정 = 재에스크로 + version+1. 옛 version 으로 참여하면 거부
select t.me('0b'); select (public.lb_peek_invite(:'code')->>'version')::int as v1 \gset
select t.ok('peek hides nicknames from non-member', public.lb_peek_invite(:'code')->'nicknames' = '[]'::jsonb and (public.lb_peek_invite(:'code')->>'memberCount')::int = 1);
select t.me('0a');
select t.ok('policy edit alone', (public.lb_update_appointment(:'appt', t.soon('3 hours'), 'Asia/Seoul', '강남역', 37.4979, 127.0276, '{"stake":200,"penaltyPerUnit":20,"shareLocationMinutesBefore":30}')).version = :v1 + 1);
select t.ok('re-escrow 200', (select balance from public.profiles) = 800);
select t.ok('share_start recomputed with new policy', (select meet_at - share_start_at = interval '30 minutes' from public.appointments where id = :'appt'));
select t.me('0b');
select t.err('stale version join', format('select public.lb_join(%L, %L, %s, true)', :'code', '비', :v1), 'LB_APPT_CHANGED');
select t.err('join needs consent', format('select public.lb_join(%L, %L, %s, false)', :'code', '비', :v1 + 1), 'LB_CONSENT_REQUIRED');
select t.ok('join active', public.lb_join(:'code', '비', :v1 + 1, true)->>'state' = 'active');
select t.ok('join idempotent', public.lb_join(:'code', '비', :v1 + 1, true)->>'state' = 'active');
select t.ok('B hold 200', (select balance from public.profiles) = 800);
select t.me('0a');
select t.err('edit locked with others', format($q$select public.lb_update_appointment(%L, %L, 'Asia/Seoul', '홍대', 37.55, 126.92, null)$q$, :'appt', t.soon('4 hours')), 'LB_EDIT_LOCKED');
select public.lb_update_memo(:'appt', '금요일 곱창', '2층');
select t.ok('memo edit keeps version', (select version from public.appointments where id = :'appt') = :v1 + 1);

-- 4. 닉네임 위장, 나가기·재참여, 강퇴+차단
select t.me('0c');
select t.err('zero-width nickname clash', format('select public.lb_join(%L, %L, %s, true)', :'code', U&'\200B비 ', :v1 + 1), 'LB_NICKNAME_TAKEN');
select t.ok('C joins', public.lb_join(:'code', '씨', :v1 + 1, true)->>'state' = 'active');
select public.lb_leave(:'appt'); select t.ok('leave refund', (select balance from public.profiles) = 1000);
select t.ok('C rejoins', public.lb_join(:'code', '씨', :v1 + 1, true)->>'state' = 'active');
select t.me('0a'); select public.lb_kick(:'appt', '00000000-0000-0000-0000-00000000000c', true);
select t.me('0c'); select t.ok('kick refund', (select balance from public.profiles) = 1000);
select t.err('banned cannot rejoin', format('select public.lb_join(%L, %L, %s, true)', :'code', '씨2', :v1 + 1), 'LB_INVITE_NOT_FOUND');
select t.err('banned cannot peek', format('select public.lb_peek_invite(%L)', :'code'), 'LB_INVITE_NOT_FOUND');

-- 5. 권한: 외부인·직접 쓰기·anon
select t.me('0e');
select t.ok('outsider sees no appointments', (select count(*) from public.appointments) = 0);
select t.ok('outsider sees no participants', (select count(*) from public.participants) = 0);
select t.err('outsider get_live', format('select public.lb_get_live(%L)', :'appt'), 'LB_NOT_MEMBER');
select t.err('locations select denied', 'select count(*) from public.locations', '42501');
select t.err('direct update denied', 'update public.profiles set balance = 999999', '42501');
select t.err('direct insert denied', $q$insert into public.ledger(user_id,kind,amount,balance_after) values ('00000000-0000-0000-0000-00000000000e','grant',5,5)$q$, '42501');
select t.err('direct delete denied', 'delete from public.participants', '42501');
select t.err('truncate denied', 'truncate public.ledger', '42501');
select t.err('private fn denied', $q$select private.lb_post('00000000-0000-0000-0000-00000000000e', null, 'grant', 5)$q$, '42501');
select t.err('private table denied', 'select * from private.lb_share_log', '42501');
reset role; set role anon;
select t.ok('anon ping ok', public.lb_ping() ? 'serverNowMs');
select t.err('anon rpc denied', $q$select public.lb_ensure_profile('x')$q$, '42501');
select t.err('anon table denied', 'select count(*) from public.appointments', '42501');
reset role;
select t.err('ledger immutable even for owner', 'delete from public.ledger', 'LB_LEDGER_IMMUTABLE');

-- 6. 시간 여행: 약속 10분 전(공개 창 안 = 잠김)
update public.appointments set meet_at = now() + interval '10 min', share_start_at = now() - interval '20 min',
  close_at = private.lb_close_at(now() + interval '10 min', stake, unit_minutes, penalty_per_unit, grace_minutes) where id = :'appt';
set role authenticated;
select t.me('0d');
select t.ok('post-lock join = pending, no hold', public.lb_join(:'code', '디', :v1 + 1, true)->>'state' = 'pending' and (select balance from public.profiles) = 1000);
select t.me('0b'); select public.lb_report_location(:'appt', 37.5100, 127.0400, 15, false, true)->>'reason' as r \gset
select t.ok('B outside stored', :'r' = 'outside');
select t.me('0d');
select t.ok('pending sees only self, no locations', (select jsonb_array_length(j->'participants') = 1 and j->'participants'->0->'location' = 'null'::jsonb and j->'appointment'->'inviteCode' = 'null'::jsonb from (select public.lb_get_live(:'appt') j) x));
select t.ok('pending report rejected', public.lb_report_location(:'appt', 37.4979, 127.0276, 10)->>'reason' = 'pending');
select t.me('0a');
select t.ok('host sees B location', (select count(*) from jsonb_array_elements(public.lb_get_live(:'appt')->'participants') e where e->'location' <> 'null'::jsonb) = 1);
select public.lb_approve(:'appt', '00000000-0000-0000-0000-00000000000d');
select t.err('no kick of active after lock', format($q$select public.lb_kick(%L, '00000000-0000-0000-0000-00000000000d')$q$, :'appt'), 'LB_KICK_CLOSED');
select t.err('no cancel after lock with others', format('select public.lb_cancel(%L)', :'appt'), 'LB_CANCEL_CLOSED');
select t.me('0d'); select t.ok('approved = hold 200', (select balance from public.profiles) = 800);
select t.err('no leave after lock', format('select public.lb_leave(%L)', :'appt'), 'LB_LEAVE_CLOSED');
select t.ok('share log written', true);
reset role;
select t.ok('share log has (viewer a -> subject b)', exists (select 1 from private.lb_share_log where viewer_id::text like '%0a' and subject_id::text like '%0b'));

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

-- 9. 약속 12분 후. A 는 15분 전 도착으로, B 의 first_near 는 2분 전(=제시간)으로 되감는다
update public.appointments set meet_at = now() - interval '12 min', share_start_at = now() - interval '42 min',
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
reset role;
select private.lb_settle(:'appt');  -- 재실행: no-op
select t.ok('payouts: A 300, B 300, D 0', (select array_agg(amount order by user_id) from public.ledger where kind = 'payout' and appointment_id = :'appt') = array[300,300,0]);
select t.ok('balances A1100 B1100 D800', (select array_agg(balance order by user_id) from public.profiles where user_id::text ~ '0[abd]$') = array[1100,1100,800]);
select t.ok('locations wiped', (select count(*) from public.locations) = 0);
select t.ok('audit clean #1', (select count(*) from private.lb_audit()) = 0);

-- 10. 전원 도착이어도 마감 전에는 정산하지 않는다 / 마감 뒤 마지막 도착이 정산을 부른다 / stake 0→300→0
set role authenticated; select t.me('0e');
select (public.lb_create_appointment('번개', t.soon('40 minutes'), 'Asia/Seoul', '강남역', '', 37.4979, 127.0276, '{"stake":0,"shareLocationMinutesBefore":60}', true)).id as ap2 \gset
select t.ok('stake 0 -> 300 alone even after lock', (public.lb_update_appointment(:'ap2', t.soon('40 minutes'), 'Asia/Seoul', '강남역', 37.4979, 127.0276, '{"stake":300,"penaltyPerUnit":300,"unitMinutes":1}')).stake = 300);
select t.ok('E hold 300', (select balance from public.profiles) = 700);
select t.ok('E arrives early', (public.lb_report_location(:'ap2', 37.4979, 127.0276, 10)->>'arrived')::boolean);
reset role; select t.ok('no early settle before meet_at', (select status from public.appointments where id = :'ap2') = 'open');
update public.appointments set meet_at = now() - interval '1 second', close_at = now() - interval '1 second' where id = :'ap2';
set role authenticated; select t.me('0e'); select public.lb_get_live(:'ap2') is not null;
select t.ok('alone on time: settled, stake back', (select balance from public.profiles) = 1000);
select (public.lb_create_appointment('혼자', t.soon('3 hours'), 'Asia/Seoul', '강남역', '', 37.4979, 127.0276, '{"stake":300,"penaltyPerUnit":10}', true)).id as ap3 \gset
select t.ok('300 -> 0', (public.lb_update_appointment(:'ap3', t.soon('3 hours'), 'Asia/Seoul', '강남역', 37.4979, 127.0276, '{"stake":0}')).stake = 0);
select t.ok('300 -> 0 refunds', (select balance from public.profiles) = 1000);
select public.lb_cancel(:'ap3');

-- 11. 즉시 잠기는 약속: 주최자는 승인한 사람을 내보낼 수 없다(판 엎기 방지). 거절은 가능.
select (public.lb_create_appointment('당일', t.soon('30 minutes'), 'Asia/Seoul', '강남역', '', 37.4979, 127.0276, :'POL', true)) as ap4row \gset
select id as ap4, invite_code as code4 from public.appointments where title = '당일' \gset
select t.me('0b'); select t.ok('instant-lock join = pending', public.lb_join(:'code4', '비', 1, true)->>'state' = 'pending');
select t.me('0c'); select t.ok('C pending too', public.lb_join(:'code4', '씨', 1, true)->>'state' = 'pending');
select t.me('0e'); select public.lb_approve(:'ap4', '00000000-0000-0000-0000-00000000000b');
select public.lb_kick(:'ap4', '00000000-0000-0000-0000-00000000000c', false);   -- 거절(차단 없이)
select t.err('host cannot kick approved member', format($q$select public.lb_kick(%L, '00000000-0000-0000-0000-00000000000b')$q$, :'ap4'), 'LB_KICK_CLOSED');
select t.err('host cannot cancel', format('select public.lb_cancel(%L)', :'ap4'), 'LB_CANCEL_CLOSED');
select public.lb_set_join_closed(:'ap4', true);
select t.me('0c'); select t.err('join closed', format('select public.lb_join(%L, %L, 1, true)', :'code4', '씨'), 'LB_JOIN_CLOSED');

-- 12. 부족분 채워주기: F 는 1000 → 300짜리 약속 4개를 만들면 4번째에서 잔액 100 < 300, 가진 것(100+900)=1000 이라 거부
select t.me('0f'); select public.lb_ensure_profile('에프') is not null;
select public.lb_create_appointment('f1', t.soon('5 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', true) is not null;
select public.lb_create_appointment('f2', t.soon('5 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', true) is not null;
select public.lb_create_appointment('f3', t.soon('5 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', true) is not null;
select t.err('wealth >= 1000: no top-up', format($q$select public.lb_create_appointment('f4', %L, 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', true)$q$, t.soon('5 hours')), 'LB_INSUFFICIENT_POINTS');
-- D 는 800. 300짜리 3개(잔액 -100 불가) → 세 번째에서 가진 것 200+600=800 < 1000 이라 100 채워 준다
select t.me('0d');
select public.lb_create_appointment('d1', t.soon('5 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', true) is not null;
select public.lb_create_appointment('d2', t.soon('5 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', true) is not null;
select public.lb_create_appointment('d3', t.soon('5 hours'), 'Asia/Seoul', 'p', '', 37.5, 127.0, '{"stake":300,"penaltyPerUnit":10}', true) is not null;
select t.ok('top-up of 100 then hold', (select balance from public.profiles) = 0 and (select amount from public.ledger where kind = 'relief') = 100);
reset role;
select t.ok('ledger meta.anon recorded', (select bool_and(meta ? 'anon') from public.ledger));
select t.ok('audit clean #2', (select count(*) from private.lb_audit()) = 0);
select * from private.lb_audit();
select t.ok('no settle errors', (select count(*) from private.lb_settle_errors) = 0);
