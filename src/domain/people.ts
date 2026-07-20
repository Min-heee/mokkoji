/**
 * 세션 참가자 추가의 순수 로직.
 * 중복 방지 가드를 updateSession 업데이터 안에서 실행되는 이 함수들에 두어,
 * 렌더 클로저의 낡은(stale) 상태를 근거로 한 이중 추가(더블탭·중복 submit)를 막는다.
 */

import { genId } from './format';
import type { Session } from './types';

/**
 * 친구를 참가자로 추가한다. 이미 같은 friendId로 연결된 참가자가 있으면
 * 세션을 그대로 반환한다 (더블탭이 두 번 적용돼도 한 명만 추가).
 * 이름이 같아도 friendId가 다르면 다른 사람이므로 추가를 허용한다.
 */
export function addFriendPerson(
  session: Session,
  friend: { id: string; name: string },
): Session {
  if (session.people.some((p) => p.friendId === friend.id)) return session;
  return {
    ...session,
    people: [
      ...session.people,
      { id: genId('p'), name: friend.name, friendId: friend.id },
    ],
  };
}

/**
 * 이름으로 참가자를 추가한다. 빈 이름이거나 같은 이름의 참가자가
 * 이미 있으면 세션을 그대로 반환한다 (중복 submit이 두 번 적용돼도 한 명만).
 */
export function addNamedPerson(session: Session, name: string): Session {
  const trimmed = name.trim();
  if (!trimmed) return session;
  if (session.people.some((p) => p.name === trimmed)) return session;
  return {
    ...session,
    people: [...session.people, { id: genId('p'), name: trimmed }],
  };
}
