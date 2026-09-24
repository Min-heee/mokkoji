import { useHeaderHeight } from '@react-navigation/elements';
import React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { parseMoneyText, sanitizeAmountText } from '@/domain/currency';

import { colors, fontSize, radius, spacing } from './theme';

export function Screen({
  children,
  scroll = true,
  footer,
  tightBottom,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  footer?: React.ReactNode;
  /**
   * 본문 아래 여백을 줄인다(48 → 16). 스크롤 없이 화면을 채우는 본문(지도 등)에서 — 스크롤 끝 여백이 필요 없고,
   * 키보드가 올라와 본문이 줄 때 그만큼 지도·칩 자리가 남는다
   */
  tightBottom?: boolean;
}) {
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  return (
    // 키보드가 열리면 padding으로 밀어 올려 포커스된 입력과 footer 버튼이
    // 가려지지 않게 한다. Android도 edge-to-edge(app.json edgeToEdgeEnabled)
    // 에서는 adjustResize가 동작하지 않으므로 iOS와 같은 padding 방식을 쓴다.
    <KeyboardAvoidingView
      style={styles.screen}
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
    >
      {scroll ? (
        <ScrollView
          contentContainerStyle={styles.screenContent}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.screenContent, { flex: 1 }, tightBottom && { paddingBottom: spacing.lg }]}>{children}</View>
      )}
      {footer ? (
        <View
          style={[
            styles.footer,
            { paddingBottom: Math.max(spacing.xl, insets.bottom + spacing.sm) },
          ]}
        >
          {footer}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

export function Card({
  children,
  onPress,
  onLongPress,
  style,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  if (!onPress && !onLongPress) {
    return <View style={[styles.card, style]}>{children}</View>;
  }
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }, style]}
    >
      {children}
    </Pressable>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Row({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  variant = 'primary',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'ghost' | 'danger';
}) {
  const base =
    variant === 'primary'
      ? styles.buttonPrimary
      : variant === 'danger'
        ? styles.buttonDanger
        : styles.buttonGhost;
  const labelStyle =
    variant === 'primary'
      ? styles.buttonPrimaryLabel
      : variant === 'danger'
        ? styles.buttonDangerLabel
        : styles.buttonGhostLabel;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.buttonBase,
        base,
        disabled && { opacity: 0.4 },
        pressed && !disabled && { opacity: 0.75 },
      ]}
    >
      <Text style={labelStyle}>{label}</Text>
    </Pressable>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  disabled,
}: {
  label: string;
  selected: boolean;
  onPress?: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        disabled && { opacity: 0.4 },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoFocus,
  onSubmitEditing,
  suffix,
  keepFocusOnSubmit,
}: {
  label?: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  keyboardType?: KeyboardTypeOptions;
  autoFocus?: boolean;
  onSubmitEditing?: () => void;
  suffix?: string;
  /** 리턴 키로 제출해도 키보드를 닫지 않는다 (연속 입력용) */
  keepFocusOnSubmit?: boolean;
}) {
  return (
    <View style={{ gap: spacing.xs }}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <View style={styles.inputWrap}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.subtext}
          keyboardType={keyboardType}
          autoFocus={autoFocus}
          onSubmitEditing={onSubmitEditing}
          submitBehavior={keepFocusOnSubmit ? 'submit' : undefined}
        />
        {suffix ? <Text style={styles.inputSuffix}>{suffix}</Text> : null}
      </View>
    </View>
  );
}

/**
 * 금액 입력 필드. 내부에 입력 텍스트 상태를 따로 들고 있어
 * "4." 같은 소수점 입력 중 상태와 선행 0 입력이 자연스럽게 동작한다.
 * decimals=0이면 정수(원화)만, >0이면 해당 자리까지 소수 허용.
 */
export function AmountField({
  label,
  value,
  onChangeValue,
  decimals = 0,
  suffix,
  placeholder,
}: {
  label?: string;
  value: number;
  onChangeValue: (value: number) => void;
  decimals?: number;
  suffix?: string;
  placeholder?: string;
}) {
  const [text, setText] = React.useState(value > 0 ? String(value) : '');

  // 외부에서 값이 바뀐 경우(다른 경로의 수정)에만 텍스트를 재동기화한다
  React.useEffect(() => {
    const parsed = parseMoneyText(text);
    if (Math.abs(parsed - value) > 1e-9) {
      setText(value > 0 ? String(value) : '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // 정수 필드로 바뀌면(외화→KRW 전환 등) 남아 있던 소수 값·텍스트를 정리해
  // 다음 키 입력에서 "4.5"가 "45x"로 붙는 왜곡을 막는다
  React.useEffect(() => {
    if (decimals === 0 && !Number.isInteger(value)) {
      const rounded = Math.round(value);
      onChangeValue(rounded);
      setText(rounded > 0 ? String(rounded) : '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decimals]);

  const handleChange = (t: string) => {
    const cleaned = sanitizeAmountText(t, decimals);
    setText(cleaned);
    onChangeValue(parseMoneyText(cleaned));
  };

  return (
    <TextField
      label={label}
      value={text}
      onChangeText={handleChange}
      placeholder={placeholder ?? '0'}
      keyboardType={decimals > 0 ? 'decimal-pad' : 'number-pad'}
      suffix={suffix}
    />
  );
}

export function EmptyState({
  title,
  hint,
}: {
  /** @deprecated 이모지는 더 이상 표시하지 않는다 (미니멀). 호출부 호환용 */
  emoji?: string;
  title: string;
  hint?: string;
}) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {hint ? <Text style={styles.emptyHint}>{hint}</Text> : null}
    </View>
  );
}

export function LoadingState() {
  return (
    <View style={styles.empty}>
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  screenContent: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xl * 2,
  },
  footer: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: spacing.sm,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  sectionTitle: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.subtext,
    marginTop: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  buttonBase: {
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPrimary: {
    backgroundColor: colors.primary,
  },
  buttonPrimaryLabel: {
    color: colors.onPrimary,
    fontSize: fontSize.md,
    fontWeight: '800',
  },
  buttonGhost: {
    backgroundColor: colors.primaryDim,
  },
  buttonGhostLabel: {
    color: colors.primary,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  buttonDanger: {
    backgroundColor: colors.dangerDim,
  },
  buttonDangerLabel: {
    color: colors.danger,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  chip: {
    borderRadius: radius.pill,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipLabel: {
    fontSize: fontSize.sm,
    color: colors.text,
    fontWeight: '600',
  },
  chipLabelSelected: {
    color: colors.onPrimary,
    fontWeight: '800',
  },
  fieldLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.subtext,
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
  },
  input: {
    flex: 1,
    paddingVertical: 12,
    fontSize: fontSize.md,
    color: colors.text,
  },
  inputSuffix: {
    fontSize: fontSize.md,
    color: colors.subtext,
    marginLeft: spacing.xs,
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl * 2,
    gap: spacing.sm,
  },
  emptyEmoji: {
    fontSize: 40,
  },
  emptyTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
  },
  emptyHint: {
    fontSize: fontSize.sm,
    color: colors.subtext,
    textAlign: 'center',
  },
});
