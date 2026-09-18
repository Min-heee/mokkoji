/**
 * [정산 시작] — 약속 내기 결과 → 기존 정산(Session) 만들기. 멱등.
 *
 * 같은 약속으로 두 번 누르면 새 세션을 만들지 않고 이미 만든 세션을 돌려준다.
 * 설계서는 AsyncStorage 맵('yaho.late.sessionMap.v1')을 말하지만, Session.lateBetId 가 세션과 함께 저장되므로
 * 그것을 기준으로 삼는다(세션을 지우면 연결도 같이 사라진다 — 따로 맞출 맵이 없다).
 * 메모리 맵은 createSession 직후 sessions 상태가 아직 갱신되기 전의 연타를 막는다.
 *
 * 사용:
 *   const sessions = useSessions();
 *   const existing = findSessionForLateBet(sessions.sessions, live.appointment.id);
 *   // existing 이 있으면 confirmDialog('이미 만든 정산이 있어요', '열까요?', () => router.replace(`/session/${existing.id}`))
 *   const { sessionId } = startSettlement({ live, selectedUserIds, sessions });
 *   router.replace(`/session/${sessionId}`);
 */
import type { Session } from '@/domain/types';
import { toSessionDraft, type ToSessionLive } from '@/domain/toSession';
import type { SessionsApi } from '@/state/SessionsContext';

const created = new Map<string, string>();

/** 이 약속으로 이미 만든 정산 세션 */
export function findSessionForLateBet(sessions: readonly Session[], lateBetId: string): Session | undefined {
  return sessions.find((s) => s.lateBetId === lateBetId);
}

export interface StartSettlementInput {
  live: ToSessionLive;
  /** 참가자 확인 시트에서 체크된 사람. 안 주면 활성 참가자 전원 */
  selectedUserIds?: readonly string[];
  sessions: Pick<SessionsApi, 'sessions' | 'getSession' | 'createSession' | 'updateSession'>;
}

export interface StartSettlementResult {
  sessionId: string;
  /** true = 새로 만들지 않고 이미 있던 세션을 돌려줬다 */
  existed: boolean;
}

export function startSettlement({ live, selectedUserIds, sessions }: StartSettlementInput): StartSettlementResult {
  const lateBetId = live.appointment.id;
  const existing = findSessionForLateBet(sessions.sessions, lateBetId);
  if (existing) return { sessionId: existing.id, existed: true };
  const justMade = created.get(lateBetId);
  if (justMade && sessions.getSession(justMade)) return { sessionId: justMade, existed: true };

  const draft = toSessionDraft(live, selectedUserIds);
  const session = sessions.createSession(draft.title, draft.people, draft.appointment);
  sessions.updateSession(session.id, (s) => ({ ...s, lateBetId: draft.lateBetId }));
  created.set(lateBetId, session.id);
  return { sessionId: session.id, existed: false };
}
