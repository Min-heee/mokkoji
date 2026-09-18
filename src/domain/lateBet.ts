/**
 * 약속 내기 — 지각 포인트 규칙 엔진 (순수 함수).
 *
 * 주최자가 1인당 걸 포인트(stake)를 정한다. 약속 시각까지 약속 장소 반경 안에 들어오면
 * 그대로 돌려받고, 지각하면 지각 단위마다 차감되며, 뺏긴 포인트는 제시간에 온 사람들이 1/n로 나눠 갖는다.
 *
 * 서버와 클라이언트가 같은 코드로 같은 결과를 내야 하므로:
 * - I/O·Date.now()·기기 타임존에 의존하지 않는다. 모든 시각은 epoch ms 인자로 받는다.
 * - 모든 포인트는 정수다. 정책(policy)은 어떤 쓰레기가 와도 함수 입구에서 정규화한다.
 * - 정산은 결정적이다(같은 입력 → 같은 출력, 입력 배열 순서 외의 우연에 기대지 않는다).
 */

export interface LatePolicy {
  /** 1인당 거는 포인트 (정수, 0이면 내기 없음) */
  stake: number;
  /** 도착 인정 반경 m (기본 100, 30~1000으로 클램프) */
  radiusM: number;
  /** 지각 단위 분 (양의 정수: 1, 5, 10 …) */
  unitMinutes: number;
  /** 지각 단위 1개당 차감 포인트 (정수 ≥ 0) */
  penaltyPerUnit: number;
  /** 봐주는 시간 분 (기본 0) */
  graceMinutes: number;
}

const MINUTE_MS = 60_000;

export const MIN_RADIUS_M = 30;
export const MAX_RADIUS_M = 1000;
/** 합계가 안전 정수 범위를 절대 넘지 않도록 두는 상한 (참가자 수백만 명이어도 안전) */
export const MAX_STAKE = 1_000_000_000;
/** 분 단위 값들의 상한 = 하루 */
const MAX_MINUTES = 24 * 60;
/**
 * 마감 이후 위치 공개 상한(분).
 * stake 10,000 · 1분당 1포인트 같은 정책이면 전액 몰수 시각이 일주일 뒤가 된다 —
 * 그동안 위치가 계속 노출되면 안 되므로 공개 창은 마감 + 이 시간에서 잘라낸다.
 */
export const MAX_SHARE_AFTER_DEADLINE_MINUTES = 180;
/** 전액 몰수 시각이 없을 때(내기 없음·단위 차감 0) 마감 후 공개 시간(분) */
export const DEFAULT_SHARE_AFTER_DEADLINE_MINUTES = 60;
/**
 * 전액 몰수 뒤에도 지각자 위치를 더 보여 주는 꼬리(분) — 오너 결정 변경 3(2026-09-18).
 * 전액을 잃은 사람도 오고 있으면 친구들이 볼 수 있어야 한다. 이 시각까지 체크인도 열려 있어
 * 꼬리 안에 온 사람은 '오지 않음'이 아니라 '지각(전액)'으로 남는다.
 */
export const SHARE_TAIL_AFTER_FULL_FORFEIT_MINUTES = 30;

export const DEFAULT_LATE_POLICY: LatePolicy = {
  stake: 0,
  radiusM: 100,
  unitMinutes: 5,
  penaltyPerUnit: 0,
  graceMinutes: 0,
};

/**
 * 유한한 number만 받아 내림 후 [min,max]로 클램프. 그 외(문자열·NaN·Infinity·null …)는 fallback.
 * 소수는 내림한다 — 입력보다 큰 포인트가 걸리는 일이 없게.
 */
function toInt(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/** 저장/네트워크 데이터 정규화. 어떤 쓰레기가 와도 안전한 정수 정책을 돌려준다 */
export function normalizeLatePolicy(raw: unknown): LatePolicy {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LATE_POLICY };
  const p = raw as Partial<Record<keyof LatePolicy, unknown>>;
  const d = DEFAULT_LATE_POLICY;
  return {
    stake: toInt(p.stake, d.stake, 0, MAX_STAKE),
    radiusM: toInt(p.radiusM, d.radiusM, MIN_RADIUS_M, MAX_RADIUS_M),
    unitMinutes: toInt(p.unitMinutes, d.unitMinutes, 1, MAX_MINUTES),
    penaltyPerUnit: toInt(p.penaltyPerUnit, d.penaltyPerUnit, 0, MAX_STAKE),
    graceMinutes: toInt(p.graceMinutes, d.graceMinutes, 0, MAX_MINUTES),
  };
}

/**
 * epoch ms로 인정하는 절대값 상한 = JS Date 한계(±8.64e15, 서기 ±27만 년).
 * '유한하지만 말이 안 되는' 시각(1e308 등)을 막는다 — JSON에는 Infinity 리터럴이 없어서
 * 네트워크로 실제 들어올 수 있는 쓰레기 시각은 Infinity가 아니라 이런 유한 거대값이다.
 * 이 범위 안에서는 두 시각의 차(≤ 1.728e16)가 절대 Infinity로 넘치지 않고,
 * 분·단위 수로 나눈 값은 항상 안전 정수다.
 */
export const MAX_EPOCH_MS = 8.64e15;

/** epoch ms로 쓸 수 있는 값인지 (유한하고 Date 범위 안인 number) */
function isValidMs(ms: unknown): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) <= MAX_EPOCH_MS;
}

/** 올림한 몫을 안전 정수로 (isValidMs 범위 안에서는 닿지 않는 이중 방어 — Infinity·1e303이 결과로 새지 않게) */
function ceilDivSafe(ms: number, unitMs: number): number {
  const q = Math.ceil(ms / unitMs);
  return Number.isFinite(q) ? Math.min(q, Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
}

/** null = 아직 안 옴/노쇼 */
export interface ArrivalRecord {
  personId: string;
  arrivedAtMs: number | null;
}

/**
 * 지각 단위 수 (정규화된 정책 기준).
 * - arrivedAtMs <= deadlineMs + grace → 0
 * - 그 외 ceil((arrivedAtMs - deadlineMs - graceMs) / unitMs) — 1ms만 늦어도 1단위
 * - 시각이 유효하지 않으면(NaN·Infinity·Date 범위 밖 거대값) 판정 불가 → 0.
 *   '도착 시각이 쓰레기'인 사람을 노쇼로 볼지는 penaltyFor/settleLateBet이 정한다.
 */
export function lateUnits(policy: LatePolicy, deadlineMs: number, arrivedAtMs: number): number {
  if (!isValidMs(deadlineMs) || !isValidMs(arrivedAtMs)) return 0;
  const p = normalizeLatePolicy(policy);
  const overMs = arrivedAtMs - deadlineMs - p.graceMinutes * MINUTE_MS;
  if (overMs <= 0) return 0;
  // 반환값은 항상 안전 정수 (시각 범위 제한 + 상한 클램프)
  return ceilDivSafe(overMs, p.unitMinutes * MINUTE_MS);
}

/**
 * 잃는 포인트.
 * - 마감 시각이 유효하지 않으면 판정 불가 → 0 (근거 없이 뺏지 않는다)
 * - null(노쇼)·유효하지 않은 도착 시각 → stake 전액
 * - 그 외 min(stake, lateUnits * penaltyPerUnit)
 */
export function penaltyFor(
  policy: LatePolicy,
  deadlineMs: number,
  arrivedAtMs: number | null,
): number {
  if (!isValidMs(deadlineMs)) return 0;
  const p = normalizeLatePolicy(policy);
  if (!isValidMs(arrivedAtMs)) return p.stake;
  if (p.penaltyPerUnit === 0) return 0;
  const units = lateUnits(p, deadlineMs, arrivedAtMs);
  // units * penaltyPerUnit 은 아주 늦은 시각에서 안전 정수를 넘을 수 있어 곱하기 전에 상한 단위 수로 자른다
  const unitsToFull = Math.ceil(p.stake / p.penaltyPerUnit);
  if (units >= unitsToFull) return p.stake;
  return units * p.penaltyPerUnit;
}

/**
 * 이 시각 '이후'(초과)에 도착하면 stake 전액 몰수. 정확히 이 시각 도착은 아직 전액이 아니다.
 * penaltyPerUnit이 0이면(지각으로는 전액에 도달 못 함) null. 내기가 없거나(stake 0) 마감이 유효하지 않아도 null.
 */
export function fullForfeitAtMs(policy: LatePolicy, deadlineMs: number): number | null {
  if (!isValidMs(deadlineMs)) return null;
  const p = normalizeLatePolicy(policy);
  if (p.stake === 0 || p.penaltyPerUnit === 0) return null;
  const unitsToFull = Math.ceil(p.stake / p.penaltyPerUnit);
  // k단위째는 (grace + (k-1)단위)를 넘는 순간 시작된다
  return deadlineMs + p.graceMinutes * MINUTE_MS + (unitsToFull - 1) * p.unitMinutes * MINUTE_MS;
}

/** 아직 안 온 사람이 '지금 도착하면' 잃는 포인트 (실시간 UI용). nowMs가 유효하지 않으면 0 */
export function projectedPenalty(policy: LatePolicy, deadlineMs: number, nowMs: number): number {
  if (!isValidMs(nowMs)) return 0;
  return penaltyFor(policy, deadlineMs, nowMs);
}

export type LateBetStatus = 'onTime' | 'late' | 'noShow';

export interface LateBetPersonResult {
  personId: string;
  /** 정산에 쓴 도착 시각 (여러 기록 중 가장 이른 유효 시각). 노쇼면 null */
  arrivedAtMs: number | null;
  /** onTime = 마감+grace 안에 도착 (포인트를 나눠 받는 사람) */
  status: LateBetStatus;
  /** 마감 시각 기준 지각 분 (올림, grace 미차감). onTime·noShow는 0 */
  lateMinutes: number;
  /** 잃은 포인트 ∈ [0, stake] */
  forfeited: number;
  /** 나눠 받은 포인트 ≥ 0 */
  received: number;
  /** received - forfeited */
  net: number;
}

/**
 * 무효 사유.
 * - noStake: 건 포인트가 0 (내기 없음)
 * - noWinner: 잃은 포인트는 있는데 제시간에 온 사람이 0명 → 받을 사람이 없어 전원 환불
 * - invalidDeadline: 마감 시각이 유효하지 않음(약속 시각 미정·쓰레기 값·Date 범위 밖) → 지각을 판정할 근거가 없어 전원 환불
 *
 * 명세 초안의 'noLoser'는 뺐다 — 아무도 안 잃은 건 무효가 아니라 정상 종료(voided=false, pot=0)다.
 * 'invalidDeadline'은 추가했다 — NaN 마감으로 전원이 조용히 '정시'나 '노쇼'가 되는 것보다
 * 호출부가 사유를 알 수 있는 편이 안전하다.
 */
export type LateBetVoidReason = 'noStake' | 'noWinner' | 'invalidDeadline';

export interface LateBetResult {
  /** participantIds 순서 (중복 제거) */
  persons: LateBetPersonResult[];
  /** 실제로 오간 포인트 합 = sum(forfeited) = sum(received). 무효면 0 */
  pot: number;
  voided: boolean;
  voidReason: LateBetVoidReason | null;
}

/**
 * 약속 내기 정산.
 * - 참가자 목록에 없는 arrival은 무시. arrival 기록이 없는 참가자는 노쇼.
 *   유효하지 않은 도착 시각(NaN·Infinity·Date 범위 밖 거대값)은 없는 기록으로 친다.
 *   같은 사람의 arrival이 여러 개면 가장 이른 유효 시각. participantIds 중복은 한 번만 센다.
 * - pot = 모든 사람의 forfeited 합. onTime인 n명이 floor(pot / n)씩 나눠 갖고,
 *   나머지 r포인트는 onTime 중 가장 일찍 도착한 r명에게 1포인트씩 (동률이면 participantIds 순서).
 * - 무효(voided)면 전원 forfeited=0, received=0. status·lateMinutes는 그대로 알려준다.
 * - 불변식: sum(net) === 0, 모든 값은 정수, forfeited ∈ [0, stake], received ≥ 0.
 */
export function settleLateBet(
  policy: LatePolicy,
  participantIds: string[],
  arrivals: ArrivalRecord[],
  deadlineMs: number,
): LateBetResult {
  const p = normalizeLatePolicy(policy);
  const deadlineOk = isValidMs(deadlineMs);

  // 참가자: 문자열 id만, 중복은 첫 등장만
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of Array.isArray(participantIds) ? participantIds : []) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  // 사람별 가장 이른 유효 도착 시각
  const earliest = new Map<string, number>();
  for (const a of Array.isArray(arrivals) ? arrivals : []) {
    if (!a || typeof a !== 'object') continue;
    if (!seen.has(a.personId) || !isValidMs(a.arrivedAtMs)) continue;
    const prev = earliest.get(a.personId);
    if (prev === undefined || a.arrivedAtMs < prev) earliest.set(a.personId, a.arrivedAtMs);
  }

  const persons: LateBetPersonResult[] = ids.map((personId) => {
    const arrivedAtMs = earliest.get(personId) ?? null;
    let status: LateBetStatus = 'noShow';
    let lateMinutes = 0;
    if (arrivedAtMs !== null) {
      // 마감이 유효하지 않으면 지각 판정 불가 → 도착한 사람은 onTime으로 둔다(어차피 무효 처리)
      const late = deadlineOk && lateUnits(p, deadlineMs, arrivedAtMs) > 0;
      status = late ? 'late' : 'onTime';
      if (late) lateMinutes = ceilDivSafe(arrivedAtMs - deadlineMs, MINUTE_MS);
    }
    const forfeited = deadlineOk ? penaltyFor(p, deadlineMs, arrivedAtMs) : 0;
    return { personId, arrivedAtMs, status, lateMinutes, forfeited, received: 0, net: 0 };
  });

  const refundAll = (voidReason: LateBetVoidReason): LateBetResult => ({
    persons: persons.map((r) => ({ ...r, forfeited: 0, received: 0, net: 0 })),
    pot: 0,
    voided: true,
    voidReason,
  });

  if (p.stake === 0) return refundAll('noStake');
  if (!deadlineOk) return refundAll('invalidDeadline');

  const pot = persons.reduce((s, r) => s + r.forfeited, 0);
  if (pot > 0) {
    // 받을 사람 = onTime. 일찍 온 순(동률이면 participantIds 순 — persons가 이미 그 순서라 인덱스로 가른다)
    const winners = persons
      .map((r, index) => ({ r, index }))
      .filter((w) => w.r.status === 'onTime')
      .sort((a, b) => (a.r.arrivedAtMs as number) - (b.r.arrivedAtMs as number) || a.index - b.index);
    if (winners.length === 0) return refundAll('noWinner');
    const share = Math.floor(pot / winners.length);
    const remainder = pot - share * winners.length;
    winners.forEach((w, rank) => {
      w.r.received = share + (rank < remainder ? 1 : 0);
    });
  }

  for (const r of persons) r.net = r.received - r.forfeited;
  // pot === 0 (아무도 안 잃음)은 무효가 아니라 정상 종료
  return { persons, pot, voided: false, voidReason: null };
}

/**
 * 체크인·위치 공개 마감 시각. SQL private.lb_close_at 과 같은 식이어야 한다.
 * - 전액 몰수 시각 + SHARE_TAIL_AFTER_FULL_FORFEIT_MINUTES(30분) — 전액을 잃은 뒤에도 오고 있는 사람을
 *   30분 더 보여 준다(오너 결정 변경 3). 전액 몰수 시각이 없으면(내기 없음·단위 차감 0) 마감 + 60분.
 * - 단 마감 + MAX_SHARE_AFTER_DEADLINE_MINUTES(180분)를 넘지 않는다 — 내기가 사실상 끝난 뒤에도
 *   위치가 계속 노출되면 안 된다(프라이버시).
 * - 이 값이 곧 체크인 마감(closeMs)이자 정산 기준 시각이다.
 * - 마감이 유효하지 않으면 null
 */
export function closeAtMs(policy: LatePolicy, deadlineMs: number): number | null {
  if (!isValidMs(deadlineMs)) return null;
  const p = normalizeLatePolicy(policy);
  const full = fullForfeitAtMs(p, deadlineMs);
  const cap = deadlineMs + MAX_SHARE_AFTER_DEADLINE_MINUTES * MINUTE_MS;
  return full === null
    ? deadlineMs + DEFAULT_SHARE_AFTER_DEADLINE_MINUTES * MINUTE_MS
    : Math.min(full + SHARE_TAIL_AFTER_FULL_FORFEIT_MINUTES * MINUTE_MS, cap);
}

/**
 * 위치 공개 창 [startMs, endMs] (양끝 포함).
 * - startMs = startedAtMs — 주최자가 [시작하기]를 누른 서버 시각(오너 결정 2026-09-18). 그 전에는 아무도 위치를 못 본다.
 * - endMs = closeAtMs (전액 몰수 시각 + 30분 꼬리, 상한 마감 + 180분, 전액 몰수 시각이 없으면 마감 + 60분)
 * - 아직 시작하지 않았거나(startedAtMs null) 시각이 유효하지 않으면 공개 창이 없다 → null
 */
export function locationShareWindow(
  policy: LatePolicy,
  deadlineMs: number,
  startedAtMs: number | null,
): { startMs: number; endMs: number } | null {
  if (!isValidMs(startedAtMs)) return null;
  const endMs = closeAtMs(policy, deadlineMs);
  if (endMs === null) return null;
  return { startMs: startedAtMs, endMs };
}

/**
 * 지금 이 사람의 위치를 다른 참가자에게 보여줘도 되는지.
 * 주최자가 시작했고, 공개 창 안이고, 아직 도착 전일 때만 true — 도착한 사람은 더 이상 위치를 공개하지 않는다.
 * 애매하면(쓰레기 시각·시작 전) 공개하지 않는 쪽으로 닫는다.
 */
export function isLocationShared(
  policy: LatePolicy,
  deadlineMs: number,
  startedAtMs: number | null,
  nowMs: number,
  hasArrived: boolean,
): boolean {
  if (hasArrived !== false) return false;
  if (!isValidMs(nowMs)) return false;
  const w = locationShareWindow(policy, deadlineMs, startedAtMs);
  if (w === null) return false;
  return nowMs >= w.startMs && nowMs <= w.endMs;
}
