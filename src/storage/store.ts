import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Session } from '@/domain/types';

const STORAGE_KEY = 'nbbang.sessions.v1';

export async function loadSessions(): Promise<Session[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Session[]) : [];
  } catch {
    return [];
  }
}

export async function saveSessions(sessions: Session[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // 저장 실패는 치명적이지 않다 — 다음 변경에서 재시도된다
  }
}
