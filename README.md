# 엔빵 (nbbang)

모임 정산 앱. 1차 카페 → 2차 밥 → 3차 술처럼 차수가 이어지고, 차수마다 결제한 사람이 다르고, 항목마다 먹은 사람이 달라도 최소 송금 횟수로 정산한다.

## 핵심 개념

- **모임(Session)** — 참가자 명단을 가진 정산 단위
- **차수(Round)** — 차수마다 결제자·참가자가 다를 수 있음. 정산 방식은 차수별로 선택:
  - `균등 n빵`: 총액만 입력하면 참가자끼리 균등 분배
  - `항목별`: 메뉴마다 단가·수량·먹은 사람을 지정 (술 안 마신 사람은 안주만 부담)
- **열외(exempt)** — 생일자 등 돈 안 내는 사람. 그 몫은 나머지가 균등 부담
- **정산** — 사람별 `결제액 − 부담액` 순채무를 계산한 뒤 송금 횟수를 최소화(인원−1 이하).
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
