/**
 * 라이브·지각 구간: 지도 + 손실 티커 + 참가자 행 + [도착 확인] + 길찾기 + 위치 공유 토글
 * 설계서 §5.3-F(live·overtime), §5.4 실패 상태 동작표. 담당: [live]
 *
 * - 1초 티커는 LossTicker·ParticipantRows 안에만 있다. LiveView 본체는 폴링(5초)·판정 결과가 바뀔 때만 다시 그린다.
 * - 위치 보고 루프는 컨테이너(app/late/[id])가 돌린다. 여기서는 reporter 의 상태를 그리고 [도착 확인]만 부른다.
 * - ArrivedView 가 같이 쓰는 조각(ParticipantRows · JoinRequests · SmallButton · liveMarkers)도 이 파일에서 내보낸다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { fullForfeitAtMs, lateUnits, normalizeLatePolicy, projectedPenalty } from '@/domain/lateBet';
import { onTimeUntilMs } from '@/domain/latePhase';
import { describePolicy, formatLoss } from '@/domain/latePresets';
import { mapRouteUrl } from '@/domain/mapRoute';
import { formatKoreanTime } from '@/domain/tzGuard';
import { Card, PrimaryButton, Screen, SectionTitle } from '@/ui/components';
import { alertDialog, confirmDialog } from '@/ui/dialogs';
import { formatDistance, MapPane, type MapPaneMarker } from '@/ui/MapPane';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

import type { LateBetApi } from '../api';
import { APPROVE_INSUFFICIENT_MESSAGE, isConnectivityError, reportReasonMessage, toLateBetError } from '../errors';
import { serverNow } from '../serverClock';
import type { LbAppointment, LbLive, LbLiveParticipant } from '../types';
import { useServerNow } from '../useServerNow';
import type { LiveViewProps } from './props';

const MINUTE_MS = 60_000;
/** 연결이 끊긴 체크인: 3초 간격 재시도(§3.4) */
const OFFLINE_RETRY_MS = 3_000;
/** GPS 부정확: 5초마다 자동 재시도(§5.4) */
const ACCURACY_RETRY_MS = 5_000;
/** 이보다 나쁜 정확도는 '대략적인 위치'로 본다(서버도 저장하지 않는다) */
const COARSE_ACCURACY_M = 1000;

// ───────────────────────── 표시 헬퍼 ─────────────────────────

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/** 남은 시간 'mm:ss' (1시간 이상이면 'h:mm:ss'). 음수는 00:00 */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

/** '1분 20초' · '45초' */
function formatSpan(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}초`;
  return s === 0 ? `${m}분` : `${m}분 ${s}초`;
}

/** '40초 전' · '4분 전' */
function formatAgo(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}초 전`;
  return `${Math.floor(total / 60)}분 전`;
}

function accuracyLabel(accuracyM: number | null): string {
  if (accuracyM === null || !(accuracyM >= 0)) return '';
  if (accuracyM <= 30) return '위치 정확도 좋음';
  if (accuracyM <= 100) return '위치 정확도 보통';
  return '위치 정확도 낮음';
}

/** 좌표 길찾기. 웹은 새 탭(같은 탭을 갈아치우면 앱이 지도로 대체된다 — app/session/[id] 의 openMap 과 같은 방식) */
function openRoute(appointment: LbAppointment): void {
  const url = mapRouteUrl(appointment.placeName, appointment.placeLat, appointment.placeLng);
  if (Platform.OS === 'web') {
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) alertDialog('지도를 열 수 없어요');
    return;
  }
  Linking.openURL(url).catch(() => alertDialog('지도를 열 수 없어요'));
}

function openSettings(): void {
  Linking.openSettings().catch(() => alertDialog('설정을 열 수 없어요'));
}

/** 지도에 찍을 수 있는 마커 = 좌표가 보이는 미도착 참가자. 기준 데이터는 참가자 행(ParticipantRows)이다 */
export function liveMarkers(live: LbLive): MapPaneMarker[] {
  return live.participants
    .filter((p) => p.state === 'active' && p.arrivedAtMs === null && p.location !== null)
    .map((p) => ({
      id: p.userId,
      label: p.nickname,
      lat: p.location ? p.location.lat : null,
      lng: p.location ? p.location.lng : null,
      distanceM: p.location ? p.location.distanceM : null,
      isMe: p.userId === live.myUserId,
    }));
}

// ───────────────────────── 손실 티커 (1초) ─────────────────────────

/**
 * live    : 지금 도착하면 전액 돌려받아요 · 마감까지 12:34
 * overtime: 지금 도착하면 −20P(브릭) · 1분 20초 뒤 −30P · 오후 8:15 넘으면 전액
 * 단계는 props 의 phase 가 아니라 이 컴포넌트의 시각으로 다시 본다(경계에서 1초 어긋나지 않게).
 */
function LossTicker({ appointment }: { appointment: LbAppointment }) {
  const now = useServerNow(1000);
  const { meetAtMs, closeMs, tz } = appointment;
  const policy = useMemo(() => normalizeLatePolicy(appointment.policy), [appointment.policy]);
  const closeLine = useMemo(() => describePolicy(policy, meetAtMs, tz).close, [policy, meetAtMs, tz]);
  const onTimeUntil = onTimeUntilMs({ meetAtMs, policy });

  if (now <= onTimeUntil) {
    return (
      <View style={styles.ticker}>
        <Text style={styles.tickerMain}>
          {policy.stake > 0 ? '지금 도착하면 전액 돌려받아요' : '포인트 없이 위치만 공유하는 약속이에요'}
        </Text>
        <Text style={styles.tickerSub}>마감까지 {formatClock(onTimeUntil - now)}</Text>
      </View>
    );
  }

  const untilClose = `체크인 마감까지 ${formatClock(closeMs - now)}`;

  // 잃을 포인트가 없는 약속(내기 없음 · 늦어도 차감 없음)
  if (policy.stake === 0 || policy.penaltyPerUnit === 0) {
    return (
      <View style={styles.ticker}>
        <Text style={styles.tickerMain}>
          {policy.stake === 0 ? '약속 시각이 지났어요' : '늦어도 포인트를 잃지 않아요'}
        </Text>
        <Text style={styles.tickerSub}>{[closeLine, untilClose].filter((s) => s !== '').join(' ')}</Text>
      </View>
    );
  }

  const loss = projectedPenalty(policy, meetAtMs, now);
  // 지금 k 단위째 → (k+1) 단위째는 onTimeUntil + k×단위 를 '넘는' 순간 시작된다
  const units = lateUnits(policy, meetAtMs, now);
  const nextAt = onTimeUntil + units * policy.unitMinutes * MINUTE_MS;
  const nextLoss = projectedPenalty(policy, meetAtMs, nextAt + 1);
  const fullAt = fullForfeitAtMs(policy, meetAtMs) ?? closeMs;
  const fullTime = formatKoreanTime(Math.min(fullAt, closeMs), tz);

  return (
    <View style={styles.ticker}>
      <Text style={styles.tickerMain}>
        지금 도착하면 <Text style={styles.loss}>{formatLoss(loss)}</Text>
      </Text>
      <Text style={styles.tickerSub}>
        {[
          nextLoss > loss && nextAt < closeMs ? `${formatSpan(nextAt - now)} 뒤 ${formatLoss(nextLoss)}` : '',
          fullTime ? `${fullTime} 넘으면 전액` : '',
        ]
          .filter((s) => s !== '')
          .join(' · ')}
      </Text>
    </View>
  );
}

// ───────────────────────── 참가자 행 (1초) ─────────────────────────

/** 미도착 참가자의 한 줄: '1.2km · 40초 전' / '4분 전까지 공유 · 앱을 닫았어요' / '위치 없음' */
function whereabouts(p: LbLiveParticipant, now: number, isMe: boolean, sharing: boolean | undefined): string {
  if (p.location) {
    return `${formatDistance(p.location.distanceM)} · ${formatAgo(now - p.location.updatedAtMs)}`;
  }
  if (isMe && sharing === false) return '위치 공유 끔';
  if (p.lastSeenMs !== null) return `${formatAgo(now - p.lastSeenMs)}까지 공유 · 앱을 닫았어요`;
  return '위치 없음';
}

export interface ParticipantRowsProps {
  live: LbLive;
  /** 내 공유 토글(LiveView 만 안다). 꺼져 있으면 내 행은 '위치 공유 끔' */
  sharing?: boolean;
  /** 미도착 친구 행 오른쪽에 붙일 것 — ArrivedView 의 [같이 있어요] */
  renderAction?: (p: LbLiveParticipant) => React.ReactNode;
}

/** 활성 참가자 목록(서버 순서 그대로). "N초 전"을 위해 이 컴포넌트만 1초마다 다시 그린다 */
export function ParticipantRows({ live, sharing, renderAction }: ParticipantRowsProps) {
  const now = useServerNow(1000);
  const tz = live.appointment.tz;
  const rows = live.participants.filter((p) => p.state === 'active');
  return (
    <Card>
      {rows.map((p) => {
        const isMe = p.userId === live.myUserId;
        const arrived = p.arrivedAtMs !== null;
        const line =
          p.arrivedAtMs !== null
            ? `도착 · ${formatKoreanTime(p.arrivedAtMs, tz)}${p.arrivalMethod === 'vouch' ? ' · 친구 확인' : ''}`
            : whereabouts(p, now, isMe, sharing);
        const action = !arrived && !isMe && renderAction ? renderAction(p) : null;
        return (
          <View key={p.userId} style={styles.personRow}>
            <View style={[styles.initial, arrived && styles.initialArrived]}>
              <Text style={[styles.initialText, arrived && styles.initialTextArrived]}>
                {Array.from(p.nickname)[0] ?? ''}
              </Text>
            </View>
            <View style={styles.personBody}>
              <Text style={styles.personName} numberOfLines={1}>
                {p.nickname}
                {isMe ? ' (나)' : ''}
                {p.userId === live.appointment.hostId ? ' · 주최자' : ''}
              </Text>
              <Text style={styles.personLine} numberOfLines={2}>
                {line}
              </Text>
            </View>
            {action}
          </View>
        );
      })}
    </Card>
  );
}

// ───────────────────────── 참여 요청 (주최자) ─────────────────────────

/** 행 안의 작은 버튼(수락·거절·같이 있어요). 풀폭 버튼 두 단계와 같은 솔리드/틴트 */
export function SmallButton({
  label,
  onPress,
  disabled,
  solid,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  solid?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.smallButton,
        solid && styles.smallButtonSolid,
        disabled && { opacity: 0.4 },
        pressed && !disabled && { opacity: 0.7 },
      ]}
    >
      <Text style={[styles.smallButtonLabel, solid && styles.smallButtonLabelSolid]}>{label}</Text>
    </Pressable>
  );
}

/**
 * 잠금 뒤에 들어온 참여 요청. 잠금 뒤의 요청은 라이브·도착 화면에 있는 주최자에게 오므로 여기서도 받는다.
 * 수락은 약속 시각까지만 된다(서버 규칙). 거절은 언제든 된다.
 */
export function JoinRequests({
  live,
  isHost,
  api,
  refresh,
}: {
  live: LbLive;
  isHost: boolean;
  api: LateBetApi;
  refresh: () => Promise<LbLive | null>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const requests = isHost ? live.participants.filter((p) => p.state === 'pending') : [];
  if (requests.length === 0) return null;

  const appointmentId = live.appointment.id;
  const stake = live.appointment.policy.stake;

  const run = async (userId: string, failTitle: string, work: () => Promise<void>) => {
    if (busyId !== null) return;
    setBusyId(userId);
    try {
      await work();
    } catch (e) {
      const err = toLateBetError(e);
      const message =
        err.code === 'LB_INSUFFICIENT_POINTS'
          ? APPROVE_INSUFFICIENT_MESSAGE
          : err.code === 'LB_JOIN_CLOSED'
            ? '약속 시각이 지나 수락할 수 없어요.'
            : err.message;
      alertDialog(failTitle, message);
    } finally {
      await refresh();
      if (alive.current) setBusyId(null);
    }
  };

  const approve = (p: LbLiveParticipant) => {
    if (serverNow() >= live.appointment.meetAtMs) {
      alertDialog('수락하지 못했어요', '약속 시각이 지나 수락할 수 없어요.');
      return;
    }
    void run(p.userId, '수락하지 못했어요', () => api.approve(appointmentId, p.userId));
  };

  const reject = (p: LbLiveParticipant) => {
    confirmDialog(
      `${p.nickname}님의 요청을 거절할까요?`,
      '포인트는 걸린 적이 없어 돌려줄 것이 없어요.',
      () => void run(p.userId, '거절하지 못했어요', () => api.kick(appointmentId, p.userId, false)),
      { confirmText: '거절', destructive: true },
    );
  };

  return (
    <>
      <SectionTitle>참여 요청</SectionTitle>
      <Card>
        {requests.map((p) => (
          <View key={p.userId} style={styles.personRow}>
            <View style={styles.personBody}>
              <Text style={styles.personName} numberOfLines={1}>
                {p.nickname}님이 참여를 요청했어요
              </Text>
              <Text style={styles.personLine}>
                {stake > 0 ? `수락하는 순간 이 친구의 ${stake}P가 걸려요.` : '수락하면 서로 위치가 보여요.'}
              </Text>
            </View>
            <SmallButton label="수락" solid disabled={busyId !== null} onPress={() => approve(p)} />
            <SmallButton label="거절" disabled={busyId !== null} onPress={() => reject(p)} />
          </View>
        ))}
      </Card>
    </>
  );
}

// ───────────────────────── 본체 ─────────────────────────

interface Notice {
  lines: string[];
  /** [설정 열기] · [위치 허용하기] */
  action?: { label: string; onPress: () => void };
}

const VOUCH_HINT = "먼저 도착한 친구에게 '같이 있어요'를 눌러달라고 하세요.";

export function LiveView({ live, phase, isHost, api, refresh, reporter }: LiveViewProps) {
  const appointment = live.appointment;
  const { permission, sharing, running, myDistanceM, myAccuracyM, lastResult } = reporter;
  const reportError = reporter.error;

  /** 내가 누른 [도착 확인]이 진행 중(자동 재시도는 버튼을 흔들지 않는다) */
  const [checking, setChecking] = useState(false);
  /** [도착 확인]을 한 번이라도 눌렀다 → '아직 140m 남았어요' 같은 판정 문구를 보여 준다 */
  const [pressed, setPressed] = useState(false);
  /** 위치를 모르는 채로 눌렀다 */
  const [noPosition, setNoPosition] = useState(false);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // 최신 reporter 를 타이머·핸들러에서 읽기 위한 ref (reporter 객체는 상태가 바뀔 때마다 새로 만들어진다)
  const reporterRef = useRef(reporter);
  reporterRef.current = reporter;

  useEffect(() => {
    if (myDistanceM !== null) setNoPosition(false);
  }, [myDistanceM]);

  // 체크인이 닫혔다는 판정을 받으면 바로 다시 읽어 결과 화면으로 넘어가게 한다
  const lastReason = lastResult?.reason ?? null;
  useEffect(() => {
    if (lastReason === 'closed' || lastReason === 'already_arrived') void refresh();
  }, [lastReason, refresh]);

  // 자동 재시도: 연결 끊김 3초 · GPS 부정확 5초(보고 루프가 돌고 있으면 루프가 5초마다 다시 보낸다)
  const offline = reportError !== null && isConnectivityError(reportError);
  const retryMs = offline ? OFFLINE_RETRY_MS : lastReason === 'low_accuracy' && !running ? ACCURACY_RETRY_MS : null;
  useEffect(() => {
    if (retryMs === null) return undefined;
    const timer = setInterval(() => void reporterRef.current.checkInNow(), retryMs);
    return () => clearInterval(timer);
  }, [retryMs]);

  const onCheckIn = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    setPressed(true);
    const hadPosition = reporterRef.current.myDistanceM !== null;
    const res = await reporterRef.current.checkInNow();
    if (!alive.current) return;
    setChecking(false);
    setNoPosition(res === null && !hadPosition);
    // 도착이 찍히면 컨테이너(onArrived)가 refresh + 도착 연출을 맡는다
  }, [checking]);

  const onToggleSharing = useCallback(() => {
    const next = !reporterRef.current.sharing;
    reporterRef.current.setSharing(next);
    if (!next) {
      // 루프가 멈추며 훅도 부르지만, 루프가 안 돌던 때에 남은 좌표까지 확실히 지운다(best-effort)
      void api
        .stopSharing(appointment.id)
        .catch(() => undefined)
        .then(() => refresh());
    }
  }, [api, appointment.id, refresh]);

  // ── 실패 상태(§5.4) — 위에서부터 먼저 걸리는 것 하나만 보여 준다
  const notice: Notice | null = (() => {
    const settings = Platform.OS === 'web' ? undefined : { label: '설정 열기', onPress: openSettings };
    if (permission === 'denied' || permission === 'unsupported') {
      return {
        lines: ['위치가 꺼져 있어 도착을 자동으로 확인할 수 없어요', VOUCH_HINT],
        action: permission === 'denied' ? settings : undefined,
      };
    }
    if (permission === 'undetermined') {
      return {
        lines: ['위치를 허용해야 도착을 자동으로 확인할 수 있어요', VOUCH_HINT],
        action: { label: '위치 허용하기', onPress: () => void reporterRef.current.requestPermission() },
      };
    }
    if (permission === 'coarse' || (myAccuracyM !== null && myAccuracyM > COARSE_ACCURACY_M)) {
      return { lines: ["대략적인 위치만 허용돼 있어요. 설정에서 '정확한 위치'를 켜주세요."], action: settings };
    }
    if (offline) {
      return {
        lines: [
          phase === 'overtime'
            ? '지상에서 한 번만 앱을 열어주세요. 서버에 닿는 순간이 도착 시각이에요.'
            : '서버에 닿는 순간이 도착 시각이에요.',
          '연결되면 바로 다시 확인할게요.',
        ],
      };
    }
    if (reportError) return { lines: [reportError.message] };
    if (noPosition) return { lines: ['위치를 읽지 못했어요. 다시 눌러주세요.'] };
    if (lastResult && lastReason !== null && (lastReason !== 'outside' || pressed)) {
      const message = reportReasonMessage(lastReason, {
        distanceM: lastResult.distanceM,
        accuracyM: myAccuracyM,
        radiusM: appointment.policy.radiusM,
        shareStartMs: appointment.shareStartMs,
        closeMs: appointment.closeMs,
        tz: appointment.tz,
      });
      if (message === null) return null;
      if (lastReason === 'low_accuracy') return { lines: [message, '5초마다 자동으로 다시 확인하고 있어요.', VOUCH_HINT] };
      return { lines: [message] };
    }
    return null;
  })();

  const locationOff = permission === 'denied' || permission === 'unsupported' || permission === 'undetermined';
  const markers = useMemo(() => liveMarkers(live), [live]);
  const myRow = live.participants.find((p) => p.userId === live.myUserId) ?? null;
  const myPoint = myRow?.location
    ? { lat: myRow.location.lat, lng: myRow.location.lng, accuracyM: myRow.location.accuracyM }
    : null;

  const statusLine = [
    myDistanceM !== null
      ? `목적지까지 ${formatDistance(myDistanceM)}`
      : locationOff
        ? '내 위치를 알 수 없어요'
        : '내 위치를 찾는 중이에요',
    myDistanceM !== null ? accuracyLabel(myAccuracyM) : '',
  ]
    .filter((s) => s !== '')
    .join(' · ');

  return (
    <Screen
      footer={
        <>
          <PrimaryButton
            label={checking ? '확인하는 중이에요' : '도착 확인'}
            disabled={checking}
            onPress={() => void onCheckIn()}
          />
          <PrimaryButton label="길찾기" variant="ghost" onPress={() => openRoute(appointment)} />
        </>
      }
    >
      <MapPane
        destination={{ name: appointment.placeName, lat: appointment.placeLat, lng: appointment.placeLng }}
        radiusM={appointment.policy.radiusM}
        markers={markers}
        me={myPoint}
      />

      <LossTicker appointment={appointment} />

      <View style={styles.statusRow}>
        <Text style={styles.statusText}>{statusLine}</Text>
        <Pressable
          onPress={onToggleSharing}
          accessibilityRole="switch"
          accessibilityState={{ checked: sharing }}
          style={({ pressed: down }) => [styles.toggle, sharing && styles.toggleOn, down && { opacity: 0.7 }]}
        >
          <Text style={[styles.toggleLabel, sharing && styles.toggleLabelOn]}>
            {sharing ? '위치 공유 켬' : '위치 공유 끔'}
          </Text>
        </Pressable>
      </View>
      {!sharing ? (
        <Text style={styles.hint}>친구에게는 &apos;위치 없음&apos;으로 보여요. [도착 확인]은 그대로 쓸 수 있어요.</Text>
      ) : null}

      {notice ? (
        <Card>
          {notice.lines.map((line, i) => (
            <Text key={line} style={i === 0 ? styles.noticeMain : styles.noticeSub}>
              {line}
            </Text>
          ))}
          {notice.action ? (
            <PrimaryButton label={notice.action.label} variant="ghost" onPress={notice.action.onPress} />
          ) : null}
        </Card>
      ) : null}

      <JoinRequests live={live} isHost={isHost} api={api} refresh={refresh} />

      <SectionTitle>참가자</SectionTitle>
      <ParticipantRows live={live} sharing={sharing} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  ticker: { gap: spacing.xs, paddingVertical: spacing.xs },
  tickerMain: { fontSize: fontSize.lg, fontWeight: '800', color: colors.text },
  tickerSub: { fontSize: fontSize.sm, color: colors.subtext, fontVariant: ['tabular-nums'] },
  loss: { color: colors.danger },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusText: { flex: 1, fontSize: fontSize.sm, color: colors.text },
  toggle: {
    borderRadius: radius.pill,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  toggleOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  toggleLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text },
  toggleLabelOn: { color: colors.onPrimary, fontWeight: '800' },
  hint: { fontSize: fontSize.xs, color: colors.subtext },
  noticeMain: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text },
  noticeSub: { fontSize: fontSize.sm, color: colors.subtext },
  personRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  personBody: { flex: 1, gap: 2 },
  personName: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  personLine: { fontSize: fontSize.sm, color: colors.subtext, fontVariant: ['tabular-nums'] },
  initial: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    backgroundColor: colors.cardAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initialArrived: { backgroundColor: colors.primary },
  initialText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text },
  initialTextArrived: { color: colors.onPrimary },
  smallButton: {
    borderRadius: radius.md,
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.primaryDim,
  },
  smallButtonSolid: { backgroundColor: colors.primary },
  smallButtonLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.primary },
  smallButtonLabelSolid: { color: colors.onPrimary, fontWeight: '800' },
});
