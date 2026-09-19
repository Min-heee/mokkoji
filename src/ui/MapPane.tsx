/**
 * 지도 자리 — 웹·폴백 구현(tsc 가 resolve 하는 기본 파일).
 *
 * iOS/Android 는 Metro 가 MapPane.native.tsx(react-native-maps)를 고른다. 웹·앱인토스 번들에는 지도 SDK 가 들어가지 않는다.
 * 두 파일은 같은 이름을 export 한다: MapPane, formatDistance, 공유 타입(mapPaneTypes).
 * 지도는 장식이고 기준 데이터는 참가자 리스트다 — 이 컴포넌트가 없어도 화면이 성립해야 한다.
 */
import React from 'react';

import { MapPaneFallback } from './MapPaneFallback';
import type { MapPaneProps } from './mapPaneTypes';

export { formatDistance } from './mapGeometry';
export type { MapPaneDestination, MapPaneMarker, MapPaneMe, MapPaneProps } from './mapPaneTypes';

export function MapPane(props: MapPaneProps) {
  return <MapPaneFallback {...props} reason="placeholder" />;
}
