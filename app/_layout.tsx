import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { LateBetProvider } from '@/lateBet/LateBetContext';
import { FriendsProvider } from '@/state/FriendsContext';
import { SessionsProvider } from '@/state/SessionsContext';
import { colors } from '@/ui/theme';

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
        <Stack.Screen name="index" options={{ title: '정산야호' }} />
        <Stack.Screen name="friends/index" options={{ title: '친구' }} />
        <Stack.Screen name="friends/[friendId]" options={{ title: '친구' }} />
        <Stack.Screen name="session/new" options={{ title: '새 모임' }} />
        <Stack.Screen name="session/[id]/index" options={{ title: '모임' }} />
        <Stack.Screen name="session/[id]/bet" options={{ title: '모임 내기' }} />
        <Stack.Screen name="session/[id]/round/[roundId]" options={{ title: '차수' }} />
        <Stack.Screen name="session/[id]/round/[roundId]/bet" options={{ title: '내기' }} />
        <Stack.Screen name="session/[id]/result" options={{ title: '정산 결과' }} />
        <Stack.Screen name="late/new" options={{ title: '약속 잡기' }} />
        <Stack.Screen name="late/place" options={{ title: '위치 정하기' }} />
        <Stack.Screen name="late/[id]/index" options={{ title: '약속' }} />
        <Stack.Screen name="late/points" options={{ title: '포인트' }} />
        <Stack.Screen name="j/index" options={{ title: '초대 코드 입력' }} />
        <Stack.Screen name="j/[code]" options={{ title: '약속 참여' }} />
      </Stack>
      </LateBetProvider>
      </FriendsProvider>
    </SessionsProvider>
  );
}
