/**
 * 장소 핀 고르기 — 담당: [create].
 *
 * P0: 프리셋 장소 몇 개 + 위도/경도 직접 입력 + 핀 미리보기(MapPane readonly).
 * P1 에서 PlacePicker.native.tsx(지도 중앙 고정 핀 + 검색)로 바뀐다. props 는 그대로 간다.
 * 확정 버튼은 부모(app/late/place.tsx)가 그린다 — 이 컴포넌트는 핀이 바뀔 때마다 onChange 만 부른다.
 *
 * 아래쪽의 '핀 전달(모듈 메모리)'은 약속 잡기(app/late/new) ↔ 위치 정하기(app/late/place) 사이의 통로다.
 * 라우트 파일끼리 import 하지 않도록 여기(둘 다 쓰는 모듈)에 둔다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Row, SectionTitle, TextField } from './components';
import { MapPane } from './MapPane';
import { colors, fontSize, radius, spacing } from './theme';

export interface PlacePickerValue {
  lat: number;
  lng: number;
  /** 프리셋·검색 결과를 골랐을 때의 이름(핀만 움직였으면 없음). 폼의 장소 이름이 비어 있을 때만 채운다 */
  name?: string;
}

// ───────────────────────── new ↔ place 핀 전달(모듈 메모리) ─────────────────────────
//
// - 좌표를 URL 에 싣지 않는다(웹 주소창·히스토리에 남지 않게).
// - new 가 openPlaceDraft 로 현재 핀·반경·장소 이름을 넘기고 push → place 가 readPlaceDraft 로 읽어 그리고,
//   확정하면 setPlaceResult 로 적어 두고 back → new 가 포커스를 되찾을 때 takePlaceResult 로 한 번만 꺼내 간다.
// - P1 에서 PlacePicker 가 지도로 바뀌어도 이 전달 방식은 그대로 간다.

export interface PlaceDraft {
  value: PlacePickerValue | null;
  radiusM: number;
  placeName: string;
}

const DEFAULT_DRAFT_RADIUS_M = 100;
let draft: PlaceDraft = { value: null, radiusM: DEFAULT_DRAFT_RADIUS_M, placeName: '' };
let result: PlacePickerValue | null = null;

/** 약속 잡기 화면이 push 직전에 부른다 */
export function openPlaceDraft(next: PlaceDraft): void {
  draft = { ...next, placeName: next.placeName ?? '' };
  result = null;
}

/** 위치 정하기 화면이 들어올 때 읽는다 */
export function readPlaceDraft(): PlaceDraft {
  return draft;
}

/** 위치 정하기 화면이 [이 위치로 정하기]에서 부른다 */
export function setPlaceResult(value: PlacePickerValue): void {
  result = value;
}

/** 확정된 핀을 한 번만 꺼낸다(없으면 null). 약속 잡기 화면이 포커스를 되찾을 때 부른다 */
export function takePlaceResult(): PlacePickerValue | null {
  const r = result;
  result = null;
  return r;
}

export interface PlacePickerProps {
  /** 현재 핀. 아직 없으면 null */
  value: PlacePickerValue | null;
  /** 반경 원 미리보기용 */
  radiusM: number;
  /** 폼에 적힌 장소 이름(검색 초기값) */
  placeName?: string;
  /** 핀이 바뀔 때마다. 확정 버튼은 부모(app/late/place.tsx)가 그린다 */
  onChange: (value: PlacePickerValue) => void;
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

export function PlacePicker({ value, radiusM, placeName, onChange }: PlacePickerProps) {
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
          <Text style={styles.help}>아래에서 장소를 고르거나 위도·경도를 적어주세요</Text>
        </View>
      )}

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
