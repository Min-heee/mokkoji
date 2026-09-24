/**
 * 친구 추가(URL '/friends/add') — 친구 탭 헤더의 '친구 추가'에서 온다. iOS 는 모달로 뜬다(app/_layout).
 *
 * - 이름 1~FRIEND_NAME_MAX 자(검증은 domain/friends.checkFriendName, FriendsContext.addFriend 와 같은 규칙).
 *   입력칸 maxLength 는 UTF-16 단위라 FRIEND_NAME_INPUT_MAX(넉넉히)로 두고, 넘치면 '20자까지' 안내 + [추가] 비활성.
 * - iOS 모달의 [취소]는 app/_layout 의 headerLeft.
 *   같은 이름은 막지 않는다(기존 규칙).
 * - [추가] 또는 키보드 제출 → 추가하고 뒤로. 더블탭·제출+탭이 겹쳐도 한 번만 추가한다(submittedRef).
 * - 버튼은 입력칸 바로 아래 본문에 둔다 — iOS 모달 시트에서도 키보드에 가리지 않게.
 */
import { useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { checkFriendName, FRIEND_NAME_INPUT_MAX, FRIEND_NAME_MAX } from '@/domain/friends';
import { useFriends } from '@/state/FriendsContext';
import { PrimaryButton, Screen, TextField } from '@/ui/components';
import { colors, fontSize, spacing } from '@/ui/theme';

export default function AddFriendScreen() {
  const router = useRouter();
  const { addFriend } = useFriends();
  const [name, setName] = useState('');
  const [done, setDone] = useState(false);
  const submittedRef = useRef(false);

  const checked = checkFriendName(name);

  const submit = () => {
    if (submittedRef.current) return;
    if (!checkFriendName(name).ok) return;
    const added = addFriend(name);
    if (!added) return;
    submittedRef.current = true;
    setDone(true);
    if (router.canGoBack()) router.back();
    else router.replace('/friends');
  };

  return (
    <Screen scroll={false}>
      <View style={styles.box}>
        <TextField
          label={`이름 (1~${FRIEND_NAME_MAX}자)`}
          value={name}
          onChangeText={setName}
          placeholder="친구 이름"
          autoFocus
          maxLength={FRIEND_NAME_INPUT_MAX}
          onSubmitEditing={submit}
        />
        {!checked.ok && checked.reason === 'tooLong' ? (
          <Text style={styles.error}>이름은 {FRIEND_NAME_MAX}자까지 쓸 수 있어요</Text>
        ) : null}
        <PrimaryButton label="추가" onPress={submit} disabled={done || !checked.ok} />
        <Text style={styles.hint}>친구를 넣어 두면 모임에 빠르게 넣고 주고받을 돈을 기록할 수 있어요</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  box: {
    gap: spacing.md,
  },
  error: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.text,
  },
  hint: {
    fontSize: fontSize.sm,
    color: colors.subtext,
    lineHeight: 20,
  },
});
