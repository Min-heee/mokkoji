/**
 * 위치 권한 — 네이티브 구현(expo-location). 포그라운드 권한만 쓴다(백그라운드 위치는 1차에 없다).
 *
 * API(node_modules/expo-location/build/Location.d.ts):
 *   getForegroundPermissionsAsync(): Promise<LocationPermissionResponse>   — 묻지 않고 읽기
 *   requestForegroundPermissionsAsync(): Promise<LocationPermissionResponse> — OS 프롬프트
 * 응답 해석은 permissionRule.toPermissionState(순수, 테스트 있음).
 * 설정 열기는 RN Linking.openSettings()(node_modules/react-native/Libraries/Linking/Linking.d.ts).
 *
 * 이 모듈은 부를 때만 동작한다 — import 만으로는 권한을 묻거나 위치를 읽지 않는다(mode off 에서 한 픽셀도 달라지면 안 된다).
 */
import * as Location from 'expo-location';
import { Linking } from 'react-native';

import { toPermissionState, UNAVAILABLE_PERMISSION, type LocationPermissionState } from './permissionRule';

export type { LocationPermissionState, LocationPermissionStatus } from './permissionRule';

export async function getLocationPermission(): Promise<LocationPermissionState> {
  try {
    return toPermissionState(await Location.getForegroundPermissionsAsync());
  } catch {
    return UNAVAILABLE_PERMISSION;
  }
}

export async function requestLocationPermission(): Promise<LocationPermissionState> {
  try {
    return toPermissionState(await Location.requestForegroundPermissionsAsync());
  } catch {
    // 요청 자체가 실패하면(모듈 없음 등) 지금 상태라도 돌려준다
    return getLocationPermission();
  }
}

export async function openAppSettings(): Promise<boolean> {
  try {
    await Linking.openSettings();
    return true;
  } catch {
    return false;
  }
}
