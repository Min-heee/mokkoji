/**
 * app.json 을 받아 비밀 값만 환경변수에서 주입한다. 키 값은 절대 이 파일이나 app.json 에 적지 않는다.
 *
 * - GOOGLE_MAPS_ANDROID_KEY: 안드로이드 구글 지도 키(EAS 환경변수). 없으면 키 필드 자체를 넣지 않는다.
 *   extra.hasGoogleMapsKey 로 키 유무만 앱에 알린다 — 키 없이 react-native-maps 구글 지도를 띄우면
 *   안드로이드가 크래시하므로 MapPane 은 이 값이 false 면 지도 대신 목록 폴백을 그린다.
 *   주의: 이 파일은 `eas update` 때도 다시 평가돼 OTA 매니페스트(Constants.expoConfig)에 그때의 값이 실린다.
 *   앱은 그 값을 쓰지 않고 바이너리에 박힌 설정(ExponentConstants.manifest)만 읽는다(src/ui/googleMapsKeyRule.ts).
 *   iOS 는 애플 지도라 키가 필요 없다.
 * - GOOGLE_SERVICES_JSON: EAS 파일 환경변수(선택, P5 푸시용). 있으면 android.googleServicesFile 로 넣는다.
 */
module.exports = ({ config }) => {
  const mapsKey = (process.env.GOOGLE_MAPS_ANDROID_KEY || '').trim();
  const googleServicesFile = (process.env.GOOGLE_SERVICES_JSON || '').trim();

  const android = { ...config.android };
  if (mapsKey) {
    android.config = {
      ...(android.config || {}),
      googleMaps: { apiKey: mapsKey },
    };
  }
  if (googleServicesFile) {
    android.googleServicesFile = googleServicesFile;
  }

  return {
    ...config,
    android,
    extra: {
      ...(config.extra || {}),
      hasGoogleMapsKey: !!mapsKey,
    },
  };
};
