import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// 루트 Stack(expo-router Stack → 원래 StackRouter 로 넘어가는 POP_TO·POP_TO_TOP)과 탭(TabRouter)의 실제 라우터
import { StackRouter, TabRouter } from '@react-navigation/routers';

import { goHomeWith, HOME_HREF, type HomeNavRouter } from './homeNav';

function fakeRouter(canGoBack: boolean) {
  const calls: string[] = [];
  const router: HomeNavRouter = {
    canGoBack: () => canGoBack,
    dismissTo: (href) => void calls.push('dismissTo ' + href),
    replace: (href) => void calls.push('replace ' + href),
  };
  return { router, calls };
}

describe('goHomeWith', () => {
  it('쌓인 화면이 있으면 dismissTo("/") 한 번 — dismissAll·replace 는 부르지 않는다', () => {
    const { router, calls } = fakeRouter(true);
    assert.equal(goHomeWith(router), 'dismissTo');
    assert.deepEqual(calls, ['dismissTo /']);
  });
  it('쌓인 화면이 없으면 replace("/")', () => {
    const { router, calls } = fakeRouter(false);
    assert.equal(goHomeWith(router), 'replace');
    assert.deepEqual(calls, ['replace /']);
  });
  it('홈 = 모임 탭 URL', () => {
    assert.equal(HOME_HREF, '/');
  });
});

/**
 * 회귀: 친구 탭을 보던 중 알림으로 약속 화면이 쌓인 상태 [(tabs)@friends, late/[id]/index].
 * - dismissAll(POP_TO_TOP) 은 (tabs) 를 떠날 때의 탭(friends) 그대로 남긴다 → '홈으로'가 친구 탭으로 갔다.
 * - dismissTo('/') 는 POP_TO (tabs) + params.screen 'index' → 탭 내비게이터가 그 params 로 모임 탭으로 이동한다.
 * - replace('/') 는 (tabs) 를 하나 더 쌓는다 → 스택이 있을 때 쓰면 안 된다.
 */
describe('루트 Stack 라우터 동작(홈으로 규칙의 근거)', () => {
  const rootNames = ['(tabs)', 'late/[id]/index', 'j/[code]'];
  const tabNames = ['friends', 'index', 'my'];
  const stack = StackRouter({ initialRouteName: '(tabs)' });
  const tabs = TabRouter({ initialRouteName: 'index', backBehavior: 'initialRoute' });
  const stackOpts = { routeNames: rootNames, routeParamList: {}, routeGetIdList: {} };
  const tabOpts = { routeNames: tabNames, routeParamList: {}, routeGetIdList: {} };

  type TabState = ReturnType<typeof tabs.getInitialState>;

  function tabsOn(tab: string): TabState {
    const init = tabs.getInitialState(tabOpts);
    const next = tabs.getStateForAction(init, { type: 'JUMP_TO', payload: { name: tab } }, tabOpts);
    assert.ok(next);
    return next as TabState;
  }

  function rootWithLateOnTopOf(tab: string) {
    return {
      stale: false as const,
      type: 'stack' as const,
      key: 'root',
      index: 1,
      routeNames: rootNames,
      preloadedRoutes: [],
      routes: [
        { key: 'tabs-1', name: '(tabs)', state: tabsOn(tab) },
        { key: 'late-1', name: 'late/[id]/index', params: { id: 'a1' } },
      ],
    };
  }

  it('POP_TO_TOP(dismissAll) 은 떠날 때의 탭을 그대로 둔다(버그의 원인)', () => {
    const next = stack.getStateForAction(rootWithLateOnTopOf('friends'), { type: 'POP_TO_TOP', target: 'root' }, stackOpts);
    assert.ok(next && 'routes' in next);
    assert.equal(next.routes.length, 1);
    const tabState = next.routes[0].state as { index: number; routeNames: string[] };
    assert.equal(tabState.routeNames[tabState.index], 'friends');
  });

  it("POP_TO (tabs){screen:'index'}(dismissTo('/')) 은 같은 (tabs) 로 걷어 내고 모임 탭을 가리킨다", () => {
    const next = stack.getStateForAction(
      rootWithLateOnTopOf('my'),
      { type: 'POP_TO', target: 'root', payload: { name: '(tabs)', params: { screen: 'index', params: {} } } },
      stackOpts,
    );
    assert.ok(next && 'routes' in next);
    assert.equal(next.routes.length, 1);
    assert.equal(next.routes[0].key, 'tabs-1', '새 (tabs) 를 만들지 않는다');
    const params = next.routes[0].params as { screen?: string } | undefined;
    assert.equal(params?.screen, 'index');
    // 탭 내비게이터는 바뀐 params.screen 을 NAVIGATE 로 받는다 → 모임 탭
    const tabState = tabs.getStateForAction(
      next.routes[0].state as TabState,
      { type: 'NAVIGATE', payload: { name: 'index' } },
      tabOpts,
    ) as TabState | null;
    assert.ok(tabState);
    assert.equal(tabState.routeNames[tabState.index], 'index');
  });

  it('REPLACE (tabs) 는 스택이 있을 때 (tabs) 를 하나 더 쌓는다(스택이 있으면 replace 금지)', () => {
    const next = stack.getStateForAction(
      rootWithLateOnTopOf('friends'),
      { type: 'REPLACE', target: 'root', payload: { name: '(tabs)', params: { screen: 'index' } } },
      stackOpts,
    );
    assert.ok(next && 'routes' in next);
    assert.deepEqual(
      next.routes.map((r) => r.name),
      ['(tabs)', '(tabs)'],
    );
  });
});

describe('소스 가드', () => {
  it("루트 레이아웃이 (tabs) 를 닻으로 둔다 — 콜드 스타트 딥링크(/j/CODE → /late/id)도 탭 위에 쌓인다", async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'app', '_layout.tsx'), 'utf8'); // npm test 는 리포 루트에서 돈다
    assert.match(src, /export const unstable_settings\s*=\s*\{[^}]*initialRouteName:\s*'\(tabs\)'/);
  });

  it("app·src 어디에서도 dismissAll 을 쓰지 않는다(남은 탭으로 돌아간다) — '홈으로'는 goHomeWith", async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = process.cwd();
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.ts$/.test(name)) {
          if (/\.dismissAll\s*\(/.test(readFileSync(p, 'utf8'))) offenders.push(p.slice(root.length + 1));
        }
      }
    };
    walk(join(root, 'app'));
    walk(join(root, 'src'));
    assert.deepEqual(offenders, []);
  });
});
