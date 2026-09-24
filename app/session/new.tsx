import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  appointmentInputHint,
  buildAppointment,
  EMPTY_PLACE_FORM,
  formatAppointmentTime,
  formatCountdown,
  parseAppointmentInput,
  type PlaceFormState,
} from '@/domain/appointment';
import { useFriends } from '@/state/FriendsContext';
import { useSessions, type NewPersonInput } from '@/state/SessionsContext';
import {
  Chip,
  PrimaryButton,
  Row,
  Screen,
  SectionTitle,
  TextField,
} from '@/ui/components';
import { placePickerUsesMap } from '@/ui/PlacePicker';
import { SessionPlaceField, useSessionPlacePicker } from '@/ui/SessionPlaceField';
import { colors, fontSize } from '@/ui/theme';

export default function NewSessionScreen() {
  const router = useRouter();
  const { createSession } = useSessions();
  const { friends } = useFriends();

  const [title, setTitle] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [names, setNames] = useState<string[]>([]);
  const [selectedFriendIds, setSelectedFriendIds] = useState<string[]>([]);
  const [dateText, setDateText] = useState('');
  const [timeText, setTimeText] = useState('');
  // 장소: 지도가 뜨는 기기면 지도 핀 + 이름, 아니면(웹·앱인토스·키 없는 안드로이드) 이름 글자만
  const [place, setPlace] = useState<PlaceFormState>(EMPTY_PLACE_FORM);
  const [usesMap] = useState(() => placePickerUsesMap());
  const openPlaceMap = useSessionPlacePicker(setPlace);

  const toggleFriend = (id: string) => {
    setSelectedFriendIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const addName = () => {
    const name = nameInput.trim();
    if (!name) return;
    if (names.includes(name)) {
      setNameInput('');
      return;
    }
    setNames((prev) => [...prev, name]);
    setNameInput('');
  };

  const removeName = (name: string) => {
    setNames((prev) => prev.filter((n) => n !== name));
  };

  // 입력만 하고 '추가'를 안 누른 이름도 버리지 않고 포함한다
  const pendingName = nameInput.trim();
  const effectiveNames =
    pendingName && !names.includes(pendingName) ? [...names, pendingName] : names;

  // 친구 선택분(friendId 연결) + 직접 입력분. 이름이 겹쳐도 다른 사람일 수 있으니 그대로 둔다
  const effectivePeople: NewPersonInput[] = [
    ...friends
      .filter((f) => selectedFriendIds.includes(f.id))
      .map((f) => ({ name: f.name, friendId: f.id })),
    ...effectiveNames.map((name) => ({ name })),
  ];

  const parsed = parseAppointmentInput(dateText, timeText);
  const at = parsed.at;
  // 적어놓은 시각이 조용히 버려지지 않게, 만들기 버튼까지 막는다
  const timeInvalid = parsed.status === 'incomplete' || parsed.status === 'invalid';

  const create = () => {
    if (timeInvalid) return;
    const session = createSession(
      title,
      effectivePeople,
      buildAppointment({ at, placeName: place.name, pin: usesMap ? place.pin : null }),
    );
    router.replace('/session/' + session.id);
  };

  return (
    <Screen
      footer={
        <PrimaryButton
          label="모임 만들기"
          onPress={create}
          disabled={effectivePeople.length < 2 || timeInvalid}
        />
      }
    >
      <TextField
        label="모임 이름"
        value={title}
        onChangeText={setTitle}
        placeholder="예: 금요일 회식 · 오사카 여행"
        autoFocus
      />

      <SectionTitle>약속 (선택)</SectionTitle>

      <Row>
        <View style={styles.dateField}>
          <TextField
            label="날짜"
            value={dateText}
            onChangeText={setDateText}
            placeholder="2026-08-03"
          />
        </View>
        <View style={styles.timeField}>
          <TextField
            label="시간"
            value={timeText}
            onChangeText={setTimeText}
            placeholder="19:30"
          />
        </View>
      </Row>

      <SessionPlaceField value={place} onChange={setPlace} onOpenMap={openPlaceMap} usesMap={usesMap} />

      {at ? (
        <Text style={styles.help}>
          {formatAppointmentTime(at) + ' · ' + formatCountdown(at, Date.now())}
        </Text>
      ) : timeInvalid ? (
        <Text style={styles.hintDanger}>{appointmentInputHint(parsed.status)}</Text>
      ) : (
        <Text style={styles.help}>나중에 모임 화면에서 정해도 돼요</Text>
      )}

      <SectionTitle>참가자</SectionTitle>

      {friends.length > 0 ? (
        <>
          <SectionTitle>친구에서 추가</SectionTitle>
          <Row>
            {friends.map((f) => (
              <Chip
                key={f.id}
                label={f.name}
                selected={selectedFriendIds.includes(f.id)}
                onPress={() => toggleFriend(f.id)}
              />
            ))}
          </Row>
        </>
      ) : null}

      <Row>
        <View style={styles.nameField}>
          <TextField
            label="참가자 이름"
            value={nameInput}
            onChangeText={setNameInput}
            placeholder="이름을 입력해주세요"
            onSubmitEditing={addName}
            keepFocusOnSubmit
          />
        </View>
        <View style={styles.addButton}>
          <PrimaryButton label="추가" variant="ghost" onPress={addName} />
        </View>
      </Row>

      {names.length > 0 ? (
        <Row>
          {names.map((name) => (
            <Chip
              key={name}
              label={name}
              selected
              onPress={() => removeName(name)}
            />
          ))}
        </Row>
      ) : null}

      <Text style={styles.help}>참가자는 2명 이상 필요해요</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  nameField: {
    flex: 1,
  },
  addButton: {
    alignSelf: 'flex-end',
  },
  help: {
    fontSize: fontSize.sm,
    color: colors.subtext,
  },
  dateField: {
    flex: 3,
  },
  timeField: {
    flex: 2,
  },
  hintDanger: {
    fontSize: fontSize.sm,
    color: colors.danger,
  },
});
