/**
 * 모임 약속의 '장소' 입력 — 새 모임(app/session/new)과 약속 수정(app/session/[id])이 같이 쓴다.
 *
 * 지도가 뜨는 기기(placePickerUsesMap — iOS, 구글 지도 키가 박힌 안드로이드):
 *   글자 칸 대신 [지도에서 장소 정하기] → app/session/place(지도 핀) → 돌아오면
 *   이름(지도 결과로 채움, 고칠 수 있음) + 작은 지도 미리보기 + [다시 정하기] + [장소 지우기].
 * 지도가 없는 기기(웹·앱인토스·키 없는 안드로이드): 예전처럼 장소 이름을 글자로 적는 칸 하나.
 *
 * 이름 채우기 규칙은 순수 함수(domain/appointment.applyPickedPlace)에 있다. 이 파일은 그리기와 화면 이동만 한다.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  applyPickedPlace,
  editPlaceName,
  EMPTY_PLACE_FORM,
  PINNED_PLACE_FALLBACK_NAME,
  type PlaceFormState,
} from '@/domain/appointment';
import { PrimaryButton, Row, TextField } from '@/ui/components';
import { MapPane } from '@/ui/MapPane';
import { openPlaceDraft, takePlaceResult } from '@/ui/PlacePicker';
import { colors, fontSize, spacing } from '@/ui/theme';

/**
 * 지도 화면을 열고, 돌아왔을 때 고른 핀을 입력 상태에 반영한다.
 * 이 화면이 연 지도에서 돌아올 때만 결과를 꺼낸다 — 같은 통로를 쓰는 약속 잡기(late/new)의 결과를 가로채지 않게.
 */
export function useSessionPlacePicker(setPlace: React.Dispatch<React.SetStateAction<PlaceFormState>>) {
  const router = useRouter();
  const awaiting = useRef(false);

  useFocusEffect(
    useCallback(() => {
      if (!awaiting.current) return;
      awaiting.current = false;
      // 모임 위치 화면(session/place)이 남긴 결과만
      const r = takePlaceResult('session');
      if (r) setPlace((prev) => applyPickedPlace(prev, r.value));
    }, [setPlace]),
  );

  return useCallback(
    (current: PlaceFormState) => {
      const name = current.name.trim();
      openPlaceDraft({
        // 이미 정한 핀이 있으면 그 자리에서 시작한다
        value: current.pin ? { lat: current.pin.lat, lng: current.pin.lng, ...(name ? { name } : {}) } : null,
        // 모임엔 도착 판정이 없다 → 반경 원·거리 칩 없음
        radiusM: null,
        placeName: name,
      });
      awaiting.current = true;
      router.push('/session/place');
    },
    [router],
  );
}

export function SessionPlaceField({
  value,
  onChange,
  onOpenMap,
  usesMap,
  label = '장소',
}: {
  value: PlaceFormState;
  onChange: (next: PlaceFormState) => void;
  /** useSessionPlacePicker 가 돌려준 함수 */
  onOpenMap: (current: PlaceFormState) => void;
  /** placePickerUsesMap() — 화면이 한 번 읽어 넘긴다 */
  usesMap: boolean;
  label?: string;
}) {
  const onChangeName = (text: string) => onChange(editPlaceName(value, text));

  // 지도가 없는 기기: 예전처럼 글자로 적는다
  if (!usesMap) {
    return (
      <TextField label={label} value={value.name} onChangeText={onChangeName} placeholder="예: 강남역 2번출구 곱창집" />
    );
  }

  const open = () => onOpenMap(value);
  const hasPlace = value.pin !== null || value.name.trim() !== '';

  if (!hasPlace) {
    return (
      <View style={styles.block}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <PrimaryButton label="지도에서 장소 정하기" variant="ghost" onPress={open} />
      </View>
    );
  }

  const shownName = value.name.trim() || PINNED_PLACE_FALLBACK_NAME;

  return (
    <View style={styles.block}>
      <TextField
        label={`${label} 이름`}
        value={value.name}
        onChangeText={onChangeName}
        placeholder={value.pin ? '예: 강남역 2번출구 곱창집' : '장소 이름'}
      />
      {value.pin ? (
        <MapPane
          destination={{ name: shownName, lat: value.pin.lat, lng: value.pin.lng }}
          // 모임엔 도착 인정 거리가 없다 → null 이면 원·'도착 인정 거리' 문구 없이 핀만
          radiusM={null}
          readonly
          onPress={open}
          accessibilityLabel={`${shownName} 지도. 누르면 장소를 다시 정해요`}
        />
      ) : (
        // 글자로만 적어 둔 옛 약속(또는 지도 없는 기기에서 적은 장소)
        <Text style={styles.help}>아직 지도에서 위치를 정하지 않았어요. 지도로 정하면 길찾기가 그 자리로 바로 열려요.</Text>
      )}
      <Row>
        <View style={styles.half}>
          <PrimaryButton label={value.pin ? '다시 정하기' : '지도에서 정하기'} variant="ghost" onPress={open} />
        </View>
        <View style={styles.half}>
          <PrimaryButton label="장소 지우기" variant="ghost" onPress={() => onChange({ ...EMPTY_PLACE_FORM })} />
        </View>
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.sm },
  half: { flex: 1 },
  // components.TextField 의 라벨과 같은 모양
  fieldLabel: { fontSize: fontSize.xs, fontWeight: '700', color: colors.subtext },
  help: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
});
