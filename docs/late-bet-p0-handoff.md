# 약속 내기 P0 — 진행 메모 (2026-09-18 2차 갱신)
설계서: `docs/appointment-bet-design.md`. 이 파일은 P0 구현 워크플로의 인수인계 메모다. **설계서 §0-1(오너 확정 흐름 2026-09-18 — 주최자 [시작하기] 모델)이 본문보다 우선한다** — 아래 계약서는 그 흐름을 반영한 판이다.
## 상태
- **2026-09-18 [통합] P0 화면 5묶음 + SQL + 통합 완료.** 게이트 `npm run typecheck` 오류 0 · `npm test` 393개 통과. `npx expo export --platform web`·`--platform ios` 둘 다 성공. 커밋 없음(브랜치 `feat/late-bet-p0`).
  - 흐름 연결(코드 리딩): 홈 [약속 잡기] → `/late/new`(InviteeEditor·`/late/place` 핀 왕복) → 생성 → `/late/<id>?invite=1`(대기실, 네이티브는 공유 시트 1회) → FakeDevPanel '봇 한 명 수락' → 주최자 [시작하기](`api.start`) → LiveView(위치 공개) → '시작 후 봇 수락' → 시간 이동 → 도착 → ArrivedView → 정산 → ResultView → [정산 시작] → `/session/<id>`. 초대: 홈 '코드 입력' → `/j` → `/j/<code>`(이름 고르기·동의) → `/late/<id>`. 주최자 수정: 대기실·LiveView [약속 수정]/[장소 바꾸기] → `/late/new?edit=<id>`(시작 전 전부 / 시작 후 미루기·장소만) → 변경 배너(version). 시작 없이 약속 시각 → notStarted 무효(홈 `refresh()`·`getLive`·위치 보고 모두에서 게으르게).
  - 통합 때 고친 것: (1) `app/late/[id]/index.tsx` 취소 문구를 `resultModel.canceledText` 한 곳으로. (2) `fakeApi` 를 SQL 에 맞춤 — 시작 없이 약속 시각이 지난 약속은 `edit`·`editInvitees` → `LB_EDIT_CLOSED`, `reportLocation` → 게으른 무효 뒤 `closed`, `settlePending` 에 `(미시작 ∧ now ≥ meetAt)` 포함(+테스트 1개). (3) `app/late/new.tsx` 생성 성공 시 `?invite=1` 로 이동(WaitingView 의 자동 공유 시트가 실제로 열리게). (4) `.env.local` 에 `EXPO_PUBLIC_LATEBET_MODE=fake`(gitignore `.env*.local` 확인).
  - 낡은 잔재 grep(`rosterComplete|lockedAt|isLocked|shareLocationMinutesBefore|shareStartMs|share_minutes_before|share_start_at|roster_complete_at|PendingView|approve`): 코드에서 0건(남은 것은 "없다"고 적은 주석·이 문서의 이력·scenario.sql 의 '보내도 무시' 단언뿐). `app/late/zz-*-harness.tsx` 삭제됨.
  - mode off: `app/index.tsx` 의 off 분기 JSX 는 merge-base(15a0c4f) 원본과 동일(`sessionList` 로 뽑았을 뿐), `LateBetProvider` 는 off 면 children 만 돌려준다. `_layout.tsx` 의 late/j 라우트 등록은 off 에서도 남지만 화면은 `LateBetUnavailable` 이라 홈에서 닿는 길이 없다.
  - 남은 문제 / 안 한 것: 로컬 PG 없음 → `test:sql`·`test:parity` 미실행(SQL 은 정적 검사만). live 모드 `supabaseApi` 는 P2(자리표시자 `LB_NOT_CONFIGURED`). `?from=<id>` 프리필은 구현돼 있으나 누르는 곳이 없다(시작 전 수정이 생겨 '취소하고 새로 만들기' 흐름이 필요 없어짐). `LocationPrimerProps.started` 없음(문구는 시제 중립). 햅틱·네이티브 지도 검색은 P1. 설계서 §3·§5 본문(잠금 모델 서술)은 손대지 않았다 — §0-1 과 이 문서가 기준.
- 2026-09-18 [rules-client] 2차: '전원 참여 시 자동 잠금(rosterCompleteAt/lockedAt)' 모델을 **주최자 [시작하기](startedAtMs) 모델**로 바꿨다(설계서 §0-1 교체). 도메인·타입·API·errors·fakeApi·useLive·homeModel·changes·FakeDevPanel·컨테이너·props 반영.
  - 게이트: `npm test` 387개 통과. typecheck 는 [rules-client] 소유 파일 오류 0(InviteeEditor.tsx 의 문법 오류가 tsc 전체의 의미 검사를 막으므로, TS API 로 그 파일만 빼고 돌려 확인했다). 남은 오류는 옛 계약을 쓰는 남의 파일뿐: `WaitingView.tsx`([waiting]) `isLocked`·`shareStartMs`·`shareLocationMinutesBefore`, `LiveView.tsx`([live]) `isLocked`·`shareStartMs`·`ReportReasonContext.shareStartMs`, `ArrivedView.tsx`([live]) `isLocked`, `LocationPrimer.tsx`([join]) `shareMinutesBefore`, `app/j/[code].tsx`([join]) `lockedAtMs`·`shareStartMs`·`locked`·`describePolicy().share`·`shareLocationMinutesBefore`, `app/index.tsx`([result]) `HomeBadge 'today'` 비교, `src/lateBet/resultModel.test.ts`([result]) `shareStartMs` 리터럴, `scripts/parity.ts`([rules-sql]) `locationShareWindow` 시그니처(→ `closeAtMs(policy, deadline)` 로 바꾸면 된다).
  - 삭제한 것: `LatePolicy.shareLocationMinutesBefore`, `SHARE_BEFORE_CHOICES`, `POLICY_LIMITS.shareLocationMinutesBefore`, `describePolicy().share`/`.shareStartMs`, `latePhase.lateTimes`·`sharesImmediately`·`isLocked`, phase `locked`, `LbAppointment.shareStartMs`·`rosterCompleteAtMs`·`lockedAtMs`, `LbInvitePreview.shareStartMs`·`lockedAtMs`, `LbMyAppointment.shareStartMs`·`lockedAtMs`, `LbJoinResult.locked`, `FakeBotInfo.locked`, `FakeServer.fillRoster`, `FAKE_DEMO_CODES.locked`·`lastSlot`, `ReportReasonContext.shareStartMs`, `LateNotificationTarget.shareStartMs`, `LocationPrimerProps.shareMinutesBefore`, `HomeBadge 'today'`, FakeDevPanel 의 '공개 시작으로'·'마지막 봇 들어오게(잠금)'.
  - 추가한 것: `lateBet.closeAtMs`, `locationShareWindow(policy, deadline, startedAtMs) → {startMs,endMs} | null`, `isLocationShared(policy, deadline, startedAtMs, now, hasArrived)`, `latePhase.isStarted`·`lateCloseMs`, `LbAppointment.startedAtMs`(+Preview·MyAppointment), `LbJoinResult.started`, `LbVoidReason 'notStarted'`, `LbLedgerReason 'notStarted'`, `api.start()`, `LB_START_CLOSED`·`LB_ALREADY_STARTED`·`LB_NOT_STARTED`, `FakeServer.start`, `FAKE_DEMO_CODES.full`·`started`, `HomeBadge 'inProgress'`, FakeDevPanel '시작 후 봇 수락'.
- 2026-09-18 [rules-client] 1차(일부 폐기): 오너 결정 변경 3건(수락제 폐지 → 초대 명단, 잠금 전후 변경 규칙, 전액 몰수 뒤 30분 꼬리)을 토대에 반영했다. 이 중 '잠금 = 전원 참여'는 2차에서 [시작하기] 모델로 대체됐다.
  - 게이트: `npm test` 361개 통과(348 + 13). `npm run typecheck` 는 [rules-client] 소유 파일 오류 0. 남은 오류는 옛 계약(pending·approve·join·needsApproval·joinClosed·`isLocked(a, now)`·`APPROVE_INSUFFICIENT_MESSAGE`)을 쓰는 화면 파일뿐이다: `src/lateBet/screens/WaitingView.tsx`([waiting]), `src/lateBet/screens/LiveView.tsx`([live]), `app/late/zz-live-harness.tsx`([live], 삭제 예정), `app/j/[code].tsx`([join]).
  - 삭제: `src/lateBet/screens/PendingView.tsx`. 거기 있던 공유 조각(`ConditionCard`·`FromNowPill`·`openExternal`)은 **`src/lateBet/screens/ConditionCard.tsx`** 로 그대로 옮겼다 — `WaitingView` 의 `import { ConditionCard } from './PendingView'` 를 `'./ConditionCard'` 로 바꾸면 된다.
  - 새 파일: `src/lateBet/changes.ts`(+test, 변경 배너 문구), `src/lateBet/screens/InviteeEditor.tsx`(골격), `src/lateBet/screens/ConditionCard.tsx`.
  - 소유 밖 최소 수정 2건(보고): `src/domain/latePresets.ts`(+test) 의 `describePolicy.close` 문장 — 마감이 전액 시각과 분리돼 "오후 8:45에 체크인이 닫혀요. 그 뒤에 와도 도착으로 남지 않아요." 로; `src/lateBet/homeModel.ts` 의 `pending` 배지·`pendingCount` → `gathering`(모이는 중)·`unclaimedCount`, `homePendingLine` → `homeUnclaimedLine`.
- 완료(9/17): P0-a 도메인 모듈 6개, Supabase SQL·테스트·스크립트 이식, Foundation(mode·api·fakeApi·Context·useLive·화면 골격)
- ~~미완: 화면 5묶음~~ → 9/18 [create]·[join]·[waiting]·[live]·[result]·[rules-sql] 완료, 위 [통합] 항목 참고. 각 담당이 fake 모드 웹 프리뷰 실클릭까지 확인했다(create·join·result). 안 한 것: 적대적 리뷰, 실기기.

---

## P0-a 도메인 모듈 보고

부록 A~E 파일은 모두 만들었지만 `test:sql`·`test:parity`는 돌리지 못했습니다. 이 머신에 PostgreSQL이 떠 있지 않았고, 지시대로 기동하지 않았습니다. 따라서 시나리오 FAIL 0줄·패리티 불일치 0은 이번에 확인되지 않았습니다. `npm run typecheck`와 `npm test`(214개)는 통과했습니다.

## 만든 파일 (리포 `/Users/byungheemin/.openclaw/workspace/nbbang`)
- `supabase/migrations/20260918000000_late_bet.sql` (873줄, 부록 A)
- `supabase/tests/stub.sql` (13줄, 부록 B)
- `supabase/tests/scenario.sql` (211줄, 부록 C)
- `scripts/parity.ts`, `scripts/test-sql.sh`, `scripts/ota.sh` (부록 D, 셸 두 개는 실행 권한 부여)
- `.github/workflows/keepalive.yml` (부록 E)
- `supabase/config.toml` (새로 작성): `project_id = "jeongsan-yaho"`, `[api] schemas = ["public"]`, `[auth] enable_anonymous_sign_ins = true`
- `package.json`: scripts에 `test:sql`, `test:parity`, `ota` 3줄만 추가

부록 A~E는 손으로 옮기지 않고 설계서 코드펜스 안쪽을 `sed -n`으로 뽑았습니다. 뽑은 뒤 7개 파일 모두 설계서 해당 구간과 `diff`로 동일함을 확인했습니다. `lb_clean_nick` 정규식의 보이지 않는 문자(U+00AD, U+200B–200F, U+2028–202F, U+2060–2064, U+FEFF)도 그대로 들어 있습니다. SQL·스크립트는 고친 곳이 없습니다. git commit/push는 하지 않았고 다른 담당의 파일은 건드리지 않았습니다.

## 실행한 검증
- **PG 상태:** `psql`·`createdb`는 16.14(Homebrew)로 설치돼 있습니다. `pg_isready`는 `/tmp:5432 - 응답 없음`이고, postgres 프로세스·소켓·리슨 포트가 없습니다. 데이터 디렉터리(`/opt/homebrew/var/postgresql@16`)에는 `postmaster.pid`·`postmaster.opts`가 없습니다.
- **패리티 벡터 생성:** `npx tsx scripts/parity.ts`는 3,000줄을 내고, 두 번 실행한 결과의 md5가 같았습니다. voided는 883건(noStake 286 / noWinner 597)이고 `voidReason` 키는 3,000건 모두에 있습니다. SQL 쪽과의 비교는 PG가 없어 못 했습니다.
- **문법:** `bash -n`으로 `scripts/test-sql.sh`·`scripts/ota.sh` 통과, keepalive YAML 파싱 통과, `package.json` JSON 파싱 통과. `supabase/config.toml`은 이 머신의 python에 tomllib이 없어 파싱 확인을 못 했습니다(키 3개뿐).
- **SQL을 읽어서 확인한 것:**
  - 마이그레이션이 던지는 `LB_*` 31종은 내부용 2종(`LB_INVARIANT_ESCROW_NONZERO`, `LB_LEDGER_IMMUTABLE`)을 빼면 모두 §5.5에 있습니다.
  - 시나리오 단언은 `t.ok` 60개와 `t.err` 28개로 88개이고, 설계서의 "ok 88줄"과 맞습니다.
  - 시나리오 1~12의 잔액·정산 수치를 손으로 따라가 본 결과 마이그레이션 로직과 어긋나는 곳은 없었습니다.

## 발견한 문제 (전부 고치지 않고 보고만)
1. **`postgres` 롤 전제.** `stub.sql`과 마이그레이션 0절이 `alter default privileges for role postgres …`를 씁니다. Homebrew 기본 클러스터의 슈퍼유저는 보통 macOS 계정명이어서 `postgres` 롤이 없을 가능성이 큽니다(미확인). 없으면 `stub.sql` 첫 실행에서 오류가 납니다. 롤이 있어도 다른 슈퍼유저로 돌리면 기본 권한 문장이 실제 생성 객체에 적용되지 않아 하드닝이 검증되지 않은 채 통과합니다. `PGUSER=postgres` 슈퍼유저로 돌려야 합니다.
2. **`test-sql.sh`가 오류를 삼킴.** `scenario.sql`에서 SQL 오류가 나면 `set -e` 때문에 `out=$(psql …)` 줄에서 스크립트가 바로 끝납니다. ERROR 줄이 출력되지 않고 종료 코드만 비정상입니다.
3. **패리티 모드 거짓 통과 가능.** 오류 시 중단 옵션이 없고 stderr를 세지 않습니다. `lb_settle_preview`가 권한 등으로 전부 ERROR여도 `parity mismatches: 0`으로 통과합니다.
4. **`ota.sh`의 `pipefail` + `grep -q`.** `eas env:list` 출력이 크면 SIGPIPE/EPIPE로 "환경변수가 없습니다"가 잘못 뜰 수 있습니다. 설계서도 `eas env:list` 출력 형식은 확인 필요로 남겨 뒀습니다.
5. **`supabase/config.toml`에 `[db] major_version`을 넣지 않았습니다.** 원격 PG 버전을 모르기 때문이고, `supabase link` 때 CLI가 경고하면 그때 맞추면 됩니다.

문서와 테스트의 불일치나 SQL 오탈자는 찾지 못했습니다.

---

## P0-a SQL 이식 보고

설계서 §5.1의 도메인 모듈 6개와 각 테스트를 만들었고, 게이트(`npm run typecheck && npm test`)가 통과합니다. typecheck는 오류 0이고 `npm test`는 314개 전부 통과, 실패 0입니다. 새 테스트는 100개이고 기존 214개는 그대로 통과합니다.

기존 `lateBet.ts`, `geo.ts`, `appointment.ts`는 재사용만 하고 고치지 않았습니다. 새 의존성·커밋은 없고, [domain] 소유 파일 외에는 만들거나 고치지 않았습니다. 여섯 모듈 모두 순수 함수이며 `Date.now()`나 기기 타임존에 기대지 않습니다.

## 만든 파일 (전부 `/Users/byungheemin/.openclaw/workspace/nbbang/src/domain/` 아래)

| 파일 | 새 테스트 |
|---|---|
| `latePhase.ts` + `latePhase.test.ts` | 19 |
| `latePresets.ts` + `latePresets.test.ts` | 23 |
| `invite.ts` + `invite.test.ts` | 19 |
| `mapRoute.ts` + `mapRoute.test.ts` | 5 |
| `tzGuard.ts` + `tzGuard.test.ts` | 27 |
| `toSession.ts` + `toSession.test.ts` | 7 |

## export 목록

**`latePhase.ts`** (9/18 2차 개정 — [시작하기] 모델) — foundation이 DTO를 맞춰야 하는 구조 타입이 여기 있습니다. `lb_get_live` 페이로드의 부분집합이며, 필드가 더 있어도 됩니다.
- 타입:
  - `LateAppointmentStatus` = `'open' | 'settled' | 'voided' | 'canceled'`
  - `LateMemberState` = `'active'` (수락제 폐지 — pending 없음. 구조 호환용으로 필드는 남김)
  - `LatePhaseAppointment` = `{ status, meetAtMs, startedAtMs: number | null, closeMs, policy: LatePolicy }` — `shareStartMs`·`lockedAtMs` 없음
  - `LatePhaseParticipant` = `{ userId, state, arrivedAtMs: number | null }`
  - `LatePhaseInput` = `{ myUserId, myState, settlePending, appointment, participants }`
  - `LatePhase` = `waiting | live | overtime | arrived | settling | settled | voided | canceled` (`locked`·`pending` 없음)
    - `waiting` 시작 전(대기실, 시각 무관) / `live`·`overtime` 주최자가 시작한 뒤(위치 공개·체크인 열림)
- 함수:
  - `phase(live, serverNowMs)` — 우선순위: 닫힌 status → settling(settlePending ∨ now > closeMs) → arrived → 시작 전이면 waiting → live/overtime(경계 = 약속 시각 + 봐주는 시간). now 가 NaN 이면 시작 여부만으로 waiting/live
  - `myParticipant(live)`
  - `onTimeUntilMs(appt)`
  - `isStarted(appt)` — `startedAtMs` 유무로만 판정(시각 무관). 옛 `isLocked` 는 없다(컴파일 오류)
  - `isCheckInOpen(appt, now)` — `open ∧ startedAtMs 있음 ∧ startedAtMs ≤ now ≤ closeMs`. 시작 전에는 항상 false
  - `isLocationVisible(appt, now)` — 남의 위치가 보이는 조건 = `isCheckInOpen` 과 같다
  - `lateCloseMs(policy, meetAtMs) → closeMs` — `lateBet.closeAtMs` 위임(SQL `lb_close_at`). **closeMs = 전액 몰수 시각 + 30분 꼬리(상한 마감+180분, 없으면 +60분)**. 옛 `lateTimes`·`sharesImmediately` 는 없다
  - `isClosedPhase(p)`
  - `pollIntervalMs(p)` — 대기실 10초(게스트가 주최자의 시작을 곧 봐야 한다), 나머지 5초, 닫힌 단계는 null.
  - `allActiveArrived(participants)`

**`lateBet.ts`** (9/18 2차) — `LatePolicy` 는 5필드(`stake·radiusM·unitMinutes·penaltyPerUnit·graceMinutes`), **`shareLocationMinutesBefore` 없음**. `closeAtMs(policy, deadlineMs) → number | null`(= 전액 + 30분, 상한 +180분, 없으면 +60분). `locationShareWindow(policy, deadlineMs, startedAtMs) → { startMs: startedAtMs, endMs: closeAtMs } | null`(시작 전·쓰레기 시각이면 null). `isLocationShared(policy, deadlineMs, startedAtMs, nowMs, hasArrived)`. `SHARE_TAIL_AFTER_FULL_FORFEIT_MINUTES = 30`.

**`latePresets.ts`**
- 상수:
  - `POLICY_LIMITS` — 서버 CHECK와 같은 범위입니다.
  - `FULL_FORFEIT_CAP_MINUTES` = 180
  - `START_BALANCE` = 1000
  - `MAX_STAKE_POINTS` = 300
  - `STAKE_CHOICES` = [0, 50, 100, 200, 300]
  - `GRACE_CHOICES` = [0, 5, 10]
  - `RADIUS_CHOICES` = [50, 100, 200]
  - `SMALL_RADIUS_WARN_M` = 50
  - `LATE_PRESETS` — id는 `mild | normal | spicy`
  - `DEFAULT_PRESET_ID` = `'normal'`
- 타입:
  - `LatePresetId`, `LatePreset`
  - `PolicyIssueField`, `PolicyIssue`, `PolicyValidation` = `{ ok, issues }`
  - `PolicyDescription`
- 함수:
  - `getPreset(id)`
  - `presetPolicy(id?)`
  - `policyWithStake(id, stake, base?)`
  - `matchPreset(policy)`
  - `minutesToFullForfeit(policy)`
  - `validatePolicy(policy)`
  - `isValidPolicy(policy)`
  - `describePolicy(policy, meetAtMs, tz = 'Asia/Seoul')` — 9/18 2차: `share`·`shareStartMs` 필드 없음(lines 는 최대 7줄). 위치 공개 시작은 화면이 "주최자가 시작하면…" 으로 말한다
  - `shortPolicyLine(policy)`
  - `formatMinutes(n)`
  - `formatLoss(p)`

**`invite.ts`**
- 상수:
  - `CODE_RE`
  - `CODE_LENGTH`
  - `CODE_ALPHABET` — 31자.
  - `INVITE_PAGE_URL`
  - `APP_SCHEME`
- 타입: `ShareTextInput`
- 함수:
  - `normalizeCode(raw) → string | null`
  - `sanitizeCodeInput(raw)`
  - `parseInviteUrl(input) → string | null`
  - `buildInviteUrl(code, pageUrl?) → string | null`
  - `buildAppLink(code) → string | null`
  - `generateCode(random)` — fakeApi용이며 난수원을 주입합니다.
  - `buildShareText({ title, meetAtMs, tz, placeName, policy, inviteCode, changed?, pageUrl? })`

**`mapRoute.ts`**
- 함수:
  - `mapRouteUrl(name, lat, lng)`
  - `mapPinUrl(name, lat, lng)` — 둘 다 항상 string을 돌려줍니다.

**`tzGuard.ts`**
- 상수·타입: `SEOUL_TZ`, `TzChoice`, `WallClock`, `TZ_CHOICES`(16개), `TZ_SUSPECT_HOURS` = 1.5
- 함수:
  - 가드: `isInKorea(lat, lng)`, `needsTzChoice(deviceTz, lat, lng)`, `tzLabel(tz)`, `tzChoices(deviceTz?)`
  - 변환: `tzOffsetMinutes(ms, tz) → number | null`, `isKnownTz(tz)`, `wallClockToMs(localAt, tz) → number | null`, `wallClockAt(ms, tz)`, `msToLocalAt(ms, tz)`
  - 표시: `formatKoreanTime`, `formatKoreanDate`, `formatKoreanDateTime`, `isSameLocalDay`, `formatFromNow(deltaMs)`
  - 서버와 같은 의심 판정: `isTzSuspect(tz, lng, atMs)` — 서버 `LB_TZ_SUSPECT`와 같은 식입니다.

**`toSession.ts`**
- 타입: `ToSessionAppointment`, `ToSessionParticipant`, `ToSessionLive`, `SessionCandidate`, `SessionDraft`
- 함수:
  - `sessionCandidates(live)` — 확인 시트의 후보 목록입니다. 활성 참가자만, 서버 순서 그대로이며 `noShow`는 라벨일 뿐 체크를 풀지 않습니다.
  - `toSessionDraft(live, selectedUserIds?) → { title, people: { name }[], appointment, lateBetId }` — `createSession(d.title, d.people, d.appointment)`에 그대로 넘기면 됩니다.

## 서버 CHECK와의 일치 확인

- `validatePolicy`는 6개 필드의 정수·범위와 `penaltyPerUnit = 0 or stake = 0 or (ceil(stake/ppu) − 1) × unit + grace <= 180`을 검사합니다. 테스트에 SQL CHECK를 따로 옮긴 참조식을 두고 무작위 2,000건에서 같은 판정이 나오는지 비교합니다.
- 프리셋 단언은 다음과 같습니다.
  - 세 프리셋 모두 `validatePolicy`를 통과합니다.
  - `describePolicy`의 전액 시각이 `fullForfeitAtMs`와 같습니다(분으로는 45/45/29).
  - 폼 선택지의 모든 조합이 CHECK를 통과합니다.

## 설계서와 다르게 했거나 명세를 채운 것

1. **`live`와 `overtime`의 경계**는 `meetAtMs + graceMinutes`입니다. 설계서에는 경계가 적혀 있지 않았습니다. 봐주는 시간 안에 "지금 도착하면 전액 돌려받아요"가 계속 참이 되도록 이렇게 했고, 그래서 `LatePhaseAppointment`에 `policy`가 필수입니다.
2. **phase 우선순위**(9/18 2차)는 닫힌 status → settling(`settlePending` 또는 now > closeMs) → arrived → 시작 전(`startedAtMs` 없음 → waiting) → live/overtime 순입니다. `serverNowMs`가 NaN이면 시각 비교 없이 시작 여부로 `waiting`/`live`(또는 서버 플래그에 따라 `settling`)로 둡니다.
3. **`describePolicy`는 문자열이 아니라 객체를 돌려줍니다.** "각 선택 아래 문장" 요구에 맞춰 `stake`, `penalty`, `example`, `full`, `close`, `grace`, `radius`, `lines[]`와 `fullForfeitAtMs`, `fullLateMinutes`, `closeMs`를 담았습니다(9/18 2차: `share`·`shareStartMs` 삭제). 다른 시간대 약속을 위해 세 번째 인자 `tz`(기본 서울)도 추가했습니다.
4. **`validatePolicy`는 `{ ok, issues: { field, message }[] }`를 돌려줍니다.** boolean만 필요하면 `isValidPolicy`를 쓰면 됩니다. (9/18 2차: 검사 필드는 5개, `shareLocationMinutesBefore` 없음)
5. **`policyWithStake`를 추가했습니다.** 폼이 걸 포인트와 프리셋을 따로 고르는데 프리셋에는 고유 스테이크가 있어, 맵기는 두고 스테이크만 바꾸는 함수가 필요했습니다. 단위 차감은 올림해서 전액 시점이 프리셋보다 늦어지지 않습니다.
   - 순한맛과 보통은 차감 비율이 같아서(5분마다 10%) 스테이크를 바꾸면 둘이 구분되지 않습니다. 이때 `matchPreset`은 정확히 일치하는 프리셋을 먼저 찾고, 없으면 보통으로 봅니다.
6. **`buildInviteUrl`과 `buildAppLink`는 코드가 형식에 안 맞으면 null을 돌려줍니다.** `buildShareText`는 그 경우 빈 문자열입니다.
7. **`INVITE_PAGE_URL`은 잠정값 `https://jeongsan-yaho.expo.app/`입니다.** 서브도메인은 오너가 `eas deploy` 때 정하므로, 확정되면 이 상수와 `invite-web/invite.js`를 같이 바꿔야 합니다.
8. **`parseInviteUrl`은 네 가지 입력을 받습니다.**
   - 입력 모양: URL(`?c=`, `/j/CODE`), 코드 단독, 공유 문구 전체, 대문자 8자 토큰.
   - 홈의 [초대 코드 붙여넣기]에서 공유 문구를 통째로 붙여넣는 경우를 위해서입니다.
   - Hermes 호환을 위해 정규식 룩비하인드는 쓰지 않았습니다.
9. **`mapRouteUrl`과 `mapPinUrl`은 좌표가 유효하지 않으면 `https://map.kakao.com/link/search/{이름}`으로 떨어집니다.** 반환 타입을 설계서대로 string으로 유지하기 위해서입니다. 좌표는 소수 6자리로 적습니다.
10. **`tzGuard.ts`에 시간대 인자 기반의 변환·포맷 함수를 같이 넣었습니다.**
    - 이유: 기존 `appointment.ts`의 표시는 기기 타임존 기준이라 `describePolicy`·`buildShareText`·fakeApi에서 쓸 수 없었습니다.
    - 시간대 계산은 Intl의 `formatToParts`로 하고, 실패하면 `TZ_CHOICES`의 표준시 오프셋 표를 씁니다. 그마저 없으면 표시용 함수는 한국 시각으로 읽고, `tzOffsetMinutes`와 `wallClockToMs`는 null을 돌려줍니다.
    - `wallClockToMs`는 서머타임으로 없는 시각을 전환 뒤로 밉니다(PostgreSQL과 같은 방향).
11. **`needsTzChoice`는 기기 tz가 빈 값이면 한국으로 봅니다.** 그래도 핀이 한국 밖이면 true입니다. 핀이 아직 없으면(null) 핀 조건은 건너뜁니다.
12. **§8 P0-a 목록의 `errors`는 만들지 않았습니다.** 파일 소유권상 [foundation]의 `src/lateBet/errors.ts`입니다.

---

## Foundation 계약서 (화면 담당이 지켜야 할 타입·props 계약) — 2026-09-18 2차 개정판 ([시작하기] 모델)

토대([foundation], 9/17)를 끝냈고, 9/18 [rules-client] 가 오너 확정 흐름(설계서 §0-1: 초대 명단 + 주최자 [시작하기])을 반영해 계약을 고쳤다. 아래가 현재 계약이다. 옛 것(pending·approve·join·setJoinClosed·updateAppointment·needsApproval·joinClosed·PendingView·`LB_EDIT_LOCKED`·`APPROVE_INSUFFICIENT_MESSAGE`·`removedMessage(wasPending)`·`isLocked`·`locksImmediately`·`lateTimes`·`sharesImmediately`·`lockedAtMs`·`rosterCompleteAtMs`·`shareStartMs`·`shareLocationMinutesBefore`·phase `locked`)은 전부 없다.

**흐름 한 줄**: 주최자가 만들고 초대 → 친구들이 명단에서 이름 골라 포인트 걸기 → 주최자 **[시작하기]** 한 번 → 그 순간부터 전원 위치 공개·체크인 → 도착·지각 판정 → 정산. 시작 전엔 위치가 아무에게도 안 보인다. 약속 시각까지 시작 안 하면 무효(전원 환불).

검증한 것(9/17): 릴리스 번들 `expo export` 성공, 웹 릴리스 JS 에 가짜 서버 코드 0건. 웹 프리뷰(fake 모드) 흐름 확인. 9/18 은 게이트(`npm test` 361, 소유 파일 typecheck 0)만 돌렸고 웹 프리뷰는 화면 재작업 뒤에 다시 본다.

# 화면 담당용 계약서

## 0. 실행

- fake 모드: `cd /Users/byungheemin/.openclaw/workspace/nbbang && EXPO_PUBLIC_LATEBET_MODE=fake npx expo start --web --port <각자 포트>`. `.env.local`은 만들지 않았습니다. 참고는 `.env.example`.
- 모드 규칙은 `src/lateBet/modeRule.ts`(테스트 있음)에 있고 `src/lateBet/mode.ts`가 상수를 냅니다: `LATEBET_MODE`, `LATEBET_ENABLED`, `LATEBET_FAKE`.
- 화면은 `useLateBet().enabled`로만 분기합니다. off면 약속 UI를 아무것도 그리지 않습니다.

## 1. 파일 (전부 `/Users/byungheemin/.openclaw/workspace/nbbang/` 아래)

- **`src/lateBet/`**
  - `types.ts`, `api.ts`, `errors.ts`
  - `changes.ts`(+test) — 변경 배너 문구 `describeChanges(unseenChanges, tz)`
  - `modeRule.ts`(+test), `mode.ts`
  - `fakeApi.ts`(+test) — 참조 구현(SQL 이 이걸 따라간다)
  - `serverClock.ts`(+test), `useServerNow.ts`
  - `LateBetContext.tsx`, `useLive.ts`, `useArrivalReporter.ts`
  - `startSettlement.ts`, `notifications.ts`
  - `homeModel.ts`, `resultModel.ts` — 표시 모델([result])
- **`src/lateBet/screens/`**
  - `props.ts` — props 계약. 고치지 마세요.
  - `NicknameGate.tsx`, `FakeDevPanel.tsx` — 완성본입니다.
  - `ConditionCard.tsx` — 공유 조각(`ConditionCard`·`FromNowPill`·`openExternal`). 옛 PendingView 에 있던 것 그대로. '위치 공개 시점' 항목은 없다.
  - `InviteeEditor.tsx` — 초대 명단 편집기(완성, [create] 9/18).
  - `WaitingView.tsx`, `LiveView.tsx`, `ArrivedView.tsx`, `ResultView.tsx`, `LocationPrimer.tsx` — 화면 담당.
  - ~~`PendingView.tsx`~~ 삭제됨.
- **`src/ui/`**: `MapPane.tsx`(완성), `PlacePicker.tsx`(완성 — 프리셋 8곳 + 좌표 입력 + 미리보기)
- **`app/`**
  - `app/late/[id]/index.tsx` — 완성된 컨테이너입니다.
  - `app/late/new.tsx`, `app/late/place.tsx`, `app/late/points.tsx`, `app/j/[code].tsx`, `app/j/index.tsx` — 완성(9/18).
  - `app/_layout.tsx` — `LateBetProvider` + `Stack.Screen` 6개(한국어 제목).

## 2. 타입 (`@/lateBet/types`)

- `LbPing`: `{ serverNowMs, minBuild, iosUrl, androidUrl }`
- `LbProfile`: `{ userId, nickname, balance }`
- `LateMemberState` = `'active'` (pending 없음)
- `LbInvitee`: `{ name, claimedByUserId: string | null, claimedAtMs: number | null }` — 명단 한 칸. 주최자는 명단에 없다(자동 참가)
- `LbAppointmentSnapshot`: `{ localAt, tz, meetAtMs, placeName, placeLat, placeLng, policy }`
- `LbAppointmentChange`: `{ version, atMs, before: Snapshot, after: Snapshot }` — 조건 변경 1건
- `LatePolicy`: `{ stake, radiusM, unitMinutes, penaltyPerUnit, graceMinutes }` — **`shareLocationMinutesBefore` 없음**
- `LbAppointment`
  - `id`, `inviteCode: string`, `hostId`, `hostNickname`, `title`
  - `localAt`, `tz`, `meetAtMs`, **`startedAtMs: number | null`**(주최자가 [시작하기]를 누른 서버 시각. null = 대기실), `closeMs`(= 전액 몰수 + 30분 꼬리, 상한 마감+180분)
  - `placeName`, `placeNote`, `placeLat`, `placeLng`
  - `status: 'open' | 'settled' | 'voided' | 'canceled'`, `voidReason: 'noStake' | 'noWinner' | 'invalidDeadline' | 'notStarted' | null`, `version`
  - `policy: LatePolicy`
  - `invitees: LbInvitee[]`, `changes: LbAppointmentChange[]`(오래된 순)
  - `shareStartMs`·`rosterCompleteAtMs`·`lockedAtMs`·`joinClosed` 없음
- `LbCreateInput`: `{ title, localAt: 'YYYY-MM-DDTHH:mm', tz, placeName, placeNote, lat, lng, policy, invitees: string[], consent, tzConfirmed? }` — `invitees` 는 주최자 제외 이름(1~12자, 중복·주최자 이름은 서버가 조용히 뺀다), 최대 19. 빈 배열도 된다(혼자 시작 가능)
- `LbEditPatch`: `{ localAt?, tz?, placeName?, lat?, lng?, policy?, tzConfirmed? }` — 바꿀 것만(부분 갱신). lat/lng 는 둘 다
- `LbInviteesPatch`: `{ add?: string[], remove?: string[] }`
- `LbInvitePreview`
  - 약속 필드 + `hostNickname`
  - **`startedAtMs`**(이미 시작했으면 그 시각 — 그래도 약속 시각 전이면 빈 이름을 고를 수 있다), `serverNowMs`, `memberCount`(주최자 포함)
  - `invitees: { name, claimed, mine }[]` — 누구에게나 보인다(자기 이름을 골라야 하므로). `claimed` 면 못 고른다, `mine` 이면 내가 고른 칸. 빈 이름이 없으면 "초대 명단에 없어요…" 안내
  - `myState: 'active' | null`, `myBalance: number | null`
  - `needsApproval`·`joinClosed`·`nicknames`·`lockedAtMs`·`shareStartMs` 없음
- `LbJoinResult`: `{ appointmentId, state: 'active', started: boolean }` — `started` = 주최자가 이미 시작한 약속에 들어왔다(→ 바로 live 화면, 그때부터 위치 공개·판정 대상)
- `LbReportInput`: `{ lat, lng, accuracyM: number | null, mocked?, share? }`
- `LbReportResult`: `{ arrived, reason, arrivedAtMs, distanceM, serverNowMs }`
  - `reason`: `null | 'closed' | 'already_arrived' | 'not_open' | 'bad_position' | 'mocked' | 'low_accuracy' | 'outside'` (`pending` 없음)
- `LbLiveParticipant`
  - `userId`, `nickname`(= 명단의 이름), `state: 'active'`, `joinedAtMs`
  - `arrivedAtMs`, `arrivalMethod: 'gps' | 'vouch' | null`, `arrivalDistanceM`, `arrivalAccuracyM`, `vouchedBy`
  - `resultStatus: 'onTime' | 'late' | 'noShow' | null`, `forfeited`, `received`
  - `lastSeenMs`
  - `location: { lat, lng, accuracyM, updatedAtMs, distanceM } | null` — **시작됨 ∧ 마감 전 ∧ 미도착 ∧ 3분 안** 일 때만. 시작 전에는 항상 null
- `LbLive`: `{ serverNowMs, myUserId, myState, myBalance, settlePending, appointment, participants[] }`
  - `participants`는 (joinedAt, userId) 순, 전원이 전 행을 본다.
  - `latePhase.LatePhaseInput`과 `toSession.ToSessionLive`를 구조적으로 만족하므로 그대로 넘기면 됩니다.
- `LbMyAppointment`
  - `id`, `title`, `localAt`, `tz`, `meetAtMs`, **`startedAtMs`**, `closeMs`, `placeName`
  - `status`, `policy`, `hostId`, `isHost`, `myState`
  - `memberCount`(주최자 포함), `unclaimedCount`(아직 안 들어온 이름 수. 약속 시각이 지나면 0). `pendingCount`·`shareStartMs`·`lockedAtMs` 없음
- `LbLedgerEntry`
  - `id`, `kind: 'grant' | 'relief' | 'hold' | 'refund' | 'payout'`, `amount`(부호 있음), `balanceAfter`
  - `appointmentId`, `appointmentTitle`
  - `reason: 'signup' | 'topup' | 'leave' | 'canceled' | 'kicked' | 'policy_change' | 'notStarted' | null` — `policy_change` 는 시작 전 걸 포인트 변경의 차액 hold(음수)·refund(양수), `notStarted` 는 시작 안 된 약속의 무효 환불(refund)
  - `reliefFor`, `createdAtMs`

## 3. `LateBetApi` (`@/lateBet/api`)

- 전부 Promise이고, 실패는 항상 `LateBetError`입니다.
- 화면은 `useLateBet().api`로 받습니다. `getLateBetApi()`를 직접 부르지 마세요.

```ts
// 세션
restoreSession(): Promise<string | null>
ensureSignedIn(): Promise<string>

// RPC (설계서 §2.3 번호. 5·8 폐지, 4·10 교체, 16·17 신설)
ping(): Promise<LbPing>
ensureProfile(nickname): Promise<LbProfile>
createAppointment(input: LbCreateInput): Promise<LbAppointment>        // input.invitees 필수(빈 배열 가능)
peekInvite(code): Promise<LbInvitePreview>
claimSlot(appointmentId, name, version, consent): Promise<LbJoinResult> // #4 명단에서 내 이름 고르기(멱등). LB_NOT_INVITED / LB_SLOT_TAKEN / LB_JOIN_CLOSED(약속 시각 지남·닫힘) / LB_APPT_CHANGED. 시작 뒤에도 약속 시각 전이면 가능(result.started)
start(appointmentId): Promise<LbAppointment>                            // #17 주최자 [시작하기]. 약속 시각 전이면 언제든(혼자여도). LB_START_CLOSED(약속 시각 지남·닫힘) / LB_ALREADY_STARTED. 되돌릴 수 없다. version 안 올림
editInvitees(appointmentId, { add?, remove? }): Promise<LbAppointment> // #16 주최자, 시작 전. 들어온 이름 remove 는 LB_INVITEE_JOINED. 시작 후 LB_EDIT_FROZEN
leave(appointmentId): Promise<void>                                     // 시작 전, 전액 환불. 이름은 명단에 빈 칸으로 남는다. 시작 후 LB_LEAVE_CLOSED
kick(appointmentId, targetUserId, ban = true): Promise<void>            // 주최자, 시작 전, 전액 환불 + 명단에서 그 이름 제거. 시작 후 LB_KICK_CLOSED
updateMemo(appointmentId, title, placeNote): Promise<void>              // version 안 올림
edit(appointmentId, patch: LbEditPatch, version): Promise<LbAppointment> // #10 시작 전: 전부(걸 포인트 차액 자동 hold/refund). 시작 후: 시간 뒤로 미루기(≤ +3h)·장소만 → 그 외 LB_EDIT_FROZEN / LB_POSTPONE_ONLY / LB_POSTPONE_TOO_FAR. 마감(closeMs) 지남·닫힘 LB_EDIT_CLOSED. version 어긋나면 LB_APPT_CHANGED. 바뀐 게 없으면 version 그대로
cancel(appointmentId): Promise<void>                                    // 시작 전(혼자면 언제든). 전원 환불. 시작 후 LB_CANCEL_CLOSED
reportLocation(appointmentId, input: LbReportInput): Promise<LbReportResult> // 시작 시각부터 마감까지. 시작 전 reason 'not_open'
stopSharing(appointmentId): Promise<void>
vouch(appointmentId, targetUserId): Promise<void>                       // 시작 전 LB_NOT_STARTED
getLive(appointmentId): Promise<LbLive>                                 // 시작 안 된 채 약속 시각이 지났으면 여기서 notStarted 무효 정산

// 조회
getMyProfile(): Promise<LbProfile | null>
listMyAppointments(): Promise<LbMyAppointment[]>   // 열린 약속(가까운 순) → 끝난 약속(최근 순)
listLedger(limit?): Promise<LbLedgerEntry[]>       // 최신순
```

- `claimSlot` 의 첫 인자는 **appointmentId**(peekInvite 가 준 `id`)다. 코드가 아니다.
- 걸 포인트를 올리는 `edit` 이 어떤 참가자의 포인트 부족(채워 줄 수도 없음)으로 실패하면 `LB_INSUFFICIENT_POINTS`, `e.detail` = 그 닉네임. 주최자에게는 `RAISE_STAKE_INSUFFICIENT_MESSAGE` 를 보여 준다.
- live 모드는 P2까지 모든 호출이 `LB_NOT_CONFIGURED`로 실패하는 자리표시자입니다.

## 4. 오류 (`@/lateBet/errors`)

- `LateBetError { code, message(한국어), detail }`. 새 문구를 만들지 말고 `e.message`를 그대로 그리세요.
- 9/18 추가: `LB_NOT_INVITED`("초대 명단에 없어요. 주최자에게 이름을 추가해 달라고 해주세요."), `LB_SLOT_TAKEN`, `LB_INVITEE_JOINED`, `LB_EDIT_FROZEN`, `LB_POSTPONE_ONLY`, `LB_POSTPONE_TOO_FAR`, **`LB_START_CLOSED`("약속 시각이 지나 이제 시작할 수 없어요."), `LB_ALREADY_STARTED`("이미 시작한 약속이에요."), `LB_NOT_STARTED`("주최자가 아직 시작하지 않았어요.")**. 삭제: `LB_EDIT_LOCKED`. 문구: `LB_LEAVE_CLOSED`("주최자가 시작해서 지금은 빠질 수 없어요…")·`LB_KICK_CLOSED`·`LB_CANCEL_CLOSED`·`LB_EDIT_FROZEN`("이미 시작한 약속…")·`LB_POSTPONE_ONLY`("시작한 뒤에는…").
- 클라이언트 코드: `LB_OFFLINE`, `LB_TIMEOUT`, `LB_NOT_CONFIGURED`, `LB_RATE_LIMITED`, `LB_CHECK_VIOLATION`(23514), `LB_RETRYABLE`, `LB_UNKNOWN`.
- 헬퍼
  - `toLateBetError(e)`, `errorMessage(code)`
  - `isTzSuspectError(e)` — 시간대 시트 → `tzConfirmed: true`로 재시도
  - `isConnectivityError(e)`, `isNotMemberError(e)`
  - `reportReasonMessage(reason, { distanceM, accuracyM, radiusM, closeMs, tz })` — §5.4 문구. `not_open` = "주최자가 시작하면 체크인할 수 있어요." (`shareStartMs` 인자 없음)
- 상수
  - `RAISE_STAKE_INSUFFICIENT_MESSAGE` — 걸 포인트 올리기 실패(위 3절)
  - `REMOVED_MESSAGE` — 내보내졌을 때(컨테이너가 그린다). 옛 `removedMessage(wasPending)` 삭제
  - `REPEATED_FAILURE_MESSAGE`, `STALE_NOTICE`, `SERVER_DOWN_NOTICE`, `SETTLE_DELAYED_NOTICE`

## 5. Context — `useLateBet()` (`@/lateBet/LateBetContext`)

변경 없음.

```ts
{
  mode, enabled, fake, api,
  status: 'off' | 'idle' | 'loading' | 'ready' | 'error',
  userId,
  profile: LbProfile | null,
  balance: number | null,
  appointments: LbMyAppointment[],
  ping, needsUpdate, installUrl,
  error: LateBetError | null,
  failCount, stale,
  refresh(): Promise<void>,
  ensureReady(): Promise<LbProfile | null>,
  ensureProfile(nickname): Promise<LbProfile>,
  applyBalance(n),
}
```

- `refresh()`는 던지지 않습니다. 홈 포커스 때와 변경 RPC 뒤에 부르세요. 마감이 지난 open 약속과 시작 없이 약속 시각을 넘긴 open 약속은 `getLive`를 한 번 불러 게으른 정산(무효)까지 합니다.
- `ensureReady()`는 익명 로그인 + ping + 로드이고, 실패하면 던집니다.
- `status === 'idle'`은 세션이 없다는 뜻입니다. 홈에는 버튼만 보이게 하세요.
- 홈은 `useFocusEffect(() => { void refresh(); })`를 쓰세요.
- `<NicknameGate>{children}</NicknameGate>`
  - 하는 일: off 안내 / `ensureReady` / 닉네임 1칸 → `ensureProfile`.
  - `late/new`와 `late/points`를 이걸로 감싸세요.
  - `j/[code]`는 프로필 닉네임과 무관하게 **명단에서 이름을 고르므로** 감싸지 말고 `ensureReady()` → (`profile === null`이면 아무 닉네임으로 `ensureProfile` — 예: 고른 명단 이름) → `api.claimSlot(preview.id, name, preview.version, consent)` 를 직접 부르세요.
- 같은 파일의 `LateBetUnavailable`은 off 모드 안내 화면입니다.

## 6. `useLive(appointmentId)` (`@/lateBet/useLive`)

```ts
{
  live: LbLive | null,
  phase: LatePhase | null,
  me, isHost, loading, error, stale, failCount,
  removed: boolean,                       // LB_NOT_MEMBER = 내보내짐 (옛 { wasPending } 아님)
  settleDelayed,
  unseenChanges: LbAppointmentChange[],   // 마지막으로 본 version 뒤의 주최자 변경(오래된 순). 주최자에게는 항상 []
  ackChanges(): void,                     // 배너 [확인]
  refresh(): Promise<LbLive | null>,
}
```

- 폴링은 `pollIntervalMs(phase)`를 따릅니다(대기실 10초, 나머지 5초, 끝났으면 정지). blur·백그라운드에서 멈추고 복귀하면 즉시 1회 읽습니다.
- `phase`는 1초마다 다시 계산하지만 값이 바뀔 때만 리렌더합니다. 마감 경계를 넘으면 즉시 refetch합니다. 대기실 → live 는 시각이 아니라 주최자의 [시작하기](서버 응답)로 바뀝니다 — 주최자는 `api.start` 뒤 `await refresh()`, 게스트는 폴링(10초)으로 봅니다. 시작 없이 약속 시각을 넘긴 대기실은 한 번 바로 refetch 해 무효(voided) 화면으로 넘어갑니다.
- 변경 배너: 처음 본 version 이 기준(만든·참여한 직후의 조건). **참여 화면은 `claimSlot` 성공 직후 `markSeenVersion(appointmentId, preview.version, mode)`(`@/lateBet/useLive` export, 장부는 `@/lateBet/seenVersions`)로 동의한 version 을 먼저 심습니다** — 안 심으면 첫 `getLive` 응답의 version 이 기준이 되어 그 사이 주최자가 바꾼 조건(차액 hold 포함)이 배너 없이 묻힙니다(생성 화면도 같은 규칙으로 심습니다). 그 뒤 `appointment.changes` 중 큰 version 이 `unseenChanges` 로 옵니다. 문구는 `describeChanges(unseenChanges, live.appointment.tz)`(`@/lateBet/changes`) → "주최자가 약속을 바꿨어요: 오후 7:30 → 오후 8:00 · 건 포인트 100P → 200P". [확인] → `ackChanges()`. live 모드는 `seenVersion` 이 캐시(`yaho.late.cache.v1`)에 같이 남습니다.
- 캐시: fake는 메모리, live는 AsyncStorage `yaho.late.cache.v1`(좌표는 저장하지 않음).
- `useLive`와 `useArrivalReporter`는 `app/late/[id]/index.tsx`가 돌립니다. 뷰는 다시 부르지 말고 props로 받으세요.
- 시계: `useServerNow(1000 | 30000)`. 1초 티커는 그 숫자를 그리는 작은 컴포넌트 안에서만 쓰세요. 이벤트 핸들러에서는 `serverNow()`, 직접 호출을 감쌀 때는 `withClockSample(() => api.peekInvite(code))`.
- 남은 시간 계산에 `Date.now()`를 쓰지 마세요. 가짜 서버의 빨리 감기와 어긋납니다.

## 7. 뷰 props (`@/lateBet/screens/props`)

```ts
interface LateViewProps {
  live; phase; me; isHost; api;
  refresh: () => Promise<LbLive | null>;
  stale; error;
  unseenChanges: LbAppointmentChange[];   // 비어 있지 않으면 화면 상단에 변경 배너 + [확인](ackChanges)
  ackChanges: () => void;
}

WaitingViewProps  = LateViewProps & { onLeft(): void }                   // phase waiting (시작 전)
LiveViewProps     = LateViewProps & { reporter: ArrivalReporter }        // phase live | overtime (시작 후)
ArrivedViewProps  = LateViewProps & { justArrived: boolean }
ResultViewProps   = LateViewProps & { settleDelayed: boolean }           // settling | settled | voided
LocationPrimerProps = { onAllow(), onLater(), busy?, permission? }       // shareMinutesBefore 없음
```

- `PendingViewProps`·phase `locked` 삭제. `WaitingView` 는 `waiting`(시작 전) 하나만 받습니다.
  - waiting · 주최자: `InviteeEditor`(명단 추가·빈 이름 삭제 → `api.editInvitees`), 조건 변경 전부(`api.edit(id, patch, live.appointment.version)`), 내보내기(`api.kick`), 취소(`api.cancel`). "아직 안 들어온 친구: 철수, 영희" 표시. **하단 primary [시작하기]** → `api.start(id)` → `await refresh()`(phase 가 live 로 바뀌어 컨테이너가 LiveView 를 그린다). 버튼 아래 설명 "누르면 모두의 위치가 서로 보여요. 아직 안 들어온 친구는 나중에 들어와도 돼요". 참가자가 주최자뿐이면 `confirmDialog('아직 아무도 안 들어왔어요', '지금 시작할까요? 친구는 나중에 들어와도 돼요', …)` 뒤 진행. 실패는 `alertDialog(e.message)`(`LB_START_CLOSED` 등).
  - waiting · 게스트: [나가기 (포인트 돌려받기)](`api.leave` → `onLeft()`). 하단 "주최자가 시작하면 위치가 보여요".
  - 시작 전에는 위치 관련 UI(지도의 친구 핀·공유 토글·[도착 확인])를 그리지 않습니다. 시각 안내는 `describePolicy` 의 `close` 문장과 조건 카드로 충분합니다.
- `LiveView`: 시작 후. 전원 위치가 내려옵니다(`startedAtMs ~ closeMs`). 주최자에게 안 들어온 이름은 "철수가 아직 안 들어왔어요"(약속 시각까지 들어올 수 있고, 명단 편집은 불가 — [명단에서 빼기] 버튼은 없다. 약속 시각에 자동 삭제). 주최자 조작은 시간 미루기·장소 변경(`api.edit`)만. `ReportReasonContext` 에 `shareStartMs` 를 넣지 마세요(없어진 필드).
- named export입니다(`export function WaitingView`). 이름과 시그니처를 유지하세요.
- 각 뷰가 자기 `<Screen>`(footer 포함)을 직접 그립니다.
- 컨테이너가 이미 그리는 것은 뷰에서 중복하지 마세요: `FakeDevPanel`, 연결 끊김 띠, 헤더 제목, `canceled` 안내, 내보내짐 안내(`REMOVED_MESSAGE`), 로딩과 실패 화면. **변경 배너는 뷰가 그립니다**(props 로 옵니다).
- 변경 RPC 뒤에는 `await refresh()`. `refresh()` 는 진행 중인 폴링 읽기를 돌려주지 않고 그 뒤에 한 번 더 읽습니다(`@/lateBet/refreshGate`; 폴링은 진행 중인 읽기를 재사용) — 변경 RPC 보다 먼저 서버에 닿은 폴링 응답(변경 전 스냅샷)이 화면에 남지 않습니다.
- 내가 빠지는 동작(게스트 나가기) 뒤에는 `refresh` 대신 `onLeft()`를 부르세요. 안 그러면 "주최자가 내보냈어요"가 뜹니다.
- 주최자 취소는 `api.cancel` → `refresh`를 하면 컨테이너가 취소 안내를 그립니다. '취소하고 새로 만들기' 강제는 없습니다(원하면 `router.replace('/late/new?from=<id>')` 는 그대로 쓸 수 있음).
- `ArrivalReporter`
  - 필드: `permission`, `sharing`, `setSharing(on)`, `running`, `myDistanceM`, `myAccuracyM`, `lastResult`, `error`, `checking`
  - 메서드: `checkInNow(): Promise<LbReportResult | null>`, `requestPermission()`
  - `checkInNow`는 공유가 꺼져 있으면 `share=false`로 판정만 받습니다. 도착이 찍히면 컨테이너가 `refresh`하고 `justArrived=true`로 바꿉니다.
  - 보고 루프는 `isCheckInOpen`(시작 후 ∧ 마감 전)일 때만 돕니다. 시작 전에는 `running=false`.
  - P0에서 `permission`은 fake면 `'granted'`, 아니면 `'unsupported'`입니다.
- [정산 시작]
  - `findSessionForLateBet(sessions.sessions, live.appointment.id)`가 있으면 `confirmDialog('이미 만든 정산이 있어요', '열까요?', ...)`.
  - 없으면 `startSettlement({ live, selectedUserIds, sessions: useSessions() })` → `{ sessionId, existed }` → `router.replace('/session/' + sessionId)`.
  - 확인 시트의 후보 목록은 `toSession.sessionCandidates(live)`입니다.
- `notifications.ts`는 P0 무동작입니다. 참여·생성·조건 변경 뒤에 `ensureNotificationPermission()`과 `scheduleLateNotifications({ id, version, title, tz, meetAtMs, closeMs })`(`shareStartMs` 없음)를, 끝날 때 `cancelLateNotifications(id)`를 지금부터 호출해 두세요.

## 7-1. `InviteeEditor` (`@/lateBet/screens/InviteeEditor`) — 완성([create] 9/18)

```ts
interface InviteeEditorProps {
  names: string[];            // 명단(주최자 제외)
  claimedNames: string[];     // 이미 들어온 이름 — 칩은 보이되 삭제 불가
  onAdd(name): void | string | Promise<void | string>;   // 문자열을 돌려주면 그 문구를 오류로 보여 준다
  onRemove(name): void | Promise<void>;                   // 빈 이름 칩을 눌렀을 때
  disabled?: boolean;
  maxNames?: number;          // 기본 19
}
```

- 생성 폼: `names` 는 폼 상태, `claimedNames = []`. 친구 목록 칩(`useFriends`)을 안에서 그릴지 부모가 합칠지는 [create] 가 정한다.
- 대기실(시작 전, 주최자): `names = invitees.map(i => i.name)`, `claimedNames = invitees.filter(i => i.claimedByUserId).map(i => i.name)`, `onAdd/onRemove → api.editInvitees → refresh`. 시작 후에는 편집기를 그리지 않는다(서버는 `LB_EDIT_FROZEN`).
- [create] 가 완성해야 한다. 현재 파일의 `INVISIBLE` 정규식에 U+2028 등 실제 보이지 않는 문자가 리터럴로 들어가 있어 **문법 오류(tsc 전체의 의미 검사를 막는다)** — `src/lateBet/fakeApi.ts` 의 `INVISIBLE`(이스케이프 표기)을 그대로 쓰면 된다.

## 8. MapPane / PlacePicker

변경 없음.

- `MapPane` props: `{ destination: { name, lat, lng }, radiusM, markers?: MapPaneMarker[], me?, readonly?, height?, style? }`
  - `MapPaneMarker = { id, label, lat: number | null, lng: number | null, distanceM?, caption?, arrived?, isMe? }`
  - `formatDistance(m)`도 export합니다.
  - readonly에서는 목록을 그리지 않습니다. 기준 데이터는 참가자 리스트이므로 Live 화면은 자기 참가자 행을 따로 그리세요.
- `PlacePicker`([create]가 채움) props: `{ value: { lat, lng, name? } | null, radiusM, placeName?, onChange(value) }`. 확정 버튼은 `late/place.tsx`가 그립니다. new ↔ place 사이의 핀 전달 방식은 [create]가 정하세요.

## 9. 라우트

| 경로 | 비고 |
|---|---|
| `/late/new` | `?edit=<id>`, `?from=<id>` |
| `/late/place` | |
| `/late/[id]` | `router.push(`/late/${id}`)` |
| `/late/points` | |
| `/j` | 코드 입력 |
| `/j/[code]` | 딥링크 `nbbang://j/CODE` |

- 참여 흐름(`/j/[code]`): `peekInvite(code)` → 명단에서 빈 이름 고르기(`invitees` 중 `!claimed`; `mine` 이 있으면 바로 약속 화면으로) + 동의 2개 → `claimSlot(preview.id, name, preview.version, true)` → `router.replace('/late/' + appointmentId)`(이미 시작한 약속이면 `result.started === true` 이고 컨테이너가 바로 LiveView 를 그린다). 빈 이름이 없으면 "초대 명단에 없어요. 주최자에게 이름을 추가해 달라고 해주세요." + [홈으로]. `serverNowMs >= meetAtMs` 이거나 status 가 open 이 아니면 `LB_JOIN_CLOSED` 문구. `startedAtMs` 가 있으면 카드에 "주최자가 이미 시작했어요. 들어오면 바로 위치가 보여요". `LB_SLOT_TAKEN`·`LB_APPT_CHANGED` 는 미리보기를 다시 읽는다. `LocationPrimer` 문구는 "주최자가 시작하면 서로 위치가 보여요".
- 생성 성공도 같은 경로로 replace합니다.

## 10. FakeDevPanel

- `<FakeDevPanel appointmentId? onChanged? />`는 fake가 아니면 null입니다. `/late/[id]`에는 이미 붙어 있습니다.
- 홈·`/j/*`·`/late/new`에는 담당이 화면 최상단에 `<FakeDevPanel />`을 넣으세요(`Screen` 바깥, `<View style={{ flex: 1 }}>` 안).
- 기능
  - 시간: +1분, +10분, +1시간, 약속 30분 전, 약속 5분 전, 약속 시각, 마감 1분 전, 마감 +1분(정산)으로 점프
  - 내 위치: 목적지, 300m, 1.5km, GPS 부정확(180m), 대략적 위치(2km 오차), 모의 위치, 위치 모름
  - 봇 친구 — **명단의 빈 이름을 차례로 고르며 수락한다**(라벨에 '아직 안 들어옴: 철수, 영희' 와 시작 여부 표시):
    - [봇 한 명 수락](성격 순환) / 제시간·지각·지하(보증 필요)·노쇼·앱 닫는 봇 — 다음 빈 이름을 그 성격의 봇이 고른다. 빈 이름이 없으면 시작 전에는 주최자가 이름을 하나 추가한 뒤 수락, 시작 후에는 실패(`LB_EDIT_FROZEN`). 약속 시각이 지났으면 `LB_JOIN_CLOSED`
    - [시작 후 봇 수락] — 시작 전이면 "대기실의 [시작하기]를 먼저 누르세요", 시작 후면 빈 이름 하나를 제시간 봇이 늦게 수락(그 순간부터 위치가 보인다)
    - [봇 한 명 도착]
  - **주최자의 [시작하기]는 패널이 대신 누르지 않는다** — 대기실의 실제 버튼으로 누른다.
  - 주최자 조작: [시간 30분 미루기] — `edit` 를 그대로 탄다(시작 후면 미루기 규칙, 마감 지났으면 `LB_EDIT_CLOSED`)
  - 연결 끊기(`LB_OFFLINE`), 초기화
- 데모 초대 코드(`FAKE_DEMO_CODES`)
  - `FAKE2222`(open): 지수 주최, 현우·태호 들어옴, 빈 이름 '민병희'·'병희' → 고르면 대기실(시작 전)
  - `FAKE3333`(full): 빈 이름이 없다 → "초대 명단에 없어요" 안내
  - `FAKE4444`(started): 주최자가 이미 시작했고 빈 이름 '민병희' 하나 → 고르는 순간 live 화면, 봇 위치가 바로 뜬다
  - `FAKE5555`(canceled): 취소됨
- 가짜 서버의 '나'는 `fake-me`이고 메모리뿐이라 리로드하면 초기화됩니다.
- 프로덕션 코드에서 `fakeApi`나 `fakeDevice`를 정적으로 import하지 마세요(릴리스 번들에 실립니다).

## 11. fakeApi가 지키는 규칙 (테스트로 고정, 36개)

- **명단·참여**: `createAppointment.invitees` 는 주최자 이름·중복(닉 키 기준)을 조용히 빼고, 1~12자 아니면 `LB_BAD_NICKNAME`, 19명 넘으면 `LB_FULL`. `claimSlot` 은 명단에 없으면 `LB_NOT_INVITED`, 남이 골랐으면 `LB_SLOT_TAKEN`, 약속 시각이 지났거나 닫혔으면 `LB_JOIN_CLOSED`, 옛 version 이면 `LB_APPT_CHANGED`. 참가자 닉네임 = 명단에 적힌 이름. **주최자가 시작한 뒤에도 약속 시각 전이면 들어올 수 있다**(`started = true`, 그 순간부터 위치 공개·판정 대상).
- **시작(start)**: 주최자만(`LB_NOT_HOST`). 약속 시각 전이면 언제든, 혼자여도(명단이 비어 있어도). `startedAtMs = 그 시각`, version 은 안 올린다. 약속 시각이 지났거나 닫혔으면 `LB_START_CLOSED`, 두 번째는 `LB_ALREADY_STARTED`. 되돌릴 수 없다.
- **시작 전**: `leave`(환불, 이름은 빈 칸으로), `kick`(환불 + 명단에서 제거 + 기본 차단), `editInvitees`, `cancel`(전원 환불), `edit` 전부. 걸 포인트 차액은 전원 `hold(policy_change)`/`refund(policy_change)`. 채워 줄 수도 없는 사람이 있으면 통째로 `LB_INSUFFICIENT_POINTS`(detail = 닉네임). 위치 보고는 `not_open`, 남의 좌표는 없고 제공 로그도 없다. `vouch` 는 `LB_NOT_STARTED`.
- **시작 후**: `leave`→`LB_LEAVE_CLOSED`, `kick`→`LB_KICK_CLOSED`, `editInvitees`→`LB_EDIT_FROZEN`, `cancel`→`LB_CANCEL_CLOSED`(혼자면 가능). `edit` 은 시간 뒤로 미루기(≤ +180분)·장소만: 정책이 바뀌면 `LB_EDIT_FROZEN`, 앞당기면 `LB_POSTPONE_ONLY`, 넘게 미루면 `LB_POSTPONE_TOO_FAR`. 미루면 `closeMs` 재계산(`startedAtMs` 는 그대로), 도착 기록 유지, 안 온 봇은 다시 걷는다. 마감(closeMs)이 지나면 `LB_EDIT_CLOSED`.
- **version·changes**: `edit` 이 실제로 무언가 바꾸면 version+1 과 `changes` 1건(전후 스냅샷). 바뀐 게 없으면 그대로. `updateMemo`·`start` 는 version 을 올리지 않는다.
- **체크인**: 시작 시각 ~ `closeMs`. 판정 순서는 설계서 표에서 pending 만 뺀 것(`not_open` = 시작 전). `closeMs` = 전액 몰수 + 30분 꼬리 → 꼬리 안에 온 사람은 '지각(전액)'.
- **좌표**: 남의 좌표는 **시작됨 ∧ 마감 전 ∧ 미도착 ∧ 3분 안**일 때만. 3분 뒤 숨김(`lastSeenMs`는 유지), 10분 뒤 삭제. 도착·`share=false`·`mocked`·정확도 1000m 초과·`stopSharing`이면 즉시 삭제.
- **약속 시각이 지나면(모든 RPC 앞 tick)**: 안 들어온 이름을 명단에서 지운다(환불 없음). **시작이 안 된 약속은 무효** — `status = voided`(stake 0 이면 settled), `voidReason = 'notStarted'`, 전원 `refund(notStarted)`, 전원 `resultStatus = 'noShow'`·forfeited 0·received 0. 이후 `start` 는 `LB_START_CLOSED`.
- **부족분 채움**: 부족분은 `relief(topup)`으로 채우고, 가진 것 전부(잔액 + 열린 약속에 걸린 합, 이 약속에 이미 걸린 것 포함)가 1000 이상이면 `LB_INSUFFICIENT_POINTS`.
- **보증 도착**: 시작 뒤에만. GPS 도착자만 가능하고 본인은 불가합니다. 시각은 `first_near_at`.
- **정산**: 마감 + 15초 / (전원 도착 ∧ 약속 시각 이후) / (시작 안 됨 ∧ 약속 시각 이후) 중 하나. 그 사이 `settlePending`. 제시간 0명이면 `voided`(noWinner). stake 0이면 원장 없이 `settled`. 멱등, 약속별 합계 0, `server.audit()` 빈 배열(명단↔참가자 1:1, 약속 시각이 지난 열린 약속에 빈 이름 없음·시작 안 된 열린 약속 없음 도 감사한다).
- **봇**: `addBot(id, plan?, name?)` 은 다음 빈 이름을 고른다(없으면 시작 전엔 이름 추가 후, 시작 후엔 `LB_EDIT_FROZEN`). 봇은 **시작 뒤에만** 움직이고 좌표를 보낸다(시작 전 도착으로 소급하지 않는다). `postpone(id, minutes)` 는 주최자 `edit`. `arriveBot(id)`. `fillRoster` 는 없다.

## 12. 설계서와 다르게 한 것·주의

1. **단계 경계**: `live`·`overtime` 경계 등 phase 규칙은 domain 보고대로입니다. `settling`은 `ResultView`가 받습니다.
2. **정산 멱등**: [정산 시작]의 멱등은 AsyncStorage 맵이 아니라 `Session.lateBetId` + 메모리 맵으로 했습니다. 세션을 지우면 연결도 같이 사라집니다.
3. **공유 토글 저장**: 약속별 공유 토글은 P0에서 메모리에만 있습니다(P1에 AsyncStorage).
4. **웹 백그라운드**: 웹에서 탭·패널이 가려져 있으면 AppState가 background로 잡혀 폴링이 멈춥니다(의도한 동작). 프리뷰에서 첫 로드가 몇 초 늦을 수 있습니다.
5. **공통 금지 사항**
   - `Alert.alert` 금지 → `confirmDialog` / `alertDialog`.
   - 이모지 금지.
   - 새 색 금지. 잃는 포인트만 `colors.danger`이고, 오류 문구도 `colors.text`로 그립니다.
   - 용어는 '내기'·'건 포인트'.
6. **`INVITE_PAGE_URL`**: domain의 잠정값 그대로입니다.
7. **9/18 계약 변경에서 명세를 채운 것([rules-client] 판단, 오너 원문에 없던 것)**
   - `claimSlot` 에 `consent`(동의 2개) 인자를 남겼다 — 위치 제공 동의·연령 확인은 법적 기록이라 뺄 수 없다.
   - **'마감'의 뜻**: 시작 마감·참여 마감·미수락 삭제·notStarted 무효의 기준은 **약속 시각(`meetAtMs`)**, 체크인·위치 공개·정산의 기준은 **`closeMs`**(전액 몰수 + 30분 꼬리). 오너 원문의 "마감 전이면 언제든 시작"·"마감에 자동 무효"·"마감까지 수락 가능"은 모두 약속 시각으로 읽었다 — 약속 시각이 지난 뒤 시작을 허용하면 그 순간 이미 전원 지각이라 의미가 없고, 참여 마감도 원래 약속 시각이었기 때문.
   - notStarted 무효는 정산 함수(`settle`)의 세 번째 조건으로 넣었고 모든 RPC 앞 tick 이 그 조건을 검사한다. 무효된 약속의 참가자 행은 전원 `noShow`·0·0 으로 채워 `resultModel` 의 엔진 대조와 어긋나지 않게 했다. stake 0 이면 status 는 `settled`(기존 규칙: voided 는 건 포인트가 있을 때만), `voidReason` 은 `notStarted` 로 남긴다 — [result] 는 `voidReason === 'notStarted'` 에 "주최자가 시작하지 않아 무효예요. 건 포인트는 모두 돌려드렸어요." 같은 문구를 붙이면 된다(지금은 `VOID_OTHER_TEXT`).
   - `start` 는 version 을 올리지 않는다(조건 변경이 아니다). 시작 후 시간을 미뤄도 `startedAtMs` 는 그대로다.
   - 시작 후 취소는 혼자일 때만(기존 '혼자면 언제든' 유지). 시작 후 미수락 이름은 명단에 남아 약속 시각까지 들어올 수 있고, 주최자가 지울 수는 없다(명단 동결).
   - `leave` 는 이름을 명단에 빈 칸으로 남기고, `kick` 은 명단에서도 지운다(차단 기본).
   - 걸 포인트 인상이 어느 참가자의 포인트 부족으로 막히면 그 사람을 내보내지 않고 변경 전체를 거절한다(`LB_INSUFFICIENT_POINTS`, detail = 닉네임).
   - 변경 배너의 '마지막으로 본 version' 은 처음 그 약속을 읽은 version 이 기준이고, live 모드에서는 캐시에 같이 저장한다.
   - `closeMs`(체크인 마감·정산 기준)는 `closeAtMs` 를 그대로 따르므로 30분 꼬리만큼 같이 늦어진다. 꼬리 안에 온 사람은 '지각(전액)'.
   - 홈 배지에서 [오늘]을 뺐다(오너 목록은 네 가지뿐). 열린 약속은 항상 [모이는 중]/[진행 중]/[정산 확인 중] 중 하나다(`homeBadge` 가 null 을 돌려주지 않는다). 대기실 폴링은 30초 → 10초.
   - **[rules-sql] 에게**: `lb_settle` 조건에 "시작 안 됨 ∧ now ≥ meet_at" 을 추가하고 `lb_get_live`·`lb_ping`(또는 조회 앞)에서 그 조건이면 정산을 부르면 fake 와 같은 타이밍이 된다. `scripts/parity.ts` 는 `locationShareWindow(policy, deadline).endMs` 대신 `closeAtMs(policy, deadline)` 를 쓰면 된다.
