/**
 * 약속 내기 — 정책 프리셋·검증·설명 문장 (순수 함수).
 *
 * - 프리셋 3종(순한맛·보통·매운맛)과 폼 선택지.
 * - validatePolicy: 서버 appointments 테이블의 CHECK 제약과 같은 식(설계서 부록 A).
 *   서버가 최종 권위다 — 여기서 통과해야만 RPC 를 부른다(23514 를 미리 막는다).
 * - describePolicy: 사용자에게 보여 줄 한국어 문장. '전액을 잃는 때'는 코드에 숫자를 적지 않고
 *   lateBet.fullForfeitAtMs 에서 파생한다(프리셋 표와 엔진이 어긋나는 사고 방지).
 *
 * Date.now()·기기 타임존에 의존하지 않는다. 시각 표시는 시간대를 인자로 받는다.
 */
import { fullForfeitAtMs, penaltyFor, type LatePolicy } from './lateBet';
import { lateTimes } from './latePhase';
import { formatKoreanTime, SEOUL_TZ } from './tzGuard';

const MINUTE_MS = 60_000;

// ───────────────────────── 서버 CHECK 와 같은 한계 ─────────────────────────

/** 서버 CHECK 의 범위(양끝 포함). 부록 A `create table public.appointments` 와 같아야 한다 */
export const POLICY_LIMITS = {
  stake: { min: 0, max: 300 },
  radiusM: { min: 30, max: 1000 },
  unitMinutes: { min: 1, max: 60 },
  penaltyPerUnit: { min: 0, max: 300 },
  graceMinutes: { min: 0, max: 30 },
  shareLocationMinutesBefore: { min: 30, max: 360 },
} as const satisfies Record<keyof LatePolicy, { min: number; max: number }>;

/** 전액 몰수까지 허용되는 최대 지각(분) — CHECK policy_reaches_full_within_cap */
export const FULL_FORFEIT_CAP_MINUTES = 180;

export const START_BALANCE = 1000;
export const MAX_STAKE_POINTS = POLICY_LIMITS.stake.max;

// ───────────────────────── 폼 선택지 ─────────────────────────

/** 걸 포인트: 없음(위치만) / 50 / 100 / 200 / 300 */
export const STAKE_CHOICES: readonly number[] = [0, 50, 100, 200, 300];
/** 봐주는 시간: 없음 / 5분 / 10분 */
export const GRACE_CHOICES: readonly number[] = [0, 5, 10];
/** 도착 인정 거리(m). '직접'은 폼이 POLICY_LIMITS.radiusM 안에서 받는다 */
export const RADIUS_CHOICES: readonly number[] = [50, 100, 200];
/** 위치 공개: 30분 / 1시간 / 2시간 전 */
export const SHARE_BEFORE_CHOICES: readonly number[] = [30, 60, 120];
/** 이 반경 이하면 폼이 경고한다: "지하·실내는 GPS가 잘 안 잡혀요. 100m를 권해요" */
export const SMALL_RADIUS_WARN_M = 50;

// ───────────────────────── 프리셋 ─────────────────────────

export type LatePresetId = 'mild' | 'normal' | 'spicy';

export interface LatePreset {
  id: LatePresetId;
  name: string;
  policy: LatePolicy;
}

const BASE = { radiusM: 100, graceMinutes: 0, shareLocationMinutesBefore: 60 } as const;

/** 기본값: 봐주는 시간 0분, 반경 100m, 공개 1시간 전 */
export const LATE_PRESETS: readonly LatePreset[] = [
  { id: 'mild', name: '순한맛', policy: { ...BASE, stake: 50, unitMinutes: 5, penaltyPerUnit: 5 } },
  { id: 'normal', name: '보통', policy: { ...BASE, stake: 100, unitMinutes: 5, penaltyPerUnit: 10 } },
  { id: 'spicy', name: '매운맛', policy: { ...BASE, stake: 300, unitMinutes: 1, penaltyPerUnit: 10 } },
];

export const DEFAULT_PRESET_ID: LatePresetId = 'normal';

export function getPreset(id: LatePresetId): LatePreset {
  return LATE_PRESETS.find((p) => p.id === id) ?? LATE_PRESETS[1];
}

/** 프리셋의 기본 정책 사본 */
export function presetPolicy(id: LatePresetId = DEFAULT_PRESET_ID): LatePolicy {
  return { ...getPreset(id).policy };
}

/**
 * 프리셋의 '맵기'(지각 단위·전액까지 걸리는 단위 수)는 두고 걸 포인트만 바꾼다.
 * 단위 차감은 올림한다 — 전액을 잃는 때가 프리셋보다 늦어지지 않아서 어떤 스테이크에서도 180분 제약을 통과한다.
 * stake 0(위치만)이면 차감도 0.
 */
export function policyWithStake(id: LatePresetId, stake: number, base?: Partial<LatePolicy>): LatePolicy {
  const preset = getPreset(id).policy;
  const s = Number.isFinite(stake)
    ? Math.min(POLICY_LIMITS.stake.max, Math.max(POLICY_LIMITS.stake.min, Math.floor(stake)))
    : preset.stake;
  const penaltyPerUnit = s === 0 ? 0 : Math.max(1, Math.ceil((s * preset.penaltyPerUnit) / preset.stake));
  return { ...preset, ...base, stake: s, unitMinutes: preset.unitMinutes, penaltyPerUnit };
}

/**
 * 정책이 어느 프리셋에서 나왔는지 (수정 화면 프리필용). 없으면 null.
 * 1) 스테이크까지 프리셋과 똑같으면 그 프리셋. 2) 아니면 스테이크만 바꾼 것과 같은 프리셋.
 * 순한맛과 보통은 차감 비율이 같아서(5분마다 10%) 스테이크를 바꾸면 구분되지 않는다 — 그때는 기본(보통)으로 본다.
 */
export function matchPreset(policy: LatePolicy): LatePresetId | null {
  const same = (a: LatePolicy) => a.unitMinutes === policy.unitMinutes && a.penaltyPerUnit === policy.penaltyPerUnit;
  const exact = LATE_PRESETS.find((p) => p.policy.stake === policy.stake && same(p.policy));
  if (exact) return exact.id;
  const ordered = [getPreset(DEFAULT_PRESET_ID), ...LATE_PRESETS.filter((p) => p.id !== DEFAULT_PRESET_ID)];
  return ordered.find((p) => same(policyWithStake(p.id, policy.stake)))?.id ?? null;
}

// ───────────────────────── 검증 (서버 CHECK 와 같은 식) ─────────────────────────

export type PolicyIssueField = keyof LatePolicy | 'fullForfeit';

export interface PolicyIssue {
  field: PolicyIssueField;
  message: string;
}

export interface PolicyValidation {
  ok: boolean;
  issues: PolicyIssue[];
}

const FIELD_NAMES: Record<keyof LatePolicy, string> = {
  stake: '걸 포인트',
  radiusM: '도착 인정 거리',
  unitMinutes: '지각 단위',
  penaltyPerUnit: '단위마다 잃는 포인트',
  graceMinutes: '봐주는 시간',
  shareLocationMinutesBefore: '위치 공개 시점',
};

const FIELD_UNITS: Record<keyof LatePolicy, string> = {
  stake: 'P',
  radiusM: 'm',
  unitMinutes: '분',
  penaltyPerUnit: 'P',
  graceMinutes: '분',
  shareLocationMinutesBefore: '분',
};

/**
 * 전액 몰수까지 걸리는 지각(분) — CHECK 의 좌변과 같은 식.
 * (ceil(stake / penaltyPerUnit) − 1) × unitMinutes + graceMinutes. 내기 없음·단위 차감 0이면 null.
 */
export function minutesToFullForfeit(policy: LatePolicy): number | null {
  if (policy.stake === 0 || policy.penaltyPerUnit === 0) return null;
  return (Math.ceil(policy.stake / policy.penaltyPerUnit) - 1) * policy.unitMinutes + policy.graceMinutes;
}

/**
 * 서버 CHECK 제약과 같은 식으로 검증한다. 값을 고쳐 주지 않는다(정규화는 lateBet.normalizeLatePolicy).
 * - 6개 필드: 정수 + 범위 (stake 0~300, radiusM 30~1000, unitMinutes 1~60, penaltyPerUnit 0~300,
 *   graceMinutes 0~30, shareLocationMinutesBefore 30~360)
 * - policy_reaches_full_within_cap: penaltyPerUnit = 0 or stake = 0 or
 *   (ceil(stake / penaltyPerUnit) − 1) × unitMinutes + graceMinutes <= 180
 */
export function validatePolicy(policy: LatePolicy): PolicyValidation {
  const issues: PolicyIssue[] = [];
  if (!policy || typeof policy !== 'object') {
    return { ok: false, issues: [{ field: 'stake', message: '설정 값을 확인해 주세요' }] };
  }
  let rangesOk = true;
  for (const field of Object.keys(POLICY_LIMITS) as (keyof LatePolicy)[]) {
    const v = policy[field] as unknown;
    const { min, max } = POLICY_LIMITS[field];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      rangesOk = false;
      const u = FIELD_UNITS[field];
      issues.push({ field, message: `${FIELD_NAMES[field]}: ${min}${u}~${max}${u} 사이로 정해 주세요` });
    }
  }
  if (rangesOk) {
    const minutes = minutesToFullForfeit(policy);
    if (minutes !== null && minutes > FULL_FORFEIT_CAP_MINUTES) {
      issues.push({
        field: 'fullForfeit',
        message: `건 포인트를 모두 잃기까지 ${minutes}분이 걸려요. ${FULL_FORFEIT_CAP_MINUTES}분 안에 끝나도록 잃는 포인트를 늘리거나 지각 단위를 줄여 주세요`,
      });
    }
  }
  return { ok: issues.length === 0, issues };
}

export function isValidPolicy(policy: LatePolicy): boolean {
  return validatePolicy(policy).ok;
}

// ───────────────────────── 설명 문장 ─────────────────────────

export interface PolicyDescription {
  /** 걸 포인트 아래 */
  stake: string;
  /** 늦으면(프리셋) 아래 */
  penalty: string;
  /** 예시: '10분 늦으면 −20P'. 내기가 없거나 단위 차감이 0이면 '' */
  example: string;
  /** 전액을 잃는 때: '45분 넘게 늦으면 100P를 모두 잃어요.' 내기가 없으면 '' */
  full: string;
  /** 체크인 마감: '오후 8:15가 지나면 체크인이 닫히고 100P를 모두 잃어요.' */
  close: string;
  /** 봐주는 시간 아래 */
  grace: string;
  /** 도착 인정 거리 아래 */
  radius: string;
  /** 위치 공개 아래: '오후 6:30부터 서로 위치가 보여요. 그 뒤에는 빠질 수 없어요.' */
  share: string;
  /** 위 문장 중 빈 것을 뺀 전체(미리보기·참여 카드의 '정책 전문') */
  lines: string[];
  /** 전액을 잃기 시작하는 경계 시각 = lateBet.fullForfeitAtMs. 없으면 null */
  fullForfeitAtMs: number | null;
  /** 그 경계가 약속 시각에서 몇 분 뒤인가 ('N분 넘게 늦으면'의 N). 없으면 null */
  fullLateMinutes: number | null;
  /** 위치 공개 시작 = 체크인 개시 = 잠금 */
  shareStartMs: number;
  /** 체크인·위치 공개 종료 */
  closeMs: number;
}

/** 'N분' 또는 'N시간 M분' */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}분`;
  return m % 60 === 0 ? `${m / 60}시간` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

/** 잃는 포인트 표기: '−20P' (U+2212). 0이면 '0P' */
export function formatLoss(points: number): string {
  return points > 0 ? `−${points}P` : '0P';
}

/**
 * 한 줄 요약(공유 문구·홈 카드): '100P 걸기 · 5분 늦을 때마다 10P'
 * 내기 없음 → '포인트 없이 위치만 공유', 단위 차감 0 → '100P 걸기 · 오지 않으면 모두 잃어요'
 */
export function shortPolicyLine(policy: LatePolicy): string {
  if (policy.stake === 0) return '포인트 없이 위치만 공유';
  if (policy.penaltyPerUnit === 0) return `${policy.stake}P 걸기 · 오지 않으면 모두 잃어요`;
  return `${policy.stake}P 걸기 · ${policy.unitMinutes}분 늦을 때마다 ${policy.penaltyPerUnit}P`;
}

/**
 * 정책 설명 문장. 시각은 tz 의 벽시계로 적는다(기본 한국 시각).
 * 모든 시각·분은 엔진(fullForfeitAtMs·penaltyFor·locationShareWindow)에서 계산한 값이다.
 */
export function describePolicy(policy: LatePolicy, meetAtMs: number, tz: string = SEOUL_TZ): PolicyDescription {
  const { stake, penaltyPerUnit, unitMinutes, graceMinutes, radiusM } = policy;
  const { shareStartMs, closeMs } = lateTimes(policy, meetAtMs);
  const fullAt = fullForfeitAtMs(policy, meetAtMs);
  const fullLateMinutes = fullAt === null ? null : Math.round((fullAt - meetAtMs) / MINUTE_MS);
  const closeTime = formatKoreanTime(closeMs, tz);

  const stakeLine =
    stake === 0
      ? '포인트는 걸지 않고 위치만 공유해요.'
      : `한 사람당 ${stake}P를 걸어요. 제시간에 오면 그대로 돌려받고, 늦은 사람이 잃은 포인트는 제시간에 온 사람들이 나눠 가져요.`;

  let penaltyLine = '';
  let example = '';
  let full = '';
  let close = closeTime ? `${closeTime}에 체크인이 닫혀요.` : '';
  if (stake > 0 && penaltyPerUnit === 0) {
    penaltyLine = '늦어도 포인트를 잃지 않아요. 끝까지 오지 않을 때만 잃어요.';
    if (closeTime) close = `${closeTime}까지 오지 않으면 ${stake}P를 모두 잃어요.`;
  } else if (stake > 0) {
    const from = graceMinutes > 0 ? `${formatMinutes(graceMinutes)}을 넘겨 ` : '';
    const first = graceMinutes > 0 ? '' : ` 1분만 늦어도 ${Math.min(stake, penaltyPerUnit)}P예요.`;
    penaltyLine = `${from}늦으면 ${unitMinutes}분마다 ${penaltyPerUnit}P씩 잃어요.${first}`;
    // 예시: 봐주는 시간 + 지각 단위 2개만큼 늦었을 때
    const exampleLate = graceMinutes + unitMinutes * 2;
    const loss = penaltyFor(policy, meetAtMs, meetAtMs + exampleLate * MINUTE_MS);
    if (loss > 0 && loss < stake) example = `${formatMinutes(exampleLate)} 늦으면 ${formatLoss(loss)}`;
    if (fullLateMinutes !== null) {
      full =
        fullLateMinutes > 0
          ? `${formatMinutes(fullLateMinutes)} 넘게 늦으면 ${stake}P를 모두 잃어요.`
          : `조금이라도 늦으면 ${stake}P를 모두 잃어요.`;
    }
    if (closeTime) close = `${closeTime}가 지나면 체크인이 닫히고 ${stake}P를 모두 잃어요.`;
  }

  const grace =
    graceMinutes === 0
      ? '봐주는 시간은 없어요. 약속 시각이 마감이에요.'
      : `약속 시각에서 ${formatMinutes(graceMinutes)}까지는 늦어도 봐줘요.`;
  const radius = `약속 장소 ${radiusM}m 안에 들어오면 도착이에요.`;
  const shareTime = formatKoreanTime(shareStartMs, tz);
  const share = shareTime ? `${shareTime}부터 서로 위치가 보여요. 그 뒤에는 빠질 수 없어요.` : '';

  const lines = [stakeLine, penaltyLine, example, full, grace, radius, share, close].filter((s) => s !== '');
  return {
    stake: stakeLine,
    penalty: penaltyLine,
    example,
    full,
    close,
    grace,
    radius,
    share,
    lines,
    fullForfeitAtMs: fullAt,
    fullLateMinutes,
    shareStartMs,
    closeMs,
  };
}
