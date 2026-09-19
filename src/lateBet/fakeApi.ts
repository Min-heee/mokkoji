/**
 * 약속 내기 — 메모리 가짜 서버 (P0: Supabase 없이 전 화면을 돌리기 위한 것).
 *
 * 설계서 부록 A 의 plpgsql RPC 를 같은 순서·같은 오류 코드로 옮긴 뒤, 오너 확정 흐름(2026-09-18, 설계서 §0-1)을 반영했다:
 * - 수락제 폐지 → 초대 명단(invitees). 참여 = 명단에서 내 이름을 고르는 것(claimSlot). pending 은 없다.
 * - 시작 = 주최자의 [시작하기](start, startedAtMs). 그 순간부터 전원 위치가 서로 보이고 체크인이 열린다. 되돌릴 수 없다.
 *   '전원 참여 시 자동 잠금'과 '위치 공개 시점(N분 전)'은 없다.
 * - 시작 전에는 주최자가 조건 전부를 바꾼다(차액 에스크로/환불, version+1, changes). 나가기·내보내기·명단 편집도 시작 전만.
 *   시작 후에는 미루기·장소만. 아직 안 들어온 이름은 시작 뒤에도 약속 시각까지 들어올 수 있다.
 * - 남의 위치는 시작됨 ∧ 마감 전 ∧ 미도착 ∧ 3분 안일 때만 내려간다. 체크인은 시작 시각부터 마감까지.
 * - 마감(closeMs) = 전액 몰수 시각 + 30분 꼬리(lateCloseMs).
 * - 약속 시각(meetAtMs)이 지나면: 안 들어온 이름 삭제(환불 없음), 시작이 안 된 약속은 무효(notStarted, 전원 환불).
 *   정산(settle)은 마감 + 15초 / 전원 도착 ∧ 약속 시각 이후 / 시작 안 됨 ∧ 약속 시각 이후 — 셋 중 하나.
 *
 * 다른 점:
 * - 저장은 메모리뿐이다(AsyncStorage 에 쓰지 않는다). 앱을 다시 띄우면 전부 사라진다.
 * - 시계는 '가짜 서버 시계'(실제 시각 + 빨리 감은 만큼)다. now()/clock_timestamp() 구분은 없다.
 * - 트랜잭션은 상태 전체를 JSON 으로 떠 두었다가 예외가 나면 되돌리는 것으로 흉내 낸다.
 * - 걸어오는 봇 친구가 있다(제시간/지각/노쇼/앱을 닫음/지하라 GPS 가 안 됨). 봇은 명단의 이름을 차례로 고른다.
 *
 * React/RN 을 import 하지 않는다 — fakeApi.test.ts 가 node 에서 그대로 돈다.
 */
import { haversineMeters } from '../domain/geo';
import { generateCode, normalizeCode } from '../domain/invite';
import { settleLateBet, type LatePolicy } from '../domain/lateBet';
import {
  canKickAfterStart,
  canMovePlace,
  canPostpone,
  isJoinedAfterStart,
  POSTPONE_MAX_MINUTES_AFTER_START,
  startableAtFrom,
  startCooldownRemainingMs,
} from '../domain/lateEditRules';
import { lateCloseMs } from '../domain/latePhase';
import { START_BALANCE, presetPolicy, validatePolicy } from '../domain/latePresets';
import { isKnownTz, isTzSuspect, msToLocalAt, wallClockToMs } from '../domain/tzGuard';
import type { LateBetApi } from './api';
import { LateBetError, type LateBetErrorCode } from './errors';
import { serverClock, type ServerClock } from './serverClock';
import type {
  LbAppointment,
  LbAppointmentChange,
  LbAppointmentSnapshot,
  LbArrivalMethod,
  LbCreateInput,
  LbEditPatch,
  LbInvitePreview,
  LbInvitee,
  LbInviteesPatch,
  LbJoinResult,
  LbLedgerEntry,
  LbLedgerKind,
  LbLedgerReason,
  LbLive,
  LbLiveParticipant,
  LbMyAppointment,
  LbPing,
  LbProfile,
  LbReportInput,
  LbReportReason,
  LbReportResult,
  LbResultStatus,
  LbVoidReason,
  LateAppointmentStatus,
  LateMemberState,
} from './types';

const MIN = 60_000;
const LOCAL_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** 좌표가 친구에게 보이는 시간 / 서버에 남는 시간 / 정산 여유 */
export const FAKE_VISIBLE_MS = 3 * MIN;
export const FAKE_PURGE_MS = 10 * MIN;
export const FAKE_SETTLE_SLACK_MS = 15_000;
/** 최대 인원(주최자 포함) = 명단 19명 + 주최자 */
export const FAKE_MAX_ACTIVE = 20;
export const FAKE_MAX_OPEN_HOSTED = 10;
/** 시작 후 시간 미루기 상한(시작하던 순간의 약속 시각 기준, 누적 — domain/lateEditRules 와 같다) */
export const FAKE_MAX_POSTPONE_MS = POSTPONE_MAX_MINUTES_AFTER_START * MIN;
/** 생성 때 정책에서 빠진 키의 기본값(SQL lb_create_appointment 의 coalesce 와 같다) */
const CREATE_POLICY_BASE: LatePolicy = { stake: 0, radiusM: 100, unitMinutes: 5, penaltyPerUnit: 0, graceMinutes: 0 };
/** 원장 조회 상한(SQL lb_list_ledger 와 같다) */
export const FAKE_LEDGER_MAX = 500;

/** 가짜 서버에서 '나' */
export const FAKE_ME = 'fake-me';

/** 데모 초대 코드 — app/j 화면을 혼자 확인할 때 입력한다 */
export const FAKE_DEMO_CODES = {
  /** 시작 전: 명단에 빈 이름('민병희'·'병희')이 있어 바로 고르고 참여할 수 있다(대기실) */
  open: 'FAKE2222',
  /** 명단에 빈 이름이 없다 → 고를 이름이 없다(LB_NOT_INVITED 안내) */
  full: 'FAKE3333',
  /** 주최자가 이미 시작했고 빈 이름이 하나('민병희') → 고르는 순간 live 화면, 친구 위치가 바로 뜬다 */
  started: 'FAKE4444',
  /** 취소된 약속 */
  canceled: 'FAKE5555',
} as const;

/**
 * 봇 성격.
 * - onTime     약속 3~9분 전에 걸어서 도착
 * - late       봐주는 시간 뒤 6~18분 늦게 도착
 * - noShow     앱을 한 번도 안 연다(위치 없음, 오지 않음)
 * - ghost      오다가 약속 20분 전에 앱을 닫는다 → "N분 전까지 공유" → 10분 뒤 좌표 삭제, 오지 않음
 * - needsVouch 제시간에 근처까지 오지만 지하라 GPS 오차가 180m → low_accuracy + first_near_at. [같이 있어요] 대상
 */
export type FakeBotPlan = 'onTime' | 'late' | 'noShow' | 'ghost' | 'needsVouch';
export const FAKE_BOT_PLANS: readonly FakeBotPlan[] = ['onTime', 'late', 'needsVouch', 'noShow', 'ghost'];
const BOT_NAMES = ['지수', '현우', '태호', '민지', '서연', '도윤', '하준', '유나', '준서', '가은', '시우', '예린'];

interface ProfileRow {
  userId: string;
  nickname: string;
  balance: number;
  isBot: boolean;
}
interface InviteeRow {
  name: string;
  claimedByUserId: string | null;
  claimedAtMs: number | null;
}
interface ChangeRow {
  version: number;
  atMs: number;
  before: LbAppointmentSnapshot;
  after: LbAppointmentSnapshot;
}
interface ApptRow {
  id: string;
  inviteCode: string;
  hostId: string;
  title: string;
  localAt: string;
  tz: string;
  meetAtMs: number;
  placeName: string;
  placeNote: string;
  placeLat: number;
  placeLng: number;
  policy: LatePolicy;
  closeMs: number;
  status: LateAppointmentStatus;
  voidReason: LbVoidReason | null;
  settledAtMs: number | null;
  version: number;
  createdAtMs: number;
  invitees: InviteeRow[];
  /** 주최자가 [시작하기]를 누른 시각. null = 시작 전 */
  startedAtMs: number | null;
  /** 시작하던 순간의 약속 시각·핀(R1·R2 의 누적 기준). 시작 전 null */
  startMeetAtMs: number | null;
  startPlaceLat: number | null;
  startPlaceLng: number | null;
  /** 친구가 있을 때 마지막 중요 변경 시각(R3). 없으면 null */
  materialChangedAtMs: number | null;
  changes: ChangeRow[];
  /** 생성 멱등 키(LbCreateInput.requestId). 없으면 null */
  requestId?: string | null;
}
interface PartRow {
  appointmentId: string;
  userId: string;
  nickname: string;
  state: LateMemberState;
  joinedAtMs: number;
  consentedAtMs: number;
  firstNearAtMs: number | null;
  arrivedAtMs: number | null;
  arrivalMethod: LbArrivalMethod | null;
  arrivalDistanceM: number | null;
  arrivalAccuracyM: number | null;
  vouchedBy: string | null;
  resultStatus: LbResultStatus | null;
  forfeited: number | null;
  received: number | null;
}
interface LocRow {
  appointmentId: string;
  userId: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  updatedAtMs: number;
}
interface LedgerRow {
  id: number;
  userId: string;
  appointmentId: string | null;
  kind: LbLedgerKind;
  amount: number;
  balanceAfter: number;
  reason: LbLedgerReason | null;
  reliefFor: string | null;
  createdAtMs: number;
}
interface BotRow {
  userId: string;
  appointmentId: string;
  plan: FakeBotPlan;
  startLat: number;
  startLng: number;
  /** 출발·도착(계획). noShow 는 쓰지 않는다 */
  departMs: number;
  arriveMs: number;
  /** ghost: 이 시각 뒤로는 보고하지 않는다 */
  stopMs: number | null;
}
interface ShareLogRow {
  appointmentId: string;
  viewerId: string;
  subjectId: string;
  firstAtMs: number;
  lastAtMs: number;
}
interface SettleErrorRow {
  appointmentId: string;
  message: string;
  atMs: number;
}

/** 전부 JSON 으로 복제 가능한 값만 둔다(트랜잭션 되돌리기) */
interface FakeState {
  profiles: ProfileRow[];
  appts: ApptRow[];
  parts: PartRow[];
  locs: LocRow[];
  ledger: LedgerRow[];
  bans: string[];
  bots: BotRow[];
  shareLog: ShareLogRow[];
  settleErrors: SettleErrorRow[];
  seq: number;
}

const emptyState = (): FakeState => ({
  profiles: [],
  appts: [],
  parts: [],
  locs: [],
  ledger: [],
  bans: [],
  bots: [],
  shareLog: [],
  settleErrors: [],
  seq: 0,
});

export interface FakeServerOptions {
  /** 실제 시각 공급원(테스트는 고정값을 넣는다). 기본 Date.now */
  now?: () => number;
  /** 난수원(테스트는 결정적으로). 기본 Math.random */
  random?: () => number;
  /** 데모 초대 코드(FAKE_DEMO_CODES)를 심는다. 기본 false */
  seedDemo?: boolean;
}

export interface FakeAuditProblem {
  problem: string;
  ref: string;
  detail: string;
}

export interface FakeBotInfo {
  userId: string;
  nickname: string;
  plan: FakeBotPlan;
  state: LateMemberState | null;
  arrivedAtMs: number | null;
  /** 주최자가 이미 시작한 뒤에 들어왔는가(들어온 순간부터 위치 공개·판정 대상) */
  started: boolean;
}

function fail(code: LateBetErrorCode, detail?: string): never {
  throw new LateBetError(code, detail ?? null);
}

/** private.lb_clean_nick 의 '보이지 않는 문자' (U+00AD, U+200B–200F, U+2028–202F, U+2060–2064, U+FEFF) */
const INVISIBLE = /[\u00AD\u200B-\u200F\u2028-\u202F\u2060-\u2064\uFEFF]/g;
/** private.lb_clean_nick */
export const cleanNick = (raw: unknown): string => (typeof raw === 'string' ? raw : '').replace(INVISIBLE, '').trim();
/** private.lb_nick_key — NFKC + 공백 제거 + 소문자 */
export const nickKey = (raw: unknown): string => cleanNick(raw).normalize('NFKC').replace(/\s/g, '').toLowerCase();
const charLen = (s: string) => Array.from(s).length;

const byJoin = (a: PartRow, b: PartRow) => a.joinedAtMs - b.joinedAtMs || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const samePolicy = (a: LatePolicy, b: LatePolicy): boolean =>
  a.stake === b.stake &&
  a.radiusM === b.radiusM &&
  a.unitMinutes === b.unitMinutes &&
  a.penaltyPerUnit === b.penaltyPerUnit &&
  a.graceMinutes === b.graceMinutes;

/** 목적지에서 bearing(라디안) 방향으로 distM 떨어진 점 (평면 근사 — 수 km 안에서는 충분하다) */
export function offsetPoint(lat: number, lng: number, distM: number, bearingRad: number): { lat: number; lng: number } {
  const dLat = (distM * Math.cos(bearingRad)) / 111_320;
  const dLng = (distM * Math.sin(bearingRad)) / (111_320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return { lat: lat + dLat, lng: lng + dLng };
}

export class FakeServer {
  private state: FakeState = emptyState();
  private offsetMs = 0;
  private readonly realNow: () => number;
  private readonly random: () => number;
  private readonly wantsDemo: boolean;
  private ticking = false;

  constructor(options: FakeServerOptions = {}) {
    this.realNow = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.wantsDemo = options.seedDemo === true;
    if (this.wantsDemo) this.seedDemo();
  }

  // ───────────────────────── 시계 ─────────────────────────

  /** 가짜 서버 시각 */
  nowMs(): number {
    return Math.floor(this.realNow() + this.offsetMs);
  }

  /** 시간 빨리 감기. 봇은 다음 호출 때 그 사이의 일을 소급해서 한다 */
  advance(ms: number): number {
    if (Number.isFinite(ms) && ms > 0) this.offsetMs += ms;
    this.tick();
    return this.nowMs();
  }

  /** 이 서버 시각으로 점프(과거로는 안 간다) */
  advanceTo(targetMs: number): number {
    return this.advance(targetMs - this.nowMs());
  }

  /** 전부 지우고 처음으로(시계 포함) */
  reset(): void {
    this.state = emptyState();
    this.offsetMs = 0;
    if (this.wantsDemo) this.seedDemo();
  }

  // ───────────────────────── 내부 도구 ─────────────────────────

  private tx<T>(fn: () => T): T {
    const snapshot = JSON.stringify(this.state);
    try {
      return fn();
    } catch (e) {
      this.state = JSON.parse(snapshot) as FakeState;
      throw e;
    }
  }

  private nextId(prefix: string): string {
    this.state.seq += 1;
    return `${prefix}-${this.state.seq.toString(36)}`;
  }

  private uid(uid: string | null | undefined): string {
    if (typeof uid !== 'string' || uid === '') fail('LB_NOT_SIGNED_IN');
    return uid as string;
  }

  private profile(userId: string): ProfileRow | undefined {
    return this.state.profiles.find((p) => p.userId === userId);
  }
  private appt(id: string): ApptRow | undefined {
    return this.state.appts.find((a) => a.id === id);
  }
  private apptByCode(code: string): ApptRow | undefined {
    const c = (typeof code === 'string' ? code : '').trim().toUpperCase();
    return this.state.appts.find((a) => a.inviteCode === c);
  }
  private part(apptId: string, userId: string): PartRow | undefined {
    return this.state.parts.find((p) => p.appointmentId === apptId && p.userId === userId);
  }
  private partsOf(apptId: string): PartRow[] {
    return this.state.parts.filter((p) => p.appointmentId === apptId).sort(byJoin);
  }
  private removePart(apptId: string, userId: string): void {
    this.state.parts = this.state.parts.filter((p) => !(p.appointmentId === apptId && p.userId === userId));
    this.removeLoc(apptId, userId); // FK cascade
  }
  private removeLoc(apptId: string, userId?: string): void {
    this.state.locs = this.state.locs.filter(
      (l) => !(l.appointmentId === apptId && (userId === undefined || l.userId === userId)),
    );
  }
  private isBanned(apptId: string, userId: string): boolean {
    return this.state.bans.includes(`${apptId}|${userId}`);
  }
  private hostAlone(a: ApptRow): boolean {
    return !this.partsOf(a.id).some((p) => p.userId !== a.hostId);
  }

  /** private.lb_post — 포인트 이동의 유일한 통로: 잔액 갱신 + 원장 1행 */
  private post(
    userId: string,
    apptId: string | null,
    kind: LbLedgerKind,
    amount: number,
    meta: { reason?: LbLedgerReason; reliefFor?: string } = {},
  ): number {
    const p = this.profile(userId);
    if (!p || p.balance + amount < 0) fail('LB_INSUFFICIENT_POINTS', this.part(apptId ?? '', userId)?.nickname);
    const row = p as ProfileRow;
    row.balance += amount;
    this.state.seq += 1;
    this.state.ledger.push({
      id: this.state.seq,
      userId,
      appointmentId: apptId,
      kind,
      amount,
      balanceAfter: row.balance,
      reason: meta.reason ?? null,
      reliefFor: meta.reliefFor ?? null,
      createdAtMs: this.nowMs(),
    });
    return row.balance;
  }

  /**
   * private.lb_hold — 모자라면 '가진 것 전부(잔액 + 열린 약속에 걸린 합) < 1000' 일 때에 한해 부족분만 채운 뒤 건다.
   * heldHere = 이 약속에 이미 걸려 있는 포인트(잠금 전 걸 포인트 인상의 차액 hold 때)
   */
  private hold(userId: string, apptId: string, amount: number, opts: { reason?: LbLedgerReason; heldHere?: number } = {}): void {
    if (amount <= 0) return;
    const p = this.profile(userId);
    if (!p) fail('LB_NO_PROFILE');
    const bal = (p as ProfileRow).balance;
    if (bal < amount) {
      const escrow = this.state.parts
        .filter((x) => x.userId === userId && x.state === 'active' && x.appointmentId !== apptId)
        .reduce((sum, x) => {
          const a = this.appt(x.appointmentId);
          return a && a.status === 'open' ? sum + a.policy.stake : sum;
        }, 0);
      if (bal + escrow + (opts.heldHere ?? 0) >= START_BALANCE) {
        fail('LB_INSUFFICIENT_POINTS', this.part(apptId, userId)?.nickname ?? p?.nickname);
      }
      this.post(userId, null, 'relief', amount - bal, { reason: 'topup', reliefFor: apptId });
    }
    this.post(userId, apptId, 'hold', -amount, opts.reason ? { reason: opts.reason } : {});
  }

  /** private.lb_resolve_meet */
  private resolveMeet(localAt: string, tz: string, lng: number, tzConfirmed: boolean): number {
    if (!isKnownTz(tz)) fail('LB_BAD_TZ');
    if (typeof localAt !== 'string' || !LOCAL_AT_RE.test(localAt)) fail('LB_BAD_TIME');
    const meet = wallClockToMs(localAt, tz);
    if (meet === null || !Number.isFinite(meet)) fail('LB_BAD_TIME');
    const meetMs = meet as number;
    const now = this.nowMs();
    if (meetMs <= now + 5 * MIN) fail('LB_TIME_IN_PAST');
    if (meetMs > now + 90 * 24 * 60 * MIN) fail('LB_TIME_TOO_FAR');
    if (isTzSuspect(tz, lng, meetMs) && !tzConfirmed) fail('LB_TZ_SUSPECT');
    return meetMs;
  }

  /**
   * 정책 합치기 = SQL 의 `coalesce((p_policy->>'stake')::int, 기준값)` — 있는 키만 바꾸고 없는 키는 기준값(생성: CREATE_POLICY_BASE,
   * 수정: 지금 값). 있는 키가 정수가 아니면 SQL 의 ::int 캐스트 오류(22P02)와 같이 LB_CHECK_VIOLATION. 범위는 여기서 보지 않는다(checkPolicy)
   */
  private mergePolicy(patch: unknown, base: LatePolicy): LatePolicy {
    const raw = (patch !== null && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
    const out: LatePolicy = { ...base };
    for (const k of ['stake', 'radiusM', 'unitMinutes', 'penaltyPerUnit', 'graceMinutes'] as const) {
      const v = raw[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'number' || !Number.isInteger(v)) fail('LB_CHECK_VIOLATION', `policy.${k}`);
      out[k] = v as number;
    }
    return out;
  }

  /** 테이블 CHECK 제약(23514) — 범위·180분 절벽 */
  private checkPolicy(policy: LatePolicy): LatePolicy {
    const v = validatePolicy(policy);
    if (!v.ok) fail('LB_CHECK_VIOLATION', v.issues.map((i) => i.field).join(','));
    return { ...policy };
  }

  private checkText(value: unknown, min: number, max: number, field: string): string {
    const s = (typeof value === 'string' ? value : '').trim();
    const n = charLen(s);
    if (n < min || n > max) fail('LB_CHECK_VIOLATION', field);
    return s;
  }

  /** 핀 좌표: 숫자가 아니거나 범위(위도 ±90·경도 ±180) 밖이면 LB_BAD_POSITION (SQL 생성·수정과 같다) */
  private checkPosition(lat: unknown, lng: unknown): void {
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      fail('LB_BAD_POSITION');
    }
    if ((lat as number) < -90 || (lat as number) > 90 || (lng as number) < -180 || (lng as number) > 180) {
      fail('LB_BAD_POSITION');
    }
  }

  /** 명단 이름 정리: 1~12자, 주최자 이름·중복(닉 키 기준) 제외 */
  private cleanInviteeNames(raw: unknown, hostNick: string, existing: readonly InviteeRow[]): string[] {
    const taken = new Set([nickKey(hostNick), ...existing.map((i) => nickKey(i.name))]);
    const out: string[] = [];
    for (const v of Array.isArray(raw) ? raw : []) {
      const name = cleanNick(v);
      const n = charLen(name);
      if (n < 1 || n > 12) fail('LB_BAD_NICKNAME', name);
      const key = nickKey(name);
      if (taken.has(key)) continue; // 주최자 본인·같은 이름은 조용히 무시
      taken.add(key);
      out.push(name);
    }
    return out;
  }

  private newInviteCode(): string {
    for (;;) {
      const code = generateCode(this.random);
      if (!this.state.appts.some((a) => a.inviteCode === code)) return code;
    }
  }

  /** private.lb_purge_stale_locations */
  private purgeStale(): void {
    const cutoff = this.nowMs() - FAKE_PURGE_MS;
    this.state.locs = this.state.locs.filter((l) => l.updatedAtMs >= cutoff);
  }

  /** 약속 시각이 지나면 아직 안 들어온 이름은 명단에서 지운다(포인트를 건 적이 없으니 환불 없음). 멱등 */
  private dropUnclaimed(a: ApptRow): void {
    if (this.nowMs() < a.meetAtMs) return;
    a.invitees = a.invitees.filter((i) => i.claimedByUserId !== null);
  }

  /**
   * private.lb_settle (멱등). 정산 조건 셋 중 하나:
   * - 마감 + 15초가 지났다
   * - 전원 도착 ∧ 약속 시각 이후
   * - 시작이 안 된 채 약속 시각이 지났다 → 무효(notStarted), 전원 환불(refund/notStarted). 체크인이 열린 적이 없으니 전원 '오지 않음'
   */
  private settle(apptId: string): void {
    const a = this.appt(apptId);
    if (!a || a.status !== 'open') return;
    const now = this.nowMs();
    const active = this.partsOf(apptId).filter((p) => p.state === 'active');
    const allArrived = active.length > 0 && active.every((p) => p.arrivedAtMs !== null);
    const notStarted = a.startedAtMs === null && now >= a.meetAtMs;
    if (!(now > a.closeMs + FAKE_SETTLE_SLACK_MS || (allArrived && now >= a.meetAtMs) || notStarted)) return;
    this.dropUnclaimed(a);

    if (notStarted) {
      for (const p of this.partsOf(apptId).sort((x, y) => byId(x.userId, y.userId))) {
        p.resultStatus = 'noShow';
        p.forfeited = 0;
        p.received = 0;
        if (a.policy.stake > 0) this.post(p.userId, apptId, 'refund', a.policy.stake, { reason: 'notStarted' });
      }
      a.status = a.policy.stake > 0 ? 'voided' : 'settled';
      a.voidReason = 'notStarted';
      a.settledAtMs = now;
      this.removeLoc(apptId);
      return;
    }

    const rows = this.partsOf(apptId);
    const res = settleLateBet(
      a.policy,
      rows.map((p) => p.userId),
      rows.map((p) => ({ personId: p.userId, arrivedAtMs: p.arrivedAtMs })),
      a.meetAtMs,
    );
    for (const r of [...res.persons].sort((x, y) => byId(x.personId, y.personId))) {
      const row = this.part(apptId, r.personId) as PartRow;
      row.resultStatus = r.status;
      row.forfeited = r.forfeited;
      row.received = r.received;
      if (a.policy.stake > 0) this.post(r.personId, apptId, 'payout', a.policy.stake - r.forfeited + r.received);
    }
    a.status = res.voided && a.policy.stake > 0 ? 'voided' : 'settled';
    a.voidReason = res.voidReason;
    a.settledAtMs = now;
    this.removeLoc(apptId);

    const sum = this.state.ledger.filter((l) => l.appointmentId === apptId).reduce((s, l) => s + l.amount, 0);
    if (sum !== 0) fail('LB_INVARIANT_ESCROW_NONZERO', String(sum));
  }

  /** private.lb_try_settle — 실패해도 호출한 쪽은 성공한다(서브트랜잭션) */
  private trySettle(apptId: string): void {
    try {
      this.tx(() => this.settle(apptId));
    } catch (e) {
      this.state.settleErrors.push({
        appointmentId: apptId,
        message: e instanceof LateBetError ? `${e.code} ${e.detail ?? ''}`.trim() : String(e),
        atMs: this.nowMs(),
      });
    }
  }

  private snapshot(a: ApptRow): LbAppointmentSnapshot {
    return {
      localAt: a.localAt,
      tz: a.tz,
      meetAtMs: a.meetAtMs,
      placeName: a.placeName,
      placeLat: a.placeLat,
      placeLng: a.placeLng,
      policy: { ...a.policy },
    };
  }

  private toAppointment(a: ApptRow): LbAppointment {
    return {
      id: a.id,
      inviteCode: a.inviteCode,
      hostId: a.hostId,
      hostNickname: this.part(a.id, a.hostId)?.nickname ?? this.profile(a.hostId)?.nickname ?? '',
      title: a.title,
      localAt: a.localAt,
      tz: a.tz,
      meetAtMs: a.meetAtMs,
      closeMs: a.closeMs,
      placeName: a.placeName,
      placeNote: a.placeNote,
      placeLat: a.placeLat,
      placeLng: a.placeLng,
      status: a.status,
      voidReason: a.voidReason,
      version: a.version,
      policy: { ...a.policy },
      invitees: a.invitees.map((i): LbInvitee => ({ ...i })),
      startedAtMs: a.startedAtMs,
      startMeetAtMs: a.startMeetAtMs ?? null,
      startPlaceLat: a.startPlaceLat ?? null,
      startPlaceLng: a.startPlaceLng ?? null,
      // 계약: 변경 + 5분이 아직 미래면 그 ms(SQL lb_appointment_json 과 같다 — 화면은 시작 전에만 쓴다)
      startableAtMs: startableAtFrom(a.materialChangedAtMs ?? null, this.nowMs()),
      changes: a.changes.map((c): LbAppointmentChange => ({ ...c, before: { ...c.before }, after: { ...c.after } })),
    };
  }

  // ───────────────────────── RPC (첫 인자 uid = auth.uid()) ─────────────────────────

  /** #0 */
  ping(): LbPing {
    this.tick();
    this.purgeStale();
    return { serverNowMs: this.nowMs(), minBuild: 0, iosUrl: '', androidUrl: '' };
  }

  /** #1 */
  ensureProfile(uidRaw: string, nickname: string, isBot = false): LbProfile {
    const uid = this.uid(uidRaw);
    return this.tx(() => {
      const nick = cleanNick(nickname);
      const n = charLen(nick);
      if (n < 1 || n > 12) fail('LB_BAD_NICKNAME');
      let p = this.profile(uid);
      if (!p) {
        p = { userId: uid, nickname: nick, balance: 0, isBot };
        this.state.profiles.push(p);
        this.post(uid, null, 'grant', START_BALANCE, { reason: 'signup' });
      } else {
        p.nickname = nick;
      }
      return { userId: p.userId, nickname: p.nickname, balance: p.balance };
    });
  }

  /** #2 — 초대 명단과 함께 만든다. 주최자 자동 참여 + 에스크로 */
  createAppointment(uidRaw: string, input: LbCreateInput): LbAppointment {
    const uid = this.uid(uidRaw);
    this.tick();
    return this.tx(() => {
      const me = this.profile(uid);
      if (!me) fail('LB_NO_PROFILE');
      const host = me as ProfileRow;
      // SQL 과 같다: 같은 주최자·같은 멱등 키면 새로 만들지 않고 그때 만든 약속(검사·에스크로 없이)
      const requestId = typeof input.requestId === 'string' && input.requestId !== '' ? input.requestId : null;
      if (requestId) {
        const prev = this.state.appts.find((x) => x.hostId === uid && x.requestId === requestId);
        if (prev) return this.toAppointment(prev);
      }
      if (input.consent !== true) fail('LB_CONSENT_REQUIRED');
      if (this.state.appts.filter((a) => a.hostId === uid && a.status === 'open').length >= FAKE_MAX_OPEN_HOSTED) {
        fail('LB_TOO_MANY_OPEN');
      }
      if (input.lat == null || input.lng == null) fail('LB_BAD_POSITION');
      this.checkPosition(input.lat, input.lng);
      const meetAtMs = this.resolveMeet(input.localAt, input.tz, input.lng, input.tzConfirmed === true);
      // SQL 과 같은 순서: 정책 캐스트 → 행 CHECK(제목·장소·메모·정책) → 명단(이름·인원)
      const policy = this.checkPolicy(this.mergePolicy(input.policy, CREATE_POLICY_BASE));
      const title = this.checkText(input.title, 1, 40, 'title');
      const placeName = this.checkText(input.placeName, 1, 60, 'place_name');
      const placeNote = this.checkText(input.placeNote ?? '', 0, 200, 'place_note');
      const names = this.cleanInviteeNames(input.invitees, host.nickname, []);
      if (names.length + 1 > FAKE_MAX_ACTIVE) fail('LB_FULL');
      const a: ApptRow = {
        id: this.nextId('appt'),
        inviteCode: this.newInviteCode(),
        hostId: uid,
        title,
        localAt: msToLocalAt(meetAtMs, input.tz),
        tz: input.tz,
        meetAtMs,
        placeName,
        placeNote,
        placeLat: input.lat,
        placeLng: input.lng,
        policy,
        closeMs: lateCloseMs(policy, meetAtMs),
        status: 'open',
        voidReason: null,
        settledAtMs: null,
        version: 1,
        createdAtMs: this.nowMs(),
        invitees: names.map((name) => ({ name, claimedByUserId: null, claimedAtMs: null })),
        startedAtMs: null,
        startMeetAtMs: null,
        startPlaceLat: null,
        startPlaceLng: null,
        materialChangedAtMs: null,
        changes: [],
        requestId,
      };
      this.state.appts.push(a);
      this.insertPart(a.id, uid, host.nickname);
      this.hold(uid, a.id, policy.stake);
      return this.toAppointment(a);
    });
  }

  private insertPart(apptId: string, userId: string, nickname: string): PartRow {
    const now = this.nowMs();
    const row: PartRow = {
      appointmentId: apptId,
      userId,
      nickname,
      state: 'active',
      joinedAtMs: now,
      consentedAtMs: now,
      firstNearAtMs: null,
      arrivedAtMs: null,
      arrivalMethod: null,
      arrivalDistanceM: null,
      arrivalAccuracyM: null,
      vouchedBy: null,
      resultStatus: null,
      forfeited: null,
      received: null,
    };
    this.state.parts.push(row);
    return row;
  }

  /** #3 — 명단(누가 골랐는지)까지 보인다: 자기 이름을 골라야 하므로 */
  peekInvite(uidRaw: string, code: string): LbInvitePreview {
    const uid = this.uid(uidRaw);
    this.tick();
    const a = this.apptByCode(code);
    if (!a || this.isBanned(a.id, uid)) fail('LB_INVITE_NOT_FOUND');
    const row = a as ApptRow;
    const mine = this.part(row.id, uid);
    return {
      id: row.id,
      title: row.title,
      hostNickname: this.part(row.id, row.hostId)?.nickname ?? '',
      localAt: row.localAt,
      tz: row.tz,
      meetAtMs: row.meetAtMs,
      startedAtMs: row.startedAtMs,
      closeMs: row.closeMs,
      placeName: row.placeName,
      placeNote: row.placeNote,
      placeLat: row.placeLat,
      placeLng: row.placeLng,
      status: row.status,
      version: row.version,
      serverNowMs: this.nowMs(),
      policy: { ...row.policy },
      memberCount: this.partsOf(row.id).length,
      invitees: row.invitees.map((i) => ({ name: i.name, claimed: i.claimedByUserId !== null, mine: i.claimedByUserId === uid })),
      myState: mine?.state ?? null,
      myBalance: this.profile(uid)?.balance ?? null,
    };
  }

  /** #4 — 명단에서 내 이름을 골라 참여(+에스크로). 약속 시각 전이면 주최자가 시작한 뒤에도 들어올 수 있다 */
  claimSlot(uidRaw: string, apptId: string, name: string, version: number, consent: boolean): LbJoinResult {
    const uid = this.uid(uidRaw);
    this.tick();
    return this.tx(() => this.claimInner(uid, apptId, name, version, consent));
  }

  private claimInner(uid: string, apptId: string, name: string, version: number, consent: boolean): LbJoinResult {
    const found = this.appt(apptId);
    if (!found || this.isBanned(found.id, uid)) fail('LB_INVITE_NOT_FOUND');
    const a = found as ApptRow;
    const mine = this.part(a.id, uid);
    if (mine) return { appointmentId: a.id, state: mine.state, started: a.startedAtMs !== null }; // 멱등

    const now = this.nowMs();
    if (a.status !== 'open' || now >= a.meetAtMs) fail('LB_JOIN_CLOSED');
    if (version !== a.version) fail('LB_APPT_CHANGED');
    if (consent !== true) fail('LB_CONSENT_REQUIRED');
    if (!this.profile(uid)) fail('LB_NO_PROFILE');
    // SQL 과 같이 정리한 이름이 1~12자가 아니면 명단을 보기 전에 LB_BAD_NICKNAME(명단 이름은 전부 1~12자라 어차피 없다)
    const cleaned = cleanNick(name);
    if (charLen(cleaned) < 1 || charLen(cleaned) > 12) fail('LB_BAD_NICKNAME');
    const key = nickKey(cleaned);
    const slot = a.invitees.find((i) => nickKey(i.name) === key);
    if (!slot) fail('LB_NOT_INVITED', cleanNick(name));
    if (slot.claimedByUserId !== null) fail('LB_SLOT_TAKEN', slot.name);
    if (this.partsOf(a.id).length >= FAKE_MAX_ACTIVE) fail('LB_FULL');

    this.insertPart(a.id, uid, slot.name);
    this.hold(uid, a.id, a.policy.stake); // 채워 줄 수도 없으면 예외 → 전체 롤백
    slot.claimedByUserId = uid;
    slot.claimedAtMs = now;
    return { appointmentId: a.id, state: 'active', started: a.startedAtMs !== null };
  }

  /**
   * #17 — [시작하기](주최자). 그 순간부터 전원 위치가 서로 보이고 체크인이 열린다. 되돌릴 수 없다.
   * 약속 시각 전이면 언제든(참여 인원 조건 없음). 약속 시각이 지났거나 닫혔으면 LB_START_CLOSED, 이미 시작했으면 LB_ALREADY_STARTED,
   * 친구가 있을 때 중요 변경 뒤 5분 안이면 LB_START_COOLDOWN(R3). 그때의 약속 시각·핀을 R1·R2 의 기준으로 남긴다
   */
  start(uidRaw: string, apptId: string): LbAppointment {
    const uid = this.uid(uidRaw);
    this.tick();
    return this.tx(() => {
      const a = this.appt(apptId);
      if (!a || a.hostId !== uid) fail('LB_NOT_HOST');
      const row = a as ApptRow;
      if (row.startedAtMs !== null) fail('LB_ALREADY_STARTED');
      const now = this.nowMs();
      if (row.status !== 'open' || now >= row.meetAtMs) fail('LB_START_CLOSED');
      // R3: 친구가 있을 때 조건을 바꾼 직후에는 시작할 수 없다(친구들이 바뀐 내용을 볼 시간)
      if (startCooldownRemainingMs(this.toAppointment(row), now) > 0) fail('LB_START_COOLDOWN');
      row.startedAtMs = now;
      row.startMeetAtMs = row.meetAtMs;
      row.startPlaceLat = row.placeLat;
      row.startPlaceLng = row.placeLng;
      return this.toAppointment(row);
    });
  }

  /** #16 — 명단 편집(주최자, 시작 전). remove 는 아직 안 들어온 이름만. 시작 후에는 LB_EDIT_FROZEN */
  editInvitees(uidRaw: string, apptId: string, patch: LbInviteesPatch): LbAppointment {
    const uid = this.uid(uidRaw);
    this.tick();
    return this.tx(() => {
      const a = this.appt(apptId);
      if (!a || a.hostId !== uid) fail('LB_NOT_HOST');
      const row = a as ApptRow;
      // 시작 없이 약속 시각이 지났으면 곧 무효될 약속이다(SQL lb_edit_invitees 와 같이 LB_EDIT_CLOSED)
      if (row.status !== 'open' || (row.startedAtMs === null && this.nowMs() >= row.meetAtMs)) fail('LB_EDIT_CLOSED');
      if (row.startedAtMs !== null) fail('LB_EDIT_FROZEN');
      for (const raw of patch.remove ?? []) {
        const key = nickKey(raw);
        const slot = row.invitees.find((i) => nickKey(i.name) === key);
        if (!slot) continue;
        if (slot.claimedByUserId !== null) fail('LB_INVITEE_JOINED', slot.name);
        row.invitees = row.invitees.filter((i) => i !== slot);
      }
      const hostNick = this.part(apptId, uid)?.nickname ?? '';
      const added = this.cleanInviteeNames(patch.add ?? [], hostNick, row.invitees);
      if (row.invitees.length + added.length + 1 > FAKE_MAX_ACTIVE) fail('LB_FULL');
      for (const name of added) row.invitees.push({ name, claimedByUserId: null, claimedAtMs: null });
      return this.toAppointment(row);
    });
  }

  /** #6 — 시작 전까지(전액 환불). 이름은 명단에 남고 빈 칸이 된다(다시 들어올 수 있다). 시작 후 LB_LEAVE_CLOSED */
  leave(uidRaw: string, apptId: string): void {
    const uid = this.uid(uidRaw);
    this.tick();
    this.tx(() => {
      const a = this.appt(apptId);
      if (!a) fail('LB_NOT_FOUND');
      const row = a as ApptRow;
      const me = this.part(apptId, uid);
      if (!me) return;
      if (row.hostId === uid) fail('LB_HOST_CANNOT_LEAVE');
      if (row.status !== 'open' || row.startedAtMs !== null) fail('LB_LEAVE_CLOSED');
      this.removePart(apptId, uid);
      const slot = row.invitees.find((i) => i.claimedByUserId === uid);
      if (slot) {
        slot.claimedByUserId = null;
        slot.claimedAtMs = null;
      }
      if (row.policy.stake > 0) this.post(uid, apptId, 'refund', row.policy.stake, { reason: 'leave' });
    });
  }

  /**
   * #7 — 시작 전: 누구든(전액 환불). 명단에서도 그 이름을 지운다. ban 기본 true.
   * 시작 후(마감 전까지, R4): 시작 뒤에 들어온 사람만 — 전액 환불·좌표 삭제·차단, 이름 칸은 빈 칸으로 되돌린다
   * (약속 시각 전이면 다른 사람이 고를 수 있다). 시작 전부터 있던 사람은 LB_KICK_CLOSED
   */
  kick(uidRaw: string, apptId: string, target: string, ban = true): void {
    const uid = this.uid(uidRaw);
    this.tick();
    this.tx(() => {
      const a = this.appt(apptId);
      if (!a || a.hostId !== uid) fail('LB_NOT_HOST');
      const row = a as ApptRow;
      if (target === uid) fail('LB_HOST_CANNOT_LEAVE');
      const t = this.part(apptId, target);
      if (!t) return;
      if (row.status !== 'open') fail('LB_KICK_CLOSED');
      const slot = row.invitees.find((i) => i.claimedByUserId === target);
      const afterStart = row.startedAtMs !== null;
      // 마감(closeMs)이 지나 결과가 정해진 뒤에는 게으른 정산 전이라도 못 내보낸다(SQL lb_kick 과 같다)
      if (afterStart && this.nowMs() > row.closeMs) fail('LB_KICK_CLOSED');
      if (afterStart && !canKickAfterStart({ joinedAfterStart: isJoinedAfterStart(slot?.claimedAtMs ?? null, row.startedAtMs) })) {
        fail('LB_KICK_CLOSED');
      }
      this.removePart(apptId, target); // 좌표도 같이 지운다
      if (afterStart && slot) {
        slot.claimedByUserId = null;
        slot.claimedAtMs = null;
      } else {
        row.invitees = row.invitees.filter((i) => i.claimedByUserId !== target);
      }
      if (row.policy.stake > 0) this.post(target, apptId, 'refund', row.policy.stake, { reason: 'kicked' });
      if (ban !== false && !this.isBanned(apptId, target)) this.state.bans.push(`${apptId}|${target}`);
    });
  }

  /** #9 — 조건이 아니므로 version 을 올리지 않는다 */
  updateMemo(uidRaw: string, apptId: string, title: string, placeNote: string): void {
    const uid = this.uid(uidRaw);
    this.tx(() => {
      const a = this.appt(apptId);
      if (!a || a.hostId !== uid || a.status !== 'open') fail('LB_NOT_HOST');
      const row = a as ApptRow;
      row.title = this.checkText(title, 1, 40, 'title');
      row.placeNote = this.checkText(placeNote ?? '', 0, 200, 'place_note');
    });
  }

  /**
   * #10 — 부분 갱신.
   * - 시작 전: 전부. 걸 포인트 차액은 전원 추가 hold(부족분 자동 채움) / refund(policy_change). version+1
   * - 시작 후: 시간 뒤로 미루기(최대 +3시간)·장소만. 그 외 변경은 LB_EDIT_FROZEN. 시작 시각은 그대로다
   * - 마감이 지났거나 닫혔으면 LB_EDIT_CLOSED
   */
  edit(uidRaw: string, apptId: string, patch: LbEditPatch, version: number): LbAppointment {
    const uid = this.uid(uidRaw);
    this.tick();
    return this.tx(() => {
      const a = this.appt(apptId);
      if (!a || a.hostId !== uid) fail('LB_NOT_HOST');
      const row = a as ApptRow;
      const now = this.nowMs();
      const started = row.startedAtMs !== null;
      // 시작 없이 약속 시각이 지났으면 곧 무효될 약속이다(SQL lb_edit_appointment 와 같이 LB_EDIT_CLOSED)
      if (row.status !== 'open' || now > row.closeMs || (!started && now >= row.meetAtMs)) fail('LB_EDIT_CLOSED');
      if (version !== row.version) fail('LB_APPT_CHANGED');

      // SQL lb_edit_appointment 와 같은 순서·같은 판정
      const tz = patch.tz ?? row.tz;
      const localAt = patch.localAt ?? row.localAt;
      if ((patch.lat === undefined) !== (patch.lng === undefined)) fail('LB_BAD_POSITION');
      const lat = patch.lat ?? row.placeLat;
      const lng = patch.lng ?? row.placeLng;
      const policy = patch.policy !== undefined ? this.mergePolicy(patch.policy, row.policy) : row.policy; // 없는 키는 그대로
      this.checkPosition(lat, lng);
      const tzConfirmed = patch.tzConfirmed === true;
      let meetAtMs = row.meetAtMs;
      if (localAt !== row.localAt || tz !== row.tz) {
        // 벽시계·시간대가 실제로 바뀔 때만 '지금+5분~90일' 검사 — 약속 직전·지각 중에 장소만 바꾸며 같은 localAt 을 실어 보내도 막지 않는다
        meetAtMs = this.resolveMeet(localAt, tz, lng, tzConfirmed);
      } else if (lng !== row.placeLng && isTzSuspect(tz, lng, meetAtMs) && !tzConfirmed) {
        fail('LB_TZ_SUSPECT'); // 핀만 다른 시간대로 옮겨도 시간대 의심 검사(SQL lb_check_tz)
      }
      const policyChanged = !samePolicy(policy, row.policy);
      if (started) {
        if (policyChanged) fail('LB_EDIT_FROZEN');
        // R1: 앞당기기 불가 · 약속 시각 전에만 · 시작하던 순간의 약속 시각 + 3시간까지(누적)
        const postpone = canPostpone(this.toAppointment(row), meetAtMs, now);
        if (!postpone.ok) fail(postpone.code);
        // R2: 시작하던 순간의 핀에서 500m 안(누적). 핀이 그대로면 통과
        const move = canMovePlace(this.toAppointment(row), lat, lng);
        if (!move.ok) fail(move.code);
      }
      const placeName = patch.placeName !== undefined ? (typeof patch.placeName === 'string' ? patch.placeName.trim() : '') : row.placeName;
      const timeChanged = meetAtMs !== row.meetAtMs || tz !== row.tz;
      const pinMoved = lat !== row.placeLat || lng !== row.placeLng;
      const placeChanged = placeName !== row.placeName || pinMoved;
      if (!timeChanged && !placeChanged && !policyChanged) return this.toAppointment(row); // 바뀐 게 없다

      const before = this.snapshot(row);
      // R3: 친구(주최자 말고 참가자)가 있을 때의 중요 변경(시각·시간대·핀·정책)은 기록 → 5분 동안 시작 불가. 장소 이름만은 아니다
      if ((timeChanged || pinMoved || policyChanged) && !this.hostAlone(row)) row.materialChangedAtMs = now;
      // 걸 포인트 차액(시작 전만 올 수 있다): 전원, user_id 순
      const diff = policy.stake - row.policy.stake;
      if (diff !== 0) {
        for (const p of this.partsOf(apptId).sort((x, y) => byId(x.userId, y.userId))) {
          if (diff > 0) this.hold(p.userId, apptId, diff, { reason: 'policy_change', heldHere: row.policy.stake });
          else this.post(p.userId, apptId, 'refund', -diff, { reason: 'policy_change' });
        }
      }
      // 행 CHECK 제약(SQL 은 update 때 23514)
      this.checkText(placeName, 1, 60, 'place_name');
      if (policyChanged) this.checkPolicy(policy);
      if (pinMoved) {
        // 옛 장소 근처에 있었다는 기록은 새 장소의 근거가 못 된다(보증 도착 시각으로 쓰이지 않게)
        for (const p of this.partsOf(apptId)) if (p.arrivedAtMs === null) p.firstNearAtMs = null;
      }
      row.localAt = msToLocalAt(meetAtMs, tz);
      row.tz = tz;
      row.meetAtMs = meetAtMs;
      row.placeName = placeName;
      row.placeLat = lat;
      row.placeLng = lng;
      row.policy = policy;
      row.closeMs = lateCloseMs(policy, meetAtMs);
      row.version += 1;
      row.changes.push({ version: row.version, atMs: now, before, after: this.snapshot(row) });
      // 아직 안 온 봇은 새 시각·장소 기준으로 다시 걷는다
      for (const b of this.state.bots.filter((x) => x.appointmentId === apptId)) {
        if (this.part(apptId, b.userId)?.arrivedAtMs === null) this.planBot(row, b.userId, b.plan);
      }
      return this.toAppointment(row);
    });
  }

  /** #11 — 시작 전까지(혼자면 언제든). 전원 환불. 시작 후 LB_CANCEL_CLOSED */
  cancel(uidRaw: string, apptId: string): void {
    const uid = this.uid(uidRaw);
    this.tick();
    this.tx(() => {
      const a = this.appt(apptId);
      if (!a || a.hostId !== uid) fail('LB_NOT_HOST');
      const row = a as ApptRow;
      if (row.status !== 'open') fail('LB_CANCEL_CLOSED');
      if (row.startedAtMs !== null && !this.hostAlone(row)) fail('LB_CANCEL_CLOSED');
      if (row.policy.stake > 0) {
        for (const p of this.partsOf(apptId).sort((x, y) => byId(x.userId, y.userId))) {
          this.post(p.userId, apptId, 'refund', row.policy.stake, { reason: 'canceled' });
        }
      }
      row.status = 'canceled';
      row.settledAtMs = this.nowMs();
      this.removeLoc(apptId);
    });
  }

  /** #12 — 위치 보고 = 도착 판정 (설계서 §2.3 판정표 순서 그대로, pending 단계만 없다). 시작 시각부터 마감까지 */
  reportLocation(uidRaw: string, apptId: string, input: LbReportInput): LbReportResult {
    const uid = this.uid(uidRaw);
    this.tick();
    return this.tx(() => this.reportInner(uid, apptId, input));
  }

  private reportInner(uid: string, apptId: string, input: LbReportInput): LbReportResult {
    const a = this.appt(apptId);
    if (!a) fail('LB_NOT_FOUND');
    const row = a as ApptRow;
    const found = this.part(apptId, uid);
    if (!found) fail('LB_NOT_MEMBER');
    const me = found as PartRow;
    const now = this.nowMs();
    const { lat, lng } = input;
    const acc = input.accuracyM ?? null;

    let reason: LbReportReason | null = null;
    if (row.status !== 'open') reason = 'closed';
    else if (row.startedAtMs === null && now >= row.meetAtMs) {
      // 시작 없이 약속 시각이 지났다 → 게으른 무효(notStarted) 뒤 closed (SQL lb_report_location 과 같다).
      // 무효 정산 자체가 실패해 아직 open 이면 SQL 처럼 '시작 전' 그대로 not_open
      this.trySettle(apptId);
      reason = this.appt(apptId)?.status !== 'open' ? 'closed' : 'not_open';
    } else if (me.arrivedAtMs !== null) reason = 'already_arrived';
    else if (row.startedAtMs === null || now < row.startedAtMs) reason = 'not_open';
    else if (now > row.closeMs) {
      this.trySettle(apptId);
      reason = 'closed';
    } else if (
      typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180
    ) {
      reason = 'bad_position';
    }
    if (reason !== null) {
      const again = this.part(apptId, uid);
      return { arrived: (again?.arrivedAtMs ?? null) !== null, reason, arrivedAtMs: again?.arrivedAtMs ?? null, distanceM: null, serverNowMs: this.nowMs() };
    }

    const dist = haversineMeters({ lat, lng }, { lat: row.placeLat, lng: row.placeLng });
    if (input.mocked === true) reason = 'mocked';
    else if (acc !== null && (!(acc >= 0) || acc > 100)) reason = 'low_accuracy';
    else if (dist > row.policy.radiusM) reason = 'outside';

    if (reason === null) {
      me.arrivedAtMs = now;
      me.arrivalMethod = 'gps';
      me.arrivalDistanceM = Math.round(dist);
      me.arrivalAccuracyM = acc === null ? null : Math.round(acc);
      this.removeLoc(apptId, uid); // 도착하면 위치 공개 종료
      this.trySettle(apptId);
      return { arrived: true, reason: null, arrivedAtMs: now, distanceM: Math.round(dist), serverNowMs: this.nowMs() };
    }

    // 정확도 미달이지만 오차를 빼면 반경 안: '근처에 있었다'는 첫 서버 시각
    if (reason === 'low_accuracy' && acc !== null && acc > 0 && me.firstNearAtMs === null && dist - Math.min(acc, 300) <= row.policy.radiusM) {
      me.firstNearAtMs = now;
    }

    if (input.share !== false && reason !== 'mocked' && (acc === null || acc <= 1000)) {
      this.removeLoc(apptId, uid);
      this.state.locs.push({ appointmentId: apptId, userId: uid, lat, lng, accuracyM: acc, updatedAtMs: now });
    } else {
      this.removeLoc(apptId, uid);
    }
    return { arrived: false, reason, arrivedAtMs: null, distanceM: Math.round(dist), serverNowMs: this.nowMs() };
  }

  /** #13 */
  stopSharing(uidRaw: string, apptId: string): void {
    const uid = this.uid(uidRaw);
    this.removeLoc(apptId, uid);
  }

  /** #14 */
  vouch(uidRaw: string, apptId: string, target: string): void {
    const uid = this.uid(uidRaw);
    this.tick();
    this.tx(() => {
      const a = this.appt(apptId);
      if (!a || a.status !== 'open') fail('LB_CLOSED');
      const row = a as ApptRow;
      const now = this.nowMs();
      if (row.startedAtMs === null) fail('LB_NOT_STARTED');
      if (now < row.startedAtMs || now > row.closeMs) fail('LB_CLOSED');
      if (target === uid) fail('LB_CANNOT_VOUCH_SELF');
      if (this.part(apptId, uid)?.arrivalMethod !== 'gps') fail('LB_VOUCHER_NOT_ARRIVED'); // 보증의 연쇄 금지
      const t = this.part(apptId, target);
      if (!t || t.state !== 'active' || t.arrivedAtMs !== null) return;
      t.arrivedAtMs = t.firstNearAtMs ?? now;
      t.arrivalMethod = 'vouch';
      t.vouchedBy = uid;
      this.removeLoc(apptId, target);
      this.trySettle(apptId);
    });
  }

  /** #15 — 남의 위치는 시작됨 ∧ 마감 전 ∧ 미도착 ∧ 3분 안일 때만 */
  getLive(uidRaw: string, apptId: string): LbLive {
    const uid = this.uid(uidRaw);
    this.tick();
    if (!this.part(apptId, uid)) fail('LB_NOT_MEMBER');
    let a = this.appt(apptId) as ApptRow;
    const now0 = this.nowMs();
    if (
      a.status === 'open' &&
      (now0 > a.closeMs + FAKE_SETTLE_SLACK_MS ||
        (now0 >= a.meetAtMs && a.startedAtMs === null) ||
        (now0 >= a.meetAtMs && !this.partsOf(apptId).some((p) => p.state === 'active' && p.arrivedAtMs === null)))
    ) {
      this.trySettle(apptId);
      a = this.appt(apptId) as ApptRow;
    }
    this.purgeStale();

    const me = this.part(apptId, uid) as PartRow;
    const now = this.nowMs();
    const visible = a.status === 'open' && a.startedAtMs !== null && now >= a.startedAtMs && now <= a.closeMs;

    const participants: LbLiveParticipant[] = this.partsOf(apptId).map((p) => {
      const l = this.state.locs.find((x) => x.appointmentId === apptId && x.userId === p.userId);
      const canSee = visible && p.arrivedAtMs === null && l !== undefined;
      if (canSee && l && p.userId !== uid && l.updatedAtMs > now - FAKE_VISIBLE_MS) this.logShare(apptId, uid, p.userId, now);
      return {
        userId: p.userId,
        nickname: p.nickname,
        state: p.state,
        joinedAtMs: p.joinedAtMs,
        arrivedAtMs: p.arrivedAtMs,
        arrivalMethod: p.arrivalMethod,
        arrivalDistanceM: p.arrivalDistanceM,
        arrivalAccuracyM: p.arrivalAccuracyM,
        vouchedBy: p.vouchedBy,
        resultStatus: p.resultStatus,
        forfeited: p.forfeited,
        received: p.received,
        joinedAfterStart: isJoinedAfterStart(
          a.invitees.find((i) => i.claimedByUserId === p.userId)?.claimedAtMs ?? null,
          a.startedAtMs,
        ),
        lastSeenMs: canSee && l ? l.updatedAtMs : null,
        location:
          canSee && l && l.updatedAtMs > now - FAKE_VISIBLE_MS
            ? {
                lat: l.lat,
                lng: l.lng,
                accuracyM: l.accuracyM,
                updatedAtMs: l.updatedAtMs,
                distanceM: Math.round(haversineMeters({ lat: l.lat, lng: l.lng }, { lat: a.placeLat, lng: a.placeLng })),
              }
            : null,
      };
    });

    return {
      serverNowMs: this.nowMs(),
      myUserId: uid,
      myState: me.state,
      myBalance: this.profile(uid)?.balance ?? 0,
      // 무효(notStarted)가 실패했을 때만 관측되는 두 번째 조건은 SQL lb_get_live 와 같다
      settlePending: a.status === 'open' && (now > a.closeMs || (a.startedAtMs === null && now >= a.meetAtMs)),
      appointment: this.toAppointment(a),
      participants,
    };
  }

  private logShare(apptId: string, viewerId: string, subjectId: string, now: number): void {
    const row = this.state.shareLog.find(
      (r) => r.appointmentId === apptId && r.viewerId === viewerId && r.subjectId === subjectId,
    );
    if (!row) this.state.shareLog.push({ appointmentId: apptId, viewerId, subjectId, firstAtMs: now, lastAtMs: now });
    else if (row.lastAtMs < now - 5 * MIN) row.lastAtMs = now;
  }

  // ───────────────────────── RLS select 에 해당하는 조회 ─────────────────────────

  getMyProfile(uidRaw: string): LbProfile | null {
    const p = this.profile(this.uid(uidRaw));
    return p ? { userId: p.userId, nickname: p.nickname, balance: p.balance } : null;
  }

  /** 열린 약속(가까운 순) 먼저, 그 뒤 끝난 약속(최근 순) */
  listMyAppointments(uidRaw: string): LbMyAppointment[] {
    const uid = this.uid(uidRaw);
    this.tick();
    const out: LbMyAppointment[] = [];
    for (const mine of this.state.parts.filter((p) => p.userId === uid)) {
      const a = this.appt(mine.appointmentId);
      if (!a) continue;
      out.push({
        id: a.id,
        title: a.title,
        localAt: a.localAt,
        tz: a.tz,
        meetAtMs: a.meetAtMs,
        startedAtMs: a.startedAtMs,
        closeMs: a.closeMs,
        placeName: a.placeName,
        status: a.status,
        policy: { ...a.policy },
        hostId: a.hostId,
        isHost: a.hostId === uid,
        myState: mine.state,
        memberCount: this.partsOf(a.id).length,
        unclaimedCount: a.invitees.filter((i) => i.claimedByUserId === null).length,
      });
    }
    // 같은 약속 시각끼리는 만든 순서(SQL lb_list_my_appointments 와 같다: created_at, id)
    const created = (id: string) => this.appt(id)?.createdAtMs ?? 0;
    return out.sort((x, y) => {
      const xo = x.status === 'open' ? 0 : 1;
      const yo = y.status === 'open' ? 0 : 1;
      if (xo !== yo) return xo - yo;
      const byMeet = xo === 0 ? x.meetAtMs - y.meetAtMs : y.meetAtMs - x.meetAtMs;
      return byMeet || created(x.id) - created(y.id) || byId(x.id, y.id);
    });
  }

  /** 내 원장(최신순) */
  listLedger(uidRaw: string, limit = 100): LbLedgerEntry[] {
    const uid = this.uid(uidRaw);
    return this.state.ledger
      .filter((l) => l.userId === uid)
      .sort((x, y) => y.id - x.id)
      .slice(0, Math.min(FAKE_LEDGER_MAX, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 100))))
      .map((l) => ({
        id: l.id,
        kind: l.kind,
        amount: l.amount,
        balanceAfter: l.balanceAfter,
        appointmentId: l.appointmentId,
        appointmentTitle: l.appointmentId ? this.appt(l.appointmentId)?.title ?? null : null,
        reason: l.reason,
        reliefFor: l.reliefFor,
        createdAtMs: l.createdAtMs,
      }));
  }

  // ───────────────────────── 감사 (private.lb_audit — 빈 배열이면 정상) ─────────────────────────

  audit(): FakeAuditProblem[] {
    const out: FakeAuditProblem[] = [];
    const { profiles, appts, ledger } = this.state;
    for (const p of profiles) {
      const rows = ledger.filter((l) => l.userId === p.userId).sort((x, y) => x.id - y.id);
      const sum = rows.reduce((s, l) => s + l.amount, 0);
      if (sum !== p.balance) out.push({ problem: 'balance_mismatch', ref: p.userId, detail: `${p.balance} vs ${sum}` });
      let run = 0;
      for (const l of rows) {
        run += l.amount;
        if (l.balanceAfter !== run || run < 0) out.push({ problem: 'balance_after_chain', ref: p.userId, detail: `ledger ${l.id}` });
      }
    }
    let openEscrow = 0;
    for (const a of appts) {
      const sum = ledger.filter((l) => l.appointmentId === a.id).reduce((s, l) => s + l.amount, 0);
      const rows = this.partsOf(a.id);
      if (a.status === 'open') {
        const want = a.policy.stake * rows.filter((p) => p.state === 'active').length;
        if (-sum !== want) out.push({ problem: 'open_escrow_mismatch', ref: a.id, detail: `${-sum} vs ${want}` });
        openEscrow += -sum;
      } else if (sum !== 0) {
        out.push({ problem: 'closed_escrow_nonzero', ref: a.id, detail: String(sum) });
      }
      if (a.status === 'settled') {
        const f = rows.reduce((s, p) => s + (p.forfeited ?? 0), 0);
        const r = rows.reduce((s, p) => s + (p.received ?? 0), 0);
        if (f !== r) out.push({ problem: 'pot_mismatch', ref: a.id, detail: `${f} vs ${r}` });
        if (rows.some((p) => (p.forfeited ?? 0) > a.policy.stake)) out.push({ problem: 'forfeit_over_stake', ref: a.id, detail: '' });
      }
      // 명단 불변식: 고른 이름 ↔ 참가자 행 1:1(주최자 제외), 약속 시각이 지난 열린 약속에는 빈 이름 없음
      for (const i of a.invitees) {
        if (i.claimedByUserId !== null && !this.part(a.id, i.claimedByUserId)) {
          out.push({ problem: 'invitee_without_participant', ref: a.id, detail: i.name });
        }
      }
      for (const p of rows) {
        if (p.userId !== a.hostId && !a.invitees.some((i) => i.claimedByUserId === p.userId)) {
          out.push({ problem: 'participant_without_invitee', ref: a.id, detail: p.nickname });
        }
      }
      if (a.status === 'open' && this.nowMs() >= a.meetAtMs && a.invitees.some((i) => i.claimedByUserId === null)) {
        out.push({ problem: 'unclaimed_after_meet', ref: a.id, detail: '' });
      }
      if (a.status === 'open' && a.startedAtMs === null && this.nowMs() >= a.meetAtMs) {
        out.push({ problem: 'not_started_after_meet', ref: a.id, detail: '' });
      }
    }
    const issued = ledger.filter((l) => l.kind === 'grant' || l.kind === 'relief').reduce((s, l) => s + l.amount, 0);
    const held = profiles.reduce((s, p) => s + p.balance, 0) + openEscrow;
    if (issued !== held) out.push({ problem: 'global_supply_mismatch', ref: '*', detail: `${issued} vs ${held}` });
    return out;
  }

  /** FakeDevPanel 용: 부작용 없이 약속 본문만 읽는다(정산·봇 이동을 일으키지 않는다). 없으면 null */
  appointmentInfo(apptId: string): LbAppointment | null {
    const a = this.appt(apptId);
    return a ? this.toAppointment(a) : null;
  }

  /** 테스트·디버그: 정산 실패 기록 */
  settleErrors(): readonly SettleErrorRow[] {
    return this.state.settleErrors;
  }
  /** 테스트·디버그: 위치 제공 사실 기록 */
  shareLog(): readonly ShareLogRow[] {
    return this.state.shareLog;
  }
  /** 테스트·디버그: 서버에 좌표 행이 남아 있는가 (클라이언트에는 이런 조회가 없다) */
  hasLocationRow(apptId: string, userId: string): boolean {
    return this.state.locs.some((l) => l.appointmentId === apptId && l.userId === userId);
  }

  // ───────────────────────── 봇 ─────────────────────────

  private newBotUser(nickname: string): string {
    const userId = this.nextId('bot');
    this.ensureProfile(userId, nickname, true);
    return userId;
  }

  private freeBotName(a: ApptRow): string {
    const taken = new Set([...this.partsOf(a.id).map((p) => nickKey(p.nickname)), ...a.invitees.map((i) => nickKey(i.name))]);
    return BOT_NAMES.find((n) => !taken.has(nickKey(n))) ?? `친구${this.state.seq + 1}`;
  }

  private planBot(a: ApptRow, userId: string, plan: FakeBotPlan): void {
    const r = this.random;
    const distM = 900 + r() * 1400;
    const start = offsetPoint(a.placeLat, a.placeLng, distM, r() * Math.PI * 2);
    const walkMs = (distM / 80) * MIN; // 분당 80m
    const grace = a.policy.graceMinutes * MIN;
    let arriveMs = a.meetAtMs - (3 + r() * 6) * MIN;
    if (plan === 'late') {
      const latest = Math.max(a.meetAtMs + grace + MIN, a.closeMs - 2 * MIN);
      arriveMs = Math.min(a.meetAtMs + grace + (6 + r() * 12) * MIN, latest);
    }
    this.state.bots = this.state.bots.filter((b) => !(b.appointmentId === a.id && b.userId === userId));
    this.state.bots.push({
      userId,
      appointmentId: a.id,
      plan,
      startLat: start.lat,
      startLng: start.lng,
      departMs: arriveMs - walkMs,
      arriveMs,
      stopMs: plan === 'ghost' ? a.meetAtMs - 20 * MIN : null,
    });
  }

  private botInfo(a: ApptRow, userId: string, plan: FakeBotPlan, started: boolean): FakeBotInfo {
    const p = this.part(a.id, userId);
    return { userId, nickname: p?.nickname ?? '', plan, state: p?.state ?? null, arrivedAtMs: p?.arrivedAtMs ?? null, started };
  }

  /**
   * 봇 한 명이 명단의 다음 빈 이름을 골라 들어온다 — 진짜 참여 규칙(claimSlot)을 그대로 탄다.
   * 주최자가 이미 시작했어도 약속 시각 전이면 들어온다(result.started = true → 그때부터 위치가 보이고 판정 대상).
   * 빈 이름이 없으면: 시작 전이면 주최자가 이름을 하나 추가한 뒤 들어온다. 시작 후에는 명단이 동결이라 LB_EDIT_FROZEN.
   * 약속 시각이 지났으면 LB_JOIN_CLOSED.
   */
  addBot(apptId: string, plan?: FakeBotPlan, nickname?: string): FakeBotInfo {
    this.tick();
    return this.tx(() => {
      const a = this.appt(apptId);
      if (!a) fail('LB_NOT_FOUND');
      const row = a as ApptRow;
      if (row.status !== 'open' || this.nowMs() >= row.meetAtMs) fail('LB_JOIN_CLOSED');
      const count = this.state.bots.filter((b) => b.appointmentId === apptId).length;
      const chosen = plan ?? FAKE_BOT_PLANS[count % FAKE_BOT_PLANS.length];
      let slot = nickname !== undefined
        ? row.invitees.find((i) => nickKey(i.name) === nickKey(nickname) && i.claimedByUserId === null)
        : row.invitees.find((i) => i.claimedByUserId === null);
      if (!slot) {
        const name = nickname ?? this.freeBotName(row);
        this.editInvitees(row.hostId, apptId, { add: [name] }); // 시작 후면 LB_EDIT_FROZEN
        slot = row.invitees.find((i) => nickKey(i.name) === nickKey(name)) as InviteeRow;
      }
      const userId = this.newBotUser(slot.name);
      const res = this.claimInner(userId, apptId, slot.name, row.version, true);
      this.planBot(row, userId, chosen);
      return this.botInfo(row, userId, chosen, res.started);
    });
  }

  /** 주최자가 시간을 minutes 만큼 뒤로 미룬다(edit 를 그대로 탄다 — 시작 후 규칙 포함) */
  postpone(apptId: string, minutes: number): LbAppointment {
    const a = this.appt(apptId);
    if (!a) fail('LB_NOT_FOUND');
    const row = a as ApptRow;
    return this.edit(row.hostId, apptId, { localAt: msToLocalAt(row.meetAtMs + minutes * MIN, row.tz) }, row.version);
  }

  /** 아직 안 온 봇 한 명을 지금 목적지에 도착시킨다(진짜 체크인 규칙을 탄다). 도착시킨 봇의 닉네임, 없으면 null */
  arriveBot(apptId: string, userId?: string): { nickname: string; result: LbReportResult } | null {
    this.tick();
    const a = this.appt(apptId);
    if (!a) return null;
    const bot = this.state.bots.find((b) => {
      if (b.appointmentId !== apptId || (userId !== undefined && b.userId !== userId)) return false;
      const p = this.part(apptId, b.userId);
      return !!p && p.state === 'active' && p.arrivedAtMs === null;
    });
    if (!bot) return null;
    const result = this.tx(() =>
      this.reportInner(bot.userId, apptId, { lat: a.placeLat, lng: a.placeLng, accuracyM: 12 }),
    );
    return { nickname: this.part(apptId, bot.userId)?.nickname ?? '', result };
  }

  bots(apptId: string): FakeBotInfo[] {
    const a = this.appt(apptId);
    if (!a) return [];
    return this.state.bots.filter((b) => b.appointmentId === apptId).map((b) => this.botInfo(a, b.userId, b.plan, false));
  }

  private botPosition(b: BotRow, a: ApptRow, t: number): { lat: number; lng: number } {
    const span = Math.max(1, b.arriveMs - b.departMs);
    const f = Math.min(1, Math.max(0, (t - b.departMs) / span));
    return { lat: b.startLat + (a.placeLat - b.startLat) * f, lng: b.startLng + (a.placeLng - b.startLng) * f };
  }

  /**
   * 서버 시간을 지금까지 흘려보낸다. 모든 RPC 앞에서 불린다.
   * - 약속 시각이 지난 열린 약속: 아직 안 들어온 이름을 자동 삭제한다. 시작이 안 됐으면 무효 정산(notStarted)까지.
   * - 봇: 시작 뒤에만 움직인다. 빨리 감기로 건너뛴 구간의 도착은 '계획한 시각'으로 소급해서 찍는다
   *   (서버 규칙 안에서: 시작 이후 ∧ 참여 이후 ∧ 마감 전).
   */
  tick(): void {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.tickInner();
    } finally {
      this.ticking = false;
    }
  }

  private tickInner(): void {
    const now = this.nowMs();

    for (const a of this.state.appts) {
      if (a.status !== 'open' || now < a.meetAtMs) continue;
      this.dropUnclaimed(a);
      if (a.startedAtMs === null) this.trySettle(a.id); // 시작 없이 약속 시각이 지났다 → 무효, 전원 환불
    }

    for (const b of this.state.bots) {
      const a = this.appt(b.appointmentId);
      const p = this.part(b.appointmentId, b.userId);
      if (!a || !p || a.status !== 'open' || p.state !== 'active' || p.arrivedAtMs !== null) continue;
      if (b.plan === 'noShow' || a.startedAtMs === null || now < a.startedAtMs) continue;
      const startedAt = a.startedAtMs;

      if (b.plan === 'onTime' || b.plan === 'late') {
        const at = Math.max(b.arriveMs, startedAt, p.joinedAtMs);
        if (at <= now && at <= a.closeMs) {
          p.arrivedAtMs = at;
          p.arrivalMethod = 'gps';
          p.arrivalDistanceM = Math.round(5 + this.random() * Math.min(40, a.policy.radiusM / 2));
          p.arrivalAccuracyM = 12;
          this.removeLoc(a.id, b.userId);
          continue;
        }
      }
      if (now > a.closeMs) continue;

      const reportAt = b.stopMs !== null ? Math.min(now, b.stopMs) : now;
      if (reportAt < startedAt || reportAt < p.joinedAtMs) continue;
      const pos = this.botPosition(b, a, reportAt);
      const near = haversineMeters(pos, { lat: a.placeLat, lng: a.placeLng }) <= a.policy.radiusM;
      const underground = b.plan === 'needsVouch' && near;
      if (underground && p.firstNearAtMs === null) {
        p.firstNearAtMs = Math.max(Math.min(b.arriveMs, now), startedAt, p.joinedAtMs);
      }
      this.removeLoc(a.id, b.userId);
      this.state.locs.push({
        appointmentId: a.id,
        userId: b.userId,
        lat: pos.lat,
        lng: pos.lng,
        accuracyM: underground ? 180 : 15,
        updatedAtMs: reportAt,
      });
    }
  }

  // ───────────────────────── 데모 데이터 ─────────────────────────

  /** app/j 화면 확인용: 봇이 주최한 약속 4개(FAKE_DEMO_CODES). 이미 있으면 아무것도 안 한다 */
  seedDemo(): void {
    if (this.state.appts.some((a) => a.inviteCode === FAKE_DEMO_CODES.open)) return;
    const now = this.nowMs();
    const place = { lat: 37.49808, lng: 127.02761 };
    const make = (
      code: string,
      title: string,
      placeName: string,
      meetInMin: number,
      hostName: string,
      claimed: string[],
      open: string[],
      started = false,
    ) => {
      const hostId = this.newBotUser(hostName);
      const tz = 'Asia/Seoul';
      // 분 단위로 맞춘다(서버의 local_at 은 분 해상도)
      const meetAtMs = Math.ceil((now + meetInMin * MIN) / MIN) * MIN;
      const created = this.createAppointment(hostId, {
        title,
        localAt: msToLocalAt(meetAtMs, tz),
        tz,
        placeName,
        placeNote: '',
        lat: place.lat,
        lng: place.lng,
        policy: presetPolicy('normal'),
        invitees: [...claimed, ...open],
        consent: true,
      });
      const row = this.appt(created.id) as ApptRow;
      row.inviteCode = code;
      this.planBot(row, hostId, 'onTime');
      claimed.forEach((name, i) => this.addBot(row.id, i === 0 ? 'late' : 'onTime', name));
      if (started) this.start(hostId, row.id);
      return row;
    };
    make(FAKE_DEMO_CODES.open, '금요일 곱창', '강남역 2번 출구 곱창', 180, '지수', ['현우', '태호'], ['민병희', '병희']);
    make(FAKE_DEMO_CODES.full, '번개 치맥', '강남역 11번 출구 치킨', 40, '민지', ['서연'], []);
    make(FAKE_DEMO_CODES.started, '동창 모임', '강남역 1번 출구 고깃집', 40, '도윤', ['하준'], ['민병희'], true);
    const canceled = make(FAKE_DEMO_CODES.canceled, '취소된 약속', '강남역 5번 출구', 300, '유나', [], []);
    this.cancel(canceled.hostId, canceled.id);
  }
}

// ───────────────────────── LateBetApi 어댑터 ─────────────────────────

export interface FakeApiOptions {
  /** 응답 지연(ms). 앱에서는 네트워크처럼 보이게 조금 둔다. 테스트는 0 */
  latencyMs?: number;
  /** true 를 돌려주면 그 호출은 LB_OFFLINE 으로 실패한다(FakeDevPanel 의 '연결 끊기') */
  isOffline?: () => boolean;
  /**
   * serverNowMs 가 든 응답(ping·peekInvite·reportLocation·getLive)으로 잴 시계. live(supabaseApi)와 같은 자리에서 잰다 —
   * 화면은 withClockSample 로 한 번 더 감싸지 않는다(두 번 재면 바깥 샘플이 안쪽 샘플을 덮는다). 기본 null(재지 않음)
   */
  clock?: ServerClock | null;
}

/** FakeServer 를 '이 사용자'의 LateBetApi 로 감싼다 */
export function createFakeApi(server: FakeServer, userId: string = FAKE_ME, options: FakeApiOptions = {}): LateBetApi {
  const latency = options.latencyMs ?? 0;
  const run = async <T>(fn: () => T): Promise<T> => {
    if (latency > 0) await new Promise<void>((resolve) => setTimeout(resolve, latency));
    if (options.isOffline?.()) throw new LateBetError('LB_OFFLINE');
    return fn();
  };
  const clock = options.clock ?? null;
  const now = () => Date.now();
  /** 왕복(지연 포함)으로 시계를 잰다 — supabaseApi.run 의 sample 과 같은 규칙 */
  const sampled = async <T extends { serverNowMs: number }>(fn: () => T): Promise<T> => {
    const t0 = now();
    const res = await run(fn);
    if (clock) clock.addSample(res.serverNowMs, t0, now());
    return res;
  };
  return {
    restoreSession: () => run(() => userId),
    ensureSignedIn: () => run(() => userId),
    ping: () => sampled(() => server.ping()),
    ensureProfile: (nickname) => run(() => server.ensureProfile(userId, nickname)),
    createAppointment: (input) => run(() => server.createAppointment(userId, input)),
    peekInvite: (code) => sampled(() => server.peekInvite(userId, normalizeCode(code) ?? code)),
    claimSlot: (id, name, version, consent) => run(() => server.claimSlot(userId, id, name, version, consent)),
    start: (id) => run(() => server.start(userId, id)),
    editInvitees: (id, patch) => run(() => server.editInvitees(userId, id, patch)),
    leave: (id) => run(() => server.leave(userId, id)),
    kick: (id, target, ban) => run(() => server.kick(userId, id, target, ban)),
    updateMemo: (id, title, placeNote) => run(() => server.updateMemo(userId, id, title, placeNote)),
    edit: (id, patch, version) => run(() => server.edit(userId, id, patch, version)),
    cancel: (id) => run(() => server.cancel(userId, id)),
    reportLocation: (id, input) => sampled(() => server.reportLocation(userId, id, input)),
    stopSharing: (id) => run(() => server.stopSharing(userId, id)),
    vouch: (id, target) => run(() => server.vouch(userId, id, target)),
    getLive: (id) => sampled(() => server.getLive(userId, id)),
    getMyProfile: () => run(() => server.getMyProfile(userId)),
    listMyAppointments: () => run(() => server.listMyAppointments(userId)),
    listLedger: (limit) => run(() => server.listLedger(userId, limit)),
  };
}

// ───────────────────────── 앱에서 쓰는 단일 인스턴스 ─────────────────────────

let singleton: { server: FakeServer; api: LateBetApi } | null = null;
let offline = false;

/** 앱 전체가 공유하는 가짜 서버(데모 초대 코드 포함). FakeDevPanel 이 직접 만진다 */
export function getFakeServer(): FakeServer {
  return ensureSingleton().server;
}
export function getFakeApi(): LateBetApi {
  return ensureSingleton().api;
}
/** FakeDevPanel '연결 끊기' 토글 */
export function setFakeOffline(value: boolean): void {
  offline = value;
}
export function isFakeOffline(): boolean {
  return offline;
}

function ensureSingleton(): { server: FakeServer; api: LateBetApi } {
  if (!singleton) {
    const server = new FakeServer({ seedDemo: true });
    singleton = { server, api: createFakeApi(server, FAKE_ME, { latencyMs: 150, isOffline: () => offline, clock: serverClock }) };
  }
  return singleton;
}
