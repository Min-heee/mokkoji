# 약속 내기 P0 — 진행 메모 (2026-09-17 중단 지점)
설계서: `docs/appointment-bet-design.md`. 이 파일은 P0 구현 워크플로를 중간에 멈춘 시점의 인수인계 메모다.
## 상태
- 완료: P0-a 도메인 모듈 6개, Supabase SQL·테스트·스크립트 이식, Foundation(mode·api·fakeApi·Context·useLive·화면 골격)
- **미완**: 화면 5묶음(create/join/waiting/live/result) — 병렬 구현 9분째에 중단. 일부 파일은 상당히 채워졌고(`app/j/[code].tsx`, `WaitingView`, `LiveView`, `ArrivedView`, `ResultView`, `PendingView`), `app/late/new.tsx`·`app/late/points.tsx`·홈(`app/index.tsx`) 섹션은 골격 그대로다. `app/late/zz-live-harness.tsx`는 live 담당의 임시 하네스 — 통합 때 지운다.
- 안 한 것: 통합(번들 검증·흐름 연결), 적대적 리뷰, 수정, 웹 프리뷰 실클릭 검증
- 중단 시점 게이트: typecheck 통과, 테스트 348개 통과

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

**`latePhase.ts`** — foundation이 DTO를 맞춰야 하는 구조 타입이 여기 있습니다. `lb_get_live` 페이로드의 부분집합이며, 필드가 더 있어도 됩니다.
- 타입:
  - `LateAppointmentStatus` = `'open' | 'settled' | 'voided' | 'canceled'`
  - `LateMemberState` = `'active' | 'pending'`
  - `LatePhaseAppointment` = `{ status, meetAtMs, shareStartMs, closeMs, policy: LatePolicy }`
  - `LatePhaseParticipant` = `{ userId, state, arrivedAtMs: number | null }`
  - `LatePhaseInput` = `{ myUserId, myState, settlePending, appointment, participants }`
  - `LatePhase` = `pending | waiting | live | overtime | arrived | settling | settled | voided | canceled`
- 함수:
  - `phase(live, serverNowMs)`
  - `myParticipant(live)`
  - `onTimeUntilMs(appt)`
  - `isLocked(appt, now)`
  - `isCheckInOpen(appt, now)`
  - `lateTimes(policy, meetAtMs) → { shareStartMs, closeMs }` — SQL `lb_close_at`과 같은 식이며 `locationShareWindow`에 위임합니다.
  - `locksImmediately(policy, meetAtMs, now)`
  - `isClosedPhase(p)`
  - `pollIntervalMs(p)` — 대기실 30초, 나머지 5초, 닫힌 단계는 null.
  - `allActiveArrived(participants)`

**`latePresets.ts`**
- 상수:
  - `POLICY_LIMITS` — 서버 CHECK와 같은 범위입니다.
  - `FULL_FORFEIT_CAP_MINUTES` = 180
  - `START_BALANCE` = 1000
  - `MAX_STAKE_POINTS` = 300
  - `STAKE_CHOICES` = [0, 50, 100, 200, 300]
  - `GRACE_CHOICES` = [0, 5, 10]
  - `RADIUS_CHOICES` = [50, 100, 200]
  - `SHARE_BEFORE_CHOICES` = [30, 60, 120]
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
  - `describePolicy(policy, meetAtMs, tz = 'Asia/Seoul')`
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
2. **phase 우선순위**는 닫힌 status → pending → settling(`settlePending` 또는 now > closeMs) → arrived → waiting → live/overtime 순입니다. `serverNowMs`가 NaN이면 시각 비교 없이 `waiting`(또는 서버 플래그에 따라 `settling`)으로 둡니다.
3. **`describePolicy`는 문자열이 아니라 객체를 돌려줍니다.** "각 선택 아래 문장" 요구에 맞춰 `stake`, `penalty`, `example`, `full`, `close`, `grace`, `radius`, `share`, `lines[]`와 `fullForfeitAtMs`, `fullLateMinutes`, `shareStartMs`, `closeMs`를 담았습니다. 다른 시간대 약속을 위해 세 번째 인자 `tz`(기본 서울)도 추가했습니다.
4. **`validatePolicy`는 `{ ok, issues: { field, message }[] }`를 돌려줍니다.** boolean만 필요하면 `isValidPolicy`를 쓰면 됩니다.
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

## Foundation 계약서 (화면 담당이 지켜야 할 타입·props 계약)

토대([foundation])를 끝냈고 게이트를 통과했습니다. `npm run typecheck` 오류 0, `npm test` 348개 전부 통과입니다(기존 214개 + domain 100개 + 새 34개).

검증한 것:
- **릴리스 번들**: `expo export --platform ios --platform web`이 성공했습니다. 웹 릴리스 JS에 가짜 서버 코드(`FAKE2222`, `FakeServer`)가 0건임을 확인했고, iOS `.hbc` 번들은 내용을 열어 보지 않았습니다(개발 번들에서만 `require`됩니다).
- **웹 프리뷰(fake 모드)**: 닉네임 입력 → 약속 생성 → 대기실 → 봇 참여 → 공개 시작으로 점프(`live`) → 내 위치를 목적지로 → 마감 +1분 → `settled`까지 눈으로 확인했습니다. `arrived` 단계는 바로 다음 조작으로 넘어가서 화면을 따로 보지는 않았습니다.
- **off 모드**: Provider가 children만 통과시키는 구조이고, 화면으로는 확인하지 않았습니다.

커밋은 하지 않았고, 소유 파일 외에는 `src/storage/store.test.ts`에 테스트 1건만 추가했습니다.

# 화면 담당용 계약서

## 0. 실행

- fake 모드: `cd /Users/byungheemin/.openclaw/workspace/nbbang && EXPO_PUBLIC_LATEBET_MODE=fake npx expo start --web --port <각자 포트>`. `.env.local`은 만들지 않았습니다. 참고는 `.env.example`.
- 모드 규칙은 `src/lateBet/modeRule.ts`(테스트 있음)에 있고 `src/lateBet/mode.ts`가 상수를 냅니다: `LATEBET_MODE`, `LATEBET_ENABLED`, `LATEBET_FAKE`.
- 화면은 `useLateBet().enabled`로만 분기합니다. off면 약속 UI를 아무것도 그리지 않습니다.

## 1. 파일 (전부 `/Users/byungheemin/.openclaw/workspace/nbbang/` 아래)

- **`src/lateBet/`**
  - `types.ts`, `api.ts`, `errors.ts`
  - `modeRule.ts`(+test), `mode.ts`
  - `fakeApi.ts`(+test)
  - `serverClock.ts`(+test), `useServerNow.ts`
  - `LateBetContext.tsx`, `useLive.ts`, `useArrivalReporter.ts`
  - `startSettlement.ts`, `notifications.ts`
- **`src/lateBet/screens/`**
  - `props.ts` — props 계약. 고치지 마세요.
  - `NicknameGate.tsx`, `FakeDevPanel.tsx` — 완성본입니다.
  - `PendingView.tsx`, `WaitingView.tsx`, `LiveView.tsx`, `ArrivedView.tsx`, `ResultView.tsx`, `LocationPrimer.tsx` — 골격입니다.
- **`src/ui/`**: `MapPane.tsx`(완성), `PlacePicker.tsx`(골격)
- **`app/`**
  - `app/late/[id]/index.tsx` — 완성된 컨테이너입니다.
  - `app/late/new.tsx`, `app/late/place.tsx`, `app/late/points.tsx`, `app/j/[code].tsx`, `app/j/index.tsx` — 골격입니다.
  - `app/_layout.tsx` — `LateBetProvider` + `Stack.Screen` 6개(한국어 제목).
- 설계서 목록에 없던 추가 파일: `modeRule.ts`, `useServerNow.ts`, `screens/props.ts`, `screens/NicknameGate.tsx`.

## 2. 타입 (`@/lateBet/types`)

- `LbPing`: `{ serverNowMs, minBuild, iosUrl, androidUrl }`
- `LbProfile`: `{ userId, nickname, balance }`
- `LbAppointment`
  - `id`, `inviteCode: string | null`(승인 대기자에게는 null), `hostId`, `title`
  - `localAt`, `tz`, `meetAtMs`, `shareStartMs`, `closeMs`
  - `placeName`, `placeNote`, `placeLat`, `placeLng`
  - `status: 'open' | 'settled' | 'voided' | 'canceled'`, `voidReason`, `version`, `joinClosed`
  - `policy: LatePolicy`
- `LbCreateInput`: `{ title, localAt: 'YYYY-MM-DDTHH:mm', tz, placeName, placeNote, lat, lng, policy, consent, tzConfirmed? }`
- `LbUpdateInput`: `{ localAt, tz, placeName, lat, lng, policy, tzConfirmed? }`
- `LbInvitePreview`
  - 약속 필드
  - `needsApproval`, `serverNowMs`, `memberCount`
  - `nicknames[]` — 내가 활성 멤버일 때만 채워집니다.
  - `myState: 'active' | 'pending' | null`
  - `myBalance: number | null`
- `LbJoinResult`: `{ appointmentId, state }`
- `LbReportInput`: `{ lat, lng, accuracyM: number | null, mocked?, share? }`
- `LbReportResult`: `{ arrived, reason, arrivedAtMs, distanceM, serverNowMs }`
  - `reason`: `null | 'closed' | 'pending' | 'already_arrived' | 'not_open' | 'bad_position' | 'mocked' | 'low_accuracy' | 'outside'`
- `LbLiveParticipant`
  - `userId`, `nickname`, `state`, `joinedAtMs`
  - `arrivedAtMs`, `arrivalMethod: 'gps' | 'vouch' | null`, `arrivalDistanceM`, `arrivalAccuracyM`, `vouchedBy`
  - `resultStatus: 'onTime' | 'late' | 'noShow' | null`, `forfeited`, `received`
  - `lastSeenMs`
  - `location: { lat, lng, accuracyM, updatedAtMs, distanceM } | null`
- `LbLive`: `{ serverNowMs, myUserId, myState, myBalance, settlePending, appointment, participants[] }`
  - `participants`는 (joinedAt, userId) 순입니다. 승인 대기자에게는 자기 행만 옵니다.
  - `latePhase.LatePhaseInput`과 `toSession.ToSessionLive`를 구조적으로 만족하므로 그대로 넘기면 됩니다.
- `LbMyAppointment`
  - `id`, `title`, `localAt`, `tz`, `meetAtMs`, `shareStartMs`, `closeMs`, `placeName`
  - `status`, `policy`, `hostId`, `isHost`, `myState`
  - `memberCount`, `pendingCount`
- `LbLedgerEntry`
  - `id`
  - `kind: 'grant' | 'relief' | 'hold' | 'refund' | 'payout'`
  - `amount`(부호 있음), `balanceAfter`
  - `appointmentId`, `appointmentTitle`
  - `reason: 'signup' | 'topup' | 'leave' | 'canceled' | 'kicked' | 'policy_change' | null`
  - `reliefFor`, `createdAtMs`

## 3. `LateBetApi` (`@/lateBet/api`)

- 전부 Promise이고, 실패는 항상 `LateBetError`입니다.
- 화면은 `useLateBet().api`로 받습니다. `getLateBetApi()`를 직접 부르지 마세요.

```ts
// 세션
restoreSession(): Promise<string | null>
ensureSignedIn(): Promise<string>

// RPC 16개 (설계서 §2.3 번호)
ping(): Promise<LbPing>
ensureProfile(nickname): Promise<LbProfile>
createAppointment(input: LbCreateInput): Promise<LbAppointment>
peekInvite(code): Promise<LbInvitePreview>
join(code, nickname, version, consent): Promise<LbJoinResult>   // 멱등
approve(appointmentId, targetUserId): Promise<void>
leave(appointmentId): Promise<void>
kick(appointmentId, targetUserId, ban = true): Promise<void>
setJoinClosed(appointmentId, closed): Promise<void>
updateMemo(appointmentId, title, placeNote): Promise<void>
updateAppointment(appointmentId, input: LbUpdateInput): Promise<LbAppointment>
cancel(appointmentId): Promise<void>
reportLocation(appointmentId, input: LbReportInput): Promise<LbReportResult>
stopSharing(appointmentId): Promise<void>
vouch(appointmentId, targetUserId): Promise<void>
getLive(appointmentId): Promise<LbLive>

// 조회
getMyProfile(): Promise<LbProfile | null>
listMyAppointments(): Promise<LbMyAppointment[]>   // 열린 약속(가까운 순) → 끝난 약속(최근 순)
listLedger(limit?): Promise<LbLedgerEntry[]>       // 최신순
```

- live 모드는 P2까지 모든 호출이 `LB_NOT_CONFIGURED`로 실패하는 자리표시자입니다.

## 4. 오류 (`@/lateBet/errors`)

- `LateBetError { code, message(한국어), detail }`. 새 문구를 만들지 말고 `e.message`를 그대로 그리세요.
- 서버 코드는 §5.5 전부입니다.
- 클라이언트 코드: `LB_OFFLINE`, `LB_TIMEOUT`, `LB_NOT_CONFIGURED`, `LB_RATE_LIMITED`, `LB_CHECK_VIOLATION`(23514), `LB_RETRYABLE`, `LB_UNKNOWN`.
- 헬퍼
  - `toLateBetError(e)`, `errorMessage(code)`
  - `isTzSuspectError(e)` — 시간대 시트 → `tzConfirmed: true`로 재시도
  - `isConnectivityError(e)`, `isNotMemberError(e)`
  - `removedMessage(wasPending)`
  - `reportReasonMessage(reason, { distanceM, accuracyM, radiusM, shareStartMs, closeMs, tz })` — §5.4 문구
- 상수
  - `APPROVE_INSUFFICIENT_MESSAGE` — 수락 시 `LB_INSUFFICIENT_POINTS`가 나면 이 문구를 씁니다.
  - `REPEATED_FAILURE_MESSAGE`, `STALE_NOTICE`, `SERVER_DOWN_NOTICE`, `SETTLE_DELAYED_NOTICE`

## 5. Context — `useLateBet()` (`@/lateBet/LateBetContext`)

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

- `refresh()`는 던지지 않습니다. 홈 포커스 때와 변경 RPC 뒤에 부르세요. 마감이 지난 open 약속은 `getLive`를 한 번 불러 게으른 정산까지 합니다.
- `ensureReady()`는 익명 로그인 + ping + 로드이고, 실패하면 던집니다.
- `status === 'idle'`은 세션이 없다는 뜻입니다. 홈에는 버튼만 보이게 하세요.
- 홈은 `useFocusEffect(() => { void refresh(); })`를 쓰세요.
- `<NicknameGate>{children}</NicknameGate>`
  - 하는 일: off 안내 / `ensureReady` / 닉네임 1칸 → `ensureProfile`.
  - `late/new`와 `late/points`를 이걸로 감싸세요.
  - `j/[code]`는 자기 닉네임 칸이 있으므로 감싸지 말고 `ensureReady()` → (`profile === null`이면) `ensureProfile(nick)` → `api.join(...)`을 직접 부르세요.
- 같은 파일의 `LateBetUnavailable`은 off 모드 안내 화면입니다.

## 6. `useLive(appointmentId)` (`@/lateBet/useLive`)

```ts
{
  live: LbLive | null,
  phase: LatePhase | null,
  me, isHost, loading, error, stale, failCount,
  removed: { wasPending } | null,
  settleDelayed,
  refresh(): Promise<LbLive | null>,
}
```

- 폴링은 `pollIntervalMs(phase)`를 따릅니다(대기실 30초, 나머지 5초, 끝났으면 정지). blur·백그라운드에서 멈추고 복귀하면 즉시 1회 읽습니다.
- `phase`는 1초마다 다시 계산하지만 값이 바뀔 때만 리렌더합니다. 잠금·마감 경계를 넘으면 즉시 refetch합니다.
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
}

PendingViewProps  = LateViewProps & { onLeft(): void }
WaitingViewProps  = LateViewProps & { onLeft(): void }
LiveViewProps     = LateViewProps & { reporter: ArrivalReporter }        // phase live | overtime
ArrivedViewProps  = LateViewProps & { justArrived: boolean }
ResultViewProps   = LateViewProps & { settleDelayed: boolean }           // settling | settled | voided
LocationPrimerProps = { shareMinutesBefore, onAllow(), onLater(), busy?, permission? }
```

- named export입니다(`export function PendingView`). 이름과 시그니처를 유지하세요.
- 각 뷰가 자기 `<Screen>`(footer 포함)을 직접 그립니다.
- 컨테이너가 이미 그리는 것은 뷰에서 중복하지 마세요.
  - `FakeDevPanel`
  - 연결 끊김 띠
  - 헤더 제목
  - `canceled` 안내
  - 내보내짐·거절 안내
  - 로딩과 실패 화면
- 변경 RPC 뒤에는 `await refresh()`.
- 내가 빠지는 동작(요청 취소, 게스트 나가기) 뒤에는 `refresh` 대신 `onLeft()`를 부르세요. 안 그러면 "주최자가 내보냈어요"가 뜹니다.
- 주최자 취소는 `api.cancel` → `refresh`를 하면 컨테이너가 취소 안내를 그립니다.
- 취소하고 새로 만들기는 `cancel` 뒤에 `router.replace('/late/new?from=<id>')`.
- `ArrivalReporter`
  - 필드: `permission`, `sharing`, `setSharing(on)`, `running`, `myDistanceM`, `myAccuracyM`, `lastResult`, `error`, `checking`
  - 메서드: `checkInNow(): Promise<LbReportResult | null>`, `requestPermission()`
  - `checkInNow`는 공유가 꺼져 있으면 `share=false`로 판정만 받습니다. 도착이 찍히면 컨테이너가 `refresh`하고 `justArrived=true`로 바꿉니다.
  - P0에서 `permission`은 fake면 `'granted'`, 아니면 `'unsupported'`입니다.
- [정산 시작]
  - `findSessionForLateBet(sessions.sessions, live.appointment.id)`가 있으면 `confirmDialog('이미 만든 정산이 있어요', '열까요?', ...)`.
  - 없으면 `startSettlement({ live, selectedUserIds, sessions: useSessions() })` → `{ sessionId, existed }` → `router.replace('/session/' + sessionId)`.
  - 확인 시트의 후보 목록은 `toSession.sessionCandidates(live)`입니다.
- `notifications.ts`는 P0 무동작입니다. 참여·생성 뒤에 `ensureNotificationPermission()`과 `scheduleLateNotifications({ id, version, title, tz, meetAtMs, shareStartMs, closeMs })`를, 끝날 때 `cancelLateNotifications(id)`를 지금부터 호출해 두세요.

## 8. MapPane / PlacePicker

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

- 참여 성공(active든 pending이든) → `router.replace('/late/' + appointmentId)`. pending은 `PendingView`가 받고, 수락되면 자동으로 다음 phase로 넘어갑니다.
- 생성 성공도 같은 경로로 replace합니다.

## 10. FakeDevPanel

- `<FakeDevPanel appointmentId? onChanged? />`는 fake가 아니면 null입니다. `/late/[id]`에는 이미 붙어 있습니다.
- 홈·`/j/*`·`/late/new`에는 담당이 화면 최상단에 `<FakeDevPanel />`을 넣으세요(`Screen` 바깥, `<View style={{ flex: 1 }}>` 안).
- 기능
  - 시간: +1분, +10분, +1시간, 공개 시작, 약속 5분 전, 약속 시각, 마감 1분 전, 마감 +1분(정산)으로 점프
  - 내 위치: 목적지, 300m, 1.5km, GPS 부정확(180m), 대략적 위치(2km 오차), 모의 위치, 위치 모름
  - 봇 참여: 제시간, 지각, 지하(보증 필요), 노쇼, 앱 닫음. 잠금 전이면 바로 참여, 잠금 후면 참여 요청이 됩니다.
  - 참여 요청 만들기: 잠금 전에도 pending을 강제로 만드는 개발용 우회입니다.
  - 봇 한 명 도착
  - 연결 끊기(`LB_OFFLINE`), 초기화
- 데모 초대 코드(`FAKE_DEMO_CODES`)
  - `FAKE2222`: 바로 참여(지수·현우·태호, 3시간 뒤)
  - `FAKE3333`: 잠김 → 참여 요청 → 봇 주최자가 8초 뒤 자동 수락
  - `FAKE4444`: 참여 마감
  - `FAKE5555`: 취소됨
- 가짜 서버의 '나'는 `fake-me`이고 메모리뿐이라 리로드하면 초기화됩니다.
- 프로덕션 코드에서 `fakeApi`나 `fakeDevice`를 정적으로 import하지 마세요(릴리스 번들에 실립니다).

## 11. fakeApi가 지키는 규칙 (테스트로 고정)

- **잠금**: 잠금 = `shareStartMs`. 잠금 전 참여는 즉시 에스크로, 잠금 후는 pending입니다. pending은 에스크로·타인 행·좌표·초대 코드가 없습니다.
- **수락·거절·차단**: 수락 순간 hold가 걸립니다. 거절 + 차단이면 `LB_INVITE_NOT_FOUND`입니다.
- **조건 동결**: 다른 행이 있으면(pending 포함) `LB_EDIT_LOCKED`. 혼자면 환불 → 재에스크로 → `version + 1`. 옛 version으로 참여하면 `LB_APPT_CHANGED`.
- **잠금 후 금지**: 잠금 후에는 나가기·강퇴·취소가 막힙니다. 주최자가 혼자면 언제든 취소할 수 있습니다.
- **부족분 채움**: 부족분은 `relief(topup)`으로 채우고, 가진 것 전부가 1000 이상이면 `LB_INSUFFICIENT_POINTS`입니다.
- **판정표**: 체크인 판정은 설계서 표의 순서를 그대로 따릅니다.
- **좌표 규칙**: 3분 뒤 숨김(`lastSeenMs`는 유지), 10분 뒤 삭제. 도착·`share=false`·`mocked`·정확도 1000m 초과·`stopSharing`이면 즉시 삭제.
- **보증 도착**: GPS 도착자만 가능하고 본인은 불가합니다. 시각은 `first_near_at`.
- **정산**
  - 조건: 마감 + 15초 또는 (전원 도착 ∧ 약속 시각 이후).
  - 그 사이에는 `settlePending`입니다.
  - 제시간 0명이면 `voided`(noWinner)입니다.
  - stake 0이면 원장 없이 `settled`입니다.
  - 남은 pending은 삭제됩니다.
  - 멱등하고, 약속별 합계는 0이며, `server.audit()`이 빈 배열입니다.

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
