/**
 * 위치 권한 해석 — 순수 함수(permissions.native.ts 와 useArrivalReporter 가 쓴다, 테스트 있음).
 *
 * expo-location 의 LocationPermissionResponse(node_modules/expo-location/build/Location.types.d.ts)
 *   = PermissionResponse{ status: 'granted'|'undetermined'|'denied', granted, canAskAgain, expires }
 *     & { ios?: { scope: 'whenInUse'|'always'|'none' }, android?: { accuracy: 'fine'|'coarse'|'none' } }
 * 를 앱의 LocationPermissionState 로 옮긴다.
 *
 * - blocked = 거부 ∧ canAskAgain=false (OS 프롬프트를 다시 띄울 수 없다 → [설정 열기])
 * - precise: 안드로이드는 android.accuracy 로 안다(coarse → false). iOS 는 권한 응답에 '정확한 위치' 여부가 없다
 *   (expo-location 19 의 iOS 요청기는 scope 만 준다) → null. iOS 의 '정확한 위치 끔'은 샘플 정확도(1000m 초과)로 잡는다.
 */
export type LocationPermissionStatus = 'granted' | 'denied' | 'undetermined' | 'blocked' | 'unavailable';

export interface LocationPermissionState {
  status: LocationPermissionStatus;
  /** 정확한 위치 허용 여부. 모르면 null(iOS · 권한 없음) */
  precise: boolean | null;
  /** OS 프롬프트를 다시 띄울 수 있는가 */
  canAskAgain: boolean;
}

/** 위치를 쓸 수 없는 환경(웹·앱인토스·테스트) */
export const UNAVAILABLE_PERMISSION: LocationPermissionState = Object.freeze({
  status: 'unavailable',
  precise: null,
  canAskAgain: false,
});

/** expo-location 응답의 필요한 부분만(구조 타입) */
export interface LocationPermissionResponseLike {
  status: string;
  granted?: boolean;
  canAskAgain?: boolean;
  android?: { accuracy?: string } | null;
  ios?: { scope?: string } | null;
}

export function toPermissionState(res: LocationPermissionResponseLike | null | undefined): LocationPermissionState {
  if (!res) return UNAVAILABLE_PERMISSION;
  const canAskAgain = res.canAskAgain !== false;
  const granted = res.granted === true || res.status === 'granted';
  if (granted) {
    const acc = res.android?.accuracy;
    const precise = acc === 'fine' ? true : acc === 'coarse' ? false : null;
    return { status: 'granted', precise, canAskAgain };
  }
  if (res.status === 'undetermined') return { status: canAskAgain ? 'undetermined' : 'blocked', precise: null, canAskAgain };
  // denied(또는 모르는 값)
  return { status: canAskAgain ? 'denied' : 'blocked', precise: null, canAskAgain };
}

/**
 * 화면용 한 단어(ArrivalReporter.permission). 기존 계약: 'granted' | 'coarse' | 'denied' | 'undetermined' | 'unsupported'.
 * blocked 는 'denied' 로 접는다(화면은 canAskAgain 으로 [위치 허용하기]/[설정 열기]를 가른다).
 * sampleCoarse = 허용은 됐는데 샘플 정확도가 1000m 를 넘는다(iOS '정확한 위치' 끔) → 'coarse'.
 */
export type ReporterPermission = 'granted' | 'coarse' | 'denied' | 'undetermined' | 'unsupported';

export function toReporterPermission(state: LocationPermissionState | null, sampleCoarse = false): ReporterPermission {
  if (!state) return 'undetermined';
  switch (state.status) {
    case 'granted':
      return state.precise === false || sampleCoarse ? 'coarse' : 'granted';
    case 'undetermined':
      return 'undetermined';
    case 'denied':
    case 'blocked':
      return 'denied';
    default:
      return 'unsupported';
  }
}

/** 위치를 읽어도 되는가(정확하든 대략적이든 허용) */
export function canReadLocation(state: LocationPermissionState | null): boolean {
  return state !== null && state.status === 'granted';
}
