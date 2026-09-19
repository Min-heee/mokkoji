/**
 * 이 바이너리의 EAS Update 채널 — iOS/Android.
 * eas.json 프로필의 channel 이 빌드 때 박힌다(beta / production / preview ...).
 * 개발 빌드·Expo Go·채널 미설정이면 null 이다(expo-updates 의 Updates.channel 문서).
 */
import * as Updates from 'expo-updates';

export function readReleaseChannel(): string | null {
  try {
    const ch = Updates.channel;
    return typeof ch === 'string' ? ch : null;
  } catch {
    return null;
  }
}
