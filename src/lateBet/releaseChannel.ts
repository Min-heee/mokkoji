/**
 * 이 바이너리의 EAS Update 채널 — 웹·앱인토스 폴백.
 * 웹 번들에는 채널이 없으므로 항상 null. 네이티브 구현은 releaseChannel.native.ts(expo-updates).
 * (tsc 는 이 파일로, Metro 는 iOS/Android 에서 .native 로 resolve 한다. 웹 번들에 expo-updates 가 섞이지 않게 분리했다.)
 */
export function readReleaseChannel(): string | null {
  return null;
}
