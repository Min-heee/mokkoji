export type PersonId = string;

export interface Person {
  id: PersonId;
  name: string;
  /** 친구 목록에서 추가된 경우 그 친구의 id (직접 입력한 사람은 null) */
  friendId?: string | null;
}

export type RoundKind =
  | 'cafe'
  | 'meal'
  | 'drinks'
  | 'lodging'
  | 'transport'
  | 'activity'
  | 'shopping'
  | 'etc';

export type RoundMode = 'itemized' | 'even';

export interface Item {
  id: string;
  name: string;
  /** 단가 (원) */
  unitPrice: number;
  quantity: number;
  /**
   * 이 항목을 먹은/마신 사람들.
   * 비어 있으면 차수 참가자 전원이 나눈 것으로 간주한다.
   */
  eaterIds: PersonId[];
  /**
   * 이 항목에 내기가 걸려 진 사람 (몰빵). 설정되면 eaterIds와 무관하게
   * 이 사람이 항목 전액을 부담한다. null이면 내기 없음.
   */
  betLoserId?: PersonId | null;
}

/** 차수 단위 내기 결과 */
export interface RoundBet {
  /** 내기에 진 사람 (몰빵) */
  loserId: PersonId;
  /** 몰빵 금액 (결제 통화 기준). 나머지 금액은 원래 방식대로 나눈다 */
  amount: number;
}

export interface Round {
  id: string;
  /** 예: "1차 카페" */
  title: string;
  kind: RoundKind;
  /** 이 차수를 결제한 사람 */
  payerId: PersonId;
  mode: RoundMode;
  /** 이 차수에 있었던 사람들 (2차부터 합류한 사람 등 반영) */
  participantIds: PersonId[];
  /** mode === 'even' 일 때 차수 전체 금액 */
  totalAmount: number;
  /** mode === 'itemized' 일 때 항목 목록 */
  items: Item[];
  /**
   * 이 차수에서 부담을 면제받는 사람 (생일자 등).
   * 이들의 몫은 나머지 참가자들이 균등하게 나눠 부담한다.
   */
  exemptIds: PersonId[];
  /** 이 지출의 결제 통화 (ISO 코드, 기본 KRW) */
  currency: string;
  /**
   * 현금 결제 시 환율: 1 currency = fxRate 원.
   * currency가 KRW면 무시된다.
   */
  fxRate: number | null;
  /**
   * 카드 결제 시 실제 청구된 원화 총액.
   * 설정되면 fxRate 대신 이 값으로 환산한다 (카드사 환율·수수료 반영).
   */
  billedBaseAmount: number | null;
  /**
   * 차수 전체에 걸린 내기 결과. 진 사람이 amount를 몰빵하고
   * 나머지 (총액 - amount)는 원래 방식대로 나눈다. null이면 내기 없음.
   */
  bet?: RoundBet | null;
}

export interface SessionSettings {
  /** 송금액 반올림 단위 (원) */
  roundingUnit: 1 | 10 | 100 | 1000;
  /** 정산 기준 통화 (현재 KRW 고정) */
  baseCurrency: string;
}

/** 모임 전체에 걸린 내기 (기준통화 원 기준) */
export interface SessionBet {
  /** 내기에 진 사람 (몰빵) */
  loserId: PersonId;
  /** 몰빵 금액 (원). 모임 전체 부담에서 이 금액을 진 사람이 몰빵한다 */
  amount: number;
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  people: Person[];
  rounds: Round[];
  settings: SessionSettings;
  /** 통화별 마지막 사용 환율 — 새 지출의 기본값으로 재사용 */
  lastFxRates?: Record<string, number>;
  /** 모임 전체 내기 결과. 진 사람이 amount를 몰빵, 나머지는 원래 비율대로 */
  bet?: SessionBet | null;
}

export interface PersonSettlement {
  personId: PersonId;
  /** 먹은/부담해야 할 총액 (원, 소수 가능) */
  consumed: number;
  /** 결제한 총액 (원) */
  paid: number;
  /** paid - consumed. 양수면 받을 돈, 음수면 보낼 돈 */
  net: number;
}

export interface Transfer {
  fromId: PersonId;
  toId: PersonId;
  /** 반올림 단위가 적용된 정수 금액 (원) */
  amount: number;
}

export interface RoundSummary {
  roundId: string;
  title: string;
  kind: RoundKind;
  payerId: PersonId;
  /** 기준통화(원) 환산 총액. 환율 미입력이면 0 */
  total: number;
  /** 결제 통화 */
  currency: string;
  /** 결제 통화 기준 총액 */
  currencyTotal: number;
  /** 외화인데 환율 정보가 없어 정산에서 제외됨 */
  missingFx: boolean;
  /** 사람별 부담액 (기준통화 원, 소수 가능) */
  shares: Record<PersonId, number>;
}

export interface SettlementResult {
  perRound: RoundSummary[];
  persons: PersonSettlement[];
  transfers: Transfer[];
  grandTotal: number;
  /** 환율 미입력으로 제외된 지출이 하나라도 있으면 true */
  hasMissingFx: boolean;
}
