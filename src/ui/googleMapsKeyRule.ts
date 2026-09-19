/**
 * 안드로이드 구글 지도 키 유무 판정(순수) — googleMapsKey(.native).ts 가 쓴다.
 *
 * 왜 Constants.expoConfig 가 아닌가:
 * expo-constants 의 expoConfig 는 OTA 로 실행 중이면 바이너리 설정이 아니라 그 업데이트 매니페스트(extra.expoClient)를 준다.
 * 그 값은 `eas update` 를 돌린 순간의 env 로 app.config.js 를 다시 평가한 것이라, 키 없이 만든 바이너리에
 * '키 있음' OTA 가 내려가면 JS 는 구글 지도를 만들고 Maps SDK 가 'API key not found' 로 네이티브 크래시를 낸다
 * (JS ErrorBoundary 로 못 막는다). 반대로 키 있는 바이너리가 키 없는 env 에서 낸 OTA 를 받으면 멀쩡한 지도가 목록으로 떨어진다.
 *
 * 그래서 바이너리에 박힌 설정(ExponentConstants.manifest — 빌드 때 expo-constants 가 assets/app.config 로 넣는 파일,
 * AndroidManifest 의 API_KEY meta-data 와 같은 빌드 env 로 만들어진다)만 읽는다. OTA 는 이 값을 바꾸지 못한다.
 */

/** 내장 설정(안드로이드는 JSON 문자열, iOS 는 객체)에서 extra.hasGoogleMapsKey === true 인지. 모르면 false(목록 폴백 쪽) */
export function embeddedHasGoogleMapsKey(rawEmbeddedConfig: unknown): boolean {
  let cfg: unknown = rawEmbeddedConfig;
  if (typeof cfg === 'string') {
    try {
      cfg = JSON.parse(cfg);
    } catch {
      return false;
    }
  }
  if (!cfg || typeof cfg !== 'object') return false;
  const extra = (cfg as { extra?: unknown }).extra;
  if (!extra || typeof extra !== 'object') return false;
  return (extra as { hasGoogleMapsKey?: unknown }).hasGoogleMapsKey === true;
}
