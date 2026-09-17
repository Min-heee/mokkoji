import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { serverClock } from './serverClock';

/**
 * 주기적으로 갱신되는 '서버 기준 지금'(표시 전용). 카운트다운·손실 티커는 1000, 목록의 "N분 뒤"는 30000.
 * 오프셋이 바뀌거나(새 응답·가짜 서버 빨리 감기) 앱이 앞으로 돌아오면 즉시 다시 맞춘다.
 * 1초 티커는 그 숫자를 그리는 작은 컴포넌트 안에서만 써라 — 화면 전체가 매초 다시 그려지지 않게.
 */
export function useServerNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => serverClock.now());

  useEffect(() => {
    const tick = () => setNow(serverClock.now());
    tick();
    const timer = setInterval(tick, intervalMs);
    const off = serverClock.subscribe(tick);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') tick();
    });
    return () => {
      clearInterval(timer);
      off();
      sub.remove();
    };
  }, [intervalMs]);

  return now;
}
