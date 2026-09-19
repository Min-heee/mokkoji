/**
 * 위치 보고 훅의 공유 조각 — 웹·가짜(useArrivalReporter.ts)와 네이티브(useArrivalReporter.native.ts)가 같이 쓴다.
 *
 * 두 훅 파일은 서로를 import 하지 않는다(.native 에서 './useArrivalReporter' 는 자기 자신이 된다). 그래서 반환 타입·
 * 가짜 기기 위치·공유 토글 저장소를 여기 한 곳에 두고, 두 파일이 같은 이름으로 다시 내보낸다
 * (props.ts·FakeDevPanel·app/j/[code].tsx 의 `from '../useArrivalReporter'` 가 어느 플랫폼에서나 그대로 동작한다).
 * 네이티브 모듈은 import 하지 않는다(웹 번들에 섞이면 안 된다).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { LateBetError } from './errors';
import type { ReporterPermission } from './permissionRule';
import type { SampleQuality } from './reportPolicy';
import type { LbReportResult } from './types';

// ───────────────────────── 반환 타입 ─────────────────────────

/** 'granted' | 'coarse'(대략적 위치만) | 'denied'(거부·영구 거부) | 'undetermined'(아직 안 물음) | 'unsupported'(웹 등) */
export type LocationPermission = ReporterPermission;

/** 지금 보고에 쓰는 위치의 출처: 실제 GPS / FakeDevPanel 의 가짜 좌표 / 없음 */
export type PositionSource = 'gps' | 'fake' | 'none';

export interface ArrivalReporterPosition {
  lat: number;
  lng: number;
  accuracyM: number | null;
}

export interface ArrivalReporter {
  /** 화면용 권한 한 단어. 웹 P0: fake 면 'granted', 아니면 'unsupported' */
  permission: LocationPermission;
  /** OS 프롬프트를 다시 띄울 수 있는가. false 면 [설정 열기]로 보낸다(웹·가짜는 true) */
  canAskAgain: boolean;
  /** 정확한 위치 허용 여부. 모르면 null(iOS 는 권한 응답에 없어서 샘플 정확도로 판단한다) */
  precise: boolean | null;
  /** 위치 공유 토글(약속별). 기본 켬 */
  sharing: boolean;
  /** 끄면 보고 루프를 멈추고 lb_stop_sharing 을 1회 부른다(끝나면 resolve). 던지지 않는다 */
  setSharing(on: boolean): Promise<void>;
  /** 지금 보고 루프가 돌고 있는가 */
  running: boolean;
  /** 내 위치에서 목적지까지(기기에서 계산, 표시용). 모르면 null */
  myDistanceM: number | null;
  myAccuracyM: number | null;
  /** 내 기기 위치(지도 '나' 점). 모르면 null */
  myPosition: ArrivalReporterPosition | null;
  /** 위치 출처 */
  source: PositionSource;
  /** 마지막 샘플의 품질(ok · inaccurate(100m 초과) · coarse(1000m 초과, 안 보냄) · invalid). 샘플이 없으면 null */
  sampleQuality: SampleQuality | null;
  /** 마지막 샘플이 모의 위치(안드로이드)였다 */
  mocked: boolean;
  /** 위치를 읽지 못하고 있다(위치 서비스 꺼짐·GPS 오류). 권한 문제는 permission 으로 본다 */
  positionUnavailable: boolean;
  /** 마지막 서버 판정 */
  lastResult: LbReportResult | null;
  /** 마지막 보고 오류(연결 끊김 등). 성공하면 null */
  error: LateBetError | null;
  /** [도착 확인] 진행 중 */
  checking: boolean;
  /** [도착 확인]: 현재 위치 1회로 즉시 판정. 위치를 모르면 null. 던지지 않는다. 공유가 꺼져 있으면 share=false */
  checkInNow(): Promise<LbReportResult | null>;
  /** OS 위치 권한 요청(LocationPrimer 의 [위치 허용하기]). 다시 물을 수 없으면 설정을 연다. 결과 permission 을 돌려준다 */
  requestPermission(): Promise<LocationPermission>;
  /** 앱 설정 열기. 열었으면 true(웹은 false) */
  openSettings(): Promise<boolean>;
}

export interface UseArrivalReporterOptions {
  /** 도착이 찍힌 순간(자동·수동 모두) — 도착 연출 + refresh */
  onArrived?: (result: LbReportResult) => void;
}

// ───────────────────────── 가짜 기기 위치 (fake 모드) ─────────────────────────

export interface FakeDevicePosition {
  lat: number;
  lng: number;
  accuracyM: number | null;
  mocked: boolean;
}

/**
 * FakeDevPanel 의 '내 위치' 오버라이드.
 * - overriding=false: 오버라이드 없음 → 네이티브는 실제 GPS, 웹은 P0 처럼 목적지 북쪽 1.5km 를 처음 한 번 심는다
 * - overriding=true, position=null: '위치 모름'
 * - overriding=true, position=값: 그 좌표를 실제 GPS 대신 보낸다
 */
let override: { overriding: boolean; position: FakeDevicePosition | null } = { overriding: false, position: null };
const fakeListeners = new Set<() => void>();

export const fakeDevice = {
  /** 오버라이드 좌표. 오버라이드가 없거나 '위치 모름'이면 null */
  get: (): FakeDevicePosition | null => override.position,
  /** 오버라이드 중인가(가짜 좌표 또는 '위치 모름') */
  isOverriding: (): boolean => override.overriding,
  /** 가짜 좌표로 덮어쓴다. null = 위치를 모른다(권한 거부와 비슷한 상태) */
  set(next: FakeDevicePosition | null): void {
    override = { overriding: true, position: next };
    fakeListeners.forEach((fn) => fn());
  },
  /** 오버라이드 해제 → 실제 GPS 로 돌아간다(웹은 다음 약속 화면에서 기본 좌표를 다시 심는다) */
  release(): void {
    override = { overriding: false, position: null };
    fakeListeners.forEach((fn) => fn());
  },
  subscribe(listener: () => void): () => void {
    fakeListeners.add(listener);
    return () => {
      fakeListeners.delete(listener);
    };
  },
};

// ───────────────────────── 약속별 [위치 공유 끄기] ─────────────────────────

/** 설계서 §3.3: AsyncStorage 'yaho.late.shareOff.v1'. live 모드만 저장한다(fake 는 메모리 — 가짜 서버 id 가 매번 바뀐다) */
export const SHARE_OFF_KEY = 'yaho.late.shareOff.v1';
/** 저장해 둘 약속 수 상한(오래된 것부터 버린다) */
const SHARE_OFF_MAX = 50;

const shareOffIds: string[] = [];
let shareOffLoaded: Promise<void> | null = null;
const shareOffListeners = new Set<() => void>();

export const shareOffStore = {
  has: (appointmentId: string): boolean => shareOffIds.includes(appointmentId),
  /** 저장소에서 한 번 읽는다(live 모드). 실패하면 메모리만 */
  load(persist: boolean): Promise<void> {
    if (!persist) return Promise.resolve();
    if (!shareOffLoaded) {
      shareOffLoaded = AsyncStorage.getItem(SHARE_OFF_KEY)
        .then((raw) => {
          const parsed: unknown = raw ? JSON.parse(raw) : [];
          if (!Array.isArray(parsed)) return;
          for (const id of parsed) {
            if (typeof id === 'string' && !shareOffIds.includes(id)) shareOffIds.push(id);
          }
          shareOffListeners.forEach((fn) => fn());
        })
        .catch(() => undefined);
    }
    return shareOffLoaded;
  },
  set(appointmentId: string, off: boolean, persist: boolean): void {
    const i = shareOffIds.indexOf(appointmentId);
    if (off && i < 0) shareOffIds.push(appointmentId);
    if (!off && i >= 0) shareOffIds.splice(i, 1);
    while (shareOffIds.length > SHARE_OFF_MAX) shareOffIds.shift();
    shareOffListeners.forEach((fn) => fn());
    if (persist) void AsyncStorage.setItem(SHARE_OFF_KEY, JSON.stringify(shareOffIds)).catch(() => undefined);
  },
  subscribe(listener: () => void): () => void {
    shareOffListeners.add(listener);
    return () => {
      shareOffListeners.delete(listener);
    };
  },
};
