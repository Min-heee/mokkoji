#!/usr/bin/env bash
# 로컬 PostgreSQL 16 테스트 클러스터(약속 내기 SQL 검증용). Supabase 프로젝트 없이 `npm run test:sql` / `npm run test:parity` 를 돌리기 위한 것.
# 쓰임:
#   bash scripts/local-pg.sh start   # 없으면 initdb, 꺼져 있으면 켠다(이미 켜져 있으면 아무것도 안 함)
#   bash scripts/local-pg.sh stop    # 끈다
#   bash scripts/local-pg.sh status
#   eval "$(bash scripts/local-pg.sh env)"   # PGHOST/PGPORT/PGUSER 를 현재 셸에 export
# 기본값: 데이터 디렉터리 $LB_PG_DIR(기본 ${TMPDIR:-/tmp}/lb-pg)/data, 포트 $LB_PG_PORT(기본 54329), 127.0.0.1 TCP 전용,
#   슈퍼유저 postgres, trust 인증(로컬 전용 — 절대 외부에 열지 말 것). 유닉스 소켓은 끈다(경로가 길면 104바이트 제한에 걸린다).
# 기존 시스템 PostgreSQL(기본 5432, Homebrew 서비스)은 건드리지 않는다.
set -euo pipefail
DIR="${LB_PG_DIR:-${TMPDIR:-/tmp}/lb-pg}"
DIR="${DIR%/}"
PORT="${LB_PG_PORT:-54329}"
DATA="$DIR/data"
# macOS: postmaster 가 로케일을 못 찾으면 '멀티쓰레드 환경' 치명적 오류로 죽는다 → 로케일을 명시한다
export LC_ALL="${LC_ALL:-en_US.UTF-8}" LANG="${LANG:-en_US.UTF-8}"

case "${1:-}" in
  start)
    mkdir -p "$DIR"
    if [ ! -f "$DATA/PG_VERSION" ]; then
      initdb -D "$DATA" -U postgres --auth=trust -E UTF8 --locale=en_US.UTF-8 >/dev/null
    fi
    if pg_isready -q -h 127.0.0.1 -p "$PORT"; then echo "already running on 127.0.0.1:$PORT"; exit 0; fi
    pg_ctl -D "$DATA" -w -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" -l "$DIR/pg.log" start >/dev/null
    echo "started on 127.0.0.1:$PORT (data $DATA, log $DIR/pg.log)"
    ;;
  stop)
    if [ -f "$DATA/postmaster.pid" ]; then pg_ctl -D "$DATA" -w -m fast stop >/dev/null; echo stopped; else echo "not running"; fi
    ;;
  status)
    pg_isready -h 127.0.0.1 -p "$PORT"
    ;;
  env)
    echo "export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres"
    ;;
  *)
    echo "usage: $0 start|stop|status|env" >&2; exit 2
    ;;
esac
