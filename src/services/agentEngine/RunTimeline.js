// ── RunTimeline.js ────────────────────────────────────────────────────────
// Phase 6 (Bounded Runs): read-only observability for agent runs.
//
// A bounded, sanitized, JSON-safe append-only event log owned per run.
// Observability only: emitting never influences execution policy — all
// decisions (budgets, retries, stops) are made elsewhere from ledger/window
// state, and this module imports nothing that can act on a run.
//
// Privacy: event metadata passes through sanitizeMeta, which drops
// secret-bearing keys and caps string lengths. Measurements stay numeric.
// ─────────────────────────────────────────────────────────────────────────────

export const TimelineTypes = Object.freeze({
  RUN_STARTED: 'RUN_STARTED',
  LLM_REQUEST: 'LLM_REQUEST',
  LLM_RESPONSE: 'LLM_RESPONSE',
  MODEL_SWITCH: 'MODEL_SWITCH',
  WINDOW_BUILT: 'WINDOW_BUILT',
  SUMMARIZATION_STARTED: 'SUMMARIZATION_STARTED',
  SUMMARIZATION_COMPLETED: 'SUMMARIZATION_COMPLETED',
  SUMMARIZATION_FAILED: 'SUMMARIZATION_FAILED',
  RETRY_STARTED: 'RETRY_STARTED',
  RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  MALFORMED_OUTPUT: 'MALFORMED_OUTPUT',
  BUDGET_WARNING: 'BUDGET_WARNING',
  CONSERVATIVE_MODE: 'CONSERVATIVE_MODE',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  CHECKPOINT_CREATED: 'CHECKPOINT_CREATED',
  RESUME_STARTED: 'RESUME_STARTED',
  RESUME_COMPLETED: 'RESUME_COMPLETED',
  RUN_COMPLETED: 'RUN_COMPLETED',
  RUN_FAILED: 'RUN_FAILED',
  RUN_CANCELLED: 'RUN_CANCELLED'
})

// Failure classes for LLM_RESPONSE outcomes. Distinct by construction:
// user cancellation is never a provider timeout, and a timeout is never a
// generic gateway error or malformed output.
export const FailureClasses = Object.freeze({
  CANCELLED: 'USER_CANCEL',
  TIMEOUT: 'PROVIDER_TIMEOUT',
  GATEWAY: 'GATEWAY_ERROR',
  MALFORMED: 'MALFORMED_OUTPUT',
  BUDGET: 'BUDGET_EXHAUSTED',
  ERROR: 'ERROR'
})

export function classifyFailureClass(error) {
  if (!error) return null
  if (error.name === 'AbortError') return FailureClasses.CANCELLED
  const category = error.category || null
  if (category === 'PROVIDER_TIMEOUT') return FailureClasses.TIMEOUT
  if (category === 'PROVIDER_GATEWAY_TIMEOUT' || category === 'PROVIDER_OVERLOADED') return FailureClasses.GATEWAY
  return FailureClasses.ERROR
}

// Keys that must never enter the timeline, matched case-insensitively as
// substrings. Separate from token-count fields (inputTokens etc.), which are
// numeric measurements and always safe.
const SECRET_KEY = /apikey|api_key|authorization|bearer|secret|credential|password|private_key|access_token|x-api-key/i
const MAX_STRING = 300

function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return Number.isFinite(value) ? value : String(value).slice(0, MAX_STRING)
  }
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value
  if (typeof value === 'function') return '[function]'
  if (depth > 3) return '[depth]'
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeValue(item, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value).slice(0, 40)) {
      if (SECRET_KEY.test(key)) continue
      try {
        out[key] = sanitizeValue(entry, depth + 1)
      } catch {
        out[key] = '[unserializable]'
      }
    }
    return out
  }
  return String(value).slice(0, MAX_STRING)
}

export class RunTimeline {
  /**
   * @param {object} options
   * @param {string|null} [options.runId]
   * @param {number} [options.maxEvents=300] - Hard bound; oldest dropped first.
   */
  constructor({ runId = null, maxEvents = 300 } = {}) {
    this.runId = runId
    this.maxEvents = Number.isFinite(maxEvents) && maxEvents > 0 ? Math.floor(maxEvents) : 300
    this.events = []
    this.dropped = 0
    this.seq = 0
  }

  emit(type, data = {}) {
    this.seq += 1
    const event = {
      seq: this.seq,
      ts: Date.now(),
      runId: this.runId,
      type: Object.values(TimelineTypes).includes(type) ? type : String(type || 'UNKNOWN')
    }
    const clean = sanitizeValue(data && typeof data === 'object' ? data : {})
    if (clean && typeof clean === 'object' && !Array.isArray(clean)) {
      for (const [key, value] of Object.entries(clean)) event[key] = value
    }
    this.events.push(event)
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents)
      this.dropped += 1
    }
    return event
  }

  count() {
    return this.events.length
  }

  byType(type) {
    return this.events.filter(event => event.type === type)
  }

  /** Newest-first tail copy for diagnostics payloads. */
  tail(n = 100) {
    const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 100
    return this.events.slice(-count).map(event => ({ ...event }))
  }

  snapshot() {
    return {
      runId: this.runId,
      events: this.events.length,
      dropped: this.dropped,
      types: [...new Set(this.events.map(event => event.type))]
    }
  }
}
