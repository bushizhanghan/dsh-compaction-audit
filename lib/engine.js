// dsh-compaction-audit engine.
//
// What compaction actually does in DSH (established by reading a real session
// log, not the docs): it does NOT delete events. The event log is append-only
// and complete; a compaction *inserts* a summary message into the model-visible
// surface at a turn boundary, and `compaction/prune` separately records ranges
// whose tokens were trimmed from the surface. Every `tool/call` before a
// summary still has its `tool/result` after it — 1306 of 1306 in the session
// this was measured on.
//
// So "what did compaction lose" is not a question about the log. It is a
// question about the *summary*: does the summary, which is what the model now
// sees instead of the history, still carry the constraints and facts that were
// in the history it replaced? That is the paper Lost in Compaction (arXiv
// 2608.11242) result — ~17% of session constraints survive on average — and
// it is checkable without an LLM, because constraints are recognisable by form.
//
// Every compactor in this ecosystem ships a quality checklist as a TODO in its
// own design doc; none ships the checker. This is the checker, and it audits
// whichever compactor produced the summary.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

// =====================================================================
// Session log reading
// =====================================================================

/** Load a session.v4.jsonl.zstd into ordered events. */
export function loadSession(file) {
  if (!existsSync(file)) return { events: [], error: `not found: ${file}` }
  let text
  try {
    text = execFileSync('zstd', ['-dc', file], { maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' })
  } catch (e) {
    return { events: [], error: `cannot decompress (is zstd installed?): ${String(e.message).slice(0, 120)}` }
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {}
  }
  events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  return { events, error: null }
}

/**
 * Pull the compaction records out of an event list.
 *
 * Two distinct mechanisms share the `compaction/` prefix and must not be
 * conflated:
 *
 *   - `start` / `summary` / `end` carry a `compactionId`: a real summarising
 *     compaction. That is what the audit can judge.
 *   - `prune` carries no id, only `shadowedRange` / `shadowedSeqs` /
 *     `shadowedTokenCount`: a silent micro-trim (tool-output clipping). It is
 *     not a compaction in the lossy sense, so it is reported separately rather
 *     than being audited as if a summary were missing.
 *
 * A `start` without a matching `summary` is likewise normal (the run ended, or
 * the compaction was aborted), so it is recorded with `summary: null` and only
 * surfaced as info — never as a warning that implies data loss.
 */
export function extractCompactions(events) {
  const byId = new Map()
  const prunes = []
  for (const ev of events) {
    const t = String(ev.type || '')
    if (t !== 'compaction/start' && t !== 'compaction/end' && t !== 'compaction/summary' && t !== 'compaction/prune') continue
    const d = ev.data || {}
    if (t === 'compaction/prune') {
      prunes.push({
        seq: ev.seq,
        range: d.shadowedRange ?? null,
        seqs: Array.isArray(d.shadowedSeqs) ? d.shadowedSeqs : [],
        tokenCount: Number(d.shadowedTokenCount ?? 0),
      })
      continue
    }
    const id = d.compactionId ?? `seq:${ev.seq}`
    if (!byId.has(id)) byId.set(id, { id, startSeq: null, endSeq: null, summarySeq: null, summary: null, turn: null })
    const rec = byId.get(id)
    if (t === 'compaction/start') {
      rec.startSeq = ev.seq
      if (d.turn != null) rec.turn = d.turn
    } else if (t === 'compaction/end') {
      rec.endSeq = ev.seq
      if (d.turn != null) rec.turn = d.turn
    } else if (t === 'compaction/summary') {
      rec.summary = summaryText(d.summary)
      rec.summarySeq = ev.seq
    }
  }
  return { compactions: [...byId.values()].sort((a, b) => (a.startSeq ?? 0) - (b.startSeq ?? 0)), prunes }
}

/** Flatten a summary payload to plain text. */
export function summaryText(summary) {
  if (typeof summary === 'string') return summary
  if (!Array.isArray(summary)) return ''
  const parts = []
  for (const p of summary) {
    if (typeof p === 'string') parts.push(p)
    else if (p && typeof p === 'object' && typeof p.text === 'string') parts.push(p.text)
  }
  return parts.join('\n\n').trim()
}

// =====================================================================
// Text extraction from events
// =====================================================================

/** The visible text of a message event, reasoning excluded. */
export function eventText(ev) {
  const d = ev?.data || {}
  const holder = d.message && typeof d.message === 'object' ? d.message : d
  const parts = Array.isArray(holder.content) ? holder.content : Array.isArray(d.content) ? d.content : []
  const out = []
  for (const p of parts) {
    if (typeof p === 'string') {
      if (p.trim()) out.push(p)
      continue
    }
    if (!p || typeof p !== 'object') continue
    if (/^(reasoning|thinking|thought)$/i.test(p.type || '')) continue
    if (typeof p.text === 'string' && p.text.trim()) out.push(p.text)
  }
  return out.join('\n\n').trim()
}

// =====================================================================
// Constraint extraction — the core of the audit
// =====================================================================

/**
 * Session constraints: the things the user said that must survive compaction.
 * arXiv 2608.11242 defines them as standing instructions ("do not delete mail
 * until I confirm"). In practice they are recognisable by form, so a
 * deterministic matcher gets most of them:
 *
 *   - imperative negations:  "don't X", "never X", "不要X", "别X", "禁止X"
 *   - standing requirements:  "must X", "always X", "一定要X", "必须X", "始终X"
 *   - hard identifiers:       absolute paths, versions, ports, appids, ids
 *   - explicit scope limits:  "only in X", "只准X", "仅限于X"
 */
const CONSTRAINT_PATTERNS = [
  { kind: 'negation', re: /\b(?:don'?t|do not|never|avoid)\s+([^.,;!\n]{6,90})/gi },
  { kind: 'negation', re: /(?:不要|别|禁止|切勿|不允许|不能)([^。，,;；!！\n]{4,60})/g },
  { kind: 'requirement', re: /\b(?:must|always|shall)\s+([^.,;!\n]{6,90})/gi },
  { kind: 'requirement', re: /(?:必须|一定要|务必|始终|永远|每次都要)([^。，,;；!！\n]{4,60})/g },
  { kind: 'scope', re: /\bonly\s+(?:in|for|when|on)\s+([^.,;!\n]{4,70})/gi },
  { kind: 'scope', re: /(?:只准|只允许|仅限于|只能在)([^。，,;；!！\n]{4,60})/g },
]

/**
 * Hard identifiers that must never be paraphrased away.
 *
 * These patterns were tightened against a real 161 KB compacted history, where
 * the loose versions produced five classes of false positive:
 *   - `s:\n\n1.`  a drive letter followed by a newline (not a path)
 *   - `/break/continue`  C keywords that happen to contain a slash
 *   - `/04/12/15/16/28:`  a numbered list
 *   - `127.0.0`  a version regex that stopped one octet short
 *   - `方案/数据/渠道`  Chinese prose using / as a separator
 * So: paths may not contain whitespace or a newline, must have at least one
 * segment with a recognisable extension or a known directory name, and a
 * version must be complete.
 */
const IDENTIFIER_PATTERNS = [
  // windows path with a real drive letter, no whitespace, and a backslash
  { kind: 'abs-path', re: /\b[A-Za-z]:\\[^\s'"`)\]]{1,118}\b/g },
  // unix path: a leading slash, then >=2 segments, none purely numeric, no whitespace
  { kind: 'abs-path', re: /\/(?:[\w.-]+\/)+[\w.-]+/g },
  // relative path: at least one directory separator and a file extension
  { kind: 'rel-path', re: /\b[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z][\w]{0,9}\b/g },
  // a version must not be the prefix of an IP (127.0.0 out of 127.0.0.1)
  { kind: 'version', re: /\b\d+\.\d+\.\d+(?:-[\w.]+)?\b(?!\.\d)/g },
  // 127.0.0.1 and friends are loopback, not a claim that needs a basis
  { kind: 'ip', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, skip: (v) => /^127\./.test(v) },
  // `port` needs no leading \b before the CJK form: \b does not fire between a
  // CJK character and a space, so "\b端口" never matches "代理端口 7891".
  { kind: 'port', re: /(?:\bport\b|端口)\s*[:：]?\s*(\d{4,5})\b/g },
  { kind: 'appid', re: /\bwx[0-9a-f]{16}\b/gi },
  { kind: 'uuid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { kind: 'env-var', re: /\b[A-Z][A-Z0-9_]{3,}\b/g },
]

/** A unix-ish path that is really code or a list, not a path. */
function looksLikePath(raw) {
  if (/[\s]/.test(raw)) return false
  if (/\n/.test(raw)) return false
  const segs = raw.replace(/^\//, '').split('/')
  if (segs.some((s) => s === '')) return false
  // every segment numeric -> a numbered list, not a path
  if (segs.every((s) => /^\d+$/.test(s))) return false
  // C/C++ keywords used as segments
  // x86 registers and SSE/AVX mnemonics show up as path-shaped text
  // x86 registers, sizes and SSE/AVX mnemonics show up as path-shaped text
  if (segs.some((s) => /^(?:break|continue|if|else|for|while|return|case|default|sizeof|struct|class|void|int|char|float|double|new|delete|try|catch|switch)$/i.test(s))) return false
  if (segs.some((s) => /^(?:[Rr]ax|[Rr]bx|[Rr]cx|[Rr]dx|[Rr]si|[Rr]di|[Rr]bp|[Rr]sp|[Rr]8|[Rr]9|[Rr]1[0-5]|eax|ebx|ecx|edx|esi|edi|ebp|esp|[A-D]X|[A-D]H|[A-D]L|[BWDLQ]?[A-D]X|[UQ]?L|xmm[0-9]+|ymm[0-9]+|[QU]?WORD|BYTE|DWORD|QWORD|TBYTE|ADDRESS|OFFSET|PTR)$/i.test(s))) return false
  if (segs.some((s) => /^(?:add|sub|mul|div|mov|movss|movsd|addss|addsd|subss|subsd|mulss|mulsd|divss|divsd|comiss|comisd|cvt|cvtsi|cvtts|push|pop|call|ret|jmp|je|jne|jg|jl|lea|test|cmp|and|or|xor|not|shl|shr|inc|dec|nop|int|syscall)$/i.test(s))) return false
  return true
}

/**
 * Words too generic — or too code-shaped — to count as an identifier that must
 * survive verbatim. `ADDRESS`, `OFFSET`, `PTR` are assembly vocabulary that the
 * env-var pattern otherwise catches as if they were environment variables.
 */
const STOP_WORDS = new Set([
  'TODO', 'FIXME', 'NOTE', 'HTTP', 'HTTPS', 'JSON', 'YAML', 'UTF', 'ASCII', 'NULL', 'TRUE', 'FALSE', 'ERROR', 'WARN', 'INFO',
  'ADDRESS', 'OFFSET', 'PTR', 'WORD', 'DWORD', 'QWORD', 'BYTE', 'LABEL', 'SECTION', 'SEGMENT',
])

/**
 * Extract constraints and identifiers from a piece of text.
 * Returns [{kind, text, verbatim}] where verbatim is the exact substring that
 * must appear in the summary for the item to count as preserved.
 *
 * The two families are independent and are asked for separately: the constraint
 * survival check wants phrases, the hallucination check wants only identifiers
 * (a rephrased "never register" is not an invention, but a port number that was
 * never in the source is).
 */
export function extractConstraints(text, { constraints = true, identifiers = true } = {}) {
  if (!text) return []
  const out = []
  const seen = new Set()
  const push = (kind, verbatim, normalised) => {
    const key = `${kind}:${normalised.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind, text: normalised.trim(), verbatim: verbatim.trim() })
  }
  if (constraints) {
    for (const { kind, re } of CONSTRAINT_PATTERNS) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(text))) {
        const phrase = `${m[0]}`.trim()
        if (phrase.length < 8) continue
        push(kind, m[0], phrase)
      }
    }
  }
  if (identifiers) {
    for (const spec of IDENTIFIER_PATTERNS) {
      const kind = spec.kind
      spec.re.lastIndex = 0
      let m
      while ((m = spec.re.exec(text))) {
        // a pattern with a capture group means the interesting part is group 1
        // (e.g. "port 8080" -> "8080"), and the verbatim must be that value
        const raw = (m[1] ?? m[0]).trim()
        if (spec.skip?.(raw)) continue
        if (kind === 'env-var' && STOP_WORDS.has(raw)) continue
        if (kind === 'version' && /^\d+\.\d+\.\d+$/.test(raw) && raw.startsWith('0.0')) continue
        if (raw.length < 4) continue
        if (kind === 'abs-path' && !looksLikePath(raw)) continue
        push(kind, raw, raw)
      }
    }
  }
  return out
}

/**
 * Is a constraint preserved in the summary?
 * Verbatim match first; then a relaxed match on the distinctive tokens, because
 * a summary legitimately rephrases wording while keeping the substance.
 */
export function isPreserved(constraint, summary) {
  if (!summary) return false
  const s = summary.toLowerCase()
  if (constraint.verbatim && s.includes(constraint.verbatim.toLowerCase())) return true
  // distinctive tokens: drop stopwords, require the rest to co-occur
  const tokens = tokenize(constraint.verbatim || constraint.text)
  if (tokens.length === 0) return false
  const hits = tokens.filter((t) => s.includes(t))
  return hits.length / tokens.length >= 0.7
}

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}._\\/-]+/u)
    .filter((t) => t.length >= 3)
    .filter((t) => !STOP_WORDS.has(t.toUpperCase()))
    .slice(0, 8)
}

// =====================================================================
// Checks. Each returns findings {rule, severity, title, detail, data}
// =====================================================================

const F = (rule, severity, title, detail, data = {}) => ({ rule, severity, title, detail, data })

/**
 * The audit for one summarising compaction.
 *
 * `history` is the message text the summary replaces — everything the model
 * could see before the compaction started. `prunes` are the trim events that
 * fired in the same window; they are what the token accounting is checked
 * against.
 */
export function auditCompaction(rec, history, prunes = []) {
  const findings = []
  if (!rec.summary) {
    findings.push(F('no-summary', 'info', `compaction at seq ${rec.startSeq} produced no summary event`, 'Nothing to audit for this one: either the run ended before the summary was written, or the compaction was aborted. Only summarising compactions can be judged for loss.', { compactionId: rec.id }))
    return findings
  }
  if (!history || history.trim().length === 0) {
    findings.push(F('no-history', 'info', `compaction at seq ${rec.startSeq} has no preceding message text to compare against`, 'The summary replaced an empty surface, so there was nothing to lose.', { compactionId: rec.id }))
    return findings
  }

  // ---- 1. constraint survival ----
  const constraints = extractConstraints(history)
  if (constraints.length > 0) {
    const lost = constraints.filter((c) => !isPreserved(c, rec.summary))
    const rate = 1 - lost.length / constraints.length
    if (lost.length > 0) {
      findings.push(
        F(
          'constraint-lost',
          rate < 0.5 ? 'error' : 'warn',
          `${lost.length} of ${constraints.length} session constraints did not survive the summary (${(rate * 100).toFixed(0)}% kept)`,
          'Session constraints are the standing instructions the user gave (do not X, must Y, only in Z). The paper Lost in Compaction (arXiv 2608.11242) measured ~17% survival across compactors; below 50% the summary is losing more than the context it frees.',
          { compactionId: rec.id, kept: constraints.length - lost.length, total: constraints.length, lost: lost.slice(0, 12).map((c) => ({ kind: c.kind, text: c.text.slice(0, 120) })) },
        ),
      )
    }
  }

  // ---- 2. summary hallucination ----
  const hallucinated = findHallucinations(history, rec.summary)
  if (hallucinated.length > 0) {
    findings.push(
      F(
        'summary-hallucination',
        'error',
        `${hallucinated.length} specific claim(s) in the summary have no basis in the history it replaced`,
        'A summary that introduces numbers, paths, or identifiers that were never in the source is worse than a lossy one: the model trusts it. Each item below appears in the summary but not in the compacted history.',
        { compactionId: rec.id, items: hallucinated.slice(0, 10) },
      ),
    )
  }

  // ---- 3. ghost references ----
  const ghosts = findGhostReferences(rec.summary)
  if (ghosts.length > 0) {
    findings.push(
      F(
        'ghost-reference',
        'warn',
        `${ghosts.length} reference(s) in the summary point at material that is no longer on the surface`,
        'The summary tells the model "see above" / "as noted earlier" about content the model can no longer see, so it either invents the content or stalls.',
        { compactionId: rec.id, items: ghosts.slice(0, 8) },
      ),
    )
  }

  // ---- 4. token accounting ----
  const prunedTokens = prunes.reduce((a, p) => a + (p.tokenCount || 0), 0)
  if (prunedTokens > 0) {
    const summaryTokens = estimateTokens(rec.summary)
    if (summaryTokens > prunedTokens * 0.9) {
      findings.push(
        F(
          'token-accounting',
          'warn',
          `summary is ~${summaryTokens} tokens but only ${prunedTokens} were reported pruned`,
          'The compaction claims to free N tokens while emitting a summary nearly as large. Either the accounting is wrong or the compaction is churning — compacting, refilling, compacting again (Codex issue #14120 burned 80% of a quota this way).',
          { compactionId: rec.id, freed: prunedTokens, summaryTokens },
        ),
      )
    }
  }

  // ---- 5. prune coverage ----
  // A prune that removed far more than the summary is worth: the surface lost
  // material the summary never accounted for.
  if (prunedTokens > 0) {
    const historyTokens = estimateTokens(history)
    if (prunedTokens > historyTokens * 3 && historyTokens > 0) {
      findings.push(
        F(
          'prune-unaccounted',
          'warn',
          `${prunedTokens} tokens were pruned but the replaced history is only ~${historyTokens} tokens of message text`,
          'The trims removed much more than the messages they sat between — tool output, most likely. Tool output that vanishes without a trace is what makes a model later claim it never saw a result it did see.',
          { compactionId: rec.id, prunedTokens, historyTokens },
        ),
      )
    }
  }

  return findings
}

/**
 * The call id a tool/result answers.
 *
 * It is not on `data` — a result carries a `message` whose `toolCallId` is the
 * link (and whose `source.callId` repeats it). Reading `data.callId` finds
 * nothing and makes every call look orphaned; that was measured on a real
 * 304-event session where all 57 calls are in fact answered.
 */
function resultCallId(ev) {
  const d = ev.data || {}
  return d.callId ?? d.message?.toolCallId ?? d.message?.source?.callId ?? d.toolCallId ?? null
}

/**
 * Every tool call must have a result somewhere in the log.
 *
 * DSH's event log is append-only and compaction inserts a summary rather than
 * deleting events, so this is *not* a loss check — it is a consistency check on
 * the audit's own model of the host. If it ever fires, the model is wrong.
 */
export function checkPairing(events) {
  const calls = new Map()
  const results = new Set()
  for (const ev of events) {
    const t = String(ev.type || '')
    if (t === 'tool/call') {
      const id = ev.data?.callId
      if (id) calls.set(id, ev)
    } else if (t === 'tool/result') {
      const id = resultCallId(ev)
      if (id) results.add(id)
    }
  }
  const orphans = [...calls.entries()].filter(([id]) => !results.has(id)).map(([id, ev]) => ({ callId: id, name: ev.data?.name ?? '(unknown)', seq: ev.seq }))
  return { total: calls.size, orphans }
}

/**
 * Specific claims in the summary with no basis in the source.
 * Only checks things that are checkable without judgement: numbers, paths,
 * versions, ports, ids, env vars. Prose will be rephrased; a summary should not
 * invent a port number. Constraint phrases are deliberately excluded — "never
 * registered" is a rephrasing of "do not register", not an invention.
 */
function findHallucinations(source, summary) {
  const items = []
  const sourceIds = new Set(extractConstraints(source, { constraints: false, identifiers: true }).map((c) => c.verbatim.toLowerCase()))
  for (const c of extractConstraints(summary, { constraints: false, identifiers: true })) {
    if (c.kind === 'env-var' && STOP_WORDS.has(c.verbatim)) continue
    const loose = c.verbatim.toLowerCase()
    if (sourceIds.has(loose)) continue
    // a value that is a substring of a source identifier (or vice versa) has a basis
    let basis = false
    for (const s of sourceIds) {
      if (s.includes(loose) || loose.includes(s)) {
        basis = true
        break
      }
    }
    if (!basis) items.push({ kind: c.kind, text: c.verbatim.slice(0, 120) })
  }
  return items
}

/** "see above", "as mentioned earlier", "前面说过" — pointing at removed text. */
const GHOST_RE = [
  /\b(?:see|as (?:noted|mentioned|described|shown)) (?:above|earlier|previously|before)\b/gi,
  /\b(?:the )?(?:above|earlier|previous(?:ly)?) (?:message|context|discussion|output|result)s?\b/gi,
  /(?:如上|如上所述|前面(?:已)?(?:说|提|述)|前述|上述|早些时候)(?:所述|提到|的)?/g,
]

function findGhostReferences(summary) {
  const items = []
  const seen = new Set()
  for (const re of GHOST_RE) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(summary))) {
      const key = m[0].trim().toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      items.push({ text: m[0].trim().slice(0, 80) })
    }
  }
  return items
}

/** Rough token estimate: CJK chars count more than latin words. */
export function estimateTokens(text) {
  if (!text) return 0
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length
  const latin = (text.replace(/[\u3400-\u9fff]/g, ' ').match(/[A-Za-z0-9_]+/g) || []).length
  return Math.round(cjk * 1.5 + latin * 1.3)
}

// =====================================================================
// Whole-session audit
// =====================================================================

/**
 * Injected context that is not conversation and must not be counted as
 * something a summary "lost": the harness re-injects all of it every turn, so
 * a summary that drops it has lost nothing.
 */
const INJECTED_RE = [
  /^<system-reminder>[\s\S]*?<\/system-reminder>/,
  /^Current runtime context\.[\s\S]*$/m,
  /^Time sampled while preparing turn[\s\S]*$/m,
  /^Instructions from:[\s\S]*$/m,
  /^# User-global coding rules[\s\S]*$/m,
  /^This is an automatically generated checkpoint[\s\S]*$/m,
]

function stripInjected(text) {
  let out = text
  for (const re of INJECTED_RE) out = out.replace(re, '')
  return out
}

/**
 * All message text before a seq, which is what a summary at that seq replaces.
 * Harness-injected context (system reminders, runtime snapshots, the global
 * AGENTS.md, the checkpoint preamble) is stripped: it is re-injected on every
 * turn, so its absence from a summary is not a loss and counting it would make
 * every compaction look catastrophic.
 */
export function historyBefore(events, seq) {
  const parts = []
  for (const ev of events) {
    if (ev.seq == null || ev.seq > seq) continue
    const t = String(ev.type || '')
    if (t !== 'user/message' && t !== 'assistant/message') continue
    const text = stripInjected(eventText(ev))
    if (text.trim()) parts.push(text.trim())
  }
  return parts.join('\n\n')
}

export function auditSession(events) {
  const { compactions, prunes } = extractCompactions(events)
  const summarised = compactions.filter((c) => c.summary)
  const findings = []

  for (const rec of summarised) {
    // the history this summary replaced: everything before its start
    const history = historyBefore(events, rec.startSeq ?? rec.summarySeq ?? 0)
    // prunes that fired in the same window as this compaction
    const prevEnd = summarised[summarised.indexOf(rec) - 1]?.endSeq ?? 0
    const mine = prunes.filter((p) => p.seq > prevEnd && p.seq <= (rec.endSeq ?? rec.summarySeq ?? Infinity))
    findings.push(...auditCompaction(rec, history, mine))
  }

  // a session with trims but no summarising compaction at all
  if (summarised.length === 0 && prunes.length > 0) {
    findings.push(
      F(
        'prune-only-session',
        'info',
        `this session has ${prunes.length} prune event(s) and no summarising compaction`,
        'Micro-trims clip tool output without a summary. Nothing was summarised, so there is no summary to audit — but the trimmed tool output is gone from the surface, which is worth knowing when the model later claims it never saw a result.',
        { prunes: prunes.length, tokens: prunes.reduce((a, p) => a + (p.tokenCount || 0), 0) },
      ),
    )
  }

  // log invariant: every tool call must still have its result
  const pairing = checkPairing(events)
  if (pairing.orphans.length > 0) {
    findings.push(
      F(
        'log-invariant-broken',
        'error',
        `${pairing.orphans.length} of ${pairing.total} tool calls have no result in the log`,
        'The event log is supposed to be append-only, so a call without a result means either the run was killed mid-call or the log was truncated. This is not compaction loss — it is a broken log, and it invalidates every other check.',
        { orphans: pairing.orphans.slice(0, 10) },
      ),
    )
  }

  return { compactions, prunes, summarised, findings }
}
