/**
 * 모임 약속의 장소 정하기 — 지도 핀(2026-09-24 오너 요청: 장소는 지도로 정한다).
 *
 * 약속 내기의 app/late/place.tsx 는 약속 내기 기능이 꺼져 있으면(LateBetUnavailable) 막히므로 쓰지 않는다.
 * 같은 PlacePicker 를 반경 원·거리 칩 없이(radiusM=null, radiusOptions=null) 쓰는 얇은 화면이다 — 모임엔 도착 판정이 없다.
 *
 * 새 모임(session/new)·약속 수정(session/[id]) ↔ 이 화면 사이의 핀 전달은 src/ui/placePickerShared 의 모듈 메모리다
 * (openPlaceDraft → readPlaceDraft / setPlaceResult → takePlaceResult). 좌표를 URL 에 싣지 않는다.
 * 부르는 화면은 지도가 뜨는 기기(placePickerUsesMap)에서만 이 화면으로 온다. 웹에서 주소로 직접 열면 폼 방식 PlacePicker 가 그려진다.
 *
 * 결과에는 owner 'session' 을 싣는다 — 모임 화면만 꺼내 간다(약속 잡기 폼에 새어 들어가지 않게).
 * 돌아갈 화면이 없으면(주소로 직접 열기·새로고침·스택 복원) 결과를 남기지 않고 홈으로 간다 — 꺼내 갈 폼이 없다.
 * 지도를 움직인 핀의 주소를 찾는 동안(namePending)은 확정을 막는다(찾을 수 있었던 주소 대신 빈 이름이 들어가지 않게).
 */
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { PrimaryButton, Screen } from '@/ui/components';
import { isNamePending } from '@/ui/placePickerModel';
import {
  PlacePicker,
  placePickerUsesMap,
  readPlaceDraft,
  setPlaceResult,
  type PlacePickerValue,
} from '@/ui/PlacePicker';
import { colors, fontSize } from '@/ui/theme';

export default function SessionPlaceScreen() {
  const router = useRouter();
  // 들어올 때의 값을 한 번만 읽는다(이 화면이 떠 있는 동안 draft 는 바뀌지 않는다)
  const [initial] = useState(() => readPlaceDraft());
  const [value, setValue] = useState<PlacePickerValue | null>(initial.value);
  const [usesMap] = useState(() => placePickerUsesMap());

  const namePending = isNamePending(value);

  const confirm = () => {
    if (!value || namePending) return;
    // 새로고침 등으로 앞 화면이 없으면 홈으로 — 꺼내 갈 폼이 없으니 결과를 남기지 않는다(다른 폼에 새지 않게)
    if (!router.canGoBack()) {
      router.replace('/');
      return;
    }
    // 모임 약속엔 도착 인정 거리가 없다 → radiusM 은 늘 null. 모임 화면만 꺼내 가게 출처를 싣는다
    setPlaceResult({ value, radiusM: null, owner: 'session' });
    router.back();
  };

  return (
    <Screen
      // 지도는 스크롤 안에 넣지 않는다 — 세로 끌기를 빼앗긴다
      scroll={!usesMap}
      tightBottom={usesMap}
      footer={
        <PrimaryButton
          label={namePending ? '주소 찾는 중…' : '이 위치로 정하기'}
          onPress={confirm}
          disabled={!value || namePending}
        />
      }
    >
      <Text style={styles.lead}>
        {usesMap
          ? '지도를 움직여 가운데 핀을 만날 장소에 맞춰 주세요. 장소 이름으로 검색해도 돼요.'
          : '만날 장소의 위치를 정해 주세요.'}
      </Text>
      <PlacePicker
        value={value}
        radiusM={null}
        radiusOptions={null}
        placeName={initial.placeName}
        onChange={setValue}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  lead: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
});
