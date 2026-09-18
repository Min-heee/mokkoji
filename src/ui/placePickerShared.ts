/**
 * PlacePicker 두 구현(PlacePicker.tsx 웹·폴백 / PlacePicker.native.tsx 지도)이 공유하는 타입과 핀 전달 통로.
 *
 * 왜 따로 있나: PlacePicker.native.tsx 가 './PlacePicker' 를 import 하면 Metro 가 자기 자신(.native)으로 resolve 한다.
 * 그래서 두 구현이 같이 쓰는 것(타입·모듈 메모리)은 이 파일에 두고 양쪽이 re-export 한다.
 * 모듈 메모리가 이 파일 하나에만 있으므로 어느 플랫폼에서든 new ↔ place 가 같은 통로를 본다.
 * react-native 를 import 하지 않는다.
 */

export interface PlacePickerValue {
  lat: number;
  lng: number;
  /** 프리셋·검색 결과를 골랐을 때의 이름(핀만 움직였으면 없음). 폼의 장소 이름이 비어 있을 때만 채운다 */
  name?: string;
}

export interface PlacePickerProps {
  /** 현재 핀. 아직 없으면 null */
  value: PlacePickerValue | null;
  /** 반경 원 미리보기용 */
  radiusM: number;
  /** 폼에 적힌 장소 이름(검색 초기값) */
  placeName?: string;
  /** 핀이 바뀔 때마다. 확정 버튼은 부모(app/late/place.tsx)가 그린다 */
  onChange: (value: PlacePickerValue) => void;
}

/**
 * 이 기기에서 PlacePicker 가 지도(화면을 채우는 레이아웃)로 그려지는가.
 * true 면 부모는 스크롤 없는 화면(Screen scroll={false})에 넣는다 — 스크롤 안의 지도는 제스처를 빼앗긴다.
 */
export type PlacePickerUsesMap = () => boolean;

// ───────────────────────── new ↔ place 핀 전달(모듈 메모리) ─────────────────────────
//
// - 좌표를 URL 에 싣지 않는다(웹 주소창·히스토리에 남지 않게).
// - new 가 openPlaceDraft 로 현재 핀·반경·장소 이름을 넘기고 push → place 가 readPlaceDraft 로 읽어 그리고,
//   확정하면 setPlaceResult 로 적어 두고 back → new 가 포커스를 되찾을 때 takePlaceResult 로 한 번만 꺼내 간다.

export interface PlaceDraft {
  value: PlacePickerValue | null;
  radiusM: number;
  placeName: string;
}

const DEFAULT_DRAFT_RADIUS_M = 100;
let draft: PlaceDraft = { value: null, radiusM: DEFAULT_DRAFT_RADIUS_M, placeName: '' };
let result: PlacePickerValue | null = null;

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
export function setPlaceResult(value: PlacePickerValue): void {
  result = value;
}

/** 확정된 핀을 한 번만 꺼낸다(없으면 null). 약속 잡기 화면이 포커스를 되찾을 때 부른다 */
export function takePlaceResult(): PlacePickerValue | null {
  const r = result;
  result = null;
  return r;
}
