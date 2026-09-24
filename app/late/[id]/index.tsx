/**
 * 약속 화면 — useLive + latePhase 로 단계를 구해 단계별 뷰로 나눈다.
 *
 *   waiting → WaitingView            (시작 전 대기실 — 주최자에게 [시작하기])
 *   live · overtime → LiveView       (주최자가 시작한 뒤: 위치 공개·체크인)   arrived → ArrivedView
 *   settling · settled · voided → ResultView
 *   canceled · 내보내짐 · 불러오기 실패 → 이 파일의 안내 화면
 * 수락제(pending·PendingView)와 '전원 참여 시 자동 잠금'(locked)은 오너 확정 흐름(2026-09-18)으로 없다.
 *
 * 뷰는 자기 <Screen> 을 직접 그린다. 이 컨테이너는 그 위에 FakeDevPanel(가짜 모드)과 연결 끊김 띠,
 * 그리고 '알림 켜기' 1회 안내 카드(네이티브, 알림 권한을 아직 안 정했을 때)만 얹는다.
 * 위치 보고 루프(useArrivalReporter)와 로컬 알림 동기화(useLateReminders)는 단계가 바뀌어도 끊기지 않게 여기서 돌린다.
 */
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { isConnectivityError, REMOVED_MESSAGE, REPEATED_FAILURE_MESSAGE } from '@/lateBet/errors';
import { useLateBet } from '@/lateBet/LateBetContext';
import { cancelLateNotifications } from '@/lateBet/notifications';
import { canceledText } from '@/lateBet/resultModel';
import { ArrivedView } from '@/lateBet/screens/ArrivedView';
import { FakeDevPanel } from '@/lateBet/screens/FakeDevPanel';
import { LiveView } from '@/lateBet/screens/LiveView';
import { LateBetUnavailable } from '@/lateBet/screens/NicknameGate';
import type { LateViewProps } from '@/lateBet/screens/props';
import { ResultView } from '@/lateBet/screens/ResultView';
import { WaitingView } from '@/lateBet/screens/WaitingView';
import { useArrivalReporter } from '@/lateBet/useArrivalReporter';
import { useLateReminders, type NotifyPrompt } from '@/lateBet/useLateReminders';
import { useLive } from '@/lateBet/useLive';
import { EmptyState, LoadingState, PrimaryButton, Screen } from '@/ui/components';
import { goHomeWith } from '@/ui/homeNav';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

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
  const { live, phase, me, isHost, loading, error, stale, failCount, removed, settleDelayed, unseenChanges, ackChanges, refresh } =
    useLive(id);

  const [justArrived, setJustArrived] = useState(false);
  const left = useRef(false);

  const reporter = useArrivalReporter(live, {
    onArrived: () => {
      setJustArrived(true);
      void refresh();
    },
  });

  // 로컬 알림: 응답마다 계획을 맞추고(도착·취소·정산이면 비워 취소), 내보내지면 전부 취소
  const notify = useLateReminders(id, live, removed);

  const goHome = useCallback(() => {
    void refreshHome();
    // 모임 탭으로(쌓인 화면은 걷어 낸다 — 규칙은 src/ui/homeNav)
    goHomeWith(router);
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
          <EmptyState title={REMOVED_MESSAGE} />
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

  const common: LateViewProps = { live, phase, me, isHost, api, refresh, stale, error, unseenChanges, ackChanges };

  let body: React.ReactNode;
  switch (phase) {
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
    case 'canceled':
      // 문구는 resultModel.canceledText 한 곳에 둔다(ResultView 와 같은 문장)
      body = (
        <Screen footer={<PrimaryButton label="홈으로" onPress={goHome} />}>
          <EmptyState title={canceledText(live, isHost)} />
        </Screen>
      );
      break;
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
      {/* 시작 뒤 위치 권한을 아직 안 정했으면 위치 안내가 먼저다 — 알림 카드는 그 뒤에 */}
      {notify.visible && (phase === 'waiting' || reporter.permission !== 'undetermined') ? (
        <NotifyCard prompt={notify} />
      ) : null}
      {body}
    </View>
  );
}

/** '알림 켜기' 1회 안내 — 참여·생성 직후의 위치 권한 안내와 겹치지 않게 약속 화면에서 묻는다 */
function NotifyCard({ prompt }: { prompt: NotifyPrompt }) {
  return (
    <View style={styles.notify}>
      <Text style={styles.notifyTitle}>약속 알림을 켤까요?</Text>
      <Text style={styles.notifyText}>약속 시간이 다가오면 알려 드려요. 앱을 닫아 둬도 받을 수 있어요.</Text>
      <View style={styles.notifyActions}>
        <Pressable
          onPress={prompt.enable}
          disabled={prompt.busy}
          accessibilityRole="button"
          hitSlop={8}
          style={({ pressed }) => [styles.notifyButton, (pressed || prompt.busy) && { opacity: 0.6 }]}
        >
          <Text style={styles.notifyButtonText}>알림 켜기</Text>
        </Pressable>
        <Pressable
          onPress={prompt.dismiss}
          disabled={prompt.busy}
          accessibilityRole="button"
          hitSlop={8}
          style={({ pressed }) => pressed && { opacity: 0.6 }}
        >
          <Text style={styles.notifyLater}>괜찮아요</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  band: { backgroundColor: colors.primary, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  bandText: { color: colors.onPrimary, fontSize: fontSize.sm, fontWeight: '600' },
  notify: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    padding: spacing.md,
    gap: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: colors.cardAlt,
  },
  notifyTitle: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text },
  notifyText: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  notifyActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginTop: spacing.xs },
  notifyButton: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.primary },
  notifyButtonText: { fontSize: fontSize.sm, fontWeight: '800', color: colors.onPrimary },
  notifyLater: { fontSize: fontSize.sm, fontWeight: '700', color: colors.subtext },
});
