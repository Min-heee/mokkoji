import { Stack, useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  appointmentStatus,
  compareByAppointment,
  formatAppointmentTime,
  formatCountdown,
  hasAppointment,
} from '@/domain/appointment';
import { formatKrw } from '@/domain/format';
import { roundBaseTotal } from '@/domain/settlement';
import type { Session } from '@/domain/types';
import { isConnectivityError, REPEATED_FAILURE_MESSAGE, SERVER_DOWN_NOTICE, STALE_NOTICE } from '@/lateBet/errors';
import {
  HOME_BADGE_LABEL,
  homeBadge,
  homeMetaLine,
  homeTimeLine,
  homeUnclaimedLine,
  splitHomeAppointments,
} from '@/lateBet/homeModel';
import { useLateBet } from '@/lateBet/LateBetContext';
import { FakeDevPanel } from '@/lateBet/screens/FakeDevPanel';
import type { LbMyAppointment } from '@/lateBet/types';
import { useServerNow } from '@/lateBet/useServerNow';
import { useSessions } from '@/state/SessionsContext';
import { confirmDialog } from '@/ui/dialogs';
import { useNow } from '@/ui/useNow';
import {
  Card,
  EmptyState,
  LoadingState,
  PrimaryButton,
  Screen,
  SectionTitle,
} from '@/ui/components';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}.${m}.${day}`;
}

function peopleSummary(session: Session): string {
  const names = session.people.map((p) => p.name);
  const count = names.length;
  if (count === 0) return '참가자 없음';
  if (count > 4) {
    return `${names.slice(0, 3).join(', ')} 외 ${count - 3}명 · ${count}명`;
  }
  return `${names.join(', ')} · ${count}명`;
}

export default function HomeScreen() {
  const router = useRouter();
  const { sessions, loading, deleteSession } = useSessions();
  // 훅이라 early return보다 위에 있어야 한다
  const now = useNow();
  // 약속 내기: 모드가 off 면 enabled=false 인 고정값이라 아래 분기는 전부 기존 홈 그대로다
  const { enabled: lateEnabled } = useLateBet();

  if (loading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  const confirmDelete = (session: Session) => {
    confirmDialog(
      '모임 삭제',
      `'${session.title}' 모임을 삭제할까요?`,
      () => deleteSession(session.id),
      { confirmText: '삭제', destructive: true },
    );
  };

  const sorted = [...sessions].sort((a, b) => compareByAppointment(a, b, now));

  const sessionList =
    sessions.length === 0 ? (
      <EmptyState
        title="아직 모임이 없어요"
        hint="새 모임을 만들어 정산을 시작해보세요"
      />
    ) : (
      sorted.map((s) => {
        const total = s.rounds.reduce((sum, r) => sum + roundBaseTotal(r), 0);
        const appt = s.appointment ?? null;
        const showAppointment = appt !== null && hasAppointment(appt);
        const place = appt ? appt.place.trim() : '';
        return (
          <Card
            key={s.id}
            onPress={() => router.push('/session/' + s.id)}
            onLongPress={() => confirmDelete(s)}
          >
            <View style={styles.headerRow}>
              <Text style={styles.title} numberOfLines={1}>
                {s.title}
              </Text>
              <Pressable
                onPress={() => confirmDelete(s)}
                hitSlop={12}
                style={({ pressed }) => [
                  styles.deleteButton,
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Text style={styles.deleteLabel}>삭제</Text>
              </Pressable>
            </View>
            {showAppointment && appt ? (
              <View style={styles.appointmentBlock}>
                {appt.at ? (
                  <View style={styles.appointmentRow}>
                    <Text style={styles.appointmentTime} numberOfLines={1}>
                      {formatAppointmentTime(appt.at)}
                    </Text>
                    <Text
                      style={[
                        styles.countdown,
                        appointmentStatus(appt, now) === 'past' &&
                          styles.countdownPast,
                      ]}
                    >
                      {formatCountdown(appt.at, now)}
                    </Text>
                  </View>
                ) : null}
                {place ? (
                  <Text style={styles.meta} numberOfLines={1}>
                    {place}
                  </Text>
                ) : null}
              </View>
            ) : (
              <Text style={styles.meta}>{formatDate(s.createdAt)}</Text>
            )}
            <Text style={styles.meta}>{peopleSummary(s)}</Text>
            <Text style={styles.meta}>
              차수 {s.rounds.length}개 · {formatKrw(total)}
            </Text>
          </Card>
        );
      })
    );

  if (!lateEnabled) {
    return (
      <Screen
        footer={
          <View style={styles.footerButtons}>
            <PrimaryButton
              label="새 모임 만들기"
              onPress={() => router.push('/session/new')}
            />
            <PrimaryButton
              label="친구 목록"
              variant="ghost"
              onPress={() => router.push('/friends')}
            />
          </View>
        }
      >
        {sessionList}
      </Screen>
    );
  }

  // ── 약속 내기가 켜진 홈 (설계서 §5.3-A): 잔액 칩 + '약속' 섹션 + [약속 잡기] primary + 코드 입력 ──
  return (
    <View style={styles.fill}>
      <Stack.Screen options={{ headerRight: () => <BalanceHeaderButton /> }} />
      <FakeDevPanel />
      <Screen
        footer={
          <View style={styles.footerButtons}>
            <PrimaryButton label="약속 잡기" onPress={() => router.push('/late/new')} />
            <PrimaryButton
              label="새 모임 만들기"
              variant="ghost"
              onPress={() => router.push('/session/new')}
            />
            <PrimaryButton
              label="친구 목록"
              variant="ghost"
              onPress={() => router.push('/friends')}
            />
            <Pressable
              onPress={() => router.push('/j')}
              hitSlop={8}
              accessibilityRole="button"
              style={({ pressed }) => [styles.codeLink, pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.codeLinkText}>
                초대 코드가 있나요? <Text style={styles.codeLinkStrong}>코드 입력</Text>
              </Text>
            </Pressable>
          </View>
        }
      >
        <LateHomeSection />
        <SectionTitle>정산 모임</SectionTitle>
        {sessionList}
      </Screen>
    </View>
  );
}

// ───────────────────────── 약속 내기 (모드가 off 가 아닐 때만 그려진다) ─────────────────────────

/** 헤더 오른쪽 잔액 칩 — 탭하면 포인트 화면. 세션·프로필이 없으면 그리지 않는다 */
function BalanceHeaderButton() {
  const router = useRouter();
  const { balance } = useLateBet();
  if (balance === null) return null;
  return (
    <Pressable
      onPress={() => router.push('/late/points')}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="포인트"
      style={({ pressed }) => [styles.balanceChip, pressed && { opacity: 0.6 }]}
    >
      <Text style={styles.balanceChipText}>{balance.toLocaleString('ko-KR')}P</Text>
    </Pressable>
  );
}

/** 끝난 약속은 이만큼만 보이고 나머지는 [더 보기] */
const ENDED_LIMIT = 2;

/**
 * '약속' 섹션: 새 버전 안내 → 연결 안내 → 카드 목록.
 * 세션이 없으면(status idle: 약속 기능에 들어온 적 없음) 아무것도 그리지 않는다 — 홈에는 버튼만 보인다.
 */
function LateHomeSection() {
  const router = useRouter();
  const { status, appointments, error, failCount, stale, needsUpdate, installUrl, refresh } = useLateBet();
  // 카운트다운은 서버 기준 시각으로(가짜 서버의 빨리 감기와 맞물린다). 목록은 30초면 충분하다
  const now = useServerNow(30_000);
  const [showEnded, setShowEnded] = useState(false);

  // 홈이 앞으로 올 때마다 목록·잔액을 다시 읽는다(변경 RPC 뒤·다른 화면에서 돌아올 때)
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  if (status === 'idle') return null;

  let notice = '';
  if (status === 'error') {
    if (isConnectivityError(error)) notice = stale ? STALE_NOTICE : error?.message ?? STALE_NOTICE;
    else notice = SERVER_DOWN_NOTICE;
    if (failCount >= 3) notice = `${notice} ${REPEATED_FAILURE_MESSAGE}`;
  }

  const { shown, hiddenEnded } = splitHomeAppointments(appointments, showEnded ? appointments.length : ENDED_LIMIT);
  const initialLoading = status === 'loading' && appointments.length === 0;

  return (
    <>
      {needsUpdate ? (
        <View style={styles.noticeBox}>
          <Text style={styles.noticeText}>새 버전을 설치해 주세요</Text>
          {installUrl ? (
            <Pressable
              onPress={() => void Linking.openURL(installUrl).catch(() => undefined)}
              hitSlop={8}
              accessibilityRole="link"
              style={({ pressed }) => [styles.noticeLink, pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.noticeLinkText}>설치</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {notice ? (
        <View style={styles.noticeBox}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      ) : null}
      <SectionTitle>약속</SectionTitle>
      {initialLoading ? (
        <Text style={styles.meta}>불러오는 중</Text>
      ) : shown.length === 0 ? (
        <Text style={styles.meta}>아직 약속이 없어요. 약속을 잡고 친구를 초대해 보세요.</Text>
      ) : (
        shown.map((a) => (
          <LateAppointmentCard key={a.id} appointment={a} now={now} onPress={() => router.push('/late/' + a.id)} />
        ))
      )}
      {hiddenEnded > 0 ? (
        <Pressable
          onPress={() => setShowEnded(true)}
          hitSlop={8}
          accessibilityRole="button"
          style={({ pressed }) => [styles.moreLink, pressed && { opacity: 0.6 }]}
        >
          <Text style={styles.moreLinkText}>끝난 약속 {hiddenEnded}개 더 보기</Text>
        </Pressable>
      ) : null}
    </>
  );
}

/**
 * 약속 카드 한 장: 제목 + 배지([모이는 중]/[진행 중]/[정산 확인 중]/[끝남], 오너 확정 2026-09-18) / 시각 · 남은 시간 /
 * 장소 · 인원 · 내기 포인트. 주최자에게는 아직 안 들어온 친구 수를 한 줄 더(시작 뒤에도 약속 시각까지 들어올 수 있다).
 * [진행 중](주최자가 시작해 위치가 보이는 중)만 솔리드로 강조한다.
 */
function LateAppointmentCard({
  appointment: a,
  now,
  onPress,
}: {
  appointment: LbMyAppointment;
  now: number;
  onPress: () => void;
}) {
  const badge = homeBadge(a, now);
  const ended = a.status !== 'open';
  const unclaimed = homeUnclaimedLine(a);
  return (
    <Card onPress={onPress}>
      <View style={styles.headerRow}>
        <Text style={[styles.title, ended && styles.titleEnded]} numberOfLines={1}>
          {a.title}
        </Text>
        <Text style={[styles.badge, badge === 'inProgress' && styles.badgeStrong]}>{HOME_BADGE_LABEL[badge]}</Text>
      </View>
      <Text style={[styles.appointmentTime, ended && styles.meta]} numberOfLines={1}>
        {homeTimeLine(a, now)}
      </Text>
      <Text style={styles.meta} numberOfLines={1}>
        {homeMetaLine(a)}
      </Text>
      {unclaimed ? <Text style={styles.meta}>{unclaimed}</Text> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  footerButtons: {
    gap: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  title: {
    flex: 1,
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
  },
  titleEnded: {
    color: colors.subtext,
  },
  deleteButton: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: colors.dangerDim,
  },
  deleteLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.danger,
  },
  meta: {
    fontSize: fontSize.sm,
    color: colors.subtext,
  },
  appointmentBlock: {
    gap: 2,
  },
  appointmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  appointmentTime: {
    flexShrink: 1,
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.text,
  },
  countdown: {
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.primaryDim,
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.subtext,
    overflow: 'hidden',
  },
  countdownPast: {
    backgroundColor: colors.dangerDim,
    color: colors.danger,
  },

  // ── 약속 내기 ──
  badge: {
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.primaryDim,
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.subtext,
    overflow: 'hidden',
  },
  badgeStrong: {
    backgroundColor: colors.primary,
    color: colors.onPrimary,
  },
  balanceChip: {
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: colors.primaryDim,
    marginRight: spacing.xs,
  },
  balanceChipText: {
    fontSize: fontSize.sm,
    fontWeight: '800',
    color: colors.text,
  },
  noticeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.cardAlt,
  },
  noticeText: {
    flex: 1,
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.text,
    lineHeight: 20,
  },
  noticeLink: {
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  noticeLinkText: {
    fontSize: fontSize.xs,
    fontWeight: '800',
    color: colors.onPrimary,
  },
  moreLink: {
    alignSelf: 'center',
    paddingVertical: spacing.xs,
  },
  moreLinkText: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.subtext,
  },
  codeLink: {
    alignSelf: 'center',
    paddingVertical: spacing.xs,
  },
  codeLinkText: {
    fontSize: fontSize.sm,
    color: colors.subtext,
  },
  codeLinkStrong: {
    fontWeight: '800',
    color: colors.text,
  },
});
