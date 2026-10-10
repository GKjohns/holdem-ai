/**
 * Session durability: a localStorage snapshot so a reload (or HMR) resumes the table, and
 * fire-and-forget JSONL lines to /api/log so finished hands land on disk as they happen.
 * Every storage access is wrapped: private windows and blocked storage just mean no resume.
 */
import type { TableState } from '~~/shared/utils/types'
import type { Lineup } from '~/composables/useLineup'
import type { DecisionRecord, HandRecord, Pace } from '~/composables/useTable'

const KEY = 'holdem-ai:table'
const VERSION = 1

export interface TableSnapshot {
  v: typeof VERSION
  sessionId: string
  lineup: Lineup
  startingStacks: Record<string, number>
  startedAt: number
  state: TableState
  history: HandRecord[]
  decisions: DecisionRecord[]
  actionLabels: string[]
  blindsNote: string
  pace: Pace
  costUsd: number
  /** Session spend cap, USD. */
  cap: number
}

export function loadSnapshot(): TableSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as TableSnapshot
    return snap?.v === VERSION && snap.state?.seats?.length ? snap : null
  } catch {
    return null
  }
}

export function saveSnapshot(snap: TableSnapshot) {
  try {
    localStorage.setItem(KEY, JSON.stringify(snap))
  } catch {
    // Quota or blocked storage: the on-disk log still has every finished hand.
  }
}

export function clearSnapshot() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // nothing to clear
  }
}

/** Append one line to data/sessions/<sessionId>.jsonl. Never blocks play; one retry, then drop. */
export function postLog(line: Record<string, unknown>) {
  $fetch('/api/log', { method: 'POST', body: { source: 'casual', ts: new Date().toISOString(), ...line }, retry: 1, retryDelay: 500 })
    .catch(err => console.warn('[log] dropped a session log line', err))
}
