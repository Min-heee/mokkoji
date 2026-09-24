/**
 * 내 이름 바꾸기(URL '/late/name') — 마이 탭 '내 이름'의 [바꾸기]에서 온다.
 *
 * NicknameGate 와 같은 흐름을 쓴다: ensureReady(조용히 익명 로그인 + 프로필 조회) → ensureProfile(nickname).
 * 서버 lb_ensure_profile 은 프로필이 없으면 만들고(+1,000P) 있으면 이름만 바꾼다. 검증(1~12자)도 서버·가짜 서버가 한다.
 * 저장하면 뒤로 간다. 모드 off 면 안내만.
 */
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { START_BALANCE } from '@/domain/latePresets';
import { type LateBetError, REPEATED_FAILURE_MESSAGE, toLateBetError } from '@/lateBet/errors';
import { useLateBet } from '@/lateBet/LateBetContext';
import { LateBetUnavailable } from '@/lateBet/screens/NicknameGate';
import { EmptyState, LoadingState, PrimaryButton, Screen, TextField } from '@/ui/components';
import { colors, fontSize, spacing } from '@/ui/theme';

const NICKNAME_MAX = 12;

export default function LateNameScreen() {
  const { enabled } = useLateBet();
  if (!enabled) return <LateBetUnavailable />;
  return <NameInner />;
}

function NameInner() {
  const router = useRouter();
  const { profile, ensureReady, ensureProfile, failCount } = useLateBet();
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>(profile ? 'ready' : 'loading');
  const [loadError, setLoadError] = useState<LateBetError | null>(null);
  const [nickname, setNickname] = useState(profile?.nickname ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<LateBetError | null>(null);
  const savingRef = useRef(false);

  const start = useCallback(() => {
    setPhase('loading');
    setLoadError(null);
    ensureReady()
      .then((me) => {
        if (me) setNickname((cur) => (cur === '' ? me.nickname : cur));
        setPhase('ready');
      })
      .catch((e: unknown) => {
        setLoadError(toLateBetError(e));
        setPhase('error');
      });
  }, [ensureReady]);

  useEffect(() => {
    if (!profile) start();
    // 첫 진입 때 1회
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === 'loading') {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }
  if (phase === 'error') {
    return (
      <Screen footer={<PrimaryButton label="다시 시도" onPress={start} />}>
        <EmptyState
          title={loadError?.message ?? '잠시 후 다시 시도해 주세요.'}
          hint={failCount >= 3 ? REPEATED_FAILURE_MESSAGE : undefined}
        />
      </Screen>
    );
  }

  const creating = profile === null;
  const unchanged = !creating && nickname.trim() === profile.nickname;

  const submit = () => {
    if (savingRef.current) return;
    if (nickname.trim() === '' || unchanged) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    ensureProfile(nickname)
      .then(() => {
        if (router.canGoBack()) router.back();
        else router.replace('/my');
      })
      .catch((e: unknown) => {
        savingRef.current = false;
        setSaving(false);
        setSaveError(toLateBetError(e));
      });
  };

  return (
    <Screen scroll={false}>
      <View style={styles.box}>
        <Text style={styles.title}>친구들에게 보일 이름</Text>
        <Text style={styles.hint}>
          내가 약속을 만들면 친구들에게 이 이름으로 보여요. 친구가 만든 약속에서는 주최자가 적어 둔 이름을 골라 들어가요.
          {creating ? ` 이름을 정하면 ${START_BALANCE.toLocaleString('ko-KR')}P를 드려요. 포인트는 가상이고 돈으로 바꿀 수 없어요.` : ''}
        </Text>
        <TextField
          label={`이름 (1~${NICKNAME_MAX}자)`}
          value={nickname}
          onChangeText={setNickname}
          placeholder="예: 민병희"
          autoFocus
          onSubmitEditing={submit}
        />
        {saveError ? <Text style={styles.error}>{saveError.message}</Text> : null}
        <PrimaryButton
          label={creating ? '이름 정하기' : '저장'}
          onPress={submit}
          disabled={saving || nickname.trim() === '' || unchanged}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  box: { gap: spacing.md },
  title: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  hint: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  error: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text },
});
