/**
 * 위치 권한 — 웹·앱인토스·폴백 구현. 항상 'unavailable'(위치를 쓰지 않는다).
 *
 * 네이티브(iOS·Android)는 Metro 가 permissions.native.ts(expo-location)를 고른다. tsc 는 이 파일로 resolve 하므로
 * 두 파일의 export 모양(이름·시그니처)이 같아야 한다. 타입은 permissionRule.ts 에 있다.
 * 웹 번들에 expo-location 이 섞이지 않게 여기서는 아무 네이티브 모듈도 import 하지 않는다.
 */
import { UNAVAILABLE_PERMISSION, type LocationPermissionState } from './permissionRule';

export type { LocationPermissionState, LocationPermissionStatus } from './permissionRule';

/** 지금 권한 상태(묻지 않는다) */
export async function getLocationPermission(): Promise<LocationPermissionState> {
  return UNAVAILABLE_PERMISSION;
}

/** OS 권한 요청. 웹은 요청하지 않는다 */
export async function requestLocationPermission(): Promise<LocationPermissionState> {
  return UNAVAILABLE_PERMISSION;
}

/** 앱 설정 화면 열기. 웹은 열 곳이 없다 → false */
export async function openAppSettings(): Promise<boolean> {
  return false;
}
