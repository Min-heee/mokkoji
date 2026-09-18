/**
 * 스토어 앱(iOS·Android) 네이티브 자동 링크 검사 — 네이티브 빌드 전에 `npm run check:native`.
 *
 * SDK 54 autolinking 은 전이 의존성까지 링크한다. 앱인토스(@apps-in-toss/web-framework)가 끌고 오는 granite 네이티브
 * 모듈과 RN 0.72 호환용 별칭 패키지(react-native-screens-3.27.0 등)가 스토어 앱에 섞이면 pod install 이 깨진다
 * (0.4.0 (6) 빌드 실패: react-native-gesture-handler-2.8.0 podspec 의 File.exists? — Ruby 3.2 에서 제거됨).
 * 그래서 package.json 의 expo.autolinking.exclude 로 빼고, 여기서 실제로 링크될 목록이 허용 목록과 같은지 확인한다.
 * (react-native.config.js 의 platforms: null 은 안드로이드 리졸버가 무시하는 경우가 있어 쓰지 않는다.)
 *
 * 새 네이티브 패키지를 앱에 넣으면 ALLOWED 에 추가한다. 앱인토스 쪽이 새 네이티브 패키지를 끌고 오면 이 검사가 실패한다
 * → package.json 의 exclude 에 추가한다.
 */
import { execFileSync } from 'node:child_process';

const ALLOWED = new Set([
  '@react-native-async-storage/async-storage',
  'expo',
  'react-native-maps',
  'react-native-safe-area-context',
  'react-native-screens',
]);

let failed = false;
for (const platform of ['ios', 'android']) {
  const out = execFileSync(
    'npx',
    ['expo-modules-autolinking', 'react-native-config', '--json', '--platform', platform],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const linked = Object.keys(JSON.parse(out).dependencies ?? {}).sort();
  const extra = linked.filter((name) => !ALLOWED.has(name));
  const missing = [...ALLOWED].filter((name) => !linked.includes(name));
  console.log(`[${platform}] 링크됨: ${linked.join(', ')}`);
  if (extra.length > 0) {
    failed = true;
    console.error(`[${platform}] 허용 목록에 없는 네이티브 모듈: ${extra.join(', ')} → package.json expo.autolinking.exclude 에 추가하세요`);
  }
  if (missing.length > 0) {
    failed = true;
    console.error(`[${platform}] 빠진 네이티브 모듈: ${missing.join(', ')}`);
  }
}
process.exit(failed ? 1 : 0);
