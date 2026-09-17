/**
 * 약속 잡기 (설계서 §5.3-B). 쿼리: ?edit=<약속 id>(혼자일 때 수정) · ?from=<약속 id>(취소 후 재생성 프리필). NicknameGate 로 감싼다.
 * 담당: [create] — 라우트가 존재하도록 만든 빈 골격이다. 내용은 담당이 채운다.
 */
import React from 'react';

import { useLateBet } from '@/lateBet/LateBetContext';
import { LateBetUnavailable } from '@/lateBet/screens/NicknameGate';
import { EmptyState, Screen } from '@/ui/components';

export default function NewLateAppointmentScreen() {
  const { enabled } = useLateBet();
  if (!enabled) return <LateBetUnavailable />;
  return (
    <Screen>
      <EmptyState title="준비 중인 화면이에요" />
    </Screen>
  );
}
