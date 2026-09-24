/**
 * 장소 핀 고르기 — 지도 없는 방식(프리셋 장소 + 위도/경도 직접 입력 + 핀 미리보기). P0 구현 그대로.
 *
 * 쓰는 곳:
 * - PlacePicker.tsx(웹·앱인토스)가 그대로 re-export 한다.
 * - PlacePicker.native.tsx 가 안드로이드에 구글 지도 키가 없을 때(extra.hasGoogleMapsKey=false) 이것을 그린다.
 *   그때는 header 로 검색창·[현재 위치로]를 위에 끼운다.
 * (PlacePicker.native.tsx 는 './PlacePicker' 를 import 하면 자기 자신으로 resolve 되므로 이 구현을 별도 파일로 뺐다.)
 *
 * 지도가 없으니 여기서는 장소 이름을 직접 적게 한다(지도 방식은 이름을 지도 결과로 채운다).
 * 적은 이름·프리셋 이름은 nameSource 'search'(사람이 고른 이름), 이름이 비면 'none' 으로 싣는다.
 * 이 화면이 보내는 핀에는 늘 nameConfirmed=true 를 붙인다 — 이름 칸에 보이던 그대로라 폼이 '고친 이름 지키기'로 버리지 않게.
 * 이름 칸의 첫 값은 폼의 지금 이름(placeName)이 먼저다(핀에 실린 옛 검색·프리셋 이름이 아니라). 폼 이름이 비었을 때만 핀 이름.
 * radiusOptions 가 있으면 같은 거리 칩 줄을 그린다(원 대신 문장). radiusM 이 null 이면 미리보기에 반경을 그리지 않는다.
 *
 * RadiusChips 는 지도 방식(PlacePicker.native.tsx)도 같이 쓴다 — 이 파일에는 .native 짝이 없어 어디서 import 해도 여기로 온다.
 *
 * 확정 버튼은 부모(app/late/place.tsx)가 그린다 — 이 컴포넌트는 핀이 바뀔 때마다 onChange 만 부른다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Chip, Row, SectionTitle, TextField } from './components';
import { MapPane } from './MapPane';
import { formatDistance } from './mapGeometry';
import { isUsableRadius, pickRadius, pinLimitStatus, radiusSentence } from './placePickerModel';
import { limitExceededText, type PlacePickerProps, type PlacePickerValue, type PlaceRadiusOptions } from './placePickerShared';
import { colors, fontSize, radius, spacing } from './theme';

/** 이름 칸 최대 글자 수(약속 잡기 폼의 장소 이름 한도와 같다) */
const NAME_MAX = 60;

/**
 * 도착 인정 거리 칩 줄 + 한 줄 설명. 지도 방식은 가로 스크롤(줄이 늘어 지도 높이가 흔들리지 않게), 폼 방식은 줄바꿈.
 * 잠겨 있으면 칩을 누를 수 없고 이유를 한 줄 더 쓴다.
 * options.custom 이 있으면 제목 줄 오른쪽에 [직접 적기] — 열면 칩 줄 바로 아래에 숫자 칸과 [완료]가 생긴다
 * (footer 에 두면 키보드와 커진 footer 가 지도·칩을 가린다. 여기 두면 적는 동안에도 원과 칩이 보인다).
 * options.warning 이 있으면 '핀에서 N m 안에…' 문장 대신 그 경고를 쓴다(줄 수가 늘지 않게)
 */
export function RadiusChips({
  options,
  radiusM,
  scroll,
}: {
  options: PlaceRadiusOptions;
  radiusM: number | null | undefined;
  scroll?: boolean;
}) {
  const current = isUsableRadius(radiusM) ? radiusM : null;
  const locked = options.locked === true;
  const custom = !locked ? (options.custom ?? null) : null;
  const chips = options.choices.map((m) => (
    <Chip
      key={m}
      label={`${m}m`}
      selected={current === m && !(custom?.open && custom.text.trim() !== '')}
      disabled={locked}
      onPress={() => {
        const next = pickRadius(options.locked, current ?? m, m);
        if (next !== current) options.onChange(next);
        // 같은 칩을 다시 눌러도 직접 적던 줄은 닫는다(칩을 고른 것이다)
        else if (custom?.open) options.onChange(next);
      }}
    />
  ));
  const note = options.warning ? (
    <Text style={styles.warn}>{options.warning}</Text>
  ) : current !== null && !custom?.open ? (
    <Text style={styles.help}>{radiusSentence(current)}</Text>
  ) : null;
  return (
    <View style={styles.radiusWrap}>
      <View style={styles.radiusTitleRow}>
        <Text style={styles.radiusTitle}>도착 인정 거리</Text>
        {custom ? (
          <Pressable
            onPress={custom.open ? custom.onDone : custom.onOpen}
            accessibilityRole="button"
            hitSlop={8}
            style={({ pressed }) => [styles.radiusLinkWrap, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.radiusLink}>{custom.open ? '완료' : '직접 적기'}</Text>
          </Pressable>
        ) : null}
      </View>
      {scroll ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipScroll} keyboardShouldPersistTaps="handled">
          {chips}
        </ScrollView>
      ) : (
        <Row>{chips}</Row>
      )}
      {custom?.open ? (
        <View style={styles.customRow}>
          <TextInput
            style={styles.customInput}
            value={custom.text}
            onChangeText={custom.onText}
            placeholder={`${custom.min}~${custom.max}`}
            placeholderTextColor={colors.subtext}
            keyboardType="number-pad"
            returnKeyType="done"
            onSubmitEditing={custom.onDone}
            maxLength={String(custom.max).length}
            autoFocus
            accessibilityLabel={`도착 인정 거리 직접 적기, ${custom.min}에서 ${custom.max}미터`}
          />
          <Text style={styles.customSuffix}>m</Text>
          <Text style={styles.customHint} numberOfLines={1}>
            {custom.min}~{custom.max}m 사이
          </Text>
        </View>
      ) : null}
      {note}
      {locked && options.lockedReason ? <Text style={styles.warn}>{options.lockedReason}</Text> : null}
    </View>
  );
}

export interface PlacePickerFallbackProps extends PlacePickerProps {
  /** 미리보기 아래·프리셋 위에 끼울 것(네이티브 폴백의 검색창·[현재 위치로]). 웹은 없음 */
  header?: React.ReactNode;
  /** 맨 위 안내 한 줄(안드로이드 구글 지도 키 없음: "이 기기에서는 지도를 띄울 수 없어 목록으로 정해요"). 웹은 없음 */
  topNote?: string;
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

/** 폴백의 핀 값: 이름 칸이 비면 'none', 아니면 사람이 적은(고른) 이름이라 'search'. 늘 이름 칸 그대로(nameConfirmed) */
function withName(lat: number, lng: number, nameText: string): PlacePickerValue {
  const name = nameText.replace(/\s+/g, ' ').trim();
  return name === ''
    ? { lat, lng, nameSource: 'none', nameConfirmed: true }
    : { lat, lng, name, nameSource: 'search', nameConfirmed: true };
}

export function PlacePickerFallback({
  value,
  radiusM,
  radiusOptions,
  placeName,
  onChange,
  header,
  topNote,
  limitCenter,
  limitRadiusM,
}: PlacePickerFallbackProps) {
  const [latText, setLatText] = useState(value ? fmt(value.lat) : '');
  const [lngText, setLngText] = useState(value ? fmt(value.lng) : '');
  // 폼의 지금 이름이 먼저다 — 핀에 실린 이름은 첫 선택 때의 옛 이름일 수 있다(폼에서 고친 이름을 되돌리지 않게)
  const [nameText, setNameText] = useState(() => (placeName ?? '').trim() || value?.name || '');
  const nameRef = useRef(nameText);
  nameRef.current = nameText;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // 내가 방금 올려 보낸 핀 — 같은 값이 props 로 되돌아와도 입력 중인 글자를 덮어쓰지 않는다
  const emitted = useRef<{ lat: number; lng: number } | null>(value ? { lat: value.lat, lng: value.lng } : null);

  // 들어올 때 이미 핀이 있으면, 이름 칸에 보이는 이름을 실어 한 번 다시 보낸다 —
  // 아무것도 안 고치고 확정해도 폼에는 화면에 보이던 이름이 돌아간다(핀에 실린 옛 이름이 아니라)
  useEffect(() => {
    if (value) onChangeRef.current(withName(value.lat, value.lng, nameRef.current));
    // 처음 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!value || samePin(value, emitted.current)) return;
    // 바깥(네이티브 폴백의 검색 결과·[현재 위치로])이 핀을 바꿨다 — 좌표 칸을 맞추고, 이름이 실려 왔으면 이름 칸도.
    // 그리고 이름 칸 그대로(nameConfirmed)로 다시 보낸다. 이름 없이 온 핀([현재 위치로])에는 이미 적어 둔 이름을 붙인다
    emitted.current = { lat: value.lat, lng: value.lng };
    setLatText(fmt(value.lat));
    setLngText(fmt(value.lng));
    const nextName = value.name ? value.name : nameRef.current;
    if (value.name) setNameText(value.name);
    onChangeRef.current(withName(value.lat, value.lng, nextName));
  }, [value]);

  const emit = (next: PlacePickerValue) => {
    emitted.current = { lat: next.lat, lng: next.lng };
    onChange(next);
  };

  const pickPreset = (p: PresetPlace) => {
    setLatText(fmt(p.lat));
    setLngText(fmt(p.lng));
    setNameText(p.name);
    emit(withName(p.lat, p.lng, p.name));
  };

  const applyTexts = (nextLat: string, nextLng: string) => {
    const lat = parseCoord(nextLat, 90);
    const lng = parseCoord(nextLng, 180);
    if (lat === null || lng === null) return;
    if (samePin({ lat, lng }, emitted.current)) return;
    emit(withName(lat, lng, nameText));
  };

  const onNameText = (t: string) => {
    setNameText(t);
    // 핀이 있으면 이름만 바꿔 다시 보낸다(좌표는 그대로)
    if (value) onChange(withName(value.lat, value.lng, t));
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
  const previewName = nameText.trim() || value?.name || (placeName ?? '').trim() || '고른 위치';
  const circleM = isUsableRadius(radiusM) ? radiusM : null;
  // 옮길 수 있는 한도(시작한 약속의 장소 바꾸기, R2) — 지도가 없으니 거리 한 줄로 알린다
  const limit = limitCenter && typeof limitRadiusM === 'number' ? pinLimitStatus(value, limitCenter, limitRadiusM) : null;

  return (
    <View style={styles.wrap}>
      {topNote ? <Text style={styles.help}>{topNote}</Text> : null}
      {value ? (
        // 반경이 없으면(모임 약속, circleM null) MapPane 이 원·'도착 인정 거리' 문구 없이 핀만 그린다
        <MapPane destination={{ name: previewName, lat: value.lat, lng: value.lng }} radiusM={circleM} readonly />
      ) : (
        <View style={styles.emptyPin}>
          <Text style={styles.emptyPinText}>아직 위치를 정하지 않았어요</Text>
          <Text style={styles.help}>
            {header ? '아래에서 장소를 찾거나 고르고, 위도·경도를 적어도 돼요' : '아래에서 장소를 고르거나 위도·경도를 적어주세요'}
          </Text>
        </View>
      )}

      {limit && typeof limitRadiusM === 'number' ? (
        <Text style={limit.over ? styles.warn : styles.help}>
          {limit.over
            ? `${limitExceededText(limitRadiusM)} (지금 ${formatDistance(limit.distanceM ?? 0)})`
            : limit.distanceM !== null
              ? `처음 장소에서 ${formatDistance(limit.distanceM)} · ${limitRadiusM}m 안으로만 옮길 수 있어요`
              : `처음 장소에서 ${limitRadiusM}m 안으로만 옮길 수 있어요`}
        </Text>
      ) : null}

      {radiusOptions ? <RadiusChips options={radiusOptions} radiusM={circleM} /> : null}

      {header}

      <TextField
        label={`장소 이름 (1~${NAME_MAX}자)`}
        value={nameText}
        onChangeText={onNameText}
        placeholder="예: 강남역 2번 출구 곱창"
      />
      {Array.from(nameText.trim()).length > NAME_MAX ? (
        <Text style={styles.warn}>장소 이름은 {NAME_MAX}자까지예요</Text>
      ) : null}

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
  warn: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text, lineHeight: 20 },
  radiusWrap: { gap: spacing.xs },
  radiusTitle: { fontSize: fontSize.sm, fontWeight: '700', color: colors.subtext },
  radiusTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  radiusLinkWrap: { paddingVertical: 2 },
  radiusLink: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text, textDecorationLine: 'underline' },
  // 직접 적기 줄 — components.TextField 의 입력 상자와 같은 모양을 한 줄로 작게
  customRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  customInput: {
    width: 96,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  customSuffix: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  customHint: { flexShrink: 1, fontSize: fontSize.sm, color: colors.subtext },
  chipScroll: { gap: spacing.sm, paddingVertical: 2 },
});
