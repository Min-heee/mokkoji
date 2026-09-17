/**
 * 대기실(phase = waiting, 잠금 전) — 설계서 §3.2·§3.6·§3.7·§5.3-F. 담당: [waiting]
 *
 *   참여 요청 카드(주최자) → 약속 조건 + 핀 지도(readonly) → 참가자 → 주최자 도구
 *   footer: 잠금 안내 한 줄 + 주최자 [친구 초대하기] / 게스트 [나가기 (포인트 돌려받기)]
 *
 * 규칙
 * - 변경 RPC 뒤에는 refresh(). 내가 빠지는 동작(나가기) 뒤에는 onLeft(). 낙관적 업데이트 없음.
 * - 파괴적 동작(내보내기·차단 거절·취소·나가기)은 confirmDialog. 실패 문구는 errors.ts 의 것만 쓴다.
 * - 잠금 뒤에는 나가기·내보내기·(친구가 있을 때) 취소가 안 된다. 서버가 최종 판단하지만,
 *   눌렀을 때 이미 잠겼으면 서버에 묻기 전에 같은 문구로 안내하고 다시 읽는다(곧 라이브 화면으로 넘어간다).
 *
 * 잠금 뒤 화면(LiveView·ArrivedView)에서도 주최자는 요청을 수락해야 한다 → 아래 조각은 혼자 동작하게 만들어 내보낸다:
 *   JoinRequests · JoinClosedButton · shareInvite · copyInvite
 */
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Share, StyleSheet, Text, View } from 'react-native';

import { buildShareText } from '@/domain/invite';
import { isLocked } from '@/domain/latePhase';
import { formatFromNow, formatKoreanDate, formatKoreanTime, isSameLocalDay } from '@/domain/tzGuard';
import { Card, PrimaryButton, Screen, SectionTitle, TextField } from '@/ui/components';
import { alertDialog, confirmDialog } from '@/ui/dialogs';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

import type { LateBetApi } from '../api';
import { APPROVE_INSUFFICIENT_MESSAGE, errorMessage, toLateBetError, type LateBetError } from '../errors';
import { useLateBet } from '../LateBetContext';
import { cancelLateNotifications, canScheduleExactAlarms, scheduleLateNotifications } from '../notifications';
import { serverNow } from '../serverClock';
import type { LbAppointment, LbLive, LbLiveParticipant } from '../types';
import { useServerNow } from '../useServerNow';
import { ConditionCard } from './PendingView';
import type { WaitingViewProps } from './props';

// ───────────────────────── 초대 문구 공유 ─────────────────────────

/** 초대 문구(설계서 §3.1). 초대 코드가 없으면(승인 대기자) '' */
export function inviteShareText(a: LbAppointment, changed = false): string {
  if (!a.inviteCode) return '';
  return buildShareText({
    title: a.title,
    meetAtMs: a.meetAtMs,
    tz: a.tz,
    placeName: a.placeName,
    policy: a.policy,
    inviteCode: a.inviteCode,
    changed,
  });
}

/** 초대 문구를 클립보드에. 클립보드가 막혀 있으면 문구를 그대로 보여 준다 */
export async function copyInvite(a: LbAppointment, changed = false): Promise<void> {
  const message = inviteShareText(a, changed);
  if (message === '') {
    alertDialog('초대 코드를 불러오지 못했어요', errorMessage(null));
    return;
  }
  try {
    await Clipboard.setStringAsync(message);
    alertDialog('초대 문구를 복사했어요', '카톡에 붙여넣어 친구에게 보내 주세요');
  } catch {
    alertDialog('초대 문구', message);
  }
}

/** [친구 초대하기] — OS 공유 시트. 공유 시트가 없는 웹 브라우저에서는 복사로 대신한다 */
export async function shareInvite(a: LbAppointment, changed = false): Promise<void> {
  const message = inviteShareText(a, changed);
  if (message === '') {
    alertDialog('초대 코드를 불러오지 못했어요', errorMessage(null));
    return;
  }
  const webShare = typeof navigator !== 'undefined' && typeof (navigator as { share?: unknown }).share === 'function';
  if (Platform.OS === 'web' && !webShare) {
    await copyInvite(a, changed);
    return;
  }
  try {
    await Share.share({ message });
  } catch {
    // 사용자가 공유 시트를 닫은 경우 등은 무시한다
  }
}

// ───────────────────────── 한 번에 하나씩 실행 ─────────────────────────

type Act = (
  key: string,
  failTitle: string,
  fn: () => Promise<void>,
  /** 오류 → 문구를 바꿔 끼울 때(수락의 포인트 부족) */
  mapMessage?: (e: LateBetError) => string,
) => Promise<void>;

/** 변경 RPC 실행기: 연타 방지 + 실패하면 errors.ts 문구로 알리고 다시 읽는다 */
function useAct(refresh: () => Promise<LbLive | null>): { busy: string | null; act: Act } {
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const act = useCallback<Act>(
    async (key, failTitle, fn, mapMessage) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(key);
      try {
        await fn();
      } catch (e) {
        const err = toLateBetError(e);
        alertDialog(failTitle, mapMessage ? mapMessage(err) : err.message);
        await refresh();
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(null);
      }
    },
    [refresh],
  );

  return { busy, act };
}

// ───────────────────────── 참여 요청 카드 (주최자) ─────────────────────────

export interface JoinRequestsProps {
  live: LbLive;
  isHost: boolean;
  api: LateBetApi;
  refresh: () => Promise<LbLive | null>;
  /** 연결이 끊겨 있으면 버튼을 막는다 */
  stale?: boolean;
}

/**
 * "현우님이 참여를 요청했어요 [수락] [거절]" — 요청마다 카드 한 장. 주최자가 아니거나 요청이 없으면 null.
 * 거절을 누르면 카드 안에서 [거절] / [거절하고 다시 못 들어오게]를 고른다(설계서 §3.2의 시트).
 * 혼자 동작한다(연타 방지·오류 안내·refresh 포함) — LiveView·ArrivedView 에 그대로 얹을 수 있다.
 */
export function JoinRequests({ live, isHost, api, refresh, stale = false }: JoinRequestsProps) {
  const { busy, act } = useAct(refresh);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const a = live.appointment;
  const requests = isHost ? live.participants.filter((p) => p.state === 'pending') : [];
  if (requests.length === 0) return null;

  const stake = a.policy.stake;
  const disabled = busy !== null || stale;

  const approve = (p: LbLiveParticipant) =>
    act(
      `approve:${p.userId}`,
      '수락하지 못했어요',
      async () => {
        await api.approve(a.id, p.userId);
        await refresh();
      },
      (e) => (e.code === 'LB_INSUFFICIENT_POINTS' ? APPROVE_INSUFFICIENT_MESSAGE : e.message),
    );

  const reject = (p: LbLiveParticipant, ban: boolean) =>
    act(`reject:${p.userId}`, '거절하지 못했어요', async () => {
      await api.kick(a.id, p.userId, ban);
      setRejectingId(null);
      await refresh();
    });

  const askRejectAndBan = (p: LbLiveParticipant) => {
    confirmDialog(
      `${p.nickname}님이 다시 못 들어오게 할까요?`,
      '이 약속에는 다시 요청할 수 없게 돼요. 되돌릴 수 없어요.',
      () => void reject(p, true),
      { confirmText: '거절하기', destructive: true },
    );
  };

  return (
    <View style={styles.requests}>
      {requests.map((p) => (
        <Card key={p.userId} style={styles.requestCard}>
          <Text style={styles.requestTitle}>{p.nickname}님이 참여를 요청했어요</Text>
          <Text style={styles.muted}>
            아는 친구일 때만 수락해 주세요. 수락하면 서로 위치가 보여요
            {stake > 0 ? `. 그 순간 친구의 ${stake}P가 걸려요.` : '.'}
          </Text>
          {rejectingId === p.userId ? (
            <View style={styles.stack}>
              <PrimaryButton label="거절" variant="ghost" onPress={() => void reject(p, false)} disabled={disabled} />
              <PrimaryButton label="거절하고 다시 못 들어오게" variant="ghost" onPress={() => askRejectAndBan(p)} disabled={disabled} />
              <Text style={styles.textButton} onPress={() => setRejectingId(null)}>
                닫기
              </Text>
            </View>
          ) : (
            <View style={styles.pair}>
              <View style={styles.pairItem}>
                <PrimaryButton label="수락" onPress={() => void approve(p)} disabled={disabled} />
              </View>
              <View style={styles.pairItem}>
                <PrimaryButton label="거절" variant="ghost" onPress={() => setRejectingId(p.userId)} disabled={disabled} />
              </View>
            </View>
          )}
        </Card>
      ))}
    </View>
  );
}

// ───────────────────────── [참여 마감] 토글 (주최자) ─────────────────────────

export interface JoinClosedButtonProps {
  appointment: LbAppointment;
  api: LateBetApi;
  refresh: () => Promise<LbLive | null>;
  stale?: boolean;
}

/** 상태 한 줄 + 풀폭 버튼. 되돌릴 수 있는 동작이라 확인 없이 바로 바꾼다 */
export function JoinClosedButton({ appointment: a, api, refresh, stale = false }: JoinClosedButtonProps) {
  const { busy, act } = useAct(refresh);
  const toggle = () =>
    act('joinClosed', a.joinClosed ? '참여를 다시 받지 못했어요' : '참여를 마감하지 못했어요', async () => {
      await api.setJoinClosed(a.id, !a.joinClosed);
      await refresh();
    });
  return (
    <View style={styles.stack}>
      <Text style={styles.muted}>
        {a.joinClosed
          ? '참여를 마감했어요. 초대 링크로 더 들어올 수 없어요.'
          : '지금은 초대 링크를 받은 사람이 들어올 수 있어요. 다 모였으면 마감해 주세요.'}
      </Text>
      <PrimaryButton
        label={a.joinClosed ? '참여 다시 받기' : '참여 마감'}
        variant="ghost"
        onPress={() => void toggle()}
        disabled={busy !== null || stale}
      />
    </View>
  );
}

// ───────────────────────── 새 참가자·요청 알림 띠 ─────────────────────────

interface SeenRow {
  nickname: string;
  state: LbLiveParticipant['state'];
}

/** 폴링 사이에 늘어난 참가자·요청을 5초 동안 한 줄로 알린다(설계서 §3.2 "활성 멤버 모두에게 토스트") */
function useRosterNotice(live: LbLive): { notice: string | null; forget: (userId: string) => void } {
  const seen = useRef<Map<string, SeenRow> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const prev = seen.current;
    const next = new Map<string, SeenRow>();
    for (const p of live.participants) next.set(p.userId, { nickname: p.nickname, state: p.state });
    seen.current = next;
    if (!prev) return; // 처음 본 명단은 알리지 않는다

    const messages: string[] = [];
    for (const p of live.participants) {
      if (p.userId === live.myUserId) continue;
      const before = prev.get(p.userId);
      if (!before) messages.push(p.state === 'pending' ? `${p.nickname}님이 참여를 요청했어요` : `${p.nickname}님이 참여했어요`);
      else if (before.state === 'pending' && p.state === 'active') messages.push(`${p.nickname}님이 참여했어요`);
    }
    // 요청이 사라진 것(거절·철회)은 알리지 않는다
    for (const [userId, row] of prev) {
      if (!next.has(userId) && row.state === 'active') messages.push(`${row.nickname}님이 나갔어요`);
    }
    if (messages.length > 0) setNotice(messages.join(' · '));
  }, [live]);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  /** 내가 직접 내보낸 사람은 "나갔어요"로 알리지 않는다 */
  const forget = useCallback((userId: string) => {
    seen.current?.delete(userId);
  }, []);

  return { notice, forget };
}

// ───────────────────────── 잠금 안내 (footer) ─────────────────────────

/** "오후 6:30에 위치 공유가 시작돼요. 그 뒤에는 빠질 수 없어요." 오늘이 아니면 날짜를 붙인다 */
function LockNotice({ appointment: a, isHost }: { appointment: LbAppointment; isHost: boolean }) {
  const now = useServerNow(30_000);
  const time = formatKoreanTime(a.shareStartMs, a.tz);
  const when = isSameLocalDay(now, a.shareStartMs, a.tz) ? time : `${formatKoreanDate(a.shareStartMs, a.tz)} ${time}`;
  const left = a.shareStartMs > now ? ` (${formatFromNow(a.shareStartMs - now)})` : '';
  return (
    <Text style={styles.lockNotice}>
      {when}에 위치 공유가 시작돼요{left}. {isHost ? '그 뒤에는 내보내거나 취소할 수 없어요.' : '그 뒤에는 빠질 수 없어요.'}
    </Text>
  );
}

// ───────────────────────── 참가자 한 줄 ─────────────────────────

function ParticipantRow({
  p,
  isMe,
  isHostRow,
  onKick,
  disabled,
}: {
  p: LbLiveParticipant;
  isMe: boolean;
  isHostRow: boolean;
  /** 주최자가 다른 사람을 볼 때만 */
  onKick?: () => void;
  disabled: boolean;
}) {
  const tags = [isHostRow ? '주최자' : '', isMe ? '나' : ''].filter((s) => s !== '').join(' · ');
  return (
    <View style={styles.personRow}>
      <View style={styles.initial}>
        <Text style={styles.initialText}>{Array.from(p.nickname)[0] ?? ''}</Text>
      </View>
      <Text style={styles.personName} numberOfLines={1}>
        {p.nickname}
      </Text>
      {tags !== '' ? <Text style={styles.personTag}>{tags}</Text> : null}
      {onKick ? (
        <Text style={[styles.textButton, styles.kick, disabled && styles.dim]} onPress={disabled ? undefined : onKick}>
          내보내기
        </Text>
      ) : null}
    </View>
  );
}

// ───────────────────────── 대기실 ─────────────────────────

export function WaitingView({ live, isHost, api, refresh, stale, onLeft }: WaitingViewProps) {
  const router = useRouter();
  const params = useLocalSearchParams<{ invite?: string }>();
  const { refresh: refreshHome } = useLateBet();
  const { busy, act } = useAct(refresh);
  const { notice, forget } = useRosterNotice(live);

  const a = live.appointment;
  const stake = a.policy.stake;
  const actives = live.participants.filter((p) => p.state === 'active');
  const pendings = live.participants.filter((p) => p.state === 'pending');
  const otherActives = actives.filter((p) => p.userId !== live.myUserId);
  /** 다른 행(요청 포함)이 하나도 없다 = 시간·장소·조건을 고칠 수 있다 (서버 LB_EDIT_LOCKED 와 같은 조건) */
  const alone = live.participants.every((p) => p.userId === live.myUserId);
  const disabled = busy !== null || stale;
  /** 취소하고 새로 만든 약속이면 /late/<id>?invite=changed 로 들어온다 → 공유 문구 앞에 [변경] */
  const changed = params.invite === 'changed';

  // 제목·장소 메모 고치기 (언제든 — lb_update_memo)
  const [memoOpen, setMemoOpen] = useState(false);
  const [titleText, setTitleText] = useState(a.title);
  const [noteText, setNoteText] = useState(a.placeNote);

  // 안드로이드 정확한 알림 권한(§5.4). P0 에서는 항상 true 라 경고가 뜨지 않는다
  const [exactAlarmOk, setExactAlarmOk] = useState(true);
  useEffect(() => {
    let alive = true;
    canScheduleExactAlarms()
      .then((ok) => {
        if (alive) setExactAlarmOk(ok);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // 조건(version)·제목이 바뀌면 로컬 알림을 다시 예약한다. 키가 (id + version) 이라 여러 번 불러도 같다
  useEffect(() => {
    void scheduleLateNotifications({
      id: a.id,
      version: a.version,
      title: a.title,
      tz: a.tz,
      meetAtMs: a.meetAtMs,
      shareStartMs: a.shareStartMs,
      closeMs: a.closeMs,
    });
  }, [a.id, a.version, a.title, a.tz, a.meetAtMs, a.shareStartMs, a.closeMs]);

  // 생성 직후(?invite=…) 공유 시트를 한 번 연다. 웹은 사용자 제스처 없이 공유를 열 수 없어 건너뛴다
  const autoShared = useRef(false);
  useEffect(() => {
    if (autoShared.current || !isHost || !params.invite || !a.inviteCode || Platform.OS === 'web') return;
    autoShared.current = true;
    void shareInvite(a, changed);
    // 첫 진입 때 1회
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, params.invite, a.inviteCode]);

  /** 눌렀을 때 이미 잠겼으면 서버에 묻지 않고 같은 문구로 안내한다 */
  const blockedByLock = (title: string, code: 'LB_LEAVE_CLOSED' | 'LB_KICK_CLOSED' | 'LB_CANCEL_CLOSED'): boolean => {
    if (!isLocked(a, serverNow())) return false;
    alertDialog(title, errorMessage(code));
    void refresh();
    return true;
  };

  // ── 게스트: 나가기 ──
  const askLeave = () => {
    if (blockedByLock('지금은 나갈 수 없어요', 'LB_LEAVE_CLOSED')) return;
    confirmDialog(
      '약속에서 나갈까요?',
      stake > 0 ? `건 ${stake}P는 바로 돌려드려요. 초대 링크로 다시 들어올 수 있어요.` : '초대 링크로 다시 들어올 수 있어요.',
      () =>
        void act('leave', '나가지 못했어요', async () => {
          await api.leave(a.id);
          onLeft(); // refresh 대신 — 안 그러면 "주최자가 내보냈어요"가 뜬다
        }),
      { confirmText: '나가기', destructive: true },
    );
  };

  // ── 주최자: 내보내기 (전액 환불 + 기본으로 차단) ──
  const askKick = (p: LbLiveParticipant) => {
    if (blockedByLock('지금은 내보낼 수 없어요', 'LB_KICK_CLOSED')) return;
    confirmDialog(
      `${p.nickname}님을 내보낼까요?`,
      `${stake > 0 ? `건 ${stake}P는 돌려드려요. ` : ''}이 약속에는 다시 들어올 수 없어요.`,
      () =>
        void act(`kick:${p.userId}`, '내보내지 못했어요', async () => {
          await api.kick(a.id, p.userId, true);
          forget(p.userId);
          await refresh();
        }),
      { confirmText: '내보내기', destructive: true },
    );
  };

  // ── 주최자: 약속 취소 ──
  const refundLine =
    stake === 0
      ? ''
      : otherActives.length > 0
        ? `친구 ${otherActives.length}명이 건 포인트는 모두 돌려드려요.`
        : `건 ${stake}P는 돌려드려요.`;

  const askCancel = () => {
    if (otherActives.length > 0 && blockedByLock('지금은 취소할 수 없어요', 'LB_CANCEL_CLOSED')) return;
    confirmDialog(
      '약속을 취소할까요?',
      [refundLine, '취소하면 되돌릴 수 없어요.'].filter((s) => s !== '').join(' '),
      () =>
        void act('cancel', '취소하지 못했어요', async () => {
          await api.cancel(a.id);
          await refresh(); // 컨테이너가 취소 안내를 그리고 알림·홈 목록을 정리한다
        }),
      { confirmText: '네, 취소할게요', destructive: true },
    );
  };

  // ── 주최자: 취소하고 새로 만들기 (친구가 있어 조건을 못 바꿀 때) ──
  const askCancelAndRecreate = () => {
    if (otherActives.length > 0 && blockedByLock('지금은 바꿀 수 없어요', 'LB_CANCEL_CLOSED')) return;
    confirmDialog(
      '취소하고 새로 만들까요?',
      [refundLine, '새 링크를 다시 보내야 해요.'].filter((s) => s !== '').join(' '),
      () =>
        void act('recreate', '취소하지 못했어요', async () => {
          await api.cancel(a.id);
          // 여기서는 refresh 하지 않는다 — 취소 안내가 번쩍이지 않게 곧바로 생성 화면으로 바꾼다
          void cancelLateNotifications(a.id);
          void refreshHome();
          router.replace(`/late/new?from=${a.id}`);
        }),
      { confirmText: '취소하고 새로 만들기', destructive: true },
    );
  };

  // ── 주최자: 제목·장소 메모 ──
  const openMemo = () => {
    setTitleText(a.title);
    setNoteText(a.placeNote);
    setMemoOpen(true);
  };
  const saveMemo = () =>
    act('memo', '저장하지 못했어요', async () => {
      await api.updateMemo(a.id, titleText.trim(), noteText.trim());
      setMemoOpen(false);
      await refresh();
    });

  const openSettings = () => {
    Linking.openSettings().catch(() => alertDialog('설정을 열 수 없어요'));
  };

  const footer = (
    <>
      <LockNotice appointment={a} isHost={isHost} />
      {isHost ? (
        <PrimaryButton label="친구 초대하기" onPress={() => void shareInvite(a, changed)} disabled={a.joinClosed || !a.inviteCode} />
      ) : (
        <PrimaryButton
          label={stake > 0 ? '나가기 (포인트 돌려받기)' : '나가기'}
          variant="ghost"
          onPress={askLeave}
          disabled={disabled}
        />
      )}
    </>
  );

  return (
    <View style={styles.fill}>
      <Screen footer={footer}>
        <JoinRequests live={live} isHost={isHost} api={api} refresh={refresh} stale={stale} />

        {!exactAlarmOk ? (
          <Card>
            <Text style={styles.body}>알림이 늦게 올 수 있어요</Text>
            <Text style={styles.textButton} onPress={openSettings}>
              설정 열기
            </Text>
          </Card>
        ) : null}

        <SectionTitle>약속</SectionTitle>
        <ConditionCard
          appointment={a}
          pinHint={isHost ? '핀 위치가 맞는지 확인해 주세요' : '핀 위치가 이상하면 주최자에게 알려 주세요'}
        />

        <SectionTitle>참가자 {actives.length}명</SectionTitle>
        <Card>
          {actives.map((p) => (
            <ParticipantRow
              key={p.userId}
              p={p}
              isMe={p.userId === live.myUserId}
              isHostRow={p.userId === a.hostId}
              onKick={isHost && p.userId !== live.myUserId ? () => askKick(p) : undefined}
              disabled={disabled}
            />
          ))}
          {otherActives.length === 0 ? (
            <Text style={styles.muted}>
              {isHost ? '아직 혼자예요. 친구를 초대해 보세요.' : '아직 다른 참가자가 없어요.'}
            </Text>
          ) : stake > 0 ? (
            <Text style={styles.muted}>한 사람당 {stake}P씩 걸었어요.</Text>
          ) : null}
          {!isHost && pendings.length > 0 ? (
            <Text style={styles.muted}>수락을 기다리는 친구: {pendings.map((p) => p.nickname).join(', ')}</Text>
          ) : null}
        </Card>

        {isHost ? (
          <>
            <SectionTitle>주최자 도구</SectionTitle>
            <Card>
              {a.inviteCode ? (
                <View style={styles.codeRow}>
                  <Text style={styles.muted}>초대 코드</Text>
                  <Text style={styles.code}>{a.inviteCode}</Text>
                  <Text style={[styles.textButton, styles.kick]} onPress={() => void copyInvite(a, changed)}>
                    초대 문구 복사
                  </Text>
                </View>
              ) : null}
              <JoinClosedButton appointment={a} api={api} refresh={refresh} stale={stale} />
            </Card>

            <Card>
              {alone ? (
                <>
                  <Text style={styles.muted}>
                    혼자일 때는 시간·장소·내기 조건을 모두 바꿀 수 있어요. 친구가 들어온 뒤에는 바꿀 수 없어요.
                  </Text>
                  <PrimaryButton
                    label="약속 수정"
                    variant="ghost"
                    onPress={() => router.push(`/late/new?edit=${a.id}`)}
                    disabled={disabled}
                  />
                </>
              ) : (
                <>
                  <Text style={styles.body}>{errorMessage('LB_EDIT_LOCKED')}</Text>
                  <Text style={styles.muted}>
                    {refundLine !== '' ? `${refundLine} ` : ''}새 링크를 다시 보내야 해요. 제목과 장소 메모는 취소하지 않고도 고칠
                    수 있어요.
                  </Text>
                  <PrimaryButton label="취소하고 새로 만들기" variant="ghost" onPress={askCancelAndRecreate} disabled={disabled} />
                </>
              )}

              {memoOpen ? (
                <View style={styles.stack}>
                  <TextField label="제목 (1~40자)" value={titleText} onChangeText={setTitleText} placeholder="예: 금요일 곱창" />
                  <TextField
                    label="장소 메모 (선택)"
                    value={noteText}
                    onChangeText={setNoteText}
                    placeholder="예: 2번 출구에서 도보 3분"
                  />
                  <View style={styles.pair}>
                    <View style={styles.pairItem}>
                      <PrimaryButton label="저장" onPress={() => void saveMemo()} disabled={disabled || titleText.trim() === ''} />
                    </View>
                    <View style={styles.pairItem}>
                      <PrimaryButton label="닫기" variant="ghost" onPress={() => setMemoOpen(false)} />
                    </View>
                  </View>
                </View>
              ) : (
                <PrimaryButton label="제목·장소 메모 고치기" variant="ghost" onPress={openMemo} disabled={disabled} />
              )}
            </Card>

            <Card>
              <Text style={styles.muted}>
                위치 공유가 시작되면 친구를 내보낼 수 없고, 친구가 있으면 약속도 취소할 수 없어요. 그 뒤에 들어오는 친구는 한 명씩
                수락해 주세요.
              </Text>
              <PrimaryButton label="약속 취소" variant="ghost" onPress={askCancel} disabled={disabled} />
            </Card>
          </>
        ) : null}
      </Screen>

      {notice !== null ? (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{notice}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  stack: { gap: spacing.sm },
  pair: { flexDirection: 'row', gap: spacing.sm },
  pairItem: { flex: 1 },
  body: { fontSize: fontSize.md, fontWeight: '600', color: colors.text, lineHeight: 22 },
  muted: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  dim: { opacity: 0.4 },
  textButton: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text, textDecorationLine: 'underline', paddingVertical: spacing.xs },

  requests: { gap: spacing.md },
  requestCard: { borderWidth: 1, borderColor: colors.text },
  requestTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.text },

  personRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 36 },
  initial: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: colors.cardAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initialText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text },
  personName: { flexShrink: 1, fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  personTag: { fontSize: fontSize.xs, fontWeight: '600', color: colors.subtext },
  kick: { marginLeft: 'auto' },

  codeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  code: { fontSize: fontSize.md, fontWeight: '800', color: colors.text, letterSpacing: 2 },

  lockNotice: { fontSize: fontSize.sm, color: colors.subtext, textAlign: 'center', lineHeight: 20 },

  toast: {
    pointerEvents: 'none',
    position: 'absolute',
    top: spacing.md,
    left: spacing.lg,
    right: spacing.lg,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  toastText: { color: colors.onPrimary, fontSize: fontSize.sm, fontWeight: '700' },
});
