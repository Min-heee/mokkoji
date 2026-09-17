/**
 * 약속 내기 모드 규칙 (순수 함수 — 테스트용으로 mode.ts 에서 분리).
 *
 * P0 규칙(오케스트레이터 결정, 설계서 §5.1 과 다른 점은 웹에서도 개발 중에는 fake 를 허용한다는 것):
 * - raw === 'fake'  → 개발 번들(__DEV__)에서만 'fake'. 릴리스 번들에서는 무조건 'off'.
 * - raw === 'live'  → 웹이 아니고 Supabase 키가 둘 다 있을 때만 'live'.
 * - 그 외           → 'off'. 약속 내기 UI 는 어디에도 보이지 않는다.
 */
export type LateBetMode = 'off' | 'fake' | 'live';

export interface LateBetModeInput {
  /** process.env.EXPO_PUBLIC_LATEBET_MODE */
  raw: string | null | undefined;
  /** __DEV__ */
  isDev: boolean;
  /** Platform.OS === 'web' */
  isWeb: boolean;
  /** EXPO_PUBLIC_SUPABASE_URL 과 EXPO_PUBLIC_SUPABASE_KEY 가 둘 다 있는가 */
  hasKeys: boolean;
}

export function resolveLateBetMode(input: LateBetModeInput): LateBetMode {
  const raw = typeof input.raw === 'string' ? input.raw.trim().toLowerCase() : '';
  if (raw === 'fake') return input.isDev === true ? 'fake' : 'off';
  if (raw === 'live') return !input.isWeb && input.hasKeys ? 'live' : 'off';
  return 'off';
}
