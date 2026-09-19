/**
 * 약속 잡기 (설계서 §5.3-B + §0-1 규칙 4·5·7). 담당: [create]
 *
 * 쿼리
 * - (없음)      새 약속. 제목 → 초대할 친구(InviteeEditor) → 날짜·시간(+시간대 라벨) → 장소 이름·메모 → [지도에서 위치 정하기]
 *               → 걸 포인트 → 늦으면(프리셋) → 봐주는 시간 → 도착 인정 거리 → 동의 2개 → [약속 만들기]
 * - ?from=<id>  그 약속(보통 취소한 것)의 값으로 폼을 채운 새 약속. 읽지 못하면 빈 폼.
 * - ?edit=<id>  주최자의 조건 변경. 시작 전에는 전부(명단 편집은 api.editInvitees 로 즉시), 시작 후에는
 *               시간 뒤로 미루기·장소만 — 동결된 항목은 비활성 + 이유(LB_EDIT_FROZEN 문구). 제목·메모는 updateMemo.
 *
 * 공정성 규칙(오너 결정 2026-09-19, src/domain/lateEditRules — 최종 판정은 서버)
 * - R1 시작 후 미루기: 지금 약속 시각 전에만, 시작하던 순간의 약속 시각 + 3시간까지(누적). 남은 한도를 보여 준다.
 * - R2 시작 후 장소: 시작하던 순간의 핀에서 500m 안(누적). 위치 정하기 화면에 한도를 넘긴다(draft.limit).
 * - R3 시작 전, 친구가 들어와 있을 때 시각·시간대·핀·정책을 바꾸면 5분 동안 [시작하기]가 막힌다 → 저장 전에 한 번 묻는다.
 *
 * 규칙
 * - '위치 공개 시점' 입력은 없다. 위치는 대기실에서 주최자가 [시작하기]를 누르는 순간부터 보인다(폼은 그 사실만 안내한다).
 * - 좌표가 없으면 만들기 버튼 비활성: "장소 위치를 정해야 도착을 확인할 수 있어요". 핀은 late/place 와 모듈 메모리로 주고받는다.
 * - 각 선택 아래 describePolicy 문장. 반경 50m 이하 경고. 정책은 validatePolicy(서버 CHECK 와 같은 식)를 통과해야 보낸다.
 * - 시간대 시트: needsTzChoice(기기 tz, 핀) 이거나 서버가 LB_TZ_SUSPECT 를 던지면 → 고른 tz + tzConfirmed=true 로 다시 보낸다.
 * - 시각 비교는 서버 시계(useServerNow)로. Date.now() 를 쓰지 않는다.
 * - Alert.alert 금지(confirmDialog/alertDialog), 이모지 금지, 새 색 금지(잃는 포인트만 colors.danger).
 */
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { appointmentInputHint, parseAppointmentInput } from '@/domain/appointment';
import type { LatePolicy } from '@/domain/lateBet';
import {
  DEFAULT_PRESET_ID,
  describePolicy,
  formatLoss,
  GRACE_CHOICES,
  LATE_PRESETS,
  matchPreset,
  POLICY_LIMITS,
  policyWithStake,
  RADIUS_CHOICES,
  SMALL_RADIUS_WARN_M,
  STAKE_CHOICES,
  validatePolicy,
  type LatePresetId,
} from '@/domain/latePresets';
import {
  formatFromNow,
  formatKoreanDateTime,
  needsTzChoice,
  SEOUL_TZ,
  tzChoices,
  tzLabel,
  wallClockToMs,
} from '@/domain/tzGuard';
import {
  errorMessage,
  isConnectivityError,
  isTzSuspectError,
  LateBetError,
  RAISE_STAKE_INSUFFICIENT_MESSAGE,
  REPEATED_FAILURE_MESSAGE,
  toLateBetError,
} from '@/lateBet/errors';
import {
  canMovePlace,
  canPostpone,
  MOVE_AFTER_START_MAX_M,
  postponeLimitMs,
  postponeRemainingMinutes,
  START_COOLDOWN_MS,
} from '@/domain/lateEditRules';
import { useLateBet } from '@/lateBet/LateBetContext';
import { readDeviceTz } from '@/lateBet/deviceTz';
import { markSeenVersion } from '@/lateBet/useLive';
import { FakeDevPanel } from '@/lateBet/screens/FakeDevPanel';
import { InviteeEditor, inviteeNameIssue } from '@/lateBet/screens/InviteeEditor';
import { LateBetUnavailable, NicknameGate } from '@/lateBet/screens/NicknameGate';
import { newRequestId } from '@/lateBet/requestId';
import type { LbAppointment, LbCreateInput, LbEditPatch, LbLive } from '@/lateBet/types';
import { useServerNow } from '@/lateBet/useServerNow';
import { Card, Chip, EmptyState, LoadingState, PrimaryButton, Row, Screen, SectionTitle, TextField } from '@/ui/components';
import { confirmDialog } from '@/ui/dialogs';
import { MapPane } from '@/ui/MapPane';
import { openPlaceDraft, takePlaceResult, type PlacePickerValue } from '@/ui/PlacePicker';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

const MIN = 60_000;
/** 서버 lb_resolve_meet 와 같은 한계 — 미리 걸러 왕복을 아낀다(최종 판정은 서버) */
const MIN_LEAD_MS = 5 * MIN;
const MAX_LEAD_MS = 90 * 24 * 60 * MIN;
const TITLE_MAX = 40;
const PLACE_NAME_MAX = 60;
const PLACE_NOTE_MAX = 200;

const START_NOTICE =
  '만든 뒤 대기실에서 [시작하기]를 누르면 그때부터 서로 위치가 보여요. 친구는 초대 링크를 열고 명단에서 자기 이름을 골라 들어와요.';
const PIN_REQUIRED = '장소 위치를 정해야 도착을 확인할 수 있어요';
const SMALL_RADIUS_WARNING = '지하·실내는 GPS가 잘 안 잡혀요. 100m를 권해요';
const CONSENT_LOCATION =
  '내가 [시작하기]를 누른 뒤부터 도착할 때까지, 앱을 켜 둔 동안 내 위치를 같은 약속의 친구들에게 보여 주는 데 동의해요';
const CONSENT_AGE = '만 14세 이상이에요';

const charLen = (s: string) => Array.from(s).length;

/** '19:30' → '오후 7:30' (시트의 "약속 시각 '오후 7:30'은 어느 시각인가요?"). 형식이 아니면 그대로 */
function koreanClock(timeText: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(timeText.trim());
  if (!m) return timeText.trim();
  const h = Number(m[1]);
  if (h > 23) return timeText.trim();
  return `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}:${m[2]}`;
}

const samePolicy = (a: LatePolicy, b: LatePolicy) =>
  a.stake === b.stake &&
  a.radiusM === b.radiusM &&
  a.unitMinutes === b.unitMinutes &&
  a.penaltyPerUnit === b.penaltyPerUnit &&
  a.graceMinutes === b.graceMinutes;

// ───────────────────────── 진입: 모드 판별·불러오기 ─────────────────────────

export default function NewLateAppointmentScreen() {
  const { enabled } = useLateBet();
  if (!enabled) return <LateBetUnavailable />;
  return (
    <NicknameGate>
      <Loader />
    </NicknameGate>
  );
}

type Mode = 'create' | 'edit';

function Loader() {
  const params = useLocalSearchParams<{ edit?: string; from?: string }>();
  const editId = typeof params.edit === 'string' && params.edit !== '' ? params.edit : null;
  const fromId = !editId && typeof params.from === 'string' && params.from !== '' ? params.from : null;
  const targetId = editId ?? fromId;
  const { api, failCount } = useLateBet();
  const router = useRouter();

  const [live, setLive] = useState<LbLive | null>(null);
  const [error, setError] = useState<LateBetError | null>(null);
  const [loading, setLoading] = useState(targetId !== null);

  const load = useCallback(() => {
    if (!targetId) return;
    setLoading(true);
    setError(null);
    api.getLive(targetId)
      .then((res) => setLive(res))
      .catch((e: unknown) => setError(toLateBetError(e)))
      .finally(() => setLoading(false));
  }, [api, targetId]);

  useEffect(() => {
    load();
  }, [load]);

  // 새 약속
  if (!targetId) return <Form mode="create" prefill={null} initialLive={null} />;

  if (loading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  // ?from= 은 프리필일 뿐이다 — 못 읽으면 빈 폼
  if (fromId) return <Form mode="create" prefill={live?.appointment ?? null} initialLive={null} />;

  // ?edit= — 주최자만, 열려 있고 마감 전인 약속만
  const back = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  let blocked: string | null = null;
  if (error) blocked = error.message;
  else if (!live) blocked = errorMessage('LB_NOT_FOUND');
  else if (live.appointment.hostId !== live.myUserId) blocked = errorMessage('LB_NOT_HOST');
  else if (live.appointment.status !== 'open' || live.serverNowMs > live.appointment.closeMs) blocked = errorMessage('LB_EDIT_CLOSED');
  if (blocked !== null || !live) {
    return (
      <View style={styles.fill}>
        <Stack.Screen options={{ title: '약속 수정' }} />
        <Screen
          footer={
            <View style={styles.footer}>
              {error ? <PrimaryButton label="다시 시도" onPress={load} /> : null}
              <PrimaryButton label="돌아가기" variant={error ? 'ghost' : 'primary'} onPress={back} />
            </View>
          }
        >
          <EmptyState
            title={blocked ?? errorMessage('LB_NOT_FOUND')}
            hint={error && failCount >= 3 ? REPEATED_FAILURE_MESSAGE : undefined}
          />
        </Screen>
      </View>
    );
  }
  return <Form mode="edit" prefill={live.appointment} initialLive={live} />;
}

// ───────────────────────── 폼 ─────────────────────────

type RadiusChoice = number | 'custom';

interface FormProps {
  mode: Mode;
  /** 값을 채울 약속(edit: 대상, create+from: 본보기). 없으면 빈 폼 */
  prefill: LbAppointment | null;
  /** edit 모드의 첫 응답(참가자 수) */
  initialLive: LbLive | null;
}

function splitLocalAt(localAt: string): { date: string; time: string } {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(localAt);
  return m ? { date: m[1], time: m[2] } : { date: '', time: '' };
}

function initialRadius(radiusM: number): { choice: RadiusChoice; text: string } {
  return RADIUS_CHOICES.includes(radiusM) ? { choice: radiusM, text: '' } : { choice: 'custom', text: String(radiusM) };
}

function Form({ mode, prefill, initialLive }: FormProps) {
  const router = useRouter();
  const { api, mode: lateBetMode, profile, balance, refresh } = useLateBet();
  // 생성 멱등 키: 이 폼에서 [만들기]를 몇 번 누르든 같은 값 — 타임아웃 뒤 다시 눌러도 약속·에스크로가 두 번 생기지 않는다(서버가 이미 만든 약속을 돌려준다)
  const createRequestId = useRef<string>('');
  if (createRequestId.current === '') createRequestId.current = newRequestId();
  // 기기 시간대: 네이티브는 expo-localization, 웹은 Intl(@/lateBet/deviceTz). 모르면 'Asia/Seoul' — needsTzChoice·tzChoices 는
  // null 을 서울로 보므로 결과가 같다
  const [deviceTz] = useState(readDeviceTz);
  const now = useServerNow(30_000);

  const isEdit = mode === 'edit';
  // edit 모드의 대상 약속. 명단 편집·가짜 패널 조작 뒤 서버 응답으로만 바뀐다(폼 입력은 건드리지 않는다)
  const [appt, setAppt] = useState<LbAppointment | null>(isEdit ? prefill : null);
  const [memberCount, setMemberCount] = useState(initialLive?.participants.length ?? 1);
  /** 주최자 말고 들어온 친구 수(R3: 1명 이상이면 중요 변경 뒤 5분 동안 시작할 수 없다) */
  const [friendCount, setFriendCount] = useState(
    initialLive ? initialLive.participants.filter((p) => p.state === 'active' && p.userId !== initialLive.appointment.hostId).length : 0,
  );

  const split = prefill ? splitLocalAt(prefill.localAt) : { date: '', time: '' };
  const startRadius = initialRadius(prefill?.policy.radiusM ?? 100);

  const [title, setTitle] = useState(prefill?.title ?? '');
  const [names, setNames] = useState<string[]>(!isEdit && prefill ? prefill.invitees.map((i) => i.name) : []);
  const [dateText, setDateText] = useState(split.date);
  const [timeText, setTimeText] = useState(split.time);
  const [tz, setTz] = useState(prefill?.tz ?? SEOUL_TZ);
  const [tzConfirmed, setTzConfirmed] = useState(false);
  const [placeName, setPlaceName] = useState(prefill?.placeName ?? '');
  const [placeNote, setPlaceNote] = useState(prefill?.placeNote ?? '');
  const [pin, setPin] = useState<PlacePickerValue | null>(prefill ? { lat: prefill.placeLat, lng: prefill.placeLng } : null);
  const [presetId, setPresetId] = useState<LatePresetId>(prefill ? (matchPreset(prefill.policy) ?? DEFAULT_PRESET_ID) : DEFAULT_PRESET_ID);
  const [stake, setStake] = useState(prefill?.policy.stake ?? policyWithStake(DEFAULT_PRESET_ID, Number.NaN).stake);
  const [grace, setGrace] = useState(prefill?.policy.graceMinutes ?? 0);
  const [radiusChoice, setRadiusChoice] = useState<RadiusChoice>(startRadius.choice);
  const [radiusText, setRadiusText] = useState(startRadius.text);
  // edit 모드: 걸 포인트·지각 규칙·봐주는 시간·거리 중 하나라도 건드리기 전에는 서버 정책을 그대로 쓴다(프리셋 역추적 오차 방지)
  const [policyTouched, setPolicyTouched] = useState(false);
  const [agreeLocation, setAgreeLocation] = useState(false);
  const [agreeAge, setAgreeAge] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [tzSheet, setTzSheet] = useState<{ open: boolean; suspect: boolean; resume: boolean }>({
    open: false,
    suspect: false,
    resume: false,
  });

  // ── 파생값 ──
  const started = appt !== null && appt.startedAtMs !== null;
  const hostName = profile?.nickname ?? null;

  const parsed = parseAppointmentInput(dateText, timeText);
  const localAt = parsed.at;
  const meetAtMs = localAt ? wallClockToMs(localAt, tz) : null;

  const radiusM =
    radiusChoice === 'custom' ? (/^\d+$/.test(radiusText.trim()) ? Number(radiusText.trim()) : Number.NaN) : radiusChoice;
  const composed = policyWithStake(presetId, stake, { radiusM, graceMinutes: grace });
  const policy = isEdit && appt && (!policyTouched || started) ? appt.policy : composed;
  const validation = validatePolicy(policy);
  const radiusValid = Number.isInteger(radiusM) && radiusM >= POLICY_LIMITS.radiusM.min && radiusM <= POLICY_LIMITS.radiusM.max;
  // 시각이 없어도 걸 포인트·지각 문장은 그릴 수 있다(close 문장만 시각이 필요하다)
  const desc = describePolicy(policy, meetAtMs ?? 0, tz);

  const timeChanged = !isEdit || !appt || localAt !== appt.localAt || tz !== appt.tz;
  const placeChanged =
    !isEdit || !appt || placeName.trim() !== appt.placeName || !pin || pin.lat !== appt.placeLat || pin.lng !== appt.placeLng;
  const pinChanged = isEdit && appt !== null && pin !== null && (pin.lat !== appt.placeLat || pin.lng !== appt.placeLng);
  // R2: 시작 후 핀은 시작하던 순간의 핀에서 500m 안(위치 정하기 화면이 먼저 막지만 한 번 더 본다)
  const moveBlocked = started && appt && pin && pinChanged ? !canMovePlace(appt, pin.lat, pin.lng).ok : false;
  const policyChanged = !isEdit || !appt || !samePolicy(policy, appt.policy);
  const memoChanged = !isEdit || !appt || title.trim() !== appt.title || placeNote.trim() !== appt.placeNote;
  const anyChange = timeChanged || placeChanged || policyChanged || memoChanged;

  // 시각 검사(서버와 같은 식). edit 에서 시각을 안 바꿨으면 검사하지 않는다(이미 지난 약속도 장소는 바꿀 수 있다)
  let timeIssue: string | null = null;
  if (parsed.status === 'incomplete' || parsed.status === 'invalid') timeIssue = appointmentInputHint(parsed.status);
  else if (parsed.status === 'ok' && meetAtMs === null) timeIssue = errorMessage('LB_BAD_TIME');
  else if (meetAtMs !== null && timeChanged) {
    // R1: 앞당기기 → 약속 시각 지남 → 누적 3시간 초과 (서버와 같은 순서, LB_TIME_IN_PAST 보다 먼저)
    const postpone = started && appt ? canPostpone(appt, meetAtMs, now) : ({ ok: true } as const);
    if (!postpone.ok) timeIssue = errorMessage(postpone.code);
    else if (meetAtMs <= now + MIN_LEAD_MS) timeIssue = errorMessage('LB_TIME_IN_PAST');
    else if (meetAtMs > now + MAX_LEAD_MS) timeIssue = errorMessage('LB_TIME_TOO_FAR');
  }

  const titleLen = charLen(title.trim());
  const placeNameLen = charLen(placeName.trim());
  const noteLen = charLen(placeNote.trim());

  // 버튼을 막는 첫 번째 이유(버튼 아래 한 줄)
  let blockReason: string | null = null;
  if (titleLen < 1) blockReason = '약속 이름을 적어주세요';
  else if (titleLen > TITLE_MAX) blockReason = `약속 이름은 ${TITLE_MAX}자까지예요`;
  else if (parsed.status === 'empty') blockReason = '날짜와 시간을 적어주세요';
  else if (timeIssue !== null) blockReason = timeIssue;
  else if (placeNameLen < 1) blockReason = '장소 이름을 적어주세요';
  else if (placeNameLen > PLACE_NAME_MAX) blockReason = `장소 이름은 ${PLACE_NAME_MAX}자까지예요`;
  else if (noteLen > PLACE_NOTE_MAX) blockReason = `장소 메모는 ${PLACE_NOTE_MAX}자까지예요`;
  else if (!pin) blockReason = PIN_REQUIRED;
  else if (moveBlocked) blockReason = errorMessage('LB_MOVE_TOO_FAR');
  else if (!validation.ok) blockReason = validation.issues[0].message;
  else if (!isEdit && (!agreeLocation || !agreeAge)) blockReason = errorMessage('LB_CONSENT_REQUIRED');
  else if (isEdit && !anyChange) blockReason = '바꾼 내용이 없어요';
  const canSubmit = blockReason === null && !submitting;

  // ── 핀 돌려받기 · edit 모드 새로 읽기 ──
  const apptId = appt?.id ?? null;
  const reloadAppt = useCallback(async () => {
    if (!apptId) return;
    try {
      const res = await api.getLive(apptId);
      setAppt(res.appointment);
      setMemberCount(res.participants.length);
      setFriendCount(res.participants.filter((p) => p.state === 'active' && p.userId !== res.appointment.hostId).length);
      if (res.appointment.startedAtMs !== null) {
        // 시작한 뒤에는 정책이 동결이다 — 칩을 서버 값으로 되돌린다
        const p = res.appointment.policy;
        setStake(p.stake);
        setGrace(p.graceMinutes);
        setPresetId(matchPreset(p) ?? DEFAULT_PRESET_ID);
        const r = initialRadius(p.radiusM);
        setRadiusChoice(r.choice);
        setRadiusText(r.text);
        setPolicyTouched(false);
      }
    } catch {
      // 폼은 마지막으로 본 값으로 계속 간다. 저장 때 서버가 최종 판정한다
    }
  }, [api, apptId]);

  useFocusEffect(
    useCallback(() => {
      const r = takePlaceResult();
      if (r) {
        setPin({ lat: r.lat, lng: r.lng, name: r.name });
        // 장소 이름이 비어 있으면 고른 장소 이름으로 채운다
        const picked = r.name;
        if (picked) setPlaceName((prev) => (prev.trim() === '' ? picked : prev));
        // 핀이 바뀌었으니 시간대는 다시 확인한다
        setTzConfirmed(false);
      }
      if (isEdit) void reloadAppt();
    }, [isEdit, reloadAppt]),
  );

  const goPlace = () => {
    // 시작한 뒤에는 시작하던 순간의 핀에서 500m 안으로만(R2) — 위치 정하기 화면이 한도 원을 그리고 넘으면 막는다
    const limit =
      started && appt
        ? { lat: appt.startPlaceLat ?? appt.placeLat, lng: appt.startPlaceLng ?? appt.placeLng, radiusM: MOVE_AFTER_START_MAX_M }
        : null;
    openPlaceDraft({ value: pin, radiusM: radiusValid ? radiusM : 100, placeName: placeName.trim(), limit });
    router.push('/late/place');
  };

  // ── 명단 (create: 폼 상태 / edit: 서버 즉시 반영) ──
  const inviteeNames = isEdit && appt ? appt.invitees.map((i) => i.name) : names;
  const claimedNames = isEdit && appt ? appt.invitees.filter((i) => i.claimedByUserId !== null).map((i) => i.name) : [];

  const onAddInvitee = async (name: string): Promise<void | string> => {
    const issue = inviteeNameIssue(name, inviteeNames, { hostName });
    if (issue !== null) return issue;
    if (isEdit && appt) {
      const next = await api.editInvitees(appt.id, { add: [name] });
      setAppt(next);
      return;
    }
    setNames((prev) => [...prev, name]);
  };

  const onRemoveInvitee = async (name: string): Promise<void> => {
    if (isEdit && appt) {
      const next = await api.editInvitees(appt.id, { remove: [name] });
      setAppt(next);
      return;
    }
    setNames((prev) => prev.filter((n) => n !== name));
  };

  // ── 시간대 시트 ──
  const openTzSheet = (suspect: boolean, resume: boolean) => setTzSheet({ open: true, suspect, resume });
  const closeTzSheet = () => setTzSheet((s) => ({ ...s, open: false }));

  // ── 저장 ──
  // 알림 예약은 약속 화면(useLateReminders)이 서버 응답을 보고 맞춘다 — 여기서는 목록만 새로 읽는다
  const afterSaved = async (_saved: LbAppointment) => {
    await refresh();
  };

  const submit = async (tzArg: string, confirmedArg: boolean) => {
    if (!canSubmit || !localAt || !pin) return;
    // 시트에서 고른 tz 로 다시 들어올 수 있으니 시간 변경 여부는 실제로 보낼 tz 로 본다
    const timeChangedNow = !isEdit || !appt || localAt !== appt.localAt || tzArg !== appt.tz;
    // 기기 시간대가 한국이 아니거나 핀이 한국 밖이면 먼저 묻는다(서버 LB_TZ_SUSPECT 를 기다리지 않는다)
    if (!confirmedArg && (timeChangedNow || placeChanged) && needsTzChoice(deviceTz, pin.lat, pin.lng)) {
      openTzSheet(true, true);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      if (!isEdit) {
        const input: LbCreateInput = {
          title: title.trim(),
          localAt,
          tz: tzArg,
          placeName: placeName.trim(),
          placeNote: placeNote.trim(),
          lat: pin.lat,
          lng: pin.lng,
          policy,
          invitees: names,
          consent: agreeLocation && agreeAge,
          tzConfirmed: confirmedArg,
          requestId: createRequestId.current,
        };
        const created = await api.createAppointment(input);
        // 만든 직후의 조건이 기준 version(주최자는 배너를 보지 않지만 기록은 같은 규칙으로 남긴다)
        markSeenVersion(created.id, created.version, lateBetMode);
        await afterSaved(created);
        // ?invite=1 — 대기실(WaitingView)이 생성 직후 공유 시트를 한 번 연다(웹은 건너뜀)
        router.replace(`/late/${created.id}?invite=1`);
        return;
      }
      if (!appt) return;
      let latest = appt;
      if (memoChanged) await api.updateMemo(appt.id, title.trim(), placeNote.trim());
      const patch: LbEditPatch = {};
      if (timeChangedNow) {
        patch.localAt = localAt;
        patch.tz = tzArg;
        if (confirmedArg) patch.tzConfirmed = true;
      }
      if (placeName.trim() !== appt.placeName) patch.placeName = placeName.trim();
      if (pin.lat !== appt.placeLat || pin.lng !== appt.placeLng) {
        patch.lat = pin.lat;
        patch.lng = pin.lng;
      }
      if (policyChanged) patch.policy = policy;
      if (Object.keys(patch).length > 0) latest = await api.edit(appt.id, patch, appt.version);
      await afterSaved(latest);
      if (router.canGoBack()) router.back();
      else router.replace(`/late/${appt.id}`);
    } catch (e) {
      const err = toLateBetError(e);
      if (isTzSuspectError(err)) {
        openTzSheet(true, true);
        return;
      }
      if (err.code === 'LB_INSUFFICIENT_POINTS' && isEdit) {
        setFormError(err.detail ? `${RAISE_STAKE_INSUFFICIENT_MESSAGE} (${err.detail})` : RAISE_STAKE_INSUFFICIENT_MESSAGE);
      } else {
        setFormError(err.message);
      }
      // 생성이 타임아웃·오프라인으로 끝났으면 서버는 이미 만들었을 수 있다 → 목록을 다시 읽어 둔다.
      // [만들기]를 다시 눌러도 같은 멱등 키라 두 번 생기지 않는다(이미 있으면 그 약속으로 간다)
      if (!isEdit && isConnectivityError(err)) void refresh();
      // 조건이 어긋났으면(다른 기기에서 바꿈·시작됨·끝남) 대상을 다시 읽어 폼 규칙을 맞춘다
      if (
        isEdit &&
        (err.code === 'LB_APPT_CHANGED' ||
          err.code === 'LB_EDIT_FROZEN' ||
          err.code === 'LB_EDIT_CLOSED' ||
          err.code === 'LB_POSTPONE_AFTER_MEET' ||
          err.code === 'LB_POSTPONE_TOO_FAR' ||
          err.code === 'LB_MOVE_TOO_FAR')
      )
        void reloadAppt();
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmitPress = () => {
    if (!canSubmit) return;
    const lines: string[] = [];
    // 시작 전 걸 포인트 인상: 들어온 친구 전원에게 차액이 자동으로 더 걸린다
    const raise = isEdit && appt && !started && policy.stake > appt.policy.stake && memberCount > 1;
    if (raise && appt) {
      const diff = policy.stake - appt.policy.stake;
      lines.push(
        `들어온 친구 ${memberCount - 1}명에게 차액 ${diff}P가 자동으로 더 걸려요. 포인트가 모자란 친구는 채워 드리고, 채울 수 없으면 변경이 되지 않아요.`,
      );
    }
    // R3: 시작 전, 친구가 있을 때 시각·시간대·핀·정책을 바꾸면 5분 동안 시작할 수 없다
    const material = isEdit && appt && !started && friendCount > 0 && (timeChanged || pinChanged || policyChanged);
    if (material && appt) {
      lines.push('바꾸면 5분 동안 시작할 수 없어요. 친구들이 바뀐 내용을 볼 시간이에요.');
      const nextMeet = meetAtMs ?? appt.meetAtMs;
      if (nextMeet <= now + START_COOLDOWN_MS) lines.push('이대로면 약속 시각까지 시작할 수 없어 내기가 무효가 돼요.');
    }
    if (lines.length > 0) {
      confirmDialog(raise ? '걸 포인트를 올릴까요?' : '약속을 바꿀까요?', lines.join(' '), () => void submit(tz, tzConfirmed), {
        confirmText: raise ? '올리기' : '바꾸기',
      });
      return;
    }
    void submit(tz, tzConfirmed);
  };

  const onPickTz = (nextTz: string) => {
    const resume = tzSheet.resume;
    setTz(nextTz);
    setTzConfirmed(true);
    setTzSheet({ open: false, suspect: false, resume: false });
    if (resume) void submit(nextTz, true);
  };

  // ── 표시 조각 ──
  const timeLine =
    meetAtMs !== null && timeIssue === null
      ? `${formatKoreanDateTime(meetAtMs, tz)} · ${tzLabel(tz)} · ${formatFromNow(meetAtMs - now)}`
      : '';
  const presetLine =
    stake > 0
      ? LATE_PRESETS.map((p) => {
          const q = policyWithStake(p.id, stake);
          return `${p.name} ${q.unitMinutes}분마다 ${formatLoss(q.penaltyPerUnit)}`;
        }).join(' · ')
      : '';
  const unclaimed = isEdit && appt ? appt.invitees.filter((i) => i.claimedByUserId === null).map((i) => i.name) : [];
  const frozenNote = errorMessage('LB_EDIT_FROZEN');
  const stakeHint =
    stake === 0 || balance === null
      ? desc.stake
      : `${desc.stake} 보유 포인트 ${balance.toLocaleString('ko-KR')}P${stake > balance ? ' · 모자란 만큼은 만들 때 채워 드려요.' : ''}`;
  const submitLabel = isEdit ? (submitting ? '저장하는 중' : '변경 저장') : submitting ? '만드는 중' : '약속 만들기';

  return (
    <View style={styles.fill}>
      <Stack.Screen options={{ title: isEdit ? '약속 수정' : '약속 잡기' }} />
      <FakeDevPanel appointmentId={apptId} onChanged={() => void reloadAppt()} />
      <Screen
        footer={
          <View style={styles.footer}>
            {formError !== null ? <Text style={styles.error}>{formError}</Text> : null}
            <PrimaryButton label={submitLabel} onPress={onSubmitPress} disabled={!canSubmit} />
            {blockReason !== null && !submitting ? <Text style={styles.footerHint}>{blockReason}</Text> : null}
          </View>
        }
      >
        {isEdit && started ? (
          <Card>
            <Text style={styles.noticeTitle}>이미 시작한 약속이에요</Text>
            <Text style={styles.help}>
              시간은 약속 시각 전에만 뒤로 미룰 수 있고(처음 약속 시각에서 최대 3시간), 장소는 처음 장소에서 {MOVE_AFTER_START_MAX_M}m 안으로만
              옮길 수 있어요. 걸 포인트·지각 규칙·명단은 그대로예요.
            </Text>
          </Card>
        ) : isEdit ? (
          <Text style={styles.help}>
            바꾼 내용은 들어온 친구에게 배너로 보여요. 걸 포인트를 올리면 차액이 자동으로 더 걸리고, 내리면 돌려드려요.
            {friendCount > 0 ? ' 친구가 들어와 있을 때 시간·장소·내기 조건을 바꾸면 5분 동안 시작할 수 없어요.' : ''}
          </Text>
        ) : (
          <Text style={styles.help}>{START_NOTICE}</Text>
        )}

        <TextField
          label={`약속 이름 (1~${TITLE_MAX}자)`}
          value={title}
          onChangeText={setTitle}
          placeholder="예: 금요일 곱창"
          autoFocus={!isEdit && !prefill}
        />

        <SectionTitle>초대할 친구</SectionTitle>
        {isEdit && started ? (
          <Text style={styles.help}>
            {unclaimed.length > 0
              ? `아직 안 들어온 친구: ${unclaimed.join(', ')} — 약속 시각까지 들어올 수 있어요. 시작한 뒤에는 명단을 바꿀 수 없어요.`
              : '초대한 친구가 모두 들어왔어요. 시작한 뒤에는 명단을 바꿀 수 없어요.'}
          </Text>
        ) : (
          <InviteeEditor
            names={inviteeNames}
            claimedNames={claimedNames}
            onAdd={onAddInvitee}
            onRemove={onRemoveInvitee}
            disabled={submitting}
          />
        )}
        {hostName ? <Text style={styles.help}>주최자 {hostName} — 명단에 없어도 자동으로 참여해요.</Text> : null}

        <SectionTitle>언제</SectionTitle>
        <Row>
          <View style={styles.dateField}>
            <TextField label="날짜" value={dateText} onChangeText={setDateText} placeholder="2026-09-25" />
          </View>
          <View style={styles.timeField}>
            <TextField label="시간" value={timeText} onChangeText={setTimeText} placeholder="19:30" />
          </View>
        </Row>
        <Row>
          <Text style={styles.help}>{tzLabel(tz)} 기준</Text>
          <Text style={styles.link} onPress={() => openTzSheet(false, false)} accessibilityRole="button">
            시간대 바꾸기
          </Text>
        </Row>
        {timeLine !== '' ? <Text style={styles.help}>{timeLine}</Text> : null}
        {timeIssue !== null && parsed.status !== 'empty' ? <Text style={styles.warn}>{timeIssue}</Text> : null}
        {isEdit && started && appt ? (
          <Text style={now >= appt.meetAtMs ? styles.warn : styles.help}>{postponeHint(appt, now)}</Text>
        ) : null}

        <SectionTitle>어디서</SectionTitle>
        <TextField
          label={`장소 이름 (1~${PLACE_NAME_MAX}자)`}
          value={placeName}
          onChangeText={setPlaceName}
          placeholder="예: 강남역 2번 출구 곱창"
        />
        <TextField label="장소 메모 (선택)" value={placeNote} onChangeText={setPlaceNote} placeholder="예: 2번 출구에서 도보 3분" />
        {pin ? (
          <MapPane
            destination={{ name: placeName.trim() || pin.name || '약속 장소', lat: pin.lat, lng: pin.lng }}
            radiusM={radiusValid ? radiusM : 100}
            readonly
          />
        ) : null}
        <PrimaryButton
          label={pin ? '지도에서 위치 다시 정하기' : '지도에서 위치 정하기'}
          variant="ghost"
          onPress={goPlace}
          disabled={submitting}
        />
        {!pin ? <Text style={styles.warn}>{PIN_REQUIRED}</Text> : null}

        <SectionTitle>걸 포인트</SectionTitle>
        <Row>
          {STAKE_CHOICES.map((s) => (
            <Chip
              key={s}
              label={s === 0 ? '없음' : `${s}P`}
              selected={stake === s}
              onPress={() => {
                setPolicyTouched(true);
                setStake(s);
              }}
              disabled={submitting || started}
            />
          ))}
        </Row>
        <Text style={styles.help}>{started ? frozenNote : stakeHint}</Text>

        <SectionTitle>늦으면</SectionTitle>
        <Row>
          {LATE_PRESETS.map((p) => (
            <Chip
              key={p.id}
              label={p.name}
              selected={presetId === p.id}
              onPress={() => {
                setPolicyTouched(true);
                setPresetId(p.id);
              }}
              disabled={submitting || started || stake === 0}
            />
          ))}
        </Row>
        {started ? (
          <Text style={styles.help}>{frozenNote}</Text>
        ) : stake === 0 ? (
          <Text style={styles.help}>포인트를 걸지 않으면 지각 규칙은 없어요.</Text>
        ) : (
          <>
            {presetLine !== '' ? <Text style={styles.help}>{presetLine}</Text> : null}
            <Text style={styles.help}>{desc.penalty}</Text>
            {desc.example !== '' ? (
              <Text style={styles.help}>
                예를 들어 <Text style={styles.loss}>{desc.example}</Text>
              </Text>
            ) : null}
            {desc.full !== '' ? <Text style={styles.help}>{desc.full}</Text> : null}
          </>
        )}

        <SectionTitle>봐주는 시간</SectionTitle>
        <Row>
          {GRACE_CHOICES.map((g) => (
            <Chip
              key={g}
              label={g === 0 ? '없음' : `${g}분`}
              selected={grace === g}
              onPress={() => {
                setPolicyTouched(true);
                setGrace(g);
              }}
              disabled={submitting || started}
            />
          ))}
        </Row>
        <Text style={styles.help}>{started ? frozenNote : desc.grace}</Text>

        <SectionTitle>도착 인정 거리</SectionTitle>
        <Row>
          {RADIUS_CHOICES.map((r) => (
            <Chip
              key={r}
              label={`${r}m`}
              selected={radiusChoice === r}
              onPress={() => {
                setPolicyTouched(true);
                setRadiusChoice(r);
              }}
              disabled={submitting || started}
            />
          ))}
          <Chip
            label="직접"
            selected={radiusChoice === 'custom'}
            onPress={() => {
              setPolicyTouched(true);
              setRadiusChoice('custom');
            }}
            disabled={submitting || started}
          />
        </Row>
        {radiusChoice === 'custom' && !started ? (
          <TextField
            label={`거리 (${POLICY_LIMITS.radiusM.min}~${POLICY_LIMITS.radiusM.max}m)`}
            value={radiusText}
            onChangeText={(t) => {
              setPolicyTouched(true);
              setRadiusText(t);
            }}
            placeholder="100"
            keyboardType="number-pad"
            suffix="m"
          />
        ) : null}
        {started ? (
          <Text style={styles.help}>{frozenNote}</Text>
        ) : radiusValid ? (
          <Text style={styles.help}>
            {desc.radius}
            {radiusM <= SMALL_RADIUS_WARN_M ? ` ${SMALL_RADIUS_WARNING}` : ''}
          </Text>
        ) : (
          <Text style={styles.warn}>
            {validation.issues.find((i) => i.field === 'radiusM')?.message ?? errorMessage('LB_CHECK_VIOLATION')}
          </Text>
        )}
        {validation.issues
          .filter((i) => i.field !== 'radiusM')
          .map((i) => (
            <Text key={i.field} style={styles.warn}>
              {i.message}
            </Text>
          ))}
        {meetAtMs !== null && timeIssue === null && desc.close !== '' ? <Text style={styles.help}>{desc.close}</Text> : null}

        {!isEdit ? (
          <>
            <SectionTitle>동의</SectionTitle>
            <CheckRow checked={agreeLocation} onToggle={() => setAgreeLocation((v) => !v)} label={CONSENT_LOCATION} disabled={submitting} />
            <CheckRow checked={agreeAge} onToggle={() => setAgreeAge((v) => !v)} label={CONSENT_AGE} disabled={submitting} />
          </>
        ) : null}
      </Screen>

      <TzSheet
        visible={tzSheet.open}
        suspect={tzSheet.suspect}
        current={tz}
        deviceTz={deviceTz}
        timeLabel={koreanClock(timeText)}
        onPick={onPickTz}
        onClose={closeTzSheet}
      />
    </View>
  );
}

// ───────────────────────── 조각 ─────────────────────────

/** 시작 후 시간 칸 아래 한 줄(R1): 약속 시각이 지났으면 이유, 아니면 남은 한도 */
function postponeHint(appt: LbAppointment, now: number): string {
  if (now >= appt.meetAtMs) return errorMessage('LB_POSTPONE_AFTER_MEET');
  const limit = postponeLimitMs(appt);
  const left = postponeRemainingMinutes(appt) ?? 0;
  if (limit === null || left <= 0) return '처음 약속 시각에서 3시간을 다 미뤘어요. 더 미룰 수 없어요.';
  const h = Math.floor(left / 60);
  const m = left % 60;
  const span = h === 0 ? `${m}분` : m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
  return `${formatKoreanDateTime(appt.meetAtMs, appt.tz)}에서 뒤로 미루기만 할 수 있어요. 남은 한도 ${span} (${formatKoreanDateTime(limit, appt.tz)}까지).`;
}

function CheckRow({ checked, label, onToggle, disabled }: { checked: boolean; label: string; onToggle: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onToggle}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !!disabled }}
      style={({ pressed }) => [styles.checkRow, disabled && { opacity: 0.4 }, pressed && !disabled && { opacity: 0.7 }]}
    >
      <View style={[styles.box, checked && styles.boxChecked]}>{checked ? <View style={styles.boxMark} /> : null}</View>
      <Text style={styles.checkLabel}>{label}</Text>
    </Pressable>
  );
}

/**
 * 시간대 시트(§5.3-B). suspect 면 "이 장소는 한국과 시간대가 다를 수 있어요…" 문구, 아니면 그냥 고르기.
 * [한국 시각] 이 첫 줄이고 그 아래 도시 목록(기기 시간대가 목록에 없으면 한국 다음에 끼운다).
 */
function TzSheet({
  visible,
  suspect,
  current,
  deviceTz,
  timeLabel,
  onPick,
  onClose,
}: {
  visible: boolean;
  suspect: boolean;
  current: string;
  deviceTz: string | null;
  /** 폼에 적힌 시각(예: '오후 7:30') — "약속 시각 '오후 7:30'은 어느 시각인가요?" */
  timeLabel: string;
  onPick: (tz: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const choices = tzChoices(deviceTz);
  const question = timeLabel !== '' ? `약속 시각 '${timeLabel}'은 어느 시각인가요?` : '약속 시각은 어느 시각인가요?';
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetRoot}>
        {/* 새 색을 만들지 않으려고 옵시디언에 투명도를 준 막을 깐다 */}
        <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="닫기" />
        <View style={[styles.sheet, { paddingBottom: Math.max(spacing.xl, insets.bottom + spacing.sm) }]}>
          <Text style={styles.sheetTitle}>{suspect ? '이 장소는 한국과 시간대가 다를 수 있어요' : '시간대 고르기'}</Text>
          <Text style={styles.help}>{question}</Text>
          <PrimaryButton label="한국 시각" onPress={() => onPick(SEOUL_TZ)} />
          <Text style={styles.sheetSub}>현지 시각 — 도시 고르기</Text>
          <ScrollView style={styles.sheetList} keyboardShouldPersistTaps="handled">
            {choices
              .filter((c) => c.tz !== SEOUL_TZ)
              .map((c) => {
                const on = c.tz === current;
                return (
                  <Pressable
                    key={c.tz}
                    onPress={() => onPick(c.tz)}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.tzRow, on && styles.tzRowOn, pressed && { opacity: 0.7 }]}
                  >
                    <Text style={[styles.tzCity, on && styles.tzCityOn]}>{c.city}</Text>
                    <Text style={[styles.tzName, on && styles.tzNameOn]}>{c.tz}</Text>
                  </Pressable>
                );
              })}
          </ScrollView>
          <PrimaryButton label="닫기" variant="ghost" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  footer: { gap: spacing.sm },
  footerHint: { fontSize: fontSize.sm, color: colors.subtext, textAlign: 'center' },
  help: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  // 경고·오류 문구도 colors.text (새 색 금지)
  warn: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text, lineHeight: 20 },
  error: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text, lineHeight: 20 },
  noticeTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  link: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text, textDecorationLine: 'underline' },
  // 잃는 포인트만 브릭
  loss: { color: colors.danger, fontWeight: '700' },
  dateField: { flex: 3 },
  timeField: { flex: 2 },

  checkRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  boxChecked: { backgroundColor: colors.primary },
  // 체크 표시: 두 변만 그린 사각형을 45도 돌린다(이모지·아이콘 폰트 없이)
  boxMark: {
    width: 6,
    height: 11,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderColor: colors.onPrimary,
    transform: [{ rotate: '45deg' }],
    marginTop: -2,
  },
  checkLabel: { flex: 1, fontSize: fontSize.sm, color: colors.text, lineHeight: 20 },

  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.primary, opacity: 0.4 },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sheetTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  sheetSub: { fontSize: fontSize.sm, fontWeight: '700', color: colors.subtext, marginTop: spacing.xs },
  sheetList: { maxHeight: 300 },
  tzRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    marginBottom: spacing.sm,
  },
  tzRowOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  tzCity: { fontSize: fontSize.md, fontWeight: '600', color: colors.text },
  tzCityOn: { color: colors.onPrimary, fontWeight: '800' },
  tzName: { fontSize: fontSize.xs, color: colors.subtext },
  tzNameOn: { color: colors.onPrimary },
});
