/**
 * 위치 정하기 (설계서 §5.3-C). 담당: [create] → P1 [picker]
 *
 * iOS/Android: PlacePicker.native(지도 중앙 고정 핀 + 반경 원 + 검색 + [현재 위치로]).
 *   안드로이드에 구글 지도 키가 없으면 폼 방식(검색 + 프리셋 + 좌표 입력)으로 떨어진다.
 * 웹·앱인토스: PlacePicker(프리셋 + 위도/경도 직접 입력) — P0 그대로.
 * 지도 방식이면(placePickerUsesMap) 스크롤 없는 화면에 넣는다 — 스크롤 안의 지도는 세로 끌기를 빼앗긴다.
 *
 * 약속 잡기(late/new) ↔ 이 화면 사이의 핀 전달은 라우트 파라미터가 아니라 src/ui/placePickerShared 의 모듈 메모리다
 * (openPlaceDraft → readPlaceDraft / setPlaceResult → takePlaceResult). 좌표를 URL 에 싣지 않는다.
 * 이미 정한 핀이 있으면 그 위치에서 시작한다(draft.value).
 * 시작한 약속의 장소 바꾸기면 draft.limit(시작하던 순간의 핀 + 500m, 공정성 규칙 R2)이 온다 → 지도에 한도 원, 넘으면 확정 버튼 비활성.
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
import {
  limitExceededText,
  PlacePicker,
  placePickerUsesMap,
  readPlaceDraft,
  setPlaceResult,
  type PlacePickerValue,
} from '@/ui/PlacePicker';
import { pinLimitStatus } from '@/ui/placePickerModel';
import { colors, fontSize, spacing } from '@/ui/theme';

const OUTSIDE_KOREA_NOTE = '한국 밖의 장소예요. 약속 시각이 어느 시간대인지 다음 화면에서 물어볼게요.';

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
  const [usesMap] = useState(() => placePickerUsesMap());

  const limit = initial.limit ?? null;
  const overLimit = limit !== null && pinLimitStatus(value, limit, limit.radiusM).over;

  const confirm = () => {
    if (!value || overLimit) return;
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

  const outsideKorea = value !== null && !isInKorea(value.lat, value.lng);

  return (
    <Screen
      scroll={!usesMap}
      footer={
        <View style={styles.footer}>
          {overLimit && limit ? <Text style={styles.warn}>{limitExceededText(limit.radiusM)}</Text> : null}
          <PrimaryButton label="이 위치로 정하기" onPress={confirm} disabled={!value || overLimit} />
          <PrimaryButton label="카카오맵에서 위치 확인" variant="ghost" onPress={openMap} disabled={!value} />
        </View>
      }
    >
      <Text style={styles.lead}>
        {usesMap
          ? `지도를 움직여 가운데 핀을 약속 장소에 맞춰 주세요. 핀에서 ${initial.radiusM}m 안에 들어오면 도착으로 인정돼요.${
              limit ? ` 이미 시작한 약속이라 점선 원(처음 장소에서 ${limit.radiusM}m) 안으로만 옮길 수 있어요.` : ''
            }`
          : `약속 장소의 위치를 정해 주세요. 이 위치에서 ${initial.radiusM}m 안에 들어오면 도착으로 인정돼요.`}
      </Text>
      <PlacePicker
        value={value}
        radiusM={initial.radiusM}
        placeName={initial.placeName}
        onChange={setValue}
        limitCenter={limit ? { lat: limit.lat, lng: limit.lng } : null}
        limitRadiusM={limit?.radiusM}
      />
      {usesMap ? (
        // 지도 화면은 세로 공간이 빠듯하다 — 꼭 필요한 안내(한국 밖)만
        outsideKorea ? <Text style={styles.help}>{OUTSIDE_KOREA_NOTE}</Text> : null
      ) : value ? (
        <Text style={styles.help}>
          정하기 전에 카카오맵에서 위치가 맞는지 확인해 주세요.
          {limit ? '' : ' 장소는 시작한 뒤에도 처음 장소 근처(500m 안)로 옮길 수 있어요.'}
          {outsideKorea ? ` ${OUTSIDE_KOREA_NOTE}` : ''}
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  footer: { gap: spacing.sm },
  lead: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  help: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  warn: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text, lineHeight: 20, textAlign: 'center' },
});
