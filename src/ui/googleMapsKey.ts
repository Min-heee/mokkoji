/**
 * 구글 지도 키 유무 — 웹·폴백 구현. 웹은 구글 지도(react-native-maps)를 쓰지 않으므로 늘 false.
 * iOS/Android 는 Metro 가 googleMapsKey.native.ts 를 고른다.
 */
export const HAS_EMBEDDED_GOOGLE_MAPS_KEY: boolean = false;
