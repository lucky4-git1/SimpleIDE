// ── BudgetPolicy.js ─────────────────────────────────────────────────────
// Phase 5 (Bounded Runs): hard run budgets + graceful degradation.
//
// Five separate resource dimensions (never collapsed into one number):
//   A. per-request context — enforced by MessageWindow; observed here as share
//   B. per-run input tokens — cumulative effective input
//   C. per-run output/reasoning tokens — cumulative effective output
//   D. per-run cost — cumulative cost, only when pricing is configured
//   E. per-run turns — owned by the existing maxTurns loop bound
//
// Conservative accounting: effective usage = max(actuals, estimates), so
// missing provider usage can never read as zero consumption. Unknown price
// disables the cost dimension; token/turn safety still operates.
//
// This module decides only. Enforcement lives in runAgentTask.
// ─────────────────────────────────────────────────────────────────────────────

export const BUDGET_STATES = Object.freeze({
  NORMAL: 'normal',
  WARNING: 'warning',
  CONSERVATIVE: 'conservative',
  EXHAUSTED: 'exhausted'
})

const SEVERITY = {
  [BUDGET_STATES.NORMAL]: 0,
  [BUDGET_STATES.WARNING]: 1,
  [BUDGET_STATES.CONSERVATIVE]: 2,
  [BUDGET_STATES.EXHAUSTED]: 3
}

// Default per-request guard for hung provider connections. Basis, not magic:
// healthy Ultra TTFT measured at 28-56s, degraded runs exceeded 180s, and
// provider gateways answer slow backends with their own 504s — this guards
// only the no-response-at-all case. Configurable per call; chat paths that do
// not pass it keep today's unbounded behavior.
export const DEFAULT_REQUEST_TIMEOUT_MS = 180000

// Bounded attempts for one model call (1 initial + 2 transient retries).
export const MAX_MODEL_ATTEMPTS_PER_TURN = 3

// Approved malformed-output safety cap: consecutive unparseable model
// responses before the run fails safely instead of burning further calls.
export const MAX_CONSECUTIVE_MALFORMED = 3

// Categories that mean "the provider, not the request, failed" and may be
// retried within strict bounds. Everything else fails fast.
export const TRANSIENT_CATEGORIES = Object.freeze(new Set([
  'PROVIDER_GATEWAY_TIMEOUT',
  'PROVIDER_OVERLOADED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_EMPTY_RESPONSE'
]))

const NETWORK_MESSAGE = /fetch failed|failed to fetch|network|ECONN|ETIMEDOUT|socket hang up|ENOTFOUND|EAI_AGAIN/i

export function isTransientFailure(error) {
  if (!error) return false
  if (error.name === 'AbortError') return false
  if (error.category && TRANSIENT_CATEGORIES.has(error.category)) return true
  return NETWORK_MESSAGE.test(String((error && error.message) || error || ''))
}

/**
 * Run fn() with bounded transient retries. Every attempt is a real LLM call
 * recorded by the standard usageSink path; this helper only bounds retries.
 * AbortError (user cancel) and non-transient errors rethrow immediately.
 * onRetry (optional) observes each failure with { attempt, maxAttempts,
 * error, willRetry } for diagnostics; it never influences the decision.
 */
export async function withBoundedRetries(fn, { maxAttempts = MAX_MODEL_ATTEMPTS_PER_TURN, signal = null, onEvent = null, onRetry = null } = {}) {
  const attempts = Math.max(1, Math.floor(maxAttempts) || 1)
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if ((error && error.name === 'AbortError') || signal?.aborted) throw error
      const willRetry = isTransientFailure(error) && attempt < attempts
      try {
        onRetry?.({ attempt, maxAttempts: attempts, error, willRetry })
      } catch {
        // Diagnostics must never break execution.
      }
      if (!willRetry) throw error
      onEvent?.({ type: 'status', message: `Transient provider issue (attempt ${attempt}/${attempts}); retrying…` })
    }
  }
  throw lastError
}

function numOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Budget configuration. All limits are per-run allocations; a resumed run
 * passes its pre-resume totals as baseline so resumed usage continues the
 * same allocation instead of silently resetting it.
 *
 * Defaults derive from existing architecture, not providers:
 * - input/output budgets scale with the run's context window (20x / 4x). A
 *   run consuming twenty full windows of input is pathological; ordinary
 *   10-turn runs sit near five.
 * - cost budget defaults to null (disabled): this repo ships no pricing, and
 *   unknown price must not mean unlimited — token/turn safety covers it.
 * - thresholds: warning 0.70 (room for a closing sequence), conservative
 *   0.85 (one window of headroom), exhausted 1.00.
 */
export class BudgetPolicy {
  constructor({ contextWindow = 128000, budgets = null, thresholds = null, pricing = null } = {}) {
    const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 128000
    this.contextWindow = window
    const custom = budgets && typeof budgets === 'object' ? budgets : {}
    const pick = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback)
    this.limits = {
      maxRunInputTokens: pick(custom.maxRunInputTokens, window * 20),
      maxRunOutputTokens: pick(custom.maxRunOutputTokens, window * 4),
      maxRunCost: pick(custom.maxRunCost, null) || null
    }
    const customThresholds = thresholds && typeof thresholds === 'object' ? thresholds : {}
    const tpick = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback)
    this.thresholds = {
      warning: tpick(customThresholds.warning, 0.7),
      conservative: tpick(customThresholds.conservative, 0.85)
    }
    if (this.thresholds.conservative < this.thresholds.warning) {
      this.thresholds.conservative = this.thresholds.warning
    }
    this.pricing = pricing && typeof pricing === 'object' ? { ...pricing } : null
  }

  /**
   * Evaluate run state. totals: RunLedger.getTotals(); baseline: totals
   * snapshot at allocation start (zeros for a fresh run, restored totals for
   * a resume). Pure: no side effects, no enforcement.
   */
  evaluate({ totals = {}, baseline = null, windowShare = 0, turn = 0, maxTurns = 0 } = {}) {
    const base = baseline && typeof baseline === 'object' ? baseline : {}
    const delta = (key) => Math.max(0, numOrZero(totals[key]) - numOrZero(base[key]))
    // Conservative: the larger of actuals and estimates wins per dimension,
    // so missing usage can never read as zero consumption.
    const effInput = Math.max(delta('inputActual'), delta('inputEst'))
    const effOutput = Math.max(delta('outputActual'), delta('outputEst'))
    const effCost = delta('cost')
    const costEnabled = this.limits.maxRunCost !== null && this.pricing !== null

    let state = BUDGET_STATES.NORMAL
    let dimension = null
    const dirty = { input: effInput, output: effOutput, cost: costEnabled ? effCost : null }
    const consider = (name, share) => {
      if (!(share >= this.thresholds.warning)) return
      const next = share >= 1 ? BUDGET_STATES.EXHAUSTED
        : share >= this.thresholds.conservative ? BUDGET_STATES.CONSERVATIVE
        : BUDGET_STATES.WARNING
      if (SEVERITY[next] > SEVERITY[state]) {
        state = next
        dimension = name
      }
    }
    consider('input', this.limits.maxRunInputTokens ? effInput / this.limits.maxRunInputTokens : 0)
    consider('output', this.limits.maxRunOutputTokens ? effOutput / this.limits.maxRunOutputTokens : 0)
    if (costEnabled) consider('cost', effCost / this.limits.maxRunCost)
    // Per-request pressure: a single composed request near the window edge.
    // MessageWindow remains the enforcer; this only observes.
    if (numOrZero(windowShare) >= 0.9) {
      if (SEVERITY[state] < SEVERITY[BUDGET_STATES.WARNING]) {
        state = BUDGET_STATES.WARNING
        dimension = dimension || 'request-context'
      }
    }

    const remaining = {
      input: Math.max(0, this.limits.maxRunInputTokens - effInput),
      output: Math.max(0, this.limits.maxRunOutputTokens - effOutput),
      cost: costEnabled ? Math.max(0, this.limits.maxRunCost - effCost) : null,
      turns: Number.isFinite(maxTurns) && maxTurns > 0 ? Math.max(0, maxTurns - numOrZero(turn)) : null
    }
    return {
      state,
      dimension,
      usage: dirty,
      limits: { ...this.limits },
      remaining,
      turns: { used: numOrZero(turn), max: maxTurns },
      message: state === BUDGET_STATES.NORMAL ? ''
        : `Run budget ${state}${dimension ? ` (${dimension})` : ''}: ` +
          `input ${Math.round(effInput)}/${this.limits.maxRunInputTokens}, ` +
          `output ${Math.round(effOutput)}/${this.limits.maxRunOutputTokens}` +
          (costEnabled ? `, cost ${effCost.toFixed(4)}/${this.limits.maxRunCost}` : '')
    }
  }

  /**
   * Read-only gauge view: the five dimensions independently, never combined
   * into one number. Disabled dimensions (cost without pricing) report
   * enabled:false instead of zero. Pure; no policy influence.
   */
  gauges({ totals = {}, baseline = null, windowShare = 0, windowLimit = null, turn = 0, maxTurns = 0 } = {}) {
    const decision = this.evaluate({ totals, baseline, windowShare, turn, maxTurns })
    const gauge = (name, usage, limit, enabled = true) => ({
      dimension: name,
      usage: enabled ? usage : null,
      limit: enabled ? limit : null,
      remaining: enabled ? Math.max(0, limit - usage) : null,
      percent: enabled && limit > 0 ? Math.min(1, usage / limit) : null,
      state: enabled ? decision.state : 'disabled',
      enabled
    })
    const window = Number.isFinite(windowLimit) && windowLimit > 0 ? windowLimit : this.contextWindow
    return {
      state: decision.state,
      dimension: decision.dimension,
      requestContext: gauge('request-context', numOrZero(windowShare) * window, window),
      runInput: gauge('run-input', decision.usage.input, this.limits.maxRunInputTokens),
      runOutput: gauge('run-output', decision.usage.output, this.limits.maxRunOutputTokens),
      runCost: this.limits.maxRunCost !== null && this.pricing !== null
        ? gauge('run-cost', decision.usage.cost, this.limits.maxRunCost)
        : gauge('run-cost', 0, 0, false),
      runTurns: {
        dimension: 'run-turns',
        usage: numOrZero(turn),
        limit: maxTurns,
        remaining: Number.isFinite(maxTurns) && maxTurns > 0 ? Math.max(0, maxTurns - numOrZero(turn)) : null,
        percent: Number.isFinite(maxTurns) && maxTurns > 0 ? Math.min(1, numOrZero(turn) / maxTurns) : null,
        state: decision.state,
        enabled: true
      },
      message: decision.message
    }
  }
}
