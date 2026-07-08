import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { currencyInfo, formatMoney } from '@/domain/currency';
import { genId } from '@/domain/format';
import { parseReceipt } from '@/domain/receiptParse';
import type { Item } from '@/domain/types';
import { recognizeReceiptLines } from '@/services/receiptOcr';
import { useSessions } from '@/state/SessionsContext';
import {
  AmountField,
  Card,
  Chip,
  EmptyState,
  LoadingState,
  PrimaryButton,
  Row,
  Screen,
  TextField,
} from '@/ui/components';
import { colors, fontSize, spacing } from '@/ui/theme';

type Phase = 'pick' | 'busy' | 'review';

/** 검토 단계에서 편집하는 로컬 항목 (추가 전까지 세션에 저장되지 않는다) */
interface ScanItem {
  key: string;
  name: string;
  unitPrice: number;
  quantity: number;
  selected: boolean;
  suspicious: boolean;
}

export default function ReceiptScanScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; roundId: string }>();
  const { loading, getSession, updateSession } = useSessions();

  const [phase, setPhase] = React.useState<Phase>('pick');
  const [items, setItems] = React.useState<ScanItem[]>([]);
  const [detectedTotal, setDetectedTotal] = React.useState<number | null>(null);
  // 추가 버튼 이중 탭 가드: ref는 동기 차단용, state는 버튼 비활성 표시용
  const addingRef = React.useRef(false);
  const [adding, setAdding] = React.useState(false);

  const sessionId = typeof params.id === 'string' ? params.id : '';
  const roundId = typeof params.roundId === 'string' ? params.roundId : '';

  const session = sessionId ? getSession(sessionId) : undefined;
  const round = session?.rounds.find((r) => r.id === roundId);

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ title: '영수증 스캔' }} />
        <Screen scroll={false}>
          <LoadingState />
        </Screen>
      </>
    );
  }

  if (!session || !round) {
    return (
      <>
        <Stack.Screen options={{ title: '영수증 스캔' }} />
        <Screen scroll={false}>
          <EmptyState
            emoji="🔍"
            title="지출을 찾을 수 없어요"
            hint="모임 화면으로 돌아가서 다시 선택해 주세요."
          />
        </Screen>
      </>
    );
  }

  const decimals = currencyInfo(round.currency).decimals;
  const currencySuffix =
    round.currency === 'KRW' ? '원' : currencyInfo(round.currency).symbol;

  const runOcr = async (uri: string) => {
    setPhase('busy');
    try {
      const lines = await recognizeReceiptLines(uri, round.currency);
      const parsed = parseReceipt(lines, { decimals });
      setItems(
        parsed.items.map((it) => ({
          key: genId('scan'),
          name: it.name,
          unitPrice: it.unitPrice,
          quantity: it.quantity,
          selected: true,
          suspicious: it.suspicious,
        })),
      );
      setDetectedTotal(parsed.detectedTotal);
      setPhase('review');
    } catch {
      // ML Kit은 네이티브 모듈 — 웹·Expo Go에선 여기로 떨어진다
      Alert.alert(
        '인식에 실패했어요',
        '이 기기에서 문자 인식을 사용할 수 없거나 이미지를 읽지 못했어요',
      );
      setPhase('pick');
    }
  };

  const pickImage = async (source: 'camera' | 'album') => {
    try {
      if (source === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('카메라 권한이 필요해요', '설정에서 허용해주세요');
          return;
        }
      } else {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        // iOS '선택한 사진만' 모드는 granted=false여도 앨범을 열 수 있다
        if (!perm.granted && perm.accessPrivileges !== 'limited') {
          Alert.alert('앨범 접근 권한이 필요해요', '설정에서 허용해주세요');
          return;
        }
      }
      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({
              mediaTypes: ['images'],
              quality: 0.8,
            })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images'],
              quality: 0.8,
            });
      if (result.canceled) return;
      const uri = result.assets?.[0]?.uri;
      if (!uri) return;
      // runOcr는 내부에서 실패를 처리하므로 여기 catch는 픽커·권한 오류용
      await runOcr(uri);
    } catch {
      Alert.alert('사진을 가져오지 못했어요', '잠시 후 다시 시도해주세요');
      setPhase('pick');
    }
  };

  const patchScanItem = (key: string, patch: Partial<ScanItem>) => {
    setItems((prev) =>
      prev.map((it) => (it.key === key ? { ...it, ...patch } : it)),
    );
  };

  const resetToPick = () => {
    setItems([]);
    setDetectedTotal(null);
    setPhase('pick');
  };

  const selectedItems = items.filter((it) => it.selected);
  const selectedSum = selectedItems.reduce(
    (sum, it) => sum + it.unitPrice * it.quantity,
    0,
  );
  // 이름이 없거나 수량을 0으로 지운(=빼려는 의도) 항목은 추가하지 않는다 —
  // 검토 화면에서 확인한 합계와 실제 저장되는 합계가 어긋나지 않도록
  const addableItems = selectedItems.filter(
    (it) => it.name.trim().length > 0 && it.quantity > 0,
  );

  const factor = 10 ** decimals;
  const totalsMatch =
    detectedTotal != null &&
    Math.round(selectedSum * factor) === Math.round(detectedTotal * factor);

  const addSelectedItems = () => {
    // pop 애니메이션 중 두 번째 탭이 들어오면 항목이 통째로 두 번 추가되고
    // GO_BACK도 두 번 나가므로, 첫 탭 이후에는 무시한다
    if (addingRef.current) return;
    const newItems: Item[] = addableItems.map((it) => ({
      id: genId('i'),
      name: it.name.trim(),
      unitPrice: it.unitPrice,
      quantity: it.quantity,
      eaterIds: [],
    }));
    if (newItems.length === 0) return;
    addingRef.current = true;
    setAdding(true);
    // even 모드였어도 추가한 항목이 바로 보이도록 mode 전환을 같은 업데이트에 담는다
    updateSession(sessionId, (s) => ({
      ...s,
      rounds: s.rounds.map((r) =>
        r.id === roundId
          ? { ...r, mode: 'itemized' as const, items: [...r.items, ...newItems] }
          : r,
      ),
    }));
    router.back();
  };

  return (
    <>
      <Stack.Screen options={{ title: '영수증 스캔' }} />
      {phase === 'pick' ? (
        <Screen>
          <Card style={{ gap: spacing.sm }}>
            <Text style={styles.guideEmoji}>🧾</Text>
            <Text style={styles.guideTitle}>
              영수증을 찍으면 항목을 자동으로 읽어요
            </Text>
            <Text style={styles.guideHint}>
              사진은 기기 안에서만 처리되고 밖으로 나가지 않아요
            </Text>
          </Card>
          <PrimaryButton label="📷 촬영하기" onPress={() => pickImage('camera')} />
          <PrimaryButton
            label="🖼 앨범에서 선택"
            variant="ghost"
            onPress={() => pickImage('album')}
          />
        </Screen>
      ) : phase === 'busy' ? (
        <Screen scroll={false}>
          <View style={styles.busyWrap}>
            <LoadingState />
            <Text style={styles.busyText}>영수증을 읽는 중...</Text>
          </View>
        </Screen>
      ) : items.length === 0 ? (
        <Screen
          scroll={false}
          footer={<PrimaryButton label="다시 찍기" onPress={resetToPick} />}
        >
          <EmptyState
            emoji="🧾"
            title="항목을 찾지 못했어요"
            hint="영수증이 잘 보이게 다시 찍어주세요"
          />
        </Screen>
      ) : (
        <Screen
          footer={
            <>
              <PrimaryButton
                label={`${addableItems.length}개 항목 추가`}
                onPress={addSelectedItems}
                disabled={adding || addableItems.length === 0}
              />
              <PrimaryButton
                label="다시 찍기"
                variant="ghost"
                onPress={resetToPick}
              />
            </>
          }
        >
          <Card>
            <Text style={styles.summaryMain}>
              선택 {selectedItems.length}개 · 합계{' '}
              {formatMoney(selectedSum, round.currency)}
            </Text>
            {detectedTotal != null ? (
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.summarySub}>
                  영수증 합계 {formatMoney(detectedTotal, round.currency)}
                </Text>
                {totalsMatch ? (
                  <Text style={styles.matchOk}>✓ 일치</Text>
                ) : (
                  <Text style={styles.matchBad}>
                    ⚠️ 합계와 달라요 — 항목을 확인해주세요
                  </Text>
                )}
              </Row>
            ) : null}
          </Card>

          {items.map((item) => (
            <Card key={item.key} style={{ gap: spacing.sm }}>
              <Row>
                <Chip
                  label="✓"
                  selected={item.selected}
                  onPress={() =>
                    patchScanItem(item.key, { selected: !item.selected })
                  }
                />
                <View style={{ flex: 1 }}>
                  <TextField
                    value={item.name}
                    onChangeText={(t) => patchScanItem(item.key, { name: t })}
                    placeholder="메뉴 이름"
                  />
                </View>
              </Row>
              <Row>
                <View style={{ flex: 2 }}>
                  <AmountField
                    label="단가"
                    value={item.unitPrice}
                    onChangeValue={(v) =>
                      patchScanItem(item.key, { unitPrice: v })
                    }
                    decimals={decimals}
                    suffix={currencySuffix}
                    placeholder="0"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <AmountField
                    label="수량"
                    value={item.quantity}
                    onChangeValue={(v) =>
                      patchScanItem(item.key, { quantity: v })
                    }
                    decimals={0}
                    placeholder="0"
                  />
                </View>
              </Row>
              {item.suspicious ? (
                <Text style={styles.suspicious}>⚠️ 확인 필요</Text>
              ) : null}
            </Card>
          ))}
        </Screen>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  guideEmoji: {
    fontSize: 40,
    textAlign: 'center',
  },
  guideTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  guideHint: {
    fontSize: fontSize.xs,
    color: colors.subtext,
    textAlign: 'center',
  },
  busyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  busyText: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.subtext,
  },
  summaryMain: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
  },
  summarySub: {
    fontSize: fontSize.sm,
    color: colors.subtext,
  },
  matchOk: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.success,
  },
  matchBad: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    color: colors.danger,
    flexShrink: 1,
  },
  suspicious: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    color: colors.danger,
  },
});
