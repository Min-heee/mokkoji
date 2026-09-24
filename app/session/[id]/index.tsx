import * as Linking from 'expo-linking';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  EMPTY_APPOINTMENT,
  appointmentDirectionsUrl,
  appointmentInputHint,
  appointmentPlaceLabel,
  appointmentStatus,
  buildAppointment,
  formatAppointmentTime,
  formatCountdown,
  hasAppointment,
  parseAppointmentInput,
  pinAfterTextOnlyEdit,
  placeFormFromAppointment,
  toLocalInputValue,
  type PlaceFormState,
} from '@/domain/appointment';
import { formatMoney } from '@/domain/currency';
import type { Friend } from '@/domain/friends';
import { addFriendPerson, addNamedPerson } from '@/domain/people';
import { roundBaseTotal, roundFxFactor, roundTotal } from '@/domain/settlement';
import { formatKrw } from '@/domain/format';
import type { Appointment, Round } from '@/domain/types';
import { useFriends } from '@/state/FriendsContext';
import { useSessions } from '@/state/SessionsContext';
import { alertDialog, confirmDialog } from '@/ui/dialogs';
import { placePickerUsesMap } from '@/ui/PlacePicker';
import { SessionPlaceField, useSessionPlacePicker } from '@/ui/SessionPlaceField';
import { useNow } from '@/ui/useNow';
import {
  Card,
  Chip,
  EmptyState,
  LoadingState,
  PrimaryButton,
  Row,
  Screen,
  SectionTitle,
  TextField,
} from '@/ui/components';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

/** 약속 → 편집 입력 4종 ('YYYY-MM-DDTHH:mm'을 날짜/시간으로 쪼갠다, 장소는 이름+지도 핀) */
function appointmentFields(appointment: Appointment) {
  const local = toLocalInputValue(appointment.at);
  const [date = '', time = ''] = local ? local.split('T') : [];
  return {
    date,
    time,
    place: placeFormFromAppointment(appointment),
    note: appointment.placeNote,
  };
}

export default function SessionDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : params.id?.[0] ?? '';
  const router = useRouter();
  const { loading, getSession, updateSession, addRound } = useSessions();
  const { friends } = useFriends();

  // 훅은 early return보다 위에 있어야 하므로 세션 조회를 먼저 한다.
  // (getSession은 훅이 아니라 그냥 조회 함수다)
  const session = getSession(id);
  const appointment = session?.appointment ?? EMPTY_APPOINTMENT;

  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState(false);
  const [dateText, setDateText] = useState(() => appointmentFields(appointment).date);
  const [timeText, setTimeText] = useState(() => appointmentFields(appointment).time);
  const [place, setPlace] = useState<PlaceFormState>(() => appointmentFields(appointment).place);
  const [noteText, setNoteText] = useState(() => appointmentFields(appointment).note);
  const now = useNow();
  // 장소: 지도가 뜨는 기기면 지도 핀 + 이름, 아니면(웹·앱인토스·키 없는 안드로이드) 이름 글자만
  const [usesMap] = useState(() => placePickerUsesMap());
  const openPlaceMap = useSessionPlacePicker(setPlace);

  // 첫 렌더는 로딩 중이라 초기값이 비어 있을 수 있다.
  // 편집을 열 때·취소할 때 항상 현재 약속에서 다시 채운다
  const seedAppointmentFields = (a: Appointment) => {
    const fields = appointmentFields(a);
    setDateText(fields.date);
    setTimeText(fields.time);
    setPlace(fields.place);
    setNoteText(fields.note);
  };

  if (loading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  if (!session) {
    return (
      <Screen>
        <EmptyState title="모임을 찾을 수 없어요" />
      </Screen>
    );
  }

  const nameOf = (personId: string) =>
    session.people.find((p) => p.id === personId)?.name ?? '?';

  const grandTotal = session.rounds.reduce(
    (sum, r) => sum + roundBaseTotal(r),
    0,
  );

  // 이름이 아니라 friendId로만 거른다 — 새 모임 화면처럼
  // 이름이 같아도 다른 친구면 추가할 수 있어야 한다
  const linkedFriendIds = new Set(
    session.people.map((p) => p.friendId).filter((v): v is string => !!v),
  );
  const availableFriends = friends.filter((f) => !linkedFriendIds.has(f.id));

  const handleAddFriendPerson = (friend: Friend) => {
    // 중복 가드는 업데이터 안(addFriendPerson)에 있어 더블탭에도 안전하다
    updateSession(session.id, (s) => addFriendPerson(s, friend));
  };

  const handleAddPerson = () => {
    const name = newName.trim();
    if (!name) return;
    if (session.people.some((p) => p.name === name)) {
      // 조용히 입력만 지우면 추가된 것처럼 보이므로 명시적으로 알린다
      alertDialog(
        '같은 이름이 있어요',
        `'${name}' 참가자가 이미 있어요. 다른 사람이라면 구분되는 이름(예: ${name}2)으로 추가해 주세요.`,
      );
      return;
    }
    // 중복 가드는 업데이터 안(addNamedPerson)에도 있어 이중 submit에 안전하다
    updateSession(session.id, (s) => addNamedPerson(s, name));
    setNewName('');
  };

  const handleAddRound = () => {
    const round = addRound(session.id);
    if (round) {
      router.push(`/session/${session.id}/round/${round.id}`);
    }
  };

  const handleDeleteRound = (round: Round) => {
    confirmDialog(
      '차수 삭제',
      `'${round.title}' 차수를 삭제할까요?`,
      () =>
        updateSession(session.id, (s) => ({
          ...s,
          rounds: s.rounds.filter((r) => r.id !== round.id),
        })),
      { confirmText: '삭제', destructive: true },
    );
  };

  const cancelRoundBet = (round: Round) => {
    updateSession(session.id, (s) => ({
      ...s,
      rounds: s.rounds.map((r) => (r.id === round.id ? { ...r, bet: null } : r)),
    }));
  };

  const cancelSessionBet = () =>
    updateSession(session.id, (s) => ({ ...s, bet: null }));

  const openAppointmentEditor = () => {
    seedAppointmentFields(appointment);
    setEditing(true);
  };

  const cancelAppointmentEdit = () => {
    seedAppointmentFields(appointment);
    setEditing(false);
  };

  const saveAppointment = () => {
    const parsed = parseAppointmentInput(dateText, timeText);
    // 시간 미정으로 두려면 날짜·시간을 둘 다 비우면 된다('empty').
    // 한쪽만 적었거나 형식이 틀렸으면, 적어둔 날짜까지 조용히 지워지지 않게 막는다
    if (parsed.status === 'incomplete' || parsed.status === 'invalid') {
      alertDialog(
        parsed.status === 'incomplete'
          ? '날짜와 시간 중 한 칸이 비었어요'
          : '날짜·시간 형식을 확인해주세요',
        appointmentInputHint(parsed.status),
      );
      return;
    }

    // 지도가 없는 기기에선 핀을 고칠 수 없다 — 이름이 그대로면 다른 기기에서 정한 핀을 지키고, 바뀌면 버린다
    const pin = usesMap ? place.pin : pinAfterTextOnlyEdit(appointment, place.name);
    updateSession(session.id, (s) => ({
      ...s,
      appointment: buildAppointment({ at: parsed.at, placeName: place.name, pin, placeNote: noteText }),
    }));
    setEditing(false);
  };

  const openMap = () => {
    // 핀이 있으면 좌표 길찾기, 없으면 이름 검색
    const url = appointmentDirectionsUrl(appointment);
    if (!url) return;
    if (Platform.OS === 'web') {
      // 웹(앱인토스 웹뷰)에서 Linking.openURL은 같은 탭을 통째로 갈아치워
      // 미니앱이 지도로 대체돼 버린다. 새 탭으로 열고, 막히면 알린다
      // (이 경로에선 openURL이 절대 reject하지 않아 .catch가 안 걸린다)
      const opened = window.open(url, '_blank', 'noopener');
      if (!opened) alertDialog('지도를 열 수 없어요');
      return;
    }
    Linking.openURL(url).catch(() => alertDialog('지도를 열 수 없어요'));
  };

  // 이름 없이 핀만 있으면 '지도에서 정한 장소'
  const placeName = appointmentPlaceLabel(appointment);
  const isPastAppointment = appointmentStatus(appointment, now) === 'past';

  return (
    <Screen
      footer={
        <PrimaryButton
          label="정산하기"
          disabled={session.rounds.length === 0}
          onPress={() => router.push(`/session/${session.id}/result`)}
        />
      }
    >
      <Stack.Screen options={{ title: session.title }} />

      <SectionTitle>약속</SectionTitle>
      <Card>
        {editing ? (
          <>
            <TextField
              label="날짜"
              value={dateText}
              onChangeText={setDateText}
              placeholder="2026-08-03"
            />
            <TextField
              label="시간"
              value={timeText}
              onChangeText={setTimeText}
              placeholder="19:30"
            />
            <SessionPlaceField value={place} onChange={setPlace} onOpenMap={openPlaceMap} usesMap={usesMap} />
            <TextField
              label="장소 메모 (선택)"
              value={noteText}
              onChangeText={setNoteText}
              placeholder="예: 2번 출구에서 도보 3분"
            />
            <Row>
              <View style={styles.apptEditButton}>
                <PrimaryButton label="저장" onPress={saveAppointment} />
              </View>
              <View style={styles.apptEditButton}>
                <PrimaryButton
                  label="취소"
                  variant="ghost"
                  onPress={cancelAppointmentEdit}
                />
              </View>
            </Row>
          </>
        ) : hasAppointment(appointment) ? (
          <>
            {appointment.at ? (
              <View style={styles.apptTimeRow}>
                <Text style={styles.apptTime}>
                  {formatAppointmentTime(appointment.at)}
                </Text>
                <Text
                  style={[styles.apptPill, isPastAppointment && styles.apptPillPast]}
                >
                  {formatCountdown(appointment.at, now)}
                </Text>
              </View>
            ) : (
              <Text style={styles.apptMuted}>시간 미정</Text>
            )}

            {placeName ? (
              <Text style={styles.apptPlace}>{placeName}</Text>
            ) : (
              <Text style={styles.apptMuted}>장소 미정</Text>
            )}
            {appointment.placeNote.trim() ? (
              <Text style={styles.apptNote}>{appointment.placeNote.trim()}</Text>
            ) : null}

            <Row>
              <PrimaryButton
                label="약속 수정"
                variant="ghost"
                onPress={openAppointmentEditor}
              />
              {placeName ? (
                <PrimaryButton label="길찾기" variant="ghost" onPress={openMap} />
              ) : null}
            </Row>
          </>
        ) : (
          <>
            <Text style={styles.apptMuted}>아직 약속이 정해지지 않았어요</Text>
            <PrimaryButton
              label="약속 정하기"
              variant="ghost"
              onPress={openAppointmentEditor}
            />
          </>
        )}
      </Card>

      <SectionTitle>참가자</SectionTitle>
      <Card>
        <Row>
          {session.people.map((person) => (
            <Chip key={person.id} label={person.name} selected={false} />
          ))}
        </Row>
        {availableFriends.length > 0 && (
          <>
            <Text style={styles.friendPickLabel}>친구에서 추가</Text>
            <Row>
              {availableFriends.map((friend) => (
                <Chip
                  key={friend.id}
                  label={friend.name}
                  selected={false}
                  onPress={() => handleAddFriendPerson(friend)}
                />
              ))}
            </Row>
          </>
        )}
        <TextField
          label="이름"
          value={newName}
          onChangeText={setNewName}
          placeholder="새 참가자 이름"
          onSubmitEditing={handleAddPerson}
          keepFocusOnSubmit
        />
        <PrimaryButton label="추가" variant="ghost" onPress={handleAddPerson} />
      </Card>

      <SectionTitle>차수</SectionTitle>
      {session.rounds.length === 0 ? (
        <EmptyState
                    title="차수를 추가해보세요"
          hint="1차 카페, 2차 밥, 3차 술, 숙소, 교통..."
        />
      ) : (
        session.rounds.map((round) => (
          <Card
            key={round.id}
            onPress={() => router.push(`/session/${session.id}/round/${round.id}`)}
            onLongPress={() => handleDeleteRound(round)}
          >
            <View style={styles.roundRow}>
              <View style={styles.roundInfo}>
                <Text style={styles.roundTitle}>{round.title}</Text>
                <Text style={styles.roundSubtitle}>
                  결제 {nameOf(round.payerId)} ·{' '}
                  {round.mode === 'even' ? '균등 정산' : '항목별'}
                </Text>
              </View>
              {(round.currency || 'KRW') === 'KRW' ? (
                <Text style={styles.roundAmount}>
                  {formatKrw(roundBaseTotal(round))}
                </Text>
              ) : (
                <View style={styles.roundAmountCol}>
                  <Text style={styles.roundAmount}>
                    {formatMoney(roundTotal(round), round.currency)}
                  </Text>
                  {roundFxFactor(round) == null ? (
                    <Text style={styles.fxMissing}>환율 필요</Text>
                  ) : (
                    <Text style={styles.fxConverted}>
                      ≈ {formatKrw(roundBaseTotal(round))}
                    </Text>
                  )}
                </View>
              )}
            </View>

            <View style={styles.betRow}>
              {round.bet ? (
                <View style={styles.betBadgeWrap}>
                  <Text style={styles.betBadge}>
                    {nameOf(round.bet.loserId)} 몰빵
                  </Text>
                  <Text style={styles.betCancel} onPress={() => cancelRoundBet(round)}>
                    취소
                  </Text>
                </View>
              ) : (
                <View />
              )}
              <Pressable
                onPress={() =>
                  router.push(`/session/${session.id}/round/${round.id}/bet`)
                }
                style={({ pressed }) => [styles.betPill, pressed && { opacity: 0.6 }]}
              >
                <Text style={styles.betPillText}>
                  {round.bet ? '내기 다시' : '내기'}
                </Text>
              </Pressable>
            </View>
          </Card>
        ))
      )}
      <PrimaryButton label="+ 차수 추가" variant="ghost" onPress={handleAddRound} />

      <SectionTitle>모임 내기</SectionTitle>
      <Card>
        {session.bet ? (
          <View style={styles.sessionBetRow}>
            <View style={styles.betBadgeWrap}>
              <Text style={styles.betBadge}>
                {nameOf(session.bet.loserId)} 몰빵 · {formatKrw(session.bet.amount)}
              </Text>
              <Text style={styles.betCancel} onPress={cancelSessionBet}>
                취소
              </Text>
            </View>
            <Pressable
              onPress={() => router.push(`/session/${session.id}/bet`)}
              style={({ pressed }) => [styles.betPill, pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.betPillText}>다시</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => router.push(`/session/${session.id}/bet`)}
            style={({ pressed }) => [
              styles.betPill,
              { alignSelf: 'flex-start' },
              pressed && { opacity: 0.6 },
            ]}
          >
            <Text style={styles.betPillText}>모임 전체 내기</Text>
          </Pressable>
        )}
        <Text style={styles.roundSubtitle}>진 사람이 오늘 전체 중 정한 금액을 몰빵해요</Text>
      </Card>

      <Card>
        <Text style={styles.totalLabel}>총 지출</Text>
        <Text style={styles.totalAmount}>{formatKrw(grandTotal)}</Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  apptTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  apptTime: {
    fontSize: fontSize.lg,
    fontWeight: '800',
    color: colors.text,
    flexShrink: 1,
  },
  apptPill: {
    fontSize: fontSize.xs,
    fontWeight: '800',
    color: colors.text,
    backgroundColor: colors.primaryDim,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 10,
    overflow: 'hidden',
  },
  apptPillPast: {
    color: colors.danger,
    backgroundColor: colors.dangerDim,
  },
  apptPlace: {
    fontSize: fontSize.md,
    color: colors.text,
  },
  apptNote: {
    fontSize: fontSize.sm,
    color: colors.subtext,
  },
  apptMuted: {
    fontSize: fontSize.sm,
    color: colors.subtext,
  },
  apptEditButton: {
    flex: 1,
  },
  friendPickLabel: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.subtext,
    marginTop: spacing.sm,
  },
  roundRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  roundInfo: {
    flex: 1,
    gap: spacing.xs,
  },
  roundTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
  },
  roundSubtitle: {
    fontSize: fontSize.sm,
    color: colors.subtext,
  },
  roundAmount: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
  },
  roundAmountCol: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  betRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  sessionBetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  betBadgeWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 1,
  },
  betBadge: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.text,
  },
  betCancel: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.danger,
  },
  betPill: {
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.text,
  },
  betPillText: {
    fontSize: fontSize.sm,
    fontWeight: '800',
    color: colors.text,
  },
  fxMissing: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    color: colors.danger,
  },
  fxConverted: {
    fontSize: fontSize.xs,
    color: colors.subtext,
  },
  totalLabel: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.subtext,
  },
  totalAmount: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.text,
  },
});
