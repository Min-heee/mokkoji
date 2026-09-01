import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * 주기적으로 갱신되는 '지금'.
 *
 * 렌더 중에 Date.now()를 부르면 그 값이 화면에 얼어붙는다 — 홈은 라우터 루트라
 * 계속 마운트된 채 있어서, 19:29에 '1분 뒤'로 그린 카드가 20:30에도 '1분 뒤'다
 * (카운트다운도, '지남' 색도, 정렬 순서도 그대로).
 * 화면이 다시 앞으로 올 때(백그라운드 복귀)도 즉시 맞춘다.
 */
export function useNow(intervalMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, intervalMs);
    // 백그라운드에서는 타이머가 멈추거나 느려지므로 복귀 시 한 번 더 맞춘다
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') tick();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [intervalMs]);

  return now;
}
