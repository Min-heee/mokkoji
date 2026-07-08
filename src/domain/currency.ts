import { formatKrw } from './format';

export interface CurrencyInfo {
  code: string;
  symbol: string;
  /** 한국어 이름 */
  label: string;
  /** 입력·표시 소수 자리 */
  decimals: number;
}

export const BASE_CURRENCY = 'KRW';

export const CURRENCIES: CurrencyInfo[] = [
  { code: 'KRW', symbol: '₩', label: '원화', decimals: 0 },
  { code: 'JPY', symbol: '¥', label: '엔', decimals: 0 },
  { code: 'USD', symbol: '$', label: '달러', decimals: 2 },
  { code: 'EUR', symbol: '€', label: '유로', decimals: 2 },
  { code: 'CNY', symbol: '元', label: '위안', decimals: 2 },
  { code: 'TWD', symbol: 'NT$', label: '대만달러', decimals: 0 },
  { code: 'THB', symbol: '฿', label: '바트', decimals: 2 },
  { code: 'VND', symbol: '₫', label: '동', decimals: 0 },
  { code: 'PHP', symbol: '₱', label: '페소', decimals: 2 },
];

export function currencyInfo(code: string): CurrencyInfo {
  return (
    CURRENCIES.find((c) => c.code === code) ?? {
      code,
      symbol: `${code} `,
      label: code,
      decimals: 2,
    }
  );
}

/** 통화에 맞는 금액 표시. KRW는 "12,345원", 그 외는 "¥1,200" / "$10.50" */
export function formatMoney(amount: number, code: string): string {
  if (code === BASE_CURRENCY) return formatKrw(amount);
  const info = currencyInfo(code);
  const factor = 10 ** info.decimals;
  const n = Math.round(amount * factor) / factor;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const [whole, frac] = abs.toFixed(info.decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fracPart = frac && Number(frac) > 0 ? `.${frac}` : '';
  return `${sign}${info.symbol}${grouped}${fracPart}`;
}

/**
 * 금액 입력 문자열 정리: 숫자와 소수점 하나만 남긴다 (decimals 자리까지).
 * 반환은 화면에 그대로 보여줄 텍스트 — "4." 같은 입력 중 상태도 유지한다.
 *
 * 소수 모드에서는 쉼표 소수점 자판(독일·베트남 등의 decimal-pad는 ','만 제공)을
 * 지원한다: 쉼표는 소수점으로 해석하되, "1,234"나 "1,234.56"처럼 천단위
 * 구분으로만 쓰인 붙여넣기 텍스트의 쉼표는 그냥 제거한다.
 */
export function sanitizeAmountText(text: string, decimals: number): string {
  let normalized = text;
  if (decimals > 0 && normalized.includes(',')) {
    const t = normalized.replace(/[^\d.,]/g, '');
    const lastComma = t.lastIndexOf(',');
    const lastDot = t.lastIndexOf('.');
    if (lastDot !== -1) {
      // 두 구분자가 함께 있으면 뒤에 오는 쪽이 소수점, 앞쪽은 천단위 구분
      normalized =
        lastComma > lastDot
          ? t.replace(/\./g, '').replace(/,/g, '.')
          : t.replace(/,/g, '');
    } else if (/^\d{1,3}(,\d{3})+$/.test(t)) {
      // "1,234" 같은 천단위 구분 붙여넣기
      normalized = t.replace(/,/g, '');
    } else {
      // 자판에서 입력된 쉼표는 소수점
      normalized = t.replace(/,/g, '.');
    }
  }
  let cleaned = normalized.replace(decimals > 0 ? /[^\d.]/g : /[^\d]/g, '');
  if (decimals > 0) {
    const firstDot = cleaned.indexOf('.');
    if (firstDot !== -1) {
      cleaned =
        cleaned.slice(0, firstDot + 1) +
        cleaned.slice(firstDot + 1).replace(/\./g, '').slice(0, decimals);
    }
  }
  // "007" 같은 선행 0 정리 (소수점 앞 한 자리는 유지)
  cleaned = cleaned.replace(/^0+(?=\d)/, '');
  return cleaned;
}

/** sanitize된 텍스트 → 숫자. 비어 있거나 "."뿐이면 0 */
export function parseMoneyText(text: string): number {
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

/** 숫자를 그대로 표현하는 데 필요한 소수 자릿수. "5.4e-7" 같은 지수 표기도 처리 */
function decimalPlacesOf(n: number): number {
  const s = String(n);
  const eIdx = s.indexOf('e');
  if (eIdx === -1) {
    const dot = s.indexOf('.');
    return dot === -1 ? 0 : s.length - dot - 1;
  }
  const mantissa = s.slice(0, eIdx);
  const exp = Number(s.slice(eIdx + 1));
  const dot = mantissa.indexOf('.');
  const mantissaDecimals = dot === -1 ? 0 : mantissa.length - dot - 1;
  return Math.max(0, mantissaDecimals - exp);
}

export const FX_RATE_MIN_DECIMALS = 4;
export const FX_RATE_MAX_DECIMALS = 10;

/**
 * 환율 입력 필드의 소수 자릿수 상한.
 *
 * 고정 4자리는 VND 같은 0.1 미만 환율(예: 0.057996, 유효숫자 5자리 = 소수
 * 6자리)을 소리 없이 잘라 정산액을 왜곡시켰다. 필드가 표현해야 하는
 * 환율들(저장된 값 + 실시간 환율)을 받아, 그 값을 손실 없이 담을 수 있는
 * 자릿수를 돌려준다 (최소 4, 과도한 입력 방지를 위해 최대 10).
 */
export function fxRateInputDecimals(
  ...rates: Array<number | null | undefined>
): number {
  let decimals = FX_RATE_MIN_DECIMALS;
  for (const rate of rates) {
    if (rate == null || !Number.isFinite(rate) || rate <= 0) continue;
    decimals = Math.max(decimals, decimalPlacesOf(rate));
  }
  return Math.min(decimals, FX_RATE_MAX_DECIMALS);
}
