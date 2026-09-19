/**
 * Conformance 러너: 시나리오 전부를 fakeApi ↔ (로컬 PG + supabaseApi) 로 돌리고 차이를 표로 낸다.
 * 실행: `npm run test:conformance` (scripts/test-conformance.sh 가 새 DB 를 만들어 PGDATABASE 로 넘긴다).
 * CONF_VERBOSE=1 이면 걸음마다 한 줄, =2 면 정규화된 두 결과까지. CONF_ONLY=S1 처럼 시나리오 접두어로 거를 수 있다.
 * 마지막 줄: `conformance mismatches: N (steps M)` — N 이 0 이 아니면 종료 코드 1.
 */
import { Duo, type StepRecord } from './duo';
import { short } from './normalize';
import { PgHarness } from './pgBackend';
import { SCENARIOS } from './scenarios';

async function main(): Promise<number> {
  const pg = new PgHarness();
  await pg.init();
  const all: StepRecord[] = [];
  const only = process.env.CONF_ONLY;
  try {
    let no = 0;
    for (const [name, run] of SCENARIOS) {
      no += 1;
      if (only && !name.startsWith(only)) continue;
      const duo = new Duo(name, no, pg);
      try {
        await run(duo);
      } catch (e) {
        duo.records.push({
          scenario: name,
          step: '(시나리오 중단)',
          mismatches: [{ path: 'exception', fake: '-', sql: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) }],
          fake: null,
          sql: null,
        });
      }
      const bad = duo.records.filter((r) => r.mismatches.length > 0).length;
      console.log(`${name}: 걸음 ${duo.records.length}, 차이 있는 걸음 ${bad}`);
      all.push(...duo.records);
    }
  } finally {
    await pg.end();
  }
  const rows = all.flatMap((r) => r.mismatches.map((m) => ({ r, m })));
  if (rows.length > 0) {
    console.log('\n| 시나리오 | 걸음 | 경로 | fakeApi | SQL |');
    console.log('|---|---|---|---|---|');
    for (const { r, m } of rows) {
      console.log(`| ${r.scenario} | ${r.step} | \`${m.path}\` | ${short(m.fake).replace(/\|/g, '\\|')} | ${short(m.sql).replace(/\|/g, '\\|')} |`);
    }
  }
  console.log(`conformance mismatches: ${rows.length} (steps ${all.length})`);
  return rows.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(2);
  },
);
