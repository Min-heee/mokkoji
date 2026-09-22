import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Friend, LedgerEntry } from '@/domain/friends';

import { pickStoredRaw } from './legacy';

const STORAGE_KEY = 'mokkoji.friends.v1';
/** 이름을 바꾸기 전(엔빵·정산야호) 키. 새 키가 비었을 때만 읽어 옮긴다 */
const LEGACY_STORAGE_KEY = 'nbbang.friends.v1';

export interface FriendsState {
  friends: Friend[];
  entries: LedgerEntry[];
}

export const EMPTY_FRIENDS_STATE: FriendsState = { friends: [], entries: [] };

/**
 * 저장소에서 읽은 값을 정규화한다. 레코드 단위로 격리해
 * 손상된 항목 하나가 전체를 지우지 못하게 한다 (sessions와 같은 원칙 —
 * load가 빈 값을 돌려주면 이후 저장이 빈 값을 덮어써 전손된다).
 */
export function normalizeFriendsState(parsed: unknown): FriendsState {
  if (!parsed || typeof parsed !== 'object') return EMPTY_FRIENDS_STATE;
  const raw = parsed as Partial<FriendsState>;

  const friends: Friend[] = [];
  if (Array.isArray(raw.friends)) {
    for (const f of raw.friends) {
      if (!f || typeof f.id !== 'string' || typeof f.name !== 'string') continue;
      friends.push({
        id: f.id,
        name: f.name,
        createdAt: typeof f.createdAt === 'string' ? f.createdAt : '',
      });
    }
  }

  const entries: LedgerEntry[] = [];
  if (Array.isArray(raw.entries)) {
    for (const e of raw.entries) {
      if (!e || typeof e.id !== 'string' || typeof e.friendId !== 'string') continue;
      if (typeof e.amount !== 'number' || !Number.isFinite(e.amount)) continue;
      entries.push({
        id: e.id,
        friendId: e.friendId,
        type: e.type === 'send' ? 'send' : 'receive',
        amount: e.amount,
        memo: typeof e.memo === 'string' ? e.memo : '',
        createdAt: typeof e.createdAt === 'string' ? e.createdAt : '',
      });
    }
  }

  return { friends, entries };
}

export async function loadFriendsState(): Promise<FriendsState> {
  try {
    const { raw, migrated } = pickStoredRaw(
      await AsyncStorage.getItem(STORAGE_KEY),
      await AsyncStorage.getItem(LEGACY_STORAGE_KEY),
    );
    if (raw === null) return EMPTY_FRIENDS_STATE;
    const state = normalizeFriendsState(JSON.parse(raw));
    if (migrated && (state.friends.length > 0 || state.entries.length > 0)) await saveFriendsState(state);
    return state;
  } catch {
    return EMPTY_FRIENDS_STATE;
  }
}

export async function saveFriendsState(state: FriendsState): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 저장 실패는 다음 변경에서 재시도된다
  }
}
