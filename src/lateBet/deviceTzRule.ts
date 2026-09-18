/**
 * 기기 시간대 고르기 — 순수 규칙(deviceTz.ts / deviceTz.native.ts 가 공유, 테스트 있음).
 *
 * deviceTz.native.ts 는 './deviceTz' 를 import 하면 Metro 가 자기 자신(.native)으로 resolve 하므로
 * 공통 로직과 타입은 이 파일에 둔다.
 */
import { isKnownTz, SEOUL_TZ } from '../domain/tzGuard';

/** 기기 IANA 시간대를 돌려주는 함수. 항상 쓸 수 있는 값을 준다(실패하면 'Asia/Seoul'). */
export type ReadDeviceTz = () => string;

/** 후보를 순서대로 시도해 처음으로 알려진 IANA 시간대를 고른다. 던지거나 모르는 값('GMT+1' 등 포함)은 건너뛴다. 전부 실패하면 'Asia/Seoul'. */
export function pickDeviceTz(candidates: ReadonlyArray<() => string | null | undefined>): string {
  for (const read of candidates) {
    let value: string | null | undefined;
    try {
      value = read();
    } catch {
      continue;
    }
    const tz = typeof value === 'string' ? value.trim() : '';
    if (tz !== '' && isKnownTz(tz)) return tz;
  }
  return SEOUL_TZ;
}

/** Intl 이 아는 기기 시간대(Hermes·브라우저). 없으면 null */
export function intlTimeZone(): string | null {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof tz === 'string' ? tz : null;
}
