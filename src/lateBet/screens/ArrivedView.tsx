/**
 * 도착 뒤: 도착 연출 + 친구 기다리기 + [같이 있어요]
 * 설계서 §5.3-F(arrived·settling), §3.4 보증 도착, §0-1 오너 결정 변경(2026-09-18). 담당: [live]
 *
 * - 도착 연출: 300ms 옵시디언 반전 + 햅틱 1회(약속당 한 번, haptics.native → expo-haptics Success. 웹은 무동작).
 * - 1초 티커는 ParticipantRows 안에만 있다. 이 화면 본체는 폴링(5초) 때만 다시 그린다.
 * - 나는 이미 도착했으므로 위치 공유는 서버에서 끝났다. 친구 위치는 공개 창(시작 ~ 마감, 전액 몰수 뒤 30분 꼬리 포함) 동안 계속 보인다.
 * - 이 화면은 시작 뒤에만 온다(도착 = 체크인 = 시작 뒤). 아직 안 들어온 이름은 약속 시각까지 들어올 수 있어 표시만 한다(버튼 없음).
 * - 주최자가 시간을 미루면 변경 배너가 뜨고(props), 내 도착 기록은 그대로 유지된다(조기/지각 표시는 새 시각 기준으로 다시 계산).
 * - 주최자에게는 [시간 미루기]·[장소 바꾸기](HostTools)와 시작 뒤에 들어온 사람의 [내보내기](R4)를 그대로 준다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, Text, View } from 'react-native';

import { normalizeLatePolicy, penaltyFor } from '@/domain/lateBet';
import { allActiveArrived } from '@/domain/latePhase';
import { formatLoss, formatMinutes } from '@/domain/latePresets';
import { formatKoreanTime } from '@/domain/tzGuard';
import { Card, Screen, SectionTitle } from '@/ui/components';
import { alertDialog, confirmDialog } from '@/ui/dialogs';
import { MapPane } from '@/ui/MapPane';
import { colors, fontSize, spacing } from '@/ui/theme';

import { toLateBetError } from '../errors';
import { arrivalHaptic } from '../haptics';
import type { LbLiveParticipant } from '../types';
import { ChangeBanner, HostTools, liveMarkers, ParticipantRows, SmallButton, unclaimedNames, useKickAfterStart } from './LiveView';
import type { ArrivedViewProps } from './props';

const MINUTE_MS = 60_000;
/** 반전을 붙들고 있는 시간 */
const FLASH_HOLD_MS = 300;
/** 반전이 걷히는 시간 */
const FLASH_FADE_MS = 180;

/** 도착 연출을 이미 보여 준 약속(화면이 다시 마운트돼도 또 번쩍이지 않게) */
const celebrated = new Set<string>();

/** 도착 순간의 화면 반전. 끝나면 스스로 사라진다(언마운트 때 애니메이션 정리) */
function ArrivalFlash({ timeLabel, onDone }: { timeLabel: string; onDone: () => void }) {
  const opacity = useRef(new Animated.Value(1)).current;
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const anim = Animated.sequence([
      Animated.delay(FLASH_HOLD_MS),
      Animated.timing(opacity, { toValue: 0, duration: FLASH_FADE_MS, useNativeDriver: Platform.OS !== 'web' }),
    ]);
    anim.start(({ finished }) => {
      if (finished) done.current();
    });
    return () => anim.stop();
  }, [opacity]);

  return (
    <Animated.View pointerEvents="none" style={[styles.flash, { opacity }]}>
      <Text style={styles.flashTitle}>도착</Text>
      {timeLabel ? <Text style={styles.flashSub}>{timeLabel}</Text> : null}
    </Animated.View>
  );
}

export function ArrivedView({ live, phase, me, isHost, api, refresh, stale, justArrived, unseenChanges, ackChanges }: ArrivedViewProps) {
  const appointment = live.appointment;
  const { tz, meetAtMs, closeMs } = appointment;
  const policy = useMemo(() => normalizeLatePolicy(appointment.policy), [appointment.policy]);
  // 주최자: 시작 뒤에 들어온 사람만 내보낼 수 있다(R4)
  const kick = useKickAfterStart(live, api, refresh, stale);

  // ── 도착 연출(약속당 1회) — 반전 + 햅틱. celebrated 가 화면 재마운트·폴링 리렌더에서의 중복을 막는다
  const [flash, setFlash] = useState(() => justArrived && !celebrated.has(appointment.id));
  useEffect(() => {
    if (!justArrived || celebrated.has(appointment.id)) return;
    celebrated.add(appointment.id);
    setFlash(true);
    arrivalHaptic();
  }, [justArrived, appointment.id]);
  const endFlash = useCallback(() => setFlash(false), []);

  // ── 내 도착 요약 (주최자가 시간을 미루면 새 약속 시각 기준으로 다시 계산된다)
  const arrivedAtMs = me?.arrivedAtMs ?? null;
  const timeLabel = arrivedAtMs !== null ? formatKoreanTime(arrivedAtMs, tz) : '';
  const loss = arrivedAtMs !== null ? penaltyFor(policy, meetAtMs, arrivedAtMs) : 0;
  let diffLine = '';
  if (arrivedAtMs !== null) {
    const earlyMs = meetAtMs - arrivedAtMs;
    if (earlyMs >= MINUTE_MS) diffLine = `${formatMinutes(Math.floor(earlyMs / MINUTE_MS))} 일찍`;
    else if (earlyMs >= 0) diffLine = '제시간';
    else diffLine = `${formatMinutes(Math.max(1, Math.ceil(-earlyMs / MINUTE_MS)))} 늦음`;
  }
  const late = arrivedAtMs !== null && arrivedAtMs > meetAtMs;

  // ── 기다리는 중 문구 (본체는 폴링 때만 다시 그리므로 그때의 서버 시각으로 본다)
  const settling = phase === 'settling' || live.settlePending;
  const everyone = allActiveArrived(live.participants);
  const missing = unclaimedNames(appointment, live.serverNowMs);
  const beforeMeet = live.serverNowMs < meetAtMs;
  const waitingLine = settling
    ? '결과를 확정하는 중이에요'
    : everyone && missing.length === 0
      ? beforeMeet
        ? `모두 도착했어요. ${formatKoreanTime(meetAtMs, tz)}에 결과가 확정돼요.`
        : '모두 도착했어요. 곧 결과가 확정돼요.'
      : `결과는 모두 도착하면 약속 시각에, 늦어도 ${formatKoreanTime(closeMs, tz)}에 확정돼요.`;

  // ── 보증 도착 [같이 있어요] — GPS 로 도착한 사람만 누를 수 있다
  const [vouchingId, setVouchingId] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const canVouch = me?.arrivalMethod === 'gps' && appointment.status === 'open' && !settling;
  const someoneMissing = live.participants.some((p) => p.state === 'active' && p.arrivedAtMs === null);

  const vouch = useCallback(
    (p: LbLiveParticipant) => {
      confirmDialog(
        `${p.nickname}님과 같이 있나요?`,
        '누르면 이 친구가 도착한 것으로 확인돼요. 되돌릴 수 없어요.',
        () => {
          setVouchingId(p.userId);
          void api
            .vouch(appointment.id, p.userId)
            .catch((e: unknown) => alertDialog('확인하지 못했어요', toLateBetError(e).message))
            .then(() => refresh())
            .then(() => {
              if (alive.current) setVouchingId(null);
            });
        },
        { confirmText: '같이 있어요' },
      );
    },
    [api, appointment.id, refresh],
  );

  const renderAction = canVouch
    ? (p: LbLiveParticipant) => (
        <SmallButton
          label={vouchingId === p.userId ? '확인 중' : '같이 있어요'}
          disabled={vouchingId !== null || stale}
          onPress={() => vouch(p)}
        />
      )
    : undefined;

  const vouchHint =
    !someoneMissing || settling
      ? ''
      : canVouch
        ? "옆에 있는데 위치가 안 잡히는 친구가 있으면 '같이 있어요'를 눌러 주세요."
        : me?.arrivalMethod === 'vouch'
          ? "'같이 있어요'는 먼저 위치로 도착을 확인한 사람만 눌러 줄 수 있어요."
          : '';

  const markers = useMemo(() => liveMarkers(live), [live]);

  return (
    <View style={styles.fill}>
      <Screen>
        <ChangeBanner changes={unseenChanges} tz={tz} onAck={ackChanges} />

        <View style={styles.hero}>
          <Text style={styles.heroTime}>
            {timeLabel ? `${timeLabel} 도착` : '도착했어요'}
            {me?.arrivalMethod === 'vouch' ? ' · 친구 확인' : ''}
          </Text>
          {diffLine ? (
            <Text style={styles.heroDiff}>
              {diffLine}
              {loss > 0 ? (
                <Text>
                  {' / '}
                  <Text style={styles.loss}>{formatLoss(loss)}</Text> 예정
                </Text>
              ) : null}
            </Text>
          ) : null}
          {late && loss === 0 && policy.stake > 0 ? (
            <Text style={styles.heroSub}>건 포인트는 그대로 돌려받아요.</Text>
          ) : null}
        </View>

        <Card>
          <Text style={styles.waitMain}>
            {settling ? waitingLine : '위치 공유가 끝났어요. 친구들을 기다리는 중'}
          </Text>
          {settling ? null : <Text style={styles.waitSub}>{waitingLine}</Text>}
          {!settling && missing.length > 0 ? (
            <Text style={styles.waitSub}>
              아직 안 들어온 친구({missing.join(', ')})는 {formatKoreanTime(meetAtMs, tz)}까지 들어올 수 있어요. 들어오면 그때부터 위치가
              보여요.
            </Text>
          ) : null}
        </Card>

        <SectionTitle>참가자</SectionTitle>
        <ParticipantRows live={live} renderAction={renderAction} kick={isHost ? kick : undefined} />
        {vouchHint ? <Text style={styles.hint}>{vouchHint}</Text> : null}

        {someoneMissing && !settling ? (
          <MapPane
            destination={{ name: appointment.placeName, lat: appointment.placeLat, lng: appointment.placeLng }}
            radiusM={appointment.policy.radiusM}
            markers={markers}
            height={160}
          />
        ) : null}

        {isHost ? <HostTools live={live} api={api} refresh={refresh} disabled={stale} /> : null}
      </Screen>
      {flash ? <ArrivalFlash timeLabel={timeLabel} onDone={endFlash} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hero: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xl },
  heroTime: { fontSize: fontSize.xl, fontWeight: '800', color: colors.text, textAlign: 'center' },
  heroDiff: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text, textAlign: 'center' },
  heroSub: { fontSize: fontSize.sm, color: colors.subtext, textAlign: 'center' },
  loss: { color: colors.danger },
  waitMain: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  waitSub: { fontSize: fontSize.sm, color: colors.subtext },
  hint: { fontSize: fontSize.xs, color: colors.subtext },
  flash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  flashTitle: { fontSize: 44, fontWeight: '800', color: colors.onPrimary },
  flashSub: { fontSize: fontSize.lg, fontWeight: '700', color: colors.onPrimary },
});
