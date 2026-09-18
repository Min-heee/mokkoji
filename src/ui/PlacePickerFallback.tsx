/**
 * 장소 핀 고르기 — 지도 없는 방식(프리셋 장소 + 위도/경도 직접 입력 + 핀 미리보기). P0 구현 그대로.
 *
 * 쓰는 곳:
 * - PlacePicker.tsx(웹·앱인토스)가 그대로 re-export 한다.
 * - PlacePicker.native.tsx 가 안드로이드에 구글 지도 키가 없을 때(extra.hasGoogleMapsKey=false) 이것을 그린다.
 *   그때는 header 로 검색창·[현재 위치로]를 위에 끼운다.
 * (PlacePicker.native.tsx 는 './PlacePicker' 를 import 하면 자기 자신으로 resolve 되므로 이 구현을 별도 파일로 뺐다.)
 *
 * 확정 버튼은 부모(app/late/place.tsx)가 그린다 — 이 컴포넌트는 핀이 바뀔 때마다 onChange 만 부른다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Row, SectionTitle, TextField } from './components';
import { MapPane } from './MapPane';
import type { PlacePickerProps, PlacePickerValue } from './placePickerShared';
import { colors, fontSize, radius, spacing } from './theme';

export interface PlacePickerFallbackProps extends PlacePickerProps {
  /** 미리보기 아래·프리셋 위에 끼울 것(네이티브 폴백의 검색창·[현재 위치로]). 웹은 없음 */
  header?: React.ReactNode;
}

interface PresetPlace {
  name: string;
  /** 목록의 둘째 줄 */
  hint: string;
  lat: number;
  lng: number;
}

/** P0 프리셋. 마지막 둘은 시간대 시트(한국 밖 핀)를 확인하기 위한 것이다 */
const PRESET_PLACES: readonly PresetPlace[] = [
  { name: '강남역 2번 출구', hint: '서울 강남구', lat: 37.49794, lng: 127.02762 },
  { name: '홍대입구역 9번 출구', hint: '서울 마포구', lat: 37.55719, lng: 126.92538 },
  { name: '서울역', hint: '서울 용산구', lat: 37.55473, lng: 126.97062 },
  { name: '잠실역', hint: '서울 송파구', lat: 37.51331, lng: 127.10013 },
  { name: '판교역', hint: '경기 성남시', lat: 37.39476, lng: 127.11116 },
  { name: '부산역', hint: '부산 동구', lat: 35.11516, lng: 129.04224 },
  { name: '도쿄역', hint: '일본 · 시간대가 같은 해외', lat: 35.68124, lng: 139.76712 },
  { name: '방콕 시암역', hint: '태국 · 시간대가 다른 해외', lat: 13.7456, lng: 100.5341 },
];

const COORD_DIGITS = 5;
const fmt = (n: number) => `${Number(n.toFixed(COORD_DIGITS))}`;

/** '37.4979' → 37.4979. 숫자가 아니거나 범위를 벗어나면 null */
function parseCoord(text: string, limit: number): number | null {
  const t = text.trim();
  if (!/^-?\d+(\.\d*)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

const samePin = (a: { lat: number; lng: number } | null, b: { lat: number; lng: number } | null) =>
  !!a && !!b && a.lat === b.lat && a.lng === b.lng;

export function PlacePickerFallback({ value, radiusM, placeName, onChange, header }: PlacePickerFallbackProps) {
  const [latText, setLatText] = useState(value ? fmt(value.lat) : '');
  const [lngText, setLngText] = useState(value ? fmt(value.lng) : '');
  // 내가 방금 올려 보낸 핀 — 같은 값이 props 로 되돌아와도 입력 중인 글자를 덮어쓰지 않는다
  const emitted = useRef<{ lat: number; lng: number } | null>(value ? { lat: value.lat, lng: value.lng } : null);

  useEffect(() => {
    if (!value || samePin(value, emitted.current)) return;
    emitted.current = { lat: value.lat, lng: value.lng };
    setLatText(fmt(value.lat));
    setLngText(fmt(value.lng));
  }, [value]);

  const emit = (next: PlacePickerValue) => {
    emitted.current = { lat: next.lat, lng: next.lng };
    onChange(next);
  };

  const pickPreset = (p: PresetPlace) => {
    setLatText(fmt(p.lat));
    setLngText(fmt(p.lng));
    emit({ lat: p.lat, lng: p.lng, name: p.name });
  };

  const applyTexts = (nextLat: string, nextLng: string) => {
    const lat = parseCoord(nextLat, 90);
    const lng = parseCoord(nextLng, 180);
    if (lat === null || lng === null) return;
    if (samePin({ lat, lng }, emitted.current)) return;
    emit({ lat, lng });
  };

  const onLatText = (t: string) => {
    // '37.4979, 127.0276' 을 한 칸에 붙여 넣으면 둘로 나눈다
    const parts = t.split(/[,\s]+/).filter((s) => s !== '');
    if (parts.length === 2 && parseCoord(parts[0], 90) !== null && parseCoord(parts[1], 180) !== null) {
      setLatText(parts[0]);
      setLngText(parts[1]);
      applyTexts(parts[0], parts[1]);
      return;
    }
    setLatText(t);
    applyTexts(t, lngText);
  };

  const onLngText = (t: string) => {
    setLngText(t);
    applyTexts(latText, t);
  };

  const typed = latText.trim() !== '' || lngText.trim() !== '';
  const typedInvalid = typed && (parseCoord(latText, 90) === null || parseCoord(lngText, 180) === null);
  const keyboardType = Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default';
  const previewName = value?.name || (placeName ?? '').trim() || '고른 위치';

  return (
    <View style={styles.wrap}>
      {value ? (
        <MapPane destination={{ name: previewName, lat: value.lat, lng: value.lng }} radiusM={radiusM} readonly />
      ) : (
        <View style={styles.emptyPin}>
          <Text style={styles.emptyPinText}>아직 위치를 정하지 않았어요</Text>
          <Text style={styles.help}>
            {header ? '아래에서 장소를 찾거나 고르고, 위도·경도를 적어도 돼요' : '아래에서 장소를 고르거나 위도·경도를 적어주세요'}
          </Text>
        </View>
      )}

      {header}

      <SectionTitle>장소 고르기</SectionTitle>
      <View style={styles.list}>
        {PRESET_PLACES.map((p) => {
          const selected = samePin(value, p);
          return (
            <Pressable
              key={p.name}
              onPress={() => pickPreset(p)}
              style={({ pressed }) => [styles.item, selected && styles.itemSelected, pressed && { opacity: 0.7 }]}
            >
              <Text style={[styles.itemName, selected && styles.itemNameSelected]} numberOfLines={1}>
                {p.name}
              </Text>
              <Text style={[styles.itemHint, selected && styles.itemHintSelected]} numberOfLines={1}>
                {p.hint}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <SectionTitle>위도·경도 직접 입력</SectionTitle>
      <Row>
        <View style={styles.coordField}>
          <TextField label="위도" value={latText} onChangeText={onLatText} placeholder="37.49794" keyboardType={keyboardType} />
        </View>
        <View style={styles.coordField}>
          <TextField label="경도" value={lngText} onChangeText={onLngText} placeholder="127.02762" keyboardType={keyboardType} />
        </View>
      </Row>
      <Text style={styles.help}>
        {typedInvalid
          ? '위도는 -90~90, 경도는 -180~180 사이의 숫자로 적어주세요'
          : '지도 앱에서 복사한 좌표(예: 37.49794, 127.02762)를 위도 칸에 붙여 넣어도 돼요'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  emptyPin: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.cardAlt,
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.xs,
  },
  emptyPinText: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  list: { gap: spacing.sm },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
  },
  itemSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  itemName: { flexShrink: 1, fontSize: fontSize.md, fontWeight: '600', color: colors.text },
  itemNameSelected: { color: colors.onPrimary, fontWeight: '800' },
  itemHint: { marginLeft: 'auto', fontSize: fontSize.sm, color: colors.subtext },
  itemHintSelected: { color: colors.onPrimary },
  coordField: { flex: 1 },
  help: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
});
