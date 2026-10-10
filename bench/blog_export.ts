/**
 * Blog export: writes the recorded-hand replays and the figure numbers for the
 * kylejohnson.ai post (PersonalWebsite `nuxt-app/app/data/holdem/`).
 *
 *   node bench/blog_export.ts --source v1 --out ../PersonalWebsite/nuxt-app/app/data/holdem
 *
 * --source v1  B3 run (data/runs/20261010_main.jsonl), the B4 lab and the B5 notebook
 *              outputs (internal_docs/20261009_holdem_vs_models/findings/notebook/out/).
 * --source v2  The v2 study (internal_docs/20261011_v2_fairness/): Study A run files
 *              (data/runs/20261011_v2A_{sol,opus,fable}.jsonl), Study B (personas on Luna,
 *              data/runs/20261011_v2B_luna.jsonl, and on Sol, 20261012_v2B_sol.jsonl) and
 *              out/{standings,styles_raw,personas,personas_sol,talk}.json. Replays use HANDS_V2; figures
 *              and facts come from buildFiguresV2() (prize share, personas, the v2 talk test).
 *              The post is v2-only, so v2 facts carry no v1 numbers.
 *
 * Outputs (each must stay under 150 KB):
 *   replays.json  { source, hands: { [id]: ReplayHand } }
 *   figures.json  v1: { source, standings, personalities, talk, lab, facts }
 *                 v2: { source, standings, guestPairs, personalities, talk, personas, personasSol, facts }
 *
 * The post reads every number from figures.json (`facts` for prose, the rest for
 * figures). Strings are cleaned of em and en dashes (the site bans them).
 * No model calls; this only reads files.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the notebook outputs are untyped JSON */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    source: { type: 'string', default: 'v1' },
    out: { type: 'string', default: '../PersonalWebsite/nuxt-app/app/data/holdem' }
  }
})

const ROOT = resolve(import.meta.dirname, '..')
const MAX_BYTES = 150 * 1024

// ---------- names ----------

const SHORT: Record<string, string> = {
  'openai/gpt-6-sol': 'Sol',
  'openai/gpt-6-luna': 'Luna',
  'openai/gpt-6-luna-decisions': 'Luna Decisions',
  'anthropic/claude-haiku-5.5': 'Haiku',
  'typesafe-ai/jev': 'Jev',
  'anthropic/claude-opus-5.5': 'Opus',
  'anthropic/claude-fable-5.1': 'Fable'
}
const FULL: Record<string, string> = {
  'openai/gpt-6-sol': 'GPT-6 Sol',
  'openai/gpt-6-luna': 'GPT-6 Luna',
  'openai/gpt-6-luna-decisions': 'GPT-6 Luna Decisions',
  'anthropic/claude-haiku-5.5': 'Claude Haiku 5.5',
  'typesafe-ai/jev': 'Jev',
  'anthropic/claude-opus-5.5': 'Claude Opus 5.5',
  'anthropic/claude-fable-5.1': 'Claude Fable 5.1'
}
const KIND: Record<string, 'words' | 'decision'> = {
  'openai/gpt-6-sol': 'words',
  'openai/gpt-6-luna': 'words',
  'openai/gpt-6-luna-decisions': 'decision',
  'anthropic/claude-haiku-5.5': 'words',
  'typesafe-ai/jev': 'decision',
  'anthropic/claude-opus-5.5': 'words',
  'anthropic/claude-fable-5.1': 'words'
}
// Display order everywhere: by result (v1: bb/100; v2: prize share in Study A)
const ORDER_V1 = ['openai/gpt-6-sol', 'openai/gpt-6-luna', 'openai/gpt-6-luna-decisions', 'anthropic/claude-haiku-5.5', 'typesafe-ai/jev']
const ORDER_V2 = ['openai/gpt-6-sol', 'anthropic/claude-opus-5.5', 'openai/gpt-6-luna', 'anthropic/claude-haiku-5.5', 'openai/gpt-6-luna-decisions', 'anthropic/claude-fable-5.1', 'typesafe-ai/jev']
const ORDER = args.source === 'v2' ? ORDER_V2 : ORDER_V1

// ---------- helpers ----------

/** Strip em/en dashes and tidy whitespace; the site's copy rules ban both dashes. */
function clean(s: string): string {
  return s
    .replace(/\s*—\s*/g, ', ')
    .replace(/(\d)\s*–\s*(\d)/g, '$1 to $2')
    .replace(/\s*–\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
}
const r0 = (n: number) => Math.round(n)
const r1 = (n: number) => Math.round(n * 10) / 10
const signed = (n: number) => (n > 0 ? '+' : n < 0 ? '-' : '') + Math.abs(r0(n)).toLocaleString('en-US')
const pct = (n: number) => `${r0(n)}%`
const num = (n: number) => r0(n).toLocaleString('en-US')
const usd = (n: number) => `$${n.toFixed(2)}`

/** "two out of three", "one in five": the nearest simple fraction, for plain-words copy. */
function inWords(p: number): string {
  const words = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
  let best = { a: 1, b: 2, err: 9 }
  for (let b = 2; b <= 10; b++) {
    for (let a = 1; a < b; a++) {
      const err = Math.abs(a / b - p / 100)
      if (err < best.err - 0.004) best = { a, b, err }
    }
  }
  const { a, b } = best
  if (a === 1 && b === 2) return 'half'
  const of = a === 1 ? 'in' : 'out of'
  return `${words[a]} ${of} ${words[b]}`
}

// Poker words in the models' own reasoning, glossed in brackets at first use per hand.
// Longest phrases first so "top two pair" wins over "top pair".
const GLOSS: [RegExp, string][] = [
  [/\btop two pair\b/i, 'pairs with the two highest cards on the table'],
  [/\btop set\b/i, 'three of a kind using a pair in hand'],
  [/\btop pair\b/i, 'a pair with the highest card on the table'],
  [/\boverpair\b/i, 'a pair in hand above every card on the table'],
  [/\bbluff-catcher\b/i, 'a hand that only beats a bluff'],
  [/\bgutshot straight draw\b/i, 'one specific card short of a straight'],
  [/\bflush draws?\b/i, 'one card short of a flush'],
  [/\bdiamond draws\b/i, 'hands one diamond short of a flush'],
  [/\b(?:nearly )?the nuts\b/i, 'the best possible hand'],
  [/\bkicker\b/i, 'side card, which breaks ties'],
  [/\bqueens full\b/i, 'a full house'],
  [/\bmade hand\b/i, 'a finished hand'],
  [/\bmade flush\b/i, 'a finished flush, not one still waiting on a card'],
  [/\bpocket (?:kings|queens|jacks|tens|nines|eights|sevens|sixes|fives|fours|threes|twos|aces|pair)\b/i, 'a pair in its own two cards'],
  [/\ba set\b/i, 'three of a kind using a pair in hand'],
  [/\bshove\b/i, 'all-in bet'],
  [/(?<!raising )\brange\b/i, 'the hands it might hold'],
  [/\boffsuit\b/i, 'two different suits'],
  [/\bsuited\b/i, 'both the same suit'],
  [/\bearly position\b/i, 'among the first to act'],
  [/\bout of position\b/i, 'having to act first'],
  [/\bvalue-bet\b/i, 'bet so that worse hands pay'],
  [/\bfor value\b/i, 'so that worse hands pay'],
  [/\bconnected board\b/i, 'shared cards close in rank'],
  [/\bdry flop\b/i, 'one that helps few hands'],
  [/\bthin the field\b/i, 'push other players out'],
  [/\blimper\b/i, 'a player who only called the big blind'],
  [/\bisolate\b/i, 'get them alone'],
  [/\bquads\b/i, 'four of a kind'],
  [/\btrips\b/i, 'three of a kind'],
  [/\braising range\b/i, 'the hands it would raise with'],
  [/\bSB\b/, 'the small blind'],
  [/\bon the bubble\b|\bthe bubble\b/i, 'one more knockout and everyone left gets paid'],
  [/\bc-bet\b/i, 'a follow-up bet by the player who raised before the flop'],
  [/\bisolation raise\b/i, 'a raise to get one weak player alone'],
  [/\b3-bet\b/i, 're-raise'],
  [/\bshowdown value\b/i, 'a chance of winning if nobody bets'],
  [/\bequity\b/i, 'share of the pot it would win on average'],
  [/\bpot odds\b/i, 'the price of a call compared with the pot'],
  [/\bin position\b/i, 'acting after the other player'],
  [/\b(?:a )?station\b/i, 'a player who calls almost every bet'],
  [/\bdead money\b/i, 'chips already in from players who folded'],
  [/\bgutshot\b/i, 'one specific card short of a straight'],
  [/\bladder\b/i, 'move up a paid place'],
  [/\bUTG\b/, 'first-to-act'],
  [/\bearly-position\b/i, 'from one of the first seats to act'],
  [/\braised light\b/i, 'raised with a weak hand'],
  [/\bmarginal hand\b/i, 'a borderline hand'],
  [/\b(?:draw-heavy|very coordinated) board\b/i, 'shared cards that make straights and flushes likely'],
  [/\boverpairs\b/i, 'pairs higher than any shared card'],
  [/\bshort-stack limp\b/i, 'a call of the big blind from a player low on chips'],
  [/\bisolation spot\b/i, 'a chance to get one weak player alone'],
  [/\breshove\b/i, 'go all-in over a raise'],
  [/\bthree-handed\b/i, 'with three players left'],
  [/\bthree-way\b/i, 'with three players in the hand'],
  [/\bseven-deuce\b/i, 'a seven and a two'],
  [/\bboard is paired\b|\bpaired board\b/i, 'two shared cards of the same rank'],
  [/\bcalls down light\b/i, 'calls bets to the end with weak hands'],
  [/\bfree card\b/i, 'next card without paying'],
  [/\boverc?card\b/i, 'a card higher than any on the table'],
  [/\blimp-called\b/i, 'called the big blind, then called a raise'],
  [/\b(?:[KQJA]|king|ace)-high\b/i, 'no pair, that card the highest'],
  [/\bchecked through\b/i, 'had nobody bet'],
  [/\bbets pot\b/i, 'bets the size of the pot'],
  [/\bcommits most of my stack\b/i, 'would take most of my chips'],
  [/\bcutoff\b/i, 'the seat just before the last to act'],
  [/\bthe wheel\b/i, 'the lowest straight, ace to five'],
  [/\bre-?raise\b/i, 'raise again'],
  [/\bopen to around 3x\b/i, 'first raise to about three big blinds'],
  [/\bjamming\b|\bjam\b/i, 'going all-in'],
  [/\bpreflop\b/i, 'before the flop'],
  [/\bbutton\b/i, 'the seat that acts last']
]
const SUIT_GLYPH: Record<string, string> = { s: '\u2660\uFE0E', h: '\u2665\uFE0E', d: '\u2666\uFE0E', c: '\u2663\uFE0E' }
/** "Ad Qd" -> "A♦ Q♦" (text presentation, so iOS doesn't draw emoji) */
const rankWord = (r: string) => (r === 'T' ? '10' : r)
const cardWords = (t: string) => t
  .replace(/\b([2-9TJQKA])([shdc])\b/g, (_, r: string, su: string) => `${rankWord(r)}${SUIT_GLYPH[su]}`)
  // poker shorthand: "A3o", "KJs", "QTs" -> "A-3 offsuit", "K-J suited" (glossed below)
  .replace(/\b([2-9TJQKA])([2-9TJQKA])([so])\b/g, (_, a: string, b: string, k: string) => `${rankWord(a)}-${rankWord(b)} ${k === 's' ? 'suited' : 'offsuit'}`)
  .replace(/\b([2-9TJQKA])\1\b/g, (_, a: string) => `${rankWord(a)}-${rankWord(a)}`)
function gloss(text: string, used: Set<string>): string {
  let out = text
  for (const [re, plain] of GLOSS) {
    if (used.has(re.source)) continue
    const m = out.match(re)
    if (!m || m.index === undefined) continue
    used.add(re.source)
    const end = m.index + m[0].length
    out = `${out.slice(0, end)} [${plain}]${out.slice(end)}`
  }
  return out
}

function firstSentences(text: string, pick: number | 'last' = 0): string {
  // Split after . ! ? followed by a space, so "7.6 big blinds" stays in one sentence
  const parts = clean(text).split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean)
  return pick === 'last' ? parts[parts.length - 1]! : (parts[pick] ?? parts[0]!)
}

function readJson<T = any>(p: string): T {
  return JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as T
}

// ---------- input shape (shared by v1 and v2) ----------

type Card = string
type LogEntry = { seatId: string, street: string, action: { type: string, to?: number }, added: number, tableTalk?: string }
type Decision = { logIndex: number, seatId: string, decision: { reasoning?: string, probabilities?: Record<string, number>, model: string } }
type HandRec = {
  tournamentId: string
  handNo: number
  smallBlind: number
  bigBlind: number
  blinds: string
  seats: { id: string, name: string, modelId: string }[]
  holes: Record<string, Card[]>
  board: Card[]
  log: LogEntry[]
  actionLabels: string[]
  decisions: Decision[]
  result: { pots: { amount: number, winners: string[], handName: string }[], shown: Record<string, { handName: string }>, deltas: Record<string, number> }
  stacksBefore: Record<string, number>
  stacksAfter: Record<string, number>
}

type Input = {
  source: 'v1' | 'v2'
  /** Tournament structure from the run's run_start record */
  structure: { stack: number, levels: { sb: number, bb: number, hands: number }[], maxHands: number }
  /** How each tournament ended ('finished' or the hand cap) */
  endings: string[]
  hands: (ids: Set<string>) => Map<string, HandRec>
  out: Record<string, any>
}

function loadV1(): Input {
  const OUT = 'internal_docs/20261009_holdem_vs_models/findings/notebook/out'
  const names = ['main_official', 'allin_main', 'breadth', 'talk', 'fable', 'extras', 'bets', 'probe', 'lab_official', 'reasoning']
  const out: Record<string, any> = {}
  for (const n of names) out[n] = readJson(`${OUT}/${n}.json`)
  const lines = readFileSync(join(ROOT, 'data/runs/20261010_main.jsonl'), 'utf8').split('\n')
  return {
    source: 'v1',
    structure: JSON.parse(lines[0]!).tournament,
    endings: lines.filter(l => l.startsWith('{"type":"tournament"')).map(l => JSON.parse(l).reason as string),
    out,
    hands(ids) {
      const found = new Map<string, HandRec>()
      const text = readFileSync(join(ROOT, 'data/runs/20261010_main.jsonl'), 'utf8')
      for (const line of text.split('\n')) {
        if (!line.startsWith('{"type":"hand"')) continue
        const h = JSON.parse(line) as HandRec
        const id = `${h.tournamentId}-${h.handNo}`
        if (ids.has(id)) found.set(id, h)
      }
      return found
    }
  }
}

const V2_DIR = 'internal_docs/20261011_v2_fairness'
const V2_TABLES = ['sol', 'opus', 'fable'] as const
/** Replay ids on v2 carry the table: "opus-m01-r0-11" = the Opus table, tournament m01-r0, hand 11. */
const v2Key = (table: string, h: { tournamentId: string, handNo: number }) => `${table}-${h.tournamentId}-${h.handNo}`

function runLines(slug: string): any[] {
  return readFileSync(join(ROOT, `data/runs/${slug}.jsonl`), 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
}

function loadV2(): Input {
  const out: Record<string, any> = {
    standings: readJson(`${V2_DIR}/out/standings.json`),
    styles: readJson(`${V2_DIR}/out/styles_raw.json`),
    personas: readJson(`${V2_DIR}/out/personas.json`),
    personasSol: readJson(`${V2_DIR}/out/personas_sol.json`),
    talk: readJson(`${V2_DIR}/out/talk.json`)
  }
  // Ops (hands, decisions, fallbacks, cost) straight from the run files' tournament lines
  const ops = (slug: string) => {
    const lines = runLines(slug)
    const ts = lines.filter(l => l.type === 'tournament')
    return {
      tournaments: ts.length,
      hands: ts.reduce((a, t) => a + t.hands, 0),
      decisions: ts.reduce((a, t) => a + t.decisions, 0),
      fallbacks: ts.reduce((a, t) => a + t.fallbacks, 0),
      cost: ts.reduce((a, t) => a + (t.costUsd ?? 0), 0),
      handCounts: ts.map(t => t.hands as number),
      start: lines.find(l => l.type === 'run_start')
    }
  }
  out.opsA = Object.fromEntries(V2_TABLES.map(t => [t, ops(`20261011_v2A_${t}`)]))
  out.opsB = ops('20261011_v2B_luna')
  out.opsBSol = ops('20261012_v2B_sol')
  const start = out.opsA.sol.start
  return {
    source: 'v2',
    structure: start.tournament,
    endings: V2_TABLES.flatMap(t => runLines(`20261011_v2A_${t}`).filter(l => l.type === 'tournament').map(l => l.reason as string)),
    out,
    hands(ids) {
      const found = new Map<string, HandRec>()
      for (const t of V2_TABLES) {
        for (const line of readFileSync(join(ROOT, `data/runs/20261011_v2A_${t}.jsonl`), 'utf8').split('\n')) {
          if (!line.startsWith('{"type":"hand"')) continue
          const h = JSON.parse(line) as HandRec
          const id = v2Key(t, h)
          if (ids.has(id)) found.set(id, h)
        }
      }
      return found
    }
  }
}

// ---------- replays ----------

type Beat = {
  /** Apply the log through this index (inclusive). */
  upto: number
  caption: string
  /** Reasoning shown beside the caption: a log index whose decision to quote, or a fixed note. */
  why?: { log: number, sentence?: number | 'last' } | { note: string }
  /** Show the board as of this street even if no action has happened on it yet. */
  street?: 'flop' | 'turn' | 'river'
  /** Seats whose cards are face up at this beat (showdown or a reveal). */
  reveal?: 'all' | string[]
  /** Final beat: stacks after the hand, winner labelled. */
  result?: boolean
}
type HandPick = { id: string, title: string, focus: string, beats: Beat[] }

// Curated for v1. Captions are written for a reader who has never played poker.
const HANDS_V1: HandPick[] = [
  {
    id: 'm04-r4-4',
    title: 'Same cards, five players',
    focus: 'openai/gpt-6-sol',
    beats: [
      { upto: 0, caption: 'Sol is dealt the ace of diamonds and the queen of spades, a strong start. It is first to bet and raises.', why: { log: 0 } },
      { upto: 4, caption: 'Haiku, Luna and Jev all pay to see the first shared cards. Luna Decisions folds.' },
      { upto: 9, caption: 'The flop brings a queen, so Sol has a pair of queens with an ace beside it. It bets half the pot and everyone calls.', why: { log: 6 } },
      { upto: 14, caption: 'An ace on the turn gives Sol two pair, aces and queens. It bets again. Haiku and Luna give up; Jev calls.' },
      { upto: 15, caption: 'On the river Jev pushes all its chips in.', street: 'river' },
      { upto: 16, caption: 'Sol calls with two pair. Jev had one pair of aces. Sol takes the 3,670-chip pot, 2,055 more than it put in.', why: { log: 16 }, reveal: 'all', result: true }
    ]
  },
  {
    id: 'm07-r4-2',
    title: 'Luna folds the better flush',
    focus: 'openai/gpt-6-luna',
    beats: [
      { upto: 8, caption: 'Luna holds two jacks and raises before the flop. Haiku calls with the ten and four of diamonds.' },
      { upto: 11, caption: 'The flop. Luna bets and Haiku calls.', why: { log: 10 } },
      { upto: 13, caption: 'The turn puts three diamonds on the board. Both players check.', why: { log: 13 } },
      { upto: 14, caption: 'The river is the ace of diamonds. Now four of the shared cards are diamonds, so anyone holding one more diamond has a flush (five cards of one suit). Haiku bets 300 into a 600 pot.', why: { log: 14 } },
      { upto: 15, caption: 'Luna folds. Haiku takes the pot without having to show its cards. (The logs recorded every card, so we can look.)', why: { log: 15 } },
      { upto: 15, caption: 'Luna had the jack of diamonds, so it held a flush too. When two players both have a flush, the higher cards win, and Luna\'s jack beat Haiku\'s ten. Luna threw away the winning hand. Haiku was wrong too: it thought no better flush was possible.', reveal: ['openai/gpt-6-luna', 'anthropic/claude-haiku-5.5'], result: true }
    ]
  },
  {
    id: 'm01-r2-8',
    title: 'Kings again, Jev',
    focus: 'anthropic/claude-haiku-5.5',
    beats: [
      { upto: 2, caption: 'Jev raises before the flop with an ace and a queen.', why: { log: 2 } },
      { upto: 4, caption: 'Haiku raises on top of Jev\'s raise and says out loud exactly what it holds: two kings. Every seat was told never to hint at its cards.', why: { log: 4 } },
      { upto: 5, caption: 'Jev calls anyway.', why: { log: 5 } },
      { upto: 7, caption: 'The flop has no ace or queen for Jev. Haiku bets and says the kings are still good. Jev calls.', why: { log: 6 } },
      { upto: 9, caption: 'A king on the turn gives Haiku three of them. It bets again. Jev, with no pair at all, calls again.', why: { log: 9 } },
      { upto: 11, caption: 'The river is a second nine, so Haiku has a full house (three kings and two nines). Jev pays to the end and loses 915 chips to a player that named its cards on the first bet.', reveal: 'all', result: true }
    ]
  },
  {
    id: 'm06-r0-14',
    title: 'Haiku\'s phantom full house',
    focus: 'anthropic/claude-haiku-5.5',
    beats: [
      { upto: 4, caption: 'Haiku raises with two fives and announces them: "Pocket fives in early position." Sol, who already has the big blind in, calls the rest.', why: { log: 0 } },
      { upto: 6, caption: 'The flop is two sixes and a two. Sol checks. Haiku bets, and its reasoning says it has a full house.', why: { log: 6 } },
      { upto: 7, caption: 'It does not. Two fives plus two sixes on the board is two pair. Sol raises: it holds the third six, so it has three of a kind.', why: { log: 7 } },
      { upto: 8, caption: 'One decision later Haiku has it right: "two pair, fives and sixes." It calls anyway.', why: { log: 8 } },
      { upto: 12, caption: 'Sol bets the turn and pushes all-in on the river. Haiku folds and loses 710 chips.', why: { log: 12 }, reveal: 'all', result: true }
    ]
  },
  {
    id: 'm06-r4-11',
    title: 'Sol believes Haiku has a king',
    focus: 'openai/gpt-6-sol',
    beats: [
      { upto: 4, caption: 'Sol raises with a jack and a ten. Haiku calls with a king and a five.' },
      { upto: 5, caption: 'The flop brings a king and an ace. Sol bets half the pot anyway.', why: { log: 5 } },
      { upto: 6, caption: 'Haiku calls and announces: "Kings on the board, and I\'m holding one." This time it is true.', why: { log: 6 } },
      { upto: 8, caption: 'Sol checks the turn. Haiku bets.' },
      { upto: 9, caption: 'Sol folds, and its reasoning cites what Haiku said. In 15,913 decisions this is the only time any AI used an opponent\'s talk.', why: { log: 9, sentence: 'last' }, reveal: 'all', result: true }
    ]
  },
  {
    id: 'm04-r0-35',
    title: 'Sol pushes with a short stack',
    focus: 'openai/gpt-6-sol',
    beats: [
      { upto: 0, caption: 'Hand 35. The blinds are now 80 and 160, eight times where they started. Every stack at the table is short.' },
      { upto: 1, caption: 'Luna Decisions has about five and a half big blinds left and an ace with a seven. It just calls.', why: { log: 1 } },
      { upto: 3, caption: 'Sol, with about seven big blinds and two nines, pushes all of it in.', why: { log: 3 } },
      { upto: 5, caption: 'Everyone folds. Sol wins the forced bets and Luna Decisions\' call without anyone seeing another card.', reveal: 'all', result: true }
    ]
  }
]

// Curated for v2 (Study A). The first five are in the post body; the last two are the live
// table's closed-state replays (CLOSED_V2), so nothing a reader sees twice.
const HANDS_V2: HandPick[] = [
  {
    id: 'fable-m02-r1-6',
    title: 'Same cards, three guests',
    focus: 'anthropic/claude-fable-5.1',
    beats: [
      { upto: 1, caption: 'Fable holds the ace of hearts and the ten of clubs. Jev raises before the flop, and Fable calls.', why: { log: 1 } },
      { upto: 4, caption: 'Everyone else folds. It\'s Fable against Jev.' },
      { upto: 6, caption: 'The flop brings a ten. Fable has a pair of tens with an ace beside it, the best pair it can hold here. Jev bets the size of the pot, and Fable calls.', why: { log: 6 } },
      { upto: 7, caption: 'The turn. Jev bets the size of the pot again.', why: { log: 7 } },
      { upto: 8, caption: 'Fable folds its pair. Jev had an ace and a king: no pair at all. Fable gave up the better hand.', why: { log: 8 }, reveal: 'all', result: true }
    ]
  },
  {
    id: 'opus-m01-r0-11',
    title: 'Opus waits out the bubble',
    focus: 'anthropic/claude-opus-5.5',
    beats: [
      { upto: 0, caption: 'Four players are left and three get paid, so the next player knocked out leaves with nothing. Poker players call this the bubble. Jev, almost out of chips, calls the big blind.', why: { log: 0 } },
      { upto: 1, caption: 'Opus raises with an ace and a three, hoping to get Jev alone.', why: { log: 1 } },
      { upto: 2, caption: 'Luna, also short on chips, pushes all-in with two sevens.', why: { log: 2 } },
      { upto: 4, caption: 'Luna Decisions folds. Jev calls with everything it has left.' },
      { upto: 5, caption: 'Opus folds. Two players low on chips are all-in against each other, and if one is knocked out, Opus is paid without risking another chip.', why: { log: 5, sentence: 'last' } },
      { upto: 5, caption: 'Jev\'s queen pairs on the turn and beats Luna\'s sevens. Nobody is out yet, and Opus still has 1,778 chips.', reveal: 'all', result: true }
    ]
  },
  {
    id: 'sol-m01-r2-33',
    title: 'Luna pushes, Sol lets it go',
    focus: 'openai/gpt-6-luna',
    beats: [
      { upto: 0, caption: 'Three players are left, and all three are already paid. What\'s left to play for is the order. The blinds are 80 and 160. Haiku raises.', why: { log: 0 } },
      { upto: 1, caption: 'Luna has about seven and a half big blinds. With a king and a jack, it pushes all-in instead of waiting for the blinds to eat its chips.', why: { log: 1 } },
      { upto: 2, caption: 'Sol folds a seven and a two. Its reasoning notes that it is already paid.', why: { log: 2, sentence: 'last' } },
      { upto: 3, caption: 'Haiku calls with a king and a four.', why: { log: 3 } },
      { upto: 3, caption: 'Luna pairs its jack, and two eights on the board give it two pair. It more than doubles, to 2,612 chips.', reveal: 'all', result: true }
    ]
  },
  {
    id: 'opus-m02-r3-12',
    title: 'Haiku\'s phantom set',
    focus: 'anthropic/claude-haiku-5.5',
    beats: [
      { upto: 4, caption: 'Luna raises. Opus folds an ace and a two. Haiku has two queens and raises again, repeating Luna\'s line word for word.', why: { log: 4 } },
      { upto: 5, caption: 'Luna calls with an ace and a five.', why: { log: 5 } },
      { upto: 6, caption: 'The flop is an ace, a two and a jack. Haiku\'s reasoning says it has a set, three queens. It has two, and the ace on the table means any ace beats it.', why: { log: 6 } },
      { upto: 7, caption: 'Luna, holding an ace, calls.', why: { log: 7 } },
      { upto: 9, caption: 'Haiku bets again on the turn, still describing three of a kind it doesn\'t have. Luna calls.' },
      { upto: 11, caption: 'On the river Haiku finally reads it right ("a pair") and checks. Luna\'s aces win, and Haiku loses 557 chips.', why: { log: 10 }, reveal: 'all', result: true }
    ]
  },
  {
    id: 'fable-m01-r1-11',
    title: 'Fable remembers Jev',
    focus: 'anthropic/claude-fable-5.1',
    beats: [
      { upto: 1, caption: 'Jev just calls the big blind. Fable raises with an ace and an eight, and its reasoning already uses what it remembers about Jev.', why: { log: 1 } },
      { upto: 5, caption: 'Haiku calls. Luna and Luna Decisions fold, and Jev calls the raise.' },
      { upto: 8, caption: 'Nobody bets the flop. Fable checks too, citing how Haiku has played in earlier hands.', why: { log: 7 } },
      { upto: 12, caption: 'On the turn Fable bets half the pot. Haiku folds; Jev calls.', why: { log: 10 } },
      { upto: 14, caption: 'On the river Fable checks, and its reasoning cites a hand from earlier in the game in which Jev called every bet with only a king.', why: { log: 14 } },
      { upto: 14, caption: 'Both have only an ace. Fable\'s eight beats Jev\'s three, and Fable takes the 780-chip pot.', reveal: 'all', result: true }
    ]
  },
  {
    id: 'opus-m01-r1-15',
    title: 'Opus knocks out two at once',
    focus: 'anthropic/claude-opus-5.5',
    beats: [
      { upto: 2, caption: 'Jev and Luna Decisions just call the big blind. Opus, the biggest stack, raises with the queen and ten of spades.', why: { log: 2 } },
      { upto: 6, caption: 'All four others call. Five players see the flop.' },
      { upto: 11, caption: 'The flop has a queen, so Opus has a pair of queens. Everyone checks to Opus, and it bets a third of the pot.', why: { log: 11 } },
      { upto: 15, caption: 'Haiku and Luna call. The two decision models fold.' },
      { upto: 18, caption: 'A ten on the turn gives Opus two pair. It pushes all-in.', why: { log: 18 } },
      { upto: 20, caption: 'Haiku and Luna both call with what\'s left of their chips.', why: { log: 19 } },
      { upto: 20, caption: 'Neither catches up. Opus\'s two pair wins both pots, Haiku and Luna are out of the tournament, and Opus has 5,386 chips.', reveal: 'all', result: true }
    ]
  },
  {
    id: 'fable-m01-r0-24',
    title: 'Fable\'s queens',
    focus: 'anthropic/claude-fable-5.1',
    beats: [
      { upto: 0, caption: 'The blinds are 40 and 80. Fable has two queens and about 12 big blinds, and raises.', why: { log: 0 } },
      { upto: 1, caption: 'Luna raises again with the ace and king of hearts.', why: { log: 1 } },
      { upto: 4, caption: 'The others fold, and Fable puts in the rest of its chips: the textbook play with queens and a short stack.', why: { log: 4 } },
      { upto: 5, caption: 'Luna calls.', why: { log: 5 } },
      { upto: 5, caption: 'A king and an ace both come. Luna wins, and Fable is out in fourth place. The same deal knocked Opus out the same way at its own table.', reveal: 'all', result: true }
    ]
  }
]
/** The live table's closed states show these (watch, play); they're not in the post body. */
const CLOSED_V2 = { watch: 'opus-m01-r1-15', play: 'fable-m01-r0-24' }

const STREET_CARDS: Record<string, number> = { preflop: 0, flop: 3, turn: 4, river: 5 }

const MENU_WORDS: Record<string, string> = {
  fold: 'fold',
  check: 'check',
  call: 'call',
  raise_min: 'small raise',
  raise_half_pot: 'raise half the pot',
  raise_pot: 'raise the pot',
  raise_2x_pot: 'raise twice the pot',
  raise_third_pot: 'raise a third of the pot',
  raise_3q_pot: 'raise three quarters of the pot',
  raise_1_5x_pot: 'raise one and a half pots',
  raise_to: 'raise',
  all_in: 'all-in'
}

function whyText(h: HandRec, w: Beat['why'], used: Set<string>): { who: string, text: string } | undefined {
  if (!w) return undefined
  if ('note' in w) return { who: 'findings', text: clean(w.note) }
  const d = h.decisions.find(x => x.logIndex === w.log)
  if (!d) throw new Error(`no decision at log ${w.log} in ${h.tournamentId} #${h.handNo}`)
  const model = d.decision.model
  const who = SHORT[model]!
  if (KIND[model] === 'decision' && d.decision.probabilities) {
    const top = Object.entries(d.decision.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3)
    return { who, text: `How likely it was to pick each move: ${top.map(([k, p]) => `${MENU_WORDS[k] ?? k} ${Math.round(p * 100)}%`).join(', ')}.` }
  }
  return { who, text: gloss(cardWords(firstSentences(d.decision.reasoning ?? '', w.sentence ?? 0)), used) }
}

const GUEST_TABLE: Record<string, string> = { sol: 'Sol\'s table, ', opus: 'Opus\'s table, ', fable: 'Fable\'s table, ' }

function buildReplay(h: HandRec, pick: HandPick) {
  const seatModel = new Map(h.seats.map(s => [s.id, s.modelId]))
  // Seats in the hand (busted seats have no cards)
  const live = h.seats.filter(s => (h.holes[s.id] ?? []).length === 2)
  // Slot 0 (bottom of the felt) is the focus seat, then clockwise in table order
  const focusIdx = live.findIndex(s => s.modelId === pick.focus)
  const ordered = [...live.slice(focusIdx), ...live.slice(0, focusIdx)]

  const blindPosted: Record<string, number> = {}
  for (const m of h.blinds.matchAll(/([^·]+?) posts (small|big) blind (\d+)/g)) {
    const seat = h.seats.find(s => s.name === m[1]!.trim())
    if (seat) blindPosted[seat.id] = (blindPosted[seat.id] ?? 0) + Number(m[3])
  }

  const seats = ordered.map((s, slot) => ({
    key: s.modelId,
    name: SHORT[s.modelId] ?? s.name,
    slot,
    hole: h.holes[s.id]
  }))

  let prevUpto = -1
  const used = new Set<string>()
  const steps = pick.beats.map((b) => {
    const lastStreet = h.log[b.upto]!.street
    const street = b.street ?? lastStreet
    let pot = Object.values(blindPosted).reduce((a, x) => a + x, 0)
    const put: Record<string, number> = { ...blindPosted }
    const folded = new Set<string>()
    const lastLabel: Record<string, string> = {}
    for (let i = 0; i <= b.upto; i++) {
      const l = h.log[i]!
      pot += l.added
      put[l.seatId] = (put[l.seatId] ?? 0) + l.added
      if (l.action.type === 'fold') folded.add(l.seatId)
      // Only this street's action labels show; earlier streets read oddly
      if (l.street !== street && !folded.has(l.seatId)) continue
      // "calls 40" counts only the chips added, which reads wrong after a raise to 80
      lastLabel[l.seatId] = l.action.type === 'call' && !/all-in/.test(h.actionLabels[i]!) ? 'calls' : h.actionLabels[i]!
    }
    const talk: Record<string, string> = {}
    for (let i = prevUpto + 1; i <= b.upto; i++) {
      const l = h.log[i]!
      if (l.tableTalk) talk[l.seatId] = cardWords(clean(l.tableTalk))
    }
    const actor = h.log[b.upto]!.seatId
    const state: Record<string, { stack: number, action?: string, folded?: boolean, talk?: string, active?: boolean }> = {}
    for (const s of ordered) {
      const sid = s.id
      let stack = h.stacksBefore[sid]! - (put[sid] ?? 0)
      let action = folded.has(sid) ? 'folded' : lastLabel[sid]
      if (b.result) {
        stack = h.stacksAfter[sid]!
        const won = h.result.pots.filter(p => p.winners.includes(sid)).reduce((a, p) => a + p.amount, 0)
        if (won > 0) action = `wins ${won.toLocaleString('en-US')}`
        else if (h.result.shown[sid]) action = h.result.shown[sid]!.handName.toLowerCase()
      }
      state[seatModel.get(sid)!] = {
        stack,
        ...(action ? { action: clean(action) } : {}),
        ...(folded.has(sid) ? { folded: true } : {}),
        ...(talk[sid] ? { talk: talk[sid] } : {}),
        ...(!b.result && sid === actor ? { active: true } : {})
      }
    }
    prevUpto = b.upto
    const reveal = b.reveal === 'all' ? seats.map(s => s.key) : (b.reveal ?? [])
    const why = whyText(h, b.why, used)
    return {
      street,
      board: STREET_CARDS[street] ?? 0,
      pot,
      seats: state,
      caption: clean(b.caption),
      ...(why ? { why } : {}),
      ...(reveal.length ? { reveal } : {})
    }
  })

  return {
    id: pick.id,
    label: `${GUEST_TABLE[pick.id.split('-')[0]!] ?? ''}${GUEST_TABLE[pick.id.split('-')[0]!] ? 'match' : 'Match'} ${Number(h.tournamentId.slice(1, 3))}, deal ${Number(h.tournamentId.split('-r')[1]) + 1} of 5, hand ${h.handNo}`,
    ref: `${GUEST_TABLE[pick.id.split('-')[0]!] ? `${pick.id.split('-')[0]} ` : ''}${h.tournamentId} #${h.handNo}`,
    title: clean(pick.title),
    hand: h.handNo,
    blinds: [h.smallBlind, h.bigBlind],
    seats,
    board: h.board,
    steps
  }
}

// ---------- figures ----------

function buildFigures(inp: Input) {
  const o = inp.out
  const main = o.main_official
  const lb = new Map<string, any>(main.leaderboard.map((r: any) => [r.modelId, r]))
  const finishes = main.finishes as Record<string, number[]>
  const style = new Map<string, any>(main.style.map((r: any) => [r.seatId, r]))
  const post = o.breadth.postflop as Record<string, any>
  const pre = o.breadth.preflop as Record<string, any>
  const short = o.extras.short_stack_preflop as Record<string, any>
  const talkStats = o.talk.stats as Record<string, any>
  const ops = o.breadth.ops as Record<string, any>
  const probe = o.probe
  const fable = o.fable

  const standings = ORDER.map((id) => {
    const r = lb.get(id)
    return {
      key: id,
      name: SHORT[id],
      kind: KIND[id],
      bb100: r1(r.bb100.value),
      lo: r1(r.bb100.lo),
      hi: r1(r.bb100.hi),
      wins: finishes[id]![0],
      firstOut: finishes[id]![4],
      tournaments: r.tournaments,
      avgFinish: r1(r.avgFinish.value)
    }
  })

  // Behaviors in plain words (no stat names in the figure)
  const personalities = {
    behaviors: [
      { key: 'plays', label: 'Joins the hand', note: 'puts chips in before the flop' },
      { key: 'raises', label: 'Raises before the flop' },
      { key: 'riverFold', label: 'Folds to a bet on the last card' },
      { key: 'shortShove', label: 'Goes all-in when short on chips', note: 'under 15 big blinds' },
      { key: 'talks', label: 'Talks at the table' }
    ],
    players: ORDER.map(id => ({
      key: id,
      name: SHORT[id],
      kind: KIND[id],
      plays: r0(style.get(id).vpip),
      raises: r0(style.get(id).pfr),
      riverFold: r0(post[id].fold_to_bet_river),
      shortShove: r1(short[id].shove),
      talks: talkStats[id] ? r0(talkStats[id].talk_rate) : null
    }))
  }

  const talkOrder = ['typesafe-ai/jev', 'anthropic/claude-haiku-5.5', 'openai/gpt-6-luna-decisions', 'openai/gpt-6-luna', 'openai/gpt-6-sol']
  const talk = {
    lines: { nuts: 'I\'ve got the nuts here. Just fold.', nothing: 'Honestly, I\'ve got nothing. Call me.' },
    spots: probe.talk.Jev.talk_strong_n,
    players: talkOrder.map((id) => {
      const t = probe.talk[SHORT[id]!]
      return { key: id, name: SHORT[id], kind: KIND[id], silent: r0(t.silent), nuts: r0(t.talk_strong), nothing: r0(t.talk_weak) }
    })
  }

  const lab = {
    planner: 'Claude Fable 5.1',
    control: r1(fable.control_bb100.value),
    cards: (fable.lab_rows as any[]).map(r => ({ name: r.label, predicted: r0(r.pred_bb100), measured: r1(r.actual_bb100) }))
      .sort((a, b) => b.predicted - a.predicted),
    spread: {
      predicted: r0(fable.spread.predicted_sd_of_leads),
      observed: r0(fable.spread.observed_sd_of_leads),
      noise: r0(fable.spread.expected_sd_from_noise_alone)
    },
    error: { fable: r0(fable.lab_calib.mae), control: r0(fable.lab_calib.mae_if_predicted_control) }
  }

  // ---------- facts: every number the prose uses ----------
  const id = { sol: 'openai/gpt-6-sol', luna: 'openai/gpt-6-luna', ld: 'openai/gpt-6-luna-decisions', haiku: 'anthropic/claude-haiku-5.5', jev: 'typesafe-ai/jev' } as const
  const st = (k: keyof typeof id) => standings.find(s => s.key === id[k])!
  const others = (['luna', 'ld', 'haiku', 'jev'] as const).map(k => short[id[k]].shove as number)
  const allin = o.allin_main.models as Record<string, any>
  const flowFromJev = main.flow[id.sol][id.jev] as number
  const solBbWon = ops[id.sol].bb_won as number
  const rq = o.bets.quality as Record<string, any>
  const xs = o.extras
  const self = probe.self_agreement as Record<string, any>
  const labSpend = o.lab_official.spend.total as number
  const labHands = Number(String(o.lab_official.fieldNotes).match(/(\d+) hands/)?.[1] ?? 0)
  const styleCard = (name: string) => (fable.style as any[]).find(s => s.name === name)
  const heldout = (o.lab_official.heldout.rows as any[]).find(r => r.cardId === 'g0c05')
  const botHunter = (o.lab_official.pooled as any[]).find(r => r.cardId === 'g0c05')
  const S = inp.structure
  const rs = o.reasoning.by_model as Record<string, any>
  const sumv = (x: Record<string, number>) => Object.values(x ?? {}).reduce((a, v) => a + v, 0)
  const claimsWrong = (m: string) => sumv(rs[m].claims_wrong)
  const fallbacks = (main.ops as any[]).reduce((a, r) => a + r.fallbacks, 0)
  const decisions = (main.ops as any[]).reduce((a, r) => a + r.decisions, 0)

  const facts: Record<string, string> = {
    tournaments: num(main.item.tournamentsDone),
    matches: num(main.item.matchesComplete),
    rotations: num(main.item.tournamentsDone / main.item.matchesComplete),
    hands: num(main.item.hands),
    decisions: num(decisions),
    fallbacks: num(fallbacks),
    cost: usd(main.item.costUsd),
    start_stack: num(S.stack),
    start_bb: num(S.stack / S.levels[0]!.bb),
    blinds_start: `${S.levels[0]!.sb} and ${S.levels[0]!.bb}`,
    blind_hands: num(S.levels[0]!.hands),
    hand_cap: num(main.maxHands),
    capped: num(inp.endings.filter(r => r !== 'finished').length),
    pairs_separated: `${(main.pairs as any[]).filter(p => p.bb100.lo > 0 || p.bb100.hi < 0).length} of ${main.pairs.length}`,

    sol_bb100: signed(st('sol').bb100),
    sol_lo: signed(st('sol').lo),
    sol_hi: signed(st('sol').hi),
    luna_bb100: signed(st('luna').bb100),
    ld_bb100: signed(st('ld').bb100),
    haiku_bb100: signed(st('haiku').bb100),
    jev_bb100: signed(st('jev').bb100),
    sol_wins: num(st('sol').wins),
    luna_wins: num(st('luna').wins),
    ld_wins: num(st('ld').wins),
    haiku_wins: num(st('haiku').wins),
    jev_wins: num(st('jev').wins),
    haiku_first_out: num(st('haiku').firstOut),
    sol_bb100_noluck: signed(allin[id.sol].adjustedBb100),
    sol_bb_won: num(solBbWon),
    sol_bb_from_jev: num(flowFromJev),

    sol_short_shove: pct(short[id.sol].shove),
    others_short_shove_max: pct(Math.max(...others)),
    luna_short_limp: pct(short[id.luna].limp_or_call),
    haiku_short_limp: pct(short[id.haiku].limp_or_call),
    sol_shoves: num(xs.sol_shoves.n),
    sol_shove_won: pct(xs.sol_shoves.won_hand_pct),
    sol_shove_median_bb: `${r0(xs.sol_shoves.median_stack_bb)}`,
    sol_river_bad_folds: `${rq[id.sol].river_hu.bad_fold} of ${rq[id.sol].river_hu.folds}`,
    sol_claims_wrong: num(claimsWrong(id.sol)),

    luna_river_fold: pct(post[id.luna].fold_to_bet_river),
    luna_river_fold_words: inWords(post[id.luna].fold_to_bet_river),
    luna_bad_folds: `${rq[id.luna].river_hu.bad_fold} of ${rq[id.luna].river_hu.folds}`,
    luna_showdown: signed(xs.sources[id.luna].bb100_showdown),
    luna_no_showdown: signed(xs.sources[id.luna].bb100_no_showdown),

    haiku_plays_words: inWords(style.get(id.haiku).vpip),
    haiku_fold_after_flop_words: inWords(post[id.haiku].fold_to_bet),
    haiku_talk_rate: pct(talkStats[id.haiku].talk_rate),
    haiku_leaks: num(talkStats[id.haiku].leaks_own_card),
    haiku_talk_lines: num(talkStats[id.haiku].talk),
    haiku_sets_wrong: `${rs[id.haiku].claims_wrong.set_trips} of ${rs[id.haiku].claims.set_trips}`,
    haiku_false_set_bb: num(-xs.haiku_false_set.bb_total),
    haiku_preflop_wrong: `${rs[id.haiku].preflop_misreads} of ${num(rs[id.haiku].preflop_with_hand_named)}`,

    jev_silent: pct(probe.talk.Jev.silent),
    jev_nuts: pct(probe.talk.Jev.talk_strong),
    jev_nothing: pct(probe.talk.Jev.talk_weak),
    sol_silent: pct(probe.talk.Sol.silent),
    sol_nuts: pct(probe.talk.Sol.talk_strong),
    sol_nothing: pct(probe.talk.Sol.talk_weak),
    talk_spots: num(probe.talk.Jev.talk_strong_n),
    // Haiku's 10 hits quote its own talk rule, not an opponent (report, "Nobody listens")
    talk_used: num(o.talk.reasoning_mentions_talk.Sol + o.talk.reasoning_mentions_talk.Luna),
    sol_talk_rate: pct(talkStats[id.sol].talk_rate),
    sol_eq_talk: pct(o.talk.tells[id.sol].eq_talk * 100),
    sol_eq_silent: pct(o.talk.tells[id.sol].eq_silent * 100),
    jev_river_calls: pct(100 - post[id.jev].fold_to_bet_river),

    ld_plays: pct(style.get(id.ld).vpip),
    ld_plays_words: inWords(style.get(id.ld).vpip),
    ld_fold_to_raise_words: inWords(pre[id.ld].vs_raise_fold),
    ld_raises: pct(style.get(id.ld).pfr),
    ld_self: pct(self['Luna Decisions'].exact),
    jev_self: pct(self.Jev.exact),
    luna_self: pct(self.Luna.exact),
    sol_self: pct(self.Sol.exact),
    haiku_self: pct(self.Haiku.exact),
    ld_ms: num(ops[id.ld].lat_mean),
    jev_ms: num(ops[id.jev].lat_mean),
    sol_s: `${r1(ops[id.sol].lat_mean / 1000)}`,
    sol_cost_100: usd(ops[id.sol].cost_per_100_hands),
    jev_cost_100: `$${(ops[id.jev].cost_per_100_hands as number).toFixed(3)}`,
    ld_cost_100: `$${(ops[id.ld].cost_per_100_hands as number).toFixed(3)}`,
    sol_cost_share: pct(ops[id.sol].cost / main.item.costUsd * 100),

    lab_cards: num(fable.lab_rows.length),
    lab_hands: num(labHands),
    lab_cost: usd(labSpend),
    lab_spread_predicted: num(lab.spread.predicted),
    lab_spread_observed: num(lab.spread.observed),
    lab_spread_noise: num(lab.spread.noise),
    lab_err_fable: num(lab.error.fable),
    lab_err_control: num(lab.error.control),
    lab_control_vpip: pct(fable.control_style.vpip),
    granite_vpip: pct(styleCard('Granite Rock').vpip),
    blitz_vpip: pct(styleCard('Blitz Maniac').vpip),
    bot_hunter_train: signed(botHunter.lead.value),
    bot_hunter_heldout: signed(heldout.heldout.bb100.value),

    probe_calls: num(probe.calls),
    probe_cost: usd(probe.cost_pricing)
  }

  return { standings, personalities, talk, lab, facts }
}

// ---------- figures (v2) ----------

function buildFiguresV2(inp: Input) {
  const o = inp.out
  const S = inp.structure
  const pooled = new Map<string, any>(o.standings.pooled.map((r: any) => [r.player, r]))
  const style = new Map<string, any>((o.styles as any[]).map(r => [r.id, r.v2]))
  const guests = new Set(['openai/gpt-6-sol', 'anthropic/claude-opus-5.5', 'anthropic/claude-fable-5.1'])
  const payouts: number[] = o.opsA.sol.start.tournament.payouts ?? [50, 30, 20]
  const entrants = o.opsA.sol.start.lineup.length as number
  const fair = 100 / entrants

  const standings = ORDER_V2.map((id) => {
    const r = pooled.get(id)
    return {
      key: id,
      name: SHORT[id],
      kind: KIND[id],
      guest: guests.has(id),
      prize: r1(r.prize.value),
      lo: r1(Math.max(0, r.prize.lo)),
      hi: r1(r.prize.hi),
      wins: r.wins,
      tournaments: r.tournaments,
      avgFinish: r1(r.avgFinish)
    }
  })
  const pair = (a: string, b: string) => (o.standings.guestPairs as any[]).find(p => p.a === a && p.b === b)
  const guestPairs = (o.standings.guestPairs as any[]).map(p => ({ a: p.a, b: p.b, prize: r0(p.prize.value), lo: r0(p.prize.lo), hi: r0(p.prize.hi) }))

  const personalities = {
    behaviors: [
      { key: 'plays', label: 'Joins the hand', note: 'puts chips in before the flop' },
      { key: 'raises', label: 'Raises before the flop' },
      { key: 'shortShove', label: 'Goes all-in when short on chips', note: 'under 15 big blinds' },
      { key: 'riverFold', label: 'Folds to a bet on the last card' },
      { key: 'talks', label: 'Talks at the table' },
      { key: 'remembers', label: 'Cites earlier hands', note: 'in its reasoning' }
    ],
    players: ORDER_V2.map((id) => {
      const st = style.get(id)
      const words = KIND[id] === 'words'
      return {
        key: id,
        name: SHORT[id],
        kind: KIND[id],
        plays: r0(st.vpip),
        raises: r0(st.pfr),
        shortShove: r1(st.shortStackShovePct),
        riverFold: r0(st.foldToRiverBetPct),
        talks: words ? r0(st.talkRatePct) : null,
        remembers: words ? r1(st.reasoningMentionsHistoryPct) : null
      }
    })
  }

  const T = o.talk.models as Record<string, any>
  const talkOrder = ['typesafe-ai/jev', 'anthropic/claude-haiku-5.5', 'openai/gpt-6-luna', 'openai/gpt-6-luna-decisions', 'anthropic/claude-opus-5.5', 'openai/gpt-6-sol']
  const talk = {
    lines: o.talk.lines,
    players: talkOrder.map(id => ({ key: id, name: SHORT[id], kind: KIND[id], spots: T[id].spots, silent: r0(T[id].foldPct.silent), nuts: r0(T[id].foldPct.nuts), nothing: r0(T[id].foldPct.nothing) }))
  }

  const P = o.personas.personas as any[]
  const persona = (k: string) => P.find(p => p.id === k)
  const personas = {
    base: 'Luna',
    fair: r1(100 / 6),
    rows: ['control', 'reader', 'aggressive', 'talker', 'tight', 'math'].map((k) => {
      const p = persona(k)
      return { key: k, name: p.label, prize: r1(p.prizeShare.value), lo: r1(p.prizeShare.lo), hi: r1(p.prizeShare.hi), wins: p.wins, plays: r0(p.vpip), talks: r0(p.talkRatePct), remembers: r0(p.reasoningCitesHistoryPct) }
    })
  }
  // Study B on Sol: same personas, seeds and structure as the Luna table, 3 matches (same row order as Luna)
  const PS = o.personasSol.personas as any[]
  const personaSol = (k: string) => PS.find(p => p.id === k)
  const personasSol = {
    base: 'Sol',
    fair: r1(100 / 6),
    rows: ['control', 'reader', 'aggressive', 'talker', 'tight', 'math'].map((k) => {
      const p = personaSol(k)
      return { key: k, name: p.label, prize: r1(p.prizeShare.value), lo: r1(p.prizeShare.lo), hi: r1(p.prizeShare.hi), wins: p.wins, plays: r0(p.vpip), talks: r0(p.talkRatePct), remembers: r0(p.reasoningCitesHistoryPct) }
    })
  }

  // ---------- facts: every number the prose uses (v2 only) ----------
  const id = { sol: 'openai/gpt-6-sol', opus: 'anthropic/claude-opus-5.5', fable: 'anthropic/claude-fable-5.1', luna: 'openai/gpt-6-luna', ld: 'openai/gpt-6-luna-decisions', haiku: 'anthropic/claude-haiku-5.5', jev: 'typesafe-ai/jev' } as const
  type K = keyof typeof id
  const st = (k: K) => standings.find(s => s.key === id[k])!
  const sty = (k: K) => style.get(id[k])
  const A = Object.values(o.opsA) as any[]
  const B = o.opsB
  const handsA = A.reduce((a, x) => a + x.hands, 0)
  const decisionsA = A.reduce((a, x) => a + x.decisions, 0)
  const allHands = A.flatMap(x => x.handCounts as number[])
  const so = pair('GPT-6 Sol', 'Claude Opus 5.5')
  const of = pair('Claude Opus 5.5', 'Claude Fable 5.1')
  const sf = pair('GPT-6 Sol', 'Claude Fable 5.1')
  const usdDec = (k: K) => `$${(sty(k).usdPerDecision as number).toFixed(sty(k).usdPerDecision < 0.001 ? 4 : 3)}`
  const pctSmall = (v: number) => (v > 0 && v < 1 ? 'under 1%' : pct(v))
  const llms: K[] = ['sol', 'opus', 'fable', 'luna', 'haiku']
  const talkMax = Math.max(...llms.map(k => sty(k).reasoningMentionsTalkPct as number))
  const tk = (k: K) => T[id[k]]
  const setClaims = String(sty('haiku').setClaimsWrong).split('/')
  const ctl = persona('control')
  // every persona trailed the control on prize share; this is the closest one's gap
  const personaLeadMax = Math.max(...P.filter(p => p.vsControl).map(p => p.vsControl.prizePts.value))
  const personaOff = Math.max(...P.map(p => Math.abs(p.prizeShare.value - 100 / 6)))
  const costA = A.reduce((a, x) => a + x.cost, 0)
  const BS = o.opsBSol
  const ctlSol = personaSol('control')
  const solLeads = PS.filter(p => p.vsControl).map(p => p.vsControl.prizePts)
  const solBest = solLeads.reduce((a, b) => (b.value > a.value ? b : a))
  const solWords = ['none', 'one', 'two', 'three', 'four', 'five']

  const facts: Record<string, string> = {
    // the study
    tournaments: num(A.reduce((a, x) => a + x.tournaments, 0)),
    tournaments_per_table: num(o.opsA.sol.tournaments),
    deck_sets: num(o.opsA.sol.tournaments / 5),
    hands: num(handsA),
    decisions: num(decisionsA),
    fallbacks: num(A.reduce((a, x) => a + x.fallbacks, 0) + B.fallbacks),
    entrants: num(entrants),
    start_stack: num(S.stack),
    start_bb: num(S.stack / S.levels[0]!.bb),
    blinds_start: `${S.levels[0]!.sb} and ${S.levels[0]!.bb}`,
    blind_hands: num(S.levels[0]!.hands),
    payouts: `${payouts.slice(0, -1).map(p => `${p}%`).join(', ')} and ${payouts.at(-1)}%`,
    payout_first: pct(payouts[0]!),
    paid_places: num(payouts.length),
    fair_share: pct(fair),
    shortest: num(Math.min(...allHands)),
    longest: num(Math.max(...allHands)),
    finished: `${inp.endings.filter(r => r === 'finished').length} of ${inp.endings.length}`,
    cost_a: usd(costA),
    cost_b: usd(B.cost),
    cost_talk: usd(o.talk.costUsd),
    cost_sol_table: usd(o.opsA.sol.cost),
    cost_opus_table: usd(o.opsA.opus.cost),
    cost_fable_table: usd(o.opsA.fable.cost),

    // standings (prize share)
    ...Object.fromEntries((Object.keys(id) as K[]).flatMap(k => [
      [`${k}_prize`, pct(st(k).prize)],
      [`${k}_prize_lo`, pct(st(k).lo)],
      [`${k}_prize_hi`, pct(st(k).hi)],
      [`${k}_wins`, num(st(k).wins)],
      [`${k}_tournaments`, num(st(k).tournaments)],
      [`${k}_finish`, `${st(k).avgFinish}`]
    ])),
    sol_opus_gap: `${r0(so.prize.value)} points`,
    sol_opus_range: `${signed(so.prize.lo)} to ${signed(so.prize.hi)}`,
    opus_fable_gap: `${r0(of.prize.value)} points`,
    opus_fable_range: `${signed(of.prize.lo)} to ${signed(of.prize.hi)}`,
    sol_fable_gap: `${r0(sf.prize.value)} points`,
    sol_fable_range: `${signed(sf.prize.lo)} to ${signed(sf.prize.hi)}`,

    // styles
    ...Object.fromEntries((Object.keys(id) as K[]).flatMap(k => [
      [`${k}_plays`, pct(sty(k).vpip)],
      [`${k}_plays_words`, inWords(sty(k).vpip)],
      [`${k}_raises`, pct(sty(k).pfr)],
      [`${k}_short_shove`, pct(sty(k).shortStackShovePct)],
      [`${k}_river_fold`, pct(sty(k).foldToRiverBetPct)],
      [`${k}_usd_dec`, usdDec(k)],
      [`${k}_latency`, `${sty(k).meanLatencyS}`],
      ...(KIND[id[k]] === 'words'
        ? [[`${k}_talk_rate`, pct(sty(k).talkRatePct)], [`${k}_history`, pctSmall(sty(k).reasoningMentionsHistoryPct)], [`${k}_payout_mentions`, pctSmall(sty(k).reasoningMentionsPayoutsPct)]]
        : [])
    ])),
    haiku_short_spots: num(sty('haiku').shortSpots),
    haiku_short_shoves: num(sty('haiku').shortStackShovePct * sty('haiku').shortSpots / 100),
    haiku_sets_wrong: `${setClaims[0]} of ${setClaims[1]}`,
    opus_raise_to: pct(sty('opus').raiseToPct),
    fable_cost_ratio: `${r1(sty('fable').usdPerDecision / sty('opus').usdPerDecision)}`,
    talk_in_reasoning_max: pctSmall(talkMax),
    overbets: num(llms.reduce((a, k) => a + (sty(k).overbetPctOfPostflopBets as number), 0)),

    // the talk test
    talk_spots: num(tk('jev').spots),
    talk_sol_spots: num(tk('sol').spots),
    talk_opus_spots: num(tk('opus').spots),
    ...Object.fromEntries((['jev', 'haiku', 'luna', 'ld', 'opus', 'sol'] as K[]).flatMap(k => [
      [`talk_${k}_silent`, pct(tk(k).foldPct.silent)],
      [`talk_${k}_nuts`, pct(tk(k).foldPct.nuts)],
      [`talk_${k}_nothing`, pct(tk(k).foldPct.nothing)]
    ])),
    talk_calls: num(o.talk.calls),

    // personas (Study B)
    persona_tournaments: num(B.tournaments),
    persona_matches: num(o.personas.design.match(/(\d+) duplicate matches/)?.[1] ?? 0),
    persona_hands: num(B.hands),
    persona_fair: `${r1(100 / 6)}%`,
    persona_control: `${r1(ctl.prizeShare.value)}%`,
    persona_tight_plays: pct(persona('tight').vpip),
    persona_aggressive_plays: pct(persona('aggressive').vpip),
    persona_aggressive_wins: num(persona('aggressive').wins),
    persona_control_wins: num(ctl.wins),
    persona_talker_talks: pct(persona('talker').talkRatePct),
    persona_control_talks: pct(ctl.talkRatePct),
    persona_reader_history: pct(persona('reader').reasoningCitesHistoryPct),
    persona_control_history: pctSmall(ctl.reasoningCitesHistoryPct),
    persona_best_behind: `${r1(-personaLeadMax)} points`,
    persona_max_off: `${r1(personaOff)}`,
    persona_control_lo: pct(Math.max(0, ctl.prizeShare.lo)),
    persona_control_hi: pct(ctl.prizeShare.hi),

    // personas on Sol (Study B, Sol table): same personas, seeds and structure as Luna, 3 matches
    persona_sol_tournaments: num(BS.tournaments),
    persona_sol_matches: num(o.personasSol.design.match(/(\d+) duplicate matches/)?.[1] ?? 0),
    persona_sol_hands: num(BS.hands),
    persona_sol_decisions: num(BS.decisions),
    persona_sol_fallbacks: num(BS.fallbacks),
    persona_sol_control: `${r1(ctlSol.prizeShare.value)}%`,
    persona_sol_control_lo: pct(Math.max(0, ctlSol.prizeShare.lo)),
    persona_sol_control_hi: pct(ctlSol.prizeShare.hi),
    persona_sol_tight_plays: pct(personaSol('tight').vpip),
    persona_sol_aggressive_plays: pct(personaSol('aggressive').vpip),
    persona_sol_aggressive_wins: num(personaSol('aggressive').wins),
    persona_sol_control_wins: num(ctlSol.wins),
    persona_sol_talker_talks: pct(personaSol('talker').talkRatePct),
    persona_sol_control_talks: pct(ctlSol.talkRatePct),
    persona_sol_reader_history: pct(personaSol('reader').reasoningCitesHistoryPct),
    persona_sol_control_history: pctSmall(ctlSol.reasoningCitesHistoryPct),
    persona_sol_plays_min: pct(Math.min(...PS.map(p => p.vpip))),
    persona_sol_plays_max: pct(Math.max(...PS.map(p => p.vpip))),
    persona_sol_talks_min: pct(Math.min(...PS.map(p => p.talkRatePct))),
    persona_sol_talks_max: pct(Math.max(...PS.map(p => p.talkRatePct))),
    persona_sol_below: solWords[solLeads.filter(l => l.value < 0).length] ?? num(solLeads.filter(l => l.value < 0).length),
    persona_sol_best_label: String(PS.find(p => p.vsControl?.prizePts === solBest).label).toLowerCase(),
    persona_sol_best_lead: `${r1(solBest.value)} points`,
    persona_sol_best_range: `${signed(solBest.lo)} to ${signed(solBest.hi)} points`,
    cost_b_sol: usd(BS.cost),
    fallbacks_all: num(A.reduce((a, x) => a + x.fallbacks, 0) + B.fallbacks + BS.fallbacks)
  }

  return { standings, guestPairs, personalities, talk, personas, personasSol, facts }
}

// ---------- main ----------

if (args.source !== 'v1' && args.source !== 'v2') throw new Error(`--source must be v1 or v2, got ${args.source}`)
const inp = args.source === 'v2' ? loadV2() : loadV1()
const picks = inp.source === 'v1' ? HANDS_V1 : HANDS_V2
const found = inp.hands(new Set(picks.map(p => p.id)))

const hands: Record<string, any> = {}
for (const p of picks) {
  const h = found.get(p.id)
  if (!h) throw new Error(`hand ${p.id} not found`)
  hands[p.id] = buildReplay(h, p)
}

// m04 #4 in every rotation: the same cards in the same seat, played by each model
const duplicate = (() => {
  if (inp.source !== 'v1') return undefined
  const ids = [0, 1, 2, 3, 4].map(r => `m04-r${r}-4`)
  const all = inp.hands(new Set(ids))
  return ids.map((hid) => {
    const h = all.get(hid)!
    const seat = Object.entries(h.holes).find(([, c]) => c.join('') === 'AdQs')![0]
    const m = h.seats.find(s => s.id === seat)!.modelId
    return { key: m, name: SHORT[m], chips: h.result.deltas[seat]!, bb: r1(h.result.deltas[seat]! / h.bigBlind) }
  }).sort((a, b) => b.chips - a.chips)
})()
if (duplicate) hands['m04-r4-4'].sameCards = { hole: ['Ad', 'Qs'], title: 'The same deal, five times. Whoever sat in this seat held', note: 'How many chips each AI came out ahead with those two cards (winnings minus what it bet). Same cards, same seat, same opponents\' cards.', rows: duplicate }

// v2: the guest seat holds the same cards at all three tables; compare the three guests
if (inp.source === 'v2') {
  const sameId = 'fable-m02-r1-6'
  const rest = sameId.split('-').slice(1)
  const key = `${rest[0]}-${rest[1]}-${rest[2]}`
  const all = inp.hands(new Set(V2_TABLES.map(t => `${t}-${key}`)))
  const guestModel: Record<string, string> = { sol: 'openai/gpt-6-sol', opus: 'anthropic/claude-opus-5.5', fable: 'anthropic/claude-fable-5.1' }
  let hole: string[] = []
  const rows = V2_TABLES.map((t) => {
    const h = all.get(`${t}-${key}`)!
    const seat = h.seats.find(s => s.modelId === guestModel[t])!
    hole = h.holes[seat.id]!
    return { key: guestModel[t], name: SHORT[guestModel[t]!], chips: h.result.deltas[seat.id]!, bb: r1(h.result.deltas[seat.id]! / h.bigBlind) }
  }).sort((a, b) => b.chips - a.chips)
  hands[sameId].sameCards = {
    hole,
    title: 'The same deal at all three guest tables. The guest in this seat held',
    note: 'Chips each guest won or lost with those two cards. Same cards, same seat, same four opponents. Stacks differed, because the earlier hands had gone differently.',
    rows
  }
}

const figures = inp.source === 'v2' ? buildFiguresV2(inp) : buildFigures(inp)
const meta = {
  source: inp.source,
  ...(inp.source === 'v2' ? { closed: CLOSED_V2 } : {}),
  note: 'Generated by holdem-ai bench/blog_export.ts. Do not edit by hand; rerun the script.',
  players: ORDER.map(id => ({ key: id, name: SHORT[id], full: FULL[id], kind: KIND[id] }))
}

const outDir = resolve(process.cwd(), args.out!)
mkdirSync(outDir, { recursive: true })
for (const [file, data] of [['replays.json', { ...meta, hands }], ['figures.json', { ...meta, ...figures }]] as const) {
  const text = JSON.stringify(data, null, 1) + '\n'
  if (/[—–]/.test(text)) throw new Error(`${file} contains an em or en dash`)
  const bytes = Buffer.byteLength(text)
  if (bytes > MAX_BYTES) throw new Error(`${file} is ${bytes} bytes, over the 150 KB budget`)
  writeFileSync(join(outDir, file), text)
  console.log(`${file}: ${(bytes / 1024).toFixed(1)} KB -> ${join(outDir, file)}`)
}
