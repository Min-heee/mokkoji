/**
 * 대기실(phase = waiting) — 설계서 §0-1(오너 확정 흐름 2026-09-18)·§5.3-F. 담당: [waiting]
 *
 *   waiting = 주최자가 아직 [시작하기]를 누르지 않았다(startedAtMs 없음). 위치는 아무도 못 보고 체크인도 안 열린다.
 *   시작은 서버 응답으로만 바뀐다 — 주최자는 api.start 뒤 refresh, 게스트는 폴링(10초)으로 live 화면을 본다.
 *
 *   [변경 배너(게스트)] → 약속 조건 + 핀 지도(readonly) → 명단(참여 완료 / 아직 안 들어옴, 주최자는 [내보내기])
 *   → 주최자: 초대 명단 편집(InviteeEditor) · 초대 코드 + [친구 초대하기] · 약속 수정(/late/new?edit=id) · 제목·메모 · 약속 취소
 *   footer: 주최자 = 설명 한 줄 + primary [시작하기] / 게스트 = "주최자가 시작하면 위치가 보여요" + [나가기 (포인트 돌려받기)]
 *
 * 규칙
 * - 변경 RPC 뒤에는 refresh(). 내가 빠지는 동작(나가기) 뒤에는 onLeft(). 낙관적 업데이트 없음.
 * - 파괴적 동작(내보내기·취소·나가기)과 혼자 시작은 confirmDialog. 실패 문구는 errors.ts 의 것만 쓴다.
 * - 시작 전에는 명단 편집·나가기·내보내기·취소·조건 변경 전부가 된다(잠금 개념 없음). 시작 후 규칙은 LiveView 몫이다.
 * - 약속 시각(meetAtMs)이 지나면 시작할 수 없다(LB_START_CLOSED). 눌렀을 때 이미 지났으면 서버에 묻기 전에 같은 문구로 안내하고
 *   다시 읽는다(useLive 가 무효(voided) 화면으로 넘긴다).
 * - 수락제(pending·승인·참여 요청·[참여 마감])와 '전원 참여 시 자동 잠금'은 없다.
 *
 * 다른 화면이 그대로 쓸 수 있게 내보내는 조각: shareInvite · copyInvite · inviteShareText
 */
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Share, StyleSheet, Text, View } from 'react-native';

import { buildShareText } from '@/domain/invite';
import { Card, PrimaryButton, Screen, SectionTitle, TextField } from '@/ui/components';
import { alertDialog, confirmDialog } from '@/ui/dialogs';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

import { describeChanges } from '../changes';
import { errorMessage, toLateBetError } from '../errors';
import { serverNow } from '../serverClock';
import type { LbAppointment, LbAppointmentChange, LbInvitee, LbLive, LbLiveParticipant } from '../types';
import { ConditionCard } from './ConditionCard';
import { InviteeEditor } from './InviteeEditor';
import type { WaitingViewProps } from './props';

// ───────────────────────── 초대 문구 공유 ─────────────────────────

/** 초대 문구(설계서 §3.1). 코드가 형식에 안 맞으면 '' */
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

// ───────────────────────── 이름 다루기 ─────────────────────────

/** 보이지 않는 문자(서버 lb_clean_nick 과 같은 목록) */
const INVISIBLE = /[\u00AD\u200B-\u200F\u2028-\u202F\u2060-\u2064\uFEFF]/g;
const cleanName = (raw: string): string => raw.replace(INVISIBLE, '').trim();
/** 서버 lb_nick_key 와 같은 판정: NFKC + 공백 제거 + 소문자 (프로덕션에서 fakeApi 를 import 하지 않기 위해 여기 다시 둔다) */
const nameKey = (raw: string): string => cleanName(raw).normalize('NFKC').replace(/\s/g, '').toLowerCase();

// ───────────────────────── 한 번에 하나씩 실행 ─────────────────────────

/** 실패하면 오류 문구를 돌려준다(성공은 null). silent 가 아니면 alertDialog 로도 알린다 */
type Act = (key: string, failTitle: string, fn: () => Promise<void>, silent?: boolean) => Promise<string | null>;

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
    async (key, failTitle, fn, silent = false) => {
      if (busyRef.current) return null;
      busyRef.current = true;
      setBusy(key);
      try {
        await fn();
        return null;
      } catch (e) {
        const message = toLateBetError(e).message;
        if (!silent) alertDialog(failTitle, message);
        await refresh();
        return message;
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(null);
      }
    },
    [refresh],
  );

  return { busy, act };
}

// ───────────────────────── 변경 배너 (게스트) ─────────────────────────

/**
 * "주최자가 약속을 바꿨어요: 오후 7:30 → 오후 8:00 · 건 포인트 100P → 200P" + [확인].
 * 변경이 없거나(주최자 본인은 항상 []) 실질 변화가 없으면 null. (LiveView 는 자기 것을 따로 가진다)
 */
function ChangeBanner({ changes, tz, onAck }: { changes: LbAppointmentChange[]; tz: string; onAck: () => void }) {
  const text = describeChanges(changes, tz);
  if (text === '') return null;
  return (
    <Card style={styles.banner}>
      <Text style={styles.bannerText}>{text}</Text>
      <PrimaryButton label="확인" variant="ghost" onPress={onAck} />
    </Card>
  );
}

// ───────────────────────── 새 참가자 알림 띠 ─────────────────────────

/** 폴링 사이에 들어오거나 나간 사람을 5초 동안 한 줄로 알린다(설계서 §3.2 "활성 멤버 모두에게 토스트") */
function useRosterNotice(live: LbLive): { notice: string | null; forget: (userId: string) => void } {
  const seen = useRef<Map<string, string> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const prev = seen.current;
    const next = new Map<string, string>();
    for (const p of live.participants) next.set(p.userId, p.nickname);
    seen.current = next;
    if (!prev) return; // 처음 본 명단은 알리지 않는다

    const messages: string[] = [];
    for (const p of live.participants) {
      if (p.userId === live.myUserId) continue;
      if (!prev.has(p.userId)) messages.push(`${p.nickname}님이 들어왔어요`);
    }
    for (const [userId, nickname] of prev) {
      if (!next.has(userId)) messages.push(`${nickname}님이 나갔어요`);
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

// ───────────────────────── 명단 한 줄 ─────────────────────────

function RosterRow({
  name,
  tags,
  status,
  dim,
  action,
  onAction,
  disabled,
}: {
  name: string;
  /** '주최자 · 나' 같은 꼬리표 */
  tags: string;
  /** 오른쪽 상태 문구(동작 버튼이 없을 때) */
  status?: string;
  dim?: boolean;
  /** 오른쪽 텍스트 버튼(내보내기) */
  action?: string;
  onAction?: () => void;
  disabled: boolean;
}) {
  return (
    <View style={[styles.personRow, dim && styles.dimRow]}>
      <View style={styles.initial}>
        <Text style={styles.initialText}>{Array.from(name)[0] ?? ''}</Text>
      </View>
      <Text style={styles.personName} numberOfLines={1}>
        {name}
      </Text>
      {tags !== '' ? <Text style={styles.personTag}>{tags}</Text> : null}
      {action && onAction ? (
        <Text style={[styles.textButton, styles.trailing, disabled && styles.dim]} onPress={disabled ? undefined : onAction}>
          {action}
        </Text>
      ) : status ? (
        <Text style={[styles.personTag, styles.trailing]}>{status}</Text>
      ) : null}
    </View>
  );
}

// ───────────────────────── 대기실 ─────────────────────────

/** 주최자 [시작하기] 버튼 아래 설명(설계서 §0-1 규칙 7) */
export const START_HINT = '누르면 모두의 위치가 서로 보여요. 아직 안 들어온 친구는 나중에 들어와도 돼요';
/** 게스트 footer 안내 */
export const GUEST_WAIT_HINT = '주최자가 시작하면 위치가 보여요';

export function WaitingView({ live, isHost, api, refresh, stale, unseenChanges, ackChanges, onLeft }: WaitingViewProps) {
  const router = useRouter();
  const params = useLocalSearchParams<{ invite?: string }>();
  const { busy, act } = useAct(refresh);
  const { notice, forget } = useRosterNotice(live);

  const a = live.appointment;
  const stake = a.policy.stake;
  const host = live.participants.find((p) => p.userId === a.hostId) ?? null;
  const others = live.participants.filter((p) => p.userId !== a.hostId);
  const byUser = new Map(live.participants.map((p) => [p.userId, p] as const));
  const claimed = a.invitees.filter((i) => i.claimedByUserId !== null);
  const missing = a.invitees.filter((i) => i.claimedByUserId === null);
  const disabled = busy !== null || stale;
  /** /late/<id>?invite=changed 로 들어오면 공유 문구 앞에 [변경] */
  const changed = params.invite === 'changed';

  // 제목·장소 메모 고치기 (언제든 — lb_update_memo, version 안 올림)
  const [memoOpen, setMemoOpen] = useState(false);
  const [titleText, setTitleText] = useState(a.title);
  const [noteText, setNoteText] = useState(a.placeNote);

  // 로컬 알림 예약은 컨테이너(app/late/[id] 의 useLateReminders)가 서버 응답마다 맞춘다

  // 생성 직후(?invite=…) 공유 시트를 한 번 연다. 웹은 사용자 제스처 없이 공유를 열 수 없어 건너뛴다
  const autoShared = useRef(false);
  useEffect(() => {
    if (autoShared.current || !isHost || !params.invite || !a.inviteCode || Platform.OS === 'web') return;
    autoShared.current = true;
    void shareInvite(a, changed);
    // 첫 진입 때 1회
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, params.invite, a.inviteCode]);

  // ── 주최자: [시작하기] (약속 시각 전이면 언제든. 되돌릴 수 없다) ──
  const startNow = () =>
    void act('start', '시작하지 못했어요', async () => {
      await api.start(a.id);
      await refresh(); // phase 가 live 로 바뀌어 컨테이너가 LiveView 를 그린다
    });
  const askStart = () => {
    // 약속 시각이 지났으면 서버도 LB_START_CLOSED 다. 묻기 전에 같은 문구로 안내하고 다시 읽는다(무효 화면으로 넘어간다)
    if (serverNow() >= a.meetAtMs) {
      alertDialog('시작할 수 없어요', errorMessage('LB_START_CLOSED'));
      void refresh();
      return;
    }
    if (others.length === 0) {
      confirmDialog('아직 아무도 안 들어왔어요', '지금 시작할까요? 친구는 나중에 들어와도 돼요.', startNow, { confirmText: '시작하기' });
      return;
    }
    startNow();
  };

  // ── 게스트: 나가기 (시작 전, 전액 환불. 이름은 명단에 빈 칸으로 남는다) ──
  const askLeave = () => {
    confirmDialog(
      '약속에서 나갈까요?',
      stake > 0
        ? `건 ${stake}P는 바로 돌려드려요. 내 이름은 명단에 남아 초대 링크로 다시 들어올 수 있어요.`
        : '내 이름은 명단에 남아 초대 링크로 다시 들어올 수 있어요.',
      () =>
        void act('leave', '나가지 못했어요', async () => {
          await api.leave(a.id);
          onLeft(); // refresh 대신 — 안 그러면 "주최자가 내보냈어요"가 뜬다
        }),
      { confirmText: '나가기', destructive: true },
    );
  };

  // ── 주최자: 내보내기 (전액 환불 + 명단에서 제거 + 기본 차단) ──
  const askKick = (p: LbLiveParticipant) => {
    confirmDialog(
      `${p.nickname}님을 내보낼까요?`,
      `${stake > 0 ? `건 ${stake}P는 돌려드려요. ` : ''}명단에서도 빠지고, 이 약속에는 다시 들어올 수 없어요.`,
      () =>
        void act(`kick:${p.userId}`, '내보내지 못했어요', async () => {
          await api.kick(a.id, p.userId, true);
          forget(p.userId);
          await refresh();
        }),
      { confirmText: '내보내기', destructive: true },
    );
  };

  // ── 주최자: 명단 편집. 오류는 InviteeEditor 가 칸 아래에 그리므로 alert 없이 문구만 돌려준다 ──
  const addInvitee = async (raw: string): Promise<string | void> => {
    const name = cleanName(raw);
    const n = Array.from(name).length;
    if (n < 1 || n > 12) return errorMessage('LB_BAD_NICKNAME');
    const key = nameKey(name);
    if ([a.hostNickname, ...a.invitees.map((i) => i.name)].some((s) => nameKey(s) === key)) {
      return errorMessage('LB_NICKNAME_TAKEN');
    }
    const failed = await act(
      'invitees:add',
      '이름을 추가하지 못했어요',
      async () => {
        await api.editInvitees(a.id, { add: [name] });
        await refresh();
      },
      true,
    );
    return failed ?? undefined;
  };
  const removeInvitee = (name: string) =>
    void act(`invitees:remove:${name}`, '명단에서 빼지 못했어요', async () => {
      await api.editInvitees(a.id, { remove: [name] });
      await refresh();
    });

  // ── 주최자: 약속 취소 (시작 전까지. 전원 환불) ──
  const refundLine =
    stake === 0
      ? ''
      : others.length > 0
        ? `친구 ${others.length}명이 건 포인트는 모두 돌려드려요.`
        : `건 ${stake}P는 돌려드려요.`;

  const askCancel = () => {
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

  const footer = isHost ? (
    <>
      <Text style={styles.notice}>{START_HINT}</Text>
      <PrimaryButton label="시작하기" onPress={askStart} disabled={disabled} />
    </>
  ) : (
    <>
      <Text style={styles.notice}>{GUEST_WAIT_HINT}</Text>
      <PrimaryButton
        label={stake > 0 ? '나가기 (포인트 돌려받기)' : '나가기'}
        variant="ghost"
        onPress={askLeave}
        disabled={disabled}
      />
    </>
  );

  const hostTags = ['주최자', host && host.userId === live.myUserId ? '나' : ''].filter((s) => s !== '').join(' · ');

  const inviteeRow = (i: LbInvitee) => {
    if (i.claimedByUserId === null) {
      return <RosterRow key={i.name} name={i.name} tags="" status="아직 안 들어옴" dim disabled={disabled} />;
    }
    const p = byUser.get(i.claimedByUserId) ?? null;
    const isMe = i.claimedByUserId === live.myUserId;
    const kickable = isHost && !isMe && p !== null;
    return (
      <RosterRow
        key={i.name}
        name={p?.nickname ?? i.name}
        tags={isMe ? '나' : ''}
        status="참여 완료"
        action={kickable ? '내보내기' : undefined}
        onAction={kickable && p ? () => askKick(p) : undefined}
        disabled={disabled}
      />
    );
  };

  return (
    <View style={styles.fill}>
      <Screen footer={footer}>
        <ChangeBanner changes={unseenChanges} tz={a.tz} onAck={ackChanges} />

        <SectionTitle>약속</SectionTitle>
        <ConditionCard
          appointment={a}
          pinHint={isHost ? '핀 위치가 맞는지 확인해 주세요' : '핀 위치가 이상하면 주최자에게 알려 주세요'}
        />

        <SectionTitle>
          명단 {a.invitees.length + 1}명 · 참여 {claimed.length + 1}명
        </SectionTitle>
        <Card>
          <RosterRow name={host?.nickname ?? a.hostNickname} tags={hostTags} status="참여 완료" disabled={disabled} />
          {a.invitees.map(inviteeRow)}
          {a.invitees.length === 0 ? (
            <Text style={styles.muted}>
              {isHost ? '아직 초대한 친구가 없어요. 아래에서 이름을 추가해 보세요.' : '아직 초대된 친구가 없어요.'}
            </Text>
          ) : missing.length > 0 ? (
            <Text style={styles.muted}>아직 안 들어온 친구: {missing.map((i) => i.name).join(', ')}</Text>
          ) : null}
          {stake > 0 && claimed.length > 0 ? <Text style={styles.muted}>한 사람당 {stake}P씩 걸었어요.</Text> : null}
          <Text style={styles.muted}>
            {isHost
              ? '약속 시각까지 시작하지 않으면 약속이 무효가 되고 건 포인트는 모두 돌려드려요. 약속 시각까지 안 들어온 이름은 명단에서 자동으로 빠져요.'
              : '주최자가 시작하기 전에는 아무도 위치를 볼 수 없어요. 약속 시각까지 시작하지 않으면 약속은 무효가 되고 건 포인트는 돌려드려요.'}
          </Text>
        </Card>

        {isHost ? (
          <>
            <SectionTitle>초대 명단</SectionTitle>
            <Card>
              <Text style={styles.muted}>
                이름을 추가하거나, 아직 안 들어온 이름을 눌러 뺄 수 있어요. 들어온 친구는 위 명단에서 내보내기로 빼요.
              </Text>
              <InviteeEditor
                names={a.invitees.map((i) => i.name)}
                claimedNames={claimed.map((i) => i.name)}
                onAdd={addInvitee}
                onRemove={removeInvitee}
                disabled={disabled}
              />
            </Card>

            <SectionTitle>주최자 도구</SectionTitle>
            {a.inviteCode ? (
              <Card>
                <View style={styles.codeRow}>
                  <Text style={styles.muted}>초대 코드</Text>
                  <Text style={styles.code}>{a.inviteCode}</Text>
                  <Text style={[styles.textButton, styles.trailing]} onPress={() => void copyInvite(a, changed)}>
                    초대 문구 복사
                  </Text>
                </View>
                <Text style={styles.muted}>친구는 링크를 열고 명단에서 자기 이름을 골라 참여해요. 시작한 뒤에도 약속 시각까지는 들어올 수 있어요.</Text>
                <PrimaryButton label="친구 초대하기" variant="ghost" onPress={() => void shareInvite(a, changed)} />
              </Card>
            ) : null}

            <Card>
              <Text style={styles.muted}>
                시작 전에는 시간·장소·걸 포인트·지각 규칙을 바꿀 수 있어요. 들어온 친구에게는 바뀐 내용이 보여요. 걸 포인트를
                올리면 차액이 자동으로 더 걸리고, 내리면 돌려드려요.
              </Text>
              <PrimaryButton
                label="약속 수정"
                variant="ghost"
                onPress={() => router.push(`/late/new?edit=${a.id}`)}
                disabled={disabled}
              />

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
                {others.length > 0
                  ? '시작하기 전까지만 취소할 수 있어요. 취소하면 친구들이 건 포인트는 모두 돌려드려요.'
                  : '취소하면 이 약속은 사라져요.'}
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
  muted: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  dim: { opacity: 0.4 },
  dimRow: { opacity: 0.55 },
  textButton: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text, textDecorationLine: 'underline', paddingVertical: spacing.xs },

  banner: { borderWidth: 1, borderColor: colors.text },
  bannerText: { fontSize: fontSize.md, fontWeight: '700', color: colors.text, lineHeight: 22 },

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
  trailing: { marginLeft: 'auto' },

  codeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  code: { fontSize: fontSize.md, fontWeight: '800', color: colors.text, letterSpacing: 2 },

  notice: { fontSize: fontSize.sm, color: colors.subtext, textAlign: 'center', lineHeight: 20 },

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
