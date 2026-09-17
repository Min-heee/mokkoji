/**
 * 초대 참여 (설계서 §3.2, §5.3-D·E). 딥링크 nbbang://j/CODE. 담당: [join]
 *
 * 흐름: 코드 형식 검사(invite.normalizeCode — 통과한 값만 RPC 에 넣는다) → 조용히 익명 로그인(ensureReady)
 *   → lb_peek_invite 미리보기 카드 → 닉네임 + 동의 2개 → lb_join(미리보기에서 본 version 으로만)
 *   → 위치 권한 사전 안내(LocationPrimer) → 알림 예약 → /late/[id] 로 replace.
 * - 잠금(위치 공개 시작) 뒤면 버튼이 [참여 요청 보내기]다. 요청이든 참여든 성공하면 약속 화면으로 간다(수락 대기는 PendingView 가 받는다).
 * - 이미 멤버면(활성·수락 대기) 미리보기 없이 바로 약속 화면으로 보낸다.
 * - 실패 상태는 §5.3-D 표 그대로다. 문구는 errors.ts 의 것을 쓰고, 표에만 있는 두 줄(취소됨·오프라인 꼬리)만 이 파일에 둔다.
 * - 낙관적 업데이트 없음: '참여했어요'는 서버 응답 뒤에만 그린다.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { normalizeCode, sanitizeCodeInput } from '@/domain/invite';
import { describePolicy, formatMinutes, START_BALANCE } from '@/domain/latePresets';
import { mapPinUrl } from '@/domain/mapRoute';
import { formatFromNow, formatKoreanDateTime, tzLabel } from '@/domain/tzGuard';
import {
  errorMessage,
  isConnectivityError,
  LateBetError,
  REPEATED_FAILURE_MESSAGE,
  toLateBetError,
} from '@/lateBet/errors';
import { useLateBet } from '@/lateBet/LateBetContext';
import { ensureNotificationPermission, scheduleLateNotifications } from '@/lateBet/notifications';
import { FakeDevPanel } from '@/lateBet/screens/FakeDevPanel';
import { LocationPrimer } from '@/lateBet/screens/LocationPrimer';
import { LateBetUnavailable } from '@/lateBet/screens/NicknameGate';
import { withClockSample } from '@/lateBet/serverClock';
import type { LbInvitePreview, LbJoinResult } from '@/lateBet/types';
import { useArrivalReporter } from '@/lateBet/useArrivalReporter';
import { useServerNow } from '@/lateBet/useServerNow';
import { Card, EmptyState, LoadingState, PrimaryButton, Screen, SectionTitle, TextField } from '@/ui/components';
import { alertDialog } from '@/ui/dialogs';
import { MapPane } from '@/ui/MapPane';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

// §5.3-D 표에만 있는 문구(errors.ts 에 코드가 없는 상태)
const CANCELED_MESSAGE = '주최자가 취소한 약속이에요.';
const OFFLINE_TAIL = ' 초대 코드는 그대로 있어요.';

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

/** 사용자가 폼에서 바로 고칠 수 있는 오류(연속 실패로 세지 않는다) */
const FIXABLE = new Set<string>(['LB_NICKNAME_TAKEN', 'LB_BAD_NICKNAME', 'LB_CONSENT_REQUIRED']);

interface Joined extends LbJoinResult {
  /** 참여하면서 서버가 채워 준 포인트(없으면 null) */
  topUp: number | null;
}

const charLen = (s: string) => Array.from(s).length;

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

  const { api, fake, profile, balance, ensureReady, ensureProfile, applyBalance, refresh: refreshHome, needsUpdate, installUrl } =
    useLateBet();
  // 위치 권한 상태·요청만 빌려 쓴다(약속이 없으므로 보고 루프는 돌지 않는다)
  const reporter = useArrivalReporter(null);
  // "2시간 10분 뒤", 잠금·마감 경계 — 30초마다 다시 본다
  const now = useServerNow(30_000);

  const [preview, setPreview] = useState<LbInvitePreview | null>(null);
  const [loading, setLoading] = useState(code !== null);
  const [block, setBlock] = useState<Block | null>(null);
  const [failCount, setFailCount] = useState(0);

  const [nickname, setNickname] = useState('');
  const [agreeLocation, setAgreeLocation] = useState(false);
  const [agreeAge, setAgreeAge] = useState(false);
  const [formError, setFormError] = useState<LateBetError | null>(null);
  /** LB_APPT_CHANGED 를 받았다 → 옛 조건으로는 더 못 누른다. [미리보기 새로고침]만 남긴다 */
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState<Joined | null>(null);
  const [finishing, setFinishing] = useState(false);

  const nickTouched = useRef(false);
  const ready = useRef(false);
  const seq = useRef(0);
  const previewRef = useRef<LbInvitePreview | null>(null);
  const joinedRef = useRef(false);
  const finishingRef = useRef(false);
  const allowingRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    async (quiet = false) => {
      if (!code || joinedRef.current) return;
      const mySeq = ++seq.current;
      if (!quiet) {
        setLoading(true);
        setBlock(null);
      }
      try {
        if (!ready.current) {
          await ensureReady();
          ready.current = true;
        }
        const next = await withClockSample(() => api.peekInvite(code));
        if (!alive.current || mySeq !== seq.current) return;
        // 조건이 바뀌었으면 동의를 다시 받는다 — 본 적 없는 조건으로는 포인트가 걸리지 않는다(§1 원칙 6)
        if (previewRef.current && previewRef.current.version !== next.version) {
          setAgreeLocation(false);
          setAgreeAge(false);
        }
        previewRef.current = next;
        applyBalance(next.myBalance);
        setPreview(next);
        setBlock(null);
        setFailCount(0);
      } catch (e) {
        if (!alive.current || mySeq !== seq.current) return;
        const err = toLateBetError(e);
        // 조용한 새로고침이 연결 문제로 실패하면 보던 미리보기를 그대로 둔다
        if (quiet && previewRef.current && isConnectivityError(err)) return;
        setFailCount((n) => n + 1);
        setBlock(blockForError(err));
      } finally {
        if (alive.current && mySeq === seq.current) setLoading(false);
      }
    },
    [api, applyBalance, code, ensureReady],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // 프로필이 있으면 그 이름을 채워 둔다(약속마다 바꿀 수 있다)
  useEffect(() => {
    if (profile && !nickTouched.current) setNickname(profile.nickname);
  }, [profile]);

  // 이미 참여 중(활성·수락 대기) → 약속 화면으로
  const alreadyMemberId = preview && preview.myState !== null ? preview.id : null;
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

  /** 참여 뒤 마무리: 알림 권한·예약(§3.2-6) → 약속 화면 */
  const finish = useCallback(
    async (j: Joined) => {
      if (finishingRef.current) return;
      finishingRef.current = true;
      setFinishing(true);
      const p = previewRef.current;
      try {
        await ensureNotificationPermission();
        if (p) {
          await scheduleLateNotifications({
            id: j.appointmentId,
            version: p.version,
            title: p.title,
            tz: p.tz,
            meetAtMs: p.meetAtMs,
            shareStartMs: p.shareStartMs,
            closeMs: p.closeMs,
          });
        }
      } catch {
        // 알림은 부가 기능이다. 실패해도 참여는 끝났다
      }
      router.replace('/late/' + j.appointmentId);
    },
    [router],
  );

  const submit = async () => {
    if (busy || !preview || !code || changed) return;
    const nick = nickname.trim();
    const n = charLen(nick);
    if (n < 1 || n > 12) {
      setFormError(new LateBetError('LB_BAD_NICKNAME'));
      return;
    }
    if (!agreeLocation || !agreeAge) {
      setFormError(new LateBetError('LB_CONSENT_REQUIRED'));
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      // 첫 진입이면 프로필부터(+1,000P). 이미 있으면 전역 이름은 건드리지 않는다 — 이 이름은 이 약속에서만 쓴다
      if (!profile) await ensureProfile(nick);
      let res: LbJoinResult;
      try {
        // version 은 반드시 화면에 그려진 미리보기의 것
        res = await api.join(code, nick, preview.version, true);
      } catch (e) {
        if (toLateBetError(e).code !== 'LB_NO_PROFILE') throw e;
        await ensureProfile(nick);
        res = await api.join(code, nick, preview.version, true);
      }

      joinedRef.current = true;
      void refreshHome();

      // "포인트가 모자라 20P를 채워 드렸어요" — 원장에서 이 약속 때문에 채워진 줄을 찾는다(best-effort)
      let topUp: number | null = null;
      if (res.state === 'active' && preview.policy.stake > 0) {
        try {
          const ledger = await api.listLedger(10);
          const relief = ledger.find((l) => l.kind === 'relief' && l.reliefFor === res.appointmentId);
          if (relief && relief.amount > 0) topUp = relief.amount;
        } catch {
          // 안내만 빠진다
        }
      }
      if (!alive.current) return;

      const j: Joined = { ...res, topUp };
      // P0: 실제 권한 요청은 없고 흐름만 — 가짜 모드에서는 항상 안내를 보여 준다
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
      if (alive.current) setBusy(false);
    }
  };

  /** [미리보기 새로고침] — 새 조건을 다시 읽고 동의를 다시 받는다 */
  const refreshPreview = () => {
    setChanged(false);
    setFormError(null);
    setAgreeLocation(false);
    setAgreeAge(false);
    void load();
  };

  const openUrl = (url: string, failTitle: string) => {
    if (!url) return;
    if (Platform.OS === 'web') {
      // 웹에서 Linking.openURL 은 같은 탭을 갈아치운다 → 새 탭으로
      const opened = window.open(url, '_blank', 'noopener');
      if (!opened) alertDialog(failTitle);
      return;
    }
    Linking.openURL(url).catch(() => alertDialog(failTitle));
  };

  const onAllow = async () => {
    if (!joined || finishingRef.current || allowingRef.current) return;
    allowingRef.current = true;
    setFinishing(true);
    try {
      const needsSettings = reporter.permission === 'denied' || reporter.permission === 'coarse';
      if (needsSettings && Platform.OS !== 'web') await Linking.openSettings();
      else await reporter.requestPermission();
    } catch {
      // 거부해도 참여는 된다
    }
    await finish(joined);
  };

  const wrap = (body: React.ReactNode) => (
    <View style={styles.fill}>
      <FakeDevPanel onChanged={() => void load(true)} />
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
    const active = joined.state === 'active';
    return wrap(
      <Screen>
        <Card>
          <Text style={styles.doneTitle}>{active ? '참여했어요' : '참여 요청을 보냈어요'}</Text>
          <Text style={styles.meta}>
            {active
              ? stake > 0
                ? `${stake}P를 걸었어요. 제시간에 도착하면 그대로 돌려받아요.`
                : '포인트 없이 위치만 공유하는 약속이에요.'
              : `주최자가 수락하면 참여돼요.${stake > 0 ? ` 수락되는 순간 ${stake}P가 걸려요.` : ''} 주최자에게 카톡으로 알려 주세요.`}
          </Text>
          {joined.topUp !== null ? (
            <Text style={styles.meta}>포인트가 모자라 {joined.topUp.toLocaleString('ko-KR')}P를 채워 드렸어요</Text>
          ) : null}
        </Card>
        <LocationPrimer
          shareMinutesBefore={preview?.policy.shareLocationMinutesBefore ?? 60}
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

  // ── 미리보기는 받았지만 참여할 수 없는 약속 ──
  if (preview.status === 'canceled') return blocked({ message: CANCELED_MESSAGE, action: 'home' });
  if (preview.status !== 'open' || preview.joinClosed || now >= preview.meetAtMs) {
    return blocked({ message: errorMessage('LB_JOIN_CLOSED'), action: 'home' });
  }

  // ── 조건 카드 + 닉네임 + 동의 ──
  const { policy } = preview;
  const stake = policy.stake;
  const locked = preview.needsApproval || now >= preview.shareStartMs;
  const desc = describePolicy(policy, preview.meetAtMs, preview.tz);
  // 잠금 뒤에는 "○시부터 위치가 보여요" 대신 수락제 안내를 그린다
  const policyLines = desc.lines.filter((line) => !(locked && line === desc.share));
  const untilMeet = preview.meetAtMs - now;
  const fromNow = formatFromNow(untilMeet);
  const myBalance = preview.myBalance ?? balance;
  const shareBefore = formatMinutes(policy.shareLocationMinutesBefore);
  const bothAgreed = agreeLocation && agreeAge;
  const offlineError = formError !== null && isConnectivityError(formError);

  const joinLabel = offlineError ? '다시 시도' : locked ? '참여 요청 보내기' : stake > 0 ? `${stake}P 걸고 참여` : '참여하기';

  return wrap(
    <Screen
      footer={
        changed ? (
          <PrimaryButton label="미리보기 새로고침" onPress={refreshPreview} />
        ) : (
          <PrimaryButton
            label={joinLabel}
            onPress={() => void submit()}
            disabled={busy || nickname.trim() === '' || !bothAgreed}
          />
        )
      }
    >
      {needsUpdate ? (
        <Card>
          <Text style={styles.line}>새 버전을 설치해 주세요</Text>
          {installUrl ? (
            <PrimaryButton label="설치" variant="ghost" onPress={() => openUrl(installUrl, '설치 페이지를 열 수 없어요')} />
          ) : null}
        </Card>
      ) : null}

      <Card>
        <Text style={styles.title}>{preview.title}</Text>
        <Text style={styles.when}>
          {formatKoreanDateTime(preview.meetAtMs, preview.tz)} · {tzLabel(preview.tz)}
        </Text>
        <Text style={styles.meta}>{untilMeet >= 60_000 ? `지금부터 ${fromNow}` : fromNow}</Text>
        <Text style={styles.place}>{preview.placeName}</Text>
        {preview.placeNote.trim() !== '' ? <Text style={styles.meta}>{preview.placeNote}</Text> : null}
      </Card>

      <MapPane
        readonly
        destination={{ name: preview.placeName, lat: preview.placeLat, lng: preview.placeLng }}
        radiusM={policy.radiusM}
      />
      <Text style={styles.meta}>핀 위치가 맞는지 확인해 주세요</Text>
      <PrimaryButton
        label="카카오맵에서 보기"
        variant="ghost"
        onPress={() => openUrl(mapPinUrl(preview.placeName, preview.placeLat, preview.placeLng), '지도를 열 수 없어요')}
      />

      <SectionTitle>내기 조건</SectionTitle>
      <Card>
        {policyLines.map((line) => (
          <Text key={line} style={line === desc.example ? styles.loss : styles.line}>
            {line}
          </Text>
        ))}
      </Card>
      {locked ? (
        <Card>
          <Text style={styles.line}>
            위치 공개가 이미 시작된 약속이에요. 참여 요청을 보내면 주최자가 수락해야 참여돼요.
            {stake > 0 ? ` 수락되는 순간 ${stake}P가 걸리고,` : ''} 수락된 뒤에는 빠질 수 없어요.
          </Text>
        </Card>
      ) : null}

      <SectionTitle>참여</SectionTitle>
      <Text style={styles.meta}>지금 {preview.memberCount}명이 참여 중이에요. 이름은 참여한 뒤에 보여요.</Text>
      <Text style={styles.meta}>
        {myBalance !== null
          ? `보유 포인트 ${myBalance.toLocaleString('ko-KR')}P`
          : `처음이면 ${START_BALANCE.toLocaleString('ko-KR')}P를 드려요. 포인트는 가상이고 돈으로 바꿀 수 없어요.`}
        {myBalance !== null && stake > myBalance ? ' · 모자란 만큼은 참여할 때 채워 드려요.' : ''}
      </Text>

      <TextField
        label="이 약속에서 쓸 이름 (1~12자)"
        value={nickname}
        onChangeText={(t) => {
          nickTouched.current = true;
          setNickname(t);
          if (formError && FIXABLE.has(formError.code)) setFormError(null);
        }}
        placeholder="예: 민병희"
      />

      <CheckRow
        checked={agreeLocation}
        disabled={busy || changed}
        onToggle={() => setAgreeLocation((v) => !v)}
        label={`약속 ${shareBefore} 전부터 도착할 때까지, 앱을 켜 둔 동안 내 위치를 같은 약속의 친구들에게 보여 주는 데 동의해요`}
      />
      <CheckRow checked={agreeAge} disabled={busy || changed} onToggle={() => setAgreeAge((v) => !v)} label="만 14세 이상이에요" />
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
  when: { fontSize: fontSize.md, fontWeight: '600', color: colors.text },
  place: { fontSize: fontSize.md, fontWeight: '600', color: colors.text, marginTop: spacing.xs },
  meta: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  line: { fontSize: fontSize.sm, color: colors.text, lineHeight: 20 },
  // 잃는 포인트에만 브릭
  loss: { fontSize: fontSize.sm, fontWeight: '700', color: colors.danger, lineHeight: 20 },
  doneTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  error: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text, lineHeight: 20 },
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
