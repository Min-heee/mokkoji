/**
 * Conformance 시나리오 — 같은 스크립트를 fakeApi 와 (로컬 PG + supabaseApi) 에 한 걸음씩 돌린다(duo.ts).
 * 시각은 전부 가상 시각(ms). 경계에서 1분 넘게 떨어진 시각만 쓴다(travelTo 는 ±30초).
 */
import { offsetPoint } from '../../src/lateBet/fakeApi';
import type { LatePolicy, LbCreateInput, LbEditPatch } from '../../src/lateBet/types';
import type { Duo, Side } from './duo';

const MIN = 60_000;
const TZ = 'Asia/Seoul';
const PLACE = { lat: 37.49808, lng: 127.02761 };
const FAR = offsetPoint(PLACE.lat, PLACE.lng, 2000, 0);
const NEAR30 = offsetPoint(PLACE.lat, PLACE.lng, 30, Math.PI);
const NEW_PIN = offsetPoint(PLACE.lat, PLACE.lng, 40, Math.PI / 2);

const pol = (stake: number, penaltyPerUnit = 10, unitMinutes = 5, graceMinutes = 0, radiusM = 100): LatePolicy => ({
  stake,
  radiusM,
  unitMinutes,
  penaltyPerUnit,
  graceMinutes,
});

function input(s: Side, meetV: number, p: Partial<LbCreateInput> & { policy: LatePolicy; invitees: string[] }): LbCreateInput {
  return {
    title: '약속',
    localAt: s.localAt(meetV, p.tz ?? TZ),
    tz: TZ,
    placeName: '강남역',
    placeNote: '',
    lat: PLACE.lat,
    lng: PLACE.lng,
    consent: true,
    ...p,
  };
}

async function create(s: Side, user: string, label: string, meetV: number, p: Partial<LbCreateInput> & { policy: LatePolicy; invitees: string[] }) {
  const a = await s.api(user).createAppointment(input(s, meetV, p));
  s.bind(label, a);
  return a;
}

async function version(s: Side, user: string, label: string): Promise<number> {
  return (await s.api(user).getLive(s.appt(label))).appointment.version;
}

async function peekVersion(s: Side, user: string, label: string): Promise<number> {
  return (await s.api(user).peekInvite(s.code(label))).version;
}

async function claim(s: Side, user: string, label: string, name: string) {
  const v = await peekVersion(s, user, label);
  return s.api(user).claimSlot(s.appt(label), name, v, true);
}

async function edit(s: Side, user: string, label: string, patch: LbEditPatch) {
  return s.api(user).edit(s.appt(label), patch, await version(s, user, label));
}

const at = (p: { lat: number; lng: number }, accuracyM: number | null = 10, extra: { mocked?: boolean; share?: boolean } = {}) => ({
  lat: p.lat,
  lng: p.lng,
  accuracyM,
  ...extra,
});

/** 끝 상태: 멤버별 getLive, 전원 원장·프로필, 홈 목록 */
async function finalState(duo: Duo, members: Record<string, string[]>, everyone: string[]) {
  for (const [label, users] of Object.entries(members)) {
    for (const u of users) await duo.step(`끝: ${u} getLive(${label})`, (s) => s.api(u).getLive(s.appt(label)));
  }
  for (const u of everyone) {
    await duo.step(`끝: ${u} listMyAppointments`, (s) => s.api(u).listMyAppointments());
    await duo.step(`끝: ${u} listLedger`, (s) => s.api(u).listLedger());
    await duo.step(`끝: ${u} getMyProfile`, (s) => s.api(u).getMyProfile());
  }
  await duo.audits();
}

// ───────────────────────── S1 본 흐름 ─────────────────────────
export async function s1MainFlow(duo: Duo): Promise<void> {
  const U = ['H', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'];
  await duo.addUsers(U);
  const nick: Record<string, string> = { H: '주최', G1: '지수폰', G2: '현우', G3: '태호', G4: '민지', G5: '다섯', G6: '서연', G7: '가은', G8: '팔번' };
  for (const u of U) await duo.step(`${u} ensureProfile`, (s) => s.api(u).ensureProfile(nick[u]));

  // 준비: G4 가 앞선 약속 P 에서 노쇼로 300P 를 잃는다(→ '가진 것 전부' < 1000 이라 나중에 자동 채움 대상)
  const mP = duo.minuteAfter(duo.vnow() + 10 * MIN);
  await duo.step('P: G5 생성(300P, 명단 사번)', (s) => create(s, 'G5', 'P', mP, { policy: pol(300, 100), invitees: ['사번'] }));
  await duo.step('P: G4 사번 수락', (s) => claim(s, 'G4', 'P', '사번'));
  await duo.step('P: G5 시작', (s) => s.api('G5').start(s.appt('P')));
  await duo.travelTo(mP - 2 * MIN);
  await duo.step('P: G5 도착(약속 2분 전)', (s) => s.api('G5').reportLocation(s.appt('P'), at(PLACE)));
  await duo.travelTo(mP + 42 * MIN); // close = +40
  await duo.step('P: 마감 뒤 G5 getLive → 정산(G4 노쇼)', (s) => s.api('G5').getLive(s.appt('P')));

  // G4: 잔액 50 (Q1·Q2 300 + Q3 50 을 걸어 둠, 가진 것 전부 700). G8: 잔액 100 (Q4~Q6 300×3, 가진 것 전부 1000)
  const far = duo.minuteAfter(duo.vnow() + 2 * 24 * 60 * MIN);
  await duo.step('G4 Q1 생성(300)', (s) => create(s, 'G4', 'Q1', far, { policy: pol(300, 100), invitees: [] }));
  await duo.step('G4 Q2 생성(300)', (s) => create(s, 'G4', 'Q2', far, { policy: pol(300, 100), invitees: [] }));
  await duo.step('G4 Q3 생성(50)', (s) => create(s, 'G4', 'Q3', far, { policy: pol(50, 10), invitees: [] }));
  for (const q of ['Q4', 'Q5', 'Q6']) await duo.step(`G8 ${q} 생성(300)`, (s) => create(s, 'G8', q, far, { policy: pol(300, 100), invitees: [] }));

  // 본 약속 A
  let mA = duo.minuteAfter(duo.vnow() + 120 * MIN);
  const names = ['지수', '현우', '태호', '민지', '서연', '하준', '팔번', '칠번'];
  await duo.step('A: H 생성(100P, 명단 8)', (s) =>
    create(s, 'H', 'A', mA, { title: '금요일 곱창', policy: pol(100), invitees: [...names, '주최', ' 지수 '] }),
  );
  await duo.step('A: H listMyAppointments', (s) => s.api('H').listMyAppointments());
  await duo.step('A: G1 미리보기(비멤버)', (s) => s.api('G1').peekInvite(s.code('A')));
  await duo.step('A: 없는 코드 미리보기', (s) => s.api('G1').peekInvite('ZZZZZZZZ'));
  await duo.step('A: G1 동의 없이 수락', async (s) =>
    s.api('G1').claimSlot(s.appt('A'), '지수', await peekVersion(s, 'G1', 'A'), false),
  );
  await duo.step('A: G1 옛 version 으로 수락', async (s) =>
    s.api('G1').claimSlot(s.appt('A'), '지수', (await peekVersion(s, 'G1', 'A')) + 1, true),
  );
  await duo.step('A: G1 명단에 없는 이름', (s) => claim(s, 'G1', 'A', '없는사람'));
  await duo.step('A: G1 13자 이름', (s) => claim(s, 'G1', 'A', '가나다라마바사아자차카타파'));
  await duo.step('A: G1 지수 수락', (s) => claim(s, 'G1', 'A', ' 지수'));
  await duo.step('A: G1 다시 수락(멱등)', (s) => claim(s, 'G1', 'A', '현우'));
  await duo.step('A: G2 지수(남이 고름)', (s) => claim(s, 'G2', 'A', '지수'));
  await duo.step('A: G2 현우 수락', (s) => claim(s, 'G2', 'A', '현우'));
  await duo.step('A: G3 태호 수락', (s) => claim(s, 'G3', 'A', '태호'));
  await duo.step('A: G4 민지 수락(잔액 50 → 50 채움)', (s) => claim(s, 'G4', 'A', '민지'));
  await duo.step('A: G4 원장', (s) => s.api('G4').listLedger(3));
  await duo.step('A: G8 팔번 수락(잔액 100 → 0)', (s) => claim(s, 'G8', 'A', '팔번'));
  await duo.step('A: 걸 포인트 100→150 (G8 부족)', (s) => edit(s, 'H', 'A', { policy: pol(150) }));
  await duo.step('A: G8 나가기', (s) => s.api('G8').leave(s.appt('A')));
  await duo.step('A: 걸 포인트 100→150 (G4 자동 채움)', (s) => edit(s, 'H', 'A', { policy: pol(150) }));
  await duo.step('A: 걸 포인트 150→120 (차액 환불)', (s) => edit(s, 'H', 'A', { policy: pol(120) }));
  await duo.step('A: G4 원장(채움·인상·인하)', (s) => s.api('G4').listLedger(6));
  await duo.step('A: G3 나가기', (s) => s.api('G3').leave(s.appt('A')));
  await duo.step('A: G6 서연 수락', (s) => claim(s, 'G6', 'A', '서연'));
  await duo.step('A: H 가 G6 내보내기(차단)', (s) => s.api('H').kick(s.appt('A'), s.uid('G6')));
  await duo.step('A: G6 미리보기(차단됨)', (s) => s.api('G6').peekInvite(s.code('A')));
  await duo.step('A: G6 다시 수락(차단됨)', (s) => s.api('G6').claimSlot(s.appt('A'), '서연', 1, true));
  await duo.step('A: 명단 +가은 −하준', (s) => s.api('H').editInvitees(s.appt('A'), { add: ['가은'], remove: ['하준'] }));
  await duo.step('A: 명단 −지수(들어온 이름)', (s) => s.api('H').editInvitees(s.appt('A'), { remove: ['지수'] }));
  await duo.step('A: H 나가기', (s) => s.api('H').leave(s.appt('A')));
  await duo.step('A: 시작 전 G1 위치 보고', (s) => s.api('G1').reportLocation(s.appt('A'), at(PLACE)));
  await duo.step('A: 시작 전 보증', (s) => s.api('H').vouch(s.appt('A'), s.uid('G1')));
  await duo.step('A: G1 시작(주최자 아님)', (s) => s.api('G1').start(s.appt('A')));
  await duo.step('A: 시작 전 G2 getLive', (s) => s.api('G2').getLive(s.appt('A')));

  // R3: 친구가 있을 때 걸 포인트를 바꿨다(150→120) → 5분 동안 시작 불가
  await duo.step('A: 조건 바꾼 직후 H 시작(쿨다운)', (s) => s.api('H').start(s.appt('A')));
  await duo.travelTo(duo.vnow() + 6 * MIN);
  await duo.step('A: H 시작', (s) => s.api('H').start(s.appt('A')));
  await duo.step('A: H 다시 시작', (s) => s.api('H').start(s.appt('A')));
  await duo.step('A: 시작 후 G1 나가기', (s) => s.api('G1').leave(s.appt('A')));
  await duo.step('A: 시작 후 G2 내보내기', (s) => s.api('H').kick(s.appt('A'), s.uid('G2')));
  await duo.step('A: 시작 후 명단 편집', (s) => s.api('H').editInvitees(s.appt('A'), { add: ['새이름'] }));
  await duo.step('A: 시작 후 취소', (s) => s.api('H').cancel(s.appt('A')));
  await duo.step('A: 시작 후 걸 포인트 변경', (s) => edit(s, 'H', 'A', { policy: pol(120, 20) }));
  await duo.step('A: 시작 후 앞당기기', (s) => edit(s, 'H', 'A', { localAt: s.localAt(mA - 10 * MIN), tz: TZ }));
  await duo.step('A: 시작 후 4시간 미루기', (s) => edit(s, 'H', 'A', { localAt: s.localAt(mA + 240 * MIN), tz: TZ }));
  await duo.step('A: 시작 후 제목·메모', (s) => s.api('H').updateMemo(s.appt('A'), '금요일 곱창 (2차)', '2번 출구'));
  await duo.step('A: 시작 후 15분 미루기', (s) => edit(s, 'H', 'A', { localAt: s.localAt(mA + 15 * MIN), tz: TZ }));
  mA += 15 * MIN;
  await duo.step('A: 시작 후 G3 태호 다시 수락', (s) => claim(s, 'G3', 'A', '태호'));
  await duo.step('A: 시작 후 G7 가은 수락', (s) => claim(s, 'G7', 'A', '가은'));

  await duo.travelTo(mA - 20 * MIN);
  await duo.step('A: G1 멀리(2km)', (s) => s.api('G1').reportLocation(s.appt('A'), at(FAR, 15)));
  await duo.step('A: G2 반경 안·정확도 150', (s) => s.api('G2').reportLocation(s.appt('A'), at(NEAR30, 150)));
  await duo.step('A: G3 모의 위치', (s) => s.api('G3').reportLocation(s.appt('A'), at(PLACE, 5, { mocked: true })));
  await duo.step('A: G7 좌표 이상', (s) => s.api('G7').reportLocation(s.appt('A'), at({ lat: 200, lng: 127 })));
  await duo.step('A: G4 공유 끔(멀리)', (s) => s.api('G4').reportLocation(s.appt('A'), at(FAR, 20, { share: false })));
  await duo.step('A: H getLive(위치 공개)', (s) => s.api('H').getLive(s.appt('A')));
  await duo.step('A: 핀 옮기기(40m)', (s) => edit(s, 'H', 'A', { placeName: '강남역 새 가게', lat: NEW_PIN.lat, lng: NEW_PIN.lng }));

  await duo.travelTo(mA - 10 * MIN);
  await duo.step('A: H 도착(새 핀)', (s) => s.api('H').reportLocation(s.appt('A'), at(NEW_PIN)));
  await duo.step('A: H 가 G2 보증', (s) => s.api('H').vouch(s.appt('A'), s.uid('G2')));
  await duo.step('A: G1 이 G3 보증(G1 미도착)', (s) => s.api('G1').vouch(s.appt('A'), s.uid('G3')));
  await duo.step('A: H 자기 보증', (s) => s.api('H').vouch(s.appt('A'), s.uid('H')));
  await duo.step('A: H 다시 보고(already_arrived)', (s) => s.api('H').reportLocation(s.appt('A'), at(NEW_PIN)));

  await duo.travelTo(mA - 3 * MIN);
  await duo.step('A: 약속 3분 전 장소 이름만(같은 localAt 동봉)', (s) =>
    edit(s, 'H', 'A', { localAt: s.localAt(mA), tz: TZ, placeName: '강남역 새 가게 2층' }),
  );
  await duo.travelTo(mA + 7 * MIN);
  await duo.step('A: G1 7분 지각 도착', (s) => s.api('G1').reportLocation(s.appt('A'), at(NEW_PIN)));
  await duo.step('A: 약속 뒤 G5 가 팔번 수락(비멤버, 시각 지남)', (s) => s.api('G5').claimSlot(s.appt('A'), '팔번', 99, true));
  await duo.step('A: 약속 뒤 G1 getLive', (s) => s.api('G1').getLive(s.appt('A')));
  await duo.travelTo(mA + 60 * MIN);
  await duo.step('A: G4 60분 지각 도착', (s) => s.api('G4').reportLocation(s.appt('A'), at(NEW_PIN)));
  await duo.travelTo(mA + 87 * MIN); // close = +85
  await duo.step('A: 마감 뒤 G2 getLive → 정산', (s) => s.api('G2').getLive(s.appt('A')));
  await duo.step('A: 정산 뒤 수정', (s) => edit(s, 'H', 'A', { placeName: 'x' }));
  await duo.step('A: 정산 뒤 보고', (s) => s.api('G3').reportLocation(s.appt('A'), at(NEW_PIN)));
  await duo.step('A: 정산 뒤 보증', (s) => s.api('H').vouch(s.appt('A'), s.uid('G3')));
  await duo.step('A: 정산 뒤 취소', (s) => s.api('H').cancel(s.appt('A')));
  await duo.step('A: 정산 뒤 제목', (s) => s.api('H').updateMemo(s.appt('A'), 'x', ''));
  await duo.step('A: 비멤버 G5 getLive', (s) => s.api('G5').getLive(s.appt('A')));
  await duo.step('A: 비멤버 G5 미리보기', (s) => s.api('G5').peekInvite(s.code('A')));
  await finalState(duo, { A: ['H', 'G1', 'G2', 'G3', 'G4', 'G7'], P: ['G5'] }, U);
}

// ───────────────────────── S2 시작 안 함 → notStarted 무효 ─────────────────────────
export async function s2NotStarted(duo: Duo): Promise<void> {
  const U = ['H', 'G1', 'G2', 'G3'];
  await duo.addUsers(U);
  for (const u of U) await duo.step(`${u} ensureProfile`, (s) => s.api(u).ensureProfile(`${u}닉`));
  const m = duo.minuteAfter(duo.vnow() + 30 * MIN);
  await duo.step('B: 생성(100P, 하나·둘·셋)', (s) => create(s, 'H', 'B', m, { policy: pol(100), invitees: ['하나', '둘', '셋'] }));
  await duo.step('C: 생성(0P)', (s) => create(s, 'H', 'C', m, { policy: pol(0, 0), invitees: ['하나'] }));
  await duo.step('B: G1 하나', (s) => claim(s, 'G1', 'B', '하나'));
  await duo.step('B: G2 둘', (s) => claim(s, 'G2', 'B', '둘'));
  await duo.step('C: G1 하나', (s) => claim(s, 'G1', 'C', '하나'));
  await duo.travelTo(m - 5 * MIN);
  await duo.step('B: 시작 전 보고(not_open)', (s) => s.api('G1').reportLocation(s.appt('B'), at(PLACE)));
  await duo.step('B: 시작 전 getLive', (s) => s.api('G2').getLive(s.appt('B')));
  await duo.travelTo(m + 2 * MIN);
  await duo.step('B: 약속 뒤 G3 미리보기(비멤버, 게으른 무효)', (s) => s.api('G3').peekInvite(s.code('B')));
  await duo.step('B: 약속 뒤 G3 셋 수락', (s) => s.api('G3').claimSlot(s.appt('B'), '셋', 1, true));
  await duo.step('B: 약속 뒤 시작', (s) => s.api('H').start(s.appt('B')));
  await duo.step('B: 약속 뒤 수정', (s) => s.api('H').edit(s.appt('B'), { placeName: 'x' }, 1));
  await duo.step('B: 약속 뒤 명단 편집', (s) => s.api('H').editInvitees(s.appt('B'), { add: ['넷'] }));
  await duo.step('B: 약속 뒤 보고', (s) => s.api('G1').reportLocation(s.appt('B'), at(PLACE)));
  await duo.step('B: 약속 뒤 나가기', (s) => s.api('G1').leave(s.appt('B')));
  await duo.step('B: G1 getLive(무효)', (s) => s.api('G1').getLive(s.appt('B')));
  await duo.step('C: H listMyAppointments(0P 게으른 종료)', (s) => s.api('H').listMyAppointments());
  await duo.step('C: G1 getLive', (s) => s.api('G1').getLive(s.appt('C')));
  await finalState(duo, { B: ['H', 'G1', 'G2'], C: ['H', 'G1'] }, U);
}

// ───────────────────────── S3 취소 ─────────────────────────
export async function s3Cancel(duo: Duo): Promise<void> {
  const U = ['H', 'G1', 'G2'];
  await duo.addUsers(U);
  for (const u of U) await duo.step(`${u} ensureProfile`, (s) => s.api(u).ensureProfile(`${u}닉`));
  const m = duo.minuteAfter(duo.vnow() + 45 * MIN);
  await duo.step('D: 생성(100P)', (s) => create(s, 'H', 'D', m, { policy: pol(100), invitees: ['갑', '을'] }));
  await duo.step('D: G1 갑', (s) => claim(s, 'G1', 'D', '갑'));
  await duo.step('D: G1 이 취소(주최자 아님)', (s) => s.api('G1').cancel(s.appt('D')));
  await duo.step('D: H 취소', (s) => s.api('H').cancel(s.appt('D')));
  await duo.step('D: H 다시 취소', (s) => s.api('H').cancel(s.appt('D')));
  await duo.step('D: 취소 뒤 G1 getLive', (s) => s.api('G1').getLive(s.appt('D')));
  await duo.step('D: 취소 뒤 G2 미리보기', (s) => s.api('G2').peekInvite(s.code('D')));
  await duo.step('D: 취소 뒤 G2 을 수락', (s) => claim(s, 'G2', 'D', '을'));
  await duo.step('D: 취소 뒤 보고', (s) => s.api('G1').reportLocation(s.appt('D'), at(PLACE)));
  await duo.step('D: 취소 뒤 시작', (s) => s.api('H').start(s.appt('D')));
  await duo.step('E: 혼자 생성(50P)', (s) => create(s, 'H', 'E', m, { policy: pol(50), invitees: ['병'] }));
  await duo.step('E: 혼자 시작', (s) => s.api('H').start(s.appt('E')));
  await duo.step('E: 시작 후 혼자면 취소 가능', (s) => s.api('H').cancel(s.appt('E')));
  await finalState(duo, { D: ['H', 'G1'], E: ['H'] }, U);
}

// ───────────────────────── S4 입력 검증·비멤버·기타 오류 코드 ─────────────────────────
export async function s4Validation(duo: Duo): Promise<void> {
  const U = ['N1', 'N2', 'G1'];
  await duo.addUsers(U);
  await duo.step('ping', (s) => s.api('N1').ping());
  await duo.step('N1 getMyProfile(없음)', (s) => s.api('N1').getMyProfile());
  await duo.step('N1 빈 닉네임', (s) => s.api('N1').ensureProfile('  ​ '));
  await duo.step('N1 13자 닉네임', (s) => s.api('N1').ensureProfile('가나다라마바사아자차카타파'));
  const m = duo.minuteAfter(duo.vnow() + 60 * MIN);
  await duo.step('N1 프로필 없이 생성', (s) => s.api('N1').createAppointment(input(s, m, { policy: pol(100), invitees: [] })));
  await duo.step('N1 ensureProfile', (s) => s.api('N1').ensureProfile('  새내기​ '));
  await duo.step('N1 닉네임 바꾸기(두 번째 지급 없음)', (s) => s.api('N1').ensureProfile('새내기2'));
  await duo.step('N1 getMyProfile', (s) => s.api('N1').getMyProfile());
  await duo.step('N2 ensureProfile', (s) => s.api('N2').ensureProfile('둘째'));
  const bad: [string, (s: Side) => LbCreateInput][] = [
    ['동의 없음', (s) => ({ ...input(s, m, { policy: pol(100), invitees: [] }), consent: false })],
    ['5분 안', (s) => input(s, duo.minuteAfter(duo.vnow() + 2 * MIN), { policy: pol(100), invitees: [] })],
    ['91일 뒤', (s) => input(s, duo.minuteAfter(duo.vnow() + 91 * 24 * 60 * MIN), { policy: pol(100), invitees: [] })],
    ['없는 시간대', (s) => ({ ...input(s, m, { policy: pol(100), invitees: [] }), tz: 'Mars/Olympus' })],
    ['localAt 형식', (s) => ({ ...input(s, m, { policy: pol(100), invitees: [] }), localAt: '2026-13-40T25:00' })],
    ['시간대 의심', (s) => input(s, m, { policy: pol(100), invitees: [], tz: 'America/New_York' })],
    ['걸 포인트 400', (s) => input(s, m, { policy: pol(400), invitees: [] })],
    ['180분 절벽', (s) => input(s, m, { policy: pol(300, 1, 5), invitees: [] })],
    ['제목 41자', (s) => input(s, m, { policy: pol(100), invitees: [], title: 'x'.repeat(41) })],
    ['위도 200', (s) => ({ ...input(s, m, { policy: pol(100), invitees: [] }), lat: 200 })],
    ['명단 13자', (s) => input(s, m, { policy: pol(100), invitees: ['가나다라마바사아자차카타파'] })],
    ['명단 20명', (s) => input(s, m, { policy: pol(100), invitees: Array.from({ length: 20 }, (_, i) => `친구${i}`) })],
  ];
  for (const [label, mk] of bad) await duo.step(`생성 오류: ${label}`, (s) => s.api('N1').createAppointment(mk(s)));
  await duo.step('시간대 확인 후 생성(뉴욕)', (s) =>
    create(s, 'N1', 'NY', m, { policy: pol(100), invitees: [], tz: 'America/New_York', tzConfirmed: true }),
  );
  await duo.step('명단 정리(주최자·중복·대소문자)', (s) =>
    create(s, 'N1', 'V', m, { policy: pol(100), invitees: ['새내기2', '친구', ' 친구 ', 'FRIEND', 'friend', '친​구'], placeNote: '  메모  ' }),
  );
  await duo.step('V: 명단 19명 넘기기', (s) =>
    s.api('N1').editInvitees(s.appt('V'), { add: Array.from({ length: 18 }, (_, i) => `추가${i}`) }),
  );
  await duo.step('V: 수정 위도 95', (s) => edit(s, 'N1', 'V', { lat: 95, lng: PLACE.lng }));
  await duo.step('V: 수정 위도만', (s) => edit(s, 'N1', 'V', { lat: NEW_PIN.lat }));
  await duo.step('V: 수정 정책 일부(stake 만)', (s) => edit(s, 'N1', 'V', { policy: { stake: 50 } as unknown as LatePolicy }));
  await duo.step('V: 수정 바뀐 것 없음', (s) => edit(s, 'N1', 'V', { placeName: '강남역', policy: pol(100) }));
  await duo.step('V: 수정 옛 version', (s) => s.api('N1').edit(s.appt('V'), { placeName: 'y' }, 99));
  await duo.step('V: 수정 앞당기기(시작 전, 5분 안)', (s) => edit(s, 'N1', 'V', { localAt: s.localAt(duo.minuteAfter(duo.vnow() + 2 * MIN)), tz: TZ }));
  await duo.step('V: 수정 시간·장소·정책(시작 전)', (s) =>
    edit(s, 'N1', 'V', { localAt: s.localAt(m + 30 * MIN), tz: TZ, placeName: '역삼역', lat: NEW_PIN.lat, lng: NEW_PIN.lng, policy: pol(200, 20, 10, 5, 200) }),
  );
  await duo.step('V: 수정 시간대 의심(경도만 이동)', (s) => edit(s, 'N1', 'V', { lat: 40.7, lng: -74 }));
  await duo.step('V: 제목·메모(주최자 아님)', (s) => s.api('N2').updateMemo(s.appt('V'), 't', ''));
  await duo.step('V: 제목 빈칸', (s) => s.api('N1').updateMemo(s.appt('V'), '  ', ''));
  await duo.step('V: 메모 201자', (s) => s.api('N1').updateMemo(s.appt('V'), '제목', 'm'.repeat(201)));
  await duo.step('V: 제목·메모', (s) => s.api('N1').updateMemo(s.appt('V'), '  새 제목 ', ' 새 메모 '));
  await duo.step('V: N1 getLive', (s) => s.api('N1').getLive(s.appt('V')));
  await duo.step('V: 비멤버 getLive', (s) => s.api('N2').getLive(s.appt('V')));
  await duo.step('없는 약속 getLive', (s) => s.api('N2').getLive(s.missingAppt));
  await duo.step('없는 약속 보고', (s) => s.api('N2').reportLocation(s.missingAppt, at(PLACE)));
  await duo.step('없는 약속 나가기', (s) => s.api('N2').leave(s.missingAppt));
  await duo.step('없는 약속 시작', (s) => s.api('N2').start(s.missingAppt));
  await duo.step('V: 비멤버 보고', (s) => s.api('N2').reportLocation(s.appt('V'), at(PLACE)));
  await duo.step('V: 비멤버 나가기(무시)', (s) => s.api('N2').leave(s.appt('V')));
  await duo.step('V: 비멤버 내보내기(무시)', (s) => s.api('N1').kick(s.appt('V'), s.uid('N2')));
  await duo.step('V: 비멤버 보증', (s) => s.api('N2').vouch(s.appt('V'), s.uid('N1')));
  await duo.step('V: 비멤버 공유 끄기', (s) => s.api('N2').stopSharing(s.appt('V')));
  await duo.step('V: G1 프로필 없이 미리보기', (s) => s.api('G1').peekInvite(s.code('V')));
  await duo.step('V: G1 프로필 없이 수락', (s) => claim(s, 'G1', 'V', '친구'));
  await duo.step('V: 미리보기 코드 소문자·공백', (s) => s.api('N2').peekInvite(` ${s.code('V').toLowerCase()} `));
  for (let i = 0; i < 8; i++) {
    await duo.step(`N1 추가 생성 ${i + 3}`, (s) => create(s, 'N1', `W${i}`, m, { policy: pol(0, 0), invitees: [] }));
  }
  await duo.step('N1 11번째 열린 약속', (s) => s.api('N1').createAppointment(input(s, m, { policy: pol(0, 0), invitees: [] })));
  // 생성 멱등 키: 같은 키 재시도는 검사(열린 약속 10개)·에스크로 없이 그때 만든 약속을 돌려준다(타임아웃 뒤 [만들기] 다시 누르기)
  const RID = '7d4b1c2e-0000-4000-8000-00000000c0de';
  await duo.step('N2 멱등 키로 생성', (s) => create(s, 'N2', 'RQ', m, { policy: pol(100), invitees: ['친구'], requestId: RID }));
  await duo.step('N2 같은 키로 다시 생성(같은 약속·에스크로 1번)', (s) =>
    s.api('N2').createAppointment(input(s, m, { policy: pol(100), invitees: ['친구'], requestId: RID })),
  );
  await duo.step('N2 같은 키 재시도 뒤 원장', (s) => s.api('N2').listLedger(5));
  await duo.step('N1 11번째지만 N2 의 키(주최자별이라 새 약속 → 열린 약속 초과)', (s) =>
    s.api('N1').createAppointment(input(s, m, { policy: pol(0, 0), invitees: [], requestId: RID })),
  );
  await duo.step('N1 원장 1줄', (s) => s.api('N1').listLedger(1));
  await duo.step('N2 정책 일부로 생성(기본값 채움)', (s) =>
    create(s, 'N2', 'PP', m, { policy: { stake: 20 } as unknown as LatePolicy, invitees: [] }),
  );
  await duo.step('N2 원장 10000줄 요청', (s) => s.api('N2').listLedger(10_000));
  await finalState(duo, { V: ['N1'] }, ['N1', 'N2']);
}

// ───────────────────────── S5 동률·즉시 정산·noWinner ─────────────────────────
export async function s5Settlement(duo: Duo): Promise<void> {
  const U = ['H', 'G1', 'G2', 'G3'];
  await duo.addUsers(U);
  for (const u of U) await duo.step(`${u} ensureProfile`, (s) => s.api(u).ensureProfile(`${u}닉`));
  const m = duo.minuteAfter(duo.vnow() + 20 * MIN);
  await duo.step('E: 생성(100P, 5분당 10P)', (s) => create(s, 'H', 'E', m, { policy: pol(100), invitees: ['a', 'b', 'c'] }));
  await duo.step('E: G1 a', (s) => claim(s, 'G1', 'E', 'a'));
  await duo.step('E: G2 b', (s) => claim(s, 'G2', 'E', 'b'));
  await duo.step('E: G3 c', (s) => claim(s, 'G3', 'E', 'c'));
  await duo.step('E: 시작', (s) => s.api('H').start(s.appt('E')));
  await duo.travelTo(m - 6 * MIN);
  await duo.step('E: H 도착', (s) => s.api('H').reportLocation(s.appt('E'), at(PLACE)));
  await duo.travelTo(m - 4 * MIN);
  await duo.step('E: G1 도착', (s) => s.api('G1').reportLocation(s.appt('E'), at(PLACE)));
  await duo.travelTo(m - 2 * MIN);
  await duo.step('E: G2 도착', (s) => s.api('G2').reportLocation(s.appt('E'), at(PLACE, null)));
  await duo.step('E: 약속 전 전원 도착 아님 → 정산 안 함', (s) => s.api('G2').getLive(s.appt('E')));
  await duo.travelTo(m + 7 * MIN);
  await duo.step('E: G3 7분 지각 = 마지막 도착 → 즉시 정산', (s) => s.api('G3').reportLocation(s.appt('E'), at(PLACE)));
  await duo.step('E: G3 getLive(20P 를 7·7·6)', (s) => s.api('G3').getLive(s.appt('E')));

  const m2 = duo.minuteAfter(duo.vnow() + 15 * MIN);
  await duo.step('F: 생성(100P)', (s) => create(s, 'H', 'F', m2, { policy: pol(100), invitees: ['d'] }));
  await duo.step('F: G1 d', (s) => claim(s, 'G1', 'F', 'd'));
  await duo.step('F: 시작', (s) => s.api('H').start(s.appt('F')));
  await duo.travelTo(m2 + 12 * MIN);
  await duo.step('F: H 12분 지각', (s) => s.api('H').reportLocation(s.appt('F'), at(PLACE)));
  await duo.step('F: G1 12분 지각 → 전원 지각 = noWinner 무효', (s) => s.api('G1').reportLocation(s.appt('F'), at(PLACE)));
  await duo.step('F: getLive', (s) => s.api('H').getLive(s.appt('F')));
  await finalState(duo, { E: ['H', 'G3'], F: ['G1'] }, U);
}

// ───────────────────────── S6 위치 공개 수명(3분 숨김·10분 삭제)·공유 끄기 ─────────────────────────
export async function s6Locations(duo: Duo): Promise<void> {
  const U = ['H', 'G1', 'G2'];
  await duo.addUsers(U);
  for (const u of U) await duo.step(`${u} ensureProfile`, (s) => s.api(u).ensureProfile(`${u}닉`));
  const m = duo.minuteAfter(duo.vnow() + 60 * MIN);
  await duo.step('L: 생성', (s) => create(s, 'H', 'L', m, { policy: pol(100, 10, 5, 5), invitees: ['일', '이'] }));
  await duo.step('L: G1 일', (s) => claim(s, 'G1', 'L', '일'));
  await duo.step('L: G2 이', (s) => claim(s, 'G2', 'L', '이'));
  await duo.step('L: 시작', (s) => s.api('H').start(s.appt('L')));
  await duo.travelTo(m - 40 * MIN);
  await duo.step('L: G1 멀리', (s) => s.api('G1').reportLocation(s.appt('L'), at(FAR, 20)));
  await duo.step('L: G2 정확도 1500(저장 안 함)', (s) => s.api('G2').reportLocation(s.appt('L'), at(FAR, 1500)));
  await duo.step('L: H getLive(G1 보임)', (s) => s.api('H').getLive(s.appt('L')));
  await duo.travelTo(m - 36 * MIN);
  await duo.step('L: 4분 뒤 H getLive(좌표 숨김·lastSeen)', (s) => s.api('H').getLive(s.appt('L')));
  await duo.travelTo(m - 25 * MIN);
  await duo.step('L: 15분 뒤 ping(청소)', (s) => s.api('H').ping());
  await duo.step('L: 15분 뒤 H getLive(삭제됨)', (s) => s.api('H').getLive(s.appt('L')));
  await duo.step('L: G2 다시 보고', (s) => s.api('G2').reportLocation(s.appt('L'), at(NEAR30, 300)));
  await duo.step('L: G2 공유 끄기', (s) => s.api('G2').stopSharing(s.appt('L')));
  await duo.step('L: H getLive(G2 없음)', (s) => s.api('H').getLive(s.appt('L')));
  await duo.step('L: G1 도착', (s) => s.api('G1').reportLocation(s.appt('L'), at(PLACE, 30)));
  await duo.step('L: G1 이 G2 보증(first_near → 시각)', (s) => s.api('G1').vouch(s.appt('L'), s.uid('G2')));
  await duo.step('L: G1 이 G2 다시 보증(무시)', (s) => s.api('G1').vouch(s.appt('L'), s.uid('G2')));
  await duo.step('L: G2 가 H 보증(보증 도착자는 보증 못 함)', (s) => s.api('G2').vouch(s.appt('L'), s.uid('H')));
  await duo.travelTo(m + 9 * MIN); // 봐주는 5분 + 4분 → 1단위
  await duo.step('L: H 9분 지각 = 마지막 → 정산', (s) => s.api('H').reportLocation(s.appt('L'), at(PLACE)));
  await finalState(duo, { L: ['H', 'G1', 'G2'] }, U);
}

// ───────────────────────── S7 공정성 규칙 R1~R4 (오너 결정 2026-09-19) ─────────────────────────
export async function s7Fairness(duo: Duo): Promise<void> {
  const U = ['H', 'G1', 'G2', 'G3', 'G4'];
  await duo.addUsers(U);
  for (const u of U) await duo.step(`${u} ensureProfile`, (s) => s.api(u).ensureProfile(`${u}닉`));
  const m = duo.minuteAfter(duo.vnow() + 60 * MIN);
  const P450 = offsetPoint(PLACE.lat, PLACE.lng, 450, 0);
  const P550 = offsetPoint(PLACE.lat, PLACE.lng, 550, 0);
  const P850 = offsetPoint(PLACE.lat, PLACE.lng, 850, 0);
  const S400 = offsetPoint(PLACE.lat, PLACE.lng, 400, Math.PI);

  // R3 — 혼자일 때 바꾼 건 기록하지 않는다
  await duo.step('S: 혼자 생성', (s) => create(s, 'H', 'S', m, { policy: pol(100), invitees: ['갑'] }));
  await duo.step('S: 혼자 걸 포인트 변경', (s) => edit(s, 'H', 'S', { policy: pol(50) }));
  await duo.step('S: 혼자 바로 시작(쿨다운 없음)', (s) => s.api('H').start(s.appt('S')));

  // R3 — 친구가 있을 때 중요 변경 → 5분 동안 시작 불가. 이름·메모·명단은 중요 변경이 아니다
  await duo.step('R: 생성(100P, 하나·둘·셋)', (s) => create(s, 'H', 'R', m, { policy: pol(100), invitees: ['하나', '둘', '셋'] }));
  await duo.step('R: G1 하나', (s) => claim(s, 'G1', 'R', '하나'));
  await duo.step('R: 장소 이름만(친구 있음)', (s) => edit(s, 'H', 'R', { placeName: '강남역 새 이름' }));
  await duo.step('R: 제목·메모', (s) => s.api('H').updateMemo(s.appt('R'), '새 제목', '메모'));
  await duo.step('R: 명단 +넷', (s) => s.api('H').editInvitees(s.appt('R'), { add: ['넷'] }));
  await duo.step('R: 이름·메모·명단 뒤 getLive(startableAt 없음)', (s) => s.api('G1').getLive(s.appt('R')));
  await duo.step('R: 핀 30m 옮기기(중요 변경)', (s) => edit(s, 'H', 'R', { lat: NEAR30.lat, lng: NEAR30.lng }));
  await duo.step('R: 바로 시작(쿨다운)', (s) => s.api('H').start(s.appt('R')));
  await duo.step('R: G1 getLive(startableAt)', (s) => s.api('G1').getLive(s.appt('R')));
  await duo.travelTo(duo.vnow() + 3 * MIN);
  await duo.step('R: 걸 포인트 변경(쿨다운 다시 시작)', (s) => edit(s, 'H', 'R', { policy: pol(120) }));
  await duo.travelTo(duo.vnow() + 3 * MIN);
  await duo.step('R: 3분 뒤 시작(아직 쿨다운)', (s) => s.api('H').start(s.appt('R')));
  await duo.travelTo(duo.vnow() + 3 * MIN);
  await duo.step('R: 6분 뒤 시작', (s) => s.api('H').start(s.appt('R')));

  // R4 — 시작 뒤 들어온 사람만 내보낼 수 있다
  await duo.step('R: 시작 후 G2 둘', (s) => claim(s, 'G2', 'R', '둘'));
  await duo.step('R: H getLive(joinedAfterStart)', (s) => s.api('H').getLive(s.appt('R')));
  await duo.step('R: G2 위치 보고', (s) => s.api('G2').reportLocation(s.appt('R'), at(FAR, 20)));
  await duo.step('R: 시작 전부터 있던 G1 내보내기', (s) => s.api('H').kick(s.appt('R'), s.uid('G1')));
  await duo.step('R: 시작 뒤 들어온 G2 내보내기', (s) => s.api('H').kick(s.appt('R'), s.uid('G2')));
  await duo.step('R: G2 미리보기(차단)', (s) => s.api('G2').peekInvite(s.code('R')));
  await duo.step('R: G2 다시 둘 수락(차단)', (s) => s.api('G2').claimSlot(s.appt('R'), '둘', 1, true));
  await duo.step('R: G2 getLive(멤버 아님)', (s) => s.api('G2').getLive(s.appt('R')));
  await duo.step('R: G3 미리보기(둘 빈 칸)', (s) => s.api('G3').peekInvite(s.code('R')));
  await duo.step('R: G3 둘 수락', (s) => claim(s, 'G3', 'R', '둘'));
  await duo.step('R: G4 셋 수락', (s) => claim(s, 'G4', 'R', '셋'));
  await duo.step('R: H getLive(내보낸 뒤)', (s) => s.api('H').getLive(s.appt('R')));

  // R1 — 누적 +180분, 약속 시각 전에만
  await duo.step('R: 120분 미루기', (s) => edit(s, 'H', 'R', { localAt: s.localAt(m + 120 * MIN), tz: TZ }));
  await duo.step('R: 처음 기준 181분 미루기', (s) => edit(s, 'H', 'R', { localAt: s.localAt(m + 181 * MIN), tz: TZ }));
  await duo.step('R: 앞당기기', (s) => edit(s, 'H', 'R', { localAt: s.localAt(m + 100 * MIN), tz: TZ }));

  // R2 — 처음 핀에서 500m 안(누적). 이름만은 자유
  await duo.step('R: 처음 핀에서 550m', (s) => edit(s, 'H', 'R', { lat: P550.lat, lng: P550.lng }));
  await duo.step('R: 처음 핀에서 450m', (s) => edit(s, 'H', 'R', { lat: P450.lat, lng: P450.lng }));
  await duo.step('R: 처음 핀에서 850m(옮긴 핀에서 400m)', (s) => edit(s, 'H', 'R', { lat: P850.lat, lng: P850.lng }));
  await duo.step('R: 반대편 400m(옮긴 핀에서 850m)', (s) => edit(s, 'H', 'R', { lat: S400.lat, lng: S400.lng }));
  await duo.step('R: 이름만', (s) => edit(s, 'H', 'R', { placeName: '완전히 다른 가게' }));
  await duo.step('R: G3 getLive', (s) => s.api('G3').getLive(s.appt('R')));

  const meet = m + 120 * MIN;
  await duo.travelTo(meet + 2 * MIN);
  await duo.step('R: 약속 뒤 30분 미루기', (s) => edit(s, 'H', 'R', { localAt: s.localAt(meet + 30 * MIN), tz: TZ }));
  await duo.step('R: 약속 뒤 이름만(같은 localAt)', (s) => edit(s, 'H', 'R', { localAt: s.localAt(meet), tz: TZ, placeName: '가게 2층' }));
  await duo.step('R: 약속 뒤 G4 내보내기(시작 뒤 들어옴, 정산 전)', (s) => s.api('H').kick(s.appt('R'), s.uid('G4')));
  await duo.step('R: 약속 뒤 H getLive', (s) => s.api('H').getLive(s.appt('R')));
  await duo.travelTo(meet + 120 * MIN);
  // 마감이 지났고 게으른 정산은 아직(아무도 getLive 안 함) — 결과가 정해진 뒤라 시작 뒤 들어온 사람도 못 내보낸다
  await duo.step('R: 마감 뒤·정산 전 G3 내보내기', (s) => s.api('H').kick(s.appt('R'), s.uid('G3')));
  await duo.step('R: 마감 뒤 getLive → 정산', (s) => s.api('G1').getLive(s.appt('R')));
  await duo.step('R: 정산 뒤 G3 내보내기', (s) => s.api('H').kick(s.appt('R'), s.uid('G3')));
  await finalState(duo, { R: ['H', 'G1', 'G3'], S: ['H'] }, U);
}

export const SCENARIOS: [string, (duo: Duo) => Promise<void>][] = [
  ['S1 본 흐름', s1MainFlow],
  ['S2 notStarted 무효', s2NotStarted],
  ['S3 취소', s3Cancel],
  ['S4 입력 검증·비멤버', s4Validation],
  ['S5 정산 동률·즉시·noWinner', s5Settlement],
  ['S6 위치 수명·보증', s6Locations],
  ['S7 공정성 R1~R4', s7Fairness],
];
