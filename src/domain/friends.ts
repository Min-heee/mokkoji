/**
 * 친구 목록 + 친구별 돈 장부 (전부 로컬 — 서버·로그인 불필요).
 * 모임 참가자를 친구 목록에서 골라 추가하고(Person.friendId로 연결),
 * 친구 상세에서 보낼 돈/받을 돈을 직접 기록한다.
 */

export interface Friend {
  id: string;
  name: string;
  createdAt: string;
}

/** send = 내가 보내야 할 돈, receive = 내가 받아야 할 돈 */
export type LedgerType = 'send' | 'receive';

export interface LedgerEntry {
  id: string;
  friendId: string;
  type: LedgerType;
  /** 원 (정수) */
  amount: number;
  memo: string;
  createdAt: string;
}

export interface FriendBalance {
  /** 보내야 할 돈 합계 */
  send: number;
  /** 받아야 할 돈 합계 */
  receive: number;
  /** receive - send. 양수면 받을 돈이 더 많다 */
  net: number;
}

/** 한 친구의 장부 잔액. 유효하지 않은 금액은 무시한다 */
export function friendBalance(entries: LedgerEntry[]): FriendBalance {
  let send = 0;
  let receive = 0;
  for (const e of entries) {
    if (!Number.isFinite(e.amount) || e.amount <= 0) continue;
    if (e.type === 'send') send += e.amount;
    else receive += e.amount;
  }
  return { send, receive, net: receive - send };
}

/** friendId별로 장부 항목을 묶는다 */
export function entriesByFriend(
  entries: LedgerEntry[],
): Record<string, LedgerEntry[]> {
  const map: Record<string, LedgerEntry[]> = {};
  for (const e of entries) {
    (map[e.friendId] ??= []).push(e);
  }
  return map;
}
