/**
 * 현재 기기의 IANA 시간대 — 웹·앱인토스 폴백: Intl → 'Asia/Seoul'.
 * 네이티브 구현은 deviceTz.native.ts(expo-localization). 두 파일은 같은 시그니처(ReadDeviceTz)를 쓴다.
 */
import { intlTimeZone, pickDeviceTz, type ReadDeviceTz } from './deviceTzRule';

export type { ReadDeviceTz };

export const readDeviceTz: ReadDeviceTz = () => pickDeviceTz([intlTimeZone]);
