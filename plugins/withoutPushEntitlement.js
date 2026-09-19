/**
 * iOS 원격 푸시 엔타이틀먼트(aps-environment) 제거.
 *
 * expo-notifications 플러그인은 aps-environment 를 자동으로 넣는데, 기존 배포 프로비저닝 프로파일에는
 * Push Notifications capability 가 없어 서명이 실패한다(0.4.0 (7) 빌드). 1차 알림은 기기 안에서 예약하는
 * 로컬 알림뿐이라 이 엔타이틀먼트가 필요 없다(원격 푸시 토큰을 발급받지 않는다).
 *
 * app.json plugins 에서 반드시 expo-notifications '앞'에 둔다 — 같은 종류의 mod 는 나중에 등록된 것이 먼저 실행돼서,
 * 뒤에 두면 expo-notifications 가 엔타이틀먼트를 넣기 전에 지우게 된다(prebuild 로 확인함).
 *
 * P5(원격 푸시)에서: 이 플러그인을 app.json 에서 빼고, 대화형 `eas build -p ios` 로 한 번 빌드해
 * App ID 에 Push capability 를 켜고 프로파일을 다시 만든다.
 */
const { withEntitlementsPlist } = require('expo/config-plugins');

module.exports = function withoutPushEntitlement(config) {
  return withEntitlementsPlist(config, (c) => {
    delete c.modResults['aps-environment'];
    return c;
  });
};
