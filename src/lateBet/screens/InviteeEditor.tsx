/**
 * 초대 명단 편집기 — 담당: [create] (props 계약은 [rules-client] 가 확정한 그대로다).
 *
 * 쓰는 곳
 * - app/late/new.tsx (생성): names 는 폼 상태, claimedNames 는 [] (주최자 본인 이름은 넣지 않는다 — 자동 참가).
 *   ?edit=id(시작 전)에서는 onAdd/onRemove 가 곧바로 api.editInvitees 를 부른다. 시작 후에는 그리지 않는다(서버 LB_EDIT_FROZEN).
 * - WaitingView(시작 전 대기실, 주최자): names = appointment.invitees.map(i => i.name),
 *   claimedNames = 이미 들어온 이름(claimedByUserId !== null) → 삭제 불가. onAdd/onRemove 는 api.editInvitees 를 부른 뒤 refresh.
 * - LiveView(시작 후): 안 들어온 이름은 표시만 한다(명단 편집 불가, 약속 시각에 자동 삭제). 이 컴포넌트를 쓰지 않는다.
 *
 * UI 는 기존 app/session/new.tsx 의 '친구에서 추가' 칩 + 이름 입력 칸 + [추가] 를 그대로 본떴다.
 * 친구 칩은 이 컴포넌트 안에서 useFriends() 로 그린다(부모는 names 만 관리하면 된다):
 *   - 친구 이름이 명단에 있으면 선택된 칩, 누르면 명단에서 뺀다(들어온 이름은 못 뺀다).
 *   - 없으면 비선택 칩, 누르면 그 이름을 명단에 넣는다(onAdd).
 *
 * 규칙: 이름 1~12자(보이지 않는 문자 제거 후), 공백·대소문자·전각만 다른 이름은 같은 이름(서버 lb_nick_key 와 같은 판정).
 * 길이·중복·정원은 여기서 먼저 거르고, 주최자 이름 같은 부모의 규칙은 onAdd 가 문구를 돌려주면 그대로 보여 준다.
 * 이모지·새 색 금지, 풀폭. 오류 문구는 errors.ts 의 것을 우선 쓴다.
 */
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useFriends } from '@/state/FriendsContext';
import { Chip, PrimaryButton, Row, SectionTitle, TextField } from '@/ui/components';
import { colors, fontSize } from '@/ui/theme';

import { errorMessage, toLateBetError } from '../errors';

export interface InviteeEditorProps {
  /** 명단(주최자 제외). 순서대로 그린다 */
  names: string[];
  /** 이미 들어온 이름 — 칩은 보이되 삭제할 수 없다(내보내기는 참가자 행에서) */
  claimedNames: string[];
  /** [추가] 또는 엔터. 부모가 중복·길이 검사 결과(오류 문구)를 돌려주면 그대로 보여 준다 */
  onAdd: (name: string) => void | string | Promise<void | string>;
  /** 빈 이름 칩을 눌렀을 때 */
  onRemove: (name: string) => void | Promise<void>;
  /** 요청 중·시작 후 등 편집 불가 */
  disabled?: boolean;
  /** 최대 인원(주최자 제외). 기본 19 */
  maxNames?: number;
}

const DEFAULT_MAX = 19;

/** 이름 길이 한계(서버 lb_ensure_profile·명단과 같다) */
export const INVITEE_NAME_MIN = 1;
export const INVITEE_NAME_MAX = 12;

/** 서버 private.lb_clean_nick 의 '보이지 않는 문자' (U+00AD, U+200B–200F, U+2028–202F, U+2060–2064, U+FEFF) */
const INVISIBLE = /[\u00AD\u200B-\u200F\u2028-\u202F\u2060-\u2064\uFEFF]/g;

/** 보이지 않는 문자 제거 + 양끝 공백 제거 (서버 lb_clean_nick) */
export function cleanInviteeName(raw: string): string {
  return raw.replace(INVISIBLE, '').trim();
}

/** 같은 이름 판정 키: NFKC + 공백 제거 + 소문자 (서버 lb_nick_key) */
export function inviteeNameKey(raw: string): string {
  return cleanInviteeName(raw).normalize('NFKC').replace(/\s/g, '').toLowerCase();
}

/** 글자 수(코드 포인트 기준 — 서버 char_length 와 같다) */
const charLen = (s: string) => Array.from(s).length;

export const INVITEE_DUPLICATE_MESSAGE = '이미 명단에 있는 이름이에요.';
export const INVITEE_HOST_MESSAGE = '주최자는 자동으로 참여해요. 친구 이름을 적어주세요.';
export const inviteeFullMessage = (max: number) => `최대 ${max}명까지 초대할 수 있어요.`;

/**
 * 이름 하나를 명단에 넣을 수 있는지 미리 검사한다(서버와 같은 규칙). 통과하면 null, 아니면 보여 줄 문구.
 * 폼(new.tsx)과 대기실이 onAdd 안에서 같이 쓴다. hostName 이 있으면 주최자 이름도 막는다.
 */
export function inviteeNameIssue(
  raw: string,
  names: readonly string[],
  options: { hostName?: string | null; maxNames?: number } = {},
): string | null {
  const name = cleanInviteeName(raw);
  const n = charLen(name);
  if (n < INVITEE_NAME_MIN || n > INVITEE_NAME_MAX) return errorMessage('LB_BAD_NICKNAME');
  const key = inviteeNameKey(name);
  if (options.hostName && inviteeNameKey(options.hostName) === key) return INVITEE_HOST_MESSAGE;
  if (names.some((x) => inviteeNameKey(x) === key)) return INVITEE_DUPLICATE_MESSAGE;
  const max = options.maxNames ?? DEFAULT_MAX;
  if (names.length >= max) return inviteeFullMessage(max);
  return null;
}

export function InviteeEditor({ names, claimedNames, onAdd, onRemove, disabled, maxNames = DEFAULT_MAX }: InviteeEditorProps) {
  const { friends } = useFriends();
  const [input, setInput] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const claimedKeys = new Set(claimedNames.map(inviteeNameKey));
  const isClaimed = (name: string) => claimedKeys.has(inviteeNameKey(name));
  const nameInList = (raw: string) => names.find((n) => inviteeNameKey(n) === inviteeNameKey(raw));
  const full = names.length >= maxNames;
  const frozen = !!disabled || busy;

  // onAdd/onRemove 가 던지면(RPC 실패) 그 문구를 그대로 보여 준다
  const run = async (task: () => Promise<void>) => {
    if (frozen) return;
    setBusy(true);
    try {
      await task();
    } catch (e) {
      setMessage(toLateBetError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const add = (raw: string, clearInput: boolean) =>
    run(async () => {
      const name = cleanInviteeName(raw);
      if (name === '') return;
      // 길이·중복·정원은 여기서 먼저 거른다(부모는 주최자 이름 같은 자기 규칙만 보면 된다)
      const local = inviteeNameIssue(name, names, { maxNames });
      if (local !== null) {
        setMessage(local);
        return;
      }
      const result = await onAdd(name);
      if (typeof result === 'string' && result !== '') {
        setMessage(result);
        return;
      }
      setMessage('');
      if (clearInput) setInput('');
    });

  const remove = (name: string) =>
    run(async () => {
      if (isClaimed(name)) return;
      await onRemove(name);
      setMessage('');
    });

  const toggleFriend = (friendName: string) => {
    const existing = nameInList(friendName);
    if (existing !== undefined) void remove(existing);
    else void add(friendName, false);
  };

  return (
    <View style={styles.wrap}>
      {friends.length > 0 ? (
        <>
          <SectionTitle>친구에서 추가</SectionTitle>
          <Row>
            {friends.map((f) => {
              const existing = nameInList(f.name);
              const selected = existing !== undefined;
              return (
                <Chip
                  key={f.id}
                  label={f.name}
                  selected={selected}
                  disabled={frozen || (existing !== undefined ? isClaimed(existing) : full)}
                  onPress={() => toggleFriend(f.name)}
                />
              );
            })}
          </Row>
        </>
      ) : null}

      <Row>
        <View style={styles.nameField}>
          <TextField
            label="초대할 친구 이름"
            value={input}
            onChangeText={(t) => {
              setInput(t);
              if (message !== '') setMessage('');
            }}
            placeholder="친구가 앱에서 고를 이름 (1~12자)"
            onSubmitEditing={() => void add(input, true)}
            keepFocusOnSubmit
          />
        </View>
        <View style={styles.addButton}>
          <PrimaryButton label="추가" variant="ghost" onPress={() => void add(input, true)} disabled={frozen || full || input.trim() === ''} />
        </View>
      </Row>

      {names.length > 0 ? (
        <Row>
          {names.map((name) => {
            const claimed = isClaimed(name);
            return (
              <Chip
                key={name}
                label={claimed ? `${name} (들어옴)` : name}
                selected
                disabled={frozen || claimed}
                onPress={() => void remove(name)}
              />
            );
          })}
        </Row>
      ) : null}

      {message !== '' ? <Text style={styles.error}>{message}</Text> : null}
      <Text style={styles.help}>
        {full
          ? inviteeFullMessage(maxNames)
          : names.length === 0
            ? '친구는 초대 링크를 열고 이 명단에서 자기 이름을 골라 참여해요. 지금 넣지 않아도 대기실에서 추가할 수 있어요.'
            : '친구는 초대 링크를 열고 이 명단에서 자기 이름을 골라 참여해요. 이름을 누르면 명단에서 빠져요.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  nameField: { flex: 1 },
  addButton: { alignSelf: 'flex-end' },
  help: { fontSize: fontSize.sm, color: colors.subtext, lineHeight: 20 },
  // 오류 문구도 colors.text (새 색 금지)
  error: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text, lineHeight: 20 },
});
