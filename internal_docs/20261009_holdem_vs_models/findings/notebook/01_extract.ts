/**
 * Flattens every batch run file into analysis tables (cache/, gitignored, rebuilt on demand):
 *   cache/decisions_<table>.csv   one row per decision, with equity vs random hands (what the seat
 *                                 could know) and vs the actual live hands (god view), pot odds,
 *                                 sizing, latency, tokens, cost, probabilities
 *   cache/seathands_<table>.csv   one row per seat per hand (delta in bb, VPIP/PFR/showdown flags)
 *   cache/text_<table>.jsonl      reasoning + table talk per decision (LLM seats)
 * Per-file outputs are skipped when newer than their source, so a rerun costs nothing.
 *   node 01_extract.ts [--only main]
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildMenu } from '../../../../shared/utils/menu.ts'
import { costUsd } from '../../../../shared/utils/pricing.ts'
import { playerOf } from '../../../../shared/utils/runs.ts'
import { CACHE, cardInt, equity, readRun, reseed, runFiles, evalCards, category, CATEGORY_NAMES } from './lib.ts'

mkdirSync(CACHE, { recursive: true })
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null

const esc = (v: unknown) => {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const toCsv = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return ''
  const cols = Object.keys(rows[0]!)
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') + '\n'
}

const MENU = ['fold', 'check', 'call', 'raise_min', 'raise_half_pot', 'raise_pot', 'raise_2x_pot', 'all_in'] as const

for (const f of runFiles()) {
  if (only && f.kind !== only && f.table !== only) continue
  const slug = f.table.replace(/[/]/g, '__')
  const dOut = join(CACHE, `decisions_${slug}.csv`)
  if (existsSync(dOut) && statSync(dOut).mtimeMs > statSync(f.path).mtimeMs && !process.argv.includes('--force')) {
    console.log('skip (fresh)', slug)
    continue
  }
  const run = readRun(f.path)
  const players = new Map((run.start?.players ?? []).map(p => [p.id, p]))
  const lab = run.start?.lab
  const dRows: Record<string, unknown>[] = []
  const hRows: Record<string, unknown>[] = []
  const text: string[] = []
  const iters = f.kind === 'main' || f.kind === 'pilot' || f.kind === 'heldout' ? 600 : 300
  let k = 0
  for (const h of run.hands) {
    const seatById = new Map(h.seats.map(s => [s.id, s]))
    const playerFor = (id: string) => { const s = seatById.get(id)!; return playerOf(s) }
    const holes = h.holes
    // per seat-hand row
    const n = h.seats.length
    const dealt = h.seats.filter(s => holes[s.id]?.length)
    for (const s of dealt) {
      const mine = h.log.filter(e => e.seatId === s.id)
      const pre = mine.filter(e => e.street === 'preflop')
      const foldedPre = pre.some(e => e.action.type === 'fold')
      const fold = mine.find(e => e.action.type === 'fold')
      const sawFlop = h.board.length >= 3 && !foldedPre
      const shown = !!h.result.shown[s.id]
      const wonAny = h.result.pots.some(p => p.winners.includes(s.id))
      const firstDec = h.decisions.find(d => d.seatId === s.id)
      const idx = h.seats.findIndex(x => x.id === s.id)
      hRows.push({
        kind: f.kind, table: f.table, gen: lab?.gen ?? '', matchId: h.matchId, tournamentId: h.tournamentId, rotation: h.rotation,
        seed: h.seed, handNo: h.handNo, level: h.level, bb: h.bigBlind, nDealt: dealt.length, seatId: s.id, seatIdx: idx,
        button: h.button, model: s.modelId, player: playerOf(s), cardId: s.cardId ?? '',
        position: firstDec?.view.position ?? '', hole: (holes[s.id] ?? []).join(''),
        stackBefore: h.stacksBefore[s.id] ?? '', stackBb: (h.stacksBefore[s.id] ?? 0) / h.bigBlind,
        delta: h.result.deltas[s.id] ?? 0, deltaBb: (h.result.deltas[s.id] ?? 0) / h.bigBlind,
        vpip: pre.some(e => e.added > 0) ? 1 : 0, pfr: pre.some(e => e.raiseTo !== undefined) ? 1 : 0,
        sawFlop: sawFlop ? 1 : 0, showdown: shown ? 1 : 0, wonAny: wonAny ? 1 : 0,
        foldStreet: fold?.street ?? '', board: h.board.join(''), uncontested: Object.keys(h.result.shown).length === 0 ? 1 : 0,
        bustedThisHand: h.busts.some(b => b.seatId === s.id) ? 1 : 0, nDecisions: h.decisions.filter(d => d.seatId === s.id).length
      })
    }
    for (const rec of h.decisions) {
      const v = rec.view
      const d = rec.decision
      const menu = buildMenu(v)
      const chosen = menu.find(o => o.id === d.menuId)
      const hero = v.hole.map(cardInt)
      const board = v.board.map(cardInt)
      const live = v.opponents.filter(o => !o.folded && v.seatOrder.includes(o.id) && (holes[o.id]?.length ?? 0) === 2)
      const oppHands = live.map(o => holes[o.id]!.map(cardInt))
      reseed((h.seed ^ (h.handNo * 7919) ^ (rec.logIndex * 104729)) >>> 0)
      const eqActual = oppHands.length ? equity(hero, board, oppHands, 0, iters) : 1
      const eqRandom = live.length ? equity(hero, board, [], live.length, iters) : 1
      const eqHU = equity(hero, board, [], 1, iters)
      const made = board.length >= 3 ? CATEGORY_NAMES[category(evalCards([...hero, ...board]))] : ''
      const potBefore = v.pot - v.toCall // pot excluding what I'd add to call (bets in front of me are included)
      const raiseTo = chosen?.action.type === 'raise' ? chosen.action.to : chosen?.action.type === 'all_in' ? v.maxRaiseTo : null
      const addChips = raiseTo !== null ? raiseTo - v.me.committed : d.menuId === 'call' ? v.toCall : 0
      const probs = d.probabilities ?? null
      let top: string | null = null, topP = -1, entropy: number | null = null, pChosen: number | null = null
      if (probs) {
        entropy = 0
        for (const [id, p] of Object.entries(probs)) {
          if ((p ?? 0) > topP) { topP = p ?? 0; top = id }
          if (p && p > 0) entropy -= p * Math.log2(p)
        }
        pChosen = probs[d.menuId] ?? 0
      }
      const lastAgg = [...v.log].reverse().find(e => e.raiseTo !== undefined || e.action.type === 'all_in')
      const prevLog = v.log
      // same-spot keys for duplicate comparisons: identical cards, seat, board and action history;
      // spotKeyExact also needs every stack equal (what the model saw, minus names)
      const hist = v.log.map(e => `${e.seatId}:${e.action.type}:${e.raiseTo ?? ''}`).join(' ')
      const spotKey = `${h.matchId}|${h.handNo}|${rec.seatId}|${rec.street}|${v.board.join('')}|${v.hole.join('')}|${v.pot}|${v.toCall}|${hist}`
      const spotKeyExact = `${spotKey}|${v.me.stack}|${v.opponents.map(o => `${o.id}=${o.stack}`).join(',')}`
      const row: Record<string, unknown> = {
        kind: f.kind, table: f.table, gen: lab?.gen ?? '', matchId: h.matchId, tournamentId: h.tournamentId, rotation: h.rotation,
        handNo: h.handNo, level: h.level, bb: h.bigBlind, logIndex: rec.logIndex, seatId: rec.seatId,
        model: seatById.get(rec.seatId)?.modelId, player: playerFor(rec.seatId), cardId: seatById.get(rec.seatId)?.cardId ?? '',
        street: rec.street, position: v.position, nSeats: v.seatOrder.length, nLive: live.length + 1,
        hole: v.hole.join(''), board: v.board.join(''), made,
        stack: v.me.stack, stackBb: v.me.stack / v.bigBlind, committed: v.me.committed, pot: v.pot, toCall: v.toCall,
        potOdds: v.toCall > 0 ? v.toCall / (v.pot + v.toCall) : 0,
        facingFrac: v.toCall > 0 && potBefore > 0 ? v.toCall / potBefore : 0,
        facingAllIn: live.some(o => o.allIn) ? 1 : 0,
        facingAgg: lastAgg ? playerFor(lastAgg.seatId) : '',
        nRaisesBefore: prevLog.filter(e => e.street === rec.street && (e.raiseTo !== undefined)).length,
        menu: menu.map(o => o.id).join('|'), menuId: d.menuId, spotKey, spotKeyExact,
        raiseTo, addChips, addFracPot: addChips && v.pot ? addChips / v.pot : 0, addBb: addChips / v.bigBlind,
        eqActual, eqRandom, eqHU,
        latencyMs: d.latencyMs, inTok: d.usage.input, outTok: d.usage.output, costUsd: costUsd(d.model, d.usage),
        fallback: d.fallback ? 1 : 0, retried: d.retried ? 1 : 0, choiceNotTop: d.choiceNotTop ? 1 : 0,
        top, topP: probs ? topP : null, pChosen, entropy,
        talkLen: d.tableTalk ? d.tableTalk.length : 0, reasonLen: d.reasoning?.length ?? 0,
        deltaBb: (h.result.deltas[rec.seatId] ?? 0) / h.bigBlind,
        showdown: h.result.shown[rec.seatId] ? 1 : 0,
        wonAny: h.result.pots.some(p => p.winners.includes(rec.seatId)) ? 1 : 0
      }
      for (const m of MENU) row[`p_${m}`] = probs ? (probs[m] ?? (menu.some(o => o.id === m) ? 0 : '')) : ''
      dRows.push(row)
      if (d.reasoning || d.tableTalk) {
        text.push(JSON.stringify({ table: f.table, tournamentId: h.tournamentId, handNo: h.handNo, logIndex: rec.logIndex, seatId: rec.seatId, player: playerFor(rec.seatId), model: d.model, street: rec.street, menuId: d.menuId, reasoning: d.reasoning, tableTalk: d.tableTalk ?? '' }))
      }
      if (++k % 2000 === 0) console.log(slug, k)
    }
  }
  writeFileSync(dOut + '.tmp', toCsv(dRows))
  writeFileSync(join(CACHE, `seathands_${slug}.csv`), toCsv(hRows))
  writeFileSync(join(CACHE, `text_${slug}.jsonl`), text.join('\n') + '\n')
  // rename last so a kill never leaves a "fresh" partial file
  const { renameSync } = await import('node:fs')
  renameSync(dOut + '.tmp', dOut)
  console.log('wrote', slug, dRows.length, 'decisions', hRows.length, 'seat-hands', 'players', [...players.keys()].length)
}
