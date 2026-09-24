/**
 * 마이 탭(URL '/my') — 무장식 카드 몇 장. 표시 규칙은 src/ui/myTabModel.ts(순수, 테스트 있음).
 *
 * - 요약: 모임 수 · 친구 수.
 * - 약속 내기가 켜져 있을 때만: '내 이름'([바꾸기] → /late/name), '내 포인트'([포인트 내역] → /late/points).
 * - 네이티브 ∧ 모드 on 일 때만: '권한' — 위치·알림 상태를 읽기만 한다(여기서 요청하지 않는다) + [설정 열기].
 *   모드 off 면 권한 API 를 한 번도 부르지 않는다. 설정 앱에서 돌아오면(AppState active) 다시 읽는다.
 * - '앱 정보': 버전(빌드) · 업데이트 id 앞 8자(웹·개발은 생략).
 */
import Constants from 'expo-constants';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Platform, StyleSheet, Text, View } from 'react-native';

import { START_BALANCE } from '@/domain/latePresets';
import { useLateBet } from '@/lateBet/LateBetContext';
import { getPermission, type NotificationPermission } from '@/lateBet/notifications';
import { getLocationPermission, openAppSettings, type LocationPermissionState } from '@/lateBet/permissions';
import { useFriends } from '@/state/FriendsContext';
import { useSessions } from '@/state/SessionsContext';
import { Card, PrimaryButton, Screen } from '@/ui/components';
import {
  appInfoRows,
  balanceLine,
  locationPermissionLabel,
  mySections,
  nicknameLine,
  notificationPermissionLabel,
  PROFILE_CHECKING,
  PROFILE_UNREACHABLE,
  PROFILE_UNREACHABLE_HINT,
  profileCardState,
  summaryLine,
} from '@/ui/myTabModel';
import { colors, fontSize, spacing } from '@/ui/theme';
import { readUpdateId } from '@/ui/updateInfo';

function readBuildNumber(): string | null {
  const cfg = Constants.expoConfig;
  const fromConfig = Platform.OS === 'ios' ? cfg?.ios?.buildNumber : Platform.OS === 'android' ? cfg?.android?.versionCode : undefined;
  if (fromConfig !== undefined && fromConfig !== null && String(fromConfig) !== '') return String(fromConfig);
  // app.json 에 빌드 번호가 없다(EAS 원격 버전) → 바이너리에 박힌 값
  return Constants.nativeBuildVersion ?? null;
}

export default function MyScreen() {
  const { enabled, mode } = useLateBet();
  const { sessions } = useSessions();
  const { friends } = useFriends();
  const sections = mySections({ lateEnabled: enabled, lateMode: mode, platform: Platform.OS });

  const info = appInfoRows({
    version: Constants.expoConfig?.version ?? Constants.nativeApplicationVersion,
    buildNumber: Platform.OS === 'web' ? null : readBuildNumber(),
    updateId: readUpdateId(),
  });

  return (
    <Screen aboveTabBar>
      <Card>
        <Text style={styles.label}>요약</Text>
        <Text style={styles.value}>{summaryLine(sessions.length, friends.length)}</Text>
      </Card>

      {sections.profile ? <ProfileCards /> : null}
      {sections.permissions ? <PermissionsCard /> : null}

      {info.length > 0 ? (
        <Card>
          <Text style={styles.label}>앱 정보</Text>
          {info.map((row) => (
            <View key={row.label} style={styles.row}>
              <Text style={styles.rowLabel}>{row.label}</Text>
              <Text style={styles.rowValue}>{row.value}</Text>
            </View>
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

/** '내 이름' · '내 포인트' — 약속 내기가 켜져 있을 때만 그려진다 */
function ProfileCards() {
  const router = useRouter();
  const { profile, balance, refresh, status, stale } = useLateBet();

  // 탭이 앞으로 올 때마다 프로필·잔액을 다시 읽는다(세션이 없으면 아무것도 안 한다)
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const balanceText = balanceLine(balance ?? profile?.balance ?? null);
  // 못 불러왔거나 아직 불러오는 중이면 '이름 없음·1,000P 드려요'라고 단정하지 않는다(규칙: myTabModel.profileCardState)
  const view = profileCardState({ hasProfile: profile !== null, status, stale });

  if (view === 'checking' || view === 'unreachable') {
    const line = view === 'checking' ? PROFILE_CHECKING : PROFILE_UNREACHABLE;
    return (
      <>
        <Card>
          <Text style={styles.label}>내 이름</Text>
          <Text style={[styles.value, styles.valueMuted]}>{line}</Text>
          {view === 'unreachable' ? <Text style={styles.caption}>{PROFILE_UNREACHABLE_HINT}</Text> : null}
        </Card>
        <Card>
          <Text style={styles.label}>내 포인트</Text>
          <Text style={[styles.value, styles.valueMuted]}>{line}</Text>
          {view === 'unreachable' ? (
            <PrimaryButton label="다시 불러오기" variant="ghost" onPress={() => void refresh()} />
          ) : null}
        </Card>
      </>
    );
  }

  return (
    <>
      <Card>
        <Text style={styles.label}>내 이름</Text>
        <Text style={[styles.value, !profile && styles.valueMuted]}>{nicknameLine(profile?.nickname)}</Text>
        <Text style={styles.caption}>약속에서 친구들에게 보이는 이름이에요</Text>
        <PrimaryButton label={profile ? '바꾸기' : '이름 정하기'} variant="ghost" onPress={() => router.push('/late/name')} />
      </Card>
      <Card>
        <Text style={styles.label}>내 포인트</Text>
        {balanceText !== null ? (
          <Text style={styles.value}>{balanceText}</Text>
        ) : (
          <Text style={styles.caption}>이름을 정하면 {START_BALANCE.toLocaleString('ko-KR')}P를 드려요</Text>
        )}
        <PrimaryButton label="포인트 내역" variant="ghost" onPress={() => router.push('/late/points')} />
      </Card>
    </>
  );
}

/** '권한' — 네이티브 ∧ 모드 on 일 때만 그려진다. 읽기만 한다 */
function PermissionsCard() {
  const [location, setLocation] = useState<LocationPermissionState | null>(null);
  const [notification, setNotification] = useState<NotificationPermission | null>(null);

  const read = useCallback(() => {
    void getLocationPermission()
      .then(setLocation)
      .catch(() => undefined);
    void getPermission()
      .then(setNotification)
      .catch(() => undefined);
  }, []);

  useFocusEffect(read);

  // 설정 앱에서 돌아오면 다시 읽는다
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') read();
    });
    return () => sub.remove();
  }, [read]);

  return (
    <Card>
      <Text style={styles.label}>권한</Text>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>위치</Text>
        <Text style={styles.rowValue}>{locationPermissionLabel(location)}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>알림</Text>
        <Text style={styles.rowValue}>{notificationPermissionLabel(notification)}</Text>
      </View>
      <Text style={styles.caption}>약속 장소 도착 확인과 약속 알림에 써요. 바꾸려면 설정에서 바꿔 주세요.</Text>
      <PrimaryButton label="설정 열기" variant="ghost" onPress={() => void openAppSettings().catch(() => false)} />
    </Card>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.subtext,
  },
  value: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
  },
  valueMuted: {
    color: colors.subtext,
  },
  caption: {
    fontSize: fontSize.sm,
    color: colors.subtext,
    lineHeight: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  rowLabel: {
    fontSize: fontSize.sm,
    color: colors.subtext,
  },
  rowValue: {
    flexShrink: 1,
    textAlign: 'right',
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.text,
  },
});
