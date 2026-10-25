// Smoke: run the audit against real session logs that contain compactions.
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { auditSession, loadSession } from '../lib/engine.js'

const ROOT = process.env.USERPROFILE + '/.dsh/sessions/--E-dsh--'
const dirs = readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory())

let audited = 0
let totalFindings = 0
for (const d of dirs) {
  const file = join(ROOT, d.name, 'session.v4.jsonl.zstd')
  if (!existsSync(file)) continue
  const { events, error } = loadSession(file)
  if (error || events.length === 0) continue
  const hasCompaction = events.some((e) => String(e.type).startsWith('compaction/'))
  if (!hasCompaction) continue
  audited++
  const { compactions, summarised, prunes, findings } = auditSession(events)
  totalFindings += findings.length
  console.log(`\n${'='.repeat(74)}`)
  console.log(`${d.name}`)
  console.log(`  ${events.length} events | ${compactions.length} compaction records | ${summarised.length} with a summary | ${prunes.length} prunes`)
  console.log('='.repeat(74))
  if (findings.length === 0) {
    console.log('  no findings')
    continue
  }
  for (const f of findings) {
    console.log(`  [${f.severity}] ${f.rule}: ${f.title}`)
    if (f.data.lost) f.data.lost.slice(0, 5).forEach((l) => console.log(`       lost(${l.kind}): ${l.text}`))
    if (f.data.items) f.data.items.slice(0, 5).forEach((i) => console.log(`       item(${i.kind || 'ref'}): ${i.text}`))
  }
}
console.log(`\naudited ${audited} sessions with compaction, ${totalFindings} findings total`)
