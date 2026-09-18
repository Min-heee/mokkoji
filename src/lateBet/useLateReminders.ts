/**
 * 약속 화면의 로컬 알림 — app/late/[id]/index.tsx 가 돌린다(모드 off 면 그 화면 자체가 없다).
 *
 * - lb_get_live 응답이 올 때마다 계획(reminderPlan.planForLive)을 다시 짜고, 지난번과 다를 때만 syncReminders.
 *   계획 시각은 서버 시계 → toDeviceFrame 으로 기기 시계로 옮겨 예약한다(가짜 서버 빨리 감기에도 맞게).
 * - 도착·취소·정산은 계획이 비어 자동으로 취소된다. 내보내지면(removed) cancelAll.
 * - '알림 켜기' 1회 안내: 권한이 아직 정해지지 않았고(undetermined) 예약할 알림이 있고 전에 안내한 적 없을 때만.
 *   [알림 켜기] → 채널 → OS 프롬프트. [괜찮아요] → 다시 묻지 않는다(설정에서 켤 수 있다).
 *   OS 프롬프트는 여기서만 띄운다(참여·생성 직후에는 위치 권한 안내가 먼저라 겹치지 않게).
 * - 웹은 NOTIFICATIONS_SUPPORTED=false 라 아무것도 하지 않는다(스토리지도 안 읽는다).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { cancelAll, getPermission, NOTIFICATIONS_SUPPORTED, requestPermission, syncReminders } from './notifications';
import { planForLive, sameReminderPlan, toDeviceFrame, type NotificationPermission, type ReminderItem } from './reminderPlan';
import { serverClock } from './serverClock';
import type { LbLive } from './types';

/** '알림 켜기' 안내를 한 번 보였다(앱 전체에서 1회) */
const PROMPT_KEY = 'yaho.late.notifyPrompt.v1';

/**
 * 계획이 그대로여도 이 간격마다 한 번은 OS 예약을 다시 맞춘다 — 홈 새로고침의 정리(pruneReminders)가
 * 방금 만든·들어온 약속을 옛 목록으로 보고 거둔 경우 같은 어긋남을 이 화면에 있는 동안 스스로 고친다.
 */
const RESYNC_MS = 60_000;

export interface NotifyPrompt {
  /** '알림 켜기' 카드를 그린다 */
  visible: boolean;
  /** OS 프롬프트가 떠 있는 중 */
  busy: boolean;
  /** [알림 켜기] */
  enable: () => void;
  /** [괜찮아요] */
  dismiss: () => void;
}

interface Synced {
  appointmentId: string;
  permission: NotificationPermission;
  items: ReminderItem[];
  /** 기기 시각 */
  atMs: number;
}

export function useLateReminders(appointmentId: string | null, live: LbLive | null, removed: boolean): NotifyPrompt {
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  /** null = 아직 저장소를 못 읽었다(깜빡임 방지로 그동안은 안 그린다) */
  const [prompted, setPrompted] = useState<boolean | null>(null);
  const [hasPlan, setHasPlan] = useState(false);
  const [busy, setBusy] = useState(false);
  const last = useRef<Synced | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // 권한: 처음 + 앱이 앞으로 올 때마다(설정 앱에서 바꾸고 돌아올 수 있다)
  useEffect(() => {
    if (!NOTIFICATIONS_SUPPORTED) return;
    const read = () => {
      void getPermission().then((p) => {
        if (alive.current) setPermission(p);
      });
    };
    read();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') read();
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!NOTIFICATIONS_SUPPORTED) return;
    AsyncStorage.getItem(PROMPT_KEY).then(
      (v) => {
        if (alive.current) setPrompted(v === '1');
      },
      () => {
        if (alive.current) setPrompted(false);
      },
    );
  }, []);

  // 응답마다 계획 → 바뀌었을 때만 OS 예약을 맞춘다
  useEffect(() => {
    if (!NOTIFICATIONS_SUPPORTED || !live || permission === null || removed) return;
    const id = live.appointment.id;
    const plan = toDeviceFrame(planForLive(live, serverClock.now()), serverClock.offsetMs());
    setHasPlan(plan.length > 0);
    const prev = last.current;
    const now = Date.now();
    if (
      prev &&
      prev.appointmentId === id &&
      prev.permission === permission &&
      now - prev.atMs < RESYNC_MS &&
      sameReminderPlan(prev.items, plan)
    ) {
      return;
    }
    const mine: Synced = { appointmentId: id, permission, items: plan, atMs: now };
    last.current = mine;
    void syncReminders(id, plan).then(
      (res) => {
        // 일부 실패면 다음 응답 때 다시 맞춘다
        if (res.failed && last.current === mine) last.current = null;
      },
      () => {
        if (last.current === mine) last.current = null;
      },
    );
  }, [live, permission, removed]);

  // 내보내졌다 → 이 약속 알림 전부 취소
  useEffect(() => {
    if (!NOTIFICATIONS_SUPPORTED || !removed || !appointmentId) return;
    last.current = null;
    void cancelAll(appointmentId);
  }, [removed, appointmentId]);

  const remember = useCallback(() => {
    setPrompted(true);
    AsyncStorage.setItem(PROMPT_KEY, '1').catch(() => undefined);
  }, []);

  const enable = useCallback(() => {
    if (busy) return;
    setBusy(true);
    void requestPermission()
      .then((p) => {
        if (!alive.current) return;
        setPermission(p);
      })
      .finally(() => {
        if (!alive.current) return;
        remember();
        setBusy(false);
      });
  }, [busy, remember]);

  const visible =
    NOTIFICATIONS_SUPPORTED && permission === 'undetermined' && prompted === false && hasPlan && !removed && live !== null;

  return { visible, busy, enable, dismiss: remember };
}
