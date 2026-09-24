/**
 * 마이 탭 표시 규칙 — 순수 함수(app/(tabs)/my.tsx 가 쓴다, node:test 로 검증).
 * React·RN·expo 를 import 하지 않는다.
 */
import type { LocationPermissionState } from '../lateBet/permissionRule';
import type { NotificationPermission } from '../lateBet/reminderPlan';

export interface MySectionsInput {
  /** useLateBet().enabled — 약속 내기 기능이 켜져 있는가 */
  lateEnabled: boolean;
  /** 약속 내기 모드('off' | 'fake' | 'live') */
  lateMode: string;
  /** Platform.OS */
  platform: string;
}

export interface MySections {
  /** '내 이름'·'내 포인트' 카드 */
  profile: boolean;
  /** '권한' 카드(위치·알림 상태 + [설정 열기]) */
  permissions: boolean;
}

export function isNativePlatform(platform: string): boolean {
  return platform === 'ios' || platform === 'android';
}

/**
 * - 이름·포인트: 약속 내기 기능이 켜져 있을 때만.
 * - 권한: 네이티브 ∧ 모드가 off 가 아닐 때만(off 면 권한 API 를 한 번도 부르지 않는다). 위치·알림은 약속 기능에서만 쓴다.
 */
export function mySections(input: MySectionsInput): MySections {
  return {
    profile: input.lateEnabled,
    permissions: input.lateMode !== 'off' && input.lateEnabled && isNativePlatform(input.platform),
  };
}

export const NO_NICKNAME = '아직 정하지 않았어요';

export function nicknameLine(nickname: string | null | undefined): string {
  const n = typeof nickname === 'string' ? nickname.trim() : '';
  return n === '' ? NO_NICKNAME : n;
}

/**
 * '내 이름'·'내 포인트' 카드가 무엇을 말할 수 있는가.
 * - ready: 프로필이 있다 → 이름·포인트를 그린다.
 * - checking: 첫 불러오기가 아직 안 끝났다(status 'loading') → '확인 중'. 이름이 없다고 단정하지 않는다.
 * - unreachable: 이번 실행에서 한 번도 못 불러왔고 마지막 시도가 실패했다(status 'error' ∧ !stale) → 연결 안내 + [다시 불러오기].
 *   이미 이름·포인트가 있는 사람에게 '아직 정하지 않았어요 / 1,000P를 드려요'를 띄우면 계정이 날아간 것처럼 보인다.
 * - none: 불러왔는데 프로필이 없다(ready·idle, 또는 불러온 적이 있는 뒤의 오류 = stale) → '아직 정하지 않았어요' + 1,000P 안내.
 */
export type ProfileCardState = 'ready' | 'checking' | 'unreachable' | 'none';

export interface ProfileCardInput {
  hasProfile: boolean;
  /** useLateBet().status */
  status: string;
  /** useLateBet().stale — 오류지만 이번 실행에서 한 번은 불러온 적이 있다 */
  stale: boolean;
}

export function profileCardState(input: ProfileCardInput): ProfileCardState {
  if (input.hasProfile) return 'ready';
  if (input.status === 'loading') return 'checking';
  if (input.status === 'error' && !input.stale) return 'unreachable';
  return 'none';
}

export const PROFILE_CHECKING = '확인 중';
export const PROFILE_UNREACHABLE = '확인하지 못했어요';
export const PROFILE_UNREACHABLE_HINT = '연결을 확인하고 다시 불러와 주세요';

/** 잔액 줄. 모르면(프로필 없음·아직 못 읽음) null → 화면은 안내 문구를 그린다 */
export function balanceLine(balance: number | null | undefined): string | null {
  if (typeof balance !== 'number' || !Number.isFinite(balance)) return null;
  return `${balance.toLocaleString('ko-KR')}P`;
}

export function locationPermissionLabel(state: LocationPermissionState | null): string {
  if (!state) return '확인 중';
  switch (state.status) {
    case 'granted':
      return state.precise === false ? '대략적인 위치만 허용' : '허용됨';
    case 'undetermined':
      return '아직 묻지 않았어요';
    case 'denied':
      return '허용 안 함';
    case 'blocked':
      return '허용 안 함 · 설정에서 바꿀 수 있어요';
    default:
      return '이 기기에서는 쓸 수 없어요';
  }
}

export function notificationPermissionLabel(p: NotificationPermission | null): string {
  switch (p) {
    case null:
      return '확인 중';
    case 'granted':
      return '허용됨';
    case 'undetermined':
      return '아직 묻지 않았어요';
    case 'denied':
      return '허용 안 함';
    default:
      return '이 기기에서는 쓸 수 없어요';
  }
}

export interface AppInfoInput {
  version: string | null | undefined;
  buildNumber: string | number | null | undefined;
  updateId: string | null | undefined;
}

export interface AppInfoRow {
  label: string;
  value: string;
}

/** '버전 0.4.0 (빌드 7)' · '업데이트 1a2b3c4d'. 모르는 값은 줄째 생략한다 */
export function appInfoRows(input: AppInfoInput): AppInfoRow[] {
  const rows: AppInfoRow[] = [];
  const version = typeof input.version === 'string' ? input.version.trim() : '';
  const build = input.buildNumber === null || input.buildNumber === undefined ? '' : String(input.buildNumber).trim();
  if (version !== '') rows.push({ label: '버전', value: build !== '' ? `${version} (빌드 ${build})` : version });
  else if (build !== '') rows.push({ label: '빌드', value: build });
  const update = typeof input.updateId === 'string' ? input.updateId.trim() : '';
  if (update !== '') rows.push({ label: '업데이트', value: update.slice(0, 8) });
  return rows;
}

/** '모임 3개 · 친구 5명' */
export function summaryLine(sessionCount: number, friendCount: number): string {
  return `모임 ${sessionCount}개 · 친구 ${friendCount}명`;
}
