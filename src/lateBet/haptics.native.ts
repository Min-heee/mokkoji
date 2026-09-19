/**
 * 햅틱 — 네이티브 구현(expo-haptics).
 * API(node_modules/expo-haptics/build/Haptics.d.ts): notificationAsync(type?: NotificationFeedbackType): Promise<void>,
 * NotificationFeedbackType.Success = 'success'(Haptics.types.d.ts). 안드로이드는 Vibrator 로 흉내 낸다.
 * 실패(기기 미지원·저전력 모드)는 조용히 삼킨다 — 도착 연출은 화면 반전이 본체다.
 */
import * as Haptics from 'expo-haptics';

export function arrivalHaptic(): void {
  try {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  } catch {
    // 모듈이 없으면 건너뛴다
  }
}
