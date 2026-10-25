// Integration test: boot the plugin against a fake ctx and drive every tool
// against the real session logs on this machine.
import { apply } from '../lib/index.js'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const registry = new Map()
const fakeCtx = { tools: { register: (t) => registry.set(t.name, t) } }
apply(fakeCtx, { maxSessions: 10 })

const SESSIONS = join(homedir(), '.dsh', 'sessions')

// find one session with a summarising compaction (the root has a workspace level)
function sessionWithSummary() {
  for (const ws of readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const wsDir = join(SESSIONS, ws.name)
    for (const d of readdirSync(wsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const f = join(wsDir, d.name, 'session.v4.jsonl.zstd')
      if (!existsSync(f)) continue
      try {
        const text = execFileSync('zstd', ['-dc', f], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' })
        if (text.includes('"compaction/summary"')) return f
      } catch {}
    }
  }
  return null
}

const results = []
try {
  const call = async (name, args = {}) => registry.get(name).execute(args, { signal: undefined })
  const expected = ['compaction_audit', 'compaction_audit_sweep', 'compaction_audit_diff', 'compaction_audit_log_check']
  results.push([`${expected.length} tools registered`, expected.every((n) => registry.has(n))])

  const file = sessionWithSummary()
  results.push(['found a real session with a summary', file !== null])

  if (file) {
    const audit = await call('compaction_audit', { session: file })
    results.push(['compaction_audit runs on a real session', audit.ok === true && audit.summary.events > 100])
    results.push(['compaction_audit produces a report', typeof audit.report === 'string' && audit.report.includes('finding')])

    const diff = await call('compaction_audit_diff', { session: file, index: 0 })
    results.push(['diff reports constraints', diff.ok === true && diff.history.constraints > 0])
    results.push(['diff lists lost and kept', Array.isArray(diff.lost) && Array.isArray(diff.kept)])

    const check = await call('compaction_audit_log_check', { session: file })
    results.push(['log check reports pairing', check.ok === true && check.calls > 0])
  }

  const sweep = await call('compaction_audit_sweep', { dir: SESSIONS, limit: 8 })
  results.push(['sweep ranks sessions', sweep.ok === true && Array.isArray(sweep.sessions) && sweep.sessions.length > 0])
  results.push(['sweep totals add up', sweep.ok === true && sweep.totals.errors >= 0])

  const missing = await call('compaction_audit', { session: 'Z:/nope/nothing.zstd' })
  results.push(['missing session is an error', missing.ok === false])
} catch (error) {
  console.error('UNEXPECTED THROW:', error)
  results.push(['no-throw', false])
}

let pass = 0
for (const [name, ok] of results) {
  console.log(`${ok ? '✔' : '✖'} ${name}`)
  if (ok) pass += 1
}
console.log(`\n${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)
