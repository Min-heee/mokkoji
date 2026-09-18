/**
 * MapPane 공유 타입 — 웹·폴백(MapPane.tsx)과 네이티브(MapPane.native.tsx)가 같은 props 를 쓴다.
 *
 * tsc 는 '@/ui/MapPane' 을 MapPane.tsx 로, Metro 는 iOS/Android 에서 MapPane.native.tsx 로 resolve 한다.
 * 두 파일은 이 타입만 공유하고 서로를 import 하지 않는다(.native 에서 './MapPane' 은 자기 자신이 된다).
 * P0 계약({ destination, radiusM, markers?, me?, readonly?, height?, style? })은 그대로 두고 선택 필드만 더했다.
 */
import type { StyleProp, ViewStyle } from 'react-native';

export interface MapPaneDestination {
  name: string;
  lat: number;
  lng: number;
}

export interface MapPaneMarker {
  /** 참가자 userId */
  id: string;
  /** 닉네임(지도에서는 첫 글자 원) */
  label: string;
  /** 좌표를 볼 수 없으면 null — 지도에는 안 찍히고 목록(폴백)에는 caption 만 나온다 */
  lat: number | null;
  lng: number | null;
  /** 목적지까지 거리(m). 서버가 준 값 */
  distanceM?: number | null;
  /** "40초 전", "4분 전까지 공유", "도착 · 오후 7:21" 같은 한 줄 */
  caption?: string;
  arrived?: boolean;
  isMe?: boolean;
  /** 마지막 좌표를 받은 시각(ms). 표시 보조용 — 문구는 호출자가 caption 으로 만든다 */
  lastSeenMs?: number | null;
  /** 좌표가 오래됐는지(호출자가 판단). true 면 지도 마커를 흐리게 그린다 */
  stale?: boolean;
}

export interface MapPaneMe {
  lat: number;
  lng: number;
  accuracyM?: number | null;
}

export interface MapPaneProps {
  destination: MapPaneDestination;
  /** 도착 인정 반경(m) — 목적지 둘레의 원 */
  radiusM: number;
  /** 친구 마커. readonly 에서는 보통 비운다 */
  markers?: readonly MapPaneMarker[];
  /** 내 위치(기기에서 읽은 값). 모르면 null */
  me?: MapPaneMe | null;
  /** 참여 카드·대기실용: 제스처 없음, 핀과 반경만 */
  readonly?: boolean;
  /** 지도 높이. 기본 readonly 140 / 라이브 220 */
  height?: number;
  style?: StyleProp<ViewStyle>;
  /**
   * 위치 권한이 이미 허용돼 있는지. true 일 때만 네이티브 지도가 기기 위치 점(showsUserLocation)을 그린다.
   * MapPane 은 권한을 요청하지 않는다 — 요청은 permissions 모듈(호출자) 몫이다. 기본 false
   */
  locationGranted?: boolean;
  /** 지도(카드) 전체를 눌렀을 때. readonly 에서는 지도 위를 덮는 버튼으로 받는다 */
  onPress?: () => void;
  /** 스크린리더 라벨. 없으면 목적지·반경·표시된 친구 수로 만든다 */
  accessibilityLabel?: string;
}

/** 폴백(목록형)을 그리는 이유. placeholder = 웹·P0, unavailable = 네이티브인데 지도를 못 띄움(키 없음·로딩 실패) */
export type MapPaneFallbackReason = 'placeholder' | 'unavailable';
