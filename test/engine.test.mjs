import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  auditCompaction,
  auditSession,
  checkPairing,
  estimateTokens,
  eventText,
  extractCompactions,
  extractConstraints,
  historyBefore,
  isPreserved,
  loadSession,
  summaryText,
} from '../lib/engine.js'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---- event construction helpers ----
const ev = (seq, type, data) => ({ type, seq, time: 1792630933999 + seq, data })

const userMsg = (seq, text) => ev(seq, 'user/message', { content: [{ type: 'text', text }] })
const asstMsg = (seq, text) => ev(seq, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } })
const toolCall = (seq, callId, name) => ev(seq, 'tool/call', { callId, name, arguments: '{}' })
const toolResult = (seq, callId) => ev(seq, 'tool/result', { message: { role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'ok' }] } })
const compStart = (seq, id, turn) => ev(seq, 'compaction/start', { compactionId: id, turn })
const compSummary = (seq, id, text) => ev(seq, 'compaction/summary', { compactionId: id, summary: [{ type: 'text', text }] })
const compEnd = (seq, id, turn) => ev(seq, 'compaction/end', { compactionId: id, turn })
const prune = (seq, n) => ({ seq, range: { start: seq, end: seq }, seqs: [seq], tokenCount: n })
// the event form, for tests that build a full event list
const pruneEvent = (seq, n) => ev(seq, 'compaction/prune', { shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: n })

// =====================================================================
// extraction
// =====================================================================
test('extractCompactions groups start/summary/end by id and separates prunes', () => {
  const events = [
    pruneEvent(10, 500),
    compStart(20, 'c1', 3),
    compSummary(21, 'c1', 'a summary'),
    compEnd(22, 'c1', 3),
    compStart(30, 'c2', 4),
  ]
  const { compactions, prunes } = extractCompactions(events)
  assert.equal(compactions.length, 2)
  assert.equal(prunes.length, 1)
  assert.equal(compactions[0].summary, 'a summary')
  assert.equal(compactions[0].startSeq, 20)
  assert.equal(compactions[0].endSeq, 22)
  assert.equal(compactions[1].summary, null)
  assert.equal(prunes[0].tokenCount, 500)
})

test('summaryText flattens a parts array', () => {
  assert.equal(summaryText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\n\nb')
  assert.equal(summaryText('plain'), 'plain')
  assert.equal(summaryText(null), '')
})

test('eventText skips reasoning parts', () => {
  const e = ev(1, 'assistant/message', { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'shown' }] } })
  assert.equal(eventText(e), 'shown')
})

// =====================================================================
// constraint extraction
// =====================================================================
test('extractConstraints finds negations, requirements and scope limits', () => {
  const text = [
    'Do not approve again without reading the diff.',
    '你必须先跑测试再提交',
    'only in the desktop profile',
    'Please always run the gate first.',
    '只允许在 E:\\plugin 目录下修改',
  ].join('\n')
  const kinds = extractConstraints(text).map((c) => c.kind)
  assert.ok(kinds.includes('negation'), 'negation')
  assert.ok(kinds.includes('requirement'), 'requirement')
  assert.ok(kinds.includes('scope'), 'scope')
})

test('extractConstraints separates constraints from identifiers', () => {
  const text = 'Do not edit E:\\dsh\\plugin\\lib\\index.js on port 8080.'
  const onlyIds = extractConstraints(text, { constraints: false, identifiers: true })
  const kinds = new Set(onlyIds.map((c) => c.kind))
  assert.ok(kinds.has('abs-path'))
  assert.ok(kinds.has('port'))
  assert.ok(!kinds.has('negation'), 'identifier mode must not return constraint phrases')
})

test('a Chinese prose slash is not a path', () => {
  const text = '方案/数据/渠道 都要覆盖，教程复刻不要做。'
  const ids = extractConstraints(text, { constraints: false, identifiers: true })
  assert.deepEqual(ids.filter((i) => i.kind === 'abs-path'), [])
})

test('C keywords and registers are not paths', () => {
  for (const raw of ['/break/continue', '/U/UL/F', '/addss/subss/mulss/divss/comiss']) {
    const ids = extractConstraints(raw, { constraints: false, identifiers: true }).filter((i) => i.kind === 'abs-path')
    assert.deepEqual(ids, [], `${raw} must not be a path`)
  }
})

test('a numbered list is not a path', () => {
  const ids = extractConstraints('/04/12/15/16/28:', { constraints: false, identifiers: true }).filter((i) => i.kind === 'abs-path')
  assert.deepEqual(ids, [])
})

test('a version prefix of an IP is not a version', () => {
  const ids = extractConstraints('server at 127.0.0.1 and pkg 1.66.28', { constraints: false, identifiers: true })
  assert.ok(!ids.some((i) => i.verbatim === '127.0.0'), 'must not truncate the IP into a version')
  assert.ok(ids.some((i) => i.verbatim === '1.66.28'), 'the real version must survive')
})

test('loopback is not a claim needing a basis', () => {
  const ids = extractConstraints('127.0.0.1', { constraints: false, identifiers: true })
  assert.deepEqual(ids.filter((i) => i.kind === 'ip'), [])
})

test('assembly vocabulary is not an env var', () => {
  const ids = extractConstraints('the ADDRESS OFFSET PTR are keywords', { constraints: false, identifiers: true })
  assert.deepEqual(ids.filter((i) => i.kind === 'env-var'), [])
})

// =====================================================================
// preservation
// =====================================================================
test('isPreserved accepts verbatim and rejects a loss', () => {
  const c = { kind: 'negation', verbatim: 'do not approve again', text: 'do not approve again' }
  // exact wording survives
  assert.equal(isPreserved(c, 'Remember: do not approve again.'), true)
  // the substance is gone even though two of three tokens appear
  assert.equal(isPreserved(c, 'all tests passed and the plugin was published'), false)
})

test('isPreserved treats a rephrasing that keeps the substance as preserved', () => {
  // "never approve" and "do not approve again" share the operative tokens
  const c = { kind: 'negation', verbatim: 'do not approve again', text: 'do not approve again' }
  assert.equal(isPreserved(c, 'do not approve it again under any circumstances'), true)
})

// =====================================================================
// pairing
// =====================================================================
test('checkPairing links results through message.toolCallId', () => {
  const events = [toolCall(1, 'c-1', 'web_search'), toolResult(2, 'c-1'), toolCall(3, 'c-2', 'bash'), toolResult(4, 'c-2')]
  const { total, orphans } = checkPairing(events)
  assert.equal(total, 2)
  assert.deepEqual(orphans, [])
})

test('checkPairing reports a genuinely unanswered call', () => {
  const events = [toolCall(1, 'c-1', 'web_search'), toolCall(3, 'c-2', 'bash'), toolResult(4, 'c-2')]
  const { orphans } = checkPairing(events)
  assert.equal(orphans.length, 1)
  assert.equal(orphans[0].callId, 'c-1')
})

// =====================================================================
// the audit itself
// =====================================================================
test('a summary that keeps everything produces no constraint finding', () => {
  const history = 'Do not approve again. You must run the gate first. Only in the desktop profile.'
  const summary = 'Constraints: do not approve again; must run the gate first; only in the desktop profile.'
  const findings = auditCompaction({ id: 'c', startSeq: 1, summary }, history, [])
  assert.deepEqual(findings.filter((f) => f.rule === 'constraint-lost'), [])
})

test('a summary that drops constraints is reported with the rate', () => {
  const history = [
    'Do not approve again.',
    'You must run the gate before publishing.',
    'Never edit the profile patch by hand.',
    'Always run the tests.',
    'Only in the desktop profile.',
    'Do not use pnpm for local installs.',
  ].join('\n')
  const summary = 'The plugin was published and the tests passed.'
  const findings = auditCompaction({ id: 'c', startSeq: 1, summary }, history, [])
  const lost = findings.find((f) => f.rule === 'constraint-lost')
  assert.ok(lost, 'constraint-lost expected')
  assert.equal(lost.severity, 'error')
  assert.equal(lost.data.total, 6)
  assert.equal(lost.data.kept, 0)
  assert.match(lost.title, /0% kept/)
})

test('a summary inventing an identifier is a hallucination', () => {
  const history = 'The file is at E:\\dsh\\plugin\\lib\\index.js and the port is 8080.'
  const summary = 'Edit src/lexer.py and tests/cases_extra.py, then deploy to port 9999.'
  const findings = auditCompaction({ id: 'c', startSeq: 1, summary }, history, [])
  const hall = findings.find((f) => f.rule === 'summary-hallucination')
  assert.ok(hall, 'hallucination expected')
  assert.ok(hall.data.items.some((i) => i.text.includes('lexer.py')))
  assert.ok(hall.data.items.some((i) => i.text === '9999'))
})

test('a rephrased constraint is not a hallucination', () => {
  const history = 'Do not register the tool globally.'
  const summary = 'The tool must never be registered globally.'
  const findings = auditCompaction({ id: 'c', startSeq: 1, summary }, history, [])
  assert.deepEqual(findings.filter((f) => f.rule === 'summary-hallucination'), [])
})

test('ghost references are reported', () => {
  const summary = 'As noted earlier, the build failed. See above for the error.'
  const findings = auditCompaction({ id: 'c', startSeq: 1, summary }, 'the build failed once', [])
  const ghost = findings.find((f) => f.rule === 'ghost-reference')
  assert.ok(ghost)
  assert.ok(ghost.data.items.length >= 2)
})

test('token accounting flags a summary as large as what it freed', () => {
  const big = 'x '.repeat(2000)
  const rules = auditCompaction({ id: 'c', startSeq: 1, summary: big }, 'some history', [prune(1, 100)]).map((f) => f.rule)
  assert.ok(rules.includes('token-accounting'), `expected token-accounting, got ${rules.join(',')}`)
})

test('an unaccounted prune is flagged', () => {
  const rules = auditCompaction({ id: 'c', startSeq: 1, summary: 'short summary' }, 'a little history', [prune(1, 50_000)]).map((f) => f.rule)
  assert.ok(rules.includes('prune-unaccounted'), `expected prune-unaccounted, got ${rules.join(',')}`)
})

test('a compaction with no summary is info, not a warning', () => {
  const findings = auditCompaction({ id: 'c', startSeq: 5, summary: null }, 'history', [])
  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'info')
  assert.equal(findings[0].rule, 'no-summary')
})

// =====================================================================
// historyBefore: injected context must not count as a loss
// =====================================================================
test('historyBefore strips harness-injected context', () => {
  const events = [
    userMsg(1, '<system-reminder>\nA skill is a reusable set of instructions.\n</system-reminder>'),
    userMsg(2, 'Current runtime context. This snapshot supersedes earlier snapshots.'),
    userMsg(3, 'Keep the workspace at E:\\plugin.'),
    asstMsg(4, 'Noted.'),
  ]
  const history = historyBefore(events, 5)
  assert.ok(history.includes('Keep the workspace'))
  assert.ok(!history.includes('system-reminder'))
  assert.ok(!history.includes('runtime context'))
})

// =====================================================================
// session level
// =====================================================================
test('auditSession reports a prune-only session as info', () => {
  const events = [userMsg(1, 'hello'), asstMsg(2, 'hi'), pruneEvent(3, 400)]
  const { findings } = auditSession(events)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'prune-only-session')
  assert.equal(findings[0].severity, 'info')
})

test('auditSession audits each summarising compaction against its own history', () => {
  const events = [
    userMsg(1, 'Do not approve again.'),
    asstMsg(2, 'Understood.'),
    compStart(10, 'c1', 1),
    compSummary(11, 'c1', 'Summary: nothing was decided.'),
    compEnd(12, 'c1', 1),
  ]
  const { summarised, findings } = auditSession(events)
  assert.equal(summarised.length, 1)
  assert.ok(findings.some((f) => f.rule === 'constraint-lost'))
})

test('auditSession flags a broken log invariant', () => {
  const events = [toolCall(1, 'c-1', 'bash')]
  const { findings } = auditSession(events)
  const broken = findings.find((f) => f.rule === 'log-invariant-broken')
  assert.ok(broken)
  assert.equal(broken.severity, 'error')
})

// =====================================================================
// token estimate
// =====================================================================
test('estimateTokens weights CJK above latin', () => {
  assert.ok(estimateTokens('中文文本测试') > estimateTokens('abc'))
  assert.equal(estimateTokens(''), 0)
})
