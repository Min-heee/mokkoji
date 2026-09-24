/**
 * 지금 실행 중인 EAS Update id — iOS/Android.
 * 개발 빌드·Expo Go 에서는 null 이다(expo-updates 의 Updates.updateId 문서). 내장 번들로 떴으면 내장 업데이트의 id 다.
 */
import * as Updates from 'expo-updates';

export function readUpdateId(): string | null {
  try {
    const id = Updates.updateId;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}
