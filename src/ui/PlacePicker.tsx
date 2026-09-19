/**
 * 장소 핀 고르기 — 웹·앱인토스·폴백 구현(tsc 가 resolve 하는 기본 파일).
 *
 * iOS/Android 는 Metro 가 PlacePicker.native.tsx(react-native-maps 지도 중앙 고정 핀 + 검색)를 고른다.
 * 웹 번들에는 지도 SDK·expo-location·카카오 키가 들어가지 않는다.
 * 두 파일은 같은 이름을 export 한다: PlacePicker, placePickerUsesMap, 공유 타입과 핀 전달 통로(placePickerShared).
 * 확정 버튼은 부모(app/late/place.tsx)가 그린다 — 이 컴포넌트는 핀이 바뀔 때마다 onChange 만 부른다.
 */
import React from 'react';

import { PlacePickerFallback } from './PlacePickerFallback';
import type { PlacePickerProps, PlacePickerUsesMap } from './placePickerShared';

export { openPlaceDraft, readPlaceDraft, setPlaceResult, takePlaceResult } from './placePickerShared';
export type { PlaceDraft, PlacePickerProps, PlacePickerValue } from './placePickerShared';

/** 웹은 지도를 쓰지 않는다(프리셋 + 좌표 입력) — 부모는 스크롤 화면에 넣는다 */
export const placePickerUsesMap: PlacePickerUsesMap = () => false;

export function PlacePicker(props: PlacePickerProps) {
  return <PlacePickerFallback {...props} />;
}
