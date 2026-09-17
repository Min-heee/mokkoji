// 임시 검증용([live] 담당) — 끝나면 지운다
import { useRouter } from 'expo-router';
import React from 'react';
import { Text } from 'react-native';

import { presetPolicy } from '@/domain/latePresets';
import { msToLocalAt } from '@/domain/tzGuard';
import { useLateBet } from '@/lateBet/LateBetContext';
import { serverNow } from '@/lateBet/serverClock';
import { PrimaryButton, Screen } from '@/ui/components';

export default function Harness() {
  const router = useRouter();
  const { ensureReady, ensureProfile, api } = useLateBet();
  const [msg, setMsg] = React.useState('');
  const go = async (mins: number) => {
    try {
      const p = await ensureReady();
      if (!p) await ensureProfile('민병희');
      const a = await api.createAppointment({
        title: '금요일 곱창',
        localAt: msToLocalAt(serverNow() + mins * 60_000, 'Asia/Seoul'),
        tz: 'Asia/Seoul',
        placeName: '강남역 2번 출구 곱창',
        placeNote: '',
        lat: 37.4979,
        lng: 127.0276,
        policy: presetPolicy('normal'),
        consent: true,
      });
      router.replace(`/late/${a.id}`);
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  };
  return (
    <Screen>
      <PrimaryButton label="3시간 뒤 약속 만들기" onPress={() => void go(180)} />
      <Text>{msg}</Text>
    </Screen>
  );
}
