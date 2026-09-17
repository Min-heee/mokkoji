/**
 * 약속 화면 — useLive + latePhase 로 단계를 구해 단계별 뷰로 나눈다.
 *
 *   pending → PendingView        waiting → WaitingView
 *   live · overtime → LiveView   arrived → ArrivedView
 *   settling · settled · voided → ResultView
 *   canceled · 내보내짐/거절 · 불러오기 실패 → 이 파일의 안내 화면
 *
 * 뷰는 자기 <Screen> 을 직접 그린다. 이 컨테이너는 그 위에 FakeDevPanel(가짜 모드)과 연결 끊김 띠만 얹는다.
 * 위치 보고 루프(useArrivalReporter)는 단계가 바뀌어도 끊기지 않게 여기서 돌린다.
 */
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { isConnectivityError, REPEATED_FAILURE_MESSAGE, removedMessage } from '@/lateBet/errors';
import { useLateBet } from '@/lateBet/LateBetContext';
import { cancelLateNotifications } from '@/lateBet/notifications';
import { ArrivedView } from '@/lateBet/screens/ArrivedView';
import { FakeDevPanel } from '@/lateBet/screens/FakeDevPanel';
import { LiveView } from '@/lateBet/screens/LiveView';
import { LateBetUnavailable } from '@/lateBet/screens/NicknameGate';
import { PendingView } from '@/lateBet/screens/PendingView';
import type { LateViewProps } from '@/lateBet/screens/props';
import { ResultView } from '@/lateBet/screens/ResultView';
import { WaitingView } from '@/lateBet/screens/WaitingView';
import { useArrivalReporter } from '@/lateBet/useArrivalReporter';
import { useLive } from '@/lateBet/useLive';
import { EmptyState, LoadingState, PrimaryButton, Screen } from '@/ui/components';
import { colors, fontSize, spacing } from '@/ui/theme';

export default function LateAppointmentScreen() {
  const { enabled } = useLateBet();
  if (!enabled) return <LateBetUnavailable />;
  return <Inner />;
}

function Inner() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : null;
  const { api, refresh: refreshHome } = useLateBet();
  const { live, phase, me, isHost, loading, error, stale, failCount, removed, settleDelayed, refresh } = useLive(id);

  const [justArrived, setJustArrived] = useState(false);
  const left = useRef(false);

  const reporter = useArrivalReporter(live, {
    onArrived: () => {
      setJustArrived(true);
      void refresh();
    },
  });

  const goHome = useCallback(() => {
    void refreshHome();
    // 스택에 홈이 있으면 거기까지 걷어 내고, 딥링크로 바로 들어온 경우에는 홈으로 바꾼다
    if (router.canGoBack()) router.dismissAll();
    else router.replace('/');
  }, [refreshHome, router]);

  const onLeft = useCallback(() => {
    left.current = true;
    if (id) void cancelLateNotifications(id);
    goHome();
  }, [goHome, id]);

  // 끝난 약속: 알림을 거두고 홈 목록·잔액을 새로 읽어 둔다
  const closed = phase === 'settled' || phase === 'voided' || phase === 'canceled';
  useEffect(() => {
    if (!closed || !id) return;
    void cancelLateNotifications(id);
    void refreshHome();
  }, [closed, id, refreshHome]);

  const title = live?.appointment.title ?? '약속';
  const header = <Stack.Screen options={{ title }} />;
  const dev = <FakeDevPanel appointmentId={id} onChanged={() => void refresh()} />;

  if (removed && !left.current) {
    return (
      <View style={styles.fill}>
        {header}
        {dev}
        <Screen footer={<PrimaryButton label="홈으로" onPress={goHome} />}>
          <EmptyState title={removedMessage(removed.wasPending)} />
        </Screen>
      </View>
    );
  }

  if (!live || !phase) {
    return (
      <View style={styles.fill}>
        {header}
        {dev}
        {loading || left.current ? (
          <Screen>
            <LoadingState />
          </Screen>
        ) : (
          <Screen
            footer={
              <View style={{ gap: spacing.sm }}>
                <PrimaryButton label="다시 시도" onPress={() => void refresh()} />
                <PrimaryButton label="홈으로" variant="ghost" onPress={goHome} />
              </View>
            }
          >
            <EmptyState
              title={error?.message ?? '약속을 불러오지 못했어요.'}
              hint={failCount >= 3 ? REPEATED_FAILURE_MESSAGE : undefined}
            />
          </Screen>
        )}
      </View>
    );
  }

  const common: LateViewProps = { live, phase, me, isHost, api, refresh, stale, error };

  let body: React.ReactNode;
  switch (phase) {
    case 'pending':
      body = <PendingView {...common} onLeft={onLeft} />;
      break;
    case 'waiting':
      body = <WaitingView {...common} onLeft={onLeft} />;
      break;
    case 'live':
    case 'overtime':
      body = <LiveView {...common} reporter={reporter} />;
      break;
    case 'arrived':
      body = <ArrivedView {...common} justArrived={justArrived} />;
      break;
    case 'settling':
    case 'settled':
    case 'voided':
      body = <ResultView {...common} settleDelayed={settleDelayed} />;
      break;
    case 'canceled': {
      const stake = live.appointment.policy.stake;
      const refund = stake > 0 && live.myState === 'active' ? ` 건 ${stake}P는 돌려드렸어요.` : '';
      body = (
        <Screen footer={<PrimaryButton label="홈으로" onPress={goHome} />}>
          <EmptyState title={isHost ? `약속을 취소했어요.${refund}` : `주최자가 약속을 취소했어요.${refund}`} />
        </Screen>
      );
      break;
    }
    default:
      body = null;
  }

  return (
    <View style={styles.fill}>
      {header}
      {dev}
      {stale ? (
        <View style={styles.band}>
          <Text style={styles.bandText}>
            {error && isConnectivityError(error)
              ? '연결이 끊겼어요. 다시 연결되면 바로 확인할게요'
              : error?.message ?? '지금은 약속 서버에 연결할 수 없어요.'}
            {failCount >= 3 ? ` ${REPEATED_FAILURE_MESSAGE}` : ''}
          </Text>
        </View>
      ) : null}
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  band: { backgroundColor: colors.primary, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  bandText: { color: colors.onPrimary, fontSize: fontSize.sm, fontWeight: '600' },
});
