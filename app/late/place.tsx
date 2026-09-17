/**
 * 위치 정하기 (설계서 §5.3-C). P0: PlacePicker(프리셋 장소 + 위도/경도 직접 입력) + [이 위치로 정하기].
 *
 * 약속 잡기(late/new) ↔ 이 화면 사이의 핀 전달은 라우트 파라미터가 아니라 아래의 모듈 메모리로 한다.
 * - 좌표를 URL 에 싣지 않는다(웹 주소창·히스토리에 남지 않게).
 * - new 가 openPlaceDraft 로 현재 핀·반경·장소 이름을 넘기고 push → 여기서 확정하면 결과를 적어 두고 back →
 *   new 가 포커스를 되찾을 때 takePlaceResult 로 한 번만 꺼내 간다.
 * P1 에서 PlacePicker 가 지도로 바뀌어도 이 전달 방식은 그대로 간다.
 */
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { mapPinUrl } from '@/domain/mapRoute';
import { isInKorea } from '@/domain/tzGuard';
import { useLateBet } from '@/lateBet/LateBetContext';
import { LateBetUnavailable } from '@/lateBet/screens/NicknameGate';
import { PrimaryButton, Screen } from '@/ui/components';
import { PlacePicker, type PlacePickerValue } from '@/ui/PlacePicker';
import { colors, fontSize, spacing } from '@/ui/theme';

// ───────────────────────── new ↔ place 핀 전달(모듈 메모리) ─────────────────────────

export interface PlaceDraft {
  value: PlacePickerValue | null;
  radiusM: number;
  placeName: string;
}

const DEFAULT_RADIUS_M = 100;
let draft: PlaceDraft = { value: null, radiusM: DEFAULT_RADIUS_M, placeName: '' };
let result: PlacePickerValue | null = null;

/** 약속 잡기 화면이 push 직전에 부른다 */
export function openPlaceDraft(next: PlaceDraft): void {
  draft = next;
  result = null;
}

/** 확정된 핀을 한 번만 꺼낸다(없으면 null). 약속 잡기 화면이 포커스를 되찾을 때 부른다 */
export function takePlaceResult(): PlacePickerValue | null {
  const r = result;
  result = null;
  return r;
}

// ───────────────────────── 화면 ─────────────────────────

export default function LatePlaceScreen() {
  const { enabled } = useLateBet();
  if (!enabled) return <LateBetUnavailable />;
  return <Inner />;
}

function Inner() {
  const router = useRouter();
  // 들어올 때의 값을 한 번만 읽는다(이 화면이 떠 있는 동안 draft 는 바뀌지 않는다)
  const [initial] = useState(() => draft);
  const [value, setValue] = useState<PlacePickerValue | null>(initial.value);

  const confirm = () => {
    if (!value) return;
    result = value;
    // 새로고침 등으로 앞 화면이 없으면 약속 잡기로 돌아간다(폼은 비어 있다)
    if (router.canGoBack()) router.back();
    else router.replace('/late/new');
  };

  const openMap = () => {
    if (!value) return;
    const name = value.name || initial.placeName.trim() || '약속 장소';
    void Linking.openURL(mapPinUrl(name, value.lat, value.lng)).catch(() => undefined);
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
          정하기 전에 카카오맵에서 위치가 맞는지 확인해 주세요. 친구가 참여한 뒤에는 위치를 바꿀 수 없어요.
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
