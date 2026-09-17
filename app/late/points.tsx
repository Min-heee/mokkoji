/**
 * 포인트 화면 (설계서 §5.3-H): 잔액 + 원장(api.listLedger) + 계정 유실 고지. NicknameGate 로 감싼다.
 * 담당: [result] — 라우트가 존재하도록 만든 빈 골격이다. 내용은 담당이 채운다.
 */
import React from 'react';

import { useLateBet } from '@/lateBet/LateBetContext';
import { LateBetUnavailable } from '@/lateBet/screens/NicknameGate';
import { EmptyState, Screen } from '@/ui/components';

export default function LatePointsScreen() {
  const { enabled } = useLateBet();
  if (!enabled) return <LateBetUnavailable />;
  return (
    <Screen>
      <EmptyState title="준비 중인 화면이에요" />
    </Screen>
  );
}
