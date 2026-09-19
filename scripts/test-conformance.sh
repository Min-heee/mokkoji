#!/usr/bin/env bash
# Conformance: 같은 시나리오를 fakeApi 와 (로컬 PG + supabaseApi) 에 돌려 결과를 대조한다. npm test 에는 넣지 않는다(PG 필요).
# 로컬 PostgreSQL 16 이 떠 있어야 한다(PGHOST/PGPORT/PGUSER, 슈퍼유저). 없으면:
#   bash scripts/local-pg.sh start && eval "$(bash scripts/local-pg.sh env)"
# 매번 새 DB 를 만들고(stub.sql + 마이그레이션, test-sql.sh 와 같은 방식) 끝나면 지운다.
set -euo pipefail
cd "$(dirname "$0")/.."
DB=lb_conf_$$
createdb "$DB"; trap 'dropdb --if-exists "$DB"' EXIT
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/stub.sql
for f in supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$DB" -c 'set role postgres' -f "$f"; done
PGDATABASE="$DB" npx tsx scripts/conformance/main.ts
