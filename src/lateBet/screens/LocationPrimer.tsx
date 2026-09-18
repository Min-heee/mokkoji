/**
 * 위치 권한 사전 안내 (설계서 §5.3-E, §0-1 규칙 4·5) — 참여 직후 1회, OS 프롬프트 전에. 담당: [join]
 *
 * 부모(app/j/[code].tsx)의 <Screen> 안에 들어가는 덩어리다. 버튼 두 개를 직접 그린다.
 * 위치 공개 시점 설정은 없다 — 공개는 주최자가 [시작하기]를 누르는 순간부터다. 이미 시작한 약속에 들어온 직후에도 뜨므로
 * 첫 줄은 시제를 타지 않게 "주최자가 시작한 뒤부터…" 로 적는다("주최자가 시작하면 서로 위치가 보여요" 는 부모의 참여 화면·카드가 말한다).
 * - [위치 허용하기] → onAllow: 부모가 OS 권한을 요청하고(P0 에서는 요청 없이) 약속 화면으로 넘긴다
 * - [나중에] → onLater: 그대로 약속 화면으로. 거부해도 참여는 된다(§3.2-5)
 * 이미 거부했거나(denied) 대략적 위치만 허용한(coarse) 경우 OS 프롬프트가 다시 뜨지 않으므로 [설정 열기]로 바꾼다(§5.4 문구).
 *
 * P1 네이티브: [위치 허용하기]를 누르면 이 컴포넌트가 먼저 OS 권한을 요청한다(permissions 모듈 — expo-location).
 * - 허용(정확·대략) → onAllow() — 부모가 이어서 약속 화면으로 넘긴다(부모의 요청은 이미 허용이라 프롬프트가 다시 뜨지 않는다)
 * - 거부(다시 물을 수 있음) → 제자리에서 거부 안내 + [다시 허용하기]/[나중에]
 * - 영구 거부(다시 물을 수 없음) → [설정 열기] → 설정에서 돌아오면 권한을 다시 읽고, 허용됐으면 onAllow()
 * 웹(앱인토스 포함)은 위치를 쓰지 않으므로 기존 흐름 그대로 onAllow() 만 부른다.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '@/ui/components';
import { colors, fontSize, spacing } from '@/ui/theme';

import { toReporterPermission, type LocationPermissionState } from '../permissionRule';
import { getLocationPermission, openAppSettings, requestLocationPermission } from '../permissions';
import type { LocationPermission } from '../useArrivalReporter';
import type { LocationPrimerProps } from './props';

const NATIVE = Platform.OS !== 'web';

export function LocationPrimer({ onAllow, onLater, busy: parentBusy, permission: given }: LocationPrimerProps) {
  // 네이티브에서 이 화면이 직접 요청·확인한 결과(없으면 부모가 준 permission 을 쓴다)
  const [own, setOwn] = useState<LocationPermissionState | null>(null);
  const [asking, setAsking] = useState(false);
  const wentToSettings = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // 지금 상태를 읽어 둔다(묻지 않는다) — 거부/영구 거부에 맞는 버튼을 고르기 위해
  useEffect(() => {
    if (!NATIVE) return;
    void getLocationPermission().then((next) => {
      if (alive.current && next.status !== 'unavailable') setOwn((cur) => cur ?? next);
    });
  }, []);

  // 설정 앱에서 돌아오면 권한을 다시 읽는다. 허용됐으면 바로 다음으로
  useEffect(() => {
    if (!NATIVE) return undefined;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !wentToSettings.current) return;
      wentToSettings.current = false;
      void getLocationPermission().then((next) => {
        if (!alive.current) return;
        setOwn(next);
        if (next.status === 'granted') onAllow();
      });
    });
    return () => sub.remove();
  }, [onAllow]);

  const permission: LocationPermission | undefined = own ? toReporterPermission(own) : given;
  const blocked = own ? own.status === 'blocked' : given === 'denied' || given === 'coarse';
  const busy = parentBusy || asking;

  const allow = useCallback(async () => {
    if (!NATIVE) {
      onAllow();
      return;
    }
    setAsking(true);
    try {
      const current = own ?? (await getLocationPermission());
      if (current.status === 'unavailable') {
        onAllow();
        return;
      }
      // 이미 허용(대략적 위치만 포함) 또는 다시 물을 수 없음 → 설정으로(대략적이면 '정확한 위치'를 켜러)
      if (current.status === 'blocked' || (current.status === 'granted' && current.precise === false)) {
        wentToSettings.current = true;
        const opened = await openAppSettings();
        if (!opened) wentToSettings.current = false;
        if (alive.current) setOwn(current);
        return;
      }
      if (current.status === 'granted') {
        onAllow();
        return;
      }
      const next = await requestLocationPermission();
      if (!alive.current) return;
      setOwn(next);
      if (next.status === 'granted') onAllow();
    } finally {
      if (alive.current) setAsking(false);
    }
  }, [onAllow, own]);

  const bullets = [
    '주최자가 시작한 뒤부터 도착할 때까지, 앱을 켜 둔 동안만 위치를 공유해요',
    '앱을 닫으면 몇 분 안에 친구 화면에서 사라져요',
    '도착하면 공유가 바로 끝나요. 약속 화면에서 언제든 끌 수 있어요',
  ];

  // OS 프롬프트를 다시 띄울 수 없는 상태 → 설정으로 보낸다
  const needsSettings = blocked || permission === 'coarse';
  const deniedOnce = permission === 'denied' && !needsSettings;
  const unsupported = permission === 'unsupported';
  const notice =
    permission === 'denied'
      ? '위치가 꺼져 있어 도착을 자동으로 확인할 수 없어요'
      : permission === 'coarse'
        ? "대략적인 위치만 허용돼 있어요. 설정에서 '정확한 위치'를 켜주세요."
        : unsupported
          ? '이 기기에서는 위치로 도착을 확인할 수 없어요'
          : null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>도착을 확인하려면 위치가 필요해요</Text>
      <View style={styles.bullets}>
        {bullets.map((line) => (
          <View key={line} style={styles.bulletRow}>
            <Text style={styles.bulletDot}>·</Text>
            <Text style={styles.bulletText}>{line}</Text>
          </View>
        ))}
      </View>
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      <Text style={styles.foot}>{"허용하지 않아도 참여는 돼요. 그때는 먼저 도착한 친구에게 '같이 있어요'를 눌러달라고 하세요."}</Text>
      <View style={styles.buttons}>
        {unsupported ? null : (
          <PrimaryButton
            label={needsSettings ? '설정 열기' : deniedOnce ? '다시 허용하기' : '위치 허용하기'}
            onPress={() => void allow()}
            disabled={busy}
          />
        )}
        <PrimaryButton label={unsupported ? '계속' : '나중에'} variant="ghost" onPress={onLater} disabled={busy} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  title: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  bullets: { gap: spacing.sm },
  bulletRow: { flexDirection: 'row', gap: spacing.sm },
  bulletDot: { fontSize: fontSize.md, fontWeight: '700', color: colors.text, lineHeight: 22 },
  bulletText: { flex: 1, fontSize: fontSize.md, color: colors.text, lineHeight: 22 },
  notice: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text, lineHeight: 20 },
  foot: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  buttons: { gap: spacing.sm, marginTop: spacing.sm },
});
