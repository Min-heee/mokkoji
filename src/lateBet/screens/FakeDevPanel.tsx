/**
 * 가짜 서버 조작 패널 — fake 모드(개발 번들, 또는 EAS 채널 'beta' 네이티브 빌드)에서만 보인다. 그 외에는 null.
 *
 * 접힌 띠 한 줄("가짜 서버 · 서버 시각")을 누르면 펼쳐진다.
 * - 시간 빨리 감기(+1분/+5분/+10분/+1시간, 시작 가능 시각(R3 쿨다운 끝)·약속 5분 전·약속 시각·마감 직전·마감 뒤로 점프)
 * - 내 가짜 위치(목적지로/300m 앞/1.5km 밖/GPS 부정확/모의 위치/위치 모름) → useArrivalReporter 가 읽어 보고한다
 *   네이티브에서는 이 좌표가 실제 GPS 를 덮어쓴다. [실제 GPS 쓰기]로 오버라이드를 풀면 진짜 위치로 돌아간다(현재 출처 표시)
 * - 봇: 명단의 빈 이름을 차례로 고르며 수락한다('봇 한 명 수락', 성격별, '시작 후 봇 수락'(= 시작 뒤 낯선 사람, 주최자가 내보낼 수 있다 R4), '봇 한 명 도착')
 *   주최자의 [시작하기]는 패널이 대신 누르지 않는다 — 대기실의 실제 버튼으로 누른다.
 * - 주최자 조작: 시간 30분 미루기(시작 전후 규칙을 그대로 탄다)
 * - 연결 끊기, 초기화
 * 조작 뒤에는 서버 시계를 다시 맞추고 onChanged(보통 useLive.refresh)와 전역 refresh 를 부른다.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatKoreanDateTime, SEOUL_TZ } from '@/domain/tzGuard';
import { Chip } from '@/ui/components';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

import { fakeDevice } from '../arrivalShared';
import { toLateBetError } from '../errors';
import { useLateBet } from '../LateBetContext';
import { serverClock } from '../serverClock';
import { useServerNow } from '../useServerNow';

// 가짜 서버 모듈은 번들 env 가 fake 일 때만 싣는다(개발 번들·beta 채널 네이티브 빌드). 웹 릴리스(앱인토스)는 modeRule 상
// fake 가 될 수 없으므로 개발 번들에서만 싣는다. __DEV__·EXPO_OS·env 비교는 이 자리에 정적으로 적어야 번들 시점에 치환돼
// 해당 없는 번들에서 require 가 빠진다. 실제로 켜지는지는 useLateBet().fake(modeRule) 가 한 번 더 막는다
const fakeModule: typeof import('../fakeApi') | null =
  (__DEV__ || process.env.EXPO_OS !== 'web') && process.env.EXPO_PUBLIC_LATEBET_MODE === 'fake'
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('../fakeApi') as typeof import('../fakeApi'))
    : null;

/** 네이티브는 실제 GPS 가 있다 — 오버라이드 해제 버튼과 출처 표시 */
const HAS_GPS = Platform.OS !== 'web';

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

/** 지금 보고에 쓰는 내 위치의 출처 */
function sourceLabel(): string {
  if (!fakeDevice.isOverriding()) return HAS_GPS ? '실제 GPS' : '가짜 좌표(기본값)';
  const p = fakeDevice.get();
  if (!p) return '가짜 — 위치 모름';
  const acc = p.accuracyM !== null ? ` · 오차 ${Math.round(p.accuracyM)}m` : '';
  return `가짜 좌표${acc}${p.mocked ? ' · 모의 위치' : ''}`;
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
  const [source, setSource] = useState(sourceLabel);
  useEffect(() => fakeDevice.subscribe(() => setSource(sourceLabel())), []);
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

  const bot = (plan: import('../fakeApi').FakeBotPlan | undefined, label: string) =>
    guard(() => {
      if (!appointmentId) return '약속이 없어요';
      const b = server.addBot(appointmentId, plan);
      return `${b.nickname}(${label}) 수락${b.started ? ' — 시작 뒤라 바로 위치가 보여요' : ''}`;
    });

  const unclaimed = a ? a.invitees.filter((i) => i.claimedByUserId === null).map((i) => i.name) : [];
  const started = a ? a.startedAtMs !== null : false;

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
            <Chip label="+5분" selected={false} onPress={guard(() => (server.advance(5 * MIN), '+5분'))} />
            <Chip label="+10분" selected={false} onPress={guard(() => (server.advance(10 * MIN), '+10분'))} />
            <Chip label="+1시간" selected={false} onPress={guard(() => (server.advance(60 * MIN), '+1시간'))} />
            {a ? (
              <>
                {a.startableAtMs !== null ? (
                  <Chip label="시작 가능 시각(쿨다운 끝)" selected={false} onPress={jump('시작 가능 시각', a.startableAtMs)} />
                ) : null}
                <Chip label="약속 30분 전" selected={false} onPress={jump('약속 30분 전', a.meetAtMs - 30 * MIN)} />
                <Chip label="약속 5분 전" selected={false} onPress={jump('약속 5분 전', a.meetAtMs - 5 * MIN)} />
                <Chip label="약속 시각" selected={false} onPress={jump('약속 시각', a.meetAtMs)} />
                <Chip label="마감 1분 전" selected={false} onPress={jump('마감 1분 전', a.closeMs - MIN)} />
                <Chip label="마감 +1분(정산)" selected={false} onPress={jump('마감 1분 뒤', a.closeMs + MIN)} />
              </>
            ) : null}
          </View>

          {a ? (
            <>
              <Text style={styles.label}>내 위치 — 지금: {source}</Text>
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
                    const cur = fakeDevice.get();
                    // 실제 GPS 에는 모의 표시를 붙일 수 없다 — 가짜 좌표를 먼저 고른다
                    if (!cur) return '먼저 가짜 좌표(목적지로·300m 앞 등)를 고르세요';
                    setMocked(next);
                    fakeDevice.set({ ...cur, mocked: next });
                    return next ? '모의 위치 켬' : '모의 위치 끔';
                  })}
                />
                <Chip label="위치 모름" selected={false} onPress={guard(() => (fakeDevice.set(null), '내 위치: 모름'))} />
                {HAS_GPS ? (
                  <Chip
                    label="실제 GPS 쓰기"
                    selected={!fakeDevice.isOverriding()}
                    onPress={guard(() => {
                      fakeDevice.release();
                      setMocked(false);
                      return '내 위치: 실제 GPS (가짜 좌표 해제)';
                    })}
                  />
                ) : null}
              </View>

              <Text style={styles.label}>
                봇 친구 — 명단의 빈 이름을 차례로 고르며 수락한다{started ? ' · 시작됨(빈 이름은 약속 시각까지 수락 가능, 명단 추가는 불가)' : ''}
                {unclaimed.length > 0 ? ` (아직 안 들어옴: ${unclaimed.join(', ')})` : started ? ' (빈 이름 없음)' : ' (빈 이름 없음 → 이름을 추가해 수락한다)'}
              </Text>
              <View style={styles.chips}>
                <Chip label="봇 한 명 수락" selected={false} onPress={bot(undefined, '성격 순환')} />
                <Chip label="제시간 봇" selected={false} onPress={bot('onTime', '제시간')} />
                <Chip label="지각 봇" selected={false} onPress={bot('late', '지각')} />
                <Chip label="지하 봇(보증 필요)" selected={false} onPress={bot('needsVouch', '보증 필요')} />
                <Chip label="노쇼 봇" selected={false} onPress={bot('noShow', '노쇼')} />
                <Chip label="앱 닫는 봇" selected={false} onPress={bot('ghost', '앱 닫음')} />
                <Chip
                  label="시작 후 봇 수락"
                  selected={false}
                  onPress={guard(() => {
                    if (!started) return '아직 시작 전이에요. 대기실의 [시작하기]를 먼저 누르세요';
                    if (unclaimed.length === 0) return '빈 이름이 없어요 (시작 뒤에는 명단을 늘릴 수 없어요)';
                    const b = server.addBot(a.id, 'onTime');
                    return `${b.nickname} 늦게 수락 — 이제부터 위치가 보이고 판정 대상이에요. 주최자는 이 사람을 내보낼 수 있어요`;
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

              <Text style={styles.label}>주최자 조작 (시작 전후 규칙을 그대로 탄다{started ? ' · 시작됨' : ' · 시작 전'})</Text>
              <View style={styles.chips}>
                <Chip
                  label="시간 30분 미루기"
                  selected={false}
                  onPress={guard(() => {
                    const moved = server.postpone(a.id, 30);
                    return `약속을 ${formatKoreanDateTime(moved.meetAtMs, moved.tz)}(으)로 미뤘어요 (version ${moved.version})`;
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
                fakeDevice.release();
                return '초기화했어요. 홈으로 돌아가 주세요';
              })}
            />
          </View>
          <Text style={styles.hint}>
            데모 초대 코드: {mod.FAKE_DEMO_CODES.open}(시작 전, 빈 이름 '민병희'·'병희' → 대기실) · {mod.FAKE_DEMO_CODES.full}(빈 이름 없음 → 명단에 없음 안내) ·{' '}
            {mod.FAKE_DEMO_CODES.started}(주최자가 이미 시작 + 빈 이름 '민병희' → 고르면 바로 live, 위치가 뜸) · {mod.FAKE_DEMO_CODES.canceled}(취소됨)
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
