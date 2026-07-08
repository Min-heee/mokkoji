import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { groupIntoRows, parseReceipt, type OcrLine } from './receiptParse';

/** 한 줄짜리 OCR 라인 픽스처 헬퍼 */
function line(text: string, y: number, x = 0, height = 20): OcrLine {
  return { text, x, y, width: text.length * 10, height };
}

describe('groupIntoRows', () => {
  it('세로 중심이 겹치는 라인들을 한 행으로 묶고 x순으로 정렬한다', () => {
    const rows = groupIntoRows([
      line('9,000', 62, 340),
      line('아메리카노', 60, 0),
      line('4,500', 62, 200),
      line('2', 61, 280),
      line('카페라떼', 100, 0),
      line('5,000', 101, 340),
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows[0].map((l) => l.text),
      ['아메리카노', '4,500', '2', '9,000'],
    );
    assert.deepEqual(
      rows[1].map((l) => l.text),
      ['카페라떼', '5,000'],
    );
  });

  it('빈 텍스트 라인은 무시한다', () => {
    const rows = groupIntoRows([line('  ', 0), line('콜라 2,000', 30)]);
    assert.equal(rows.length, 1);
  });
});

describe('parseReceipt — 한국 영수증', () => {
  it('단가·수량·금액 형태와 금액만 있는 형태를 함께 파싱한다', () => {
    const result = parseReceipt([
      line('스타벅스 강남점', 0),
      line('2026-07-08 20:21', 30),
      line('아메리카노 4,500 2 9,000', 60),
      line('카페라떼 5,000', 90),
      line('합계 14,000', 120),
      line('신용카드 14,000', 150),
      line('전화: 02-123-4567', 180),
    ]);
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items[0], {
      name: '아메리카노',
      unitPrice: 4500,
      quantity: 2,
      amount: 9000,
      suspicious: false,
    });
    assert.deepEqual(result.items[1], {
      name: '카페라떼',
      unitPrice: 5000,
      quantity: 1,
      amount: 5000,
      suspicious: false,
    });
    assert.equal(result.detectedTotal, 14000);
  });

  it('열이 분리된 레이아웃(이름/단가/수량/금액이 별도 라인)도 행으로 묶어 파싱한다', () => {
    const result = parseReceipt([
      line('아메리카노', 60, 0),
      line('4,500', 62, 200),
      line('2', 61, 280),
      line('9,000', 62, 340),
      line('합 계', 120, 0),
      line('9,000', 121, 340),
    ]);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].unitPrice, 4500);
    assert.equal(result.items[0].quantity, 2);
    assert.equal(result.detectedTotal, 9000); // "합 계" 공백 포함도 합계로 인식
  });

  it('숫자가 섞인 상품명은 이름으로 유지한다', () => {
    const result = parseReceipt([
      line('참이슬 360ml 5,000', 0),
      line('2인세트 30,000', 30),
    ]);
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].name, '참이슬 360ml');
    assert.equal(result.items[0].unitPrice, 5000);
    assert.equal(result.items[1].name, '2인세트');
    assert.equal(result.items[1].unitPrice, 30000);
  });

  it('수량만 있는 형태("아메리카노 2 9,000")는 단가를 역산한다', () => {
    const result = parseReceipt([line('아메리카노 2 9,000', 0)]);
    assert.equal(result.items[0].unitPrice, 4500);
    assert.equal(result.items[0].quantity, 2);
  });

  it('잡음 줄(사업자·승인·포인트·할인·부가세·주문번호)은 버린다', () => {
    const result = parseReceipt([
      line('사업자 123-45-67890', 0),
      line('승인번호 12345678', 30),
      line('포인트 적립 500', 60),
      line('할인 -1,000', 90),
      line('부가세 1,272', 120),
      line('주문번호 37', 150),
      line('김치찌개 9,000', 180),
    ]);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].name, '김치찌개');
  });

  it('항목 번호 접두("01 아메리카노")는 이름에서 제거한다', () => {
    const result = parseReceipt([line('01 아메리카노 4,500', 0)]);
    assert.equal(result.items[0].name, '아메리카노');
  });

  it('결제금액도 합계 후보로 본다 (최댓값 채택)', () => {
    const result = parseReceipt([
      line('총구매액 14,000', 0),
      line('결제금액 14,000', 30),
    ]);
    assert.equal(result.items.length, 0);
    assert.equal(result.detectedTotal, 14000);
  });
});

describe('parseReceipt — 일본·해외 영수증', () => {
  it('일본 영수증: 항목 파싱 + 세금·합계 처리', () => {
    const result = parseReceipt([
      line('生ビール 600 2 1,200', 0),
      line('枝豆 400', 30),
      line('小計 1,600', 60),
      line('消費税 160', 90),
      line('合計 ¥1,760', 120),
      line('お預り 2,000', 150),
      line('お釣り 240', 180),
    ]);
    assert.equal(result.items.length, 2);
    assert.deepEqual(
      result.items.map((i) => [i.name, i.unitPrice, i.quantity]),
      [
        ['生ビール', 600, 2],
        ['枝豆', 400, 1],
      ],
    );
    assert.equal(result.detectedTotal, 1760);
  });

  it('VND식 점 천단위(25.000)는 소수 0자리 통화에서 천단위로 해석한다', () => {
    const result = parseReceipt([line('PHO BO 65.000', 0)], { decimals: 0 });
    assert.equal(result.items[0].unitPrice, 65000);
  });

  it('소수 통화(USD)에서는 4.50이 소수로 남는다', () => {
    const result = parseReceipt([line('LATTE 4.50', 0)], { decimals: 2 });
    assert.equal(result.items[0].unitPrice, 4.5);
  });
});

describe('parseReceipt — 행 병합 회귀 (2컬럼·기울어진 사진)', () => {
  it('같은 y 밴드에 놓인 두 항목 라인은 각각 항목으로 파싱한다 (2컬럼)', () => {
    const result = parseReceipt([
      line('떡볶이 3,000', 60, 0),
      line('순대 6,000', 61, 400),
    ]);
    assert.deepEqual(
      result.items.map((i) => [i.name, i.amount, i.suspicious]),
      [
        ['떡볶이', 3000, false],
        ['순대', 6000, false],
      ],
    );
  });

  it('줄 간격이 빠듯해 겹친 같은 가격의 두 줄도 모두 남는다', () => {
    const result = parseReceipt([
      line('김치찌개 8,000', 100),
      line('계란말이 8,000', 112),
    ]);
    assert.deepEqual(
      result.items.map((i) => [i.name, i.amount]),
      [
        ['김치찌개', 8000],
        ['계란말이', 8000],
      ],
    );
  });

  it('행 묶음이 아래로 연쇄 확장되지 않는다 (기준은 행의 첫 줄)', () => {
    const result = parseReceipt([
      line('공기밥 1,000', 100),
      line('된장찌개 8,000', 112),
      line('제육볶음 9,000', 124),
    ]);
    assert.equal(result.items.length, 3);
    assert.equal(
      result.items.reduce((sum, i) => sum + i.amount, 0),
      18000,
    );
  });

  it('한 줄 안에 두 항목이 붙어 나오면 최소한 suspicious로 표시한다', () => {
    const result = parseReceipt([line('떡볶이 3,000 순대 6,000', 0)]);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].suspicious, true);
  });

  it('합계 줄과 같은 밴드에 겹친 항목은 잃지 않는다 (2컬럼)', () => {
    const result = parseReceipt([
      line('김밥 3,000', 60, 0),
      line('합계 15,000', 61, 400),
    ]);
    assert.deepEqual(
      result.items.map((i) => [i.name, i.amount]),
      [['김밥', 3000]],
    );
    assert.equal(result.detectedTotal, 15000);
  });

  it('마지막 항목이 합계 줄과 겹쳐도 항목·합계 둘 다 인식한다', () => {
    const result = parseReceipt([
      line('김치찌개 9,000', 100),
      line('합계 9,000', 112),
    ]);
    assert.deepEqual(
      result.items.map((i) => [i.name, i.amount]),
      [['김치찌개', 9000]],
    );
    assert.equal(result.detectedTotal, 9000);
  });

  it('시각·날짜·카드마스킹 조각이 같은 밴드에 겹쳐도 항목은 살아남는다', () => {
    const result = parseReceipt([
      line('아메리카노 4,500', 60, 0),
      line('20:21', 61, 400),
      line('카페라떼 5,000', 90, 0),
      line('2026-07-08', 91, 400),
      line('바닐라라떼 5,500', 120, 0),
      line('****-1234', 121, 400),
    ]);
    assert.deepEqual(
      result.items.map((i) => [i.name, i.amount]),
      [
        ['아메리카노', 4500],
        ['카페라떼', 5000],
        ['바닐라라떼', 5500],
      ],
    );
  });
});

describe('parseReceipt — 비정형 레이아웃', () => {
  it('금액이 왼쪽, 이름이 오른쪽인 열 분리 행도 파싱한다', () => {
    const result = parseReceipt([
      line('4,500', 60, 0),
      line('아메리카노', 61, 200),
      line('5,000', 90, 0),
      line('카페라떼', 91, 200),
      line('합계 9,500', 120, 0),
    ]);
    assert.deepEqual(
      result.items.map((i) => [i.name, i.unitPrice, i.quantity]),
      [
        ['아메리카노', 4500, 1],
        ['카페라떼', 5000, 1],
      ],
    );
    assert.equal(result.detectedTotal, 9500);
  });

  it('일본식 후행 하이픈 금액(1,200-)은 음수가 아니라 금액이다', () => {
    const result = parseReceipt([
      line('生ビール 1,200-', 0),
      line('合計 1,200-', 30),
    ]);
    assert.deepEqual(
      result.items.map((i) => [i.name, i.amount]),
      [['生ビール', 1200]],
    );
    assert.equal(result.detectedTotal, 1200);
  });
});

describe('parseReceipt — SKIP 키워드 오탐', () => {
  it('키워드를 낱말 일부로 포함하는 영문 메뉴명은 버리지 않는다', () => {
    const result = parseReceipt([
      line('CASHEW NUT SALAD 12,000', 0),
      line('CARDAMOM LATTE 6,000', 30),
      line('POINTE BRUNCH 15,000', 60),
    ]);
    assert.deepEqual(
      result.items.map((i) => [i.name, i.amount]),
      [
        ['CASHEW NUT SALAD', 12000],
        ['CARDAMOM LATTE', 6000],
        ['POINTE BRUNCH', 15000],
      ],
    );
  });

  it('키워드를 낱말 일부로 포함하는 한국어 메뉴명은 유지한다', () => {
    const result = parseReceipt([
      line('할인마트표 소세지 3,000', 0),
      line('포인트빵 2,000', 30),
      line('현금박치기세트 12,000', 60),
    ]);
    assert.deepEqual(
      result.items.map((i) => i.name),
      ['할인마트표 소세지', '포인트빵', '현금박치기세트'],
    );
  });

  it('실제 결제·적립·거스름 줄은 여전히 버린다', () => {
    const result = parseReceipt([
      line('김치찌개 9,000', 0),
      line('신용카드 9,000', 30),
      line('CASH 9,000', 60),
      line('포인트 적립 500', 90),
      line('거스름돈 1,000', 120),
      line('승인번호 12345678', 150),
    ]);
    assert.deepEqual(
      result.items.map((i) => i.name),
      ['김치찌개'],
    );
  });
});

describe('parseReceipt — 애매한 행 표시', () => {
  it('단가×수량이 금액과 안 맞으면 suspicious', () => {
    const result = parseReceipt([line('모둠안주 15,000 2 25,000', 0)]);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].suspicious, true);
    assert.equal(result.items[0].amount, 25000);
  });

  it('금액 0원·이름 없는 행은 버린다', () => {
    const result = parseReceipt([line('서비스 0', 0), line('4,500', 30)]);
    assert.equal(result.items.length, 0);
  });
});
