/**
 * 개명(엔빵·정산야호 → 모꼬지) 전 저장 키에서 데이터를 인계하는 규칙.
 *
 * 저장 키에 앱 이름이 박혀 있어서 이름을 바꾸면 쓰던 기록이 안 보이게 된다.
 * 새 키가 비어 있을 때만 옛 키를 읽고, 읽었으면 새 키로 한 번 옮겨 쓴다(migrated=true).
 * 옛 키는 지우지 않는다 — 옮기다 실패해도 원본이 남아 있게.
 */
export interface PickedStoredRaw {
  /** 화면에 쓸 원본 문자열. 둘 다 없으면 null */
  raw: string | null;
  /** 옛 키에서 읽어온 것이라 새 키로 저장해야 하는가 */
  migrated: boolean;
}

export function pickStoredRaw(current: string | null, legacy: string | null): PickedStoredRaw {
  if (current !== null && current !== '') return { raw: current, migrated: false };
  if (legacy !== null && legacy !== '') return { raw: legacy, migrated: true };
  return { raw: null, migrated: false };
}
