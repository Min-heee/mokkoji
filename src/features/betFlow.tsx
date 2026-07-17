import { Stack } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  BET_GAMES,
  buildLadderRungs,
  lastDigit,
  loserByHighestScore,
  lowestScoreIds,
  pickRandomLoser,
  randomBombDurationMs,
  randomInt,
  randomReactionDelayMs,
  randomTargetSeconds,
  traceLadderColumn,
  type BetGameId,
} from '@/domain/betting';
import { currencyInfo, formatMoney } from '@/domain/currency';
import type { PersonId } from '@/domain/types';
import {
  AmountField,
  Card,
  Chip,
  EmptyState,
  PrimaryButton,
  Row,
  Screen,
  SectionTitle,
} from '@/ui/components';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

type Phase = 'pick' | 'play' | 'result';

/** 턴제 게임의 사람별 기록 (결과 화면에 표시) */
interface BetRecord {
  id: PersonId;
  text: string;
}
type OnDone = (loserId: PersonId, records?: BetRecord[]) => void;

export interface BetFlowProps {
  title: string;
  players: PersonId[];
  nameOf: (id: PersonId) => string;
  currency: string;
  totalAmount: number;
  editable: boolean;
  emptyHint: string;
  onApply: (loserId: PersonId, amount: number) => void;
}

export function BetFlow(props: BetFlowProps) {
  const [phase, setPhase] = React.useState<Phase>('pick');
  /** 게임으로 뽑을지, 밖에서 정한 결과를 직접 고를지 */
  const [method, setMethod] = React.useState<'game' | 'manual'>('game');
  const [game, setGame] = React.useState<BetGameId>('draw');
  const [manualLoser, setManualLoser] = React.useState<PersonId | null>(null);
  const [loserId, setLoserId] = React.useState<PersonId | null>(null);
  const [records, setRecords] = React.useState<BetRecord[] | null>(null);
  const [betAmount, setBetAmount] = React.useState<number>(props.totalAmount);

  const appliedAmount = props.editable ? betAmount : props.totalAmount;

  const startAgain = () => {
    setLoserId(null);
    setRecords(null);
    setPhase('pick');
  };

  // 내기 결과를 정산에 반영: 진 사람에게 금액을 붙인다.
  const applyResult = () => {
    if (!loserId) return;
    props.onApply(loserId, appliedAmount);
  };

  if (props.players.length < 2) {
    return (
      <>
        <Stack.Screen options={{ title: '내기' }} />
        <Screen scroll={false}>
          <EmptyState
            title="참가자가 2명 이상 있어야 해요"
            hint={props.emptyHint}
          />
        </Screen>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: props.title }} />
      {phase === 'pick' ? (
        <Screen
          footer={
            method === 'game' ? (
              <PrimaryButton label="시작하기" onPress={() => setPhase('play')} />
            ) : (
              <PrimaryButton
                label="정했어요"
                disabled={!manualLoser}
                onPress={() => {
                  setLoserId(manualLoser);
                  setRecords(null);
                  setPhase('result');
                }}
              />
            )
          }
        >
          <Card>
            <Text style={styles.betTitle}>{props.title}</Text>
            <Text style={styles.betSub}>
              {props.players.map(props.nameOf).join(', ')} · {props.players.length}명 중 한 명이 당첨돼요
            </Text>
          </Card>

          {props.editable ? (
            <>
              <SectionTitle>몰빵 금액</SectionTitle>
              <AmountField
                value={betAmount}
                onChangeValue={setBetAmount}
                decimals={currencyInfo(props.currency).decimals}
                suffix={props.currency === 'KRW' ? '원' : currencyInfo(props.currency).symbol}
                placeholder="0"
              />
              <Text style={styles.betSub}>
                이 금액을 진 사람이 다 내고, 나머지 {formatMoney(Math.max(0, props.totalAmount - betAmount), props.currency)}는 원래대로 나눠요
              </Text>
            </>
          ) : (
            <Card>
              <Text style={styles.amountLine}>
                진 사람이 {formatMoney(props.totalAmount, props.currency)} 몰빵
              </Text>
            </Card>
          )}

          <SectionTitle>정하는 방법</SectionTitle>
          <Row>
            <Chip
              label="게임으로"
              selected={method === 'game'}
              onPress={() => setMethod('game')}
            />
            <Chip
              label="직접 고르기"
              selected={method === 'manual'}
              onPress={() => setMethod('manual')}
            />
          </Row>

          {method === 'game' ? (
            <>
              <SectionTitle>게임 고르기</SectionTitle>
              {BET_GAMES.map((g) => (
                <Card key={g.id} onPress={() => setGame(g.id)}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.gameLabel}>{g.label}</Text>
                      <Text style={styles.gameDesc}>{g.desc}</Text>
                    </View>
                    <View style={[styles.radio, game === g.id && styles.radioOn]}>
                      {game === g.id ? <Text style={styles.radioDot}>✓</Text> : null}
                    </View>
                  </Row>
                </Card>
              ))}
            </>
          ) : (
            <>
              <SectionTitle>누가 걸렸어요?</SectionTitle>
              <Row>
                {props.players.map((pid) => (
                  <Chip
                    key={pid}
                    label={props.nameOf(pid)}
                    selected={manualLoser === pid}
                    onPress={() => setManualLoser(pid)}
                  />
                ))}
              </Row>
              <Text style={styles.betSub}>
                사다리·가위바위보처럼 밖에서 정했으면 진 사람만 골라 정산에 반영해요
              </Text>
            </>
          )}
        </Screen>
      ) : null}

      {phase === 'play'
        ? (() => {
            const onDone: OnDone = (id, recs) => {
              setLoserId(id);
              setRecords(recs ?? null);
              setPhase('result');
            };
            const gameProps = { players: props.players, nameOf: props.nameOf, onDone };
            switch (game) {
              case 'draw':
                return <DrawGame {...gameProps} />;
              case 'bomb':
                return <BombGame {...gameProps} />;
              case 'roulette':
                return <RouletteGame {...gameProps} />;
              case 'timer':
                return <TenSecondGame {...gameProps} />;
              case 'reaction':
                return <ReactionGame {...gameProps} />;
              case 'digits':
                return <LastDigitGame {...gameProps} />;
              case 'ladder':
                return <LadderGame {...gameProps} />;
              case 'numberbomb':
                return <NumberBombGame {...gameProps} />;
              case 'tapfrenzy':
                return <TapFrenzyGame {...gameProps} />;
              case 'minefield':
                return <MineFieldGame {...gameProps} />;
              default:
                return null;
            }
          })()
        : null}

      {phase === 'result' ? (
        <Screen
          footer={
            <>
              <PrimaryButton
                label={`${loserId ? props.nameOf(loserId) : ''}가 내는 걸로`}
                onPress={applyResult}
              />
              <PrimaryButton label="한 판 더" variant="ghost" onPress={startAgain} />
            </>
          }
        >
          <View style={styles.resultTop}>
            <Text style={styles.resultKicker}>당첨</Text>
            <Text style={styles.resultName}>{loserId ? props.nameOf(loserId) : '?'}</Text>
            <Text style={styles.resultAmount}>
              {formatMoney(appliedAmount, props.currency)} 몰빵
            </Text>
            <Text style={styles.resultHint}>
              정산에 반영하면 이 금액이 {loserId ? props.nameOf(loserId) : '?'}님 부담으로 붙어요
            </Text>
          </View>

          {records && records.length > 0 ? (
            <>
              <SectionTitle>기록</SectionTitle>
              <Card>
                {records.map((r, i) => (
                  <View
                    key={r.id}
                    style={[
                      styles.recordRow,
                      i > 0 && styles.recordDivider,
                      r.id === loserId && styles.recordLoser,
                    ]}
                  >
                    <Text
                      style={[
                        styles.recordName,
                        r.id === loserId && styles.recordNameLoser,
                      ]}
                    >
                      {props.nameOf(r.id)}
                      {r.id === loserId ? ' · 당첨' : ''}
                    </Text>
                    <Text
                      style={[
                        styles.recordValue,
                        r.id === loserId && styles.recordNameLoser,
                      ]}
                    >
                      {r.text}
                    </Text>
                  </View>
                ))}
              </Card>
            </>
          ) : null}
        </Screen>
      ) : null}
    </>
  );
}

/** 제비뽑기: 각자 카드 한 장, 하나가 💣. 뒤집다 폭탄 나온 사람이 당첨 */
function DrawGame({
  players,
  nameOf,
  onDone,
}: {
  players: PersonId[];
  nameOf: (id: PersonId) => string;
  onDone: OnDone;
}) {
  // 폭탄이 걸린 사람을 미리 정해두고, 그 사람 카드를 뒤집으면 터진다
  const bombId = React.useMemo(() => pickRandomLoser(players)!, [players]);
  const [flipped, setFlipped] = React.useState<Set<PersonId>>(new Set());

  const flip = (id: PersonId) => {
    if (flipped.has(id)) return;
    const next = new Set(flipped);
    next.add(id);
    setFlipped(next);
    if (id === bombId) {
      setTimeout(() => onDone(id), 700);
    }
  };

  return (
    <Screen>
      <Card>
        <Text style={styles.playTitle}>카드를 한 장씩 뒤집어요</Text>
        <Text style={styles.playSub}>꽝을 뒤집은 사람이 당첨</Text>
      </Card>
      <View style={styles.cardGrid}>
        {players.map((id) => {
          const isFlipped = flipped.has(id);
          const isBomb = id === bombId;
          return (
            <Pressable
              key={id}
              onPress={() => flip(id)}
              style={({ pressed }) => [
                styles.card,
                isFlipped && (isBomb ? styles.cardBomb : styles.cardSafe),
                pressed && !isFlipped && { opacity: 0.7 },
              ]}
            >
              {isFlipped ? (
                <>
                  <Text style={[styles.cardFace, isBomb && styles.cardFaceBomb]}>
                    {isBomb ? '꽝' : '세이프'}
                  </Text>
                  <Text style={styles.cardName}>{nameOf(id)}</Text>
                </>
              ) : (
                <Text style={styles.cardBack}>{nameOf(id)}</Text>
              )}
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.playHint}>돌아가며 자기 카드를 뒤집어 보세요</Text>
    </Screen>
  );
}

/** 폭탄 돌리기: 랜덤 시간 뒤 터진다. '넘기기'로 다음 사람에게, 터질 때 든 사람이 당첨 */
function BombGame({
  players,
  nameOf,
  onDone,
}: {
  players: PersonId[];
  nameOf: (id: PersonId) => string;
  onDone: OnDone;
}) {
  const [holder, setHolder] = React.useState(0);
  const holderRef = React.useRef(0);
  holderRef.current = holder;

  React.useEffect(() => {
    const duration = randomBombDurationMs();
    const timer = setTimeout(() => {
      onDone(players[holderRef.current % players.length]);
    }, duration);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pass = () => setHolder((h) => (h + 1) % players.length);

  return (
    <Screen scroll={false}>
      <View style={styles.bombWrap}>
        <Text style={styles.bombKicker}>폭탄</Text>
        <Text style={styles.bombHolder}>{nameOf(players[holder])}</Text>
        <Text style={styles.bombHint}>지금 들고 있어요 — 빨리 넘겨요!</Text>
      </View>
      <View style={{ padding: spacing.lg, paddingBottom: spacing.xl }}>
        <PrimaryButton label="넘기기 →" onPress={pass} />
      </View>
    </Screen>
  );
}

/** 룰렛: 하이라이트가 이름들 사이를 돌다 점점 느려지며 멈춘 사람이 당첨 */
function RouletteGame({
  players,
  nameOf,
  onDone,
}: {
  players: PersonId[];
  nameOf: (id: PersonId) => string;
  onDone: OnDone;
}) {
  const loser = React.useMemo(() => pickRandomLoser(players)!, [players]);
  const [highlight, setHighlight] = React.useState<PersonId | null>(null);
  const [done, setDone] = React.useState(false);

  React.useEffect(() => {
    const loserIdx = players.indexOf(loser);
    const totalSteps = players.length * 3 + loserIdx; // 3바퀴 돌고 당첨자에 멈춤
    let step = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setHighlight(players[step % players.length]);
      if (step >= totalSteps) {
        setDone(true);
        timer = setTimeout(() => onDone(loser), 700);
        return;
      }
      const progress = step / totalSteps;
      const delay = 55 + progress * progress * 340; // 뒤로 갈수록 감속
      step += 1;
      timer = setTimeout(tick, delay);
    };
    tick();
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Screen>
      <Card>
        <Text style={styles.playTitle}>룰렛</Text>
        <Text style={styles.playSub}>
          {done ? '멈췄어요!' : '돌림판이 돌아가는 중...'}
        </Text>
      </Card>
      <View style={styles.tileGrid}>
        {players.map((pid) => {
          const on = highlight === pid;
          return (
            <View
              key={pid}
              style={[
                styles.tile,
                on && styles.tileOn,
                done && on && styles.tileLoser,
              ]}
            >
              <Text style={[styles.tileText, on && styles.tileTextOn]}>
                {nameOf(pid)}
              </Text>
            </View>
          );
        })}
      </View>
    </Screen>
  );
}

/** 사람별 결과를 한 명씩 공개하는 리빌 화면 */
function TurnReveal({
  kicker,
  name,
  big,
  sub,
  isLast,
  onNext,
}: {
  kicker: string;
  name: string;
  big: string;
  sub?: string;
  isLast: boolean;
  onNext: () => void;
}) {
  return (
    <Screen
      scroll={false}
      footer={
        <PrimaryButton label={isLast ? '결과 보기' : '다음'} onPress={onNext} />
      }
    >
      <View style={styles.turnWrap}>
        <Text style={styles.turnKicker}>{kicker}</Text>
        <Text style={styles.turnName}>{name}</Text>
        <Text style={styles.revealBig}>{big}</Text>
        {sub ? <Text style={styles.turnHint}>{sub}</Text> : null}
      </View>
    </Screen>
  );
}

/** 시간 맞히기: 매 판 1~10초 랜덤 목표. 각자 안 보고 멈추고, 끝날 때마다 기록 공개 */
function TenSecondGame({
  players,
  nameOf,
  onDone,
}: {
  players: PersonId[];
  nameOf: (id: PersonId) => string;
  onDone: OnDone;
}) {
  const target = React.useMemo(() => randomTargetSeconds(), []);
  const targetMs = target * 1000;
  const [idx, setIdx] = React.useState(0);
  const [rows, setRows] = React.useState<
    { id: PersonId; score: number; elapsed: number }[]
  >([]);
  const [state, setState] = React.useState<'ready' | 'running' | 'reveal'>('ready');
  const [lastElapsed, setLastElapsed] = React.useState(0);
  const startRef = React.useRef(0);
  const current = players[idx];
  const isLast = idx + 1 >= players.length;

  const start = () => {
    startRef.current = Date.now();
    setState('running');
  };

  const stop = () => {
    const elapsed = Date.now() - startRef.current;
    setLastElapsed(elapsed);
    setRows((prev) => [
      ...prev,
      { id: current, score: Math.abs(elapsed - targetMs), elapsed },
    ]);
    setState('reveal');
  };

  const next = () => {
    if (isLast) {
      const loser = loserByHighestScore(rows)!;
      const records: BetRecord[] = [...rows]
        .sort((a, b) => a.score - b.score)
        .map((r) => ({
          id: r.id,
          text: `${(r.elapsed / 1000).toFixed(1)}초 · 오차 ${(r.score / 1000).toFixed(1)}초`,
        }));
      onDone(loser, records);
    } else {
      setIdx(idx + 1);
      setState('ready');
    }
  };

  if (state === 'reveal') {
    return (
      <TurnReveal
        kicker={`${idx + 1} / ${players.length} · 목표 ${target}초`}
        name={nameOf(current)}
        big={`${(lastElapsed / 1000).toFixed(1)}초`}
        sub={`오차 ${(Math.abs(lastElapsed - targetMs) / 1000).toFixed(1)}초`}
        isLast={isLast}
        onNext={next}
      />
    );
  }

  const running = state === 'running';
  return (
    <Screen
      scroll={false}
      footer={
        running ? (
          <PrimaryButton label="멈춰!" onPress={stop} />
        ) : (
          <PrimaryButton label={`${nameOf(current)} 시작`} onPress={start} />
        )
      }
    >
      <View style={styles.turnWrap}>
        <Text style={styles.turnKicker}>
          {idx + 1} / {players.length} · 목표 {target}초
        </Text>
        <Text style={styles.turnName}>{nameOf(current)}</Text>
        <Text style={styles.turnHint}>
          {running
            ? `${target}초라고 생각되면 멈춰요 (화면엔 안 보여요)`
            : `시작을 누르고 속으로 ${target}초를 세요`}
        </Text>
      </View>
    </Screen>
  );
}

/** 반응 속도: 신호가 뜨면 탭. 끝날 때마다 기록 공개. 가장 느린(부정출발 포함) 사람이 당첨 */
const FALSE_START = 99999;
function ReactionGame({
  players,
  nameOf,
  onDone,
}: {
  players: PersonId[];
  nameOf: (id: PersonId) => string;
  onDone: OnDone;
}) {
  const [idx, setIdx] = React.useState(0);
  const [scores, setScores] = React.useState<{ id: PersonId; score: number }[]>([]);
  const [state, setState] = React.useState<'idle' | 'waiting' | 'go' | 'reveal'>(
    'idle',
  );
  const [lastScore, setLastScore] = React.useState(0);
  const goAtRef = React.useRef(0);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = players[idx];
  const isLast = idx + 1 >= players.length;

  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const begin = () => {
    setState('waiting');
    timerRef.current = setTimeout(() => {
      goAtRef.current = Date.now();
      setState('go');
    }, randomReactionDelayMs());
  };

  const recordTurn = (score: number) => {
    setLastScore(score);
    setScores((prev) => [...prev, { id: current, score }]);
    setState('reveal');
  };

  const tap = () => {
    if (state === 'waiting') {
      if (timerRef.current) clearTimeout(timerRef.current);
      recordTurn(FALSE_START);
    } else if (state === 'go') {
      recordTurn(Date.now() - goAtRef.current);
    }
  };

  const next = () => {
    if (isLast) {
      const loser = loserByHighestScore(scores)!;
      const records: BetRecord[] = [...scores]
        .sort((a, b) => a.score - b.score)
        .map((r) => ({
          id: r.id,
          text: r.score >= FALSE_START ? '부정출발' : `${r.score}ms`,
        }));
      onDone(loser, records);
    } else {
      setIdx(idx + 1);
      setState('idle');
    }
  };

  if (state === 'reveal') {
    return (
      <TurnReveal
        kicker={`${idx + 1} / ${players.length}`}
        name={nameOf(current)}
        big={lastScore >= FALSE_START ? '부정출발' : `${lastScore}ms`}
        isLast={isLast}
        onNext={next}
      />
    );
  }

  return (
    <Screen
      scroll={false}
      footer={
        state === 'idle' ? (
          <PrimaryButton label={`${nameOf(current)} 준비`} onPress={begin} />
        ) : undefined
      }
    >
      <Pressable
        style={[styles.reactArea, state === 'go' && styles.reactAreaGo]}
        onPress={state === 'idle' ? undefined : tap}
        disabled={state === 'idle'}
      >
        <Text style={styles.turnKicker}>
          {idx + 1} / {players.length} · {nameOf(current)}
        </Text>
        <Text style={[styles.reactText, state === 'go' && styles.reactTextGo]}>
          {state === 'idle'
            ? '준비되면 아래 버튼을 눌러요'
            : state === 'waiting'
              ? '기다려요...'
              : '지금 눌러!'}
        </Text>
      </Pressable>
    </Screen>
  );
}

/**
 * 끝자리 곱하기: 빠르게 오르는 타이머를 멈춰 끝자리를 얻는다. 두 번 해서
 * 두 끝자리를 곱한 값이 점수. 가장 낮은 사람이 당첨. 동점이면 그 사람들끼리 재대결.
 */
function LastDigitGame({
  players,
  nameOf,
  onDone,
}: {
  players: PersonId[];
  nameOf: (id: PersonId) => string;
  onDone: OnDone;
}) {
  const [active, setActive] = React.useState<PersonId[]>(players);
  const [idx, setIdx] = React.useState(0);
  const [scores, setScores] = React.useState<
    { id: PersonId; score: number; d1: number; d2: number }[]
  >([]);
  const [state, setState] = React.useState<
    'roll1' | 'reveal1' | 'roll2' | 'revealTurn' | 'tiebreak'
  >('roll1');
  const [count, setCount] = React.useState(0);
  const countRef = React.useRef(0);
  const [d1, setD1] = React.useState(0);
  const [d2, setD2] = React.useState(0);
  const tiebreaksRef = React.useRef(0);
  const current = active[idx];
  const isLastPlayer = idx + 1 >= active.length;

  const buildRecords = (
    rows: { id: PersonId; score: number; d1: number; d2: number }[],
  ): BetRecord[] =>
    [...rows]
      .sort((a, b) => a.score - b.score)
      .map((r) => ({ id: r.id, text: `${r.d1} × ${r.d2} = ${r.score}` }));

  // 타이머는 roll 상태에서만 빠르게 오른다
  React.useEffect(() => {
    if (state !== 'roll1' && state !== 'roll2') return;
    const iv = setInterval(() => {
      countRef.current += 1;
      setCount(countRef.current);
    }, 30);
    return () => clearInterval(iv);
  }, [state]);

  const stopFirst = () => {
    setD1(lastDigit(countRef.current));
    setState('reveal1');
  };
  const stopSecond = () => {
    setD2(lastDigit(countRef.current));
    setState('revealTurn');
  };

  const afterTurn = () => {
    const score = d1 * d2;
    const nextScores = [...scores, { id: current, score, d1, d2 }];
    if (isLastPlayer) {
      const lowest = lowestScoreIds(nextScores);
      if (lowest.length === 1) {
        onDone(lowest[0], buildRecords(nextScores));
      } else if (tiebreaksRef.current >= 5) {
        // 안전장치: 계속 동점이면 그 중 랜덤으로 (무한 재대결 방지)
        onDone(pickRandomLoser(lowest)!, buildRecords(nextScores));
      } else {
        // 동점 최저 → 그 사람들끼리 재대결
        tiebreaksRef.current += 1;
        setActive(lowest);
        setScores([]);
        setIdx(0);
        setState('tiebreak');
      }
    } else {
      setScores(nextScores);
      setIdx(idx + 1);
      setState('roll1');
    }
  };

  if (state === 'tiebreak') {
    return (
      <Screen scroll={false} footer={<PrimaryButton label="재대결 시작" onPress={() => setState('roll1')} />}>
        <View style={styles.turnWrap}>
          <Text style={styles.resultKicker}>동점</Text>
          <Text style={styles.turnName}>{active.map(nameOf).join(', ')}</Text>
          <Text style={styles.turnHint}>가장 낮은 점수가 같아요. 이 사람들끼리 다시!</Text>
        </View>
      </Screen>
    );
  }

  if (state === 'reveal1') {
    return (
      <Screen scroll={false} footer={<PrimaryButton label="두 번째" onPress={() => setState('roll2')} />}>
        <View style={styles.turnWrap}>
          <Text style={styles.turnKicker}>
            {idx + 1} / {active.length} · 첫 번째
          </Text>
          <Text style={styles.turnName}>{nameOf(current)}</Text>
          <Text style={styles.revealBig}>끝자리 {d1}</Text>
        </View>
      </Screen>
    );
  }

  if (state === 'revealTurn') {
    return (
      <TurnReveal
        kicker={`${idx + 1} / ${active.length}`}
        name={nameOf(current)}
        big={`${d1} × ${d2} = ${d1 * d2}`}
        sub="낮을수록 당첨 위험"
        isLast={isLastPlayer}
        onNext={afterTurn}
      />
    );
  }

  const rolling1 = state === 'roll1';
  return (
    <Screen
      scroll={false}
      footer={
        <PrimaryButton
          label="멈춰!"
          onPress={rolling1 ? stopFirst : stopSecond}
        />
      }
    >
      <View style={styles.turnWrap}>
        <Text style={styles.turnKicker}>
          {idx + 1} / {active.length} · {rolling1 ? '첫 번째' : '두 번째'}
        </Text>
        <Text style={styles.turnName}>{nameOf(current)}</Text>
        <Text style={styles.rollNumber}>{count}</Text>
        <Text style={styles.turnHint}>멈춰서 끝자리를 정해요</Text>
      </View>
    </Screen>
  );
}

/** 사다리타기: 각자 이름을 눌러 사다리를 타고 내려간다. 꽝칸에 도착한 사람이 당첨 */
const LADDER_ROWS = 10;
const COL_W = 64;
const ROW_H = 30;
function LadderGame({
  players,
  nameOf,
  onDone,
}: {
  players: PersonId[];
  nameOf: (id: PersonId) => string;
  onDone: (loserId: PersonId) => void;
}) {
  const numCols = players.length;
  const rungs = React.useMemo(
    () => buildLadderRungs(numCols, LADDER_ROWS),
    [numCols],
  );
  // 꽝 바닥칸을 랜덤으로 정하고, 그 칸으로 도착하는 시작열이 당첨
  const bombCol = React.useMemo(() => randomInt(Math.random, 0, numCols - 1), [numCols]);
  const loserCol = React.useMemo(() => {
    for (let c = 0; c < numCols; c += 1) {
      if (traceLadderColumn(c, rungs, numCols) === bombCol) return c;
    }
    return 0;
  }, [rungs, numCols, bombCol]);

  const [revealed, setRevealed] = React.useState<Set<number>>(new Set());
  const [tracing, setTracing] = React.useState<number | null>(null);
  const [dot, setDot] = React.useState<{ x: number; y: number } | null>(null);
  const stepRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  React.useEffect(
    () => () => {
      if (stepRef.current) clearInterval(stepRef.current);
    },
    [],
  );

  const colX = (c: number) => c * COL_W + COL_W / 2;

  const path = (startCol: number) => {
    const pts: { x: number; y: number }[] = [{ x: colX(startCol), y: 0 }];
    let c = startCol;
    for (let r = 0; r < rungs.length; r += 1) {
      const y = (r + 1) * ROW_H;
      if (c < numCols - 1 && rungs[r][c]) {
        pts.push({ x: colX(c), y });
        c += 1;
        pts.push({ x: colX(c), y });
      } else if (c > 0 && rungs[r][c - 1]) {
        pts.push({ x: colX(c), y });
        c -= 1;
        pts.push({ x: colX(c), y });
      }
    }
    pts.push({ x: colX(c), y: LADDER_ROWS * ROW_H + ROW_H });
    return { pts, endCol: c };
  };

  const run = (startCol: number) => {
    if (tracing !== null || revealed.has(startCol)) return;
    const { pts, endCol } = path(startCol);
    setTracing(startCol);
    setDot(pts[0]);
    let i = 0;
    stepRef.current = setInterval(() => {
      i += 1;
      if (i >= pts.length) {
        if (stepRef.current) clearInterval(stepRef.current);
        setDot(null);
        setTracing(null);
        setRevealed((prev) => new Set(prev).add(startCol));
        if (endCol === bombCol) {
          setTimeout(() => onDone(players[loserCol]), 600);
        }
        return;
      }
      setDot(pts[i]);
    }, 120);
  };

  const boardW = numCols * COL_W;
  const boardH = LADDER_ROWS * ROW_H + ROW_H;

  return (
    <Screen>
      <Card>
        <Text style={styles.playTitle}>사다리타기</Text>
        <Text style={styles.playSub}>이름을 눌러 사다리를 타고 내려가요</Text>
      </Card>
      <View style={{ alignItems: 'center' }}>
        <View style={[styles.ladderNames, { width: boardW }]}>
          {players.map((id, c) => (
            <Pressable
              key={id}
              onPress={() => run(c)}
              style={[styles.ladderName, { width: COL_W }]}
            >
              <Text
                style={[
                  styles.ladderNameText,
                  revealed.has(c) && styles.ladderNameDone,
                ]}
              >
                {nameOf(id)}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={{ width: boardW, height: boardH }}>
          {/* 세로줄 */}
          {players.map((id, c) => (
            <View
              key={id}
              style={[styles.ladderCol, { left: colX(c) - 1, height: boardH }]}
            />
          ))}
          {/* 가로줄 */}
          {rungs.map((row, r) =>
            row.map((on, c) =>
              on ? (
                <View
                  key={`${r}-${c}`}
                  style={[
                    styles.ladderRung,
                    {
                      left: colX(c),
                      top: (r + 1) * ROW_H,
                      width: COL_W,
                    },
                  ]}
                />
              ) : null,
            ),
          )}
          {/* 움직이는 말 */}
          {dot ? (
            <View style={[styles.ladderDot, { left: dot.x, top: dot.y }]} />
          ) : null}
        </View>

        {/* 바닥칸 */}
        <View style={[styles.ladderNames, { width: boardW }]}>
          {players.map((id, c) => {
            const isBombRevealed = [...revealed].some(
              (start) => path(start).endCol === c && c === bombCol,
            );
            const anyReached = [...revealed].some(
              (start) => path(start).endCol === c,
            );
            return (
              <View key={id} style={[styles.ladderSlot, { width: COL_W }]}>
                <Text
                  style={[
                    styles.ladderSlotText,
                    isBombRevealed && styles.ladderSlotBomb,
                  ]}
                >
                  {anyReached ? (c === bombCol ? '꽝' : '안전') : '?'}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    </Screen>
  );
}

/** 숫자 폭탄: 1~100 숨은 숫자. 돌아가며 범위 안 숫자를 골라 좁히다 정확히 집으면 당첨 */
function NumberBombGame({
  players,
  nameOf,
  onDone,
}: {
  players: PersonId[];
  nameOf: (id: PersonId) => string;
  onDone: (loserId: PersonId) => void;
}) {
  const bomb = React.useMemo(() => randomInt(Math.random, 1, 100), []);
  const [lo, setLo] = React.useState(1);
  const [hi, setHi] = React.useState(100);
  const [idx, setIdx] = React.useState(0);
  const [guess, setGuess] = React.useState(Math.round((1 + 100) / 2));
  const current = players[idx];

  const clamp = (n: number) => Math.max(lo, Math.min(hi, n));

  const pick = () => {
    if (guess === bomb) {
      onDone(current);
      return;
    }
    let nlo = lo;
    let nhi = hi;
    if (guess < bomb) nlo = guess + 1;
    else nhi = guess - 1;
    setLo(nlo);
    setHi(nhi);
    setGuess(Math.round((nlo + nhi) / 2));
    setIdx((idx + 1) % players.length);
  };

  return (
    <Screen scroll={false}>
      <View style={styles.turnWrap}>
        <Text style={styles.turnKicker}>
          {lo} ~ {hi} 중 하나
        </Text>
        <Text style={styles.turnName}>{nameOf(current)}</Text>
        <Text style={styles.rollNumber}>{guess}</Text>
        <View style={styles.stepRow}>
          <Pressable style={styles.stepBtn} onPress={() => setGuess(clamp(guess - 10))}>
            <Text style={styles.stepBtnText}>−10</Text>
          </Pressable>
          <Pressable style={styles.stepBtn} onPress={() => setGuess(clamp(guess - 1))}>
            <Text style={styles.stepBtnText}>−1</Text>
          </Pressable>
          <Pressable style={styles.stepBtn} onPress={() => setGuess(clamp(guess + 1))}>
            <Text style={styles.stepBtnText}>+1</Text>
          </Pressable>
          <Pressable style={styles.stepBtn} onPress={() => setGuess(clamp(guess + 10))}>
            <Text style={styles.stepBtnText}>+10</Text>
          </Pressable>
        </View>
        <Text style={styles.turnHint}>범위 안에서 골라요. 숨은 숫자를 집으면 당첨!</Text>
      </View>
      <View style={{ padding: spacing.lg, paddingBottom: spacing.xl }}>
        <PrimaryButton label={`${guess} 선택`} onPress={pick} />
      </View>
    </Screen>
  );
}

/** 연타 대결: 각자 5초간 최대한 많이 탭. 가장 적게 누른 사람이 당첨 */
const TAP_SECONDS = 5;
function TapFrenzyGame({
  players,
  nameOf,
  onDone,
}: {
  players: PersonId[];
  nameOf: (id: PersonId) => string;
  onDone: OnDone;
}) {
  const [idx, setIdx] = React.useState(0);
  const [scores, setScores] = React.useState<{ id: PersonId; taps: number }[]>([]);
  const [state, setState] = React.useState<'ready' | 'running' | 'reveal'>('ready');
  const [count, setCount] = React.useState(0);
  const [left, setLeft] = React.useState(TAP_SECONDS);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const current = players[idx];
  const isLast = idx + 1 >= players.length;

  React.useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
    },
    [],
  );

  const start = () => {
    setCount(0);
    setLeft(TAP_SECONDS);
    setState('running');
    const startedAt = Date.now();
    timerRef.current = setInterval(() => {
      const remain = TAP_SECONDS - Math.floor((Date.now() - startedAt) / 1000);
      if (remain <= 0) {
        if (timerRef.current) clearInterval(timerRef.current);
        setLeft(0);
        setState('reveal');
      } else {
        setLeft(remain);
      }
    }, 100);
  };

  const tap = () => {
    if (state === 'running') setCount((c) => c + 1);
  };

  const finalCount = count;
  const next = () => {
    const nextScores = [...scores, { id: current, taps: finalCount }];
    if (isLast) {
      const loserId = lowestScoreIds(
        nextScores.map((s) => ({ id: s.id, score: s.taps })),
      )[0];
      const records: BetRecord[] = [...nextScores]
        .sort((a, b) => b.taps - a.taps)
        .map((r) => ({ id: r.id, text: `${r.taps}번` }));
      onDone(loserId, records);
    } else {
      setScores(nextScores);
      setIdx(idx + 1);
      setState('ready');
    }
  };

  if (state === 'reveal') {
    return (
      <TurnReveal
        kicker={`${idx + 1} / ${players.length}`}
        name={nameOf(current)}
        big={`${finalCount}번`}
        isLast={isLast}
        onNext={next}
      />
    );
  }

  if (state === 'ready') {
    return (
      <Screen
        scroll={false}
        footer={<PrimaryButton label={`${nameOf(current)} 시작`} onPress={start} />}
      >
        <View style={styles.turnWrap}>
          <Text style={styles.turnKicker}>
            {idx + 1} / {players.length}
          </Text>
          <Text style={styles.turnName}>{nameOf(current)}</Text>
          <Text style={styles.turnHint}>{TAP_SECONDS}초 동안 최대한 많이 눌러요</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll={false}>
      <Pressable style={styles.tapArea} onPress={tap}>
        <Text style={styles.turnKicker}>{left}초</Text>
        <Text style={styles.tapCount}>{count}</Text>
        <Text style={styles.turnHint}>계속 눌러요!</Text>
      </Pressable>
    </Screen>
  );
}

/** 지뢰밟기: 돌아가며 칸을 연다. 지뢰를 밟은 사람이 당첨 */
function MineFieldGame({
  players,
  nameOf,
  onDone,
}: {
  players: PersonId[];
  nameOf: (id: PersonId) => string;
  onDone: (loserId: PersonId) => void;
}) {
  const tiles = players.length + 2;
  const mine = React.useMemo(() => randomInt(Math.random, 0, tiles - 1), [tiles]);
  const [opened, setOpened] = React.useState<Set<number>>(new Set());
  const [turn, setTurn] = React.useState(0);
  const [done, setDone] = React.useState(false);
  const current = players[turn % players.length];

  const open = (i: number) => {
    if (done || opened.has(i)) return;
    const next = new Set(opened).add(i);
    setOpened(next);
    if (i === mine) {
      setDone(true);
      setTimeout(() => onDone(current), 700);
    } else {
      setTurn((t) => t + 1);
    }
  };

  return (
    <Screen>
      <Card>
        <Text style={styles.playTitle}>지뢰밟기</Text>
        <Text style={styles.playSub}>
          {done ? '지뢰!' : `${nameOf(current)} 차례 · 칸을 하나 열어요`}
        </Text>
      </Card>
      <View style={styles.mineGrid}>
        {Array.from({ length: tiles }, (_, i) => {
          const isOpen = opened.has(i);
          const isMine = i === mine;
          return (
            <Pressable
              key={i}
              onPress={() => open(i)}
              style={({ pressed }) => [
                styles.mineTile,
                isOpen && (isMine ? styles.mineTileBomb : styles.mineTileSafe),
                pressed && !isOpen && { opacity: 0.7 },
              ]}
            >
              <Text style={[styles.mineTileText, isOpen && isMine && styles.mineTileBombText]}>
                {isOpen ? (isMine ? '지뢰' : '안전') : '?'}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.playHint}>돌아가며 한 칸씩 — 지뢰를 피해요</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  betTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.text },
  betSub: { fontSize: fontSize.sm, color: colors.subtext },
  gameLabel: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  gameDesc: { fontSize: fontSize.sm, color: colors.subtext, marginTop: 2 },

  // 사다리
  ladderNames: { flexDirection: 'row' },
  ladderName: { alignItems: 'center', paddingVertical: spacing.sm },
  ladderNameText: { fontSize: fontSize.sm, fontWeight: '800', color: colors.text },
  ladderNameDone: { color: colors.subtext },
  ladderCol: {
    position: 'absolute',
    top: 0,
    width: 2,
    backgroundColor: colors.border,
  },
  ladderRung: { position: 'absolute', height: 3, backgroundColor: colors.text },
  ladderDot: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    marginLeft: -8,
    marginTop: -8,
    backgroundColor: colors.primary,
  },
  ladderSlot: { alignItems: 'center', paddingVertical: spacing.sm },
  ladderSlotText: { fontSize: fontSize.sm, fontWeight: '800', color: colors.subtext },
  ladderSlotBomb: { color: colors.danger },

  // 숫자 폭탄 스텝 버튼
  stepRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  stepBtn: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stepBtnText: { fontSize: fontSize.md, fontWeight: '800', color: colors.text },

  // 연타
  tapArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  tapCount: { fontSize: 72, fontWeight: '800', color: colors.text },

  // 지뢰
  mineGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    justifyContent: 'center',
  },
  mineTile: {
    width: 80,
    height: 80,
    borderRadius: radius.md,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mineTileSafe: { backgroundColor: colors.card },
  mineTileBomb: { backgroundColor: colors.dangerDim, borderColor: colors.danger },
  mineTileText: { fontSize: fontSize.md, fontWeight: '800', color: colors.subtext },
  mineTileBombText: { color: colors.danger },
  radio: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: colors.primary, backgroundColor: colors.primary },
  radioDot: { color: colors.onPrimary, fontSize: fontSize.sm, fontWeight: '800' },

  playTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  playSub: { fontSize: fontSize.sm, color: colors.subtext },
  playHint: {
    fontSize: fontSize.sm,
    color: colors.subtext,
    textAlign: 'center',
    marginTop: spacing.sm,
  },

  // 룰렛 타일
  tileGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'center',
  },
  tile: {
    minWidth: 84,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  tileOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  tileLoser: { backgroundColor: colors.danger, borderColor: colors.danger },
  tileText: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  tileTextOn: { color: colors.onPrimary },

  // 턴제(10초·반응) 공통
  turnWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  turnKicker: {
    fontSize: fontSize.sm,
    fontWeight: '800',
    color: colors.subtext,
    letterSpacing: 2,
  },
  turnName: { fontSize: fontSize.xl, fontWeight: '800', color: colors.text },
  turnHint: {
    fontSize: fontSize.md,
    color: colors.subtext,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
  revealBig: {
    fontSize: 44,
    fontWeight: '800',
    color: colors.text,
    marginTop: spacing.xs,
  },
  rollNumber: {
    fontSize: 56,
    fontWeight: '800',
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  reactArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    borderRadius: radius.lg,
    margin: spacing.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  reactAreaGo: { backgroundColor: colors.primary, borderColor: colors.primary },
  reactText: { fontSize: fontSize.xl, fontWeight: '800', color: colors.text },
  reactTextGo: { color: colors.onPrimary },
  cardGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    justifyContent: 'center',
  },
  card: {
    width: 96,
    height: 128,
    borderRadius: radius.lg,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  cardBack: { color: colors.onPrimary, fontSize: fontSize.md, fontWeight: '800' },
  cardSafe: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  cardBomb: { backgroundColor: colors.dangerDim, borderWidth: 1, borderColor: colors.danger },
  cardFace: { fontSize: fontSize.lg, fontWeight: '800', color: colors.subtext },
  cardFaceBomb: { color: colors.danger },
  cardName: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text },

  bombWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  bombKicker: {
    fontSize: fontSize.md,
    fontWeight: '800',
    color: colors.danger,
    letterSpacing: 4,
  },
  bombHolder: { fontSize: fontSize.xl, fontWeight: '800', color: colors.text },
  bombHint: { fontSize: fontSize.md, color: colors.danger, fontWeight: '600' },

  resultTop: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
  },
  resultKicker: {
    fontSize: fontSize.md,
    fontWeight: '800',
    color: colors.danger,
    letterSpacing: 6,
  },
  resultName: { fontSize: fontSize.xl, fontWeight: '800', color: colors.danger },
  resultAmount: {
    fontSize: fontSize.lg,
    fontWeight: '800',
    color: colors.text,
    marginTop: spacing.xs,
  },
  resultHint: {
    fontSize: fontSize.sm,
    color: colors.subtext,
    marginTop: spacing.sm,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
  amountLine: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },

  recordRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  recordDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  recordLoser: {},
  recordName: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  recordValue: { fontSize: fontSize.sm, color: colors.subtext },
  recordNameLoser: { color: colors.danger },
});
