/**
 * Batch run files (`data/runs/<slug>.jsonl`): line types and a tolerant parser shared by
 * `bench/tournament.ts` (resume) and `/api/results`. The `hand` line is the session `hand` line
 * (AGENTS.md § Session logs) plus batch fields, and each decision carries the exact SeatView the
 * model saw. Pure (relative imports, no Nuxt).
 */
import type { ScoutingReport } from './narration.ts'
import type { Finish, TournamentFormat } from './tournament.ts'
import type { ActionEvent, Card, Decision, HandResult, SeatView, Street } from './types.ts'

interface Base { source: 'batch', runId: string, ts: string }

export interface RunStartLine extends Base {
  type: 'run_start'
  lineup: string[]
  format: 'sng' | 'cash'
  tournament: TournamentFormat
  baseSeed: number
  /** Random deciders, no gateway calls: for testing the pipeline. */
  fake: boolean
  narrator: false
}

export interface RunSeat { id: string, name: string, modelId: string }

export interface RunDecisionRecord {
  handNo: number
  seatId: string
  street: Street
  logIndex: number
  /** Exactly what was sent to the model (seatView + priorTableTalk). */
  view: SeatView
  decision: Decision
}

export interface RunHandLine extends Base {
  type: 'hand'
  /** = tournamentId, so session tooling that groups by sessionId still works. */
  sessionId: string
  mode: 'batch'
  matchId: string
  tournamentId: string
  rotation: number
  seed: number
  handNo: number
  /** 0-based blind level and the blinds for this hand. */
  level: number
  smallBlind: number
  bigBlind: number
  button: number
  seats: RunSeat[]
  holes: Record<string, Card[]>
  board: Card[]
  blinds: string
  log: ActionEvent[]
  actionLabels: string[]
  decisions: RunDecisionRecord[]
  result: HandResult
  stacksBefore: Record<string, number>
  stacksAfter: Record<string, number>
  /** Seats that busted this hand, with their places. */
  busts: Finish[]
  /** Engine rejections replaced by a safe check/fold (should be 0). */
  engineErrors?: number
}

export interface TournamentLine extends Base {
  type: 'tournament'
  sessionId: string
  matchId: string
  tournamentId: string
  rotation: number
  seed: number
  seats: RunSeat[]
  hands: number
  reason: 'finished' | 'hand_cap'
  /** Best first. */
  finish: (Finish & { modelId: string, name: string })[]
  costUsd: number
  decisions: number
  fallbacks: number
  retried: number
  engineErrors: number
  chipsConserved: boolean
  wallMs: number
}

export interface RunEndLine extends Base {
  type: 'run_end'
  status: 'complete' | 'budget' | 'interrupted' | 'errors'
  /** Live gateway spend in this invocation (replayed decisions cost nothing). */
  spentUsd: number
  liveDecisions: number
  replayedDecisions: number
  tournamentsDone: number
  tournamentsPlanned: number
}

export interface RunScoutingLine extends Base {
  type: 'scouting_report'
  sampleTournamentId: string
  report: ScoutingReport
  markdown: string
}

export type RunLine = RunStartLine | RunHandLine | TournamentLine | RunEndLine | RunScoutingLine

export interface ParsedRun {
  start: RunStartLine | null
  /** Hands of completed tournaments only. */
  hands: RunHandLine[]
  /** Hands of tournaments with no `tournament` line yet (in progress or interrupted). */
  partialHands: RunHandLine[]
  tournaments: TournamentLine[]
  ends: RunEndLine[]
  scouting: RunScoutingLine | null
  badLines: number
}

/** Skips unparsable lines (a kill mid-write can leave half a line). Later duplicates win. */
export function parseRun(text: string): ParsedRun {
  const out: ParsedRun = { start: null, hands: [], partialHands: [], tournaments: [], ends: [], scouting: null, badLines: 0 }
  const hands = new Map<string, RunHandLine>()
  const tournaments = new Map<string, TournamentLine>()
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    let line: RunLine
    try {
      line = JSON.parse(raw)
    } catch {
      out.badLines++
      continue
    }
    if (line.type === 'run_start') out.start ??= line
    else if (line.type === 'hand') hands.set(`${line.tournamentId}#${line.handNo}`, line)
    else if (line.type === 'tournament') tournaments.set(line.tournamentId, line)
    else if (line.type === 'run_end') out.ends.push(line)
    else if (line.type === 'scouting_report') out.scouting = line
  }
  out.tournaments = [...tournaments.values()]
  for (const h of hands.values()) (tournaments.has(h.tournamentId) ? out.hands : out.partialHands).push(h)
  const order = (a: RunHandLine, b: RunHandLine) => a.tournamentId.localeCompare(b.tournamentId) || a.handNo - b.handNo
  out.hands.sort(order)
  out.partialHands.sort(order)
  out.tournaments.sort((a, b) => a.tournamentId.localeCompare(b.tournamentId))
  return out
}
