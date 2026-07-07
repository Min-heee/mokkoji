import { useHeaderHeight } from '@react-navigation/elements';
import React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
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

import { colors, fontSize, radius, spacing } from './theme';

export function Screen({
  children,
  scroll = true,
  footer,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  footer?: React.ReactNode;
}) {
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  return (
    // iOS는 키보드가 화면을 리사이즈하지 않으므로 padding으로 밀어 올려
    // 포커스된 입력과 footer 버튼이 가려지지 않게 한다.
    // Android는 adjustResize가 처리하므로 behavior 없이 일반 View처럼 동작.
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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
        <View style={[styles.screenContent, { flex: 1 }]}>{children}</View>
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

export function EmptyState({
  emoji,
  title,
  hint,
}: {
  emoji: string;
  title: string;
  hint?: string;
}) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyEmoji}>{emoji}</Text>
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
    color: '#FFFFFF',
    fontSize: fontSize.md,
    fontWeight: '700',
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
    backgroundColor: colors.card,
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
    color: '#FFFFFF',
  },
  fieldLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.subtext,
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
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
