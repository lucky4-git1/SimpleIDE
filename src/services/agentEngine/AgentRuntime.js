// ── AgentRuntime.js ─────────────────────────────────────────────────────────
// Milestone 4: Formal Agent Runtime State Machine V1
//
// The runtime owns all agent lifecycle state. The LLM suggests plans and
// actions; the runtime evaluates guards and executes deterministic transitions.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical agent states. The runtime is always in exactly one of these.
 * Terminal states (COMPLETED, FAILED, CANCELLED) can only transition to IDLE
 * via an explicit TASK_RESET event.
 */
export const AGENT_STATES = Object.freeze({
  IDLE:               'IDLE',
  PLANNING:           'PLANNING',
  EXECUTING:          'EXECUTING',
  AWAITING_APPROVAL:  'AWAITING_APPROVAL',
  EVALUATING:         'EVALUATING',
  VERIFYING:          'VERIFYING',
  REPAIRING:          'REPAIRING',
  REPLANNING:         'REPLANNING',
  COMPLETED:          'COMPLETED',
  FAILED:             'FAILED',
  CANCELLED:          'CANCELLED'
})

/**
 * Events that drive state transitions. Each event may carry a payload
 * inspected by guard functions to choose the target state.
 */
export const AGENT_EVENTS = Object.freeze({
  // Lifecycle
  TASK_STARTED:         'TASK_STARTED',
  TASK_RESET:           'TASK_RESET',

  // Planning
  PLAN_RECEIVED:        'PLAN_RECEIVED',
  PLAN_ERROR:           'PLAN_ERROR',

  // Execution
  ACTION_COMPLETED:     'ACTION_COMPLETED',
  APPROVAL_REQUIRED:    'APPROVAL_REQUIRED',
  APPROVAL_GRANTED:     'APPROVAL_GRANTED',
  APPROVAL_DENIED:      'APPROVAL_DENIED',
  MORE_ACTIONS:         'MORE_ACTIONS',

  // Evaluation → next phase
  FINISH_REQUESTED:     'FINISH_REQUESTED',
  NEEDS_REPLAN:         'NEEDS_REPLAN',

  // Verification
  VERIFICATION_PASSED:  'VERIFICATION_PASSED',
  VERIFICATION_FAILED:  'VERIFICATION_FAILED',
  VERIFICATION_SKIPPED: 'VERIFICATION_SKIPPED',

  // Repair
  REPAIR_SUCCEEDED:     'REPAIR_SUCCEEDED',
  REPAIR_FAILED:        'REPAIR_FAILED',
  MAX_REPAIR_ATTEMPTS:  'MAX_REPAIR_ATTEMPTS',

  // Replanning
  REPLAN_ISSUED:        'REPLAN_ISSUED',
  MAX_REPLANS:          'MAX_REPLANS',

  // Cancellation (valid from most active states)
  USER_CANCELLED:       'USER_CANCELLED',

  // Generic failure (valid from most active states)
  FATAL_ERROR:          'FATAL_ERROR',

  // Max turns exhausted
  MAX_TURNS:            'MAX_TURNS'
})

const S = AGENT_STATES
const E = AGENT_EVENTS

const MAX_HISTORY = 200

// ── Transition Table ────────────────────────────────────────────────────────
// Each entry: { target } or { guard: (payload, runtime) => targetState }
// A guard returns the target state string, allowing conditional routing.

const TRANSITIONS = new Map([
  // IDLE
  [S.IDLE, new Map([
    [E.TASK_STARTED,    { target: S.PLANNING }]
  ])],

  // PLANNING
  [S.PLANNING, new Map([
    [E.PLAN_RECEIVED,   { target: S.EXECUTING }],
    [E.PLAN_ERROR,      { target: S.FAILED }],
    [E.USER_CANCELLED,  { target: S.CANCELLED }],
    [E.FATAL_ERROR,     { target: S.FAILED }],
    [E.MAX_TURNS,       { target: S.FAILED }]
  ])],

  // EXECUTING
  [S.EXECUTING, new Map([
    [E.ACTION_COMPLETED,   { target: S.EVALUATING }],
    [E.APPROVAL_REQUIRED,  { target: S.AWAITING_APPROVAL }],
    [E.USER_CANCELLED,     { target: S.CANCELLED }],
    [E.FATAL_ERROR,        { target: S.FAILED }],
    [E.MAX_TURNS,          { target: S.FAILED }]
  ])],

  // AWAITING_APPROVAL
  [S.AWAITING_APPROVAL, new Map([
    [E.APPROVAL_GRANTED,  { target: S.EXECUTING }],
    [E.APPROVAL_DENIED,   { target: S.CANCELLED }],
    [E.USER_CANCELLED,    { target: S.CANCELLED }]
  ])],

  // EVALUATING
  [S.EVALUATING, new Map([
    [E.PLAN_RECEIVED,     { target: S.EXECUTING }],
    [E.MORE_ACTIONS,      { target: S.EXECUTING }],
    [E.FINISH_REQUESTED,  {
      guard: (payload, runtime) => {
        if (payload?.consistencyResult && !payload.consistencyResult.valid) {
          return S.REPAIRING
        }
        // If the task requires verification and has written files, go to VERIFYING
        if (payload?.requiresVerification && payload?.hasWrittenFiles && !payload?.hasVerified) {
          return S.VERIFYING
        }
        return S.COMPLETED
      }
    }],
    [E.NEEDS_REPLAN,      { target: S.PLANNING }],
    [E.USER_CANCELLED,    { target: S.CANCELLED }],
    [E.FATAL_ERROR,       { target: S.FAILED }],
    [E.MAX_TURNS,         { target: S.FAILED }]
  ])],

  // VERIFYING
  [S.VERIFYING, new Map([
    [E.VERIFICATION_PASSED,  { target: S.COMPLETED }],
    [E.VERIFICATION_FAILED,  { target: S.REPAIRING }],
    [E.VERIFICATION_SKIPPED, { target: S.COMPLETED }],
    [E.USER_CANCELLED,       { target: S.CANCELLED }],
    [E.FATAL_ERROR,          { target: S.FAILED }]
  ])],

  // REPAIRING
  [S.REPAIRING, new Map([
    [E.REPAIR_SUCCEEDED,     { target: S.VERIFYING }],
    [E.REPAIR_FAILED,        { target: S.REPLANNING }],
    [E.MAX_REPAIR_ATTEMPTS,  { target: S.FAILED }],
    [E.USER_CANCELLED,       { target: S.CANCELLED }],
    [E.FATAL_ERROR,          { target: S.FAILED }]
  ])],

  // REPLANNING
  [S.REPLANNING, new Map([
    [E.REPLAN_ISSUED,    { target: S.PLANNING }],
    [E.MAX_REPLANS,      { target: S.FAILED }],
    [E.USER_CANCELLED,   { target: S.CANCELLED }],
    [E.FATAL_ERROR,      { target: S.FAILED }]
  ])],

  // Terminal states — only TASK_RESET returns to IDLE
  [S.COMPLETED, new Map([
    [E.TASK_RESET, { target: S.IDLE }]
  ])],

  [S.FAILED, new Map([
    [E.TASK_RESET, { target: S.IDLE }]
  ])],

  [S.CANCELLED, new Map([
    [E.TASK_RESET, { target: S.IDLE }]
  ])]
])

// ── Terminal state set ──────────────────────────────────────────────────────
const TERMINAL_STATES = new Set([S.COMPLETED, S.FAILED, S.CANCELLED])

/**
 * AgentRuntime — the authoritative state machine governing the agent lifecycle.
 *
 * Usage:
 *   const runtime = new AgentRuntime({
 *     onTransition: (from, to, event, payload) => { ... },
 *     onError: (error, event, state) => { ... }
 *   })
 *   runtime.transition(AGENT_EVENTS.TASK_STARTED, { taskId: '...' })
 */
export class AgentRuntime {
  /**
   * @param {object} options
   * @param {function} [options.onTransition] - Called after every successful transition: (from, to, event, payload) => void
   * @param {function} [options.onError]      - Called on invalid transition attempts: (error, event, currentState) => void
   */
  constructor(options = {}) {
    this._state = S.IDLE
    this._history = []
    this._onTransition = options.onTransition || null
    this._onError = options.onError || null
    this._taskId = null
    this._metadata = {}
  }

  // ── Read-only accessors ─────────────────────────────────────────────────

  /** Current state of the runtime. */
  getState() {
    return this._state
  }

  /** Full transition history (most recent last). */
  getHistory() {
    return [...this._history]
  }

  /** The active task ID, if any. */
  getTaskId() {
    return this._taskId
  }

  /** Whether the runtime is in a terminal state. */
  isTerminal() {
    return TERMINAL_STATES.has(this._state)
  }

  /** Whether the runtime is actively processing (not IDLE and not terminal). */
  isActive() {
    return this._state !== S.IDLE && !this.isTerminal()
  }

  /** Arbitrary metadata attached to the current run. */
  getMetadata() {
    return { ...this._metadata }
  }

  setMetadata(key, value) {
    this._metadata[key] = value
  }

  // ── Transition logic ────────────────────────────────────────────────────

  /**
   * Attempt a state transition driven by the given event.
   *
   * @param {string} event   - One of AGENT_EVENTS
   * @param {object} [payload] - Optional data inspected by guards
   * @returns {{ success: boolean, from: string, to: string, event: string } | { success: false, error: string }}
   */
  transition(event, payload = {}) {
    const from = this._state
    const stateTransitions = TRANSITIONS.get(from)

    if (!stateTransitions) {
      const error = `No transitions defined for state '${from}'.`
      this._onError?.(error, event, from)
      return { success: false, error, from, event }
    }

    const rule = stateTransitions.get(event)
    if (!rule) {
      const validEvents = [...stateTransitions.keys()].join(', ')
      const error = `Invalid transition: event '${event}' is not valid from state '${from}'. Valid events: [${validEvents}]`
      this._onError?.(error, event, from)
      return { success: false, error, from, event }
    }

    // Resolve target state — use guard if present, otherwise static target
    let to
    if (rule.guard) {
      to = rule.guard(payload, this)
      if (!to || !Object.values(S).includes(to)) {
        const error = `Guard for event '${event}' from state '${from}' returned invalid target: '${to}'.`
        this._onError?.(error, event, from)
        return { success: false, error, from, event }
      }
    } else {
      to = rule.target
    }

    // Record in history
    const record = {
      from,
      to,
      event,
      payload: this._safePayload(payload),
      timestamp: Date.now()
    }
    this._history.push(record)
    if (this._history.length > MAX_HISTORY) {
      this._history = this._history.slice(-MAX_HISTORY)
    }

    // Commit the transition
    this._state = to

    // Track task ID from TASK_STARTED
    if (event === E.TASK_STARTED && payload?.taskId) {
      this._taskId = payload.taskId
    }

    // Invoke callback
    this._onTransition?.(from, to, event, payload)

    return { success: true, from, to, event }
  }

  /**
   * Check whether the given event can be fired from the current state.
   *
   * @param {string} event - One of AGENT_EVENTS
   * @returns {boolean}
   */
  canTransition(event) {
    const stateTransitions = TRANSITIONS.get(this._state)
    return stateTransitions ? stateTransitions.has(event) : false
  }

  /**
   * Return the list of events valid from the current state.
   *
   * @returns {string[]}
   */
  getValidEvents() {
    const stateTransitions = TRANSITIONS.get(this._state)
    return stateTransitions ? [...stateTransitions.keys()] : []
  }

  /**
   * Reset the runtime to IDLE. Preserves history.
   * Only valid from terminal states or IDLE.
   *
   * @returns {{ success: boolean }}
   */
  reset() {
    if (this._state === S.IDLE) {
      return { success: true, from: S.IDLE, to: S.IDLE, event: E.TASK_RESET }
    }
    if (TERMINAL_STATES.has(this._state)) {
      return this.transition(E.TASK_RESET)
    }
    const error = `Cannot reset from active state '${this._state}'. Cancel or fail the task first.`
    this._onError?.(error, E.TASK_RESET, this._state)
    return { success: false, error }
  }

  // ── Convenience predicates ──────────────────────────────────────────────

  /** Whether the last terminal state was COMPLETED. */
  didComplete() {
    return this._state === S.COMPLETED
  }

  /** Whether the last terminal state was FAILED. */
  didFail() {
    return this._state === S.FAILED
  }

  /** Whether the last terminal state was CANCELLED. */
  wasCancelled() {
    return this._state === S.CANCELLED
  }

  /** Count of transitions in history. */
  getTransitionCount() {
    return this._history.length
  }

  /** Get the most recent history entry. */
  getLastTransition() {
    return this._history.length > 0 ? { ...this._history[this._history.length - 1] } : null
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  /**
   * Produce a safe, serializable copy of the payload for history storage.
   * Strips functions and circular references; truncates large strings.
   */
  _safePayload(payload) {
    if (!payload || typeof payload !== 'object') return {}
    const safe = {}
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === 'function') continue
      if (typeof value === 'string' && value.length > 500) {
        safe[key] = value.slice(0, 500) + '…'
      } else if (typeof value === 'object' && value !== null) {
        try {
          // Shallow clone; deep objects get JSON-stringified summary
          safe[key] = JSON.parse(JSON.stringify(value))
        } catch {
          safe[key] = '[unserializable]'
        }
      } else {
        safe[key] = value
      }
    }
    return safe
  }
}
