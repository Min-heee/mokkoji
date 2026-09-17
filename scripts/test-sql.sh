#!/usr/bin/env bash
# 로컬 PostgreSQL 16 이 떠 있어야 한다(PGHOST/PGPORT/PGUSER 환경변수 사용). 매번 새 DB 를 만든다.
set -euo pipefail
DB=lb_test_$$
createdb "$DB"; trap 'dropdb --if-exists "$DB"' EXIT
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/stub.sql
for f in supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"; done
if [ "${1:-}" = "parity" ]; then
  bad=$( { echo "set role authenticated;"; npx tsx scripts/parity.ts; } | psql -q -At -d "$DB" | grep -vc '^SET' || true)
  echo "parity mismatches: $bad"; [ "$bad" = "0" ]
else
  out=$(psql -q -d "$DB" -f supabase/tests/scenario.sql 2>&1)
  echo "$out" | grep -E '^(ok|FAIL)|ERROR' || true
  ! echo "$out" | grep -qE 'FAIL|ERROR'
fi
