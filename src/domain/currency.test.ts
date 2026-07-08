import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { invertRate } from '../services/fxRates';
import {
  formatMoney,
  fxRateInputDecimals,
  parseMoneyText,
  sanitizeAmountText,
} from './currency';

describe('formatMoney', () => {
  it('KRW는 원화 표기', () => {
    assert.equal(formatMoney(12345, 'KRW'), '12,345원');
  });

  it('JPY는 소수 없이 기호 표기', () => {
    assert.equal(formatMoney(1200, 'JPY'), '¥1,200');
    assert.equal(formatMoney(1234.4, 'JPY'), '¥1,234');
  });

  it('USD는 소수 2자리, .00은 생략', () => {
    assert.equal(formatMoney(10.5, 'USD'), '$10.50');
    assert.equal(formatMoney(10, 'USD'), '$10');
    assert.equal(formatMoney(1234.567, 'USD'), '$1,234.57');
  });

  it('모르는 통화 코드는 코드 접두', () => {
    assert.equal(formatMoney(100, 'XYZ'), 'XYZ 100');
  });
});

describe('sanitizeAmountText', () => {
  it('정수 모드: 숫자만 남기고 선행 0 제거', () => {
    assert.equal(sanitizeAmountText('007', 0), '7');
    assert.equal(sanitizeAmountText('1,234원', 0), '1234');
    assert.equal(sanitizeAmountText('4.5', 0), '45');
  });

  it('소수 모드: 소수점 하나, 자리수 제한', () => {
    assert.equal(sanitizeAmountText('4.', 2), '4.');
    assert.equal(sanitizeAmountText('4.567', 2), '4.56');
    assert.equal(sanitizeAmountText('1.2.3', 2), '1.23');
    assert.equal(sanitizeAmountText('0.5', 2), '0.5');
  });

  it('소수 모드: 쉼표 소수점 자판의 ","는 소수점으로 해석된다', () => {
    // 독일·베트남 등 decimal-pad는 ','만 제공 — 지우면 1,25가 125로 100배 왜곡됐다
    assert.equal(sanitizeAmountText('1,25', 4), '1.25');
    assert.equal(sanitizeAmountText('0,5', 2), '0.5');
    // 입력 중 상태("1,")도 소수점 입력 중으로 유지된다
    assert.equal(sanitizeAmountText('1,', 2), '1.');
    assert.equal(parseMoneyText(sanitizeAmountText('1,25', 4)), 1.25);
  });

  it('소수 모드: 천단위 구분 쉼표 붙여넣기는 그대로 제거된다', () => {
    assert.equal(sanitizeAmountText('1,234', 2), '1234');
    assert.equal(sanitizeAmountText('1,234,567', 2), '1234567');
    assert.equal(sanitizeAmountText('1,234.56', 2), '1234.56');
    // 유럽식 표기: 마지막 구분자가 소수점
    assert.equal(sanitizeAmountText('1.234,56', 2), '1234.56');
  });

  it('정수 모드: 쉼표는 여전히 제거만 된다', () => {
    assert.equal(sanitizeAmountText('1,25', 0), '125');
  });
});

describe('fxRateInputDecimals', () => {
  it('기본은 4자리 — 환율이 없거나 4자리로 충분하면 그대로', () => {
    assert.equal(fxRateInputDecimals(), 4);
    assert.equal(fxRateInputDecimals(null, undefined), 4);
    assert.equal(fxRateInputDecimals(0, -1, NaN, Infinity), 4);
    // JPY 9.3691, USD 1517.5, THB 41.946 — 모두 4자리 이내
    assert.equal(fxRateInputDecimals(9.3691, 1517.5), 4);
    assert.equal(fxRateInputDecimals(41.946), 4);
  });

  it('VND처럼 0.1 미만 환율은 필요한 자릿수만큼 넓어진다', () => {
    // invertRate(17.242653) = 0.057996 — 소수 6자리
    assert.equal(fxRateInputDecimals(0.057996), 6);
    assert.equal(fxRateInputDecimals(null, 0.054054), 6);
    // 저장값·실시간 환율 중 더 넓은 쪽을 따른다
    assert.equal(fxRateInputDecimals(9.3691, 0.057996), 6);
  });

  it('지수 표기로 떨어지는 아주 작은 환율도 처리한다', () => {
    assert.equal(fxRateInputDecimals(5.4e-7), 8);
    // 상한 10자리 — 필드가 무한정 넓어지지는 않는다
    assert.equal(fxRateInputDecimals(1.2345e-9), 10);
  });

  it('회귀: 실시간 VND 환율이 입력 필드를 그대로 통과한다', () => {
    // 서비스가 실제로 만들어내는 값(유효숫자 5자리)으로 왕복 검증
    const rate = invertRate(17.242653);
    assert.equal(rate, 0.057996);
    const decimals = fxRateInputDecimals(null, rate);

    // (1) 화면에 표시된 "0.057996"을 한 글자씩 입력해도 잘리지 않는다
    let text = '';
    for (const ch of String(rate)) {
      text = sanitizeAmountText(text + ch, decimals);
    }
    assert.equal(text, '0.057996');
    assert.equal(parseMoneyText(text), 0.057996);

    // (2) 적용된 값에서 백스페이스 한 번 → 마지막 한 자리만 사라진다
    const applied = String(rate);
    const afterBackspace = sanitizeAmountText(
      applied.slice(0, -1),
      fxRateInputDecimals(rate, rate),
    );
    assert.equal(afterBackspace, '0.05799');

    // 기존 4자리 고정이 일으키던 손상: 0.057996 → 0.0579 (960원/천만동 오차)
    assert.equal(sanitizeAmountText(applied, 4), '0.0579');
  });
});

describe('parseMoneyText', () => {
  it('입력 중 상태도 안전하게 숫자로', () => {
    assert.equal(parseMoneyText('4.'), 4);
    assert.equal(parseMoneyText(''), 0);
    assert.equal(parseMoneyText('12.5'), 12.5);
  });
});
