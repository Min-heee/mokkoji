import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatMoney, parseMoneyText, sanitizeAmountText } from './currency';

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

describe('parseMoneyText', () => {
  it('입력 중 상태도 안전하게 숫자로', () => {
    assert.equal(parseMoneyText('4.'), 4);
    assert.equal(parseMoneyText(''), 0);
    assert.equal(parseMoneyText('12.5'), 12.5);
  });
});
