# 엔빵 (nbbang)

모임·여행 정산 앱. 1차 카페 → 2차 밥 → 3차 술처럼 차수가 이어지고, 차수마다 결제한 사람이 다르고, 항목마다 먹은 사람이 달라도 최소 송금 횟수로 정산한다. 여행에서는 지출마다 통화가 달라도(현지 현금/카드) 원화로 환산해 한 번에 정산한다.

## 핵심 개념

- **모임(Session)** — 참가자 명단을 가진 정산 단위. 타입: 모임 🍻 / 여행 ✈️
- **지출(Round)** — 지출마다 결제자·참가자가 다를 수 있음. 정산 방식은 지출별로 선택:
  - `균등 n빵`: 총액만 입력하면 참가자끼리 균등 분배
  - `항목별`: 메뉴마다 단가·수량·먹은 사람을 지정 (술 안 마신 사람은 안주만 부담)
- **통화(currency)** — 지출별로 결제 통화 선택 (원/엔/달러/유로/위안/대만달러/바트/동/페소):
  - 현금 결제: 환율 직접 입력 (`1 JPY = 9.2원`), 통화별 마지막 환율은 자동 기억
  - 카드 결제: **실제 청구된 원화 금액** 입력 — 카드사 환율+수수료가 그대로 반영되며 환율보다 우선
  - 환율 미입력 지출은 정산에서 제외되고 결과 화면에 경고 표시
- **열외(exempt)** — 생일자 등 돈 안 내는 사람. 그 몫은 나머지가 균등 부담
- **정산** — 전부 원화로 환산 후 사람별 `결제액 − 부담액` 순채무를 계산, 송금 횟수를 최소화(인원−1 이하).
  송금액은 반올림 단위(1/10/100/1,000원)의 배수로 정리되고 자투리는 최대 채권자(주 결제자)가 흡수

## 스택

Expo SDK 54 · expo-router v6 · React Native 0.81 · TypeScript strict · AsyncStorage (로컬 우선, 서버 없음)

## 구조

```
app/                        # expo-router 화면
  index.tsx                 # 모임 목록
  session/new.tsx           # 새 모임
  session/[id]/index.tsx    # 모임 상세 (차수 목록)
  session/[id]/round/[roundId].tsx  # 차수 편집 (핵심 입력 화면)
  session/[id]/result.tsx   # 정산 결과 + 공유
src/
  domain/                   # 순수 정산 엔진 (UI 독립, 테스트 대상)
    types.ts settlement.ts shareText.ts format.ts
  state/SessionsContext.tsx # 세션 상태 + AsyncStorage 영속화
  storage/store.ts
  ui/                       # 테마 + 공용 컴포넌트
```

## 명령어

```bash
npm start          # Expo dev server
npm test           # 정산 엔진 테스트 (node:test + tsx)
npm run typecheck  # tsc --noEmit
```

## 로드맵 (MVP 이후)

- 정산 결과 공유 링크 (최소 서버: 결과 스냅샷 → 웹페이지)
- 영수증 사진 OCR → 항목 자동 입력
- 토스/카카오페이 송금 딥링크
- EAS 빌드 & 스토어 배포
