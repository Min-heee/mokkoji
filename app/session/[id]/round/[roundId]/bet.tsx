import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  BET_GAMES,
  pickRandomLoser,
  randomBombDurationMs,
  type BetGameId,
} from '@/domain/betting';
import type { PersonId } from '@/domain/types';
import { useSessions } from '@/state/SessionsContext';
import {
  Card,
  EmptyState,
  PrimaryButton,
  Row,
  Screen,
  SectionTitle,
} from '@/ui/components';
import { colors, fontSize, radius, spacing } from '@/ui/theme';

type Phase = 'pick' | 'play' | 'result';

export default function BetScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; roundId: string; itemId?: string }>();
  const sessionId = typeof params.id === 'string' ? params.id : '';
  const roundId = typeof params.roundId === 'string' ? params.roundId : '';
  const itemId = typeof params.itemId === 'string' ? params.itemId : '';
  const { getSession } = useSessions();

  const session = sessionId ? getSession(sessionId) : undefined;
  const round = session?.rounds.find((r) => r.id === roundId);
  const item = itemId ? round?.items.find((it) => it.id === itemId) : undefined;

  const [phase, setPhase] = React.useState<Phase>('pick');
  const [game, setGame] = React.useState<BetGameId>('draw');
  const [loserId, setLoserId] = React.useState<PersonId | null>(null);

  if (!session || !round || (itemId && !item)) {
    return (
      <Screen scroll={false}>
        <EmptyState emoji="🎲" title="내기를 열 수 없어요" hint="차수로 돌아가 주세요." />
      </Screen>
    );
  }

  const nameOf = (pid: PersonId) =>
    session.people.find((p) => p.id === pid)?.name ?? '?';

  // 항목 내기면 그 항목을 먹은 사람들끼리 (아무도 없으면 차수 참가자 전원).
  // 차수 내기면 차수 참가자 전원.
  const players =
    item && item.eaterIds.length > 0 ? item.eaterIds : round.participantIds;
  const betLabel = item ? `${item.name || '항목'} 내기` : `${round.title} 내기`;

  const startAgain = () => {
    setLoserId(null);
    setPhase('pick');
  };

  if (players.length < 2) {
    return (
      <>
        <Stack.Screen options={{ title: '내기' }} />
        <Screen scroll={false}>
          <EmptyState
            emoji="🙋"
            title="참가자가 2명 이상 있어야 해요"
            hint={
              item
                ? "이 항목을 '먹은 사람'이 2명 이상이어야 해요."
                : "차수에서 '함께한 사람'을 먼저 골라주세요."
            }
          />
        </Screen>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: betLabel }} />
      {phase === 'pick' ? (
        <Screen
          footer={
            <PrimaryButton
              label={`${BET_GAMES.find((g) => g.id === game)?.emoji} 시작하기`}
              onPress={() => setPhase('play')}
            />
          }
        >
          <Card>
            <Text style={styles.betTitle}>🎲 {betLabel}</Text>
            <Text style={styles.betSub}>
              {players.map(nameOf).join(', ')} · {players.length}명 중 한 명이 당첨돼요
            </Text>
          </Card>

          <SectionTitle>게임 고르기</SectionTitle>
          {BET_GAMES.map((g) => (
            <Card key={g.id} onPress={() => setGame(g.id)}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.gameLabel}>
                    {g.emoji} {g.label}
                  </Text>
                  <Text style={styles.gameDesc}>{g.desc}</Text>
                </View>
                <View style={[styles.radio, game === g.id && styles.radioOn]}>
                  {game === g.id ? <Text style={styles.radioDot}>✓</Text> : null}
                </View>
              </Row>
            </Card>
          ))}
        </Screen>
      ) : null}

      {phase === 'play' && game === 'draw' ? (
        <DrawGame
          players={players}
          nameOf={nameOf}
          onDone={(id) => {
            setLoserId(id);
            setPhase('result');
          }}
        />
      ) : null}

      {phase === 'play' && game === 'bomb' ? (
        <BombGame
          players={players}
          nameOf={nameOf}
          onDone={(id) => {
            setLoserId(id);
            setPhase('result');
          }}
        />
      ) : null}

      {phase === 'result' ? (
        <Screen
          scroll={false}
          footer={
            <>
              <PrimaryButton label="🔁 한 판 더" onPress={startAgain} />
              <PrimaryButton
                label="닫기"
                variant="ghost"
                onPress={() => router.back()}
              />
            </>
          }
        >
          <View style={styles.resultWrap}>
            <Text style={styles.resultBoom}>💥</Text>
            <Text style={styles.resultName}>{loserId ? nameOf(loserId) : '?'}</Text>
            <Text style={styles.resultLabel}>당첨! 몰빵이에요</Text>
            <Text style={styles.resultHint}>
              이 판은 {loserId ? nameOf(loserId) : '?'}님이 내는 걸로 🫡
            </Text>
          </View>
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
  onDone: (loserId: PersonId) => void;
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
        <Text style={styles.playTitle}>🃏 카드를 한 장씩 뒤집어요</Text>
        <Text style={styles.playSub}>💣을 뒤집은 사람이 당첨!</Text>
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
                  <Text style={styles.cardFace}>{isBomb ? '💣' : '😌'}</Text>
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
  onDone: (loserId: PersonId) => void;
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
        <Text style={styles.bombEmoji}>🧨</Text>
        <Text style={styles.bombHolder}>{nameOf(players[holder])}</Text>
        <Text style={styles.bombHint}>지금 들고 있어요 — 빨리 넘겨요!</Text>
      </View>
      <View style={{ padding: spacing.lg, paddingBottom: spacing.xl }}>
        <PrimaryButton label="넘기기 →" onPress={pass} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  betTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.text },
  betSub: { fontSize: fontSize.sm, color: colors.subtext },
  gameLabel: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  gameDesc: { fontSize: fontSize.sm, color: colors.subtext, marginTop: 2 },
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
  radioDot: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  playTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  playSub: { fontSize: fontSize.sm, color: colors.subtext },
  playHint: {
    fontSize: fontSize.sm,
    color: colors.subtext,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
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
  cardBack: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  cardSafe: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  cardBomb: { backgroundColor: colors.dangerDim, borderWidth: 1, borderColor: colors.danger },
  cardFace: { fontSize: 40 },
  cardName: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text },

  bombWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  bombEmoji: { fontSize: 96 },
  bombHolder: { fontSize: fontSize.xl, fontWeight: '800', color: colors.text },
  bombHint: { fontSize: fontSize.md, color: colors.danger, fontWeight: '600' },

  resultWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  resultBoom: { fontSize: 80 },
  resultName: { fontSize: fontSize.xl, fontWeight: '800', color: colors.danger },
  resultLabel: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  resultHint: { fontSize: fontSize.sm, color: colors.subtext, marginTop: spacing.sm },
});
