import { Stack, useRouter } from 'expo-router';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { LateBetProvider } from '@/lateBet/LateBetContext';
import { FriendsProvider } from '@/state/FriendsContext';
import { SessionsProvider } from '@/state/SessionsContext';
import { HeaderTextButton } from '@/ui/components';
import { colors } from '@/ui/theme';

/**
 * 루트 Stack 의 닻 = (tabs). 앱이 꺼진 상태에서 딥링크(/j/CODE, /late/id, /friends/add …)로 열어도
 * 그 화면 아래에 (tabs)(모임 탭)가 깔린다 → 헤더 뒤로 버튼·안드로이드 뒤로가기가 탭으로 돌아오고,
 * '홈으로'(src/ui/homeNav)는 dismissTo('/') 로 모임 탭에 간다. 없으면 딥링크 화면 한 장짜리 스택이 되어 뒤로가기 = 앱 종료.
 */
export const unstable_settings = {
  initialRouteName: '(tabs)',
};

const IOS_MODAL = Platform.OS === 'ios';

/**
 * iOS 친구 추가 모달의 왼쪽 위 [취소]. 모달은 따로 쌓인 네이티브 스택의 첫 화면이라 뒤로 버튼이 생기지 않는다 —
 * 없으면 시트를 쓸어내리는 것 말고 나갈 길이 없다. 안드로이드·웹은 card 라 기본 뒤로 화살표가 있다.
 */
function ModalCancelButton() {
  const router = useRouter();
  return (
    <HeaderTextButton
      label="취소"
      side="left"
      onPress={() => {
        if (router.canGoBack()) router.back();
        else router.replace('/friends');
      }}
    />
  );
}

export default function RootLayout() {
  return (
    <SessionsProvider>
      <FriendsProvider>
      {/* 약속 내기: 모드가 off 면 아무 일도 하지 않는다(네트워크·스토리지 접근 0) */}
      <LateBetProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700', color: colors.text },
          headerStyle: { backgroundColor: colors.bg },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        {/* 아래 탭바(친구 · 모임 · 마이). 헤더는 탭마다 따로 그린다. title 은 탭을 옮길 때 (tabs)/_layout 이 맞춘다(iOS 뒤로 버튼 글자) */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: '모꼬지' }} />
        <Stack.Screen name="friends/[friendId]" options={{ title: '친구' }} />
        <Stack.Screen
          name="friends/add"
          options={
            IOS_MODAL
              ? { title: '친구 추가', presentation: 'modal', headerLeft: () => <ModalCancelButton /> }
              : { title: '친구 추가', presentation: 'card' }
          }
        />
        <Stack.Screen name="session/new" options={{ title: '새 모임' }} />
        <Stack.Screen name="session/place" options={{ title: '장소 정하기' }} />
        <Stack.Screen name="session/[id]/index" options={{ title: '모임' }} />
        <Stack.Screen name="session/[id]/bet" options={{ title: '모임 내기' }} />
        <Stack.Screen name="session/[id]/round/[roundId]" options={{ title: '차수' }} />
        <Stack.Screen name="session/[id]/round/[roundId]/bet" options={{ title: '내기' }} />
        <Stack.Screen name="session/[id]/result" options={{ title: '정산 결과' }} />
        <Stack.Screen name="late/new" options={{ title: '약속 잡기' }} />
        <Stack.Screen name="late/place" options={{ title: '위치 정하기' }} />
        <Stack.Screen name="late/[id]/index" options={{ title: '약속' }} />
        <Stack.Screen name="late/points" options={{ title: '포인트' }} />
        <Stack.Screen name="late/name" options={{ title: '내 이름' }} />
        <Stack.Screen name="j/index" options={{ title: '초대 코드 입력' }} />
        <Stack.Screen name="j/[code]" options={{ title: '약속 참여' }} />
      </Stack>
      </LateBetProvider>
      </FriendsProvider>
    </SessionsProvider>
  );
}
