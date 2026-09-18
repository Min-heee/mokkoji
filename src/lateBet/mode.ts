/**
 * 약속 내기 모드. 규칙은 modeRule.ts(순수 함수, 테스트 있음).
 *
 * - env 는 `eas env`(development/preview/production)에 둔다. 로컬 개발은 .env.local (gitignore 됨). .env.example 참고.
 * - process.env.EXPO_PUBLIC_* 는 번들 시점에 글자 그대로 치환되므로 반드시 아래처럼 정적으로 적는다.
 * - fake 허용: 개발 번들, 또는 EAS 채널이 'beta' 인 네이티브 릴리스(TestFlight 체험용). production 채널 등 그 밖의 릴리스는 off.
 * - off 면 약속 내기 UI 는 어디에도 보이지 않고, Provider 는 네트워크·스토리지에 손대지 않는다.
 */
import { Platform } from 'react-native';

import { resolveLateBetMode, type LateBetMode } from './modeRule';
import { readReleaseChannel } from './releaseChannel';

export type { LateBetMode };

const raw = process.env.EXPO_PUBLIC_LATEBET_MODE;
const hasKeys = !!process.env.EXPO_PUBLIC_SUPABASE_URL && !!process.env.EXPO_PUBLIC_SUPABASE_KEY;

export const LATEBET_MODE: LateBetMode = resolveLateBetMode({
  raw,
  isDev: typeof __DEV__ !== 'undefined' && __DEV__ === true,
  isWeb: Platform.OS === 'web',
  hasKeys,
  // 네이티브 릴리스에서 fake 는 EAS 채널 'beta'(eas.json beta 프로필)일 때만. 웹은 항상 null.
  channel: readReleaseChannel(),
});

/** 약속 내기 UI 를 그려도 되는가 */
export const LATEBET_ENABLED = LATEBET_MODE !== 'off';
/** 가짜 서버로 도는가 (FakeDevPanel 노출 조건) */
export const LATEBET_FAKE = LATEBET_MODE === 'fake';
