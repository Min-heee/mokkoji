import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { presetPolicy } from '../domain/latePresets';
import {
  buildResultModel,
  buildResultShareText,
  canceledText,
  formatSignedPoints,
  NO_LOSS_TEXT,
  NO_STAKE_TEXT,
  NOT_STARTED_NO_STAKE_TEXT,
  resultRowDelta,
  resultRowDetail,
  SETTLING_TEXT,
  VOID_NO_WINNER_TEXT,
  VOID_NOT_STARTED_TEXT,
} from './resultModel';
import type { LbAppointment, LbLive, LbLiveParticipant } from './types';

const MIN = 60_000;
const MEET = Date.UTC(2026, 8, 25, 10, 30); // 2026-09-25 19:30 KST
const TZ = 'Asia/Seoul';

function appointment(over: Partial<LbAppointment> = {}): LbAppointment {
  const policy = presetPolicy('normal'); // 100P · 5분마다 −10P · 봐주는 시간 0
  return {
    id: 'appt-1',
    inviteCode: 'ABCDEFGH',
    hostId: 'u-jisu',
    hostNickname: '지수',
    title: '금요일 곱창',
    localAt: '2026-09-25T19:30',
    tz: TZ,
    meetAtMs: MEET,
    // 주최자가 약속 2시간 전에 [시작하기]를 눌렀다
    startedAtMs: MEET - 120 * MIN,
    startMeetAtMs: MEET,
    startPlaceLat: 37.49808,
    startPlaceLng: 127.02761,
    startableAtMs: null,
    closeMs: MEET + 75 * MIN,
    placeName: '강남역 2번 출구 곱창',
    placeNote: '',
    placeLat: 37.49808,
    placeLng: 127.02761,
    status: 'settled',
    voidReason: null,
    version: 1,
    policy,
    invitees: [],
    changes: [],
    ...over,
  };
}

function participant(userId: string, nickname: string, over: Partial<LbLiveParticipant> = {}): LbLiveParticipant {
  return {
    userId,
    nickname,
    state: 'active',
    joinedAtMs: MEET - 180 * MIN,
    arrivedAtMs: null,
    arrivalMethod: null,
    arrivalDistanceM: null,
    arrivalAccuracyM: null,
    vouchedBy: null,
    resultStatus: null,
    forfeited: null,
    received: null,
    joinedAfterStart: false,
    lastSeenMs: null,
    location: null,
    ...over,
  };
}

/** 지수 제시간(GPS ±12m) · 민병희 제시간(친구 확인) · 현우 7분 지각 · 태호 오지 않음 — 설계서 §5.3-G 예시 */
function settledLive(over: Partial<LbLive> = {}): LbLive {
  return {
    serverNowMs: MEET + 200 * MIN,
    myUserId: 'u-me',
    myState: 'active',
    myBalance: 1060,
    settlePending: false,
    appointment: appointment(),
    participants: [
      participant('u-jisu', '지수', { arrivedAtMs: MEET - 9 * MIN, arrivalMethod: 'gps', arrivalAccuracyM: 12, resultStatus: 'onTime', forfeited: 0, received: 60 }),
      participant('u-hyunwoo', '현우', { arrivedAtMs: MEET + 7 * MIN, arrivalMethod: 'gps', arrivalAccuracyM: 30, resultStatus: 'late', forfeited: 20, received: 0 }),
      participant('u-me', '민병희', { arrivedAtMs: MEET - 6 * MIN, arrivalMethod: 'vouch', vouchedBy: 'u-jisu', resultStatus: 'onTime', forfeited: 0, received: 60 }),
      participant('u-taeho', '태호', { resultStatus: 'noShow', forfeited: 100, received: 0 }),
    ],
    ...over,
  };
}

describe('buildResultModel — 확정된 결과', () => {
  it('먼저 온 순으로 순위를 매기고 오지 않은 사람은 맨 뒤, 머리 문장은 "모인 포인트 120P → 제시간에 온 2명이 나눠 가졌어요"', () => {
    const m = buildResultModel(settledLive(), 'settled');
    assert.equal(m.kind, 'settled');
    assert.equal(m.title, '금요일 곱창 결과');
    assert.equal(m.headline, '모인 포인트 120P → 제시간에 온 2명이 나눠 가졌어요');
    assert.equal(m.pot, 120);
    assert.equal(m.onTimeCount, 2);
    assert.equal(m.hasStake, true);
    assert.equal(m.provisional, false);
    assert.equal(m.mismatch, false);
    assert.deepEqual(
      m.rows.map((r) => [r.rank, r.nickname, r.statusText, r.basisText, r.net]),
      [
        [1, '지수', '제시간', 'GPS ±12m', 60],
        [2, '민병희', '제시간', '친구 확인', 60],
        [3, '현우', '7분 지각', 'GPS ±30m', -20],
        [4, '태호', '오지 않음', '', -100],
      ],
    );
    assert.equal(m.rows[1].isMe, true);
    assert.equal(m.rows[3].timeText, '');
  });

  it('행 문구: "오후 7:21 · 제시간 · GPS ±12m" / 증감 "+60P" · "−20P" · "−100P"', () => {
    const m = buildResultModel(settledLive(), 'settled');
    assert.equal(resultRowDetail(m.rows[0]), '오후 7:21 · 제시간 · GPS ±12m');
    assert.equal(resultRowDetail(m.rows[3]), '오지 않음');
    assert.deepEqual(m.rows.map((r) => resultRowDelta(m, r)), ['+60P', '+60P', '−20P', '−100P']);
    assert.equal(formatSignedPoints(0), '0P');
    assert.equal(formatSignedPoints(1500), '+1,500P');
  });

  it('제시간 한 명이면 "…지수님이 모두 가졌어요", 아무도 안 잃었으면 NO_LOSS_TEXT', () => {
    const one = settledLive({
      participants: [
        participant('u-jisu', '지수', { arrivedAtMs: MEET - 9 * MIN, arrivalMethod: 'gps', resultStatus: 'onTime', forfeited: 0, received: 120 }),
        participant('u-hyunwoo', '현우', { arrivedAtMs: MEET + 7 * MIN, arrivalMethod: 'gps', resultStatus: 'late', forfeited: 20, received: 0 }),
        participant('u-taeho', '태호', { resultStatus: 'noShow', forfeited: 100, received: 0 }),
      ],
    });
    assert.equal(buildResultModel(one, 'settled').headline, '모인 포인트 120P → 제시간에 온 지수님이 모두 가졌어요');

    const noLoss = settledLive({
      participants: [
        participant('u-jisu', '지수', { arrivedAtMs: MEET - 9 * MIN, arrivalMethod: 'gps', resultStatus: 'onTime', forfeited: 0, received: 0 }),
        participant('u-me', '민병희', { arrivedAtMs: MEET - 1 * MIN, arrivalMethod: 'gps', resultStatus: 'onTime', forfeited: 0, received: 0 }),
      ],
    });
    const m = buildResultModel(noLoss, 'settled');
    assert.equal(m.headline, NO_LOSS_TEXT);
    assert.equal(m.pot, 0);
    assert.deepEqual(m.rows.map((r) => resultRowDelta(m, r)), ['0P', '0P']);
  });

  it('내기 없음(stake 0)이면 증감 열을 그리지 않고 NO_STAKE_TEXT', () => {
    const live = settledLive({
      appointment: appointment({ policy: { ...presetPolicy('normal'), stake: 0, penaltyPerUnit: 0 } }),
      participants: [
        participant('u-jisu', '지수', { arrivedAtMs: MEET - 9 * MIN, arrivalMethod: 'gps', resultStatus: 'onTime', forfeited: 0, received: 0 }),
        participant('u-taeho', '태호', { resultStatus: 'noShow', forfeited: 0, received: 0 }),
      ],
    });
    const m = buildResultModel(live, 'settled');
    assert.equal(m.hasStake, false);
    assert.equal(m.headline, NO_STAKE_TEXT);
    assert.deepEqual(m.rows.map((r) => resultRowDelta(m, r)), ['', '']);
  });

  it('무효(noWinner): 머리 문장은 VOID_NO_WINNER_TEXT, 증감 열 없음, 순위는 그대로', () => {
    const live = settledLive({
      appointment: appointment({ status: 'voided', voidReason: 'noWinner' }),
      participants: [
        participant('u-hyunwoo', '현우', { arrivedAtMs: MEET + 7 * MIN, arrivalMethod: 'gps', resultStatus: 'late', forfeited: 0, received: 0 }),
        participant('u-taeho', '태호', { resultStatus: 'noShow', forfeited: 0, received: 0 }),
      ],
    });
    const m = buildResultModel(live, 'voided');
    assert.equal(m.kind, 'voided');
    assert.equal(m.headline, VOID_NO_WINNER_TEXT);
    assert.equal(m.pot, 0);
    assert.equal(m.mismatch, false);
    assert.deepEqual(m.rows.map((r) => [r.rank, r.nickname, resultRowDelta(m, r)]), [
      [1, '현우', ''],
      [2, '태호', ''],
    ]);
  });

  it('서버 값이 엔진 재계산과 다르면 mismatch(개발 빌드 배너), 확정 전에는 항상 false', () => {
    const wrong = settledLive();
    wrong.participants[2] = { ...wrong.participants[2], received: 30 };
    assert.equal(buildResultModel(wrong, 'settled').mismatch, true);
    // 무효 여부가 어긋나도 mismatch (제시간에 온 사람이 있는데 voided)
    const badVoid = settledLive({ appointment: appointment({ status: 'voided', voidReason: 'noWinner' }) });
    assert.equal(buildResultModel(badVoid, 'voided').mismatch, true);
    assert.equal(buildResultModel(wrong, 'settling').mismatch, false);
  });

  it('마감 뒤에 찍힌 도착이 있어도 기록이 오지 않음이면 시각을 그리지 않는다', () => {
    const live = settledLive({
      participants: [
        participant('u-jisu', '지수', { arrivedAtMs: MEET - 9 * MIN, arrivalMethod: 'gps', resultStatus: 'onTime', forfeited: 0, received: 100 }),
        participant('u-taeho', '태호', { arrivedAtMs: MEET + 100 * MIN, arrivalMethod: 'gps', resultStatus: 'noShow', forfeited: 100, received: 0 }),
      ],
    });
    const m = buildResultModel(live, 'settled');
    assert.equal(m.rows[1].timeText, '');
    assert.equal(m.rows[1].arrivedAtMs, null);
    assert.equal(resultRowDetail(m.rows[1]), '오지 않음');
  });

  it('시작하지 않아 무효(notStarted): "주최자가 시작하지 않아 내기는 무효예요…", 행은 이름만(오지 않음·증감 없음), mismatch 아님', () => {
    // 가짜 서버(참조 구현)와 같은 모양: status voided · voidReason notStarted · 전원 noShow·0·0 · startedAtMs null
    const live = settledLive({
      appointment: appointment({ status: 'voided', voidReason: 'notStarted', startedAtMs: null }),
      participants: [
        participant('u-jisu', '지수', { resultStatus: 'noShow', forfeited: 0, received: 0 }),
        participant('u-me', '민병희', { resultStatus: 'noShow', forfeited: 0, received: 0 }),
      ],
    });
    const m = buildResultModel(live, 'voided');
    assert.equal(m.notStarted, true);
    assert.equal(m.headline, VOID_NOT_STARTED_TEXT);
    assert.equal(m.pot, 0);
    assert.equal(m.mismatch, false);
    assert.deepEqual(
      m.rows.map((r) => [r.rank, r.nickname, r.statusText, r.timeText, resultRowDetail(r), resultRowDelta(m, r)]),
      [
        [1, '지수', '', '', '', ''],
        [2, '민병희', '', '', '', ''],
      ],
    );
    assert.equal(m.rows[1].isMe, true);
  });

  it('시작하지 않아 무효인데 건 포인트가 없으면 status 가 settled 여도 NOT_STARTED_NO_STAKE_TEXT', () => {
    const live = settledLive({
      appointment: appointment({
        status: 'settled',
        voidReason: 'notStarted',
        startedAtMs: null,
        policy: { ...presetPolicy('normal'), stake: 0, penaltyPerUnit: 0 },
      }),
      participants: [participant('u-jisu', '지수', { resultStatus: 'noShow', forfeited: 0, received: 0 })],
    });
    const m = buildResultModel(live, 'settled');
    assert.equal(m.notStarted, true);
    assert.equal(m.hasStake, false);
    assert.equal(m.headline, NOT_STARTED_NO_STAKE_TEXT);
    assert.equal(m.mismatch, false);
    assert.deepEqual(m.rows.map((r) => resultRowDelta(m, r)), ['']);
  });

  it('정산 전(settling)에는 voidReason 이 없으니 notStarted 가 아니다', () => {
    const live = settledLive({ settlePending: true, appointment: appointment({ status: 'open', startedAtMs: null }) });
    assert.equal(buildResultModel(live, 'settling').notStarted, false);
  });
});

describe('canceledText', () => {
  it('주최자 "약속을 취소했어요." / 참가자 "주최자가 약속을 취소했어요." + 건 포인트가 있으면 환불 문장', () => {
    const live = settledLive({ appointment: appointment({ status: 'canceled' }) });
    assert.equal(canceledText(live, true), '약속을 취소했어요. 건 100P는 돌려드렸어요.');
    assert.equal(canceledText(live, false), '주최자가 약속을 취소했어요. 건 100P는 돌려드렸어요.');
    const free = settledLive({
      appointment: appointment({ status: 'canceled', policy: { ...presetPolicy('normal'), stake: 0, penaltyPerUnit: 0 } }),
    });
    assert.equal(canceledText(free, false), '주최자가 약속을 취소했어요.');
  });
});

describe('buildResultModel — 확정 전(settling)', () => {
  it('서버 결과가 없어도 도착 시각으로 진행 중 순위를 만들고 증감에는 "예정"을 붙인다', () => {
    const live = settledLive({
      settlePending: true,
      appointment: appointment({ status: 'open' }),
      participants: [
        participant('u-jisu', '지수', { arrivedAtMs: MEET - 9 * MIN, arrivalMethod: 'gps', arrivalAccuracyM: 12 }),
        participant('u-hyunwoo', '현우', { arrivedAtMs: MEET + 7 * MIN, arrivalMethod: 'gps' }),
        participant('u-me', '민병희', { arrivedAtMs: MEET - 6 * MIN, arrivalMethod: 'vouch', vouchedBy: 'u-jisu' }),
        participant('u-taeho', '태호'),
      ],
    });
    const m = buildResultModel(live, 'settling');
    assert.equal(m.provisional, true);
    assert.equal(m.headline, SETTLING_TEXT);
    assert.equal(m.mismatch, false);
    assert.deepEqual(m.rows.map((r) => [r.nickname, r.statusText, resultRowDelta(m, r)]), [
      ['지수', '제시간', '+60P 예정'],
      ['민병희', '제시간', '+60P 예정'],
      ['현우', '7분 지각', '−20P 예정'],
      ['태호', '오지 않음', '−100P 예정'],
    ]);
  });
});

describe('buildResultShareText', () => {
  it('[모꼬지] 제목 / 시각 · 장소 / 머리 문장 / 번호. 이름 · 상세 · 증감', () => {
    const live = settledLive();
    const text = buildResultShareText(live, buildResultModel(live, 'settled'));
    const lines = text.split('\n');
    assert.equal(lines[0], '[모꼬지] 금요일 곱창 결과');
    assert.match(lines[1], /^9월 25일 \(금\) 오후 7:30 · 강남역 2번 출구 곱창$/);
    assert.equal(lines[2], '모인 포인트 120P → 제시간에 온 2명이 나눠 가졌어요');
    assert.equal(lines[3], '1. 지수 · 오후 7:21 · 제시간 · GPS ±12m · +60P');
    assert.equal(lines[6], '4. 태호 · 오지 않음 · −100P');
    assert.equal(lines.length, 7);
  });

  it('시작하지 않아 무효면 순위 대신 "참여: 이름, 이름" 한 줄', () => {
    const live = settledLive({
      appointment: appointment({ status: 'voided', voidReason: 'notStarted', startedAtMs: null }),
      participants: [
        participant('u-jisu', '지수', { resultStatus: 'noShow', forfeited: 0, received: 0 }),
        participant('u-me', '민병희', { resultStatus: 'noShow', forfeited: 0, received: 0 }),
      ],
    });
    const lines = buildResultShareText(live, buildResultModel(live, 'voided')).split('\n');
    assert.equal(lines[2], VOID_NOT_STARTED_TEXT);
    assert.equal(lines[3], '참여: 지수, 민병희');
    assert.equal(lines.length, 4);
  });

  it('한국이 아닌 시간대면 시각 뒤에 라벨을 붙인다', () => {
    const live = settledLive({ appointment: appointment({ tz: 'Asia/Tokyo' }) });
    const text = buildResultShareText(live, buildResultModel(live, 'settled'));
    assert.match(text.split('\n')[1], /\(.+\) · 강남역 2번 출구 곱창$/);
    assert.notEqual(text.split('\n')[1].indexOf('('), -1);
  });
});
