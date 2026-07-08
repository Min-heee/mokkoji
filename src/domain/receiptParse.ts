/**
 * 영수증 OCR 결과 → 항목 목록 파서.
 * OCR 엔진 독립: 줄 텍스트 + bounding box만 받는 순수 로직 (테스트 대상).
 */

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ParsedReceiptItem {
  name: string;
  unitPrice: number;
  quantity: number;
  /** 영수증에 찍힌 줄 금액 */
  amount: number;
  /** 파싱이 애매해서 검토가 필요한 항목 */
  suspicious: boolean;
}

export interface ParsedReceipt {
  items: ParsedReceiptItem[];
  /** 합계 줄에서 찾은 금액 (검증용). 못 찾으면 null */
  detectedTotal: number | null;
}

/** 합계로 인식할 줄 (금액은 detectedTotal로 흡수) */
const TOTAL_KEYWORDS = [
  '합계', '총합계', '총액', '총구매액', '총금액', '결제금액', '청구금액', '받을금액',
  '판매합계', '영수금액',
  '合計', '総合計', 'ご合計', '御合計',
  'total', 'grandtotal', 'amountdue',
];

/** 항목이 아닌 줄 (버림) */
const SKIP_KEYWORDS = [
  '소계', '부가세', '과세', '면세', '공급가', '봉사료', '할인', '쿠폰', '에누리',
  '카드', '신용', '체크', '현금', '결제', '거스름', '받은돈', '받은금액', '내신금액',
  '포인트', '적립', '승인', '취소', '사업자', '대표', '매장', '지점', '점포',
  '주소', '전화', '가맹', '단말', '거래', '영수증', '교환', '환불', '반품',
  '주문번호', '승인번호', '거스름돈', '테이블', '인원',
  '小計', '消費税', '内税', '外税', '税込', '税抜', 'お預り', 'お預かり', 'お釣り',
  '釣銭', '現金', 'クレジット', '領収', '伝票', '担当', '店舗',
  'subtotal', 'tax', 'vat', 'cash', 'card', 'credit', 'change', 'tel', 'fax',
  'thank', 'point',
];

/** 항목일 수 없는 패턴: 전화번호, 사업자번호, 날짜, 시각, 마스킹된 카드번호 */
const NOISE_PATTERNS = [
  /\d{2,4}-\d{3,4}-\d{4}/, // 전화번호·사업자번호(123-45-67890도 걸림)
  /\d{4}[-./]\d{1,2}[-./]\d{1,2}/, // 날짜
  /\d{1,2}:\d{2}/, // 시각
  /\*{2,}/, // 카드번호 마스킹
];

/** 통화기호·원 표기를 벗겨낸 "순수 숫자 토큰"인지 */
function parseNumericToken(raw: string, decimals: number): number | null {
  let t = raw.replace(/^[₩¥\\€$£]/, '').replace(/원$/, '').replace(/[₩¥\\€$£]$/, '');
  if (!t || /[^\d.,-]/.test(t)) return null;
  // 후행 '-'(1,200-)는 일본 영수증의 금액 종결 기호이지 음수가 아니다
  const negative = t.startsWith('-');
  t = t.replace(/-/g, '');
  if (!t) return null;

  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) {
    // 1,234 / 1,234.56 — 쉼표는 천단위
    t = t.replace(/,/g, '');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(t) && decimals === 0) {
    // 25.000 (VND식 점 천단위) — 소수 없는 통화에서만
    t = t.replace(/\./g, '');
  } else if (/^\d+(\.\d{1,2})?$/.test(t)) {
    // 4500 / 4.5
  } else {
    return null;
  }
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** 키워드 매칭용: 공백 제거 + 소문자 ("합 계" → "합계") */
function normalizeForKeyword(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

function matchesAny(text: string, keywords: string[]): boolean {
  const norm = normalizeForKeyword(text);
  return keywords.some((k) => norm.includes(k));
}

/** 긴 키워드 먼저 걷어내야 "승인번호"가 "승인"+잔여 "번호"로 쪼개지지 않는다 */
const SKIP_KEYWORDS_BY_LENGTH = [...SKIP_KEYWORDS].sort((a, b) => b.length - a.length);

/**
 * SKIP 판정. 단순 부분 문자열 매칭은 메뉴명을 오탐한다
 * (CASHEW의 cash, CARDAMOM의 card, 포인트빵의 포인트 등).
 * 키워드를 모두 걷어낸 나머지에 글자가 남으면 "키워드를 품은 메뉴명"으로 보고
 * 살리고, 숫자·기호만 남으면(신용카드 14,000 등) 항목이 아닌 줄로 버린다.
 */
function matchesSkip(text: string): boolean {
  const norm = normalizeForKeyword(text);
  let leftover = norm;
  for (const k of SKIP_KEYWORDS_BY_LENGTH) leftover = leftover.split(k).join('');
  if (leftover === norm) return false; // 키워드가 아예 없다
  return !/\p{L}/u.test(leftover.replace(/원/g, ''));
}

/** OCR 줄들을 세로 중심이 겹치는 행(row)으로 묶는다 */
export function groupIntoRows(lines: OcrLine[]): OcrLine[][] {
  const sorted = [...lines]
    .filter((l) => l.text.trim().length > 0)
    .sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2));
  const rows: OcrLine[][] = [];
  for (const line of sorted) {
    const cy = line.y + line.height / 2;
    const last = rows[rows.length - 1];
    if (last) {
      // 기준은 행의 첫 라인: 마지막에 추가된 라인을 기준으로 하면
      // 기울어진 사진에서 행이 아래로 연쇄 확장되며 여러 줄을 삼킨다
      const ref = last[0];
      const refCy = ref.y + ref.height / 2;
      const tolerance = Math.max(line.height, ref.height) * 0.6;
      if (Math.abs(cy - refCy) <= tolerance) {
        last.push(line);
        continue;
      }
    }
    rows.push([line]);
  }
  // 행 안에서는 왼쪽→오른쪽
  rows.forEach((row) => row.sort((a, b) => a.x - b.x));
  return rows;
}

interface Token {
  raw: string;
  value: number | null;
}

/** 이름 앞에 붙는 항목 번호("01", "3.", "*") 제거 */
function cleanName(tokens: string[]): string {
  const cleaned = [...tokens];
  while (cleaned.length > 1) {
    const head = cleaned[0];
    if (/^\d{1,2}\.?$/.test(head) || /^[*#·-]+$/.test(head)) cleaned.shift();
    else break;
  }
  return cleaned.join(' ').trim();
}

function looksLikeQuantity(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 999;
}

/**
 * 한 행에서 항목을 뽑는다.
 * 마지막 숫자 토큰 = 금액. 이름과 금액 사이의 숫자들로 단가/수량을 추론.
 */
function parseItemRow(rawTokens: Token[], decimals: number): ParsedReceiptItem | null {
  // "01 아메리카노 4,500" 같은 항목 번호 접두: 1~2자리 숫자 뒤에
  // 텍스트가 이어지면 번호로 보고 떼어낸다 (이름이 비어버리는 것을 방지)
  let tokens = rawTokens;
  while (
    tokens.length > 1 &&
    tokens[0].value != null &&
    /^\d{1,2}\.?$/.test(tokens[0].raw) &&
    tokens[1].value == null
  ) {
    tokens = tokens.slice(1);
  }

  const numericIdxs = tokens
    .map((t, i) => (t.value != null ? i : -1))
    .filter((i) => i >= 0);
  if (numericIdxs.length === 0) return null;

  const amountIdx = numericIdxs[numericIdxs.length - 1];
  const amount = tokens[amountIdx].value as number;
  if (amount <= 0) return null; // 0원·할인(음수) 줄은 버린다

  // 이름 = 첫 숫자 토큰 이전의 텍스트 ("참이슬 360ml"의 360ml은 숫자 토큰이 아니라 이름)
  const firstNumIdx = numericIdxs[0];
  let nameTokens = tokens.slice(0, firstNumIdx).map((t) => t.raw);
  if (nameTokens.length === 0) {
    // 금액이 왼쪽·이름이 오른쪽인 비정형 레이아웃: 금액 뒤 텍스트를 이름으로
    nameTokens = tokens.slice(amountIdx + 1).map((t) => t.raw);
  }
  const name = cleanName(nameTokens);
  if (!name || /^[\d\s.,-]*$/.test(name)) return null;

  // 첫 숫자와 금액 사이에 텍스트가 끼어 있으면 두 항목이 한 줄로 붙었을
  // 가능성이 있다 ("떡볶이 3,000 순대 6,000") → 검토 표시
  const textBetweenNumbers = tokens
    .slice(firstNumIdx + 1, amountIdx)
    .some((t) => t.value == null);

  const mids = numericIdxs
    .slice(0, -1)
    .filter((i) => i > firstNumIdx - 1)
    .map((i) => tokens[i].value as number)
    .filter((v) => v > 0);

  const approxEq = (a: number, b: number) => Math.abs(a - b) <= 2;

  let unitPrice = amount;
  let quantity = 1;
  let suspicious = false;

  if (mids.length >= 2) {
    const [a, b] = mids.slice(-2); // 이름 바로 뒤 잡음보다 금액에 가까운 두 개
    if (looksLikeQuantity(b) && approxEq(a * b, amount)) {
      unitPrice = a;
      quantity = b;
    } else if (looksLikeQuantity(a) && approxEq(b * a, amount)) {
      unitPrice = b;
      quantity = a;
    } else {
      suspicious = true;
    }
  } else if (mids.length === 1) {
    const n = mids[0];
    if (n > 0 && amount % n === 0 && looksLikeQuantity(amount / n) && amount / n <= 99) {
      // n이 단가: 4,500 → 수량 = 9,000/4,500 = 2
      unitPrice = n;
      quantity = amount / n;
    } else if (looksLikeQuantity(n) && n <= 99 && amount % n === 0) {
      // n이 수량: 2 → 단가 = 9,000/2
      quantity = n;
      unitPrice = amount / n;
    } else {
      suspicious = true;
    }
  }

  if (quantity >= 13) suspicious = true; // 수량 13 이상은 오인식일 확률이 높다
  if (!approxEq(unitPrice * quantity, amount)) suspicious = true;
  if (textBetweenNumbers) suspicious = true;

  return { name, unitPrice, quantity, amount, suspicious };
}

/**
 * 영수증 파싱 진입점.
 * @param decimals 결제 통화의 소수 자리 (KRW/JPY/VND=0, USD 등=2) — 점 천단위 해석에 사용
 */
function tokenize(text: string, decimals: number): Token[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => ({ raw, value: parseNumericToken(raw, decimals) }));
}

export function parseReceipt(lines: OcrLine[], options?: { decimals?: number }): ParsedReceipt {
  const decimals = options?.decimals ?? 0;
  const rows = groupIntoRows(lines);

  const items: ParsedReceiptItem[] = [];
  let detectedTotal: number | null = null;

  for (const row of rows) {
    // 분류는 병합된 행 텍스트가 아니라 라인 단위로 한다: 기울어진 사진·2컬럼
    // 레이아웃에서 항목이 잡음·합계와 같은 세로 밴드에 묶여도
    // 그 라인 하나만 처리하고 옆 라인의 항목은 지우지 않는다.
    const totalLines: OcrLine[] = [];
    let itemLines: OcrLine[] = [];
    for (const line of row) {
      if (NOISE_PATTERNS.some((p) => p.test(line.text))) continue;
      if (matchesAny(line.text, TOTAL_KEYWORDS)) {
        totalLines.push(line);
        continue;
      }
      if (matchesSkip(line.text)) continue;
      itemLines.push(line);
    }

    if (totalLines.length > 0) {
      const nums = totalLines
        .flatMap((l) => tokenize(l.text, decimals))
        .map((t) => t.value)
        .filter((v): v is number => v != null && v > 0);
      // "합 계 | 9,000"처럼 금액이 별도 라인(컬럼)인 합계: 같은 행의
      // 숫자뿐인 라인은 합계의 금액 컬럼으로 흡수한다
      // (이름 없는 숫자는 어차피 항목이 될 수 없다)
      itemLines = itemLines.filter((l) => {
        const tokens = tokenize(l.text, decimals);
        if (tokens.length === 0 || tokens.some((t) => t.value == null)) return true;
        nums.push(...tokens.map((t) => t.value as number).filter((v) => v > 0));
        return false;
      });
      if (nums.length > 0) {
        const candidate = Math.max(...nums);
        detectedTotal = detectedTotal == null ? candidate : Math.max(detectedTotal, candidate);
      }
    }

    // 한 행에 여러 항목이 병합된 경우(2컬럼·겹친 줄): 이름+금액을 이미 갖춘
    // 묶음 뒤에 텍스트로 시작하는 라인이 오면 새 항목으로 끊는다.
    let segment: Token[] = [];
    let hasNumber = false;
    let hasText = false;
    const flushSegment = () => {
      if (segment.length > 0) {
        const item = parseItemRow(segment, decimals);
        if (item) items.push(item);
      }
      segment = [];
      hasNumber = false;
      hasText = false;
    };
    for (const line of itemLines) {
      const tokens = tokenize(line.text, decimals);
      if (tokens.length === 0) continue;
      if (hasNumber && hasText && tokens[0].value == null) flushSegment();
      for (const t of tokens) {
        segment.push(t);
        if (t.value != null) hasNumber = true;
        else hasText = true;
      }
    }
    flushSegment();
  }

  return { items, detectedTotal };
}
