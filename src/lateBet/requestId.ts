/**
 * 생성 멱등 키(uuid v4) — lb_create_appointment 의 p_request_id.
 *
 * 폼 한 번에 하나 만들고, 타임아웃·오프라인 뒤 [만들기]를 다시 눌러도 같은 값을 보낸다 → 서버는 이미 만든 약속을 그대로 돌려준다.
 * 보안 난수가 필요하지 않다(키는 주최자별로만 유일하면 된다). crypto.getRandomValues 가 있으면 쓰고, 없으면(Hermes 등) Math.random.
 * 새 네이티브 모듈을 쓰지 않는다.
 */
export function newRequestId(random: () => number = Math.random): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (random === Math.random && c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(random() * 256) & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
