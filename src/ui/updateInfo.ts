/**
 * 지금 실행 중인 EAS Update id — 웹·앱인토스 폴백(항상 null).
 * 네이티브 구현은 updateInfo.native.ts(expo-updates). tsc 는 이 파일로, Metro 는 iOS/Android 에서 .native 로 resolve 한다.
 * (releaseChannel.ts 와 같은 이유로 분리했다 — 웹 번들에 expo-updates 가 섞이지 않게.)
 */
export function readUpdateId(): string | null {
  return null;
}
