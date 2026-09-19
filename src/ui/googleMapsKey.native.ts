/**
 * 구글 지도 키 유무 — iOS/Android 구현. 바이너리에 박힌 설정만 읽는다(OTA 매니페스트 무시).
 * 이유는 googleMapsKeyRule.ts 머리 주석 참고.
 *
 * ExponentConstants.manifest 는 expo-constants 네이티브 모듈이 앱 번들의 app.config(빌드 때 생성)를 그대로 돌려준다
 * (안드로이드 ConstantsService.appConfig = assets/app.config 문자열, iOS EXConstantsService.appConfig = 객체).
 * Constants.expoConfig 와 달리 ExpoUpdates 매니페스트로 바꿔치지 않는다.
 */
import { requireOptionalNativeModule } from 'expo';

import { embeddedHasGoogleMapsKey } from './googleMapsKeyRule';

function readEmbedded(): boolean {
  try {
    const mod = requireOptionalNativeModule<{ manifest?: unknown }>('ExponentConstants');
    return embeddedHasGoogleMapsKey(mod?.manifest);
  } catch {
    return false;
  }
}

export const HAS_EMBEDDED_GOOGLE_MAPS_KEY: boolean = readEmbedded();
