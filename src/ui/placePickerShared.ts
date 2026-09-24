/**
 * PlacePicker 두 구현(PlacePicker.tsx 웹·폴백 / PlacePicker.native.tsx 지도)이 공유하는 타입과 핀 전달 통로.
 *
 * 왜 따로 있나: PlacePicker.native.tsx 가 './PlacePicker' 를 import 하면 Metro 가 자기 자신(.native)으로 resolve 한다.
 * 그래서 두 구현이 같이 쓰는 것(타입·모듈 메모리)은 이 파일에 두고 양쪽이 re-export 한다.
 * 모듈 메모리가 이 파일 하나에만 있으므로 어느 플랫폼에서든 new ↔ place 가 같은 통로를 본다.
 * react-native 를 import 하지 않는다.
 */

/**
 * 핀에 실린 이름이 어디서 왔나(약속 잡기 폼의 이름 채우기 규칙이 이것으로 가른다 — placePickerModel.fillPlaceName).
 * - 'search'  : 사람이 고른 이름 — 검색 결과·프리셋의 상호명, 그리고 지도가 없는 폴백에서 직접 적은 이름
 * - 'address' : 지도를 움직인 핀에서 역지오코딩한 가장 가까운 주소(기계가 찾은 값)
 * - 'none'    : 이름이 없다(주소를 못 찾았거나 실패, 좌표만 적음) — 폼은 이름 칸을 비워 사용자가 적게 한다.
 *               주소를 아직 찾는 중이면 namePending 이 true 다(위치 정하기 화면은 그동안 확정을 막는다)
 */
export type PlaceNameSource = 'search' | 'address' | 'none';

export interface PlacePickerValue {
  lat: number;
  lng: number;
  /** 핀의 이름(nameSource 가 'none' 이면 없음) */
  name?: string;
  /** name 이 어디서 왔나. 없으면(옛 값·폼이 가진 저장된 핀) 알 수 없음 — 이름 채우기 규칙은 name 유무로만 본다 */
  nameSource?: PlaceNameSource;
  /**
   * true 면 이 이름은 위치 정하기 화면의 '장소 이름' 칸에 보이던 그대로다(지도가 없는 폴백 — 사람이 보고 적거나 고른 값).
   * 폼은 '직접 고친 이름을 지킨다' 규칙보다 이것을 앞세워 이름 칸을 이 값으로 바꾼다(비어 있으면 비운다)
   */
  nameConfirmed?: boolean;
  /**
   * true 면 지도를 움직인 핀의 가장 가까운 주소를 아직 찾는 중이다(nameSource 'none' 과 같이만 온다).
   * 찾으면 'address' 로, 못 찾으면 이 표시 없이 'none' 으로 다시 온다. 그 사이에는 확정하지 않는다 —
   * 확정하면 찾을 수 있었던 주소 대신 빈 이름이 폼에 들어간다
   */
  namePending?: boolean;
}

/**
 * 칩 줄의 '직접 적기'(지도 아래 칩 옆에 인라인으로 — footer 에 두면 키보드와 함께 지도·칩을 가린다).
 * 상태(열림·글자)는 부모가 들고, 적은 값이 올바르면 부모가 radiusM 을 바꾼다
 */
export interface PlaceRadiusCustom {
  /** 입력 줄이 열려 있는가 */
  open: boolean;
  /** 적은 글자 */
  text: string;
  /** 적을 수 있는 범위(m) — 자리 표시·안내에 쓴다 */
  min: number;
  max: number;
  /** [직접 적기] */
  onOpen: () => void;
  onText: (text: string) => void;
  /** [완료]·키보드의 완료 키 */
  onDone: () => void;
}

/** 지도 아래 '도착 인정 거리' 칩 줄. 없으면(null) 칩을 그리지 않는다(모임 약속) */
export interface PlaceRadiusOptions {
  /** 칩으로 보일 거리(m). 호출자가 radiusChipList 로 현재 값을 넣고 정렬해 준다 */
  choices: number[];
  /** 칩을 고를 때마다. 부모가 radiusM prop 을 바꾸면 원이 바로 바뀐다 */
  onChange: (m: number) => void;
  /** true 면 칩을 누를 수 없다(시작한 약속의 정책 동결) */
  locked?: boolean;
  /** 잠근 이유 한 줄(칩 아래) */
  lockedReason?: string;
  /** 있으면 칩 줄 제목 옆에 [직접 적기]. 잠겨 있으면 그리지 않는다 */
  custom?: PlaceRadiusCustom | null;
  /** 칩 아래 경고 한 줄(범위 밖·GPS 주의). 있으면 '핀에서 N m 안에…' 문장 대신 보인다 */
  warning?: string | null;
}

export interface PlacePickerProps {
  /** 현재 핀. 아직 없으면 null */
  value: PlacePickerValue | null;
  /**
   * 반경 원 미리보기(m). null(또는 생략)이면 원을 그리지 않는다 — 모임 약속처럼 '도착 인정 거리'가 없는 곳.
   * 원이 없어도 지도의 첫 확대 수준은 동네 몇 블록(100m 원 기준)으로 잡는다
   */
  radiusM?: number | null;
  /** 있으면 지도 아래에 거리 칩 줄. radiusM 과 같이 준다 */
  radiusOptions?: PlaceRadiusOptions | null;
  /** 폼에 적힌 장소 이름(검색 초기값) */
  placeName?: string;
  /** 핀·이름이 바뀔 때마다. 확정 버튼은 부모(app/late/place.tsx)가 그린다 */
  onChange: (value: PlacePickerValue) => void;
  /**
   * 옮길 수 있는 한도의 중심(선택). 시작한 약속의 장소 바꾸기 = 시작하던 순간의 핀(공정성 규칙 R2).
   * 있으면 지도에 한도 원을 그리고(폴백은 거리 한 줄), 넘으면 안내한다. 확정 버튼 비활성은 부모 몫
   */
  limitCenter?: { lat: number; lng: number } | null;
  /** 한도 반경(m). limitCenter 와 같이 준다 */
  limitRadiusM?: number;
}

/** 한도를 넘은 핀 안내(부모의 확정 버튼 아래·지도 말풍선) */
export function limitExceededText(radiusM: number): string {
  return `처음 장소에서 ${radiusM}m 안으로만 옮길 수 있어요`;
}

/**
 * 이 기기에서 PlacePicker 가 지도(화면을 채우는 레이아웃)로 그려지는가.
 * true 면 부모는 스크롤 없는 화면(Screen scroll={false})에 넣는다 — 스크롤 안의 지도는 제스처를 빼앗긴다.
 */
export type PlacePickerUsesMap = () => boolean;

// ───────────────────────── new ↔ place 핀 전달(모듈 메모리) ─────────────────────────
//
// - 좌표를 URL 에 싣지 않는다(웹 주소창·히스토리에 남지 않게).
// - new 가 openPlaceDraft 로 현재 핀·반경(+칩 목록·잠금)·장소 이름을 넘기고 push → place 가 readPlaceDraft 로 읽어 그리고,
//   확정하면 setPlaceResult({ value, radiusM }) 로 적어 두고 back → new 가 포커스를 되찾을 때 takePlaceResult 로 한 번만 꺼내 간다.

export interface PlaceDraft {
  value: PlacePickerValue | null;
  /** 도착 인정 거리(m). null 이면 반경 원·칩 없음(모임 약속) */
  radiusM: number | null;
  /** 지도 아래 칩으로 보일 거리. 없으면 위치 정하기 화면의 기본 목록(RADIUS_PICKER_CHOICES). radiusM 이 null 이면 무시 */
  radiusChoices?: number[];
  /** true 면 칩을 잠근다(시작한 약속 — 정책 동결) */
  radiusLocked?: boolean;
  /** 잠근 이유 한 줄 */
  radiusLockedReason?: string;
  placeName: string;
  /** 옮길 수 있는 한도(시작한 약속의 장소 바꾸기). 없으면 제한 없음 */
  limit?: { lat: number; lng: number; radiusM: number } | null;
}

/**
 * 결과를 누가 꺼내 가나. 같은 통로를 약속 잡기(late/new ↔ late/place)와 모임 약속(session/* ↔ session/place)이 같이 쓴다 —
 * 돌아갈 화면이 없어 남은 결과가 다른 쪽 폼에 새어 들어가지 않게 결과에 출처를 싣고, 꺼낼 때 자기 것만 꺼낸다.
 */
export type PlaceResultOwner = 'late' | 'session';

/** 위치 정하기 화면이 [이 위치로 정하기]에서 남기는 결과 */
export interface PlaceResult {
  /** 고른 핀(이름·이름 출처 포함) */
  value: PlacePickerValue;
  /** 지도에서 고른 도착 인정 거리(m). draft.radiusM 이 null 이었으면 null. 잠겨 있었으면 draft 값 그대로 */
  radiusM: number | null;
  /** 결과를 남긴 위치 정하기 화면(= 꺼내 갈 폼). 없으면 owner 없이 부른 takePlaceResult() 만 꺼낸다 */
  owner?: PlaceResultOwner;
}

const DEFAULT_DRAFT_RADIUS_M = 100;
let draft: PlaceDraft = { value: null, radiusM: DEFAULT_DRAFT_RADIUS_M, placeName: '' };
let result: PlaceResult | null = null;

/** 약속 잡기 화면이 push 직전에 부른다 */
export function openPlaceDraft(next: PlaceDraft): void {
  draft = { ...next, placeName: next.placeName ?? '' };
  result = null;
}

/** 위치 정하기 화면이 들어올 때 읽는다 */
export function readPlaceDraft(): PlaceDraft {
  return draft;
}

/** 위치 정하기 화면이 [이 위치로 정하기]에서 부른다 */
export function setPlaceResult(next: PlaceResult): void {
  result = next;
}

/**
 * 확정된 핀·거리를 한 번만 꺼낸다(없으면 null). 폼 화면이 포커스를 되찾을 때 부른다.
 * owner 를 주면 그 출처의 결과만 꺼낸다 — 다른 쪽 결과는 건드리지 않고 남긴다(그쪽 폼이 스택 아래에서 기다릴 수 있다)
 */
export function takePlaceResult(owner?: PlaceResultOwner): PlaceResult | null {
  const r = result;
  if (!r) return null;
  if (owner !== undefined && r.owner !== owner) return null;
  result = null;
  return r;
}
