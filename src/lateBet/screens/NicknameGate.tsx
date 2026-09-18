/**
 * 약속 기능 진입 관문 — 담당: [foundation] (완성본. 화면 담당은 감싸서 쓰기만 한다).
 *
 *   <NicknameGate>{...프로필이 있어야 하는 화면...}</NicknameGate>
 *
 * 하는 일: (1) 모드가 off 면 안내만 그린다 (2) ensureReady: 조용히 익명 로그인 + ping + 프로필 조회
 * (3) 프로필이 없으면 닉네임 1칸을 받아 ensureProfile(+1,000P) (4) 그 뒤 children.
 *
 * 프로필 닉네임의 역할(오너 결정 변경 1, 초대 명단 방식):
 * - 내가 약속을 만들 때 친구들에게 보이는 이름이다(주최자는 명단에 없고 자동 참가 → 참가자 행의 닉네임 = 프로필 닉네임).
 * - 친구 약속에 들어갈 때는 쓰이지 않는다. 주최자가 적어 둔 명단에서 내 이름을 고르면 그 이름이 그 약속의 닉네임이 된다.
 *   그래서 초대 참여 화면(app/j/[code])은 이 관문으로 감싸지 않고 useLateBet().ensureReady → (프로필이 없으면 고른 명단 이름으로
 *   ensureProfile) → api.claimSlot 을 직접 부른다. 프로필이 이미 있으면 전역 이름은 건드리지 않는다.
 * - 쓰는 곳: app/late/new(약속 잡기), app/late/points(포인트).
 * - 버튼 라벨은 '이름 정하기' — '시작하기'는 대기실에서 주최자가 약속을 시작하는 버튼의 이름이라 여기서는 쓰지 않는다.
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
    <Screen footer={<PrimaryButton label="이름 정하기" onPress={submit} disabled={saving || nickname.trim() === ''} />}>
      <View style={styles.box}>
        <Text style={styles.title}>친구들에게 보일 이름을 정해 주세요</Text>
        <Text style={styles.hint}>
          내가 약속을 만들면 친구들에게 이 이름으로 보여요. 친구가 만든 약속에서는 주최자가 적어 둔 이름을 골라 들어가요. 이름을 정하면{' '}
          {START_BALANCE.toLocaleString('ko-KR')}P를 드려요. 포인트는 가상이고 돈으로 바꿀 수 없어요.
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
