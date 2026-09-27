// ── RollingSummarizer.js ────────────────────────────────────────────────
// Phase 3 (Bounded Runs): rolling summarization of compacted history.
//
// The summary preserves actionable STATE, never a transcript reproduction.
// Precedence (deterministic application state always wins):
//   1. current runtime/task state   2. immutable facts
//   3. verified structured state    4. rolling summary
//   5. recent conversation          6. historical observations
// (mergeWithDeterministic enforces 1-4; MessageWindow ordering enforces the rest.)
//
// No enforcement here: generation, validation, and merge are pure and
// deterministic. The caller (runAgentTask) decides WHEN to summarize, records
// the LLM call in RunLedger via the standard usageSink path, and commits the
// validated replacement atomically through MessageWindow.setSummary.
// ─────────────────────────────────────────────────────────────────────────────
import { z } from 'zod'
import { estimateTokens } from './ContextChunk.js'

export const SUMMARY_VERSION = 1

// Hard bounds. The summary must never grow across cycles: every field is
// capped, and the rendered total is capped by SUMMARY_MAX_TOKENS.
export const SUMMARY_MAX_TOKENS = 2000
export const SUMMARIZER_INPUT_MAX_TOKENS = 6000
export const SUMMARIZER_MAX_TOKENS = 512
export const MAX_SUMMARIZER_CALLS_PER_RUN = 12
export const MAX_EVICTED_EXCHANGES_PER_SUMMARY = 30
export const EVICTED_EXCHANGE_CHARS = 400

const stringList = (itemMax, listMax) => z.array(z.string().max(itemMax)).max(listMax).default([])

export const SummarySchema = z.object({
  version: z.literal(SUMMARY_VERSION),
  objective: z.string().min(1).max(1000),
  requirements: stringList(500, 20),
  constraints: stringList(500, 20),
  decisions: stringList(500, 20),
  discoveries: stringList(500, 20),
  filesInspected: stringList(300, 30),
  filesChanged: stringList(300, 30),
  plan: z.string().max(2000).default(''),
  completedSteps: stringList(300, 20),
  failedApproaches: stringList(500, 15),
  successfulApproaches: stringList(500, 15),
  unresolvedIssues: stringList(500, 15),
  verification: z.object({
    status: z.enum(['passed', 'failed', 'pending', 'not_required', 'unknown']).default('unknown'),
    command: z.string().max(300).default(''),
    detail: z.string().max(1000).default('')
  }).default({ status: 'unknown', command: '', detail: '' }),
  evidence: z.array(z.object({
    note: z.string().max(500),
    ref: z.string().max(200).optional()
  })).max(15).default([]),
  errors: stringList(500, 15),
  nextAction: z.string().max(500).default('')
})

export const SUMMARIZER_SYSTEM_PROMPT = `You compress agent run history into a compact state summary. Output ONLY one JSON object matching the requested schema. Rewrite and refresh: distill prior summary plus new exchanges into current state, do not append transcripts. Never reproduce private chain-of-thought; record conclusions, decisions, and facts. Keep every field short; prefer file paths and one-line evidence notes over raw output. Unresolved issues and verification status must be carried forward accurately.`

/** Deterministic canonical rendering, used for prompts, window messages, and size checks. */
export function renderSummary(summary) {
  const list = (title, items) => (Array.isArray(items) && items.length > 0
    ? `${title}:\n${items.map(item => `- ${typeof item === 'string' ? item : item?.note || ''}`).join('\n')}`
    : null)
  const verification = summary?.verification && typeof summary.verification === 'object' ? summary.verification : {}
  const sections = [
    `Objective: ${summary?.objective || ''}`,
    Array.isArray(summary?.requirements) && summary.requirements.length ? `Requirements: ${summary.requirements.join('; ')}` : null,
    Array.isArray(summary?.constraints) && summary.constraints.length ? `Constraints: ${summary.constraints.join('; ')}` : null,
    list('Decisions', summary?.decisions),
    list('Discoveries', summary?.discoveries),
    Array.isArray(summary?.filesInspected) && summary.filesInspected.length ? `Inspected: ${summary.filesInspected.join(', ')}` : null,
    Array.isArray(summary?.filesChanged) && summary.filesChanged.length ? `Changed: ${summary.filesChanged.join(', ')}` : null,
    summary?.plan ? `Plan: ${summary.plan}` : null,
    list('Done', summary?.completedSteps),
    list('Failed approaches (do not retry blindly)', summary?.failedApproaches),
    list('Working approaches', summary?.successfulApproaches),
    list('Open issues', summary?.unresolvedIssues),
    `Verification: ${verification.status || 'unknown'}${verification.command ? ` (${verification.command})` : ''}${verification.detail ? ` — ${verification.detail}` : ''}`,
    list('Evidence', (summary?.evidence || []).map(e => (e && typeof e === 'object' ? `${e.note}${e.ref ? ` [ref:${e.ref}]` : ''}` : String(e || '')))),
    list('Errors seen', summary?.errors),
    summary?.nextAction ? `Next: ${summary.nextAction}` : null
  ].filter(Boolean)
  return sections.join('\n')
}

export function summaryTokens(summary) {
  try {
    return estimateTokens(renderSummary(summary))
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

/** Extract a JSON object from model text (fenced, bare, or embedded). Null when none found. */
export function extractSummaryJson(text) {
  const source = String(text || '')
  if (!source.trim()) return { found: false, value: null }
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = []
  if (fenced) candidates.push(fenced[1])
  candidates.push(source)
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) candidates.push(source.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      if (value && typeof value === 'object' && !Array.isArray(value)) return { found: true, value }
    } catch {
      // try next candidate
    }
  }
  return { found: false, value: null }
}

/**
 * Validate raw model text into a versioned, bounded summary.
 * Returns { ok:true, summary } or { ok:false, reason } — never throws.
 * Reasons: 'empty' | 'no_json' | 'invalid_json' | 'schema' | 'oversize'.
 */
export function parseAndValidateSummary(rawText) {
  if (!String(rawText || '').trim()) return { ok: false, reason: 'empty' }
  const extracted = extractSummaryJson(rawText)
  if (!extracted.found) return { ok: false, reason: 'no_json' }
  let parsed
  try {
    parsed = SummarySchema.safeParse(extracted.value)
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }
  if (!parsed.success) return { ok: false, reason: 'schema', issues: parsed.error.issues.map(i => `${(i.path || []).join('.')}: ${i.message}`) }
  if (summaryTokens(parsed.data) > SUMMARY_MAX_TOKENS) return { ok: false, reason: 'oversize' }
  return { ok: true, summary: parsed.data }
}

/** True when an arbitrary object already satisfies the schema and size cap. */
export function isValidSummary(value) {
  if (!value || typeof value !== 'object') return false
  const parsed = SummarySchema.safeParse(value)
  return parsed.success && summaryTokens(parsed.data) <= SUMMARY_MAX_TOKENS
}

/**
 * Merge deterministic run state over a validated summary. Deterministic wins;
 * summary supplies everything deterministic state does not authoritatively own.
 * Pure function — the conflict-resolution point tested for precedence.
 */
export function mergeWithDeterministic(summary, deterministic = {}) {
  const base = summary && typeof summary === 'object' ? { ...summary } : {}
  const merged = { ...base }
  if (typeof deterministic.objective === 'string' && deterministic.objective.trim()) {
    merged.objective = deterministic.objective.trim().slice(0, 1000)
  }
  if (Array.isArray(deterministic.filesChanged)) {
    merged.filesChanged = [...new Set(deterministic.filesChanged.map(f => String(f)).filter(Boolean))].slice(0, 30)
  }
  if (deterministic.verification && typeof deterministic.verification === 'object') {
    merged.verification = {
      status: ['passed', 'failed', 'pending', 'not_required', 'unknown'].includes(deterministic.verification.status)
        ? deterministic.verification.status
        : 'unknown',
      command: String(deterministic.verification.command || '').slice(0, 300),
      detail: String(deterministic.verification.detail || '').slice(0, 1000)
    }
  }
  if (typeof deterministic.plan === 'string' && deterministic.plan.trim()) {
    merged.plan = deterministic.plan.trim().slice(0, 2000)
  }
  if (Array.isArray(deterministic.filesInspected)) {
    const union = [...new Set([...(merged.filesInspected || []), ...deterministic.filesInspected.map(f => String(f)).filter(Boolean)])]
    merged.filesInspected = union.slice(0, 30)
  }
  // Re-check the size cap after merging (deterministic overrides are clipped
  // above, so this only guards pathological combinations).
  if (summaryTokens(merged) > SUMMARY_MAX_TOKENS) return { ok: false, reason: 'oversize' }
  const parsed = SummarySchema.safeParse(merged)
  if (!parsed.success) return { ok: false, reason: 'schema' }
  return { ok: true, summary: parsed.data }
}

/**
 * Build the bounded summarizer input. Never the full transcript: previous
 * summary + newly evicted exchanges (clipped, count-capped, oldest trimmed
 * first) + facts + task state + verification. Deterministic.
 */
export function buildSummarizerInput({ previousSummary = null, evictedExchanges = [], facts = [], taskState = '', verificationText = '', maxInputTokens = SUMMARIZER_INPUT_MAX_TOKENS } = {}) {
  const parts = []
  if (previousSummary && typeof previousSummary === 'object') {
    parts.push(`PREVIOUS SUMMARY (refresh, do not append):\n${renderSummary(previousSummary)}`)
  } else {
    parts.push('PREVIOUS SUMMARY: none (first compaction).')
  }
  const exchanges = Array.isArray(evictedExchanges) ? evictedExchanges : []
  const renderedExchanges = []
  for (const exchange of exchanges.slice(-MAX_EVICTED_EXCHANGES_PER_SUMMARY)) {
    const kind = exchange && exchange.kind ? String(exchange.kind) : 'exchange'
    const text = String((exchange && exchange.text) || '').slice(0, EVICTED_EXCHANGE_CHARS)
    if (text.trim()) renderedExchanges.push(`[${kind}] ${text}`)
  }
  if (renderedExchanges.length > 0) parts.push(`NEWLY COMPACTED EXCHANGES (summarize conclusions only, never reproduce verbatim):\n${renderedExchanges.join('\n')}`)
  if (Array.isArray(facts) && facts.length > 0) {
    parts.push(`IMMUTABLE FACTS (already preserved separately; do not contradict):\n${facts.map(f => `- ${String(f).slice(0, 500)}`).join('\n')}`)
  }
  if (typeof taskState === 'string' && taskState.trim()) parts.push(`CURRENT TASK STATE:\n${taskState.trim().slice(0, 2000)}`)
  if (typeof verificationText === 'string' && verificationText.trim()) {
    parts.push(`VERIFICATION STATE:\n${verificationText.trim().slice(0, 1000)}`)
  }
  let text = parts.join('\n\n')
  // Enforce the deterministic input cap by trimming oldest exchanges first.
  let trimmedExchanges = 0
  while (estimateTokens(text) > maxInputTokens && renderedExchanges.length > 0) {
    renderedExchanges.shift()
    trimmedExchanges += 1
    parts[1] = `NEWLY COMPACTED EXCHANGES (summarize conclusions only, never reproduce verbatim):\n${renderedExchanges.join('\n')}`
    text = parts.join('\n\n')
  }
  return { text, stats: { exchangesIncluded: renderedExchanges.length, trimmedExchanges, estimatedTokens: estimateTokens(text) } }
}

/**
 * Deterministic compaction guard. Summarization runs only when genuinely new
 * history was compacted AND the per-run call cap is not reached. Pure.
 */
export function canSummarize({ summarizerCalls = 0, maxCalls = MAX_SUMMARIZER_CALLS_PER_RUN, evictedSinceSummary = 0 } = {}) {
  if (!Number.isFinite(summarizerCalls) || summarizerCalls < 0) return false
  if (!Number.isFinite(maxCalls) || maxCalls <= 0) return false
  if (!Number.isFinite(evictedSinceSummary) || evictedSinceSummary <= 0) return false
  return summarizerCalls < maxCalls
}

/**
 * Run one summarization round. llmCall is injected ({ system, user }) =>
 * rawText, keeping this module provider-agnostic and unit-testable without
 * network. Never throws for model-side failures; those return ok:false and
 * the caller keeps the previous valid summary (atomic update).
 */
export async function summarize({ llmCall, input }) {
  if (typeof llmCall !== 'function') return { ok: false, reason: 'no_llm' }
  let rawText
  try {
    rawText = await llmCall(input)
  } catch (error) {
    // Cancellation must propagate so the run can terminate; every other
    // model-side failure converts to ok:false and the caller keeps the
    // previous valid summary (atomic update).
    if (error && error.name === 'AbortError') throw error
    return { ok: false, reason: 'provider', error: (error && error.message) || String(error) }
  }
  return parseAndValidateSummary(rawText)
}
