import { settleLateBet } from '../src/domain/lateBet';
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const lines: string[] = [];
for (let i = 0; i < 3000; i++) {
  const policy = { stake: rnd() < 0.1 ? 0 : ri(1, 500), radiusM: 100, unitMinutes: ri(1, 15), penaltyPerUnit: rnd() < 0.15 ? 0 : ri(1, 60), graceMinutes: ri(0, 5), shareLocationMinutesBefore: 60 };
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
console.log(lines.join('\n'));
