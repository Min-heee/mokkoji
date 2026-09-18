/**
 * 햅틱 — 웹·앱인토스·폴백 구현(무동작). 네이티브는 Metro 가 haptics.native.ts(expo-haptics)를 고른다.
 * 두 파일의 export 모양이 같아야 한다.
 */

/** 도착 순간 1회(ArrivedView 가 약속당 한 번만 부른다). 던지지 않는다 */
export function arrivalHaptic(): void {
  // 웹은 진동이 없다
}
