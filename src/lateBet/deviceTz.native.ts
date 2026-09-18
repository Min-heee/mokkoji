/**
 * 현재 기기의 IANA 시간대 — iOS/Android: expo-localization getCalendars()[0].timeZone → Intl → 'Asia/Seoul'.
 * 웹 폴백은 deviceTz.ts. 두 파일은 같은 시그니처(ReadDeviceTz)를 쓴다.
 */
import { getCalendars } from 'expo-localization';

import { intlTimeZone, pickDeviceTz, type ReadDeviceTz } from './deviceTzRule';

export type { ReadDeviceTz };

export const readDeviceTz: ReadDeviceTz = () =>
  pickDeviceTz([() => getCalendars()[0]?.timeZone, intlTimeZone]);
