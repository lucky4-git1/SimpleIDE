// ── RunLedger.js ──────────────────────────────────────────────────────────
// Phase 1 (Bounded Runs): per-run, observation-only token accounting.
//
// The ledger measures every LLM call in an agent run. It never enforces
// anything: no thresholds, no truncation, no stop conditions. Future phases
// (window bounding, summarization, budgets) will consume these numbers.
//
// Estimates use the project's existing heuristic (estimateTokens from
// ContextChunk.js: ~3.8 chars/token) and are ALWAYS labeled estimated.
// Provider `usage` payloads, when present, are recorded as actuals via the
// normalized shape produced by LLMRouter.extractUsage:
//   { input, output, total, reasoning } (each a non-negative number or null)
// ─────────────────────────────────────────────────────────────────────────────
import { estimateTokens } from './ContextChunk.js'

export const LEDGER_CALL_TYPES = Object.freeze({
  AGENT: 'agent',
  SUMMARIZER: 'summarizer',
  OTHER: 'other'
})

function numOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function numOrZero(value) {
  const n = numOrNull(value)
  return n === null ? 0 : n
}

function newCounter() {
  return { calls: 0, inputEst: 0, outputEst: 0, inputActual: 0, outputActual: 0, reasoningActual: 0, cost: 0 }
}

export class RunLedger {
  /**
   * @param {object} options
   * @param {string} [options.runId]
   * @param {string} [options.model]
   * @param {number} [options.contextWindow]
   * @param {object|null} [options.pricing] - Optional { inputPerMTok, outputPerMTok }
   *   in currency units per million tokens. Absent by default: this repo ships
   *   no pricing data and none is invented. Cost stays null without it.
   * @param {object|null} [options.compactionBudget] - Stored for future phases
   *   (e.g. { maxCalls, maxInputTokens }). Recorded only, never enforced here.
   */
  constructor({ runId = null, model = null, contextWindow = null, pricing = null, compactionBudget = null } = {}) {
    this.runId = runId
    this.model = model
    this.contextWindow = typeof contextWindow === 'number' && Number.isFinite(contextWindow) ? contextWindow : null
    this.pricing = pricing && typeof pricing === 'object' ? { ...pricing } : null
    this.compactionBudget = compactionBudget && typeof compactionBudget === 'object' ? { ...compactionBudget } : null
    this.startedAt = Date.now()
    this.turns = 0
    this.segments = new Map()
    // Failed attempts (network/provider failures before usable output).
    // Counted separately; their input estimates still accumulate below so a
    // storm of failed calls is visible to budgets instead of reading as zero.
    this.failedCalls = 0
    // Phase 6 observability: per-call outcomes and latency. Kept OUTSIDE
    // totals (whose shape is frozen) in a separate additive structure.
    this.outcomes = { ok: 0, failed: 0, cancelled: 0, timeouts: 0, latencyTotalMs: 0, latencyCount: 0 }
    this.compaction = { calls: 0, failures: 0, inputEst: 0, inputActual: 0, outputEst: 0, outputActual: 0, reasoningActual: 0, cost: 0 }
    this.totals = { calls: 0, inputEst: 0, outputEst: 0, inputActual: 0, outputActual: 0, reasoningActual: 0, cost: 0 }
    // Phase 2 (Bounded Runs): MessageWindow observations. Accumulated only;
    // never consulted for decisions in this phase.
    this.window = {
      builds: 0,
      compactions: 0,
      evictedMessages: 0,
      orphansDropped: 0,
      exchangesRetained: 0,
      retainedLast: 0,
      tokensBeforeLast: 0,
      tokensAfterLast: 0,
      factsIncludedLast: 0,
      overflowLast: false
    }
    // True while every recorded call carried provider usage; flips false
    // permanently once a call without usable usage is recorded.
    this.actualComplete = true
  }

  advanceTurn() {
    this.turns += 1
    return this.turns
  }

  segmentFor(model) {
    const key = String(model || 'unknown')
    let segment = this.segments.get(key)
    if (!segment) {
      segment = { model: key, ...newCounter(), actualComplete: true }
      this.segments.set(key, segment)
    }
    return segment
  }

  /**
   * Record one LLM call. Pure accumulation; cannot fail the caller.
   * Monotonic by construction: only non-negative values are ever added.
   */
  recordCall({ model = null, provider = null, callType = LEDGER_CALL_TYPES.AGENT, inputEst = 0, outputText = null, usage = null, failed = false, durationMs = null, outcome = null, failureCategory = null } = {}) {
    const type = Object.values(LEDGER_CALL_TYPES).includes(callType) ? callType : LEDGER_CALL_TYPES.OTHER
    const inEst = numOrZero(inputEst)
    const outEst = typeof outputText === 'string' ? estimateTokens(outputText) : 0
    const normalized = usage && typeof usage === 'object' ? usage : null
    const inActual = normalized ? numOrNull(normalized.input) : null
    const outActual = normalized ? numOrNull(normalized.output) : null
    const reasoningActual = normalized ? numOrNull(normalized.reasoning) : null
    const usageAvailable = inActual !== null || outActual !== null
    if (!usageAvailable) this.actualComplete = false

    const cost = this.priceOf(inActual !== null ? inActual : inEst, outActual !== null ? outActual : outEst)
    const costEstimated = cost !== null && !usageAvailable
    const failedCall = Boolean(failed)
    if (failedCall) this.failedCalls += 1

    const call = {
      model: model !== null && model !== undefined ? String(model) : (this.model !== null ? String(this.model) : 'unknown'),
      provider: provider !== null && provider !== undefined ? String(provider) : null,
      callType: type,
      inputEst: inEst,
      outputEst: outEst,
      inputActual: inActual,
      outputActual: outActual,
      reasoningActual,
      usageAvailable,
      cost,
      costEstimated,
      failed: failedCall,
      outcome: outcome === 'ok' || outcome === 'failed' || outcome === 'cancelled' ? outcome : (failedCall ? 'failed' : 'ok'),
      failureCategory: typeof failureCategory === 'string' && failureCategory ? failureCategory : null,
      durationMs: typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null,
      at: Date.now()
    }

    const segment = this.segmentFor(call.model)
    segment.calls += 1
    segment.inputEst += inEst
    segment.outputEst += outEst
    segment.inputActual += inActual !== null ? inActual : 0
    segment.outputActual += outActual !== null ? outActual : 0
    segment.reasoningActual += reasoningActual !== null ? reasoningActual : 0
    if (cost !== null) segment.cost += cost
    if (!usageAvailable) segment.actualComplete = false
    // Outcome/latency aggregates (additive keys only; existing fields untouched).
    segment.errors = (segment.errors || 0) + (call.outcome === 'failed' ? 1 : 0)
    segment.cancels = (segment.cancels || 0) + (call.outcome === 'cancelled' ? 1 : 0)
    segment.timeouts = (segment.timeouts || 0) + (call.failureCategory === 'PROVIDER_TIMEOUT' ? 1 : 0)
    if (call.durationMs !== null) {
      segment.latencyTotalMs = (segment.latencyTotalMs || 0) + call.durationMs
      segment.latencyCount = (segment.latencyCount || 0) + 1
      if (!Array.isArray(segment.latencies)) segment.latencies = []
      segment.latencies.push(call.durationMs)
      if (segment.latencies.length > 50) segment.latencies.shift()
    }
    this.outcomes[call.outcome] = (this.outcomes[call.outcome] || 0) + 1
    if (call.failureCategory === 'PROVIDER_TIMEOUT') this.outcomes.timeouts += 1
    if (call.durationMs !== null) {
      this.outcomes.latencyTotalMs += call.durationMs
      this.outcomes.latencyCount += 1
    }

    this.totals.calls += 1
    this.totals.inputEst += inEst
    this.totals.outputEst += outEst
    this.totals.inputActual += inActual !== null ? inActual : 0
    this.totals.outputActual += outActual !== null ? outActual : 0
    this.totals.reasoningActual += reasoningActual !== null ? reasoningActual : 0
    if (cost !== null) this.totals.cost += cost

    // Summarizer/compaction accounting shape for future phases. Recorded
    // here, never enforced; no summarizer exists yet.
    if (type === LEDGER_CALL_TYPES.SUMMARIZER) {
      this.compaction.calls += 1
      this.compaction.inputEst += inEst
      this.compaction.inputActual += inActual !== null ? inActual : 0
      this.compaction.outputEst += outEst
      this.compaction.outputActual += outActual !== null ? outActual : 0
      this.compaction.reasoningActual += reasoningActual !== null ? reasoningActual : 0
      if (cost !== null) this.compaction.cost += cost
    }

    return call
  }

  priceOf(inputTokens, outputTokens) {
    if (!this.pricing) return null
    const inRate = numOrNull(this.pricing.inputPerMTok)
    const outRate = numOrNull(this.pricing.outputPerMTok)
    if (inRate === null && outRate === null) return null
    return (numOrZero(inputTokens) / 1e6) * (inRate || 0) + (numOrZero(outputTokens) / 1e6) * (outRate || 0)
  }

  getTotals() {
    return {
      ...this.totals,
      cost: this.pricing ? this.totals.cost : null,
      actualComplete: this.actualComplete,
      turns: this.turns
    }
  }

  getSegments() {
    return [...this.segments.values()].map(segment => {
      const copy = { ...segment }
      const count = copy.latencyCount || 0
      copy.avgLatencyMs = count > 0 ? copy.latencyTotalMs / count : null
      if (Array.isArray(copy.latencies) && copy.latencies.length > 0) {
        const sorted = [...copy.latencies].sort((a, b) => a - b)
        const mid = Math.floor(sorted.length / 2)
        copy.medianLatencyMs = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
      } else {
        copy.medianLatencyMs = null
      }
      copy.errors = copy.errors || 0
      copy.cancels = copy.cancels || 0
      copy.timeouts = copy.timeouts || 0
      return copy
    })
  }

  getOutcomeTotals() {
    return { ...this.outcomes }
  }

  getCompaction() {
    return { ...this.compaction }
  }

  getFailedCalls() {
    return this.failedCalls
  }

  /**
   * Record a failed summarization round (observation only). Failures never
   * destroy the previous valid summary — see RollingSummarizer atomicity.
   */
  recordSummarizerFailure() {
    this.compaction.failures += 1
    return this.compaction.failures
  }

  /**
   * Phase 2 (Bounded Runs): record one MessageWindow build report.
   * Observation only — totals only grow; nothing here gates run behavior.
   */
  recordWindow({ tokensBefore = 0, tokensAfter = 0, retained = 0, evicted = 0, orphansDropped = 0, exchangesRetained = 0, factsIncluded = 0, overflow = false } = {}) {
    const clean = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)
    this.window.builds += 1
    if (clean(evicted) > 0) this.window.compactions += 1
    this.window.evictedMessages += clean(evicted)
    this.window.orphansDropped += clean(orphansDropped)
    this.window.exchangesRetained += clean(exchangesRetained)
    this.window.retainedLast = clean(retained)
    this.window.tokensBeforeLast = clean(tokensBefore)
    this.window.tokensAfterLast = clean(tokensAfter)
    this.window.factsIncludedLast = clean(factsIncluded)
    this.window.overflowLast = Boolean(overflow)
    return { ...this.window }
  }

  getWindow() {
    return { ...this.window }
  }

  /**
   * Phase 4 (Bounded Runs): merge a checkpoint ledger snapshot so cumulative
   * measurement continues across resume instead of restarting from zero.
   * Additive-only (counters sum, turns take the max, prior run recorded), so
   * monotonicity is preserved. Never enforces anything. Returns false when
   * the snapshot is unusable, leaving this ledger untouched.
   */
  restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false
    const totals = snapshot.totals && typeof snapshot.totals === 'object' ? snapshot.totals : null
    if (!totals) return false
    const add = (target, source, keys) => {
      for (const key of keys) {
        const value = source[key]
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) target[key] += value
      }
    }
    const counterKeys = ['calls', 'inputEst', 'outputEst', 'inputActual', 'outputActual', 'reasoningActual', 'cost']
    add(this.totals, totals, counterKeys)
    if (Array.isArray(snapshot.segments)) {
      for (const saved of snapshot.segments) {
        if (!saved || typeof saved !== 'object') continue
        const segment = this.segmentFor(saved.model)
        add(segment, saved, counterKeys)
        if (saved.actualComplete === false) segment.actualComplete = false
      }
    }
    if (snapshot.compaction && typeof snapshot.compaction === 'object') {
      add(this.compaction, snapshot.compaction, [...counterKeys, 'failures'])
    }
    if (snapshot.outcomes && typeof snapshot.outcomes === 'object') {
      add(this.outcomes, snapshot.outcomes, ['ok', 'failed', 'cancelled', 'timeouts', 'latencyTotalMs', 'latencyCount'])
    }
    if (snapshot.window && typeof snapshot.window === 'object') {
      const saved = snapshot.window
      this.window.builds += (typeof saved.builds === 'number' && saved.builds > 0 ? Math.floor(saved.builds) : 0)
      this.window.compactions += (typeof saved.compactions === 'number' && saved.compactions > 0 ? Math.floor(saved.compactions) : 0)
      this.window.evictedMessages += (typeof saved.evictedMessages === 'number' && saved.evictedMessages > 0 ? saved.evictedMessages : 0)
      this.window.orphansDropped += (typeof saved.orphansDropped === 'number' && saved.orphansDropped > 0 ? saved.orphansDropped : 0)
      this.window.exchangesRetained += (typeof saved.exchangesRetained === 'number' && saved.exchangesRetained > 0 ? saved.exchangesRetained : 0)
    }
    if (typeof snapshot.turns === 'number' && Number.isFinite(snapshot.turns) && snapshot.turns > this.turns) {
      this.turns = Math.floor(snapshot.turns)
    }
    if (totals.actualComplete === false) this.actualComplete = false
    if (typeof snapshot.failedCalls === 'number' && Number.isFinite(snapshot.failedCalls) && snapshot.failedCalls > 0) {
      this.failedCalls += Math.floor(snapshot.failedCalls)
    }
    this.priorRuns = Array.isArray(this.priorRuns) ? this.priorRuns : []
    this.priorRuns.push({
      runId: typeof snapshot.runId === 'string' ? snapshot.runId : null,
      turns: typeof snapshot.turns === 'number' ? snapshot.turns : 0,
      totals: { ...this.totals }
    })
    return true
  }

  /** JSON-safe snapshot for checkpoints / diagnostics (future phases). */
  snapshot() {
    return {
      version: 1,
      runId: this.runId,
      model: this.model,
      contextWindow: this.contextWindow,
      turns: this.turns,
      totals: this.getTotals(),
      segments: this.getSegments(),
      compaction: this.getCompaction(),
      window: this.getWindow(),
      outcomes: this.getOutcomeTotals(),
      failedCalls: this.failedCalls,
      priorRuns: Array.isArray(this.priorRuns) ? this.priorRuns.map(p => ({ ...p })) : [],
      pricingAvailable: Boolean(this.pricing)
    }
  }
}
