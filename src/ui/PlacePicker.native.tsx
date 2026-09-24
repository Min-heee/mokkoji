/**
 * 장소 핀 고르기 — iOS/Android 구현(설계서 §5.3-C). Metro 가 iOS/Android 에서 PlacePicker.tsx 대신 이 파일을 고른다.
 *
 * - 지도(react-native-maps): 화면 중앙 고정 핀(지도가 움직이고 핀은 가운데) + 반경 원 미리보기 + [현재 위치로].
 *   iOS 는 애플 지도(PROVIDER_DEFAULT, 키 불필요), 안드로이드는 구글 지도(PROVIDER_GOOGLE).
 * - 안드로이드 바이너리에 구글 지도 키가 없으면(내장 설정 extra.hasGoogleMapsKey !== true — OTA 매니페스트가 아니라
 *   바이너리에 박힌 값, googleMapsKeyRule.ts 참고) 지도를 띄우지 않고
 *   PlacePickerFallback(프리셋 + 좌표 입력)에 검색창·[현재 위치로 정하기]를 얹어 그린다 — 키 없는 구글 지도는 크래시한다.
 * - 검색창: src/lateBet/placeSearch(카카오 키가 있으면 상호 검색, 없거나 실패하면 expo-location geocodeAsync).
 *   안드로이드에서 위치 권한을 거부했고 카카오 키도 없으면 검색창을 숨기고 핀 방식만 남긴다.
 * - 핀이 멈추면 reverseGeocodeAsync 로 '핀에서 가장 가까운 주소' 한 줄(실패하면 생략).
 * - 이름: 검색 결과를 누르면 그 상호명(nameSource 'search'), 지도를 움직이면 먼저 'none'(+namePending: 주소 찾는 중)으로
 *   보내고 주소를 찾으면 그 주소로 한 번 더 보낸다('address'). 못 찾으면 namePending 만 뗀 'none'.
 *   부모는 namePending 인 동안 확정을 막는다(찾을 수 있었던 주소 대신 빈 이름이 폼에 들어가지 않게).
 *   약속 잡기 폼이 이 출처로 이름 칸 채우기를 가른다.
 * - 거리 직접 적기(radiusOptions.custom.open)인 동안은 검색창·주소 줄을 접는다(키보드가 올라와도 지도·원·칩이 보이게).
 * - 반경: radiusM 이 숫자면 핀 둘레 원, null 이면 원 없음(모임 약속). radiusOptions 가 있으면 지도 아래 거리 칩 줄 —
 *   고르면 원이 바로 바뀌고, 원이 잘리거나 점처럼 작으면 반경의 2.5배가 보이게 줌을 맞춘다(radiusRefitRegion).
 * - 핀은 사용자가 지도를 만졌거나 검색 결과·[현재 위치로]를 눌렀을 때만 정해진다(첫 화면이 저절로 핀이 되지 않게).
 *
 * 권한: 이 화면은 권한을 스스로 묻지 않는다. [현재 위치로]를 누르거나(안드로이드) 주소 검색을 할 때만 OS 프롬프트를 띄운다.
 * 위치 구독(watch)은 하지 않는다 — 한 번 읽기만. 지도의 파란 점(showsUserLocation)은 권한이 이미 있을 때만 켠다
 * (iOS 는 showsUserLocation 이 켜지면 권한을 묻기 때문).
 *
 * 확정 버튼은 부모(app/late/place.tsx)가 그린다 — 이 컴포넌트는 핀이 바뀔 때마다 onChange 만 부른다.
 * 부모는 placePickerUsesMap() 이 true 면 스크롤 없는 화면에 넣는다(스크롤 안의 지도는 제스처를 빼앗긴다).
 */
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapView, { Circle, PROVIDER_DEFAULT, PROVIDER_GOOGLE, type Details, type Region } from 'react-native-maps';

import type { GeoPoint } from '@/domain/geo';
import { getLocationPermission, openAppSettings, requestLocationPermission } from '@/lateBet/permissions';
import { formatPlaceDistance, hasKakaoKey, searchPlaces, type PlaceSearchResult } from '@/lateBet/placeSearch';

import { PrimaryButton, SectionTitle } from './components';
import { alertDialog, confirmDialog } from './dialogs';
import { HAS_EMBEDDED_GOOGLE_MAPS_KEY } from './googleMapsKey';
// 타입 전용 import 는 번들에서 지워진다(Metro 는 이 파일로 다시 resolve 하지 않는다). tsc 는 PlacePicker.tsx 로 resolve 해
// 두 구현의 export 모양이 같은지 확인한다.
import type * as WebPicker from './PlacePicker';
import { PlacePickerFallback, RadiusChips } from './PlacePickerFallback';
import {
  DEFAULT_CENTER,
  FRAMING_RADIUS_M,
  formatNearestAddress,
  isUsableRadius,
  geocoderNeedsPermission,
  nameForCenter,
  pickerPermissionFromStatus,
  pinLimitStatus,
  placeSearchMode,
  radiusRefitRegion,
  regionAround,
  regionCenter,
  ROUGH_FIX_M,
  isNamePending,
  settleNearestName,
  shouldEmitCenter,
  usesNativeMap,
  type MapRegion,
  type PickerPermission,
  type PlaceSearchMode,
} from './placePickerModel';
import { limitExceededText, type PlacePickerProps, type PlacePickerValue } from './placePickerShared';
import { colors, fontSize, radius, spacing } from './theme';

export { limitExceededText, openPlaceDraft, readPlaceDraft, setPlaceResult, takePlaceResult } from './placePickerShared';
export type {
  PlaceDraft,
  PlaceNameSource,
  PlacePickerProps,
  PlacePickerValue,
  PlaceRadiusOptions,
  PlaceRadiusCustom,
  PlaceResult,
  PlaceResultOwner,
} from './placePickerShared';

/** 바이너리에 박힌 키 유무(OTA 로 바뀌지 않는다) */
const HAS_GOOGLE_MAPS_KEY = HAS_EMBEDDED_GOOGLE_MAPS_KEY;
const USES_MAP = usesNativeMap(Platform.OS, HAS_GOOGLE_MAPS_KEY);
const HAS_KAKAO_KEY = hasKakaoKey();

/** [현재 위치로]: 새로 재는 데 기다리는 최대 시간 */
const FIX_TIMEOUT_MS = 10_000;
/** geocodeAsync·reverseGeocodeAsync 가 멈춰 있을 때 포기하는 시간 */
const GEOCODE_TIMEOUT_MS = 8_000;
/** 핀이 멈춘 뒤 주소를 찾기까지 기다리는 시간(연속 이동 중 호출 폭주 방지 — iOS 지오코더는 호출 수 제한이 있다) */
const ADDRESS_DEBOUNCE_MS = 700;
/** 주소 '찾는 중'이 이보다 길면 표시를 뗀다(디바운스 + 조회 제한 시간 + 여유) — 확정 버튼이 영영 막히지 않게 */
const NAME_PENDING_MAX_MS = ADDRESS_DEBOUNCE_MS + GEOCODE_TIMEOUT_MS + 1_500;
const ANIMATE_MS = 500;

const NOT_FOUND_ON_MAP = '찾지 못했어요. 지도를 움직여 핀을 맞춰주세요';
const NOT_FOUND_ON_FORM = '찾지 못했어요. 아래에서 장소를 고르거나 위도·경도를 적어주세요';
const SEARCH_HIDDEN_ON_MAP = '위치 권한이 없어 장소 검색을 쓸 수 없어요. 지도를 움직여 핀을 맞춰주세요';
const SEARCH_HIDDEN_ON_FORM = '위치 권한이 없어 장소 검색을 쓸 수 없어요. 아래에서 고르거나 위도·경도를 적어주세요';
const ROUGH_FIX_NOTICE = '대략적인 위치예요. 지도를 움직여 핀을 정확히 맞춰주세요';
const NO_MAP_ON_THIS_DEVICE = '이 기기에서는 지도를 띄울 수 없어 목록으로 정해요';

// ───────────────────────── expo-location 얇은 감싸기 ─────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// 권한 읽기·요청·설정 열기는 약속 화면과 같은 공용 모듈(@/lateBet/permissions → Metro 가 .native 를 고른다)을 쓴다.

/** 지금 권한(프롬프트 없음) */
async function readPermission(): Promise<PickerPermission> {
  return pickerPermissionFromStatus((await getLocationPermission()).status);
}

/** 권한 요청. 이미 거부돼 다시 물을 수 없으면 프롬프트 없이 prompted=false */
async function askPermission(): Promise<{ permission: PickerPermission; prompted: boolean }> {
  const cur = await getLocationPermission();
  if (cur.status === 'granted') return { permission: 'granted', prompted: false };
  // 영구 거부(blocked)·사용 불가(unavailable)는 프롬프트를 띄울 수 없다
  if (!cur.canAskAgain || cur.status === 'blocked' || cur.status === 'unavailable') {
    return { permission: pickerPermissionFromStatus(cur.status), prompted: false };
  }
  return { permission: pickerPermissionFromStatus((await requestLocationPermission()).status), prompted: true };
}

function openSettingsDialog(message: string): void {
  confirmDialog(
    '위치 권한이 꺼져 있어요',
    message,
    () => {
      void openAppSettings().then((opened) => {
        if (!opened) alertDialog('설정을 열 수 없어요');
      });
    },
    { confirmText: '설정 열기' },
  );
}

interface Fix {
  point: GeoPoint;
  accuracyM: number | null;
}

function toFix(loc: Location.LocationObject | null): Fix | null {
  if (!loc) return null;
  const point = regionCenter({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
  if (!point) return null;
  const acc = loc.coords.accuracy;
  return { point, accuracyM: typeof acc === 'number' && Number.isFinite(acc) && acc >= 0 ? acc : null };
}

/** 현재 위치 한 번: 1분 안·50m 안의 마지막 위치가 있으면 그것, 없으면 새로 잰다(최대 10초). 실패하면 null */
async function readCurrentFix(): Promise<Fix | null> {
  try {
    const last = toFix(await Location.getLastKnownPositionAsync({ maxAge: 60_000, requiredAccuracy: 50 }));
    if (last) return last;
  } catch {
    // 새로 잰다
  }
  try {
    return toFix(await withTimeout(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }), FIX_TIMEOUT_MS));
  } catch {
    return null;
  }
}

/** 권한이 이미 있을 때 지도 첫 화면을 내 근처로(빠른 값만, 기다리지 않는다) */
async function readQuickFix(): Promise<Fix | null> {
  try {
    return toFix(await Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000, requiredAccuracy: 1_000 }));
  } catch {
    return null;
  }
}

const geocodeWithDevice = (q: string) => withTimeout(Location.geocodeAsync(q), GEOCODE_TIMEOUT_MS);

// ───────────────────────── 훅 ─────────────────────────

/** 위치 권한 상태 + 사용자 동작에서만 부르는 요청. 앱으로 돌아오면(설정에서 바꿨을 수 있다) 다시 읽는다 */
function useLocationPermission() {
  const [permission, setPermission] = useState<PickerPermission>('undetermined');
  const permissionRef = useRef<PickerPermission>('undetermined');
  const alive = useRef(true);

  const apply = useCallback((p: PickerPermission) => {
    if (!alive.current) return;
    permissionRef.current = p;
    setPermission(p);
  }, []);

  useEffect(() => {
    alive.current = true;
    void readPermission().then(apply);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void readPermission().then(apply);
    });
    return () => {
      alive.current = false;
      sub.remove();
    };
  }, [apply]);

  /** OS 프롬프트(가능할 때). 다시 물을 수 없게 거부돼 있으면 설정 안내. 허용되면 true */
  const ask = useCallback(
    async (settingsMessage: string): Promise<boolean> => {
      const r = await askPermission();
      apply(r.permission);
      if (r.permission === 'granted') return true;
      if (!r.prompted && alive.current) openSettingsDialog(settingsMessage);
      return false;
    },
    [apply],
  );

  return { permission, permissionRef, ask };
}

/**
 * 핀에서 가장 가까운 주소 한 줄. 핀이 멈추고 잠시 뒤에 찾는다. 안드로이드는 권한이 없으면 부르지 않는다. 실패하면 ''.
 * settled = 지금 핀 좌표의 조회가 끝났는가(성공·실패 모두) — 주소를 찾는 동안 확정을 막는 표시(namePending)를 뗄 때 쓴다
 */
function useNearestAddress(
  value: PlacePickerValue | null,
  permission: PickerPermission,
  paused: boolean,
): { text: string; settled: boolean } {
  const [address, setAddress] = useState<{ key: string; text: string }>({ key: '', text: '' });
  // 이미 찾은 핀은 다시 묻지 않는다(지도를 만졌다 제자리에 놓아도 호출이 늘지 않게)
  const fetchedKey = useRef('');
  const lat = value?.lat ?? null;
  const lng = value?.lng ?? null;
  const key = lat === null || lng === null ? '' : `${lat},${lng}`;
  const allowed = !geocoderNeedsPermission(Platform.OS, permission);

  useEffect(() => {
    if (lat === null || lng === null || !allowed || paused) return;
    const k = `${lat},${lng}`;
    if (fetchedKey.current === k) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      withTimeout(Location.reverseGeocodeAsync({ latitude: lat, longitude: lng }), GEOCODE_TIMEOUT_MS)
        .then((list) => {
          if (cancelled) return;
          fetchedKey.current = k;
          setAddress({ key: k, text: formatNearestAddress(list[0]) });
        })
        .catch(() => {
          if (cancelled) return;
          fetchedKey.current = k;
          setAddress({ key: k, text: '' });
        });
    }, ADDRESS_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lat, lng, allowed, paused]);

  // 핀이 바뀐 뒤 새 주소가 오기 전에는 옛 주소를 보이지 않는다
  const settled = key !== '' && address.key === key;
  return { text: settled && allowed ? address.text : '', settled };
}

/** [현재 위치로]: 권한 → 한 번 읽기. 성공하면 onFix */
function useGoToMe(ask: (msg: string) => Promise<boolean>, onFix: (fix: Fix) => void) {
  const [locating, setLocating] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const ok = await ask('설정에서 위치를 허용하면 현재 위치로 핀을 옮길 수 있어요. 지도를 움직여 핀을 맞춰도 돼요.');
      if (!ok || !alive.current) return;
      setLocating(true);
      const fix = await readCurrentFix();
      if (!alive.current) return;
      setLocating(false);
      if (!fix) {
        alertDialog('현재 위치를 찾지 못했어요', '위치 서비스가 켜져 있는지 확인하고, 건물 밖이나 창가에서 다시 눌러주세요.');
        return;
      }
      onFix(fix);
    } finally {
      busy.current = false;
      if (alive.current) setLocating(false);
    }
  }, [ask, onFix]);

  return { locating, run };
}

// ───────────────────────── 검색창 ─────────────────────────

interface SearchBoxProps {
  mode: Exclude<PlaceSearchMode, 'hidden'>;
  initialQuery: string;
  /** 근처 우선 검색의 기준(지도 중심·지금 핀). 모르면 null */
  near: GeoPoint | null;
  /** geocoder 를 써도 되는가. interactive=true 면(주소 검색 모드) 안드로이드에서 권한을 물어도 된다 */
  prepareGeocoder: (interactive: boolean) => Promise<boolean>;
  onPick: (r: PlaceSearchResult) => void;
  emptyText: string;
  /** 지도 화면: 결과를 높이 제한된 스크롤로. 폼 화면: 그냥 나열(바깥이 스크롤) */
  scrollResults: boolean;
}

function PlaceSearchBox({ mode, initialQuery, near, prepareGeocoder, onPick, emptyText, scrollResults }: SearchBoxProps) {
  const [query, setQuery] = useState(initialQuery);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<PlaceSearchResult[] | null>(null);
  const seq = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      seq.current += 1; // 진행 중인 검색 결과를 버린다
    };
  }, []);

  const canSubmit = query.trim() !== '' && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    Keyboard.dismiss();
    const mine = ++seq.current;
    setBusy(true);
    setResults(null);
    try {
      // 카카오 모드의 geocoder 는 폴백일 뿐이라 권한을 새로 묻지 않는다(이미 허용돼 있을 때만 쓴다)
      const geocoderOk = await prepareGeocoder(mode === 'geocoder');
      const found = await searchPlaces(query, near, { geocode: geocoderOk ? geocodeWithDevice : null });
      if (mine !== seq.current || !alive.current) return;
      setResults(found);
    } finally {
      if (mine === seq.current && alive.current) setBusy(false);
    }
  };

  const pick = (r: PlaceSearchResult) => {
    setResults(null);
    onPick(r);
  };

  const rows =
    results && results.length > 0
      ? results.map((r) => {
          const dist = formatPlaceDistance(r.distanceM);
          const sub = r.address || (r.source === 'geocoder' ? '주소로 찾은 위치' : '');
          return (
            <Pressable
              key={r.id}
              onPress={() => pick(r)}
              accessibilityRole="button"
              accessibilityLabel={[r.name, sub, dist].filter((s) => s !== '').join(', ')}
              style={({ pressed }) => [styles.resultRow, pressed && { opacity: 0.7 }]}
            >
              <View style={styles.resultTop}>
                <Text style={styles.resultName} numberOfLines={1}>
                  {r.name}
                </Text>
                {dist !== '' ? <Text style={styles.resultDist}>{dist}</Text> : null}
              </View>
              {sub !== '' ? (
                <Text style={styles.resultSub} numberOfLines={1}>
                  {sub}
                </Text>
              ) : null}
            </Pressable>
          );
        })
      : null;

  return (
    <View style={styles.searchWrap}>
      <View style={styles.searchRow}>
        <View style={styles.inputWrap}>
          <TextInput
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            placeholder={mode === 'kakao' ? '장소·주소 검색 (예: 강남역 2번 출구)' : '주소 검색 (예: 서울 강남구 테헤란로 152)'}
            placeholderTextColor={colors.subtext}
            returnKeyType="search"
            onSubmitEditing={() => void submit()}
            autoCorrect={false}
            clearButtonMode="while-editing"
            accessibilityLabel="장소 검색"
          />
        </View>
        <Pressable
          onPress={() => void submit()}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityLabel="검색"
          style={({ pressed }) => [styles.searchButton, !canSubmit && { opacity: 0.4 }, pressed && canSubmit && { opacity: 0.75 }]}
        >
          {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.searchButtonLabel}>검색</Text>}
        </Pressable>
      </View>

      {results !== null ? (
        <View style={styles.resultsBox}>
          {rows ? (
            scrollResults ? (
              <ScrollView style={styles.resultsScroll} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                {rows}
              </ScrollView>
            ) : (
              rows
            )
          ) : (
            <Text style={styles.resultsEmpty}>{emptyText}</Text>
          )}
          <Pressable onPress={() => setResults(null)} accessibilityRole="button" style={styles.resultsClose}>
            <Text style={styles.resultsCloseLabel}>닫기</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

// ───────────────────────── 지도 방식 ─────────────────────────

function MapPicker({ value, radiusM, radiusOptions, placeName, onChange, limitCenter, limitRadiusM }: PlacePickerProps) {
  const mapRef = useRef<MapView>(null);
  const { permission, permissionRef, ask } = useLocationPermission();
  // 주소를 찾을 수 있는가(안드로이드는 위치 권한이 있어야 한다). 콜백 안에서도 최신 값을 보게 ref 로도 둔다
  const addressPossible = !geocoderNeedsPermission(Platform.OS, permission);
  const addressPossibleRef = useRef(addressPossible);
  addressPossibleRef.current = addressPossible;
  // 거리를 직접 적는 중이면 검색창·주소 줄을 접는다(키보드가 올라와도 지도·원·칩이 보이게)
  const typingRadius = radiusOptions?.custom?.open === true && radiusOptions.locked !== true;
  // 원 반경(null = 원 없음, 모임 약속). 확대 수준은 원이 없어도 동네 몇 블록으로 잡는다
  const circleRadius = isUsableRadius(radiusM) ? radiusM : null;
  const framingRadius = circleRadius ?? FRAMING_RADIUS_M;
  // 옮길 수 있는 한도(시작한 약속의 장소 바꾸기, R2). 있으면 첫 화면이 한도 원 전체를 담게 넓게 잡는다
  const limit =
    limitCenter && typeof limitRadiusM === 'number' && Number.isFinite(limitRadiusM) && limitRadiusM > 0
      ? { center: limitCenter, radiusM: limitRadiusM }
      : null;

  const [initialRegion] = useState<Region>(() =>
    value
      ? regionAround({ lat: value.lat, lng: value.lng }, limit ? Math.max(framingRadius, limit.radiusM) : framingRadius)
      : regionAround(limit ? limit.center : DEFAULT_CENTER, limit ? limit.radiusM : undefined),
  );
  // 반경 원의 중심 = 마지막으로 멈춘 지도 중심
  const [center, setCenter] = useState<GeoPoint>(() => (value ? { lat: value.lat, lng: value.lng } : DEFAULT_CENTER));
  const centerRef = useRef(center);
  centerRef.current = center;
  const [moving, setMoving] = useState(false);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // 사용자가 지도를 만졌는가 — 만지기 전에는 지도가 멈춰도 핀을 만들지 않는다
  const interacted = useRef(false);
  // 콜백 안에서 쓸 최신 값
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // 검색·프리셋으로 고른 장소(그 근처에서 미세 조정하면 이름을 유지한다). 주소로 채운 이름은 여기 넣지 않는다
  const picked = useRef<{ name: string; lat: number; lng: number } | null>(
    value?.name && value.nameSource !== 'address' && value.nameSource !== 'none'
      ? { name: value.name, lat: value.lat, lng: value.lng }
      : null,
  );
  // 마지막으로 멈춘 지도 영역(반경을 바꿀 때 원이 알맞게 보이는지 판단)
  const lastRegion = useRef<MapRegion | null>(initialRegion);

  const moveTo = useCallback(
    (p: GeoPoint) => {
      setCenter(p);
      mapRef.current?.animateToRegion(regionAround(p, framingRadius), ANIMATE_MS);
    },
    [framingRadius],
  );

  // 칩으로 반경을 바꾸면: 원은 prop 으로 바로 바뀐다. 원이 잘리거나 점처럼 작아지면 줌만 맞춘다(핀은 그대로)
  const prevRadius = useRef(circleRadius);
  useEffect(() => {
    if (prevRadius.current === circleRadius) return;
    prevRadius.current = circleRadius;
    if (!ready || circleRadius === null) return;
    const cur = valueRef.current;
    const focus = cur ? { lat: cur.lat, lng: cur.lng } : centerRef.current;
    const next = radiusRefitRegion(lastRegion.current, focus, circleRadius);
    if (next) mapRef.current?.animateToRegion(next, ANIMATE_MS);
  }, [circleRadius, ready]);

  // 핀이 없고 권한이 이미 있으면 첫 화면을 내 근처로(핀은 만들지 않는다)
  const autoCentered = useRef(false);
  useEffect(() => {
    if (!ready || autoCentered.current || valueRef.current || permission !== 'granted') return;
    autoCentered.current = true;
    let cancelled = false;
    void readQuickFix().then((fix) => {
      if (cancelled || !fix || interacted.current || valueRef.current) return;
      moveTo(fix.point);
    });
    return () => {
      cancelled = true;
    };
  }, [ready, permission, moveTo]);

  const onRegionChangeComplete = useCallback((region: Region, details: Details) => {
    setMoving(false);
    lastRegion.current = region;
    const c = regionCenter(region);
    if (!c) return;
    setCenter(c);
    if (details?.isGesture === true) interacted.current = true;
    const current = valueRef.current;
    if (!shouldEmitCenter(interacted.current, c, current ? { lat: current.lat, lng: current.lng } : null)) return;
    const name = nameForCenter(picked.current, c);
    if (!name) picked.current = null;
    setNotice(null);
    // 검색으로 고른 곳 근처면 그 이름, 아니면 이름 없이 먼저 보내고 주소를 찾으면 다시 보낸다(아래 effect).
    // 주소를 찾을 수 있으면 '찾는 중'(namePending)을 붙인다 — 그동안 부모는 확정을 막는다
    onChangeRef.current(
      name
        ? { lat: c.lat, lng: c.lng, name, nameSource: 'search' }
        : { lat: c.lat, lng: c.lng, nameSource: 'none', ...(addressPossibleRef.current ? { namePending: true } : {}) },
    );
  }, []);

  const onPick = useCallback(
    (r: PlaceSearchResult) => {
      const p = regionCenter({ latitude: r.lat, longitude: r.lng });
      if (!p) return;
      interacted.current = true;
      picked.current = { name: r.name, lat: p.lat, lng: p.lng };
      setNotice(null);
      onChangeRef.current({ lat: p.lat, lng: p.lng, name: r.name, nameSource: 'search' });
      moveTo(p);
    },
    [moveTo],
  );

  const onFix = useCallback(
    (fix: Fix) => {
      interacted.current = true;
      picked.current = null;
      onChangeRef.current({
        lat: fix.point.lat,
        lng: fix.point.lng,
        nameSource: 'none',
        ...(addressPossibleRef.current ? { namePending: true } : {}),
      });
      moveTo(fix.point);
      setNotice(fix.accuracyM === null || fix.accuracyM > ROUGH_FIX_M ? ROUGH_FIX_NOTICE : null);
    },
    [moveTo],
  );
  const me = useGoToMe(ask, onFix);

  const prepareGeocoder = useCallback(
    async (interactive: boolean) => {
      if (!geocoderNeedsPermission(Platform.OS, permissionRef.current)) return true;
      if (!interactive) return false;
      return ask('설정에서 위치를 허용하면 주소로 검색할 수 있어요. 지도를 움직여 핀을 맞춰도 돼요.');
    },
    [ask, permissionRef],
  );

  const mode = placeSearchMode(Platform.OS, HAS_KAKAO_KEY, permission);
  const lookup = useNearestAddress(value, permission, moving);
  const address = lookup.text;
  // 지도를 움직여 이름 없이 보낸 핀에 주소가 도착하면 그 주소를 이름으로 다시 보낸다(nameSource 'address').
  // 조회가 끝났는데 주소가 없으면(실패) '찾는 중' 표시만 떼어 다시 보낸다 — 확정 버튼이 풀린다
  useEffect(() => {
    const next = settleNearestName(value, lookup, addressPossible);
    if (next) onChangeRef.current(next);
  }, [value, lookup.text, lookup.settled, addressPossible]); // eslint-disable-line react-hooks/exhaustive-deps
  // 안전판: 조회가 어떤 이유로든 끝나지 않으면(지도가 멈춘 채 이벤트를 놓침 등) 제한 시간 뒤 '찾는 중'을 뗀다
  const pending = isNamePending(value);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      const next = settleNearestName(valueRef.current, { text: '', settled: true }, false);
      if (next && isNamePending(valueRef.current)) onChangeRef.current(next);
    }, NAME_PENDING_MAX_MS);
    return () => clearTimeout(timer);
  }, [pending, value?.lat, value?.lng]);
  const near = value ? { lat: value.lat, lng: value.lng } : center;
  const overLimit = limit !== null && pinLimitStatus(value, limit.center, limit.radiusM).over;
  const bubble = overLimit && limit ? limitExceededText(limit.radiusM) : (notice ?? (!value ? '지도를 움직여 핀을 약속 장소에 맞춰주세요' : null));

  return (
    <View style={styles.mapRoot}>
      {typingRadius ? null : mode === 'hidden' ? (
        <Text style={styles.help}>{SEARCH_HIDDEN_ON_MAP}</Text>
      ) : (
        <PlaceSearchBox
          mode={mode}
          initialQuery={(placeName ?? '').trim()}
          near={near}
          prepareGeocoder={prepareGeocoder}
          onPick={onPick}
          emptyText={NOT_FOUND_ON_MAP}
          scrollResults
        />
      )}

      <View style={styles.mapWrap}>
        {/* 지도 자체를 만졌을 때만 '사용자가 옮겼다'로 본다(위에 얹은 [현재 위치로] 버튼 터치는 형제라 여기로 오지 않는다) */}
        <View
          style={StyleSheet.absoluteFill}
          onTouchStart={() => {
            interacted.current = true;
          }}
        >
          <MapView
            ref={mapRef}
            style={StyleSheet.absoluteFill}
            provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
            initialRegion={initialRegion}
            onMapReady={() => setReady(true)}
            onRegionChangeStart={() => setMoving(true)}
            onRegionChangeComplete={onRegionChangeComplete}
            showsUserLocation={permission === 'granted'}
            showsMyLocationButton={false}
            showsCompass={false}
            toolbarEnabled={false}
            pitchEnabled={false}
            rotateEnabled={false}
            moveOnMarkerPress={false}
            loadingEnabled
            loadingBackgroundColor={colors.cardAlt}
            loadingIndicatorColor={colors.text}
            userInterfaceStyle="light"
            accessibilityLabel="약속 장소 지도. 지도를 움직이면 가운데 핀이 약속 장소가 돼요"
          >
            {limit ? (
              // 한도 원: 이 안으로만 핀을 옮길 수 있다(점선, 채우지 않음)
              <Circle
                center={{ latitude: limit.center.lat, longitude: limit.center.lng }}
                radius={limit.radiusM}
                strokeColor={colors.subtext}
                strokeWidth={1.5}
                lineDashPattern={[6, 6]}
                fillColor="transparent"
              />
            ) : null}
            {!moving && circleRadius !== null ? (
              <Circle
                center={{ latitude: center.lat, longitude: center.lng }}
                radius={circleRadius}
                strokeColor={colors.text}
                strokeWidth={1.5}
                fillColor={colors.primaryDim}
              />
            ) : null}
          </MapView>
        </View>

        {/* 화면 중앙 고정 핀 — 끝(아래 꼭짓점)이 정확히 지도 중심에 온다 */}
        <View pointerEvents="none" style={styles.pinLayer}>
          <View style={styles.pinBase} />
        </View>
        <View pointerEvents="none" style={styles.pinLayer}>
          <View style={styles.pin}>
            <View style={styles.pinHead}>
              <View style={styles.pinDot} />
            </View>
            <View style={styles.pinStem} />
          </View>
        </View>

        {/* 안내는 지도 위 말풍선으로 — 지도 아래에 줄이 생겼다 없어지면 지도 높이가 흔들린다 */}
        {bubble !== null ? (
          <View pointerEvents="none" style={styles.hintBubbleWrap}>
            <Text style={styles.hintBubble}>{bubble}</Text>
          </View>
        ) : null}

        <Pressable
          onPress={() => void me.run()}
          disabled={me.locating}
          accessibilityRole="button"
          accessibilityLabel="현재 위치로"
          style={({ pressed }) => [styles.meButton, pressed && { opacity: 0.75 }]}
        >
          {me.locating ? <ActivityIndicator color={colors.text} /> : <Text style={styles.meButtonLabel}>현재 위치로</Text>}
        </Pressable>
      </View>

      {radiusOptions ? <RadiusChips options={radiusOptions} radiusM={circleRadius} scroll /> : null}

      {/* 주소를 찾을 수 있는 동안은 한 줄 자리를 늘 잡아 둔다(주소가 오갈 때 지도 높이가 흔들리지 않게). 실패하면 빈 줄 */}
      {value && addressPossible && !typingRadius ? (
        <Text style={styles.address} numberOfLines={1}>
          {address !== '' ? `핀에서 가장 가까운 주소 · ${address}` : ' '}
        </Text>
      ) : null}
    </View>
  );
}

// ───────────────────────── 지도 없는 방식(안드로이드 구글 지도 키 없음) ─────────────────────────

function FormPicker(props: PlacePickerProps) {
  const { value, placeName, onChange } = props;
  const { permission, permissionRef, ask } = useLocationPermission();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [notice, setNotice] = useState<string | null>(null);

  const onPick = useCallback((r: PlaceSearchResult) => {
    const p = regionCenter({ latitude: r.lat, longitude: r.lng });
    if (!p) return;
    setNotice(null);
    onChangeRef.current({ lat: p.lat, lng: p.lng, name: r.name, nameSource: 'search' });
  }, []);

  const onFix = useCallback((fix: Fix) => {
    // 이름 칸에 적어 둔 이름이 있으면 PlacePickerFallback 이 붙여 다시 보낸다
    onChangeRef.current({ lat: fix.point.lat, lng: fix.point.lng, nameSource: 'none' });
    setNotice(fix.accuracyM === null || fix.accuracyM > ROUGH_FIX_M ? '대략적인 위치예요. 위도·경도를 확인해 주세요' : null);
  }, []);
  const me = useGoToMe(ask, onFix);

  const prepareGeocoder = useCallback(
    async (interactive: boolean) => {
      if (!geocoderNeedsPermission(Platform.OS, permissionRef.current)) return true;
      if (!interactive) return false;
      return ask('설정에서 위치를 허용하면 주소로 검색할 수 있어요. 아래에서 고르거나 위도·경도를 적어도 돼요.');
    },
    [ask, permissionRef],
  );

  const mode = placeSearchMode(Platform.OS, HAS_KAKAO_KEY, permission);
  const address = useNearestAddress(value, permission, false).text;

  const header = (
    <View style={styles.formHeader}>
      <SectionTitle>장소 찾기</SectionTitle>
      {mode === 'hidden' ? (
        <Text style={styles.help}>{SEARCH_HIDDEN_ON_FORM}</Text>
      ) : (
        <PlaceSearchBox
          mode={mode}
          initialQuery={(placeName ?? '').trim()}
          near={value ? { lat: value.lat, lng: value.lng } : null}
          prepareGeocoder={prepareGeocoder}
          onPick={onPick}
          emptyText={NOT_FOUND_ON_FORM}
          scrollResults={false}
        />
      )}
      <PrimaryButton
        label={me.locating ? '현재 위치를 찾는 중…' : '현재 위치로 정하기'}
        variant="ghost"
        onPress={() => void me.run()}
        disabled={me.locating}
      />
      {notice ? <Text style={styles.help}>{notice}</Text> : null}
      {value && address !== '' ? (
        <Text style={styles.address} numberOfLines={2}>
          핀에서 가장 가까운 주소 · {address}
        </Text>
      ) : null}
    </View>
  );

  return <PlacePickerFallback {...props} header={header} topNote={NO_MAP_ON_THIS_DEVICE} />;
}

// ───────────────────────── export (PlacePicker.tsx 와 같은 모양) ─────────────────────────

/** 안드로이드에 구글 지도 키가 없으면 false(폼 방식) — 부모는 스크롤 화면에 넣는다 */
export const placePickerUsesMap: typeof WebPicker.placePickerUsesMap = () => USES_MAP;

export const PlacePicker: typeof WebPicker.PlacePicker = function PlacePicker(props: PlacePickerProps) {
  return USES_MAP ? <MapPicker {...props} /> : <FormPicker {...props} />;
};

// ───────────────────────── 스타일 (theme 토큰만) ─────────────────────────

const PIN_HEAD = 22;
const PIN_STEM = 12;
const PIN_HEIGHT = PIN_HEAD + PIN_STEM;

const styles = StyleSheet.create({
  mapRoot: { flex: 1, gap: spacing.sm },
  formHeader: { gap: spacing.sm },
  help: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  address: { fontSize: fontSize.sm, color: colors.text, lineHeight: 20, minHeight: 20 },

  // 검색창 — components.TextField 와 같은 모양(검색 키·지우기 버튼 때문에 TextInput 을 직접 쓴다)
  searchWrap: { gap: spacing.sm, flexShrink: 1 },
  searchRow: { flexDirection: 'row', alignItems: 'stretch', gap: spacing.sm },
  inputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
  },
  input: { flex: 1, paddingVertical: 12, fontSize: fontSize.md, color: colors.text },
  searchButton: {
    minWidth: 64,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchButtonLabel: { color: colors.onPrimary, fontSize: fontSize.md, fontWeight: '800' },
  resultsBox: {
    flexShrink: 1,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  resultsScroll: { maxHeight: 220 },
  resultRow: {
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 2,
  },
  resultTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  resultName: { flexShrink: 1, fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  resultDist: { marginLeft: 'auto', fontSize: fontSize.sm, color: colors.subtext },
  resultSub: { fontSize: fontSize.sm, color: colors.subtext },
  resultsEmpty: { padding: spacing.md, fontSize: fontSize.sm, color: colors.text, lineHeight: 20 },
  resultsClose: { alignSelf: 'flex-end', paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  resultsCloseLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.subtext },

  // 지도
  mapWrap: {
    flex: 1,
    // 키보드가 올라오면 지도가 줄어든다(검색창은 위에 있어 가려지지 않는다)
    minHeight: 120,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.cardAlt,
    overflow: 'hidden',
  },
  pinLayer: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  // 가운데 정렬된 상자에 자기 높이만큼 아래 여백을 주면 상자 아래 끝이 정확히 중심에 온다
  pin: { alignItems: 'center', marginBottom: PIN_HEIGHT },
  pinHead: {
    width: PIN_HEAD,
    height: PIN_HEAD,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    borderWidth: 2,
    borderColor: colors.onPrimary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinDot: { width: 6, height: 6, borderRadius: radius.pill, backgroundColor: colors.onPrimary },
  pinStem: { width: 2, height: PIN_STEM, backgroundColor: colors.primary },
  pinBase: { width: 8, height: 4, borderRadius: radius.pill, backgroundColor: colors.primary, opacity: 0.35 },
  hintBubbleWrap: { position: 'absolute', top: spacing.md, left: spacing.md, right: spacing.md, alignItems: 'center' },
  hintBubble: {
    overflow: 'hidden',
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.text,
  },
  meButton: {
    position: 'absolute',
    right: spacing.md,
    bottom: spacing.md,
    minHeight: 36,
    minWidth: 96,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  meButtonLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text },
});
