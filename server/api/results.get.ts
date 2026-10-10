/**
 * GET /api/results — batch runs from data/runs/*.jsonl (written by bench/tournament.ts).
 *   no query      → { runs: RunListItem[] }
 *   ?run=<slug>   → RunDetail; &matches=N limits the stats to the first N complete matches.
 * Parsed files are cached by mtime + size, so polling a run in progress stays cheap.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseRun } from '../../shared/utils/runs'
import type { ParsedRun } from '../../shared/utils/runs'
import { listItem, runDetail } from '../utils/results'

const DIR = join(process.cwd(), 'data', 'runs')
const cache = new Map<string, { key: string, run: ParsedRun }>()

async function load(slug: string): Promise<{ run: ParsedRun, updated: string } | null> {
  const file = join(DIR, `${slug}.jsonl`)
  const st = await stat(file).catch(() => null)
  if (!st) return null
  const key = `${st.mtimeMs}:${st.size}`
  let hit = cache.get(slug)
  if (hit?.key !== key) {
    hit = { key, run: parseRun(await readFile(file, 'utf8')) }
    cache.set(slug, hit)
  }
  return { run: hit.run, updated: st.mtime.toISOString() }
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  if (typeof q.run === 'string') {
    if (!/^[\w.-]{3,120}$/.test(q.run)) throw createError({ statusCode: 400, statusMessage: 'Bad run slug' })
    const loaded = await load(q.run)
    if (!loaded?.run.start) throw createError({ statusCode: 404, statusMessage: `No run ${q.run}` })
    const matches = Number(q.matches) > 0 ? Math.floor(Number(q.matches)) : undefined
    return runDetail(q.run, loaded.run, loaded.updated, { matches })
  }
  const files = (await readdir(DIR).catch(() => [] as string[]))
    .filter(f => f.endsWith('.jsonl') && !f.endsWith('.cache.jsonl'))
  const runs = []
  for (const f of files) {
    const slug = f.slice(0, -'.jsonl'.length)
    const loaded = await load(slug)
    if (loaded?.run.start) runs.push(listItem(slug, loaded.run, loaded.updated))
  }
  runs.sort((a, b) => b.updated.localeCompare(a.updated))
  return { runs }
})
