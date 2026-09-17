/**
 * 가짜 서버 조작 패널 — fake 모드(개발 번들)에서만 보인다. 그 외에는 null.
 *
 * 접힌 띠 한 줄("가짜 서버 · 서버 시각")을 누르면 펼쳐진다.
 * - 시간 빨리 감기(+1분/+10분/+1시간, 공개 시작·약속 시각·마감 직전·마감 뒤로 점프)
 * - 내 가짜 위치(목적지로/300m 앞/1.5km 밖/GPS 부정확/모의 위치/위치 모름) → useArrivalReporter 가 읽어 보고한다
 * - 봇(성격별 참여, 참여 요청 만들기, 한 명 도착시키기)
 * - 연결 끊기, 초기화
 * 조작 뒤에는 서버 시계를 다시 맞추고 onChanged(보통 useLive.refresh)와 전역 refresh 를 부른다.
 */
import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatKoreanDateTime, SEOUL_TZ } from '@/domain/tzGuard';
import { Chip } from '@/ui/components';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

import { toLateBetError } from '../errors';
import { useLateBet } from '../LateBetContext';
import { serverClock } from '../serverClock';
import { fakeDevice } from '../useArrivalReporter';
import { useServerNow } from '../useServerNow';

// 개발 번들에서만 가짜 서버 모듈을 싣는다
const fakeModule: typeof import('../fakeApi') | null = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('../fakeApi') as typeof import('../fakeApi'))
  : null;

const MIN = 60_000;

export interface FakeDevPanelProps {
  /** 약속 화면에서는 id 를 준다 → 점프·위치·봇 조작이 나온다. 홈·참여 화면에서는 생략(시간·초기화·데모 코드만) */
  appointmentId?: string | null;
  /** 조작 직후 불린다 — 보통 useLive 의 refresh */
  onChanged?: () => void;
}

export function FakeDevPanel({ appointmentId, onChanged }: FakeDevPanelProps) {
  const { fake } = useLateBet();
  if (!fake || !fakeModule) return null;
  return <Panel appointmentId={appointmentId ?? null} onChanged={onChanged} mod={fakeModule} />;
}

function Clock() {
  const now = useServerNow(1000);
  return <Text style={styles.barText}>가짜 서버 · {formatKoreanDateTime(now, SEOUL_TZ)}</Text>;
}

function Panel({
  appointmentId,
  onChanged,
  mod,
}: {
  appointmentId: string | null;
  onChanged?: () => void;
  mod: typeof import('../fakeApi');
}) {
  const { refresh } = useLateBet();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [offline, setOffline] = useState(mod.isFakeOffline());
  const [mocked, setMocked] = useState(fakeDevice.get()?.mocked === true);
  const server = mod.getFakeServer();

  const after = useCallback(
    (message: string) => {
      const t = Date.now();
      serverClock.addSample(server.nowMs(), t, t);
      setNote(message);
      onChanged?.();
      void refresh();
    },
    [onChanged, refresh, server],
  );

  const guard = (fn: () => string) => () => {
    try {
      after(fn());
    } catch (e) {
      after(`실패: ${toLateBetError(e).code}`);
    }
  };

  const a = appointmentId ? server.appointmentInfo(appointmentId) : null;

  const jump = (label: string, target: number) =>
    guard(() => {
      if (target <= server.nowMs()) return `${label}: 이미 지났어요`;
      server.advanceTo(target);
      return `${label}(으)로 감았어요`;
    });

  const place = (label: string, distM: number, accuracyM: number | null) =>
    guard(() => {
      if (!a) return '약속이 없어요';
      const p = mod.offsetPoint(a.placeLat, a.placeLng, distM, 0.6);
      fakeDevice.set({ lat: p.lat, lng: p.lng, accuracyM, mocked });
      return `내 위치: ${label}`;
    });

  const bot = (plan: import('../fakeApi').FakeBotPlan, label: string) =>
    guard(() => {
      if (!appointmentId) return '약속이 없어요';
      const b = server.addBot(appointmentId, plan);
      return `${b.nickname}(${label}) ${b.state === 'pending' ? '참여 요청' : '참여'}`;
    });

  return (
    <View style={styles.wrap}>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.bar}>
        <Clock />
        <Text style={styles.barText}>{open ? '접기' : '펼치기'}</Text>
      </Pressable>
      {open ? (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {note !== '' ? <Text style={styles.note}>{note}</Text> : null}

          <Text style={styles.label}>시간 빨리 감기</Text>
          <View style={styles.chips}>
            <Chip label="+1분" selected={false} onPress={guard(() => (server.advance(MIN), '+1분'))} />
            <Chip label="+10분" selected={false} onPress={guard(() => (server.advance(10 * MIN), '+10분'))} />
            <Chip label="+1시간" selected={false} onPress={guard(() => (server.advance(60 * MIN), '+1시간'))} />
            {a ? (
              <>
                <Chip label="공개 시작으로" selected={false} onPress={jump('위치 공개 시작', a.shareStartMs)} />
                <Chip label="약속 5분 전" selected={false} onPress={jump('약속 5분 전', a.meetAtMs - 5 * MIN)} />
                <Chip label="약속 시각" selected={false} onPress={jump('약속 시각', a.meetAtMs)} />
                <Chip label="마감 1분 전" selected={false} onPress={jump('마감 1분 전', a.closeMs - MIN)} />
                <Chip label="마감 +1분(정산)" selected={false} onPress={jump('마감 1분 뒤', a.closeMs + MIN)} />
              </>
            ) : null}
          </View>

          {a ? (
            <>
              <Text style={styles.label}>내 위치</Text>
              <View style={styles.chips}>
                <Chip label="목적지로" selected={false} onPress={place('목적지', 5, 10)} />
                <Chip label="300m 앞" selected={false} onPress={place('300m 앞', 300, 12)} />
                <Chip label="1.5km 밖" selected={false} onPress={place('1.5km 밖', 1500, 15)} />
                <Chip label="GPS 부정확(근처)" selected={false} onPress={place('근처, 오차 180m', 20, 180)} />
                <Chip label="대략적 위치(2km 오차)" selected={false} onPress={place('대략적 위치', 400, 2000)} />
                <Chip
                  label="모의 위치"
                  selected={mocked}
                  onPress={guard(() => {
                    const next = !mocked;
                    setMocked(next);
                    const cur = fakeDevice.get();
                    if (cur) fakeDevice.set({ ...cur, mocked: next });
                    return next ? '모의 위치 켬' : '모의 위치 끔';
                  })}
                />
                <Chip label="위치 모름" selected={false} onPress={guard(() => (fakeDevice.set(null), '내 위치: 모름'))} />
              </View>

              <Text style={styles.label}>봇 친구 (잠금 전 = 바로 참여, 잠금 후 = 참여 요청)</Text>
              <View style={styles.chips}>
                <Chip label="제시간 봇" selected={false} onPress={bot('onTime', '제시간')} />
                <Chip label="지각 봇" selected={false} onPress={bot('late', '지각')} />
                <Chip label="지하 봇(보증 필요)" selected={false} onPress={bot('needsVouch', '보증 필요')} />
                <Chip label="노쇼 봇" selected={false} onPress={bot('noShow', '노쇼')} />
                <Chip label="앱 닫는 봇" selected={false} onPress={bot('ghost', '앱 닫음')} />
                <Chip
                  label="참여 요청 만들기"
                  selected={false}
                  onPress={guard(() => {
                    const b = server.addBotRequest(a.id);
                    return `${b.nickname}님이 참여를 요청했어요`;
                  })}
                />
                <Chip
                  label="봇 한 명 도착"
                  selected={false}
                  onPress={guard(() => {
                    const r = server.arriveBot(a.id);
                    if (!r) return '도착시킬 봇이 없어요';
                    return r.result.arrived ? `${r.nickname} 도착` : `${r.nickname}: ${r.result.reason}`;
                  })}
                />
              </View>
            </>
          ) : null}

          <Text style={styles.label}>기타</Text>
          <View style={styles.chips}>
            <Chip
              label="연결 끊기"
              selected={offline}
              onPress={() => {
                const next = !offline;
                mod.setFakeOffline(next);
                setOffline(next);
                setNote(next ? '연결을 끊었어요' : '다시 연결했어요');
                if (!next) {
                  onChanged?.();
                  void refresh();
                }
              }}
            />
            <Chip
              label="가짜 서버 초기화"
              selected={false}
              onPress={guard(() => {
                server.reset();
                fakeDevice.set(null);
                return '초기화했어요. 홈으로 돌아가 주세요';
              })}
            />
          </View>
          <Text style={styles.hint}>
            데모 초대 코드: {mod.FAKE_DEMO_CODES.open}(바로 참여) · {mod.FAKE_DEMO_CODES.locked}(수락제, 8초 뒤 자동 수락) ·{' '}
            {mod.FAKE_DEMO_CODES.joinClosed}(참여 마감) · {mod.FAKE_DEMO_CODES.canceled}(취소됨)
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.cardAlt,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  barText: { fontSize: fontSize.xs, color: colors.subtext, fontWeight: '600' },
  // 폰에서 화면을 다 덮지 않게
  scroll: { maxHeight: 300 },
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.sm },
  label: { fontSize: fontSize.xs, color: colors.subtext, marginTop: spacing.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  note: {
    fontSize: fontSize.sm,
    color: colors.text,
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    padding: spacing.sm,
  },
  hint: { fontSize: fontSize.xs, color: colors.subtext },
});
