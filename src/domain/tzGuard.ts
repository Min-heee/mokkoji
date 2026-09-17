/**
 * 약속 내기 — 시간대 가드와 '시간대를 명시한' 시각 표시 (순수 함수).
 *
 * 약속 시각은 벽시계 문자열('YYYY-MM-DDTHH:mm') + IANA 시간대로 서버에 보낸다.
 * 여행 약속에서 "서울 시각으로 잡았는데 핀은 방콕" 같은 사고를 막기 위해:
 * - needsTzChoice: 시간대 시트를 띄워야 하는 조건 (설계서 §5.3-B)
 * - isTzSuspect: 서버 lb_resolve_meet 의 LB_TZ_SUSPECT 와 같은 식 (경도/15 와 1.5시간 넘게 어긋남)
 *
 * 이 모듈의 모든 시각 함수는 시간대를 인자로 받는다 — 기기 타임존·Date.now()에 기대지 않는다.
 * Intl 이 그 시간대를 모르면(아주 오래된 엔진) 아래 고정 오프셋 표로, 그것도 없으면 한국 시각으로 떨어진다.
 */

export const SEOUL_TZ = 'Asia/Seoul';

// ───────────────────────── 한국 판정·시간대 시트 ─────────────────────────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 핀이 한국 안인가 — 위도 33~39, 경도 124~132 (경계 포함). 좌표가 쓰레기면 false */
export function isInKorea(lat: number, lng: number): boolean {
  if (!isNum(lat) || !isNum(lng)) return false;
  return lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132;
}

/**
 * 시간대 시트를 띄워야 하는가.
 * - 기기 tz 가 Asia/Seoul 이 아님 → true
 * - 기기 tz 가 Asia/Seoul 인데 핀이 한국 밖 → true
 * - 핀을 아직 안 정했으면(null) 핀 조건은 건너뛴다
 * 기기 tz 를 알 수 없으면(빈 값) 한국으로 본다 — 그래도 핀이 한국 밖이면 시트가 뜬다.
 * (서버가 LB_TZ_SUSPECT 를 던진 경우는 호출부가 따로 시트를 띄운다)
 */
export function needsTzChoice(
  deviceTz: string | null | undefined,
  lat: number | null | undefined,
  lng: number | null | undefined,
): boolean {
  const tz = typeof deviceTz === 'string' && deviceTz.trim() !== '' ? deviceTz.trim() : SEOUL_TZ;
  if (tz !== SEOUL_TZ) return true;
  if (lat === null || lat === undefined || lng === null || lng === undefined) return false;
  return !isInKorea(lat, lng);
}

export interface TzChoice {
  /** IANA 이름 */
  tz: string;
  /** 도시(또는 나라) 이름 — 시트의 한 줄 */
  city: string;
  /** '도쿄 시각' 같은 라벨 */
  label: string;
  /** 표준시 오프셋(분). Intl 이 없을 때의 대체값이자 목록 정렬 기준. 서머타임은 반영하지 않는다 */
  standardOffsetMinutes: number;
}

const choice = (tz: string, city: string, standardOffsetMinutes: number): TzChoice => ({
  tz,
  city,
  label: `${city} 시각`,
  standardOffsetMinutes,
});

/** 시간대 시트의 도시 목록 — 한국에서 자주 가는 곳 위주 */
export const TZ_CHOICES: readonly TzChoice[] = [
  choice(SEOUL_TZ, '한국', 540),
  choice('Asia/Tokyo', '도쿄', 540),
  choice('Asia/Shanghai', '베이징·상하이', 480),
  choice('Asia/Taipei', '타이베이', 480),
  choice('Asia/Hong_Kong', '홍콩', 480),
  choice('Asia/Manila', '마닐라·세부', 480),
  choice('Asia/Singapore', '싱가포르', 480),
  choice('Asia/Bangkok', '방콕', 420),
  choice('Asia/Ho_Chi_Minh', '다낭·호치민', 420),
  choice('Pacific/Guam', '괌', 600),
  choice('Australia/Sydney', '시드니', 600),
  choice('Pacific/Honolulu', '하와이', -600),
  choice('America/Los_Angeles', '로스앤젤레스', -480),
  choice('America/New_York', '뉴욕', -300),
  choice('Europe/London', '런던', 0),
  choice('Europe/Paris', '파리', 60),
];

const CHOICE_BY_TZ = new Map(TZ_CHOICES.map((c) => [c.tz, c]));

/** IANA 이름 모양인가 (서버가 pg_timezone_names 로 최종 검증한다 — 여기서는 모양만) */
function looksLikeTz(tz: unknown): tz is string {
  return typeof tz === 'string' && /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(tz) && tz.length <= 64;
}

/** 'Asia/Seoul' → '한국 시각', 목록에 없는 tz 는 마지막 조각으로 ('America/Sao_Paulo' → 'Sao Paulo 시각') */
export function tzLabel(tz: string | null | undefined): string {
  if (!looksLikeTz(tz)) return CHOICE_BY_TZ.get(SEOUL_TZ)!.label;
  const known = CHOICE_BY_TZ.get(tz);
  if (known) return known.label;
  const last = tz.split('/').pop() ?? tz;
  return `${last.replace(/_/g, ' ')} 시각`;
}

/** 시트에 그릴 목록: 고정 목록 + (목록에 없으면) 기기 tz 를 한국 바로 다음에 */
export function tzChoices(deviceTz?: string | null): TzChoice[] {
  const list = [...TZ_CHOICES];
  if (looksLikeTz(deviceTz) && !CHOICE_BY_TZ.has(deviceTz)) {
    const last = (deviceTz.split('/').pop() ?? deviceTz).replace(/_/g, ' ');
    const offset = tzOffsetMinutes(0, deviceTz) ?? 0;
    list.splice(1, 0, { tz: deviceTz, city: `${last} (이 기기)`, label: tzLabel(deviceTz), standardOffsetMinutes: offset });
  }
  return list;
}

// ───────────────────────── 시간대 오프셋·벽시계 변환 ─────────────────────────

const MAX_EPOCH_MS = 8.64e15;
const isMs = (v: unknown): v is number => isNum(v) && Math.abs(v) <= MAX_EPOCH_MS;

const formatterCache = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(tz: string): Intl.DateTimeFormat | null {
  if (formatterCache.has(tz)) return formatterCache.get(tz) ?? null;
  let f: Intl.DateTimeFormat | null = null;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    f = null; // 모르는 시간대(RangeError) 또는 Intl 없음
  }
  formatterCache.set(tz, f);
  return f;
}

/**
 * 그 순간 그 시간대의 UTC 오프셋(분, 동쪽이 +). 모르는 시간대면 null.
 * Intl 로 구하고, 안 되면 TZ_CHOICES 의 표준시 오프셋으로 대신한다.
 */
export function tzOffsetMinutes(ms: number, tz: string): number | null {
  if (!isMs(ms) || !looksLikeTz(tz)) return null;
  const f = formatterFor(tz);
  if (f) {
    try {
      const parts: Record<string, number> = {};
      for (const p of f.formatToParts(new Date(ms))) {
        if (p.type !== 'literal') parts[p.type] = Number(p.value);
      }
      const hour = parts.hour === 24 ? 0 : parts.hour; // 일부 엔진은 자정을 24로 준다
      const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second);
      // 1000년 이전 등에서 Date.UTC 가 두 자리 연도를 1900년대로 읽는 경우는 약속 범위 밖이라 무시
      const floored = Math.floor(ms / 1000) * 1000;
      const diff = (asUtc - floored) / 60_000;
      if (Number.isFinite(diff)) return Math.round(diff);
    } catch {
      // 아래 대체 경로로
    }
  }
  return CHOICE_BY_TZ.get(tz)?.standardOffsetMinutes ?? null;
}

/** Intl 또는 고정 목록이 아는 시간대인가 */
export function isKnownTz(tz: string | null | undefined): tz is string {
  return looksLikeTz(tz) && tzOffsetMinutes(0, tz) !== null;
}

const LOCAL_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const pad2 = (n: number) => `${n}`.padStart(2, '0');

/**
 * 벽시계 문자열 + 시간대 → 절대 시각(epoch ms). 형식이 틀렸거나 없는 날짜(2월 30일)·모르는 시간대면 null.
 * 서머타임으로 '없는 시각'은 전환 뒤로 민다(PostgreSQL 과 같은 방향). '두 번 있는 시각'은 둘 중 하나로 정해진다.
 * 최종 값은 서버(lb_resolve_meet)가 정한다 — 이 함수는 미리보기와 fakeApi 용이다.
 */
export function wallClockToMs(localAt: string, tz: string): number | null {
  const m = typeof localAt === 'string' ? LOCAL_AT_RE.exec(localAt) : null;
  if (!m) return null;
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59) return null;
  const wallUtc = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(wallUtc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;

  const off1 = tzOffsetMinutes(wallUtc, tz);
  if (off1 === null) return null;
  const t1 = wallUtc - off1 * 60_000;
  const off2 = tzOffsetMinutes(t1, tz);
  if (off2 === null || off2 === off1) return t1;
  const t2 = wallUtc - off2 * 60_000;
  const off3 = tzOffsetMinutes(t2, tz);
  if (off3 === off2) return t2; // 전환 경계 근처: 두 번째 추정이 자기 오프셋과 맞는다
  // 없는 시각(서머타임 시작의 빈 구간): 전환 뒤 쪽으로
  return Math.max(t1, t2);
}

export interface WallClock {
  year: number;
  /** 1~12 */
  month: number;
  day: number;
  /** 0~23 */
  hour: number;
  minute: number;
  /** 0=일 … 6=토 */
  weekday: number;
}

/** 절대 시각을 그 시간대의 벽시계로. 모르는 시간대면 한국 시각으로 읽는다. ms 가 쓰레기면 null */
export function wallClockAt(ms: number, tz: string): WallClock | null {
  if (!isMs(ms)) return null;
  const offset = tzOffsetMinutes(ms, tz) ?? 540;
  const d = new Date(ms + offset * 60_000);
  if (Number.isNaN(d.getTime())) return null;
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

/** 절대 시각 → 'YYYY-MM-DDTHH:mm' (그 시간대의 벽시계). 실패하면 '' */
export function msToLocalAt(ms: number, tz: string): string {
  const w = wallClockAt(ms, tz);
  if (!w) return '';
  return `${`${w.year}`.padStart(4, '0')}-${pad2(w.month)}-${pad2(w.day)}T${pad2(w.hour)}:${pad2(w.minute)}`;
}

// ───────────────────────── 한국어 표시 ─────────────────────────

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** '오후 7:30' */
export function formatKoreanTime(ms: number, tz: string): string {
  const w = wallClockAt(ms, tz);
  if (!w) return '';
  const ampm = w.hour < 12 ? '오전' : '오후';
  const h12 = w.hour % 12 === 0 ? 12 : w.hour % 12;
  return `${ampm} ${h12}:${pad2(w.minute)}`;
}

/** '9월 25일 (금)' */
export function formatKoreanDate(ms: number, tz: string): string {
  const w = wallClockAt(ms, tz);
  if (!w) return '';
  return `${w.month}월 ${w.day}일 (${WEEKDAYS[w.weekday]})`;
}

/** '9월 25일 (금) 오후 7:30' — 기존 formatAppointmentTime 과 같은 모양 */
export function formatKoreanDateTime(ms: number, tz: string): string {
  const date = formatKoreanDate(ms, tz);
  return date ? `${date} ${formatKoreanTime(ms, tz)}` : '';
}

/** 두 시각이 그 시간대에서 같은 날짜인가 (홈 카드의 [오늘] 배지) */
export function isSameLocalDay(aMs: number, bMs: number, tz: string): boolean {
  const a = wallClockAt(aMs, tz);
  const b = wallClockAt(bMs, tz);
  return !!a && !!b && a.year === b.year && a.month === b.month && a.day === b.day;
}

/**
 * 남은 시간 문구. deltaMs = 대상 시각 − 서버 현재 시각.
 * '2시간 10분 뒤' · '35분 뒤' · '3일 뒤' · '1일 4시간 뒤' · '곧'(1분 미만) · 지났으면 '12분 지남'
 */
export function formatFromNow(deltaMs: number): string {
  if (!isNum(deltaMs)) return '';
  const past = deltaMs < 0;
  const totalMin = Math.floor(Math.abs(deltaMs) / 60_000);
  if (totalMin < 1) return past ? '방금 지남' : '곧';
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  let body: string;
  if (days >= 2) body = `${days}일`;
  else if (days === 1) body = hours > 0 ? `1일 ${hours}시간` : '1일';
  else if (hours > 0) body = mins > 0 ? `${hours}시간 ${mins}분` : `${hours}시간`;
  else body = `${mins}분`;
  return past ? `${body} 지남` : `${body} 뒤`;
}

// ───────────────────────── 서버와 같은 의심 판정 ─────────────────────────

/** 서버 LB_TZ_SUSPECT 기준(시간) */
export const TZ_SUSPECT_HOURS = 1.5;

/**
 * 서버 lb_resolve_meet 와 같은 식: |그 시각의 tz 오프셋(시간) − 경도/15| > 1.5.
 * 모르는 시간대·쓰레기 값이면 true (확인을 받는 쪽으로 닫는다).
 */
export function isTzSuspect(tz: string, lng: number, atMs: number): boolean {
  if (!isNum(lng)) return true;
  const off = tzOffsetMinutes(atMs, tz);
  if (off === null) return true;
  return Math.abs(off / 60 - lng / 15) > TZ_SUSPECT_HOURS;
}
