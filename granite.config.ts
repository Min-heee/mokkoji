import { defineConfig } from '@apps-in-toss/web-framework/config';

/**
 * 앱인토스(Apps in Toss) 미니앱 설정.
 * 정산야호의 기존 Expo 웹 빌드(react-native-web)를 그대로 토스 웹뷰에 싣는다.
 * appName은 앱인토스 콘솔에 등록한 값과 반드시 일치해야 한다 (intoss://jeongsan-yaho).
 */
export default defineConfig({
  appName: 'jeongsan-yaho',
  brand: {
    displayName: '정산야호',
    // 옵시디언 — 앱 테마(웜 아이보리+옵시디언)의 강조색
    primaryColor: '#1A1A1A',
    icon: './assets/icon.png',
  },
  permissions: [],
  web: {
    host: 'localhost',
    port: 8082,
    commands: {
      dev: 'npx expo start --web --port 8082',
      build: 'npx expo export --platform web',
    },
  },
  outdir: 'dist',
  webViewProps: {
    type: 'partner',
  },
});
