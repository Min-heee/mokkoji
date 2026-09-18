import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildAppLink,
  buildInviteUrl,
  buildShareText,
  CODE_ALPHABET,
  CODE_RE,
  generateCode,
  INVITE_PAGE_URL,
  normalizeCode,
  parseInviteUrl,
  sanitizeCodeInput,
} from './invite';
import { presetPolicy } from './latePresets';

const CODE = 'UB7NPZT7';
const MEET = Date.UTC(2026, 8, 25, 10, 30); // 2026-09-25 (금) 19:30 KST

describe('CODE_RE · 알파벳', () => {
  it('31자 알파벳에는 헷갈리는 글자(0 O 1 I L)가 없다', () => {
    assert.equal(CODE_ALPHABET.length, 31);
    assert.equal(new Set(CODE_ALPHABET).size, 31);
    for (const ch of '01OIL') assert.equal(CODE_ALPHABET.includes(ch), false, ch);
  });

  it('알파벳의 모든 글자는 정규식을 통과하고, 그 밖의 글자는 통과하지 못한다', () => {
    for (const ch of CODE_ALPHABET) assert.ok(CODE_RE.test(ch.repeat(8)), ch);
    for (const ch of '01OILabc-_ ') assert.equal(CODE_RE.test(`${ch}2345678`), false, ch);
  });

  it('8자가 아니면 거부', () => {
    assert.equal(CODE_RE.test('UB7NPZT'), false);
    assert.equal(CODE_RE.test('UB7NPZT77'), false);
  });
});

describe('normalizeCode', () => {
  it('공백을 지우고 대문자로 바꾼다', () => {
    assert.equal(normalizeCode(' ub7n pzt7 '), CODE);
    assert.equal(normalizeCode('U B 7 N P Z T 7'), CODE);
    assert.equal(normalizeCode('ub7npzt7\n'), CODE);
  });

  it('형식에 안 맞으면 null', () => {
    for (const bad of ['', 'UB7NPZT', 'UB7NPZT0', 'UB7NPZTI', 'UB7N-PZT7', '<img src>', null, undefined, 12345678]) {
      assert.equal(normalizeCode(bad), null, String(bad));
    }
  });
});

describe('sanitizeCodeInput', () => {
  it('입력 중에는 알파벳 밖 글자를 버리고 8자에서 자른다', () => {
    assert.equal(sanitizeCodeInput('ub7n-pzt7zzz'), CODE);
    assert.equal(sanitizeCodeInput('o0i1l'), '');
    assert.equal(sanitizeCodeInput('ub7'), 'UB7');
  });
});

describe('parseInviteUrl', () => {
  it('https 초대 링크', () => {
    assert.equal(parseInviteUrl(`${INVITE_PAGE_URL}?c=${CODE}`), CODE);
    assert.equal(parseInviteUrl(`https://example.expo.app/?noapp=1&c=${CODE.toLowerCase()}#x`), CODE);
  });

  it('앱 딥링크와 경로', () => {
    assert.equal(parseInviteUrl(`nbbang://j/${CODE}`), CODE);
    assert.equal(parseInviteUrl(`/j/${CODE}`), CODE);
    assert.equal(parseInviteUrl(`https://example.expo.app/j/${CODE}?x=1`), CODE);
  });

  it('코드만 붙여넣어도 된다', () => {
    assert.equal(parseInviteUrl(' ub7npzt7 '), CODE);
  });

  it('공유 문구 전체를 붙여넣어도 코드를 찾는다', () => {
    const text = buildShareText({
      title: '금요일 곱창',
      meetAtMs: MEET,
      tz: 'Asia/Seoul',
      placeName: '강남역 2번 출구 곱창',
      policy: presetPolicy('normal'),
      inviteCode: CODE,
    });
    assert.equal(parseInviteUrl(text), CODE);
    assert.equal(parseInviteUrl(`친구가 보냄: 초대 코드 ${CODE} 입니다`), CODE);
    assert.equal(parseInviteUrl(`코드는 ${CODE} 야`), CODE);
  });

  it('악성 쿼리·형식 오류는 null', () => {
    for (const bad of [
      'https://example.expo.app/?c=<img onerror=alert(1)>',
      'https://example.expo.app/?c=X;S.browser_fallback_url=https://evil',
      'https://example.expo.app/?c=UB7NPZT0',
      'https://example.expo.app/?code=UB7NPZT7X',
      'nbbang://j/',
      'nbbang://session/abc',
      '%E0%A4%A',
      '',
      null,
      42,
    ]) {
      assert.equal(parseInviteUrl(bad), null, String(bad));
    }
  });

  it('소문자 일반 단어를 코드로 오인하지 않는다', () => {
    assert.equal(parseInviteUrl('see you at the restaurant tonight'), null);
    assert.equal(parseInviteUrl('ABCDEFGH2345 는 너무 길다'), null);
  });
});

describe('buildInviteUrl · buildAppLink', () => {
  it('검증된 코드로만 만든다', () => {
    assert.equal(buildInviteUrl(CODE), `${INVITE_PAGE_URL}?c=${CODE}`);
    assert.equal(buildInviteUrl('ub7npzt7', 'https://x.expo.app'), `https://x.expo.app/?c=${CODE}`);
    assert.equal(buildAppLink(CODE), `nbbang://j/${CODE}`);
    assert.equal(buildInviteUrl('X;evil'), null);
    assert.equal(buildAppLink('../../x'), null);
  });

  it('만든 링크는 다시 같은 코드로 읽힌다', () => {
    assert.equal(parseInviteUrl(buildInviteUrl(CODE)), CODE);
    assert.equal(parseInviteUrl(buildAppLink(CODE)), CODE);
  });
});

describe('generateCode', () => {
  it('어떤 난수가 와도 형식에 맞는 코드를 만든다', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 200; i += 1) assert.ok(CODE_RE.test(generateCode(rnd)));
    assert.ok(CODE_RE.test(generateCode(() => 0)));
    assert.ok(CODE_RE.test(generateCode(() => 1)));
    assert.ok(CODE_RE.test(generateCode(() => Number.NaN)));
    assert.equal(generateCode(() => 0.999999), 'ZZZZZZZZ');
  });
});

describe('buildShareText', () => {
  const base = {
    title: '금요일 곱창',
    meetAtMs: MEET,
    tz: 'Asia/Seoul',
    placeName: '강남역 2번 출구 곱창',
    policy: presetPolicy('normal'),
    inviteCode: CODE,
  };

  it('설계서의 문구 그대로 — 시간대 라벨과 평문 코드가 항상 들어간다', () => {
    assert.equal(
      buildShareText(base),
      [
        '[정산야호] 금요일 곱창 — 9월 25일 (금) 오후 7:30 (한국 시각), 강남역 2번 출구 곱창',
        '100P 걸기 · 5분 늦을 때마다 10P',
        `참여: ${INVITE_PAGE_URL}?c=${CODE}  (초대 코드 ${CODE})`,
      ].join('\n'),
    );
  });

  it('취소하고 새로 만든 약속은 [변경]을 붙인다', () => {
    assert.ok(buildShareText({ ...base, changed: true }).startsWith('[변경] [정산야호] 금요일 곱창'));
  });

  it('다른 시간대면 그 시간대의 벽시계와 라벨', () => {
    const text = buildShareText({ ...base, tz: 'Asia/Bangkok' });
    assert.ok(text.includes('오후 5:30 (방콕 시각)'), text);
  });

  it('제목의 줄바꿈은 한 줄로, 코드가 틀리면 빈 문자열', () => {
    assert.ok(buildShareText({ ...base, title: '금요일\n곱창' }).startsWith('[정산야호] 금요일 곱창 —'));
    assert.equal(buildShareText({ ...base, inviteCode: 'nope' }), '');
  });
});
