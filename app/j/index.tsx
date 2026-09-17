/**
 * 초대 코드 직접 입력 (설계서 §5.3-A, §7). 담당: [join]
 *
 * - 클립보드는 자동으로 읽지 않는다. [초대 코드 붙여넣기]를 눌렀을 때만 읽는다.
 * - 코드 하나만이 아니라 링크·공유 문구를 통째로 붙여넣어도 invite.parseInviteUrl 이 코드를 꺼낸다.
 * - 정규식(CODE_RE)을 통과한 값만 /j/CODE 로 넘긴다. 이 화면은 서버를 부르지 않는다(익명 로그인도 하지 않는다).
 * - /j/CODE 로는 replace 로 간다 → 스택이 홈 → 참여 화면으로 납작하게 유지된다. 참여 화면의 [코드 다시 입력]은 /j?c=… 로 되돌아온다.
 */
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { CODE_LENGTH, normalizeCode, parseInviteUrl, sanitizeCodeInput } from '@/domain/invite';
import { useLateBet } from '@/lateBet/LateBetContext';
import { FakeDevPanel } from '@/lateBet/screens/FakeDevPanel';
import { LateBetUnavailable } from '@/lateBet/screens/NicknameGate';
import { PrimaryButton, Screen, TextField } from '@/ui/components';
import { colors, fontSize, spacing } from '@/ui/theme';

export default function EnterInviteCodeScreen() {
  const { enabled } = useLateBet();
  if (!enabled) return <LateBetUnavailable />;
  return <Inner />;
}

function Inner() {
  const router = useRouter();
  const params = useLocalSearchParams<{ c?: string }>();
  // 참여 화면에서 [코드 다시 입력]으로 돌아온 경우 그 코드를 채워 둔다
  const [text, setText] = useState(() => sanitizeCodeInput(typeof params.c === 'string' ? params.c : ''));
  const [note, setNote] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);

  const code = normalizeCode(text);

  const onChange = (raw: string) => {
    setNote(null);
    // 8자를 넘게 들어오면 링크·공유 문구를 통째로 붙여넣은 것일 수 있다
    const found = raw.length > CODE_LENGTH ? parseInviteUrl(raw) : null;
    setText(found ?? sanitizeCodeInput(raw));
  };

  const paste = async () => {
    if (pasting) return;
    setPasting(true);
    try {
      const clip = await Clipboard.getStringAsync();
      const found = parseInviteUrl(clip);
      if (found) {
        setText(found);
        setNote(null);
      } else {
        setNote(
          clip.trim() === ''
            ? '복사해 둔 내용이 없어요. 초대 코드를 직접 적어주세요.'
            : '붙여넣은 내용에서 초대 코드를 찾지 못했어요. 코드를 직접 적어주세요.',
        );
      }
    } catch {
      // 웹에서 클립보드 권한을 거부한 경우 등
      setNote('클립보드를 읽을 수 없어요. 초대 코드를 직접 적어주세요.');
    } finally {
      setPasting(false);
    }
  };

  const go = () => {
    if (!code) return;
    router.replace('/j/' + code);
  };

  return (
    <View style={styles.fill}>
      <FakeDevPanel />
      <Screen footer={<PrimaryButton label="약속 확인하기" onPress={go} disabled={!code} />}>
        <Text style={styles.title}>받은 초대 코드를 적어주세요</Text>
        <Text style={styles.help}>
          친구가 보낸 메시지에 있는 8자 코드예요. 링크나 메시지를 통째로 붙여넣어도 돼요.
        </Text>
        <TextField
          label={`초대 코드 (${CODE_LENGTH}자)`}
          value={text}
          onChangeText={onChange}
          placeholder="예: UB7NPZT7"
          autoFocus
          onSubmitEditing={go}
        />
        <PrimaryButton label="초대 코드 붙여넣기" variant="ghost" onPress={() => void paste()} disabled={pasting} />
        {note ? <Text style={styles.note}>{note}</Text> : null}
        <Text style={styles.help}>헷갈리기 쉬운 글자(숫자 0·1, 영문 I·L·O)는 코드에 쓰지 않아요.</Text>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  title: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  help: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  note: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text, lineHeight: 20, marginTop: spacing.xs },
});
