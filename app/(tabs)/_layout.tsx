/**
 * 아래 탭바: 친구 · 모임 · 마이 (왼→오). 앱을 열면 모임 탭(index, URL '/')이 먼저 보인다.
 *
 * - JS 탭(expo-router Tabs = @react-navigation/bottom-tabs). 네이티브 탭(NativeTabs)은 쓰지 않는다 — 지금 폰의 바이너리로 OTA 한다.
 * - 안드로이드 뒤로가기: 다른 탭에서 누르면 모임 탭으로 돌아온다(backBehavior 'initialRoute'). 첫 탭(친구)으로 가지 않는다.
 * - 각 탭은 자기 헤더를 가진다(루트 Stack 헤더와 같은 톤). 탭을 옮길 때 루트 Stack 의 (tabs) 제목을 맞춰 둔다 —
 *   탭 위로 쌓인 화면(친구 장부 등)의 iOS 뒤로 버튼 글자가 '(tabs)' 가 아니라 떠나온 탭 이름이 되게.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs, useNavigation, useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HeaderTextButton } from '@/ui/components';
import { colors } from '@/ui/theme';

export const unstable_settings = {
  initialRouteName: 'index',
};

type IconName = React.ComponentProps<typeof Ionicons>['name'];

/**
 * 탭바 본체 높이(하단 안전영역 제외). 기본 49 는 라벨 10px 기준이라 12px 라벨의 아랫부분이 잘린다
 * (아이콘 칸 28 + 위아래 여백 10 + 테두리 1 → 라벨 칸 10). 56 이면 라벨 칸 17.
 */
const TAB_BAR_HEIGHT = 56;

const TAB_TITLES: Record<string, string> = {
  friends: '친구',
  index: '모꼬지',
  my: '마이',
};

function tabIcon(filled: IconName, outline: IconName) {
  return function TabIcon({ focused, color, size }: { focused: boolean; color: string; size: number }) {
    return <Ionicons name={focused ? filled : outline} size={size} color={color} />;
  };
}

/** 친구 탭 헤더 오른쪽 위 글자 버튼 → 친구 추가 화면 */
function AddFriendHeaderButton() {
  const router = useRouter();
  return <HeaderTextButton label="친구 추가" side="right" onPress={() => router.push('/friends/add')} />;
}

export default function TabsLayout() {
  // 이 레이아웃은 루트 Stack 의 '(tabs)' 화면이다 → 여기의 navigation 은 루트 Stack 쪽
  const stackNavigation = useNavigation();
  // 높이를 직접 주면 bottom-tabs 는 안전영역을 더하지 않는다(안쪽 paddingBottom 으로만 쓴다) → 여기서 더한다
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      initialRouteName="index"
      backBehavior="initialRoute"
      screenListeners={({ route }) => ({
        focus: () => {
          const title = TAB_TITLES[route.name];
          if (title) stackNavigation.setOptions({ title });
        },
      })}
      screenOptions={{
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '700', color: colors.text },
        headerStyle: { backgroundColor: colors.bg },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: colors.bg },
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.subtext,
        tabBarLabelStyle: styles.tabLabel,
        tabBarStyle: [styles.tabBar, { height: TAB_BAR_HEIGHT + insets.bottom }],
      }}
    >
      <Tabs.Screen
        name="friends"
        options={{
          title: TAB_TITLES.friends,
          tabBarLabel: '친구',
          tabBarIcon: tabIcon('people', 'people-outline'),
          headerRight: () => <AddFriendHeaderButton />,
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: TAB_TITLES.index,
          tabBarLabel: '모임',
          tabBarIcon: tabIcon('calendar', 'calendar-outline'),
        }}
      />
      <Tabs.Screen
        name="my"
        options={{
          title: TAB_TITLES.my,
          tabBarLabel: '마이',
          tabBarIcon: tabIcon('person-circle', 'person-circle-outline'),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.card,
    borderTopColor: colors.border,
    borderTopWidth: 1,
  },
  tabLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
});
