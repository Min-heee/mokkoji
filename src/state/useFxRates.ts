import { useCallback, useEffect, useRef, useState } from 'react';

import { getFxRates, type FxResult } from '@/services/fxRates';

export interface FxRatesApi {
  /** null이면 아직 로딩 전이거나 캐시조차 없는 상태 */
  result: FxResult | null;
  loading: boolean;
  /** 강제 새로고침 (네트워크 재시도) */
  refresh(): void;
  /** 1 <code> = ?원. 모르면 null */
  rateFor(code: string): number | null;
}

/** 실시간 환율 훅. 마운트 시 캐시→네트워크 순으로 채운다 */
export function useFxRates(): FxRatesApi {
  const [result, setResult] = useState<FxResult | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const load = useCallback((forceRefresh: boolean) => {
    setLoading(true);
    getFxRates({ forceRefresh })
      .then((r) => {
        if (!alive.current) return;
        setResult(r);
        setLoading(false);
      })
      .catch(() => {
        if (!alive.current) return;
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    alive.current = true;
    load(false);
    return () => {
      alive.current = false;
    };
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  const rateFor = useCallback(
    (code: string): number | null => result?.snapshot?.rates[code] ?? null,
    [result],
  );

  return { result, loading, refresh, rateFor };
}
