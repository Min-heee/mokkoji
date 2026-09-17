/**
 * 약속 기능 진입 관문 — 담당: [foundation] (완성본. 화면 담당은 감싸서 쓰기만 한다).
 *
 *   <NicknameGate>{...프로필이 있어야 하는 화면...}</NicknameGate>
 *
 * 하는 일: (1) 모드가 off 면 안내만 그린다 (2) ensureReady: 조용히 익명 로그인 + ping + 프로필 조회
 * (3) 프로필이 없으면 닉네임 1칸을 받아 ensureProfile(+1,000P) (4) 그 뒤 children.
 * 초대 참여 화면(app/j/[code])은 자기 닉네임 칸이 있으므로 이 관문 대신 useLateBet().ensureReady / ensureProfile 을 직접 쓴다.
 */
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { START_BALANCE } from '@/domain/latePresets';
import { EmptyState, LoadingState, PrimaryButton, Screen, TextField } from '@/ui/components';
import { colors, fontSize, spacing } from '@/ui/theme';

import { LateBetError, REPEATED_FAILURE_MESSAGE, toLateBetError } from '../errors';
import { useLateBet } from '../LateBetContext';

/** 모드 off(또는 이 버전에서 못 쓰는 기능)일 때의 안내 화면 */
export function LateBetUnavailable() {
  const router = useRouter();
  return (
    <Screen footer={<PrimaryButton label="홈으로" onPress={() => router.replace('/')} />}>
      <EmptyState title="이 버전에서는 약속 기능을 쓸 수 없어요" hint="앱을 최신 버전으로 업데이트해 주세요." />
    </Screen>
  );
}

export function NicknameGate({ children }: { children: React.ReactNode }) {
  const { enabled, profile, ensureReady, ensureProfile, failCount } = useLateBet();
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>(profile ? 'ready' : 'loading');
  const [error, setError] = useState<LateBetError | null>(null);
  const [nickname, setNickname] = useState('');
  const [saving, setSaving] = useState(false);

  const start = useCallback(() => {
    setPhase('loading');
    setError(null);
    ensureReady()
      .then(() => setPhase('ready'))
      .catch((e: unknown) => {
        setError(toLateBetError(e));
        setPhase('error');
      });
  }, [ensureReady]);

  useEffect(() => {
    if (enabled && !profile) start();
    // 첫 진입 때 1회
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  if (!enabled) return <LateBetUnavailable />;
  if (profile) return <>{children}</>;
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
        <EmptyState title={error?.message ?? '잠시 후 다시 시도해 주세요.'} hint={failCount >= 3 ? REPEATED_FAILURE_MESSAGE : undefined} />
      </Screen>
    );
  }

  const submit = () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    ensureProfile(nickname)
      .catch((e: unknown) => setError(toLateBetError(e)))
      .finally(() => setSaving(false));
  };

  return (
    <Screen footer={<PrimaryButton label="시작하기" onPress={submit} disabled={saving || nickname.trim() === ''} />}>
      <View style={styles.box}>
        <Text style={styles.title}>친구들에게 보일 이름을 정해 주세요</Text>
        <Text style={styles.hint}>
          약속마다 바꿀 수 있어요. 시작하면 {START_BALANCE.toLocaleString('ko-KR')}P를 드려요. 포인트는 가상이고 돈으로 바꿀 수 없어요.
        </Text>
        <TextField label="이름 (1~12자)" value={nickname} onChangeText={setNickname} placeholder="예: 민병희" autoFocus onSubmitEditing={submit} />
        {error ? <Text style={styles.error}>{error.message}</Text> : null}
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
