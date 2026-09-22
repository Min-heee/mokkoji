/**
 * 약속 내기 — 초대 코드·링크·공유 문구 (순수 함수).
 *
 * 코드는 8자, 헷갈리는 글자(0/O/1/I/L)를 뺀 31자 알파벳이다.
 * 랜딩 페이지(invite-web/invite.js)·서버(lb_peek_invite)·앱(app/j/[code])이 모두 같은 정규식으로 거른다 —
 * 이 정규식을 통과한 값만 URL·RPC 에 들어간다.
 */
import type { LatePolicy } from './lateBet';
import { shortPolicyLine } from './latePresets';
import { formatKoreanDateTime, tzLabel } from './tzGuard';

export const CODE_RE = /^[2-9A-HJKMNP-Z]{8}$/;
export const CODE_LENGTH = 8;
/** 31자: 숫자 2~9 + 대문자에서 I·L·O 제외 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * 초대 페이지 주소. 서브도메인은 오너가 `eas deploy` 때 고른다(설계서 §9-1) — 확정되면 이 상수와
 * invite-web/invite.js 의 PAGE 상수를 같이 바꾼다. 끝은 항상 '/'.
 */
export const INVITE_PAGE_URL = 'https://mokkoji.expo.app/';
/** 앱 스킴 (app.json scheme) */
export const APP_SCHEME = 'nbbang';

/**
 * 사용자가 친 값을 코드로. 공백을 지우고 대문자로 바꾼 뒤 정규식을 통과해야만 돌려준다. 아니면 null.
 * (랜딩 페이지가 코드를 'U B 7 N …'처럼 띄어 보여 주므로 공백은 어디에 있든 지운다)
 */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.replace(/\s/g, '').toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

/** 입력 중인 값 정리(코드 입력칸용): 공백 제거·대문자·알파벳 밖 글자 제거·8자 자르기 */
export function sanitizeCodeInput(raw: string): string {
  const upper = (typeof raw === 'string' ? raw : '').toUpperCase();
  let out = '';
  for (const ch of upper) {
    if (CODE_ALPHABET.includes(ch)) out += ch;
    if (out.length === CODE_LENGTH) break;
  }
  return out;
}

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * 링크·붙여넣은 문구에서 초대 코드를 꺼낸다. 없으면 null.
 * 받는 모양: 코드 그 자체 / https://…/?c=CODE / nbbang://j/CODE · /j/CODE / 공유 문구 전체('초대 코드 CODE').
 * 어떤 경로로 찾든 마지막에 CODE_RE 를 통과해야 한다. 쿼리의 다른 값은 읽지 않는다.
 */
export function parseInviteUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text === '' || text.length > 2000) return null;

  const whole = normalizeCode(text);
  if (whole) return whole;

  // ?c=CODE 또는 &c=CODE
  for (const m of text.matchAll(/[?&]c=([^&#\s]*)/gi)) {
    const code = normalizeCode(safeDecode(m[1]));
    if (code) return code;
  }
  // …/j/CODE (nbbang://j/CODE, https://…/j/CODE, /j/CODE)
  for (const m of text.matchAll(/(?:^|\/)j\/([^/?#\s]+)/gi)) {
    const code = normalizeCode(safeDecode(m[1]));
    if (code) return code;
  }
  // '초대 코드 CODE'
  const labeled = /초대\s*코드\s*[:：]?\s*([2-9A-Za-z]{8})(?![0-9A-Za-z])/.exec(text);
  if (labeled) {
    const code = normalizeCode(labeled[1]);
    if (code) return code;
  }
  // 문구 속에 따로 떨어진 8자 토큰 (이미 대문자인 것만 — 일반 단어를 코드로 오인하지 않게)
  // (룩비하인드는 엔진 호환을 위해 쓰지 않는다 — 앞 글자를 그룹으로 잡는다)
  for (const m of text.matchAll(/(?:^|[^0-9A-Za-z])([2-9A-HJKMNP-Z]{8})(?![0-9A-Za-z])/g)) {
    if (CODE_RE.test(m[1])) return m[1];
  }
  return null;
}

/** 카톡에 붙는 https 링크. 코드가 형식에 안 맞으면 null (검증 안 된 값을 URL 에 넣지 않는다) */
export function buildInviteUrl(code: string, pageUrl: string = INVITE_PAGE_URL): string | null {
  const c = normalizeCode(code);
  if (!c) return null;
  const base = pageUrl.endsWith('/') ? pageUrl : `${pageUrl}/`;
  return `${base}?c=${c}`;
}

/** 앱 딥링크 nbbang://j/CODE. 코드가 형식에 안 맞으면 null */
export function buildAppLink(code: string): string | null {
  const c = normalizeCode(code);
  return c ? `${APP_SCHEME}://j/${c}` : null;
}

/**
 * 새 초대 코드(가짜 서버용 — 실제 코드는 서버가 만든다).
 * 난수원은 인자로 받는다: [0,1) 을 돌려주는 함수.
 */
export function generateCode(random: () => number): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    const r = random();
    const idx = Number.isFinite(r) ? Math.min(CODE_ALPHABET.length - 1, Math.max(0, Math.floor(r * CODE_ALPHABET.length))) : 0;
    out += CODE_ALPHABET[idx];
  }
  return out;
}

export interface ShareTextInput {
  title: string;
  /** 서버가 준 약속 시각(epoch ms) */
  meetAtMs: number;
  /** IANA 시간대 — 라벨을 항상 붙인다('한국 시각') */
  tz: string;
  placeName: string;
  policy: LatePolicy;
  inviteCode: string;
  /** 취소하고 새로 만든 약속이면 앞에 '[변경]'을 붙인다 */
  changed?: boolean;
  pageUrl?: string;
}

const oneLine = (s: string) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/**
 * 공유 문구(설계서 §3.1). 코드는 항상 평문으로도 넣는다(디퍼드 딥링크가 없어서).
 *
 * [모꼬지] 금요일 곱창 — 9월 25일 (금) 오후 7:30 (한국 시각), 강남역 2번 출구 곱창
 * 100P 걸기 · 5분 늦을 때마다 10P
 * 참여: https://…/?c=UB7NPZT7  (초대 코드 UB7NPZT7)
 *
 * 코드가 형식에 안 맞으면 '' (공유 버튼을 누를 수 없는 상태).
 */
export function buildShareText(input: ShareTextInput): string {
  const code = normalizeCode(input.inviteCode);
  const url = code ? buildInviteUrl(code, input.pageUrl) : null;
  if (!code || !url) return '';
  const head = input.changed ? '[변경] [모꼬지]' : '[모꼬지]';
  const title = oneLine(input.title) || '약속';
  const when = formatKoreanDateTime(input.meetAtMs, input.tz);
  const whenPart = when ? `${when} (${tzLabel(input.tz)})` : '';
  const place = oneLine(input.placeName);
  const detail = [whenPart, place].filter((s) => s !== '').join(', ');
  return [
    detail ? `${head} ${title} — ${detail}` : `${head} ${title}`,
    shortPolicyLine(input.policy),
    `참여: ${url}  (초대 코드 ${code})`,
  ].join('\n');
}
