/**
 * '홈으로' — 모임 탭(URL '/')으로 돌아가는 단 하나의 규칙. 순수(React·expo import 없음), node:test 로 검증.
 *
 * - 스택에 쌓인 화면이 있으면 dismissTo('/') — 루트 Stack 을 (tabs) 까지 걷어 내면서 **모임 탭으로 점프**한다.
 *   dismissAll(POP_TO_TOP) 은 쓰지 않는다: 탭 내비게이터는 떠날 때의 탭을 기억하므로, 친구·마이 탭에서
 *   알림·딥링크로 약속 화면에 들어왔으면 '홈으로'가 그 탭(친구·마이)으로 돌아간다.
 * - 쌓인 화면이 없으면(웹 새로고침 등) replace('/').
 *   replace 를 스택이 있을 때 쓰면 루트 Stack 에 (tabs) 가 하나 더 쌓인다([(tabs)#1, (tabs)#2]) — 그래서 갈라 쓴다.
 *
 * 쓰는 곳: app/late/[id], app/j/[code], lateBet/screens/ResultView, lateBet/screens/NicknameGate(LateBetUnavailable).
 */
export const HOME_HREF = '/';

/** expo-router 의 Router 중 여기서 쓰는 부분만 */
export interface HomeNavRouter {
  canGoBack(): boolean;
  dismissTo(href: typeof HOME_HREF): void;
  replace(href: typeof HOME_HREF): void;
}

export function goHomeWith(router: HomeNavRouter): 'dismissTo' | 'replace' {
  if (router.canGoBack()) {
    router.dismissTo(HOME_HREF);
    return 'dismissTo';
  }
  router.replace(HOME_HREF);
  return 'replace';
}
