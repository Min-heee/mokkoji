#!/usr/bin/env bash
# 로컬 PostgreSQL 16 이 떠 있어야 한다(PGHOST/PGPORT/PGUSER 환경변수 사용, 접속 롤은 슈퍼유저). 매번 새 DB 를 만든다.
# 클러스터가 없으면: `bash scripts/local-pg.sh start && eval "$(bash scripts/local-pg.sh env)"` (127.0.0.1:54329, 슈퍼유저 postgres).
# 마이그레이션은 `set role postgres` 로 적용한다(Supabase 와 같은 소유자 → 기본 권한 회수가 실제로 검증된다).
set -euo pipefail
cd "$(dirname "$0")/.."
DB=lb_test_$$
createdb "$DB"; trap 'dropdb --if-exists "$DB"' EXIT
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/stub.sql
for f in supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$DB" -c 'set role postgres' -f "$f"; done
if [ "${1:-}" = "parity" ]; then
  # 불일치 벡터의 번호만 출력된다. SQL 오류(권한 등)도 한 줄로 잡혀 0 이 아니게 된다(거짓 통과 방지).
  bad=$( { echo "set role authenticated;"; npx tsx scripts/parity.ts; } | psql -q -At -v ON_ERROR_STOP=1 -d "$DB" 2>&1 | grep -vcE '^(SET|RESET)$' || true)
  echo "parity mismatches: $bad"; [ "$bad" = "0" ]
else
  out=$(psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/scenario.sql 2>&1) || true   # 오류가 나도 출력을 삼키지 않는다
  echo "$out" | grep -E '^(ok|FAIL)|ERROR' || true
  ! echo "$out" | grep -qE 'FAIL|ERROR'
fi
