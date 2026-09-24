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

/** 친구 이름 최대 글자 수(이모지·한글 한 글자 = 1) */
export const FRIEND_NAME_MAX = 20;

/**
 * 입력칸 maxLength(UTF-16 코드 유닛 — RN TextInput·웹 maxlength 가 세는 단위). 판정은 checkFriendName(코드 포인트)이 한다.
 * 코드 포인트 FRIEND_NAME_MAX 개는 UTF-16 으로 최대 FRIEND_NAME_MAX*2 단위 + 앞뒤 공백 여유.
 * FRIEND_NAME_MAX 를 그대로 maxLength 로 주면 이모지·확장 한자 이름이 10자에서 잘리고 '20자까지' 안내는 영영 안 뜬다.
 */
export const FRIEND_NAME_INPUT_MAX = FRIEND_NAME_MAX * 2 + 4;

export type FriendNameCheck =
  | { ok: true; name: string }
  | { ok: false; reason: 'empty' | 'tooLong' };

/**
 * 친구 이름 검증 — 앞뒤 공백을 떼고 1~FRIEND_NAME_MAX 자면 통과.
 * 같은 이름은 막지 않는다(기존 규칙: 동명이인도 따로 넣을 수 있다).
 */
export function checkFriendName(raw: string): FriendNameCheck {
  const name = (typeof raw === 'string' ? raw : '').trim();
  const len = Array.from(name).length;
  if (len === 0) return { ok: false, reason: 'empty' };
  if (len > FRIEND_NAME_MAX) return { ok: false, reason: 'tooLong' };
  return { ok: true, name };
}
