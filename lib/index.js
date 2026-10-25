// dsh-compaction-audit: agent tools over the compaction audit pipeline.
//
// One entry point runs every check against a session log, so an agent asking
// "did that compaction lose anything?" gets the same answer a human gets from
// the CLI. Every check is deterministic: no LLM is called, so a wrong answer is
// a rule bug with a name rather than a hallucination about a hallucination.
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readdirSync, existsSync } from 'node:fs'
import {
  auditCompaction,
  auditSession,
  checkPairing,
  estimateTokens,
  extractConstraints,
  historyBefore,
  loadSession,
} from './engine.js'

export const name = 'compaction-audit'
export const inject = ['tools']

const Config = {
  // Where DSH keeps session logs.
  sessionsDir: '',
  // Cap the number of sessions a sweep will read, so a large history cannot
  // hang the tool. Override with a bigger number when you want the full sweep.
  maxSessions: 40,
}

const RULE_ORDER = ['log-invariant-broken', 'summary-hallucination', 'constraint-lost', 'prune-unaccounted', 'token-accounting', 'ghost-reference', 'no-summary', 'no-history', 'no-shadowed-text', 'prune-only-session']
const MARK = { error: '✗', warn: '!', info: '·' }

function renderReport(findings, { title }) {
  if (findings.length === 0) return `\n${title}: nothing to report.\n`
  const ordered = [...findings].sort((a, b) => {
    const sa = RULE_ORDER.indexOf(a.rule)
    const sb = RULE_ORDER.indexOf(b.rule)
    return (sa === -1 ? 99 : sa) - (sb === -1 ? 99 : sb)
  })
  const lines = ['', `${title}: ${findings.length} finding(s)`, '']
  for (const f of ordered) {
    lines.push(`${MARK[f.severity] ?? '·'} ${f.title}  [${f.rule}]`)
    lines.push(`    ${f.detail}`)
    if (f.data.lost) f.data.lost.slice(0, 6).forEach((l) => lines.push(`      lost(${l.kind}): ${l.text}`))
    if (f.data.items) f.data.items.slice(0, 6).forEach((i) => lines.push(`      item(${i.kind || 'ref'}): ${i.text}`))
    if (f.data.kept != null) lines.push(`      kept ${f.data.kept} of ${f.data.total}`)
    if (f.data.freed != null) lines.push(`      freed ${f.data.freed}, summary ~${f.data.summaryTokens}`)
    lines.push('')
  }
  const counts = { error: 0, warn: 0, info: 0 }
  for (const f of findings) counts[f.severity] += 1
  const parts = []
  if (counts.error) parts.push(`${counts.error} error`)
  if (counts.warn) parts.push(`${counts.warn} warning`)
  if (counts.info) parts.push(`${counts.info} note`)
  lines.push(parts.join(' · '))
  lines.push('')
  return lines.join('\n')
}

/** Resolve the sessions dir: explicit arg, config, or the default per-profile layout. */
function resolveSessionsDir(dir) {
  if (dir) return dir
  if (Config.sessionsDir) return Config.sessionsDir
  const home = homedir()
  return join(home, '.dsh', 'sessions')
}

/**
 * Every session log under a sessions root.
 *
 * The layout is `<sessions>/<workspace-slug>/session-<uuid>/session.v4.jsonl.zstd`
 * — a workspace level sits between the root and the session, so a flat scan of
 * the root finds nothing. Walk down to the session dirs and keep the workspace
 * slug with each row so a report can say which workspace a loss came from.
 */
function listSessions(root, limit) {
  if (!existsSync(root)) return []
  const out = []
  const walk = (dir, workspace, depth) => {
    if (depth > 2 || out.length > (typeof limit === 'number' ? limit : 500)) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = join(dir, e.name)
      const log = join(full, 'session.v4.jsonl.zstd')
      if (existsSync(log)) {
        out.push({ name: e.name, workspace, file: log })
        continue
      }
      walk(full, e.name, depth + 1)
    }
  }
  walk(root, '(root)', 0)
  // newest workspace first, then by session name
  out.sort((a, b) => b.workspace.localeCompare(a.workspace) || b.name.localeCompare(a.name))
  return typeof limit === 'number' ? out.slice(0, limit) : out
}

export function apply(ctx, config = {}) {
  const cfg = { ...Config, ...config }
  const OUTPUT_SCHEMA = { type: 'json' }
  const outRender = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

  const tools = [
    {
      name: 'compaction_audit',
      description:
        'Audit what a context compaction actually lost, from the raw session event log. Checks: session-constraint survival (the standing instructions the user gave — do-not-X, must-Y, only-in-Z — and whether the summary still carries them; the paper Lost in Compaction measured ~17% survival across compactors), summary hallucination (paths, versions, ports and ids the summary invents that were never in the history it replaced), ghost references ("see above" pointing at removed text), token accounting (a summary nearly as large as what it claims to free), and unaccounted prunes (tool output that vanished without a trace). Deterministic — no LLM, so a wrong answer is a rule bug with a name. Returns {ok, findings, summary, report}.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Path to a session.v4.jsonl.zstd file, or a session directory. Omit to sweep the newest sessions.' },
          dir: { type: 'string', description: 'Sessions root to sweep when no single session is given. Defaults to ~/.dsh/sessions.' },
          limit: { type: 'integer', description: 'How many sessions to sweep at most (default 40).' },
        },
      },
      async execute(args) {
        let file = null
        if (args.session) {
          const p = args.session
          file = existsSync(p) && p.endsWith('.zstd') ? p : join(p, 'session.v4.jsonl.zstd')
          if (!existsSync(file)) return { ok: false, error: `no session.v4.jsonl.zstd at ${p}` }
        }
        const { events, error } = loadSession(file)
        if (error) return { ok: false, error }
        if (events.length === 0) return { ok: false, error: 'session log is empty' }
        const result = auditSession(events)
        const title = file ? `compaction audit · ${file}` : 'compaction audit'
        return {
          ok: true,
          findings: result.findings,
          summary: {
            events: events.length,
            compactions: result.compactions.length,
            summarised: result.summarised.length,
            prunes: result.prunes.length,
            prunedTokens: result.prunes.reduce((a, p) => a + (p.tokenCount || 0), 0),
          },
          report: renderReport(result.findings, { title }),
        }
      },
    },
    {
      name: 'compaction_audit_sweep',
      description:
        'Audit every session under a sessions root and rank them by severity, so you can see which conversations lost the most to compaction instead of reading one at a time. Read-only; a big history is capped by `limit` (default 40 newest). Returns {ok, sessions:[{name,events,summarised,prunes,errors,warns,top}], totals}.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Sessions root. Defaults to ~/.dsh/sessions.' },
          limit: { type: 'integer', description: 'Max sessions to read (default 40).' },
        },
      },
      async execute(args) {
        const root = resolveSessionsDir(args.dir)
        const sessions = listSessions(root, Math.max(1, Number(args.limit) || cfg.maxSessions))
        if (sessions.length === 0) return { ok: false, error: `no sessions found under ${root}` }
        const rows = []
        for (const s of sessions) {
          const { events, error } = loadSession(s.file)
          if (error || events.length === 0) continue
          if (!events.some((e) => String(e.type).startsWith('compaction/'))) continue
          const result = auditSession(events)
          const errors = result.findings.filter((f) => f.severity === 'error').length
          const warns = result.findings.filter((f) => f.severity === 'warn').length
          const top = result.findings.find((f) => f.severity === 'error')
          rows.push({
            name: s.name,
            events: events.length,
            summarised: result.summarised.length,
            prunes: result.prunes.length,
            errors,
            warns,
            top: top ? `${top.rule}: ${top.title}` : null,
          })
        }
        rows.sort((a, b) => b.errors - a.errors || b.warns - a.warns)
        const totals = rows.reduce((acc, r) => ({ errors: acc.errors + r.errors, warns: acc.warns + r.warns }), { errors: 0, warns: 0 })
        return { ok: true, sessions: rows, totals }
      },
    },
    {
      name: 'compaction_audit_diff',
      description:
        'Compare one compaction in detail: what the summary replaced (the message history before it), which constraints that history contained, and which of them the summary still carries. Use it to answer "what exactly did that compaction drop?" for a single compaction rather than a whole session. Returns {ok, compaction, history:{chars,constraints}, lost:[...], kept:[...]}.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Path to a session.v4.jsonl.zstd file or session directory.' },
          index: { type: 'integer', description: 'Which summarising compaction to inspect, 0-based (default 0, the first).' },
        },
        required: ['session'],
      },
      async execute(args) {
        const p = args.session
        const file = existsSync(p) && p.endsWith('.zstd') ? p : join(p, 'session.v4.jsonl.zstd')
        if (!existsSync(file)) return { ok: false, error: `no session.v4.jsonl.zstd at ${p}` }
        const { events, error } = loadSession(file)
        if (error) return { ok: false, error }
        const { compactions, prunes } = auditSession(events)
        const summarised = compactions.filter((c) => c.summary)
        const i = Math.max(0, Number(args.index) || 0)
        const rec = summarised[i]
        if (!rec) return { ok: false, error: `session has ${summarised.length} summarising compaction(s); index ${i} is out of range` }
        const history = historyBefore(events, rec.startSeq ?? rec.summarySeq ?? 0)
        const constraints = extractConstraints(history)
        const { isPreserved } = await import('./engine.js')
        const lost = constraints.filter((c) => !isPreserved(c, rec.summary))
        const kept = constraints.filter((c) => isPreserved(c, rec.summary))
        const prevEnd = summarised[i - 1]?.endSeq ?? 0
        const mine = prunes.filter((x) => x.seq > prevEnd && x.seq <= (rec.endSeq ?? rec.summarySeq ?? Infinity))
        return {
          ok: true,
          compaction: { id: rec.id, startSeq: rec.startSeq, endSeq: rec.endSeq, turn: rec.turn, summaryChars: rec.summary.length, summaryTokens: estimateTokens(rec.summary) },
          history: { chars: history.length, tokens: estimateTokens(history), constraints: constraints.length },
          prunes: mine,
          kept: kept.slice(0, 40).map((c) => ({ kind: c.kind, text: c.text.slice(0, 140) })),
          lost: lost.slice(0, 60).map((c) => ({ kind: c.kind, text: c.text.slice(0, 140) })),
        }
      },
    },
    {
      name: 'compaction_audit_log_check',
      description:
        'Check the session log itself for structural integrity: every tool call must have a result, and the event sequence must be ordered. This is not a loss check — DSH appends events and never deletes them, so a failure here means the log is truncated or the audit\'s model of the host is wrong, which invalidates every other finding. Returns {ok, calls, results, orphans, gaps}.',
      parameters: {
        type: 'object',
        properties: { session: { type: 'string', description: 'Path to a session.v4.jsonl.zstd file or session directory.' } },
        required: ['session'],
      },
      async execute(args) {
        const p = args.session
        const file = existsSync(p) && p.endsWith('.zstd') ? p : join(p, 'session.v4.jsonl.zstd')
        if (!existsSync(file)) return { ok: false, error: `no session.v4.jsonl.zstd at ${p}` }
        const { events, error } = loadSession(file)
        if (error) return { ok: false, error }
        const pairing = checkPairing(events)
        let gaps = 0
        for (let i = 1; i < events.length; i++) {
          if (events[i].seq != null && events[i - 1].seq != null && events[i].seq !== events[i - 1].seq + 1) gaps += 1
        }
        return {
          ok: pairing.orphans.length === 0 && gaps === 0,
          calls: pairing.total,
          results: events.filter((e) => String(e.type) === 'tool/result').length,
          orphans: pairing.orphans.slice(0, 20),
          gaps,
          note: gaps > 0 ? `${gaps} sequence gaps — the log may have been trimmed or the session was resumed` : null,
        }
      },
    },
  ]

  for (const t of tools) {
    try {
      ctx.tools.register({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        output: { schema: OUTPUT_SCHEMA, render: outRender },
        timeoutMs: 300_000,
        isConcurrencySafe: () => true,
        presentCall: (args) => ({ card: 'generic', title: t.name, kind: 'read', rawInput: args }),
        execute: t.execute,
      })
    } catch (error) {
      console.error(`[compaction-audit] ${t.name} registration skipped: ${error}`)
    }
  }
}
