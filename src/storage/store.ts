import AsyncStorage from '@react-native-async-storage/async-storage';

import { normalizeAppointment } from '@/domain/appointment';

import { pickStoredRaw } from './legacy';
import { BASE_CURRENCY } from '@/domain/currency';
import type { Item, Round, Session } from '@/domain/types';

const STORAGE_KEY = 'mokkoji.sessions.v1';
/** 이름을 바꾸기 전(엔빵·정산야호) 키. 새 키가 비었을 때만 읽어 옮긴다 — 쓰던 모임 기록이 사라지지 않게 */
const LEGACY_STORAGE_KEY = 'nbbang.sessions.v1';

/** 배열이 아니면(손상·구버전 데이터) 빈 배열로 취급해 화면 렌더 크래시를 막는다 */
function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * 구버전(통화 개념 이전)에 저장된 데이터를 현재 스키마로 정규화한다.
 * 필드가 없으면 KRW 지출로 취급 — 기존 정산 결과가 그대로 유지된다.
 */
export function normalizeSession(raw: Partial<Session> & { id: string }): Session {
  const rounds = asArray<Partial<Round> & { id: string }>(raw.rounds).map(
    (r: Partial<Round> & { id: string }): Round => ({
      id: r.id,
      title: r.title ?? '지출',
      kind: r.kind ?? 'etc',
      payerId: r.payerId ?? '',
      mode: r.mode ?? 'even',
      participantIds: asArray(r.participantIds),
      totalAmount: r.totalAmount ?? 0,
      items: asArray<Partial<Item> & { id: string }>(r.items).map((it) => ({
        id: it.id,
        name: it.name ?? '',
        unitPrice: it.unitPrice ?? 0,
        quantity: it.quantity ?? 1,
        eaterIds: asArray(it.eaterIds),
        betLoserId: it.betLoserId ?? null,
      })),
      exemptIds: asArray(r.exemptIds),
      currency: r.currency ?? BASE_CURRENCY,
      fxRate: r.fxRate ?? null,
      billedBaseAmount: r.billedBaseAmount ?? null,
      bet: r.bet ?? null,
    }),
  );
  return {
    id: raw.id,
    title: raw.title ?? '모임',
    createdAt: raw.createdAt ?? new Date(0).toISOString(),
    people: asArray(raw.people),
    rounds,
    settings: {
      roundingUnit: raw.settings?.roundingUnit ?? 100,
      baseCurrency: raw.settings?.baseCurrency ?? BASE_CURRENCY,
    },
    lastFxRates: raw.lastFxRates ?? {},
    bet: raw.bet ?? null,
    appointment: normalizeAppointment(raw.appointment),
    // 약속 내기에서 만든 세션만 갖는다. 없거나 문자열이 아니면 키 자체를 두지 않는다(기존 데이터 모양 그대로)
    ...(typeof raw.lateBetId === 'string' && raw.lateBetId !== '' ? { lateBetId: raw.lateBetId } : {}),
  };
}

/**
 * 저장소에서 읽은(JSON.parse된) 값을 세션 목록으로 정규화한다.
 * 레코드 단위로 격리해서, 손상된 레코드 하나가 나머지 세션까지 지우지 못하게 한다
 * — loadSessions가 []를 돌려주면 이후 디바운스 저장이 빈 목록을 덮어써
 * 멀쩡한 세션까지 영구히 사라지기 때문이다.
 */
export function normalizeStoredSessions(parsed: unknown): Session[] {
  if (!Array.isArray(parsed)) return [];
  const sessions: Session[] = [];
  for (const s of parsed) {
    if (!s || typeof (s as { id?: unknown }).id !== 'string') continue;
    try {
      sessions.push(normalizeSession(s as Partial<Session> & { id: string }));
    } catch {
      // 이 레코드만 건너뛰고 나머지는 살린다
    }
  }
  return sessions;
}

export async function loadSessions(): Promise<Session[]> {
  try {
    const { raw, migrated } = pickStoredRaw(
      await AsyncStorage.getItem(STORAGE_KEY),
      await AsyncStorage.getItem(LEGACY_STORAGE_KEY),
    );
    if (raw === null) return [];
    const sessions = normalizeStoredSessions(JSON.parse(raw));
    if (migrated && sessions.length > 0) await saveSessions(sessions);
    return sessions;
  } catch {
    return [];
  }
}

export async function saveSessions(sessions: Session[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // 저장 실패는 치명적이지 않다 — 다음 변경에서 재시도된다
  }
}
