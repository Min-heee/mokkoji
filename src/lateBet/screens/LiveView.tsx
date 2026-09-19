/**
 * 라이브·지각 구간(공개 창 안): 지도 + 손실 티커 + 참가자 행 + [도착 확인] + 길찾기 + 위치 공유 토글
 * 설계서 §5.3-F(live·overtime), §5.4 실패 상태 동작표, §0-1 오너 결정 변경(2026-09-18). 담당: [live]
 *
 * - 1초 티커는 LossTicker·ParticipantRows 안에만 있다. LiveView 본체는 폴링(5초)·판정 결과가 바뀔 때만 다시 그린다.
 * - 위치 보고 루프는 컨테이너(app/late/[id])가 돌린다. 여기서는 reporter 의 상태를 그리고 [도착 확인]만 부른다.
 *   P1: 네이티브 reporter(expo-location)의 권한(permission·canAskAgain)·샘플 품질·모의 위치·위치 못 읽음 상태를 §5.4 문구로 잇는다.
 *   [위치 공유] 토글은 reporter.setSharing 이 루프를 멈추고 lb_stop_sharing 을 1회 부른다(여기서 따로 부르지 않는다).
 *   지도의 '나' 점은 기기 위치(reporter.myPosition), 없으면 서버가 돌려준 내 좌표.
 * - 이 화면은 주최자가 [시작하기]를 누른 뒤(startedAtMs 있음)에만 온다. 그 순간부터 전원 위치가 서로 보이고 체크인이 열린다.
 * - 아직 안 들어온 이름(명단의 빈 칸)은 약속 시각까지 계속 들어올 수 있다 — 표시만 하고 [명단에서 빼기]는 없다
 *   (시작 후 명단은 동결, 약속 시각에 서버가 자동 삭제). 들어오면 다음 폴링부터 참가자 행·지도에 나타난다.
 * - 변경 배너(주최자가 시간을 미루거나 장소를 바꿈)는 props 로 온다. 티커·행은 appointment 를 그대로 읽으므로
 *   새 마감 기준으로 저절로 다시 계산된다.
 * - 전액 몰수 뒤 30분 꼬리(closeMs 까지)에도 참가자 행·좌표는 그대로 보인다. 티커만 '전액' 문구로 바뀐다.
 * - ArrivedView 가 같이 쓰는 조각(ChangeBanner · ParticipantRows · HostTools · SmallButton · liveMarkers · unclaimedNames)도 이 파일에서 내보낸다.
 */
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { fullForfeitAtMs, lateUnits, normalizeLatePolicy, projectedPenalty } from '@/domain/lateBet';
import { onTimeUntilMs } from '@/domain/latePhase';
import { describePolicy, formatLoss } from '@/domain/latePresets';
import { mapRouteUrl } from '@/domain/mapRoute';
import { formatKoreanDateTime, formatKoreanTime, msToLocalAt } from '@/domain/tzGuard';
import { Card, Chip, PrimaryButton, Screen, SectionTitle } from '@/ui/components';
import { alertDialog, confirmDialog } from '@/ui/dialogs';
import { formatDistance, MapPane, type MapPaneMarker } from '@/ui/MapPane';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

import type { LateBetApi } from '../api';
import { describeChanges } from '../changes';
import { isConnectivityError, reportReasonMessage, toLateBetError } from '../errors';
import { serverNow } from '../serverClock';
import type { LbAppointment, LbAppointmentChange, LbLive, LbLiveParticipant } from '../types';
import { useServerNow } from '../useServerNow';
import { openExternal } from './ConditionCard';
import type { LiveViewProps } from './props';

const MINUTE_MS = 60_000;
/** 연결이 끊긴 체크인: 3초 간격 재시도(§3.4) */
const OFFLINE_RETRY_MS = 3_000;
/** GPS 부정확: 5초마다 자동 재시도(§5.4) */
const ACCURACY_RETRY_MS = 5_000;
/** 이보다 나쁜 정확도는 '대략적인 위치'로 본다(서버도 저장하지 않는다) */
const COARSE_ACCURACY_M = 1000;
/** [시간 미루기] 선택지(분). 서버 상한 +180분(LB_POSTPONE_TOO_FAR)과 같다 */
const POSTPONE_CHOICES_MINUTES = [15, 30, 60, 120, 180] as const;
/** 서버 규칙: 새 약속 시각은 지금부터 5분 뒤 이후(LB_TIME_IN_PAST) */
const MIN_LEAD_MS = 5 * MINUTE_MS;

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

/** '15분' · '1시간' · '2시간 30분' */
function formatDelta(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}분`;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

function accuracyLabel(accuracyM: number | null): string {
  if (accuracyM === null || !(accuracyM >= 0)) return '';
  if (accuracyM <= 30) return '위치 정확도 좋음';
  if (accuracyM <= 100) return '위치 정확도 보통';
  return `위치 정확도 낮음 (오차 약 ${formatDistance(accuracyM)})`;
}

/** 좌표 길찾기(카카오맵). 웹은 새 탭(같은 탭을 갈아치우면 앱이 지도로 대체된다) */
function openRoute(appointment: LbAppointment): void {
  openExternal(mapRouteUrl(appointment.placeName, appointment.placeLat, appointment.placeLng));
}

/**
 * 아직 안 들어온 이름(명단에서 아무도 고르지 않은 칸). 약속 시각까지 들어올 수 있고, 그 뒤에는 서버가 지운다.
 * nowMs 를 주면 약속 시각이 지난 뒤(다음 폴링 전)에는 빈 배열 — 서버 삭제와 화면이 어긋나지 않게
 */
export function unclaimedNames(appointment: LbAppointment, nowMs?: number): string[] {
  if (typeof nowMs === 'number' && nowMs >= appointment.meetAtMs) return [];
  return appointment.invitees.filter((i) => i.claimedByUserId === null).map((i) => i.name);
}

/** 이보다 오래된 좌표는 지도에서 흐리게(서버는 3분이 지나면 좌표를 아예 내려주지 않는다) */
const MARKER_STALE_MS = 60_000;

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
      // 서버 시각 기준(폴링 응답의 serverNowMs) — 기기 시계와 섞지 않는다
      lastSeenMs: p.location ? p.location.updatedAtMs : null,
      stale: p.location ? live.serverNowMs - p.location.updatedAtMs > MARKER_STALE_MS : false,
    }));
}

// ───────────────────────── 변경 배너 ─────────────────────────

/**
 * "주최자가 약속을 바꿨어요: 오후 7:30 → 오후 8:00 · 건 포인트 100P → 200P" + [확인].
 * 문구는 changes.describeChanges. 실질 변화가 없으면(중간에 바꿨다가 되돌린 경우) 그리지 않고 바로 확인 처리한다.
 */
export function ChangeBanner({
  changes,
  tz,
  onAck,
}: {
  changes: readonly LbAppointmentChange[];
  tz: string;
  onAck: () => void;
}) {
  const text = describeChanges(changes, tz);
  const pending = changes.length > 0 && text === '';
  useEffect(() => {
    if (pending) onAck();
  }, [pending, onAck]);
  if (text === '') return null;
  return (
    <Card style={styles.banner}>
      <Text style={styles.bannerText}>{text}</Text>
      <Text style={styles.bannerSub}>위치 공개·체크인 마감 시각도 새 약속 기준으로 다시 계산됐어요.</Text>
      <PrimaryButton label="확인" variant="ghost" onPress={onAck} />
    </Card>
  );
}

// ───────────────────────── 손실 티커 (1초) ─────────────────────────

/**
 * live    : 지금 도착하면 전액 돌려받아요 · 마감까지 12:34
 * overtime: 지금 도착하면 −20P(브릭) · 1분 20초 뒤 −30P · 오후 8:15 넘으면 전액
 * 꼬리    : 지금 도착해도 −100P · 그래도 오후 8:45까지 오면 '지각'으로 남아요 · 체크인 마감까지 29:59
 * 단계는 props 의 phase 가 아니라 이 컴포넌트의 시각으로 다시 본다(경계에서 1초 어긋나지 않게).
 * appointment 가 바뀌면(주최자가 시간을 미룸) 새 마감 기준으로 저절로 다시 계산된다.
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

  const fullAt = fullForfeitAtMs(policy, meetAtMs) ?? closeMs;

  // 전액 몰수 뒤 30분 꼬리: 잃는 건 확정, 그래도 오면 '지각'으로 남는다(오너 결정 변경 3)
  if (now > fullAt) {
    return (
      <View style={styles.ticker}>
        <Text style={styles.tickerMain}>
          지금 도착해도 <Text style={styles.loss}>{formatLoss(policy.stake)}</Text>
        </Text>
        <Text style={styles.tickerSub}>
          그래도 {formatKoreanTime(closeMs, tz)}까지 오면 &apos;지각&apos;으로 남아요 · {untilClose}
        </Text>
      </View>
    );
  }

  const loss = projectedPenalty(policy, meetAtMs, now);
  // 지금 k 단위째 → (k+1) 단위째는 onTimeUntil + k×단위 를 '넘는' 순간 시작된다
  const units = lateUnits(policy, meetAtMs, now);
  const nextAt = onTimeUntil + units * policy.unitMinutes * MINUTE_MS;
  const nextLoss = projectedPenalty(policy, meetAtMs, nextAt + 1);
  const fullTime = formatKoreanTime(fullAt, tz);

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

/** 행 안의 작은 버튼(같이 있어요·명단에서 빼기). 풀폭 버튼 두 단계와 같은 솔리드/틴트 */
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

export interface ParticipantRowsProps {
  live: LbLive;
  /** 내 공유 토글(LiveView 만 안다). 꺼져 있으면 내 행은 '위치 공유 끔' */
  sharing?: boolean;
  /** 미도착 친구 행 오른쪽에 붙일 것 — ArrivedView 의 [같이 있어요] */
  renderAction?: (p: LbLiveParticipant) => React.ReactNode;
}

/**
 * 참가자 목록(서버 순서 그대로) + 아직 안 들어온 이름(명단의 빈 칸, 약속 시각까지만). "N초 전"을 위해 이 컴포넌트만 1초마다 다시 그린다.
 * 전액 몰수 뒤 30분 꼬리에도 미도착 행과 좌표는 그대로 보인다(서버가 closeMs 까지 내려 준다).
 * 안 들어온 이름에는 버튼이 없다 — 시작 후 명단은 동결이고, 약속 시각에 서버가 지운다.
 */
export function ParticipantRows({ live, sharing, renderAction }: ParticipantRowsProps) {
  const now = useServerNow(1000);
  const a = live.appointment;
  const tz = a.tz;
  const rows = live.participants.filter((p) => p.state === 'active');
  const missing = unclaimedNames(a, now);
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
                {p.userId === a.hostId ? ' · 주최자' : ''}
              </Text>
              <Text style={styles.personLine} numberOfLines={2}>
                {line}
              </Text>
            </View>
            {action}
          </View>
        );
      })}
      {missing.map((name) => (
        <View key={`unclaimed:${name}`} style={styles.personRow}>
          <View style={[styles.initial, styles.initialMissing]}>
            <Text style={[styles.initialText, styles.initialTextMissing]}>{Array.from(name)[0] ?? ''}</Text>
          </View>
          <View style={styles.personBody}>
            <Text style={[styles.personName, styles.personNameMissing]} numberOfLines={1}>
              {name}
            </Text>
            <Text style={styles.personLine}>아직 안 들어왔어요 · {formatKoreanTime(a.meetAtMs, tz)}까지 들어올 수 있어요</Text>
          </View>
        </View>
      ))}
    </Card>
  );
}

// ───────────────────────── 주최자 도구: 시간 미루기 · 장소 바꾸기 ─────────────────────────

export interface HostToolsProps {
  live: LbLive;
  api: LateBetApi;
  refresh: () => Promise<LbLive | null>;
  /** 연결이 끊겨 있으면 버튼을 잠근다 */
  disabled?: boolean;
}

/**
 * 시작 후 주최자가 할 수 있는 두 가지(§0-1 규칙 5): 시간 '뒤로 미루기'(최대 +3시간)와 장소 변경.
 * - 미루기: 약속 시각 + 15분/30분/1시간/2시간/3시간 중 지금부터 5분 뒤 이후인 것만(서버 LB_TIME_IN_PAST 규칙).
 *   api.edit(id, { localAt }, version) → 서버가 마감·정산 시각을 새 시각 기준으로 다시 계산한다(startedAtMs 는 그대로).
 *   앞당기면 LB_POSTPONE_ONLY, 3시간 넘게 미루면 LB_POSTPONE_TOO_FAR — 선택지 자체가 그 범위 안이라 평소엔 안 나온다.
 * - 장소: 약속 잡기 화면의 수정 모드(/late/new?edit=<id>)로 들어간다. 시작 후 다른 조건을 건드리면 서버가 LB_EDIT_FROZEN 으로 막는다.
 * 정산이 시작된 뒤(마감 지남·settlePending)에는 그리지 않는다(서버 LB_EDIT_CLOSED).
 */
export function HostTools({ live, api, refresh, disabled = false }: HostToolsProps) {
  const router = useRouter();
  const a = live.appointment;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const postponeTo = useCallback(
    (targetMs: number) => {
      const localAt = msToLocalAt(targetMs, a.tz);
      if (localAt === '') {
        alertDialog('미루지 못했어요', '시간대를 읽지 못했어요.');
        return;
      }
      confirmDialog(
        `약속을 ${formatKoreanDateTime(targetMs, a.tz)}(으)로 미룰까요?`,
        '체크인 마감·결과 확정 시각도 새 약속 기준으로 다시 계산돼요. 이미 도착한 사람의 도착은 그대로예요.',
        () => {
          setBusy(true);
          void (async () => {
            try {
              // 시간대는 그대로다 — 만들 때 이미 확인한 값이므로 다시 묻지 않는다
              // 알림은 refresh 뒤 useLateReminders 가 새 version 으로 다시 맞춘다
              await api.edit(a.id, { localAt, tzConfirmed: true }, a.version);
              if (alive.current) setOpen(false);
            } catch (e) {
              alertDialog('미루지 못했어요', toLateBetError(e).message);
            } finally {
              await refresh();
              if (alive.current) setBusy(false);
            }
          })();
        },
        { confirmText: '미루기' },
      );
    },
    [a.id, a.tz, a.version, api, refresh],
  );

  // 정산이 시작됐거나 닫힌 약속은 못 바꾼다(서버 LB_EDIT_CLOSED)
  if (a.status !== 'open' || live.settlePending) return null;

  const now = serverNow();
  const choices = POSTPONE_CHOICES_MINUTES.map((minutes) => ({ minutes, targetMs: a.meetAtMs + minutes * MINUTE_MS })).filter(
    (c) => c.targetMs > now + MIN_LEAD_MS,
  );
  return (
    <>
      <SectionTitle>주최자</SectionTitle>
      <Card>
        <Text style={styles.muted}>
          이미 시작한 약속이라 시간은 뒤로 미루기(최대 3시간)만, 장소는 바꿀 수 있어요. 바꾸면 친구들 화면에 알림 배너가 떠요.
        </Text>
        {open ? (
          <View style={styles.stack}>
            <Text style={styles.label}>언제로 미룰까요?</Text>
            {choices.length === 0 ? (
              <Text style={styles.muted}>더 미룰 수 있는 시각이 없어요. 약속 시각에서 최대 3시간까지만 미룰 수 있어요.</Text>
            ) : (
              <View style={styles.chips}>
                {choices.map((c) => (
                  <Chip
                    key={c.minutes}
                    label={`${formatKoreanTime(c.targetMs, a.tz)} (+${formatDelta(c.minutes)})`}
                    selected={false}
                    disabled={busy || disabled}
                    onPress={() => postponeTo(c.targetMs)}
                  />
                ))}
              </View>
            )}
            <PrimaryButton label="닫기" variant="ghost" onPress={() => setOpen(false)} disabled={busy} />
          </View>
        ) : (
          <View style={styles.stack}>
            <PrimaryButton label="시간 미루기" variant="ghost" onPress={() => setOpen(true)} disabled={busy || disabled} />
            <PrimaryButton
              label="장소 바꾸기"
              variant="ghost"
              onPress={() => router.push(`/late/new?edit=${a.id}`)}
              disabled={busy || disabled}
            />
          </View>
        )}
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
const MOCKED_MESSAGE = '모의 위치 앱이 켜져 있으면 도착을 확인할 수 없어요.';

export function LiveView({ live, phase, isHost, api, refresh, stale, reporter, unseenChanges, ackChanges }: LiveViewProps) {
  const appointment = live.appointment;
  const { permission, sharing, running, myDistanceM, myAccuracyM, lastResult, canAskAgain } = reporter;
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

  // 체크인이 닫혔다는 판정을 받으면 바로 다시 읽어 결과 화면으로 넘어가게 한다. 이미 도착이면 도착 화면으로
  const lastReason = lastResult?.reason ?? null;
  useEffect(() => {
    if (lastReason === 'closed' || lastReason === 'already_arrived') void refresh();
  }, [lastReason, refresh]);

  // 자동 재시도: 연결 끊김 3초 · GPS 부정확 5초(보고 루프가 돌고 있으면 루프가 5초마다 다시 보낸다). 언마운트 때 정리
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
    // 끄면 reporter 가 루프를 멈추고 lb_stop_sharing 을 1회 부른다 → 끝나면 다시 읽어 내 행을 '위치 공유 끔'으로
    void reporterRef.current.setSharing(next).then(() => {
      if (!next) void refresh();
    });
  }, [refresh]);

  const openSettings = useCallback(() => {
    void reporterRef.current.openSettings().then((opened) => {
      if (!opened) alertDialog('설정을 열 수 없어요');
    });
  }, []);

  // ── 실패 상태(§5.4) — 위에서부터 먼저 걸리는 것 하나만 보여 준다
  const notice: Notice | null = (() => {
    const settings = Platform.OS === 'web' ? undefined : { label: '설정 열기', onPress: openSettings };
    const askAgain = { label: '위치 허용하기', onPress: () => void reporterRef.current.requestPermission() };
    if (permission === 'denied' || permission === 'unsupported') {
      return {
        lines: ['위치가 꺼져 있어 도착을 자동으로 확인할 수 없어요', VOUCH_HINT],
        // 한 번 거부(다시 물을 수 있음)는 OS 프롬프트로, 영구 거부는 설정으로
        action: permission === 'denied' ? (canAskAgain && Platform.OS !== 'web' ? askAgain : settings) : undefined,
      };
    }
    if (permission === 'undetermined') {
      return {
        lines: ['위치를 허용해야 도착을 자동으로 확인할 수 있어요', VOUCH_HINT],
        action: askAgain,
      };
    }
    if (permission === 'coarse' || (myAccuracyM !== null && myAccuracyM > COARSE_ACCURACY_M)) {
      return { lines: ["대략적인 위치만 허용돼 있어요. 설정에서 '정확한 위치'를 켜주세요."], action: settings };
    }
    // 서버 판정을 기다리지 않고 기기가 먼저 안다(안드로이드 mocked 플래그)
    if (reporter.mocked) return { lines: [MOCKED_MESSAGE, VOUCH_HINT] };
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
    if (reporter.positionUnavailable && myDistanceM === null) {
      return {
        lines: ['위치를 읽지 못하고 있어요. 휴대폰의 위치 서비스가 켜져 있는지 확인해 주세요.', VOUCH_HINT],
        action: settings,
      };
    }
    if (noPosition) return { lines: ['위치를 읽지 못했어요. 다시 눌러주세요.'] };
    if (lastResult && lastReason !== null && (lastReason !== 'outside' || pressed)) {
      const message = reportReasonMessage(lastReason, {
        distanceM: lastResult.distanceM,
        accuracyM: myAccuracyM,
        radiusM: appointment.policy.radiusM,
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
  const hasDevicePoint = reporter.myPosition !== null;
  // 기기 위치로 '나'를 그릴 때는 서버가 돌려준 내 마커를 빼서 두 번 찍히지 않게 한다
  const markers = useMemo(
    () => (hasDevicePoint ? liveMarkers(live).filter((m) => !m.isMe) : liveMarkers(live)),
    [live, hasDevicePoint],
  );
  const myRow = live.participants.find((p) => p.userId === live.myUserId) ?? null;
  // 지도 '나' 점: 기기 위치가 먼저(공유를 꺼도 내 화면에는 보인다), 없으면 서버가 돌려준 내 좌표
  const myPoint =
    reporter.myPosition ??
    (myRow?.location ? { lat: myRow.location.lat, lng: myRow.location.lng, accuracyM: myRow.location.accuracyM } : null);
  // 네이티브 지도가 OS 의 '내 위치' 점을 그려도 되는가(권한이 이미 있고 실제 GPS 를 쓰는 중)
  const locationGranted = (permission === 'granted' || permission === 'coarse') && reporter.source !== 'fake';

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

  // 아직 안 들어온 이름 안내(약속 시각까지 들어올 수 있다). 본체는 폴링 때만 다시 그리므로 그때의 서버 시각으로 본다
  const missing = unclaimedNames(appointment, live.serverNowMs);
  const policy = normalizeLatePolicy(appointment.policy);
  const fullAt = fullForfeitAtMs(policy, appointment.meetAtMs);
  const tailLine =
    fullAt !== null && fullAt < appointment.closeMs
      ? `전액을 잃은 뒤에도 ${formatKoreanTime(appointment.closeMs, appointment.tz)}까지는 위치가 보이고, 그때까지 오면 '지각'으로 남아요.`
      : '';
  const placeNote = appointment.placeNote.trim();

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
      <ChangeBanner changes={unseenChanges} tz={appointment.tz} onAck={ackChanges} />

      <MapPane
        destination={{ name: appointment.placeName, lat: appointment.placeLat, lng: appointment.placeLng }}
        radiusM={appointment.policy.radiusM}
        markers={markers}
        me={myPoint}
        locationGranted={locationGranted}
      />
      <Text style={styles.placeLine} numberOfLines={2}>
        {appointment.placeName}
        {placeNote !== '' ? ` · ${placeNote}` : ''}
      </Text>

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

      {missing.length > 0 ? (
        <Card>
          <Text style={styles.noticeMain}>아직 안 들어온 친구: {missing.join(', ')}</Text>
          <Text style={styles.noticeSub}>
            {formatKoreanTime(appointment.meetAtMs, appointment.tz)}까지 들어올 수 있고, 들어오면 그때부터 위치가 보여요.
            {isHost ? ' 그때까지도 안 들어온 이름은 명단에서 자동으로 빠져요.' : ''}
          </Text>
        </Card>
      ) : null}

      <SectionTitle>참가자</SectionTitle>
      <ParticipantRows live={live} sharing={sharing} />
      {tailLine !== '' ? <Text style={styles.hint}>{tailLine}</Text> : null}

      {isHost ? <HostTools live={live} api={api} refresh={refresh} disabled={stale} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  banner: { backgroundColor: colors.cardAlt },
  bannerText: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  bannerSub: { fontSize: fontSize.sm, color: colors.subtext },
  placeLine: { fontSize: fontSize.sm, color: colors.subtext },
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
  muted: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  label: { fontSize: fontSize.xs, fontWeight: '700', color: colors.subtext },
  stack: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  noticeMain: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text },
  noticeSub: { fontSize: fontSize.sm, color: colors.subtext },
  personRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  personBody: { flex: 1, gap: 2 },
  personName: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  personNameMissing: { color: colors.subtext },
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
  initialMissing: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  initialText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text },
  initialTextArrived: { color: colors.onPrimary },
  initialTextMissing: { color: colors.subtext },
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
