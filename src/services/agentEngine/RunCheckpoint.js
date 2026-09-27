// ── RunCheckpoint.js ────────────────────────────────────────────────────
// Phase 4 (Bounded Runs): state checkpoints for bounded resume.
//
// A checkpoint is task/bounded state, never a transcript dump:
//   task state (existing v1 text fields) + immutable facts + rolling summary
//   + RunLedger snapshot + bounded recent messages + run metadata.
//
// Migration: v1 (and older/partial/unknown shapes) normalize to v2 through
// migrateCheckpoint, which never trusts unknown fields and never reintroduces
// unlimited history — legacy message arrays pass through Phase 2 window
// rules. Resume reconstructs a fresh MessageWindow from the bounded state.
// All helpers are pure and unit-testable; no Electron dependencies.
// ─────────────────────────────────────────────────────────────────────────────
import { partitionMessageUnits, classifyMessage, MESSAGE_KINDS } from './MessageWindow.js'
import { isValidSummary } from './RollingSummarizer.js'

export const CHECKPOINT_VERSION = 2
export const MAX_RECENT_MESSAGES = 12
export const MAX_OBSERVATIONS = 24
export const MAX_RUNTIME_HISTORY = 80

function cleanString(value, max, fallback = '') {
  if (typeof value !== 'string') return fallback
  return value.length > max ? value.slice(0, max) : value
}

function cleanStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
}

/**
 * Take the newest complete units covering at most maxMessages raw messages.
 * Unit boundaries are never split and a leading tool-result orphan is never
 * returned, so the result is always a valid request prefix.
 */
export function takeRecentUnits(entries, maxMessages = MAX_RECENT_MESSAGES) {
  const list = Array.isArray(entries) ? entries : []
  const classified = []
  for (const item of list) {
    const msg = item && typeof item === 'object' && 'msg' in item ? item.msg : item
    if (!msg || typeof msg !== 'object') continue
    const kind = (item && typeof item === 'object' && item.kind) || classifyMessage(msg) || 'user'
    classified.push({ msg, kind })
  }
  const units = partitionMessageUnits(classified)
  const taken = []
  let count = 0
  for (let i = units.length - 1; i >= 0; i--) {
    const unit = units[i]
    if (taken.length > 0 && count + unit.entries.length > maxMessages) break
    // Always keep the newest unit so the result is never empty when input isn't.
    taken.unshift(unit)
    count += unit.entries.length
    if (count >= maxMessages) break
  }
  const messages = taken.flatMap(unit => unit.entries.map(entry => entry.msg))
  while (messages.length > 0 && classifyMessage(messages[0]) === MESSAGE_KINDS.TOOL_RESULT) {
    messages.shift()
  }
  return messages
}

/**
 * Build a v2 checkpoint from live run state. The caller supplies the existing
 * v1 text fields (already clipped); bounded state comes from the window and
 * ledger snapshots. Single synchronous construction = coherent boundary.
 */
export function buildCheckpointV2({ base = {}, ledger = null, messageWindow = null, meta = {} } = {}) {
  const summary = messageWindow && messageWindow.summary && isValidSummary(messageWindow.summary)
    ? messageWindow.summary
    : null
  const facts = messageWindow && Array.isArray(messageWindow.facts) ? [...messageWindow.facts] : []
  const recentMessages = messageWindow
    ? takeRecentUnits(messageWindow.entries, MAX_RECENT_MESSAGES)
    : []
  return {
    version: CHECKPOINT_VERSION,
    // v1 text fields (source-of-truth prose, unchanged semantics).
    task: cleanString(base.task, 2000),
    workspace: cleanString(base.workspace, 500),
    approvedPlan: cleanString(base.approvedPlan, 12000),
    changedFiles: cleanStringArray(base.changedFiles).slice(0, 100),
    observations: Array.isArray(base.observations) ? base.observations.slice(-MAX_OBSERVATIONS) : [],
    verification: base.verification && typeof base.verification === 'object' ? base.verification : null,
    runtimeHistory: Array.isArray(base.runtimeHistory) ? base.runtimeHistory.slice(-MAX_RUNTIME_HISTORY) : [],
    // v2 bounded state.
    summary,
    facts,
    recentMessages,
    ledger: ledger && typeof ledger.snapshot === 'function' ? ledger.snapshot() : null,
    // Run metadata for the resume flow (informational; model comes from live config).
    model: meta.model !== undefined ? meta.model : null,
    provider: meta.provider !== undefined ? meta.provider : null,
    runId: meta.runId !== undefined ? meta.runId : null,
    turns: Number.isFinite(meta.turns) ? meta.turns : 0,
    maxTurns: Number.isFinite(meta.maxTurns) ? meta.maxTurns : 0,
    savedAt: Date.now()
  }
}

/**
 * Normalize any checkpoint-shaped input to v2. Never throws; unknown or
 * hostile shapes yield { checkpoint: null } (resume proceeds fresh) or a
 * sanitized v2 object plus warnings. Unknown future fields are ignored, never
 * trusted.
 */
export function migrateCheckpoint(raw) {
  const warnings = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { checkpoint: null, warnings: ['checkpoint missing or not an object; resuming without saved state'], migratedFrom: 'invalid' }
  }
  const version = raw.version
  if (typeof version === 'number' && version > CHECKPOINT_VERSION) {
    warnings.push(`checkpoint version ${version} is newer than supported v${CHECKPOINT_VERSION}; known fields kept, unknown fields ignored`)
  }
  const text = {
    task: cleanString(raw.task, 2000),
    workspace: cleanString(raw.workspace, 500),
    approvedPlan: cleanString(raw.approvedPlan, 12000),
    changedFiles: cleanStringArray(raw.changedFiles).slice(0, 100),
    observations: Array.isArray(raw.observations) ? raw.observations.slice(-MAX_OBSERVATIONS) : [],
    verification: raw.verification && typeof raw.verification === 'object' ? raw.verification : null,
    runtimeHistory: Array.isArray(raw.runtimeHistory) ? raw.runtimeHistory.slice(-MAX_RUNTIME_HISTORY) : []
  }

  // Summary: only a validated object survives; never manufactured.
  let summary = null
  if (raw.summary !== undefined && raw.summary !== null) {
    if (isValidSummary(raw.summary)) summary = raw.summary
    else warnings.push('checkpoint summary failed validation; resuming without a summary')
  }

  // Facts: strings only, independently preserved (never re-derived by LLM).
  let facts = cleanStringArray(raw.facts)
  if (raw.facts !== undefined && !Array.isArray(raw.facts)) warnings.push('checkpoint facts malformed; ignored')

  // Recent messages: bounded + validity-checked; a legacy transcript is
  // migrated through unit-boundary rules instead of restored raw.
  let recentMessages = []
  const legacyMessages = Array.isArray(raw.recentMessages) ? raw.recentMessages
    : Array.isArray(raw.nativeMessages) ? raw.nativeMessages : null
  if (legacyMessages) {
    recentMessages = takeRecentUnits(legacyMessages, MAX_RECENT_MESSAGES)
    if (raw.nativeMessages && !raw.recentMessages) warnings.push('legacy transcript migrated through bounded-window rules; unlimited history not restored')
  } else if (raw.recentMessages !== undefined || raw.nativeMessages !== undefined) {
    warnings.push('checkpoint message history malformed; resuming without recent messages')
  }

  // Ledger snapshot: structural sanity only; RunLedger.restore merges it.
  let ledger = null
  if (raw.ledger !== undefined && raw.ledger !== null) {
    if (raw.ledger && typeof raw.ledger === 'object' && raw.ledger.totals && typeof raw.ledger.totals === 'object') {
      ledger = raw.ledger
    } else {
      warnings.push('checkpoint ledger malformed; measurements restart from zero')
    }
  }

  const checkpoint = {
    version: CHECKPOINT_VERSION,
    ...text,
    summary,
    facts,
    recentMessages,
    ledger,
    model: raw.model !== undefined ? raw.model : null,
    provider: raw.provider !== undefined ? raw.provider : null,
    runId: raw.runId !== undefined ? raw.runId : null,
    turns: Number.isFinite(raw.turns) ? raw.turns : 0,
    maxTurns: Number.isFinite(raw.maxTurns) ? raw.maxTurns : 0,
    savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : Date.now()
  }
  const migratedFrom = version === CHECKPOINT_VERSION ? 'v2' : (typeof version === 'number' ? `v${version}` : 'legacy')
  return { checkpoint, warnings, migratedFrom }
}

/**
 * Reconstruct a fresh MessageWindow from a migrated checkpoint. Facts stay
 * facts, the summary is committed only if valid, recent messages restore in
 * order with trailing incomplete tool exchanges dropped explicitly.
 * Returns { restoredMessages, droppedIncomplete, warnings }.
 */
export function restoreIntoWindow({ window, checkpoint }) {
  const warnings = []
  if (!window || !checkpoint || typeof checkpoint !== 'object') {
    return { restoredMessages: 0, droppedIncomplete: 0, warnings: ['nothing to restore'] }
  }
  for (const fact of cleanStringArray(checkpoint.facts)) window.addFact(fact)
  if (checkpoint.summary !== null && checkpoint.summary !== undefined) {
    if (!window.setSummary(checkpoint.summary)) warnings.push('checkpoint summary rejected; continuing without it')
  }
  let restoredMessages = 0
  if (Array.isArray(checkpoint.recentMessages)) {
    for (const msg of checkpoint.recentMessages) {
      if (window.push(msg) !== null) restoredMessages += 1
    }
  }
  const droppedIncomplete = window.dropTrailingIncompleteExchange()
  if (droppedIncomplete > 0) {
    warnings.push(`dropped ${droppedIncomplete} trailing message(s) forming an incomplete tool exchange`)
  }
  return { restoredMessages, droppedIncomplete, warnings }
}
