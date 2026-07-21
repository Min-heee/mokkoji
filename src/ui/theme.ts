/**
 * 정산야호 디자인 토큰 — 웜 아이보리 + 옵시디언, 무채색 미니멀.
 * 색을 빼서 구조·타이포가 전면에 서게 한다. 강조는 짙은 옵시디언 하나로,
 * 돈을 보내야 하는 신호(보낼 돈·삭제)에만 절제된 브릭을 쓴다.
 */
export const colors = {
  /** 배경 — 살짝 깊은 웜 아이보리 (카드가 떠 보이도록) */
  bg: '#EFE9DB',
  /** 카드/표면 — 밝은 웜 아이보리 */
  card: '#F7F2E8',
  /** 입력·비선택 칩 — 조금 더 깊은 톤 */
  cardAlt: '#E7DECC',
  /** 본문 — 옵시디언 */
  text: '#1A1A1A',
  /** 보조 — 웜 그레이 */
  subtext: '#7C7566',
  /** 경계선 */
  border: '#DDD3BF',
  /** 강조·CTA·선택 — 옵시디언 */
  primary: '#1A1A1A',
  /** 옵시디언 위 텍스트 — 아이보리 */
  onPrimary: '#F5EFE0',
  /** 은은한 강조 배경 (ghost/선택) */
  primaryDim: 'rgba(26,26,26,0.06)',
  /** 받을 돈 등 — 옵시디언 (무채색 유지, 부호로 구분) */
  success: '#1A1A1A',
  /** 보낼 돈·삭제 — 절제된 브릭 */
  danger: '#B23A2E',
  /** 브릭의 은은한 배경 */
  dangerDim: 'rgba(178,58,46,0.09)',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
};

export const fontSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 26,
};
