/**
 * 약속 내기 모드 규칙 (순수 함수 — 테스트용으로 mode.ts 에서 분리).
 *
 * P1 규칙:
 * - raw === 'fake'  → 개발 번들(__DEV__)이거나, 네이티브이고 EAS 채널이 정확히 'beta' 일 때만 'fake'.
 *                     웹은 기존대로 __DEV__ 만. production·preview·채널 없음 등 그 밖의 모든 릴리스는 무조건 'off'.
 *                     (beta 채널 = eas.json 의 beta 프로필. Supabase 전에 오너가 TestFlight 실기기에서
 *                      진짜 지도·GPS·알림을 가짜 서버로 체험하려는 용도.)
 * - raw === 'live'  → 웹이 아니고 Supabase 키가 둘 다 있을 때만 'live'.
 * - 그 외           → 'off'. 약속 내기 UI 는 어디에도 보이지 않는다.
 */
export type LateBetMode = 'off' | 'fake' | 'live';

/** fake 를 허용하는 유일한 릴리스 채널. 대소문자·공백 변형은 인정하지 않는다. */
export const FAKE_RELEASE_CHANNEL = 'beta';

export interface LateBetModeInput {
  /** process.env.EXPO_PUBLIC_LATEBET_MODE */
  raw: string | null | undefined;
  /** __DEV__ */
  isDev: boolean;
  /** Platform.OS === 'web' */
  isWeb: boolean;
  /** EXPO_PUBLIC_SUPABASE_URL 과 EXPO_PUBLIC_SUPABASE_KEY 가 둘 다 있는가 */
  hasKeys: boolean;
  /** expo-updates 의 Updates.channel. 웹·개발 빌드·미설정이면 null. 생략하면 null 로 본다. */
  channel?: string | null;
}

/** 이 번들에서 fake 모드를 켤 수 있는가 */
export function isFakeAllowed(input: Pick<LateBetModeInput, 'isDev' | 'isWeb' | 'channel'>): boolean {
  if (input.isDev === true) return true;
  if (input.isWeb) return false;
  return input.channel === FAKE_RELEASE_CHANNEL;
}

export function resolveLateBetMode(input: LateBetModeInput): LateBetMode {
  const raw = typeof input.raw === 'string' ? input.raw.trim().toLowerCase() : '';
  if (raw === 'fake') return isFakeAllowed(input) ? 'fake' : 'off';
  if (raw === 'live') return !input.isWeb && input.hasKeys ? 'live' : 'off';
  return 'off';
}
