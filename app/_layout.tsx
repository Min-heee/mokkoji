import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { SessionsProvider } from '@/state/SessionsContext';
import { colors } from '@/ui/theme';

export default function RootLayout() {
  return (
    <SessionsProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700' },
          headerStyle: { backgroundColor: colors.bg },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: '엔빵' }} />
        <Stack.Screen name="session/new" options={{ title: '새 모임' }} />
        <Stack.Screen name="session/[id]/index" options={{ title: '모임' }} />
        <Stack.Screen name="session/[id]/round/[roundId]" options={{ title: '차수' }} />
        <Stack.Screen name="session/[id]/round/[roundId]/scan" options={{ title: '영수증 스캔' }} />
        <Stack.Screen name="session/[id]/result" options={{ title: '정산 결과' }} />
      </Stack>
    </SessionsProvider>
  );
}
