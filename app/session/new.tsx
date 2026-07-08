import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { SessionType } from '@/domain/types';
import { useSessions } from '@/state/SessionsContext';
import {
  Chip,
  PrimaryButton,
  Row,
  Screen,
  SectionTitle,
  TextField,
} from '@/ui/components';
import { colors, fontSize } from '@/ui/theme';

export default function NewSessionScreen() {
  const router = useRouter();
  const { createSession } = useSessions();

  const [type, setType] = useState<SessionType>('moim');
  const [title, setTitle] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [names, setNames] = useState<string[]>([]);

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

  const create = () => {
    const session = createSession(title, effectiveNames, type);
    router.replace('/session/' + session.id);
  };

  const isTravel = type === 'travel';

  return (
    <Screen
      footer={
        <PrimaryButton
          label="모임 만들기"
          onPress={create}
          disabled={effectiveNames.length < 2}
        />
      }
    >
      <SectionTitle>어떤 정산인가요?</SectionTitle>
      <Row>
        <Chip
          label="🍻 모임"
          selected={type === 'moim'}
          onPress={() => setType('moim')}
        />
        <Chip
          label="✈️ 여행"
          selected={type === 'travel'}
          onPress={() => setType('travel')}
        />
      </Row>

      <TextField
        label={isTravel ? '여행 이름' : '모임 이름'}
        value={title}
        onChangeText={setTitle}
        placeholder={isTravel ? '예: 오사카 여행' : '예: 금요일 회식'}
        autoFocus
      />

      <SectionTitle>참가자</SectionTitle>
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
});
