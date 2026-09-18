/**
 * 위치 정하기 (설계서 §5.3-C). 담당: [create]
 *
 * P0: PlacePicker(프리셋 장소 + 위도/경도 직접 입력) + [이 위치로 정하기]. P1 에서 PlacePicker 가 지도로 바뀐다.
 * 약속 잡기(late/new) ↔ 이 화면 사이의 핀 전달은 라우트 파라미터가 아니라 src/ui/PlacePicker 의 모듈 메모리다
 * (openPlaceDraft → readPlaceDraft / setPlaceResult → takePlaceResult). 좌표를 URL 에 싣지 않는다.
 */
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { mapPinUrl } from '@/domain/mapRoute';
import { isInKorea } from '@/domain/tzGuard';
import { useLateBet } from '@/lateBet/LateBetContext';
import { openExternal } from '@/lateBet/screens/ConditionCard';
import { LateBetUnavailable } from '@/lateBet/screens/NicknameGate';
import { PrimaryButton, Screen } from '@/ui/components';
import { PlacePicker, readPlaceDraft, setPlaceResult, type PlacePickerValue } from '@/ui/PlacePicker';
import { colors, fontSize, spacing } from '@/ui/theme';

export default function LatePlaceScreen() {
  const { enabled } = useLateBet();
  if (!enabled) return <LateBetUnavailable />;
  return <Inner />;
}

function Inner() {
  const router = useRouter();
  // 들어올 때의 값을 한 번만 읽는다(이 화면이 떠 있는 동안 draft 는 바뀌지 않는다)
  const [initial] = useState(() => readPlaceDraft());
  const [value, setValue] = useState<PlacePickerValue | null>(initial.value);

  const confirm = () => {
    if (!value) return;
    setPlaceResult(value);
    // 새로고침 등으로 앞 화면이 없으면 약속 잡기로 돌아간다(폼은 비어 있다)
    if (router.canGoBack()) router.back();
    else router.replace('/late/new');
  };

  const openMap = () => {
    if (!value) return;
    const name = value.name || initial.placeName.trim() || '약속 장소';
    openExternal(mapPinUrl(name, value.lat, value.lng));
  };

  return (
    <Screen
      footer={
        <View style={styles.footer}>
          <PrimaryButton label="이 위치로 정하기" onPress={confirm} disabled={!value} />
          <PrimaryButton label="카카오맵에서 위치 확인" variant="ghost" onPress={openMap} disabled={!value} />
        </View>
      }
    >
      <Text style={styles.lead}>
        약속 장소의 위치를 정해 주세요. 이 위치에서 {initial.radiusM}m 안에 들어오면 도착으로 인정돼요.
      </Text>
      <PlacePicker value={value} radiusM={initial.radiusM} placeName={initial.placeName} onChange={setValue} />
      {value ? (
        <Text style={styles.help}>
          정하기 전에 카카오맵에서 위치가 맞는지 확인해 주세요. 장소는 시작한 뒤에도 바꿀 수 있어요.
          {isInKorea(value.lat, value.lng) ? '' : ' 한국 밖의 장소예요. 약속 시각이 어느 시간대인지 다음 화면에서 물어볼게요.'}
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  footer: { gap: spacing.sm },
  lead: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  help: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
});
