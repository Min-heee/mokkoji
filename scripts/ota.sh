#!/usr/bin/env bash
# 프로덕션 OTA 는 이 스크립트로만. EAS 환경변수에 Supabase URL 이 없으면 발행하지 않는다(가짜/꺼짐 번들 사고 방지).
set -euo pipefail
eas env:list --environment production | grep -q EXPO_PUBLIC_SUPABASE_URL || { echo "EXPO_PUBLIC_SUPABASE_URL 이 production 환경에 없습니다"; exit 1; }
eas update --environment production --channel production --message "${1:?메시지를 적어 주세요}"
