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
 *
 * 도착 인정 거리(2026-09-24 오너 "지도로 정해야 몇 m 기준을 정할 수 있지"): 약속 잡기 폼의 칩을 이 화면으로 옮겼다.
 * - 지도 아래 칩 50·100·200·300·500m(+지금 값) — 고르면 원이 바로 바뀐다. [직접 적기]로 POLICY_LIMITS.radiusM 안의 값.
 *   직접 적기 칸은 footer 가 아니라 칩 줄 바로 아래(RadiusChips 의 custom)에 둔다 — 적는 동안에도 원·칩이 보이게.
 *   지도 방식에서 적는 동안(키보드가 떠 있는 동안)은 안내 문장·검색창·주소 줄·footer 를 접는다. [완료]·키보드 내림으로 끝낸다.
 * - 50m 이하면 GPS 경고, 값이 이상하면 범위 안내(칩 아래 한 줄). 값이 이상하면 확정 버튼 비활성.
 * - 지도를 움직인 핀의 가장 가까운 주소를 찾는 동안(value.namePending)은 확정 버튼을 '주소 찾는 중…'으로 막는다 —
 *   그 사이에 확정하면 찾을 수 있었던 주소 대신 빈 이름이 폼에 들어간다.
 * - draft.radiusLocked(시작한 약속 — 정책 동결)면 칩을 잠그고 이유를 보인다. 결과의 radiusM 은 draft 값 그대로.
 * - 확정: setPlaceResult({ value(lat·lng·name·nameSource), radiusM, owner: 'late' }) — 약속 잡기 폼만 꺼내 간다.
 */
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Platform, StyleSheet, Text, View } from 'react-native';

import { mapPinUrl } from '@/domain/mapRoute';
import { POLICY_LIMITS, SMALL_RADIUS_WARN_M } from '@/domain/latePresets';
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
  type PlaceRadiusOptions,
} from '@/ui/PlacePicker';
import {
  isNamePending,
  parseRadiusText,
  pinLimitStatus,
  RADIUS_PICKER_CHOICES,
  radiusChipList,
  shouldCloseCustomRadius,
} from '@/ui/placePickerModel';
import { colors, fontSize, spacing } from '@/ui/theme';

const OUTSIDE_KOREA_NOTE = '한국 밖의 장소예요. 약속 시각이 어느 시간대인지 다음 화면에서 물어볼게요.';
const SMALL_RADIUS_WARNING = '지하·실내는 GPS가 잘 안 잡혀요. 100m를 권해요';
const RADIUS_RANGE_TEXT = `도착 인정 거리는 ${POLICY_LIMITS.radiusM.min}~${POLICY_LIMITS.radiusM.max}m 사이로 정해 주세요`;
const { min: RADIUS_MIN, max: RADIUS_MAX } = POLICY_LIMITS.radiusM;

/** 직접 적은 거리: 정수이고 POLICY_LIMITS.radiusM 안이면 그 값, 아니면 null(서버 CHECK 와 같은 범위) */
const parseRadius = (text: string) => parseRadiusText(text, RADIUS_MIN, RADIUS_MAX);

/** 키보드가 떠 있는가(웹은 늘 false). iOS 는 will 이벤트로 먼저 알아 레이아웃이 한 번에 바뀌게 */
function useKeyboardShown(onHide: () => void): boolean {
  const [shown, setShown] = useState(false);
  const onHideRef = useRef(onHide);
  onHideRef.current = onHide;
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEvt, () => setShown(true));
    const b = Keyboard.addListener(hideEvt, () => {
      setShown(false);
      onHideRef.current();
    });
    return () => {
      a.remove();
      b.remove();
    };
  }, []);
  return shown;
}

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
  // 도착 인정 거리. draft 가 null 이면(반경 없는 곳) 칩도 원도 없다
  const [radiusM, setRadiusM] = useState<number | null>(initial.radiusM);
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState('');
  // 직접 적기를 열던 때의 반경 — 적는 동안 칩 줄이 글자마다 늘었다 줄었다 하지 않게 칩 목록은 이 값으로 만든다
  const [radiusAtOpen, setRadiusAtOpen] = useState<number | null>(null);
  const locked = initial.radiusLocked === true;
  const hasRadius = initial.radiusM !== null;

  const customTextRef = useRef(customText);
  customTextRef.current = customText;
  const customOpenRef = useRef(customOpen);
  customOpenRef.current = customOpen;

  /** [완료]·키보드 내림: 비었거나 올바른 값이면 닫는다. 이상한 값이면 열어 두고 칩 아래 범위 안내를 보인다 */
  const finishCustom = () => {
    if (!customOpenRef.current) return;
    if (shouldCloseCustomRadius(customTextRef.current, RADIUS_MIN, RADIUS_MAX)) {
      setCustomOpen(false);
      setCustomText('');
    }
  };
  const keyboardShown = useKeyboardShown(finishCustom);

  const limit = initial.limit ?? null;
  const overLimit = limit !== null && pinLimitStatus(value, limit, limit.radiusM).over;
  // 직접 적는 중인데 값이 이상하면 확정을 막는다(칩으로 고른 마지막 값으로 조용히 저장하지 않게)
  const customInvalid = customOpen && !locked && customText.trim() !== '' && parseRadius(customText) === null;
  const radiusInvalid = hasRadius && !locked && (radiusM === null || radiusM < RADIUS_MIN || radiusM > RADIUS_MAX);
  const radiusBlocked = customInvalid || radiusInvalid;
  // 지도를 움직인 핀의 주소를 찾는 중 — 끝나면(찾았든 못 찾았든) 풀린다
  const namePending = isNamePending(value);
  const confirmDisabled = !value || overLimit || radiusBlocked || namePending;
  // 지도 방식에서 거리를 적는 동안(키보드가 떠 있는 동안)은 지도·원·칩이 보이게 나머지를 접는다
  const typingRadius = usesMap && customOpen && !locked;
  const hideFooter = typingRadius && keyboardShown;

  const radiusWarning = !hasRadius || locked
    ? null
    : radiusBlocked
      ? RADIUS_RANGE_TEXT
      : radiusM !== null && radiusM <= SMALL_RADIUS_WARN_M
        ? SMALL_RADIUS_WARNING
        : null;

  const chipBase = customOpen ? radiusAtOpen : radiusM;
  const radiusOptions = useMemo<PlaceRadiusOptions | null>(
    () =>
      hasRadius
        ? {
            choices: radiusChipList(initial.radiusChoices ?? RADIUS_PICKER_CHOICES, chipBase),
            onChange: (m: number) => {
              setRadiusM(m);
              // 칩을 고르면 직접 적던 값은 버린다
              setCustomOpen(false);
              setCustomText('');
            },
            locked,
            lockedReason: initial.radiusLockedReason,
            custom: locked
              ? null
              : {
                  open: customOpen,
                  text: customText,
                  min: RADIUS_MIN,
                  max: RADIUS_MAX,
                  onOpen: () => {
                    setRadiusAtOpen(radiusM);
                    setCustomText('');
                    setCustomOpen(true);
                  },
                  onText: (t: string) => {
                    const digits = t.replace(/[^0-9]/g, '');
                    setCustomText(digits);
                    const n = parseRadius(digits);
                    if (n !== null) setRadiusM(n);
                  },
                  onDone: () => {
                    Keyboard.dismiss();
                    finishCustom();
                  },
                },
            warning: radiusWarning,
          }
        : null,
    // finishCustom 은 ref 만 읽는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasRadius, initial.radiusChoices, initial.radiusLockedReason, locked, radiusM, chipBase, customOpen, customText, radiusWarning],
  );

  const confirm = () => {
    if (confirmDisabled || !value) return;
    // 잠겨 있으면 draft 값 그대로 돌려준다(정책 동결). 약속 잡기 폼만 꺼내 가게 출처를 싣는다
    setPlaceResult({ value, radiusM: locked ? initial.radiusM : radiusM, owner: 'late' });
    // 새로고침 등으로 앞 화면이 없으면 약속 잡기로 돌아간다(새 폼이 이 결과를 꺼내 간다)
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
      tightBottom={usesMap}
      footer={
        hideFooter ? undefined : (
          <View style={styles.footer}>
            {overLimit && limit ? <Text style={styles.warn}>{limitExceededText(limit.radiusM)}</Text> : null}
            <PrimaryButton
              label={namePending ? '주소 찾는 중…' : '이 위치로 정하기'}
              onPress={confirm}
              disabled={confirmDisabled}
            />
            <PrimaryButton label="카카오맵에서 위치 확인" variant="ghost" onPress={openMap} disabled={!value} />
          </View>
        )
      }
    >
      {typingRadius ? null : (
        <Text style={styles.lead}>
          {usesMap
            ? `지도를 움직여 가운데 핀을 약속 장소에 맞추고, 아래에서 몇 m 안에 들어오면 도착인지 골라 주세요.${
                limit ? ` 이미 시작한 약속이라 점선 원(처음 장소에서 ${limit.radiusM}m) 안으로만 옮길 수 있어요.` : ''
              }`
            : '약속 장소의 위치와 이름을 정하고, 몇 m 안에 들어오면 도착인지 골라 주세요.'}
        </Text>
      )}
      <PlacePicker
        value={value}
        radiusM={radiusM}
        radiusOptions={radiusOptions}
        placeName={initial.placeName}
        onChange={setValue}
        limitCenter={limit ? { lat: limit.lat, lng: limit.lng } : null}
        limitRadiusM={limit?.radiusM}
      />
      {usesMap ? (
        // 지도 화면은 세로 공간이 빠듯하다 — 꼭 필요한 안내(한국 밖)만
        outsideKorea && !typingRadius ? <Text style={styles.help}>{OUTSIDE_KOREA_NOTE}</Text> : null
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
