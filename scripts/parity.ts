// SQL↔TS 패리티 벡터 생성기. 출력은 psql 에 그대로 흘려보낸다(scripts/test-sql.sh parity). 불일치가 있으면 그 벡터 번호가 한 줄씩 나온다.
// 1) public.lb_settle_preview ↔ settleLateBet (authenticated 로 실행)
// 2) private.lb_close_at ↔ locationShareWindow(policy, deadline, startedAt).endMs — 체크인·위치 공개 마감(전액 몰수 + 30분 꼬리, 상한 180분).
//    공개 창 시작은 주최자의 [시작하기] 시각(startedAtMs)이라 정책과 무관하다(startMs = startedAtMs 인지도 여기서 같이 확인). private 라 슈퍼유저로 실행
import { locationShareWindow, settleLateBet, type LatePolicy } from '../src/domain/lateBet';
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const lines: string[] = [];
for (let i = 0; i < 3000; i++) {
  const policy: LatePolicy = { stake: rnd() < 0.1 ? 0 : ri(1, 500), radiusM: 100, unitMinutes: ri(1, 15), penaltyPerUnit: rnd() < 0.15 ? 0 : ri(1, 60), graceMinutes: ri(0, 5) };
  const deadline = 1790000000000 + ri(0, 1000) * 60000;
  const n = ri(1, 7);
  const ids = Array.from({ length: n }, (_, k) => `u${k}`);
  const arrivals = ids.map((id) => {
    const r = rnd();
    const arrivedAtMs = r < 0.2 ? null : r < 0.5 ? deadline - ri(0, 3) * 60000 - ri(0, 1) : r < 0.6 ? deadline + policy.graceMinutes * 60000 + ri(-1, 1) : deadline + ri(1, 200 * 60000);
    return { personId: id, arrivedAtMs };
  });
  const res = settleLateBet(policy, ids, arrivals, deadline);
  const expected = { voided: res.voided, voidReason: res.voidReason, pot: res.pot, persons: res.persons.map((p) => ({ id: p.personId, status: p.status, forfeited: p.forfeited, received: p.received, net: p.net })) };
  const arr = arrivals.map((a) => ({ id: a.personId, arrivedAtMs: a.arrivedAtMs }));
  lines.push(`select ${i} as i where public.lb_settle_preview('${JSON.stringify(policy)}'::jsonb, ${deadline}, '${JSON.stringify(arr)}'::jsonb) <> '${JSON.stringify(expected)}'::jsonb;`);
}
lines.push('reset role;');
for (let i = 0; i < 2000; i++) {
  // 서버 CHECK 범위 안의 정책만(DB 에 실제로 들어올 수 있는 값). 절벽 금지(전액까지 180분 이내)는 상한 절단이 같은지 보려고 일부러 넘기도 한다
  const policy: LatePolicy = { stake: rnd() < 0.1 ? 0 : ri(1, 300), radiusM: 100, unitMinutes: ri(1, 60), penaltyPerUnit: rnd() < 0.15 ? 0 : ri(1, 300), graceMinutes: ri(0, 30) };
  const deadline = 1790000000000 + ri(0, 1000) * 60000;
  const startedAt = deadline - ri(1, 6 * 60) * 60000;   // 시작은 약속 시각 전 어느 때든(서버 CHECK started_before_meet)
  const w = locationShareWindow(policy, deadline, startedAt);
  if (w === null || w.startMs !== startedAt) {           // 공개 창 시작 = 시작 시각. 어긋나면 SQL 을 거치지 않고 바로 불일치로 센다
    lines.push(`select 's${i}' as i;`);
    continue;
  }
  lines.push(`select 'w${i}' as i where private.lb_ms(private.lb_close_at(to_timestamp(${deadline / 1000}), ${policy.stake}, ${policy.unitMinutes}, ${policy.penaltyPerUnit}, ${policy.graceMinutes})) <> ${w.endMs};`);
}
console.log(lines.join('\n'));
