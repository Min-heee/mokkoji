/**
 * 초대 참여 (설계서 §3.2, §5.3-D·E, §0-1 규칙 4·5). 딥링크 nbbang://j/CODE. 담당: [join]
 *
 * 흐름: 코드 형식 검사(invite.normalizeCode — 통과한 값만 RPC 에 넣는다) → 조용히 익명 로그인(ensureReady)
 *   → lb_peek_invite 미리보기(조건 카드 + 초대 명단) → 명단에서 내 이름 고르기 + 동의 2개
 *   → lb_claim_slot(미리보기에서 본 version 으로만) → 위치 권한 사전 안내(LocationPrimer) → /late/[id] 로 replace
 *   (알림 권한 안내·예약은 약속 화면의 useLateReminders·NotifyCard 가 위치 안내 뒤에 맡는다).
 * - 수락제·자동 잠금은 없다. 명단에 없는 사람은 참여할 수 없고, 남이 이미 고른 이름은 비활성 칩이다.
 * - 참여 마감 = 약속 시각(meetAtMs). 주최자가 이미 [시작하기]를 눌렀어도(startedAtMs) 약속 시각 전이면 들어올 수 있다 —
 *   그때는 "이미 시작됐어요 — 들어오면 바로 위치가 보여요" 를 알리고, 참여 직후 컨테이너가 바로 live 화면을 그린다(result.started).
 * - 이미 멤버면(myState·mine) 미리보기 없이 바로 약속 화면으로 보낸다(멱등 재진입).
 * - 약속 시각 지남·닫힘 → LB_JOIN_CLOSED 문구. 명단에 빈 이름이 없음 → LB_NOT_INVITED 문구(시작 후에는 주최자도 이름을 못 늘린다).
 * - 실패 상태는 §5.3-D 표에서 수락제 행을 뺀 것 + LB_SLOT_TAKEN·LB_NOT_INVITED(고른 이름을 풀고 명단을 다시 읽는다)
 *   + 조건 변경(LB_APPT_CHANGED → [미리보기 새로고침]). 문구는 errors.ts 의 것을 쓰고, 표에만 있는 두 줄(취소됨·오프라인 꼬리)만 여기 둔다.
 * - 프로필이 없으면 고른 명단 이름으로 ensureProfile(+1,000P). 프로필이 있으면 전역 이름은 건드리지 않는다
 *   (이 약속에서의 닉네임 = 명단 이름. 서버가 참가자 행에 그 이름을 쓴다).
 * - 낙관적 업데이트 없음: '참여했어요'는 서버 응답 뒤에만 그린다.
 * - 미리보기는 앞으로 돌아올 때와 15초마다 조용히 다시 읽는다(주최자의 이름 추가·시작·조건 변경을 곧 본다).
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';

import { normalizeCode, sanitizeCodeInput } from '@/domain/invite';
import { describePolicy, START_BALANCE } from '@/domain/latePresets';
import { mapPinUrl } from '@/domain/mapRoute';
import { formatKoreanDateTime, tzLabel } from '@/domain/tzGuard';
import {
  errorMessage,
  isConnectivityError,
  LateBetError,
  REPEATED_FAILURE_MESSAGE,
  toLateBetError,
} from '@/lateBet/errors';
import { useLateBet } from '@/lateBet/LateBetContext';
import { FromNowPill, openExternal } from '@/lateBet/screens/ConditionCard';
import { FakeDevPanel } from '@/lateBet/screens/FakeDevPanel';
import { LocationPrimer } from '@/lateBet/screens/LocationPrimer';
import { LateBetUnavailable } from '@/lateBet/screens/NicknameGate';
import { withClockSample } from '@/lateBet/serverClock';
import type { LbInvitePreview, LbJoinResult } from '@/lateBet/types';
import { useArrivalReporter } from '@/lateBet/useArrivalReporter';
import { markSeenVersion } from '@/lateBet/useLive';
import { useServerNow } from '@/lateBet/useServerNow';
import { Card, Chip, EmptyState, LoadingState, PrimaryButton, Row, Screen, SectionTitle } from '@/ui/components';
import { alertDialog } from '@/ui/dialogs';
import { MapPane } from '@/ui/MapPane';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

// §5.3-D 표에만 있는 문구(errors.ts 에 코드가 없는 상태)
const CANCELED_MESSAGE = '주최자가 취소한 약속이에요.';
const OFFLINE_TAIL = ' 초대 코드는 그대로 있어요.';

/** 주최자가 이미 [시작하기]를 누른 약속에 들어가려는 사람에게 (§0-1 규칙 5) */
const STARTED_NOTICE = '주최자가 이미 시작했어요. 들어오면 바로 위치가 보여요.';
/** 시작 전 약속에 들어가려는 사람에게 (§0-1 규칙 4·7) */
const NOT_STARTED_NOTICE = '주최자가 시작하면 서로 위치가 보여요.';

/** 보던 미리보기를 조용히 다시 읽는 간격 */
const PREVIEW_POLL_MS = 15_000;

/** 화면 전체를 차지하는 실패 상태. action 이 버튼을 정한다 */
type BlockAction = 'reenter' | 'retry' | 'home';
interface Block {
  message: string;
  action: BlockAction;
}

function blockForError(e: LateBetError): Block {
  if (isConnectivityError(e)) return { message: errorMessage('LB_OFFLINE') + OFFLINE_TAIL, action: 'retry' };
  switch (e.code) {
    case 'LB_INVITE_NOT_FOUND':
      return { message: e.message, action: 'reenter' };
    case 'LB_JOIN_CLOSED':
    case 'LB_FULL':
    case 'LB_INSUFFICIENT_POINTS':
    case 'LB_NOT_CONFIGURED':
      return { message: e.message, action: 'home' };
    default:
      return { message: e.message, action: 'retry' };
  }
}

/** 사용자가 화면에서 바로 고칠 수 있는 오류(연속 실패로 세지 않고, 다시 고르거나 체크하면 지운다) */
const FIXABLE = new Set<string>(['LB_BAD_NICKNAME', 'LB_CONSENT_REQUIRED', 'LB_SLOT_TAKEN', 'LB_NOT_INVITED']);

interface Joined extends LbJoinResult {
  /** 내가 고른 명단 이름 */
  name: string;
  /** 참여하면서 서버가 채워 준 포인트(없으면 null) */
  topUp: number | null;
}

interface LoadOptions {
  /** 보던 화면을 유지한 채 다시 읽는다(로딩 화면 없음). 연결 문제면 보던 미리보기를 그대로 둔다 */
  quiet?: boolean;
  /** quiet 이면서 '읽는 중' 표시도 하지 않는다(주기 폴링) */
  silent?: boolean;
  /** 사용자가 조건 변경을 이미 알고 누른 새로고침 → version 이 달라도 안내를 다시 띄우지 않는다 */
  expectChange?: boolean;
}

export default function JoinByCodeScreen() {
  const { enabled } = useLateBet();
  if (!enabled) return <LateBetUnavailable />;
  return <Inner />;
}

function Inner() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code: string }>();
  const rawCode = typeof params.code === 'string' ? params.code : '';
  const code = normalizeCode(rawCode);

  const { api, fake, mode, profile, balance, ensureReady, ensureProfile, applyBalance, refresh: refreshHome, needsUpdate, installUrl } =
    useLateBet();
  // 위치 권한 상태·요청만 빌려 쓴다(약속이 없으므로 보고 루프는 돌지 않는다)
  const reporter = useArrivalReporter(null);
  // 참여 마감(약속 시각) 경계 — 30초마다 다시 본다 ("N분 뒤" 알약은 FromNowPill 이 따로 센다)
  const now = useServerNow(30_000);

  const [preview, setPreview] = useState<LbInvitePreview | null>(null);
  const [loading, setLoading] = useState(code !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [block, setBlock] = useState<Block | null>(null);
  const [failCount, setFailCount] = useState(0);

  /** 명단에서 고른 내 이름 */
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [agreeLocation, setAgreeLocation] = useState(false);
  const [agreeAge, setAgreeAge] = useState(false);
  const [formError, setFormError] = useState<LateBetError | null>(null);
  /** LB_APPT_CHANGED 를 받았다 → 옛 조건으로는 더 못 누른다. [미리보기 새로고침]만 남긴다 */
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState<Joined | null>(null);
  const [finishing, setFinishing] = useState(false);

  const ready = useRef(false);
  const seq = useRef(0);
  const previewRef = useRef<LbInvitePreview | null>(null);
  const selectedRef = useRef<string | null>(null);
  const joinedRef = useRef(false);
  const busyRef = useRef(false);
  const finishingRef = useRef(false);
  const allowingRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const select = useCallback((name: string | null) => {
    selectedRef.current = name;
    setSelectedName(name);
  }, []);

  const load = useCallback(
    async (opts: LoadOptions = {}) => {
      if (!code || joinedRef.current) return;
      const quiet = opts.quiet === true || opts.silent === true;
      const mySeq = ++seq.current;
      if (quiet) {
        if (!opts.silent) setRefreshing(true);
      } else {
        setLoading(true);
        setBlock(null);
      }
      try {
        if (!ready.current) {
          await ensureReady();
          ready.current = true;
        }
        const next = await withClockSample(() => api.peekInvite(code));
        if (!alive.current || mySeq !== seq.current || joinedRef.current) return;
        const prev = previewRef.current;
        // 조건이 바뀌었으면 동의를 다시 받는다 — 본 적 없는 조건으로는 포인트가 걸리지 않는다(§1 원칙 6)
        if (prev && prev.version !== next.version) {
          setAgreeLocation(false);
          setAgreeAge(false);
          if (!opts.expectChange) setFormError(new LateBetError('LB_APPT_CHANGED'));
        }
        // 고른 이름을 그새 남이 골랐거나 주최자가 지웠으면 선택을 푼다
        const sel = selectedRef.current;
        if (sel !== null && !next.invitees.some((i) => i.name === sel && !i.claimed)) select(null);
        previewRef.current = next;
        applyBalance(next.myBalance);
        setPreview(next);
        setBlock(null);
        setFailCount(0);
      } catch (e) {
        if (!alive.current || mySeq !== seq.current || joinedRef.current) return;
        const err = toLateBetError(e);
        // 조용한 새로고침이 연결 문제로 실패하면 보던 미리보기를 그대로 둔다
        if (quiet && previewRef.current && isConnectivityError(err)) return;
        setFailCount((n) => n + 1);
        setBlock(blockForError(err));
      } finally {
        if (alive.current && mySeq === seq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [api, applyBalance, code, ensureReady, select],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // 카톡으로 주최자에게 이름을 부탁하고 돌아오는 경우가 흔하다 → 앞으로 돌아오면 명단을 조용히 다시 읽는다
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void load({ quiet: true });
    });
    return () => sub.remove();
  }, [load]);

  // 보는 동안 15초마다 조용히 — 주최자가 이름을 추가했거나 [시작하기]를 눌렀으면 곧 보인다(참여를 누르는 중에는 쉰다)
  const polling = preview !== null && block === null && joined === null;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      if (AppState.currentState === 'active' && !busyRef.current) void load({ silent: true });
    }, PREVIEW_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, load]);

  // 이미 참여 중(내가 고른 칸이 있다) → 약속 화면으로
  const alreadyMemberId = preview && (preview.myState !== null || preview.invitees.some((i) => i.mine)) ? preview.id : null;
  useEffect(() => {
    if (alreadyMemberId && !joinedRef.current) router.replace('/late/' + alreadyMemberId);
  }, [alreadyMemberId, router]);

  const goHome = useCallback(() => {
    if (router.canGoBack()) router.dismissAll();
    else router.replace('/');
  }, [router]);

  const reenter = useCallback(() => {
    router.replace({ pathname: '/j', params: { c: sanitizeCodeInput(rawCode) } });
  }, [rawCode, router]);

  /**
   * 참여 뒤 마무리 → 약속 화면(이미 시작한 약속이면 컨테이너가 바로 live 화면을 그린다).
   * 알림 권한 안내·예약은 약속 화면이 맡는다(useLateReminders + NotifyCard — 위치 안내가 먼저, 알림 카드는 그 뒤).
   */
  const finish = useCallback(
    async (j: Joined) => {
      if (finishingRef.current) return;
      finishingRef.current = true;
      setFinishing(true);
      router.replace('/late/' + j.appointmentId);
    },
    [router],
  );

  const clearFixable = () => {
    setFormError((cur) => (cur && FIXABLE.has(cur.code) ? null : cur));
  };

  const submit = async () => {
    if (busy || !preview || !code || changed) return;
    const name = selectedName;
    if (name === null) return;
    if (!agreeLocation || !agreeAge) {
      setFormError(new LateBetError('LB_CONSENT_REQUIRED'));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setFormError(null);
    try {
      // 첫 진입이면 프로필부터(+1,000P) — 고른 명단 이름으로. 이미 있으면 전역 이름은 건드리지 않는다
      if (!profile) await ensureProfile(name);
      let res: LbJoinResult;
      try {
        // version 은 반드시 화면에 그려진 미리보기의 것. 첫 인자는 appointmentId(코드가 아니다)
        res = await api.claimSlot(preview.id, name, preview.version, true);
      } catch (e) {
        if (toLateBetError(e).code !== 'LB_NO_PROFILE') throw e;
        await ensureProfile(name);
        res = await api.claimSlot(preview.id, name, preview.version, true);
      }

      joinedRef.current = true;
      // 내가 동의한 조건 = 미리보기의 version. 첫 getLive 전에 먼저 심어 두어야 그 사이 주최자가 바꾼 조건이 배너로 뜬다
      markSeenVersion(res.appointmentId, preview.version, mode);
      void refreshHome();

      // "포인트가 모자라 20P를 채워 드렸어요" — 원장에서 이 약속 때문에 채워진 줄을 찾는다(best-effort)
      let topUp: number | null = null;
      if (preview.policy.stake > 0) {
        try {
          const ledger = await api.listLedger(10);
          const relief = ledger.find((l) => l.kind === 'relief' && l.reliefFor === res.appointmentId);
          if (relief && relief.amount > 0) topUp = relief.amount;
        } catch {
          // 안내만 빠진다
        }
      }
      if (!alive.current) return;

      const j: Joined = { ...res, name, topUp };
      // 권한이 아직 없거나 모자라면 사전 안내. 가짜 모드는 흐름 확인용으로 항상 보여 준다(네이티브 beta 에서는 안내가 실제 OS 프롬프트를 띄운다)
      const showPrimer =
        fake || reporter.permission === 'undetermined' || reporter.permission === 'denied' || reporter.permission === 'coarse';
      if (showPrimer) {
        setJoined(j);
      } else {
        if (topUp !== null) alertDialog(`포인트가 모자라 ${topUp.toLocaleString('ko-KR')}P를 채워 드렸어요`);
        await finish(j);
      }
    } catch (e) {
      if (!alive.current) return;
      const err = toLateBetError(e);
      switch (err.code) {
        case 'LB_APPT_CHANGED':
          setChanged(true);
          setFormError(err);
          break;
        case 'LB_SLOT_TAKEN':
        case 'LB_NOT_INVITED':
          // 그새 남이 골랐거나 주최자가 명단을 바꿨다 → 선택을 풀고 명단을 다시 읽는다(칩이 비활성으로 바뀐다)
          select(null);
          setFormError(err);
          void load({ quiet: true, expectChange: true });
          break;
        case 'LB_INVITE_NOT_FOUND':
        case 'LB_JOIN_CLOSED':
        case 'LB_FULL':
        case 'LB_INSUFFICIENT_POINTS':
          setBlock(blockForError(err));
          break;
        default:
          setFormError(err);
          if (!FIXABLE.has(err.code) && !isConnectivityError(err)) setFailCount((c) => c + 1);
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };

  /** [미리보기 새로고침] — 새 조건을 다시 읽고 동의를 다시 받는다 */
  const refreshPreview = () => {
    setChanged(false);
    setFormError(null);
    setAgreeLocation(false);
    setAgreeAge(false);
    void load({ expectChange: true });
  };

  // LocationPrimer 가 권한을 직접 요청·확인하고(네이티브) 허용됐을 때만 onAllow 를 부른다 — 여기서는 넘기기만 한다.
  // (여기서 다시 요청하거나 설정을 열면, 설정에서 돌아와 허용한 뒤에도 옛 권한 값 때문에 설정이 또 열린다)
  const onAllow = async () => {
    if (!joined || finishingRef.current || allowingRef.current) return;
    allowingRef.current = true;
    await finish(joined);
  };

  const wrap = (body: React.ReactNode) => (
    <View style={styles.fill}>
      <FakeDevPanel onChanged={() => void load({ quiet: true })} />
      {body}
    </View>
  );

  const blocked = (b: Block) =>
    wrap(
      <Screen
        footer={
          <View style={styles.footerButtons}>
            {b.action === 'reenter' ? <PrimaryButton label="코드 다시 입력" onPress={reenter} /> : null}
            {b.action === 'retry' ? <PrimaryButton label="다시 시도" onPress={() => void load()} /> : null}
            <PrimaryButton label="홈으로" variant={b.action === 'home' ? 'primary' : 'ghost'} onPress={goHome} />
          </View>
        }
      >
        <EmptyState title={b.message} hint={b.action === 'retry' && failCount >= 3 ? REPEATED_FAILURE_MESSAGE : undefined} />
      </Screen>,
    );

  // ── 코드 형식 오류: 서버를 부르지 않는다 ──
  if (!code) return blocked({ message: errorMessage('LB_INVITE_NOT_FOUND'), action: 'reenter' });

  // ── 참여 직후: 위치 권한 사전 안내 ──
  if (joined) {
    const stake = preview?.policy.stake ?? 0;
    return wrap(
      <Screen>
        <Card>
          <Text style={styles.doneTitle}>참여했어요</Text>
          <Text style={styles.meta}>
            {stake > 0
              ? `'${joined.name}' 이름으로 ${stake}P를 걸었어요. 제시간에 도착하면 그대로 돌려받아요.`
              : `'${joined.name}' 이름으로 들어왔어요. 포인트 없이 위치만 공유하는 약속이에요.`}
          </Text>
          <Text style={styles.meta}>
            {joined.started
              ? '주최자가 이미 시작한 약속이에요. 지금부터 친구들과 서로 위치가 보이고, 도착·지각 판정도 시작돼요. 이제 빠질 수 없어요.'
              : '주최자가 시작하면 서로 위치가 보여요. 시작하기 전까지는 약속 화면에서 나가 포인트를 돌려받을 수 있어요.'}
          </Text>
          {joined.topUp !== null ? (
            <Text style={styles.meta}>포인트가 모자라 {joined.topUp.toLocaleString('ko-KR')}P를 채워 드렸어요</Text>
          ) : null}
        </Card>
        <LocationPrimer
          permission={reporter.permission}
          busy={finishing}
          onAllow={() => void onAllow()}
          onLater={() => void finish(joined)}
        />
      </Screen>,
    );
  }

  if (block) return blocked(block);

  if (loading || !preview || alreadyMemberId) {
    return wrap(
      <Screen>
        <LoadingState />
      </Screen>,
    );
  }

  // ── 미리보기는 받았지만 참여할 수 없는 약속(상태 자체가 끝남·약속 시각 지남) ──
  if (preview.status === 'canceled') return blocked({ message: CANCELED_MESSAGE, action: 'home' });
  if (preview.status !== 'open' || now >= preview.meetAtMs) {
    return blocked({ message: errorMessage('LB_JOIN_CLOSED'), action: 'home' });
  }

  const { policy } = preview;
  const stake = policy.stake;
  /** 주최자가 이미 [시작하기]를 눌렀다 — 그래도 약속 시각 전이면 빈 이름을 고를 수 있다 */
  const started = preview.startedAtMs !== null;
  const unclaimed = preview.invitees.filter((i) => !i.claimed);
  /** 명단에 빈 이름이 없어 고를 수 없다(시작 후에는 주최자도 못 늘린다) */
  const noSlot = unclaimed.length === 0;

  const summary = (
    <Card>
      <Text style={styles.title}>{preview.title}</Text>
      {preview.hostNickname !== '' ? <Text style={styles.meta}>{preview.hostNickname}님이 초대했어요</Text> : null}
      <View style={styles.timeRow}>
        <Text style={styles.when}>{formatKoreanDateTime(preview.meetAtMs, preview.tz)}</Text>
        <FromNowPill targetMs={preview.meetAtMs} />
      </View>
      <Text style={styles.meta}>{tzLabel(preview.tz)} 기준</Text>
      <Text style={styles.place}>{preview.placeName}</Text>
      {preview.placeNote.trim() !== '' ? <Text style={styles.meta}>{preview.placeNote}</Text> : null}
      {started ? <Text style={styles.notice}>{STARTED_NOTICE}</Text> : null}
    </Card>
  );

  const updateCard = needsUpdate ? (
    <Card>
      <Text style={styles.line}>새 버전을 설치해 주세요</Text>
      {installUrl ? (
        <PrimaryButton label="설치" variant="ghost" onPress={() => openExternal(installUrl, '설치 페이지를 열 수 없어요')} />
      ) : null}
    </Card>
  ) : null;

  // ── 고를 이름이 없다(LB_NOT_INVITED). 시작 전이면 주최자가 추가해 줄 수 있고, 시작 후에는 명단이 동결이다 ──
  if (noSlot) {
    return wrap(
      <Screen
        footer={
          <View style={styles.footerButtons}>
            {started ? null : <PrimaryButton label="명단 다시 읽기" variant="ghost" onPress={() => void load()} />}
            <PrimaryButton label="홈으로" onPress={goHome} />
          </View>
        }
      >
        {updateCard}
        {summary}
        <Card>
          <Text style={styles.line}>{errorMessage('LB_NOT_INVITED')}</Text>
          <Text style={styles.meta}>
            {started
              ? '이미 시작한 약속이라 주최자도 이름을 더 추가할 수 없어요.'
              : '주최자가 이름을 추가하면 이 화면에서 바로 고를 수 있어요.'}
          </Text>
        </Card>
        {preview.invitees.length > 0 ? (
          <Row>
            {preview.invitees.map((i) => (
              <Chip key={i.name} label={`${i.name} (들어옴)`} selected={false} disabled />
            ))}
          </Row>
        ) : null}
      </Screen>,
    );
  }

  // ── 조건 카드 + 명단에서 내 이름 고르기 + 동의 ──
  const desc = describePolicy(policy, preview.meetAtMs, preview.tz);
  const shareNotice = started
    ? '들어오는 순간부터 친구들과 서로 위치가 보이고, 도착·지각 판정이 시작돼요. 시작한 뒤에는 빠질 수 없어요.'
    : `${NOT_STARTED_NOTICE} 시작하기 전까지는 약속 화면에서 나가 포인트를 돌려받을 수 있어요.`;
  const myBalance = preview.myBalance ?? balance;
  const bothAgreed = agreeLocation && agreeAge;
  const offlineError = formError !== null && isConnectivityError(formError);
  const joinLabel = offlineError ? '다시 시도' : stake > 0 ? `${stake}P 걸고 참여` : '참여하기';

  return wrap(
    <Screen
      footer={
        changed ? (
          <PrimaryButton label="미리보기 새로고침" onPress={refreshPreview} />
        ) : (
          <PrimaryButton label={joinLabel} onPress={() => void submit()} disabled={busy || selectedName === null || !bothAgreed} />
        )
      }
    >
      {updateCard}
      {summary}

      <MapPane
        readonly
        destination={{ name: preview.placeName, lat: preview.placeLat, lng: preview.placeLng }}
        radiusM={policy.radiusM}
      />
      <Text style={styles.meta}>핀 위치가 맞는지 확인해 주세요</Text>
      <PrimaryButton
        label="카카오맵에서 보기"
        variant="ghost"
        onPress={() => openExternal(mapPinUrl(preview.placeName, preview.placeLat, preview.placeLng))}
      />

      <SectionTitle>내기 조건</SectionTitle>
      <Card>
        {desc.lines.map((line) => (
          <Text key={line} style={line === desc.example ? styles.loss : styles.line}>
            {line}
          </Text>
        ))}
        <Text style={styles.line}>{shareNotice}</Text>
      </Card>

      <SectionTitle>내 이름 고르기</SectionTitle>
      <Card>
        <Text style={styles.meta}>
          {preview.hostNickname !== '' ? `${preview.hostNickname}님이 적어 둔 명단이에요. ` : ''}
          내 이름을 골라 주세요. 이미 들어온 친구는 고를 수 없어요.
        </Text>
        <Row>
          {preview.invitees.map((i) =>
            i.claimed ? (
              <Chip key={i.name} label={`${i.name} (들어옴)`} selected={false} disabled />
            ) : (
              <Chip
                key={i.name}
                label={i.name}
                selected={selectedName === i.name}
                disabled={busy || changed}
                onPress={() => {
                  select(selectedName === i.name ? null : i.name);
                  clearFixable();
                }}
              />
            ),
          )}
        </Row>
        <View style={styles.helpRow}>
          <Text style={[styles.meta, styles.helpText]}>
            {started
              ? '내 이름이 없으면 들어올 수 없어요. 이미 시작한 약속이라 주최자도 이름을 더 추가할 수 없어요.'
              : '내 이름이 없으면 주최자에게 이름을 추가해 달라고 해주세요.'}
          </Text>
          <Text
            style={[styles.link, refreshing && { opacity: 0.4 }]}
            onPress={() => {
              if (!refreshing) void load({ quiet: true });
            }}
          >
            {refreshing ? '읽는 중' : '명단 다시 읽기'}
          </Text>
        </View>
      </Card>

      <SectionTitle>참여</SectionTitle>
      <Text style={styles.meta}>
        지금 {preview.memberCount}명이 들어왔어요 · 아직 안 들어온 친구 {unclaimed.length}명
      </Text>
      <Text style={styles.meta}>
        {myBalance !== null
          ? `보유 포인트 ${myBalance.toLocaleString('ko-KR')}P`
          : `처음이면 ${START_BALANCE.toLocaleString('ko-KR')}P를 드려요. 포인트는 가상이고 돈으로 바꿀 수 없어요.`}
        {myBalance !== null && stake > myBalance ? ' · 모자란 만큼은 참여할 때 채워 드려요.' : ''}
      </Text>

      <CheckRow
        checked={agreeLocation}
        disabled={busy || changed}
        onToggle={() => {
          setAgreeLocation((v) => !v);
          clearFixable();
        }}
        label="주최자가 시작한 뒤부터 도착할 때까지, 앱을 켜 둔 동안 내 위치를 같은 약속의 친구들에게 보여 주는 데 동의해요"
      />
      <CheckRow
        checked={agreeAge}
        disabled={busy || changed}
        onToggle={() => {
          setAgreeAge((v) => !v);
          clearFixable();
        }}
        label="만 14세 이상이에요"
      />
      {!bothAgreed && !formError ? <Text style={styles.meta}>{errorMessage('LB_CONSENT_REQUIRED')}</Text> : null}

      {formError ? (
        <Text style={styles.error}>
          {offlineError ? errorMessage('LB_OFFLINE') + OFFLINE_TAIL : formError.message}
          {failCount >= 3 && !FIXABLE.has(formError.code) && !changed ? ` ${REPEATED_FAILURE_MESSAGE}` : ''}
        </Text>
      ) : null}
    </Screen>,
  );
}

function CheckRow({
  checked,
  label,
  onToggle,
  disabled,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onToggle}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !!disabled }}
      style={({ pressed }) => [styles.checkRow, disabled && { opacity: 0.4 }, pressed && !disabled && { opacity: 0.7 }]}
    >
      <View style={[styles.box, checked && styles.boxChecked]}>{checked ? <View style={styles.boxMark} /> : null}</View>
      <Text style={styles.checkLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  footerButtons: { gap: spacing.sm },
  title: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  when: { fontSize: fontSize.md, fontWeight: '600', color: colors.text, flexShrink: 1 },
  place: { fontSize: fontSize.md, fontWeight: '600', color: colors.text, marginTop: spacing.xs },
  meta: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  line: { fontSize: fontSize.sm, color: colors.text, lineHeight: 20 },
  // 이미 시작한 약속 안내 — 색 없이 굵기로만 세운다
  notice: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text, lineHeight: 20, marginTop: spacing.xs },
  // 잃는 포인트에만 브릭
  loss: { fontSize: fontSize.sm, fontWeight: '700', color: colors.danger, lineHeight: 20 },
  doneTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  error: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text, lineHeight: 20 },
  helpRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  helpText: { flex: 1, minWidth: 160 },
  link: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text, textDecorationLine: 'underline' },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  boxChecked: { backgroundColor: colors.primary },
  // 체크 표시: 두 변만 그린 사각형을 45도 돌린다(이모지·아이콘 폰트 없이)
  boxMark: {
    width: 6,
    height: 11,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderColor: colors.onPrimary,
    transform: [{ rotate: '45deg' }],
    marginTop: -2,
  },
  checkLabel: { flex: 1, fontSize: fontSize.sm, color: colors.text, lineHeight: 20 },
});
