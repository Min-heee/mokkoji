/**
 * 약속 내기 live 백엔드 — 웹·앱인토스·폴백.
 *
 * 웹은 약속 내기 모드가 항상 off(modeRule)라 여기가 불릴 일이 없지만, 불리면 모든 호출이 LB_NOT_CONFIGURED 로 실패한다.
 * supabase-js 를 import 하지 않는다 — 웹 번들에 들어가지 않게. 실제 구현은 supabase.native.ts(Metro 가 iOS/Android 에서 고른다).
 * tsc 는 이 파일로 타입을 본다(supabase.native.ts 와 export 모양이 같아야 한다).
 */
import { LateBetError } from './errors';
import type { LbLiveBackend } from './supabaseApi';

const notConfigured = (): Promise<never> => Promise.reject(new LateBetError('LB_NOT_CONFIGURED'));

export function getLiveBackend(): LbLiveBackend {
  return {
    rpc: notConfigured,
    ensureSession: notConfigured,
    requireSession: notConfigured,
    restoreSession: () => Promise.resolve(null),
    refreshSession: notConfigured,
    query: { profile: notConfigured },
  };
}
