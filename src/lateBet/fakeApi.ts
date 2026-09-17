/**
 * 약속 내기 — 메모리 가짜 서버 (P0: Supabase 없이 전 화면을 돌리기 위한 것).
 *
 * 설계서 부록 A 의 plpgsql RPC 를 같은 순서·같은 오류 코드로 옮겼다. 다른 점:
 * - 저장은 메모리뿐이다(AsyncStorage 에 쓰지 않는다). 앱을 다시 띄우면 전부 사라진다.
 * - 시계는 '가짜 서버 시계'(실제 시각 + 빨리 감은 만큼)다. now()/clock_timestamp() 구분은 없다.
 * - 트랜잭션은 상태 전체를 JSON 으로 떠 두었다가 예외가 나면 되돌리는 것으로 흉내 낸다.
 * - 걸어오는 봇 친구가 있다(제시간/지각/노쇼/앱을 닫음/지하라 GPS 가 안 됨).
 *
 * React/RN 을 import 하지 않는다 — fakeApi.test.ts 가 node 에서 그대로 돈다.
 */
import { haversineMeters } from '../domain/geo';
import { generateCode, normalizeCode } from '../domain/invite';
import { settleLateBet, type LatePolicy } from '../domain/lateBet';
import { lateTimes } from '../domain/latePhase';
import { START_BALANCE, presetPolicy, validatePolicy } from '../domain/latePresets';
import { isKnownTz, isTzSuspect, msToLocalAt, wallClockToMs } from '../domain/tzGuard';
import type { LateBetApi } from './api';
import { LateBetError, type LateBetErrorCode } from './errors';
import type {
  LbAppointment,
  LbArrivalMethod,
  LbCreateInput,
  LbInvitePreview,
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
  LbUpdateInput,
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
export const FAKE_MAX_ACTIVE = 20;
export const FAKE_MAX_PENDING = 10;
export const FAKE_MAX_OPEN_HOSTED = 10;
/** 봇이 주최한 약속에서 내 참여 요청이 자동 수락되기까지 */
export const FAKE_BOT_HOST_APPROVE_MS = 8_000;

/** 가짜 서버에서 '나' */
export const FAKE_ME = 'fake-me';

/** 데모 초대 코드 — app/j 화면을 혼자 확인할 때 입력한다 */
export const FAKE_DEMO_CODES = {
  /** 잠금 전: 바로 참여 + 에스크로 */
  open: 'FAKE2222',
  /** 잠금 후: 참여 요청 → 봇 주최자가 8초 뒤 수락 */
  locked: 'FAKE3333',
  /** 주최자가 참여 마감을 눌러 둠 → LB_JOIN_CLOSED */
  joinClosed: 'FAKE4444',
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
  shareStartMs: number;
  closeMs: number;
  joinClosed: boolean;
  status: LateAppointmentStatus;
  voidReason: LbVoidReason | null;
  settledAtMs: number | null;
  version: number;
  createdAtMs: number;
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
}

function fail(code: LateBetErrorCode, detail?: string): never {
  throw new LateBetError(code, detail ?? null);
}

const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g;
/** private.lb_clean_nick */
export const cleanNick = (raw: unknown): string => (typeof raw === 'string' ? raw : '').replace(INVISIBLE, '').trim();
/** private.lb_nick_key — NFKC + 공백 제거 + 소문자 */
export const nickKey = (raw: unknown): string => cleanNick(raw).normalize('NFKC').replace(/\s/g, '').toLowerCase();
const charLen = (s: string) => Array.from(s).length;

const byJoin = (a: PartRow, b: PartRow) => a.joinedAtMs - b.joinedAtMs || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

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

  /** private.lb_post — 포인트 이동의 유일한 통로: 잔액 갱신 + 원장 1행 */
  private post(
    userId: string,
    apptId: string | null,
    kind: LbLedgerKind,
    amount: number,
    meta: { reason?: LbLedgerReason; reliefFor?: string } = {},
  ): number {
    const p = this.profile(userId);
    if (!p || p.balance + amount < 0) fail('LB_INSUFFICIENT_POINTS');
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

  /** private.lb_hold — 모자라면 '가진 것 전부 < 1000' 일 때에 한해 부족분만 채운 뒤 건다 */
  private hold(userId: string, apptId: string, stake: number): void {
    if (stake <= 0) return;
    const p = this.profile(userId);
    if (!p) fail('LB_NO_PROFILE');
    const bal = (p as ProfileRow).balance;
    if (bal < stake) {
      const escrow = this.state.parts
        .filter((x) => x.userId === userId && x.state === 'active' && x.appointmentId !== apptId)
        .reduce((sum, x) => {
          const a = this.appt(x.appointmentId);
          return a && a.status === 'open' ? sum + a.policy.stake : sum;
        }, 0);
      if (bal + escrow >= START_BALANCE) fail('LB_INSUFFICIENT_POINTS');
      this.post(userId, null, 'relief', stake - bal, { reason: 'topup', reliefFor: apptId });
    }
    this.post(userId, apptId, 'hold', -stake);
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

  /** 테이블 CHECK 제약(23514) */
  private checkPolicy(policy: LatePolicy): LatePolicy {
    const raw = policy as unknown as Record<string, unknown>;
    for (const k of ['stake', 'radiusM', 'unitMinutes', 'penaltyPerUnit', 'graceMinutes', 'shareLocationMinutesBefore']) {
      if (raw == null || typeof raw[k] !== 'number' || !Number.isInteger(raw[k] as number)) {
        fail('LB_CHECK_VIOLATION', `policy.${k}`);
      }
    }
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

  private checkPosition(lat: unknown, lng: unknown): void {
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      fail('LB_BAD_POSITION');
    }
    if ((lat as number) < -90 || (lat as number) > 90 || (lng as number) < -180 || (lng as number) > 180) {
      fail('LB_CHECK_VIOLATION', 'place');
    }
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

  /** private.lb_settle (멱등) */
  private settle(apptId: string): void {
    const a = this.appt(apptId);
    if (!a || a.status !== 'open') return;
    const now = this.nowMs();
    const active = this.partsOf(apptId).filter((p) => p.state === 'active');
    const allArrived = active.length > 0 && active.every((p) => p.arrivedAtMs !== null);
    if (!(now > a.closeMs + FAKE_SETTLE_SLACK_MS || (allArrived && now >= a.meetAtMs))) return;

    // 승인 안 된 요청은 hold 가 없으므로 그냥 지운다
    for (const p of this.partsOf(apptId)) if (p.state === 'pending') this.removePart(apptId, p.userId);

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

  private toAppointment(a: ApptRow, withCode: boolean): LbAppointment {
    return {
      id: a.id,
      inviteCode: withCode ? a.inviteCode : null,
      hostId: a.hostId,
      title: a.title,
      localAt: a.localAt,
      tz: a.tz,
      meetAtMs: a.meetAtMs,
      shareStartMs: a.shareStartMs,
      closeMs: a.closeMs,
      placeName: a.placeName,
      placeNote: a.placeNote,
      placeLat: a.placeLat,
      placeLng: a.placeLng,
      status: a.status,
      voidReason: a.voidReason,
      version: a.version,
      joinClosed: a.joinClosed,
      policy: { ...a.policy },
    };
  }

  // ───────────────────────── RPC 16개 (첫 인자 uid = auth.uid()) ─────────────────────────

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

  /** #2 */
  createAppointment(uidRaw: string, input: LbCreateInput): LbAppointment {
    const uid = this.uid(uidRaw);
    this.tick();
    return this.tx(() => {
      const me = this.profile(uid);
      if (!me) fail('LB_NO_PROFILE');
      if (input.consent !== true) fail('LB_CONSENT_REQUIRED');
      if (this.state.appts.filter((a) => a.hostId === uid && a.status === 'open').length >= FAKE_MAX_OPEN_HOSTED) {
        fail('LB_TOO_MANY_OPEN');
      }
      if (input.lat == null || input.lng == null) fail('LB_BAD_POSITION');
      this.checkPosition(input.lat, input.lng);
      const meetAtMs = this.resolveMeet(input.localAt, input.tz, input.lng, input.tzConfirmed === true);
      const policy = this.checkPolicy(input.policy);
      const times = lateTimes(policy, meetAtMs);
      const a: ApptRow = {
        id: this.nextId('appt'),
        inviteCode: this.newInviteCode(),
        hostId: uid,
        title: this.checkText(input.title, 1, 40, 'title'),
        localAt: msToLocalAt(meetAtMs, input.tz),
        tz: input.tz,
        meetAtMs,
        placeName: this.checkText(input.placeName, 1, 60, 'place_name'),
        placeNote: this.checkText(input.placeNote ?? '', 0, 200, 'place_note'),
        placeLat: input.lat,
        placeLng: input.lng,
        policy,
        shareStartMs: times.shareStartMs,
        closeMs: times.closeMs,
        joinClosed: false,
        status: 'open',
        voidReason: null,
        settledAtMs: null,
        version: 1,
        createdAtMs: this.nowMs(),
      };
      this.state.appts.push(a);
      this.insertPart(a.id, uid, (me as ProfileRow).nickname, 'active');
      this.hold(uid, a.id, policy.stake);
      return this.toAppointment(a, true);
    });
  }

  private insertPart(apptId: string, userId: string, nickname: string, state: LateMemberState): PartRow {
    const now = this.nowMs();
    const row: PartRow = {
      appointmentId: apptId,
      userId,
      nickname,
      state,
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

  /** #3 */
  peekInvite(uidRaw: string, code: string): LbInvitePreview {
    const uid = this.uid(uidRaw);
    this.tick();
    const a = this.apptByCode(code);
    if (!a || this.isBanned(a.id, uid)) fail('LB_INVITE_NOT_FOUND');
    const row = a as ApptRow;
    const mine = this.part(row.id, uid);
    const active = this.partsOf(row.id).filter((p) => p.state === 'active');
    const now = this.nowMs();
    return {
      id: row.id,
      title: row.title,
      localAt: row.localAt,
      tz: row.tz,
      meetAtMs: row.meetAtMs,
      shareStartMs: row.shareStartMs,
      closeMs: row.closeMs,
      placeName: row.placeName,
      placeNote: row.placeNote,
      placeLat: row.placeLat,
      placeLng: row.placeLng,
      status: row.status,
      version: row.version,
      joinClosed: row.joinClosed,
      needsApproval: now >= row.shareStartMs,
      serverNowMs: now,
      policy: { ...row.policy },
      memberCount: active.length,
      nicknames: mine?.state === 'active' ? active.map((p) => p.nickname) : [],
      myState: mine?.state ?? null,
      myBalance: this.profile(uid)?.balance ?? null,
    };
  }

  /** #4 */
  join(uidRaw: string, code: string, nickname: string, version: number, consent: boolean): LbJoinResult {
    const uid = this.uid(uidRaw);
    this.tick();
    return this.tx(() => this.joinInner(uid, code, nickname, version, consent, false));
  }

  private joinInner(
    uid: string,
    code: string,
    nickname: string,
    version: number,
    consent: boolean,
    forcePending: boolean,
  ): LbJoinResult {
    const found = this.apptByCode(code);
    if (!found || this.isBanned(found.id, uid)) fail('LB_INVITE_NOT_FOUND');
    const a = found as ApptRow;
    const mine = this.part(a.id, uid);
    if (mine) return { appointmentId: a.id, state: mine.state }; // 멱등

    const now = this.nowMs();
    if (a.status !== 'open' || a.joinClosed || now >= a.meetAtMs) fail('LB_JOIN_CLOSED');
    if (version !== a.version) fail('LB_APPT_CHANGED');
    if (consent !== true) fail('LB_CONSENT_REQUIRED');
    if (!this.profile(uid)) fail('LB_NO_PROFILE');
    const nick = cleanNick(nickname);
    const n = charLen(nick);
    if (n < 1 || n > 12) fail('LB_BAD_NICKNAME');
    const key = nickKey(nick);
    const rows = this.partsOf(a.id);
    if (rows.some((p) => nickKey(p.nickname) === key)) fail('LB_NICKNAME_TAKEN');

    if (forcePending || now >= a.shareStartMs) {
      if (rows.filter((p) => p.state === 'pending').length >= FAKE_MAX_PENDING) fail('LB_FULL');
      this.insertPart(a.id, uid, nick, 'pending');
      return { appointmentId: a.id, state: 'pending' };
    }
    if (rows.filter((p) => p.state === 'active').length >= FAKE_MAX_ACTIVE) fail('LB_FULL');
    this.insertPart(a.id, uid, nick, 'active');
    this.hold(uid, a.id, a.policy.stake); // 채워 줄 수도 없으면 예외 → 전체 롤백
    return { appointmentId: a.id, state: 'active' };
  }

  /** #5 */
  approve(uidRaw: string, apptId: string, target: string): void {
    const uid = this.uid(uidRaw);
    this.tick();
    this.tx(() => {
      const a = this.appt(apptId);
      if (!a || a.hostId !== uid) fail('LB_NOT_HOST');
      const row = a as ApptRow;
      if (row.status !== 'open' || this.nowMs() >= row.meetAtMs) fail('LB_JOIN_CLOSED');
      if (this.partsOf(apptId).filter((p) => p.state === 'active').length >= FAKE_MAX_ACTIVE) fail('LB_FULL');
      const t = this.part(apptId, target);
      if (!t || t.state !== 'pending') return; // 이미 승인됐거나 요청을 거둔 경우
      t.state = 'active';
      t.joinedAtMs = this.nowMs();
      this.hold(target, apptId, row.policy.stake);
    });
  }

  /** #6 */
  leave(uidRaw: string, apptId: string): void {
    const uid = this.uid(uidRaw);
    this.tick();
    this.tx(() => {
      const a = this.appt(apptId);
      if (!a) fail('LB_NOT_FOUND');
      const row = a as ApptRow;
      const me = this.part(apptId, uid);
      if (!me) return;
      if (me.state === 'pending') {
        this.removePart(apptId, uid);
        return;
      }
      if (row.hostId === uid) fail('LB_HOST_CANNOT_LEAVE');
      if (row.status !== 'open' || this.nowMs() >= row.shareStartMs) fail('LB_LEAVE_CLOSED');
      this.removePart(apptId, uid);
      if (row.policy.stake > 0) this.post(uid, apptId, 'refund', row.policy.stake, { reason: 'leave' });
    });
  }

  /** #7 */
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
      if (t.state === 'active') {
        if (row.status !== 'open' || this.nowMs() >= row.shareStartMs) fail('LB_KICK_CLOSED');
        this.removePart(apptId, target);
        if (row.policy.stake > 0) this.post(target, apptId, 'refund', row.policy.stake, { reason: 'kicked' });
      } else {
        this.removePart(apptId, target);
      }
      if (ban !== false && !this.isBanned(apptId, target)) this.state.bans.push(`${apptId}|${target}`);
    });
  }

  /** #8 */
  setJoinClosed(uidRaw: string, apptId: string, closed: boolean): void {
    const uid = this.uid(uidRaw);
    const a = this.appt(apptId);
    if (!a || a.hostId !== uid || a.status !== 'open') fail('LB_NOT_HOST');
    (a as ApptRow).joinClosed = closed !== false;
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

  /** #10 — 주최자 혼자일 때만. 옛 스테이크 환불 → 새 스테이크 에스크로 → version+1 */
  updateAppointment(uidRaw: string, apptId: string, input: LbUpdateInput): LbAppointment {
    const uid = this.uid(uidRaw);
    this.tick();
    return this.tx(() => {
      const a = this.appt(apptId);
      if (!a || a.hostId !== uid) fail('LB_NOT_HOST');
      const row = a as ApptRow;
      if (row.status !== 'open') fail('LB_EDIT_CLOSED');
      if (this.partsOf(apptId).some((p) => p.userId !== uid || p.arrivedAtMs !== null)) fail('LB_EDIT_LOCKED');
      if (input.lat == null || input.lng == null) fail('LB_BAD_POSITION');
      this.checkPosition(input.lat, input.lng);
      const meetAtMs = this.resolveMeet(input.localAt, input.tz, input.lng, input.tzConfirmed === true);
      const policy = this.checkPolicy(input.policy);

      if (row.policy.stake > 0) this.post(uid, apptId, 'refund', row.policy.stake, { reason: 'policy_change' });
      const times = lateTimes(policy, meetAtMs);
      row.localAt = msToLocalAt(meetAtMs, input.tz);
      row.tz = input.tz;
      row.meetAtMs = meetAtMs;
      row.placeName = this.checkText(input.placeName, 1, 60, 'place_name');
      row.placeLat = input.lat;
      row.placeLng = input.lng;
      row.policy = policy;
      row.shareStartMs = times.shareStartMs;
      row.closeMs = times.closeMs;
      row.version += 1;
      this.hold(uid, apptId, policy.stake);
      this.removeLoc(apptId);
      return this.toAppointment(row, true);
    });
  }

  /** #11 */
  cancel(uidRaw: string, apptId: string): void {
    const uid = this.uid(uidRaw);
    this.tick();
    this.tx(() => {
      const a = this.appt(apptId);
      if (!a || a.hostId !== uid) fail('LB_NOT_HOST');
      const row = a as ApptRow;
      if (row.status !== 'open') fail('LB_CANCEL_CLOSED');
      const others = this.partsOf(apptId).some((p) => p.state === 'active' && p.userId !== uid);
      if (this.nowMs() >= row.shareStartMs && others) fail('LB_CANCEL_CLOSED');
      for (const p of this.partsOf(apptId)) if (p.state === 'pending') this.removePart(apptId, p.userId);
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

  /** #12 — 위치 보고 = 도착 판정 (설계서 §2.3 판정표 순서 그대로) */
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
    else if (me.state === 'pending') reason = 'pending';
    else if (me.arrivedAtMs !== null) reason = 'already_arrived';
    else if (now < row.shareStartMs) reason = 'not_open';
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
      if (now < row.shareStartMs || now > row.closeMs) fail('LB_CLOSED');
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

  /** #15 */
  getLive(uidRaw: string, apptId: string): LbLive {
    const uid = this.uid(uidRaw);
    this.tick();
    if (!this.part(apptId, uid)) fail('LB_NOT_MEMBER');
    let a = this.appt(apptId) as ApptRow;
    const now0 = this.nowMs();
    if (
      a.status === 'open' &&
      (now0 > a.closeMs + FAKE_SETTLE_SLACK_MS ||
        (now0 >= a.meetAtMs && !this.partsOf(apptId).some((p) => p.state === 'active' && p.arrivedAtMs === null)))
    ) {
      this.trySettle(apptId);
      a = this.appt(apptId) as ApptRow;
    }
    this.purgeStale();

    const found = this.part(apptId, uid);
    if (!found) fail('LB_NOT_MEMBER'); // 정산이 승인 대기 요청을 지운 경우
    const me = found as PartRow;
    const now = this.nowMs();
    const shareOpen = a.status === 'open' && me.state === 'active' && now >= a.shareStartMs && now <= a.closeMs;

    const rows = this.partsOf(apptId).filter((p) => me.state === 'active' || p.userId === uid);
    const participants: LbLiveParticipant[] = rows.map((p) => {
      const l = this.state.locs.find((x) => x.appointmentId === apptId && x.userId === p.userId);
      const canSee = shareOpen && p.arrivedAtMs === null && l !== undefined;
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
      settlePending: a.status === 'open' && now > a.closeMs,
      appointment: this.toAppointment(a, me.state === 'active'),
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
      const rows = this.partsOf(a.id);
      out.push({
        id: a.id,
        title: a.title,
        localAt: a.localAt,
        tz: a.tz,
        meetAtMs: a.meetAtMs,
        shareStartMs: a.shareStartMs,
        closeMs: a.closeMs,
        placeName: a.placeName,
        status: a.status,
        policy: { ...a.policy },
        hostId: a.hostId,
        isHost: a.hostId === uid,
        myState: mine.state,
        memberCount: mine.state === 'active' ? rows.filter((p) => p.state === 'active').length : 0,
        pendingCount: a.hostId === uid ? rows.filter((p) => p.state === 'pending').length : 0,
      });
    }
    return out.sort((x, y) => {
      const xo = x.status === 'open' ? 0 : 1;
      const yo = y.status === 'open' ? 0 : 1;
      if (xo !== yo) return xo - yo;
      return xo === 0 ? x.meetAtMs - y.meetAtMs : y.meetAtMs - x.meetAtMs;
    });
  }

  /** 내 원장(최신순) */
  listLedger(uidRaw: string, limit = 100): LbLedgerEntry[] {
    const uid = this.uid(uidRaw);
    return this.state.ledger
      .filter((l) => l.userId === uid)
      .sort((x, y) => y.id - x.id)
      .slice(0, Math.max(1, limit))
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
    }
    const issued = ledger.filter((l) => l.kind === 'grant' || l.kind === 'relief').reduce((s, l) => s + l.amount, 0);
    const held = profiles.reduce((s, p) => s + p.balance, 0) + openEscrow;
    if (issued !== held) out.push({ problem: 'global_supply_mismatch', ref: '*', detail: `${issued} vs ${held}` });
    return out;
  }

  /** FakeDevPanel 용: 부작용 없이 약속 본문만 읽는다(정산·봇 이동을 일으키지 않는다). 없으면 null */
  appointmentInfo(apptId: string): LbAppointment | null {
    const a = this.appt(apptId);
    return a ? this.toAppointment(a, true) : null;
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

  private newBotUser(apptId: string, nickname?: string): { userId: string; nickname: string } {
    const taken = new Set(this.partsOf(apptId).map((p) => nickKey(p.nickname)));
    const name = nickname ?? BOT_NAMES.find((n) => !taken.has(nickKey(n))) ?? `친구${this.state.seq + 1}`;
    const userId = this.nextId('bot');
    this.ensureProfile(userId, name, true);
    return { userId, nickname: name };
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

  /**
   * 봇 한 명을 초대 코드로 참여시킨다 — 진짜 참여 규칙을 그대로 탄다.
   * 잠금 전이면 즉시 참여(+에스크로), 잠금 후면 참여 요청(pending)이 된다.
   */
  addBot(apptId: string, plan?: FakeBotPlan, nickname?: string): FakeBotInfo {
    this.tick();
    return this.tx(() => {
      const a = this.appt(apptId);
      if (!a) fail('LB_NOT_FOUND');
      const row = a as ApptRow;
      const count = this.state.bots.filter((b) => b.appointmentId === apptId).length;
      const chosen = plan ?? FAKE_BOT_PLANS[count % FAKE_BOT_PLANS.length];
      const bot = this.newBotUser(apptId, nickname);
      const res = this.joinInner(bot.userId, row.inviteCode, bot.nickname, row.version, true, false);
      this.planBot(row, bot.userId, chosen);
      return { userId: bot.userId, nickname: bot.nickname, plan: chosen, state: res.state, arrivedAtMs: null };
    });
  }

  /** 주최자 수락 흐름 확인용: 잠금 전이어도 봇의 '참여 요청'(pending)을 만든다(개발 전용 우회) */
  addBotRequest(apptId: string, plan: FakeBotPlan = 'onTime', nickname?: string): FakeBotInfo {
    this.tick();
    return this.tx(() => {
      const a = this.appt(apptId);
      if (!a) fail('LB_NOT_FOUND');
      const row = a as ApptRow;
      const bot = this.newBotUser(apptId, nickname);
      const res = this.joinInner(bot.userId, row.inviteCode, bot.nickname, row.version, true, true);
      this.planBot(row, bot.userId, plan);
      return { userId: bot.userId, nickname: bot.nickname, plan, state: res.state, arrivedAtMs: null };
    });
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
    return this.state.bots
      .filter((b) => b.appointmentId === apptId)
      .map((b) => {
        const p = this.part(apptId, b.userId);
        return {
          userId: b.userId,
          nickname: p?.nickname ?? this.profile(b.userId)?.nickname ?? '',
          plan: b.plan,
          state: p?.state ?? null,
          arrivedAtMs: p?.arrivedAtMs ?? null,
        };
      });
  }

  private botPosition(b: BotRow, a: ApptRow, t: number): { lat: number; lng: number } {
    const span = Math.max(1, b.arriveMs - b.departMs);
    const f = Math.min(1, Math.max(0, (t - b.departMs) / span));
    return { lat: b.startLat + (a.placeLat - b.startLat) * f, lng: b.startLng + (a.placeLng - b.startLng) * f };
  }

  /**
   * 봇의 시간을 지금까지 흘려보낸다. 모든 RPC 앞에서 불린다.
   * 빨리 감기로 건너뛴 구간의 도착은 '계획한 시각'으로 소급해서 찍는다(서버 규칙 안에서: 공개 시작 이후 ∧ 마감 이전 ∧ 승인 이후).
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
    for (const b of this.state.bots) {
      const a = this.appt(b.appointmentId);
      const p = this.part(b.appointmentId, b.userId);
      if (!a || !p || a.status !== 'open' || p.state !== 'active' || p.arrivedAtMs !== null) continue;
      if (b.plan === 'noShow' || now < a.shareStartMs) continue;

      if (b.plan === 'onTime' || b.plan === 'late') {
        const at = Math.max(b.arriveMs, a.shareStartMs, p.joinedAtMs);
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
      if (reportAt < a.shareStartMs || reportAt < p.joinedAtMs) continue;
      const pos = this.botPosition(b, a, reportAt);
      const near = haversineMeters(pos, { lat: a.placeLat, lng: a.placeLng }) <= a.policy.radiusM;
      const underground = b.plan === 'needsVouch' && near;
      if (underground && p.firstNearAtMs === null) {
        p.firstNearAtMs = Math.max(Math.min(b.arriveMs, now), a.shareStartMs, p.joinedAtMs);
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

    // 봇이 주최한 약속: 사람이 보낸 참여 요청을 잠시 뒤 수락한다
    for (const p of this.state.parts.filter((x) => x.state === 'pending')) {
      const a = this.appt(p.appointmentId);
      if (!a || a.status !== 'open' || !this.profile(a.hostId)?.isBot || this.profile(p.userId)?.isBot) continue;
      if (now < p.joinedAtMs + FAKE_BOT_HOST_APPROVE_MS || now >= a.meetAtMs) continue;
      try {
        this.approve(a.hostId, a.id, p.userId);
      } catch {
        // 포인트가 모자라면 요청은 그대로 남는다
      }
    }
  }

  // ───────────────────────── 데모 데이터 ─────────────────────────

  /** app/j 화면 확인용: 봇이 주최한 약속 4개(FAKE_DEMO_CODES). 이미 있으면 아무것도 안 한다 */
  seedDemo(): void {
    if (this.state.appts.some((a) => a.inviteCode === FAKE_DEMO_CODES.open)) return;
    const now = this.nowMs();
    const place = { lat: 37.49808, lng: 127.02761 };
    const make = (code: string, title: string, placeName: string, meetInMin: number, hostName: string, friends: string[]) => {
      const hostId = this.nextId('bot');
      this.ensureProfile(hostId, hostName, true);
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
        consent: true,
      });
      const row = this.appt(created.id) as ApptRow;
      row.inviteCode = code;
      this.planBot(row, hostId, 'onTime');
      friends.forEach((name, i) => {
        const bot = this.newBotUser(row.id, name);
        // 데모 친구는 잠금 여부와 상관없이 처음부터 활성 멤버로 둔다
        this.insertPart(row.id, bot.userId, bot.nickname, 'active');
        this.hold(bot.userId, row.id, row.policy.stake);
        this.planBot(row, bot.userId, i === 0 ? 'late' : 'onTime');
      });
      return row;
    };
    make(FAKE_DEMO_CODES.open, '금요일 곱창', '강남역 2번 출구 곱창', 180, '지수', ['현우', '태호']);
    make(FAKE_DEMO_CODES.locked, '번개 치맥', '강남역 11번 출구 치킨', 40, '민지', ['서연']);
    make(FAKE_DEMO_CODES.joinClosed, '동창 모임', '강남역 1번 출구 고깃집', 240, '도윤', ['하준']).joinClosed = true;
    const canceled = make(FAKE_DEMO_CODES.canceled, '취소된 약속', '강남역 5번 출구', 300, '유나', []);
    this.cancel(canceled.hostId, canceled.id);
  }
}

// ───────────────────────── LateBetApi 어댑터 ─────────────────────────

export interface FakeApiOptions {
  /** 응답 지연(ms). 앱에서는 네트워크처럼 보이게 조금 둔다. 테스트는 0 */
  latencyMs?: number;
  /** true 를 돌려주면 그 호출은 LB_OFFLINE 으로 실패한다(FakeDevPanel 의 '연결 끊기') */
  isOffline?: () => boolean;
}

/** FakeServer 를 '이 사용자'의 LateBetApi 로 감싼다 */
export function createFakeApi(server: FakeServer, userId: string = FAKE_ME, options: FakeApiOptions = {}): LateBetApi {
  const latency = options.latencyMs ?? 0;
  const run = async <T>(fn: () => T): Promise<T> => {
    if (latency > 0) await new Promise<void>((resolve) => setTimeout(resolve, latency));
    if (options.isOffline?.()) throw new LateBetError('LB_OFFLINE');
    return fn();
  };
  return {
    restoreSession: () => run(() => userId),
    ensureSignedIn: () => run(() => userId),
    ping: () => run(() => server.ping()),
    ensureProfile: (nickname) => run(() => server.ensureProfile(userId, nickname)),
    createAppointment: (input) => run(() => server.createAppointment(userId, input)),
    peekInvite: (code) => run(() => server.peekInvite(userId, normalizeCode(code) ?? code)),
    join: (code, nickname, version, consent) => run(() => server.join(userId, code, nickname, version, consent)),
    approve: (id, target) => run(() => server.approve(userId, id, target)),
    leave: (id) => run(() => server.leave(userId, id)),
    kick: (id, target, ban) => run(() => server.kick(userId, id, target, ban)),
    setJoinClosed: (id, closed) => run(() => server.setJoinClosed(userId, id, closed)),
    updateMemo: (id, title, placeNote) => run(() => server.updateMemo(userId, id, title, placeNote)),
    updateAppointment: (id, input) => run(() => server.updateAppointment(userId, id, input)),
    cancel: (id) => run(() => server.cancel(userId, id)),
    reportLocation: (id, input) => run(() => server.reportLocation(userId, id, input)),
    stopSharing: (id) => run(() => server.stopSharing(userId, id)),
    vouch: (id, target) => run(() => server.vouch(userId, id, target)),
    getLive: (id) => run(() => server.getLive(userId, id)),
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
    singleton = { server, api: createFakeApi(server, FAKE_ME, { latencyMs: 150, isOffline: () => offline }) };
  }
  return singleton;
}
