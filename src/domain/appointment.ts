import { haversineMeters, isValidGeoPoint, type GeoPoint } from './geo';
import { mapRouteUrl } from './mapRoute';
import type { Appointment, Session } from './types';

/**
 * 약속(시간·장소) 표시와 정렬을 위한 순수 로직.
 * 지도 SDK 없이 동작한다 — 길찾기는 지도 앱 링크를 연다(핀이 있으면 좌표, 없으면 장소 이름 검색).
 */

export const EMPTY_APPOINTMENT: Appointment = {
  at: null,
  place: '',
  placeNote: '',
};

/**
 * 약속 시각 저장 형식 = 타임존 없는 '벽시계' 문자열 'YYYY-MM-DDTHH:mm'.
 *
 * 약속은 "그 동네에서 몇 시에 만난다"는 뜻이라 절대 시각(UTC 순간)으로 저장하면
 * 안 된다 — 여행 중 기기 타임존이 바뀌는 순간 표시 시각이 통째로 밀린다
 * (서울에서 잡은 19:30이 방콕에서 17:30으로 보이고, 고쳐 넣으면 서울에서 21:30이 된다).
 * 예전 데이터는 절대 시각 ISO('...Z')라, 읽을 때 한 번만 그 기기의 벽시계로
 * 옮겨 적어 새 형식으로 정규화한다(normalizeAppointment).
 */
const LOCAL_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const pad2 = (n: number) => `${n}`.padStart(2, '0');

/** Date → 벽시계 문자열 */
function formatLocalAt(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 저장된 at → Date.
 * 벽시계 문자열이면 기기 타임존과 무관하게 적힌 그대로,
 * 예전 절대 시각 ISO면 지금 기기 타임존의 벽시계로 읽는다.
 */
function parseAt(at: string | null | undefined): Date | null {
  if (!at) return null;
  const m = LOCAL_AT_RE.exec(at);
  if (m) {
    const d = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      0,
      0,
    );
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const legacy = new Date(at);
  return Number.isNaN(legacy.getTime()) ? null : legacy;
}

/** 저장 데이터 정규화 (예전 모임엔 appointment가 없다) */
export function normalizeAppointment(raw: unknown): Appointment {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_APPOINTMENT };
  const a = raw as Partial<Appointment>;
  // 예전 절대 시각 ISO는 이 기기의 벽시계로 한 번 옮겨 적는다
  const parsed = typeof a.at === 'string' ? parseAt(a.at) : null;
  const out: Appointment = {
    at: parsed ? formatLocalAt(parsed) : null,
    place: typeof a.place === 'string' ? a.place : '',
    placeNote: typeof a.placeNote === 'string' ? a.placeNote : '',
  };
  // 핀은 위도·경도가 둘 다 유효할 때만 싣는다. 옛 데이터(좌표 없음)·쓰레기 좌표(범위 밖·NaN·한쪽만)는
  // 필드를 싣지 않는다(= 핀 없음). null 을 따로 적지 않는 건 좌표 없는 기존 약속의 모양을 그대로 두기 위해서다
  const point = { lat: a.placeLat, lng: a.placeLng };
  if (isValidGeoPoint(point)) {
    out.placeLat = point.lat;
    out.placeLng = point.lng;
  }
  return out;
}

/** 약속의 핀(지도에서 정한 좌표). 없거나 쓰레기 값이면 null */
export function appointmentPoint(a: Appointment | null | undefined): GeoPoint | null {
  if (!a) return null;
  const p = { lat: a.placeLat, lng: a.placeLng };
  return isValidGeoPoint(p) ? { lat: p.lat, lng: p.lng } : null;
}

/** 이름 없이 핀만 있는 장소의 표시 이름 */
export const PINNED_PLACE_FALLBACK_NAME = '지도에서 정한 장소';

/**
 * 화면에 보일 장소 이름. 이름이 있으면 그대로, 이름 없이 핀만 있으면 '지도에서 정한 장소', 둘 다 없으면 ''.
 * (지도에서 고른 곳에 이름이 안 붙었어도 '장소 미정'으로 보이면 안 된다)
 */
export function appointmentPlaceLabel(a: Appointment | null | undefined): string {
  if (!a) return '';
  const name = a.place.trim();
  if (name) return name;
  return appointmentPoint(a) ? PINNED_PLACE_FALLBACK_NAME : '';
}

/** 약속에 볼 만한 내용이 있는지 (시간이나 장소 중 하나라도) */
export function hasAppointment(a: Appointment | null | undefined): boolean {
  if (!a) return false;
  return Boolean(a.at) || appointmentPlaceLabel(a) !== '';
}

/** 약속 시각(ms). 없으면 null */
export function appointmentTime(a: Appointment | null | undefined): number | null {
  const d = parseAt(a?.at);
  return d ? d.getTime() : null;
}

export type AppointmentStatus = 'upcoming' | 'today' | 'past' | 'none';

/** 약속 상태. today = 같은 날(아직 안 지남), past = 이미 지난 시각 */
export function appointmentStatus(
  a: Appointment | null | undefined,
  now: number,
): AppointmentStatus {
  const t = appointmentTime(a);
  if (t == null) return 'none';
  if (t < now) return 'past';
  const d = new Date(t);
  const n = new Date(now);
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();
  return sameDay ? 'today' : 'upcoming';
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** "8월 3일 (토) 오후 7:30" 형태. 시각이 없으면 빈 문자열 */
export function formatAppointmentTime(at: string | null): string {
  const d = parseAt(at);
  if (!d) return '';
  const hour = d.getHours();
  const ampm = hour < 12 ? '오전' : '오후';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]}) ${ampm} ${h12}:${mm}`;
}

/** "오늘", "내일", "3일 뒤", "지났어요" 같은 짧은 라벨 */
export function formatCountdown(at: string | null, now: number): string {
  const parsed = parseAt(at);
  if (!parsed) return '';
  const t = parsed.getTime();
  const startOf = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((startOf(t) - startOf(now)) / 86400000);
  if (t < now) {
    if (days === 0) return '오늘 (지남)';
    return days === -1 ? '어제' : `${-days}일 전`;
  }
  if (days === 0) {
    const mins = Math.round((t - now) / 60000);
    if (mins < 60) return `${Math.max(1, mins)}분 뒤`;
    return `${Math.round(mins / 60)}시간 뒤`;
  }
  if (days === 1) return '내일';
  return `${days}일 뒤`;
}

/**
 * 약속 목록 정렬: 다가오는 약속이 가까운 순으로 먼저,
 * 그다음 시간 없는 약속, 마지막에 지난 약속(최근 순).
 */
export function compareByAppointment(a: Session, b: Session, now: number): number {
  const ta = appointmentTime(a.appointment);
  const tb = appointmentTime(b.appointment);
  const rank = (t: number | null) => (t == null ? 1 : t >= now ? 0 : 2);
  const ra = rank(ta);
  const rb = rank(tb);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return (ta as number) - (tb as number); // 임박한 순
  if (ra === 2) return (tb as number) - (ta as number); // 최근에 지난 순
  // 둘 다 시간 없음 → 최근 생성 순
  return b.createdAt.localeCompare(a.createdAt);
}

/** 편집 입력용 "YYYY-MM-DDTHH:mm" (벽시계 기준) */
export function toLocalInputValue(at: string | null): string {
  const d = parseAt(at);
  return d ? formatLocalAt(d) : '';
}

/** 날짜·시간 조각으로 벽시계 문자열 만들기. 유효하지 않으면 null */
export function buildLocalAt(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string | null {
  if (![year, month, day, hour, minute].every((n) => Number.isInteger(n))) return null;
  if (year < 1000 || year > 9999) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // 시·분 범위 검사. 없으면 19:99가 20:39로 조용히 굴러간다
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  // 2월 31일 같은 없는 날짜 걸러내기 (UTC로 확인해 기기 타임존·서머타임 영향 없음)
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}`;
}

const DATE_INPUT_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const TIME_INPUT_RE = /^(\d{1,2}):(\d{2})$/;

/**
 * 날짜·시간 입력 상태.
 * empty = 둘 다 안 적음(시간 미정), incomplete = 한쪽만 적음, invalid = 형식·범위 오류
 */
export type AppointmentInputStatus = 'empty' | 'ok' | 'incomplete' | 'invalid';

export interface ParsedAppointmentInput {
  status: AppointmentInputStatus;
  /** status가 'ok'일 때만 값이 있다 */
  at: string | null;
}

/**
 * 새 모임 화면과 약속 편집 화면이 같은 규칙으로 입력을 읽도록 한 곳에 모은 파서.
 * (화면마다 정규식을 따로 들고 있으면 한쪽에만 검사가 빠진다)
 */
export function parseAppointmentInput(
  dateText: string,
  timeText: string,
): ParsedAppointmentInput {
  const date = dateText.trim();
  const time = timeText.trim();
  if (!date && !time) return { status: 'empty', at: null };
  if (!date || !time) return { status: 'incomplete', at: null };

  const d = DATE_INPUT_RE.exec(date);
  const t = TIME_INPUT_RE.exec(time);
  if (!d || !t) return { status: 'invalid', at: null };

  const at = buildLocalAt(
    Number(d[1]),
    Number(d[2]),
    Number(d[3]),
    Number(t[1]),
    Number(t[2]),
  );
  return at ? { status: 'ok', at } : { status: 'invalid', at: null };
}

/** 입력 오류 안내 문구 (두 화면이 같은 말을 하도록 도메인에 둔다) */
export function appointmentInputHint(status: AppointmentInputStatus): string {
  if (status === 'incomplete') {
    return '날짜와 시간을 함께 적어주세요. 시간을 정하지 않으려면 두 칸을 모두 비워주세요';
  }
  if (status === 'invalid') {
    return '날짜는 2026-08-03, 시간은 19:30 형식으로 적어주세요';
  }
  return '';
}

/**
 * 장소 이름으로 지도 검색 URL을 만든다 — API 키·심사 없이 동작한다.
 * 지도 앱이 열릴지 웹으로 뜰지는 카카오/네이버의 앱 링크 등록에 달렸고,
 * 이 코드가 보장하지는 않는다.
 */
export function mapSearchUrl(
  place: string,
  provider: 'kakao' | 'naver' = 'kakao',
): string | null {
  const q = place.trim();
  if (!q) return null;
  const encoded = encodeURIComponent(q);
  return provider === 'naver'
    ? `https://map.naver.com/p/search/${encoded}`
    : `https://map.kakao.com/?q=${encoded}`;
}

/**
 * 약속 카드의 [길찾기] 링크.
 * 핀이 있으면 좌표 길찾기(카카오맵 link/to — 같은 이름의 다른 지점으로 가지 않는다),
 * 없으면 예전처럼 장소 이름 검색. 둘 다 없으면 null(버튼을 숨긴다).
 */
export function appointmentDirectionsUrl(a: Appointment | null | undefined): string | null {
  if (!a) return null;
  const p = appointmentPoint(a);
  if (p) return mapRouteUrl(a.place, p.lat, p.lng);
  return mapSearchUrl(a.place);
}

// ───────────────────────── 장소 입력 상태 (새 모임·약속 수정 화면 공용) ─────────────────────────

/** 화면이 들고 있는 장소 입력 상태 */
export interface PlaceFormState {
  /** 장소 이름 칸 */
  name: string;
  /** 지도에서 정한 핀. 아직 없으면 null */
  pin: GeoPoint | null;
  /** 사람이 이름 칸을 직접 고쳤는지. 고친 이름은 핀을 살짝 옮겨도 덮어쓰지 않는다 */
  nameEdited: boolean;
}

export const EMPTY_PLACE_FORM: PlaceFormState = { name: '', pin: null, nameEdited: false };

/** 지도 화면에서 돌아온 결과(PlacePicker 값의 부분집합) */
export interface PickedPlace {
  lat: number;
  lng: number;
  /** 검색 결과 이름 또는 핀에서 가장 가까운 주소 */
  name?: string;
  nameSource?: 'search' | 'address' | 'none';
  /** 위치 정하기 화면의 이름 칸에 보이던 그대로(지도 없는 폴백) — 사람이 보고 확정한 이름이라 그대로 쓴다 */
  nameConfirmed?: boolean;
}

/** 이 거리 안에서 핀을 다시 맞춘 건 '같은 장소를 다듬은 것'으로 본다 — 사람이 고친 이름을 지키는 기준 */
export const SAME_PLACE_M = 100;

/** 저장된 약속 → 입력 상태. 저장돼 있던 이름은 사람이 정한 이름으로 본다 */
export function placeFormFromAppointment(a: Appointment | null | undefined): PlaceFormState {
  if (!a) return { ...EMPTY_PLACE_FORM };
  const name = a.place;
  return { name, pin: appointmentPoint(a), nameEdited: name.trim() !== '' };
}

/**
 * 지도에서 핀을 정하고 돌아왔을 때 이름을 어떻게 할지.
 * - 사람이 고친 이름(또는 자동 이름인데 이번 결과에 이름이 없음) + 같은 장소(100m 안)에서 다듬기 → 이름 유지
 * - 결과에 이름(검색 결과·가장 가까운 주소)이 있으면 → 그 이름으로 채운다(나중에 고칠 수 있다)
 * - 핀 없이 이름만 있던 옛 약속인데 결과에 이름이 없으면 → 적어둔 이름 유지(그 이름으로 찾아간 곳일 가능성이 크다)
 * - 그 밖(먼 곳으로 옮겼는데 이름을 못 얻음) → 이름을 비운다. 옛 이름이 새 핀을 잘못 설명하지 않게
 * - 단 위치 화면의 이름 칸에서 확정한 이름(nameConfirmed, 지도 없는 폴백)이면 무엇보다 먼저 그 이름(비었으면 빈 이름)
 */
export function applyPickedPlace(prev: PlaceFormState, picked: PickedPlace): PlaceFormState {
  const pin = { lat: picked.lat, lng: picked.lng };
  if (!isValidGeoPoint(pin)) return prev;
  const prevName = prev.name.trim();
  const pickedName =
    picked.nameSource !== 'none' && typeof picked.name === 'string' ? picked.name.replace(/\s+/g, ' ').trim() : '';
  // 폴백 화면의 이름 칸에서 사람이 보고 확정한 이름 — 고친 이름 지키기보다 앞선다(그 화면에서 적은 이름이 버려지지 않게)
  if (picked.nameConfirmed === true) return { name: pickedName, pin, nameEdited: pickedName !== '' && prev.nameEdited };
  const samePlace = prev.pin !== null && haversineMeters(prev.pin, pin) <= SAME_PLACE_M;

  if (prevName && samePlace && (prev.nameEdited || !pickedName)) {
    return { name: prev.name, pin, nameEdited: prev.nameEdited };
  }
  if (pickedName) return { name: pickedName, pin, nameEdited: false };
  if (prevName && prev.pin === null) return { name: prev.name, pin, nameEdited: prev.nameEdited };
  return { name: '', pin, nameEdited: false };
}

/** 이름 칸을 사람이 고쳤을 때 */
export function editPlaceName(prev: PlaceFormState, name: string): PlaceFormState {
  return { ...prev, name, nameEdited: true };
}

/**
 * 지도가 없는 기기(웹·앱인토스·키 없는 안드로이드)에서 이름 칸만 고쳤을 때 핀을 남길지.
 * 이름이 처음과 같으면 핀(다른 기기에서 지도로 정한 것)을 그대로 두고,
 * 바뀌었으면 버린다 — 옛 핀이 새 이름과 다른 곳으로 길찾기를 열지 않게.
 */
export function pinAfterTextOnlyEdit(original: Appointment | null | undefined, newName: string): GeoPoint | null {
  const pin = appointmentPoint(original);
  if (!pin || !original) return null;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return norm(original.place) === norm(newName) ? pin : null;
}

/** 입력 상태 → 저장할 약속. 핀이 없으면 좌표 필드를 null 로 적어 예전 핀을 지운다 */
export function buildAppointment(input: {
  at: string | null;
  placeName: string;
  pin: GeoPoint | null;
  placeNote?: string;
}): Appointment {
  const pin = input.pin && isValidGeoPoint(input.pin) ? input.pin : null;
  return {
    at: input.at,
    place: input.placeName.trim(),
    placeNote: (input.placeNote ?? '').trim(),
    placeLat: pin ? pin.lat : null,
    placeLng: pin ? pin.lng : null,
  };
}
