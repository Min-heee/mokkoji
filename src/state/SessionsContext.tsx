import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { genId } from '@/domain/format';
import type { Person, Round, Session } from '@/domain/types';
import { loadSessions, saveSessions } from '@/storage/store';

export interface SessionsApi {
  sessions: Session[];
  loading: boolean;
  getSession(id: string): Session | undefined;
  createSession(title: string, peopleNames: string[]): Session;
  updateSession(id: string, updater: (session: Session) => Session): void;
  deleteSession(id: string): void;
  /** 기본값으로 새 차수를 만들어 세션에 추가하고 그 차수를 반환 */
  addRound(sessionId: string): Round | undefined;
}

const SessionsContext = createContext<SessionsApi | null>(null);

function makeDefaultRound(session: Session): Round {
  // 삭제 후에도 "n차" 제목이 중복되지 않도록 기존 제목의 최대 번호를 잇는다
  const maxN = session.rounds.reduce((max, r) => {
    const match = /^(\d+)차/.exec(r.title.trim());
    return match ? Math.max(max, Number(match[1])) : max;
  }, session.rounds.length);
  const n = maxN + 1;
  return {
    id: genId('r'),
    title: `${n}차`,
    kind: n === 1 ? 'meal' : n === 2 ? 'drinks' : 'etc',
    payerId: session.people[0]?.id ?? '',
    mode: 'even',
    participantIds: session.people.map((p) => p.id),
    totalAmount: 0,
    items: [],
    exemptIds: [],
  };
}

export function SessionsProvider({ children }: { children: React.ReactNode }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const hydrated = useRef(false);

  useEffect(() => {
    let alive = true;
    loadSessions().then((list) => {
      if (!alive) return;
      // 로드가 끝나기 전에 만들어진 세션(예: 딥링크로 새 모임 생성)이
      // 덮어써지지 않도록 교체가 아니라 병합한다. 메모리에 있는 세션이 우선.
      setSessions((prev) => {
        if (prev.length === 0) return list;
        const existing = new Set(prev.map((s) => s.id));
        return [...prev, ...list.filter((s) => !existing.has(s.id))];
      });
      hydrated.current = true;
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 키 입력마다 전체 직렬화가 돌지 않게 저장은 짧게 디바운스하고,
  // 프로바이더가 내려갈 때는 남은 변경분을 즉시 flush한다.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSave = useRef<Session[] | null>(null);

  useEffect(() => {
    if (!hydrated.current) return;
    pendingSave.current = sessions;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      if (pendingSave.current) {
        saveSessions(pendingSave.current);
        pendingSave.current = null;
      }
    }, 400);
  }, [sessions]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (pendingSave.current) saveSessions(pendingSave.current);
    },
    [],
  );

  const getSession = useCallback(
    (id: string) => sessions.find((s) => s.id === id),
    [sessions],
  );

  const createSession = useCallback((title: string, peopleNames: string[]): Session => {
    const people: Person[] = peopleNames
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .map((name) => ({ id: genId('p'), name }));
    const session: Session = {
      id: genId('s'),
      title: title.trim() || '새 모임',
      createdAt: new Date().toISOString(),
      people,
      rounds: [],
      settings: { roundingUnit: 100 },
    };
    setSessions((prev) => [session, ...prev]);
    return session;
  }, []);

  const updateSession = useCallback(
    (id: string, updater: (session: Session) => Session) => {
      setSessions((prev) => prev.map((s) => (s.id === id ? updater(s) : s)));
    },
    [],
  );

  const deleteSession = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const addRound = useCallback(
    (sessionId: string): Round | undefined => {
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return undefined;
      const round = makeDefaultRound(session);
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId ? { ...s, rounds: [...s.rounds, round] } : s,
        ),
      );
      return round;
    },
    [sessions],
  );

  const api = useMemo<SessionsApi>(
    () => ({
      sessions,
      loading,
      getSession,
      createSession,
      updateSession,
      deleteSession,
      addRound,
    }),
    [sessions, loading, getSession, createSession, updateSession, deleteSession, addRound],
  );

  return <SessionsContext.Provider value={api}>{children}</SessionsContext.Provider>;
}

export function useSessions(): SessionsApi {
  const api = useContext(SessionsContext);
  if (!api) {
    throw new Error('useSessions must be used within SessionsProvider');
  }
  return api;
}
