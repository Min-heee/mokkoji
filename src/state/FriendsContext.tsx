import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';

import { genId } from '@/domain/format';
import type { Friend, LedgerEntry, LedgerType } from '@/domain/friends';
import {
  EMPTY_FRIENDS_STATE,
  loadFriendsState,
  saveFriendsState,
  type FriendsState,
} from '@/storage/friendsStore';

export interface FriendsApi {
  friends: Friend[];
  entries: LedgerEntry[];
  loading: boolean;
  getFriend(id: string): Friend | undefined;
  /** 이름으로 친구 추가. 빈 이름이면 무시하고 undefined */
  addFriend(name: string): Friend | undefined;
  /** 친구 삭제 — 그 친구의 장부 항목도 함께 지운다 */
  removeFriend(id: string): void;
  entriesOf(friendId: string): LedgerEntry[];
  addEntry(friendId: string, type: LedgerType, amount: number, memo: string): void;
  removeEntry(entryId: string): void;
}

const FriendsContext = createContext<FriendsApi | null>(null);

export function FriendsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<FriendsState>(EMPTY_FRIENDS_STATE);
  const [loading, setLoading] = useState(true);
  const hydrated = useRef(false);

  useEffect(() => {
    let alive = true;
    loadFriendsState().then((loaded) => {
      if (!alive) return;
      // 하이드레이션 전에 생긴 변경이 있으면 메모리 우선 병합 (세션과 같은 원칙)
      setState((prev) => {
        if (prev.friends.length === 0 && prev.entries.length === 0) return loaded;
        const friendIds = new Set(prev.friends.map((f) => f.id));
        const entryIds = new Set(prev.entries.map((e) => e.id));
        return {
          friends: [...prev.friends, ...loaded.friends.filter((f) => !friendIds.has(f.id))],
          entries: [...prev.entries, ...loaded.entries.filter((e) => !entryIds.has(e.id))],
        };
      });
      hydrated.current = true;
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 디바운스 저장 + 백그라운드 진입 시 즉시 flush
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSave = useRef<FriendsState | null>(null);

  useEffect(() => {
    if (!hydrated.current) return;
    pendingSave.current = state;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      if (pendingSave.current) {
        saveFriendsState(pendingSave.current);
        pendingSave.current = null;
      }
    }, 400);
  }, [state]);

  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (pendingSave.current) {
      saveFriendsState(pendingSave.current);
      pendingSave.current = null;
    }
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') flushSave();
    });
    return () => sub.remove();
  }, [flushSave]);

  const getFriend = useCallback(
    (id: string) => state.friends.find((f) => f.id === id),
    [state.friends],
  );

  const addFriend = useCallback((name: string): Friend | undefined => {
    const trimmed = name.trim();
    if (!trimmed) return undefined;
    const friend: Friend = {
      id: genId('f'),
      name: trimmed,
      createdAt: new Date().toISOString(),
    };
    setState((prev) => ({ ...prev, friends: [...prev.friends, friend] }));
    return friend;
  }, []);

  const removeFriend = useCallback((id: string) => {
    setState((prev) => ({
      friends: prev.friends.filter((f) => f.id !== id),
      entries: prev.entries.filter((e) => e.friendId !== id),
    }));
  }, []);

  const entriesOf = useCallback(
    (friendId: string) => state.entries.filter((e) => e.friendId === friendId),
    [state.entries],
  );

  const addEntry = useCallback(
    (friendId: string, type: LedgerType, amount: number, memo: string) => {
      if (!Number.isFinite(amount) || amount <= 0) return;
      const entry: LedgerEntry = {
        id: genId('le'),
        friendId,
        type,
        amount,
        memo: memo.trim(),
        createdAt: new Date().toISOString(),
      };
      setState((prev) => ({ ...prev, entries: [entry, ...prev.entries] }));
    },
    [],
  );

  const removeEntry = useCallback((entryId: string) => {
    setState((prev) => ({
      ...prev,
      entries: prev.entries.filter((e) => e.id !== entryId),
    }));
  }, []);

  const api = useMemo<FriendsApi>(
    () => ({
      friends: state.friends,
      entries: state.entries,
      loading,
      getFriend,
      addFriend,
      removeFriend,
      entriesOf,
      addEntry,
      removeEntry,
    }),
    [state, loading, getFriend, addFriend, removeFriend, entriesOf, addEntry, removeEntry],
  );

  return <FriendsContext.Provider value={api}>{children}</FriendsContext.Provider>;
}

export function useFriends(): FriendsApi {
  const api = useContext(FriendsContext);
  if (!api) {
    throw new Error('useFriends must be used within FriendsProvider');
  }
  return api;
}
