import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

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
import { useSessions } from '@/state/SessionsContext';
import { confirmDialog } from '@/ui/dialogs';
import { useNow } from '@/ui/useNow';
import {
  Card,
  EmptyState,
  LoadingState,
  PrimaryButton,
  Screen,
} from '@/ui/components';
import { colors, fontSize, radius } from '@/ui/theme';

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
      {sessions.length === 0 ? (
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
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
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
});
