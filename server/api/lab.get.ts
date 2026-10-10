/**
 * GET /api/lab — Strategy Lab runs from data/lab/<run>/ (written by bench/lab.ts).
 *   no query    → { runs: LabListItem[] }
 *   ?run=<slug> → LabDetail (every number from stats.ts via server/utils/lab.ts)
 * Table files are parsed once per (mtime, size), so polling a run in progress stays cheap.
 */
import { existsSync } from 'node:fs'
import { labDetail, labDir, labList, loadLab } from '../utils/lab'

export default defineEventHandler((event) => {
  const q = getQuery(event)
  if (typeof q.run === 'string') {
    if (!/^[\w.-]{3,80}$/.test(q.run)) throw createError({ statusCode: 400, statusMessage: 'Bad run slug' })
    const dir = labDir(q.run)
    if (!existsSync(dir)) throw createError({ statusCode: 404, statusMessage: `No lab run ${q.run}` })
    return labDetail(loadLab(dir))
  }
  return { runs: labList() }
})
