import { Alert, Platform } from 'react-native';

/**
 * 크로스 플랫폼 다이얼로그.
 * RN의 Alert.alert는 웹(react-native-web)에서 무동작이라, 앱인토스(토스 웹뷰)와
 * 웹 타깃에서는 window.confirm/alert로 대체한다. 네이티브는 기존 Alert 그대로.
 */

export interface ConfirmOptions {
  /** 확인 버튼 라벨 (기본 '확인') */
  confirmText?: string;
  /** 파괴적 동작(삭제 등)이면 네이티브에서 destructive 스타일 */
  destructive?: boolean;
}

/** 확인/취소 다이얼로그. 확인을 누르면 onConfirm 실행 */
export function confirmDialog(
  title: string,
  message: string,
  onConfirm: () => void,
  options?: ConfirmOptions,
): void {
  const confirmText = options?.confirmText ?? '확인';
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: '취소', style: 'cancel' },
    {
      text: confirmText,
      style: options?.destructive ? 'destructive' : 'default',
      onPress: onConfirm,
    },
  ]);
}

/** 단순 알림 다이얼로그 */
export function alertDialog(title: string, message?: string): void {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    window.alert(message ? `${title}\n\n${message}` : title);
    return;
  }
  Alert.alert(title, message);
}
