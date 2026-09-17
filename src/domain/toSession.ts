/**
 * 약속 내기 → 기존 정산(Session) 연결 (순수 함수).
 *
 * 결과 화면 [정산 시작] → 참가자 확인 시트 → createSession(title, people, appointment).
 * 이 모듈은 live 상태에서 시트의 후보 목록과 createSession 입력을 만든다.
 * 세션 생성·중복 방지(같은 약속으로 두 번 누름)는 src/lateBet/startSettlement.ts 가 한다.
 *
 * 입력 타입은 lb_get_live 페이로드의 부분집합이다(필드가 더 있어도 된다).
 */
import type { Appointment } from './types';

export interface ToSessionAppointment {
  id: string;
  title: string;
  /** 서버가 다시 쓴 벽시계 'YYYY-MM-DDTHH:mm' */
  localAt: string;
  placeName: string;
  placeNote?: string | null;
}

export interface ToSessionParticipant {
  userId: string;
  nickname: string;
  state: 'active' | 'pending';
  arrivedAtMs: number | null;
  /** 정산 뒤 서버가 채운다: 'onTime' | 'late' | 'noShow' */
  resultStatus?: string | null;
}

export interface ToSessionLive {
  appointment: ToSessionAppointment;
  participants: readonly ToSessionParticipant[];
}

/** 참가자 확인 시트의 한 줄 */
export interface SessionCandidate {
  userId: string;
  name: string;
  /** '오지 않음' 라벨을 붙일지. 체크는 풀지 않는다 — 마감 뒤에 온 사람이 기록상 오지 않음일 수 있다 */
  noShow: boolean;
}

/** createSession(title, people, appointment) 에 그대로 넘길 값 */
export interface SessionDraft {
  title: string;
  people: { name: string }[];
  appointment: Appointment;
  /** Session.lateBetId 에 적을 서버 약속 id */
  lateBetId: string;
}

const LOCAL_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/**
 * 시트 후보: 활성 참가자만(승인 대기는 약속에 온 사람이 아니다), 서버 순서(참여 순) 그대로.
 * 이름이 비었거나 같은 이름이 또 나오면 건너뛴다(서버가 약속 안에서 유일하게 강제하지만 세션 화면의 중복 검사와 맞춘다).
 */
export function sessionCandidates(live: ToSessionLive): SessionCandidate[] {
  const out: SessionCandidate[] = [];
  const seen = new Set<string>();
  for (const p of live.participants) {
    if (p.state !== 'active') continue;
    const name = clean(p.nickname);
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    const noShow = p.resultStatus ? p.resultStatus === 'noShow' : p.arrivedAtMs === null;
    out.push({ userId: p.userId, name, noShow });
  }
  return out;
}

/**
 * createSession 입력. selectedUserIds 를 주면 시트에서 체크된 사람만, 안 주면 전원.
 * 약속 시각은 서버의 벽시계 문자열을 그대로 쓴다 — 기존 Appointment.at 과 같은 형식이라 변환이 없다.
 */
export function toSessionDraft(live: ToSessionLive, selectedUserIds?: readonly string[]): SessionDraft {
  const selected = selectedUserIds ? new Set(selectedUserIds) : null;
  const people = sessionCandidates(live)
    .filter((c) => selected === null || selected.has(c.userId))
    .map((c) => ({ name: c.name }));
  const a = live.appointment;
  return {
    title: clean(a.title) || '새 모임',
    people,
    appointment: {
      at: LOCAL_AT_RE.test(a.localAt) ? a.localAt : null,
      place: clean(a.placeName),
      placeNote: clean(a.placeNote),
    },
    lateBetId: a.id,
  };
}
