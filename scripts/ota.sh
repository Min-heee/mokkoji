#!/usr/bin/env bash
# OTA 는 이 스크립트로만 발행한다.
#   npm run ota -- "메시지"        → production 채널 (EAS 환경 production)
#   npm run ota:beta -- "메시지"   → beta 채널 (EAS 환경 preview — beta 바이너리 = eas.json beta 프로필)
#
# 가드:
# - production: EAS production 환경의 EXPO_PUBLIC_LATEBET_MODE 로 가른다.
#     live        → EXPO_PUBLIC_SUPABASE_URL·EXPO_PUBLIC_SUPABASE_KEY 가 둘 다 있어야 발행.
#     off / 없음   → 약속 내기가 숨겨진 번들로 발행(Supabase 전에도 다른 수정을 내보낼 수 있게). 경고를 크게 찍는다 —
#                   약속 내기가 이미 production 에서 켜져 있다면 이 OTA 가 기능을 꺼 버린다.
#     fake / 그 외 → 거부(production 에서 가짜 서버는 어차피 modeRule 이 off 로 떨어뜨린다 — 헷갈리지 않게 막는다).
# - beta: preview 환경에 EXPO_PUBLIC_LATEBET_MODE(fake|live)가 있어야 한다. live 면 URL·KEY 도 있어야 한다.
#   (eas.json beta 프로필의 env 는 '빌드'에만 적용된다. OTA 번들의 env 는 --environment 로 고른 EAS 환경에서 온다.)
# - EXPO_NO_DOTENV=1: 로컬 .env.local(개발용 fake 등)이 OTA 번들에 섞이지 않게 한다.
# - --clear-cache: Metro 변환 캐시가 이전 export 의 EXPO_PUBLIC_* 값을 재사용하는 것을 확인했다
#   (P2 검증: env 를 바꿔 다시 export 해도 캐시를 안 비우면 같은 번들 해시·이전 Supabase URL 이 나왔다). 매번 비운다.
set -euo pipefail

target="production"
if [ "${1:-}" = "--beta" ]; then
  target="beta"
  shift
fi
message="${1:?메시지를 적어 주세요}"

if [ "$target" = "production" ]; then
  env_name="production"
  channel="production"
else
  env_name="preview"
  channel="beta"
fi

# eas 가 전역 설치돼 있지 않아도 돈다. 테스트에서는 EAS_BIN 으로 가짜 eas 를 꽂는다.
EAS_BIN="${EAS_BIN:-npx --yes eas-cli@latest}"
vars="$($EAS_BIN env:list --environment "$env_name" --include-sensitive 2>/dev/null || $EAS_BIN env:list --environment "$env_name")"
has() { printf '%s\n' "$vars" | grep -qE "(^|[[:space:]])$1="; }
mode="$(printf '%s\n' "$vars" | sed -nE 's/^[[:space:]]*EXPO_PUBLIC_LATEBET_MODE=//p' | head -1 | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"

need_keys() {
  has EXPO_PUBLIC_SUPABASE_URL || { echo "EXPO_PUBLIC_SUPABASE_URL 이 EAS $env_name 환경에 없습니다"; exit 1; }
  has EXPO_PUBLIC_SUPABASE_KEY || { echo "EXPO_PUBLIC_SUPABASE_KEY 가 EAS $env_name 환경에 없습니다"; exit 1; }
}

if [ "$target" = "production" ]; then
  case "$mode" in
    live) need_keys ;;
    off|"")
      echo "!!! 약속 내기 꺼진 번들로 발행합니다(EAS production EXPO_PUBLIC_LATEBET_MODE='${mode}')."
      echo "!!! 약속 내기가 이미 production 에서 켜져 있다면 이 OTA 가 기능을 끕니다 — 그렇다면 Ctrl+C 하고 MODE=live 로 맞추세요."
      mode="off"
      ;;
    *) echo "EAS production 환경의 EXPO_PUBLIC_LATEBET_MODE='${mode}' 는 production 에서 쓸 수 없습니다(live 또는 off)"; exit 1 ;;
  esac
else
  case "$mode" in
    live) need_keys ;;
    fake) ;;
    *) echo "EAS preview 환경에 EXPO_PUBLIC_LATEBET_MODE(fake|live)가 없습니다(현재: '${mode}') — beta 사용자에게서 기능이 사라집니다"; exit 1 ;;
  esac
fi

echo "OTA: 채널 $channel · EAS 환경 $env_name · 모드 $mode"
EXPO_NO_DOTENV=1 $EAS_BIN update --environment "$env_name" --channel "$channel" --clear-cache --message "$message"
