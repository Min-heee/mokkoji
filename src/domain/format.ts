/** 12345 -> "12,345원", -1234.5 -> "-1,235원" (표시 시점에 원 단위 반올림) */
export function formatKrw(amount: number): string {
  const n = Math.round(amount);
  const sign = n < 0 ? '-' : '';
  const digits = Math.abs(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${digits}원`;
}

/** "12,345" 같은 입력 문자열 -> 12345. 숫자가 아니면 0 */
export function parseAmount(text: string): number {
  const cleaned = text.replace(/[^\d]/g, '');
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

let idCounter = 0;

export function genId(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}${idCounter.toString(36)}`;
}
