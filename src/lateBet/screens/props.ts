/**
 * 약속 화면(phase별 뷰)의 props 계약. app/late/[id]/index.tsx 가 이 모양으로 내려 준다.
 * 화면 담당은 이 파일을 고치지 말고, 필요한 것이 빠졌으면 foundation 에 알린다.
 *
 * 공통 규칙
 * - 각 뷰는 자기 <Screen>(스크롤 + footer 버튼)을 직접 그린다. 컨테이너는 그 위에 FakeDevPanel 과 연결 끊김 띠만 얹는다.
 * - 변경 RPC(api.*) 뒤에는 반드시 `await refresh()`. 낙관적 업데이트 금지.
 * - 내가 약속에서 빠지는 동작(요청 취소·나가기) 뒤에는 refresh 대신 `onLeft()`.
 * - 실패는 LateBetError 로 온다 → alertDialog(제목, e.message). Alert.alert 금지.
 * - 1초 티커가 필요하면 그 숫자를 그리는 작은 컴포넌트 안에서 useServerNow(1000) 을 쓴다.
 */
import type { LatePhase } from '@/domain/latePhase';

import type { LateBetApi } from '../api';
import type { LateBetError } from '../errors';
import type { LbLive, LbLiveParticipant } from '../types';
import type { ArrivalReporter, LocationPermission } from '../useArrivalReporter';

export interface LateViewProps {
  /** lb_get_live 의 마지막 응답. 절대 고치지 말 것 */
  live: LbLive;
  phase: LatePhase;
  /** 내 참가자 행 (live.participants 에서 찾은 것) */
  me: LbLiveParticipant | null;
  isHost: boolean;
  api: LateBetApi;
  /** 즉시 다시 읽기. 던지지 않는다 */
  refresh: () => Promise<LbLive | null>;
  /** 연결이 끊겨 마지막으로 본 내용을 그리는 중(띠는 컨테이너가 그린다. 버튼 비활성화 등에만 쓴다) */
  stale: boolean;
  error: LateBetError | null;
}

/** phase = pending — 승인 대기. 다른 참가자·위치는 live 에 들어 있지 않다 */
export interface PendingViewProps extends LateViewProps {
  /** [요청 취소] 성공 뒤 */
  onLeft: () => void;
}

/** phase = waiting — 대기실 */
export interface WaitingViewProps extends LateViewProps {
  /** 게스트의 [나가기] 성공 뒤. (주최자의 취소는 refresh 하면 컨테이너가 취소 안내를 그린다) */
  onLeft: () => void;
}

/** phase = live | overtime */
export interface LiveViewProps extends LateViewProps {
  /** 위치 보고 루프(컨테이너가 돌린다). 공유 토글·[도착 확인]·내 거리·마지막 판정 */
  reporter: ArrivalReporter;
}

/** phase = arrived — 나는 도착, 친구를 기다리는 중. GPS 도착자에게는 [같이 있어요] */
export interface ArrivedViewProps extends LateViewProps {
  /** 이 화면이 떠 있는 동안 방금 도착이 찍혔다 → 도착 연출(300ms 반전)을 1회 */
  justArrived: boolean;
}

/** phase = settling | settled | voided */
export interface ResultViewProps extends LateViewProps {
  /** settlePending 이 1분 넘게 이어진다 → errors.SETTLE_DELAYED_NOTICE */
  settleDelayed: boolean;
}

/** 위치 권한 사전 안내(§5.3-E) — 참여 직후 1회, OS 프롬프트 전에. app/j/[code].tsx 가 띄운다 */
export interface LocationPrimerProps {
  /** 정책의 shareLocationMinutesBefore — "약속 1시간 전부터" 문구용 */
  shareMinutesBefore: number;
  /** [위치 허용하기] — 부모가 OS 권한을 요청하고 다음 화면으로 넘긴다 */
  onAllow: () => void;
  /** [나중에] */
  onLater: () => void;
  busy?: boolean;
  /** 이미 아는 권한 상태(있으면 거부 안내 문구를 바꿀 수 있다) */
  permission?: LocationPermission;
}
