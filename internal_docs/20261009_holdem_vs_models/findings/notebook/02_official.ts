/**
 * Reproduces the official /results and /lab numbers through the app's own code (runDetail,
 * labDetail) and saves them as out/b3_official.json, out/pilot_official.json, out/lab_official.json.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runDetail } from '../../../../server/utils/results.ts'
import { labDetail, loadLab, labDir } from '../../../../server/utils/lab.ts'
import { OUT, ROOT, readRun } from './lib.ts'

mkdirSync(OUT, { recursive: true })
for (const slug of ['20261010_main', '20261010_pilot']) {
  const d = runDetail(slug, readRun(join(ROOT, `data/runs/${slug}.jsonl`)), '')
  const { scouting, series, ...rest } = d
  writeFileSync(join(OUT, `${slug.replace('20261010_', '')}_official.json`), JSON.stringify({ ...rest, series }, null, 1))
  console.log(slug, d.matchesUsed, 'matches')
  for (const r of d.leaderboard) console.log(' ', r.modelId.padEnd(30), r.hands, r.bb100.value?.toFixed(1), r.bb100.lo?.toFixed(1), r.bb100.hi?.toFixed(1), 'fin', r.avgFinish.value?.toFixed(2))
}
const lab = labDetail(loadLab(labDir('20261010_lab', ROOT)))
writeFileSync(join(OUT, 'lab_official.json'), JSON.stringify(lab, null, 1))
console.log('lab keys', Object.keys(lab))
const pilot = labDetail(loadLab(labDir('20261010_lab_pilot', ROOT)))
writeFileSync(join(OUT, 'lab_pilot_official.json'), JSON.stringify(pilot, null, 1))
console.log('lab pilot scatter', pilot.scatter.length)
