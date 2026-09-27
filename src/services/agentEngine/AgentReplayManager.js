/**
 * AgentReplayManager.js
 *
 * Implements Phase 24: Agent Replay
 * Developer replay engine for inspecting and playing back agent execution trajectories:
 * 1. user_request
 * 2. laya_decisions
 * 3. context_selection
 * 4. llm_calls_metadata
 * 5. tool_calls & results
 * 6. verification
 * 7. final_outcome
 *
 * Strict Privacy: Strips all API keys, bearer tokens, auth headers, and secrets before storing.
 */

const SECRET_KEY_PATTERNS = [
  /key/i,
  /token/i,
  /secret/i,
  /auth/i,
  /password/i,
  /credential/i
]

export function sanitizeReplayValue(val, keyName = '') {
  if (val === null || val === undefined) return val
  if (typeof val === 'string') {
    if (SECRET_KEY_PATTERNS.some(p => p.test(keyName)) && val.length > 8) {
      return '[REDACTED_SECRET]'
    }
    if (/bearer\s+[a-zA-Z0-9_\-.]+/i.test(val)) {
      return val.replace(/bearer\s+[a-zA-Z0-9_\-.]+/gi, 'Bearer [REDACTED]')
    }
    return val.slice(0, 10000)
  }
  if (Array.isArray(val)) {
    return val.map(item => sanitizeReplayValue(item, keyName))
  }
  if (typeof val === 'object') {
    const clean = {}
    for (const [k, v] of Object.entries(val)) {
      clean[k] = sanitizeReplayValue(v, k)
    }
    return clean
  }
  return val
}

export class AgentReplayManager {
  constructor() {
    this.replays = new Map() // runId -> replayTrajectory
  }

  startTrajectory(runId, userRequest) {
    const trajectory = {
      runId,
      userRequest: sanitizeReplayValue(userRequest),
      startedAt: Date.now(),
      steps: [],
      outcome: null
    }
    this.replays.set(runId, trajectory)
    return trajectory
  }

  recordEvent(runId, type, payload = {}) {
    let trajectory = this.replays.get(runId)
    if (!trajectory) {
      trajectory = this.startTrajectory(runId, '')
    }

    const step = {
      stepIndex: trajectory.steps.length,
      type, // 'laya_decision' | 'context_selection' | 'llm_call' | 'tool_call' | 'tool_result' | 'verification'
      payload: sanitizeReplayValue(payload),
      timestamp: Date.now()
    }

    trajectory.steps.push(step)
    return step
  }

  finalizeTrajectory(runId, outcome = {}) {
    const trajectory = this.replays.get(runId)
    if (!trajectory) return null

    trajectory.outcome = sanitizeReplayValue(outcome)
    trajectory.completedAt = Date.now()
    trajectory.durationMs = trajectory.completedAt - trajectory.startedAt
    return trajectory
  }

  getTrajectory(runId) {
    return this.replays.get(runId) || null
  }

  async *replayStream(runId, { delayMs = 10 } = {}) {
    const trajectory = this.getTrajectory(runId)
    if (!trajectory) return

    yield { type: 'trajectory_start', userRequest: trajectory.userRequest, runId }

    for (const step of trajectory.steps) {
      if (delayMs > 0) {
        await new Promise(r => setTimeout(r, delayMs))
      }
      yield step
    }

    yield { type: 'trajectory_end', outcome: trajectory.outcome }
  }

  clear() {
    this.replays.clear()
  }
}

export const agentReplayManager = new AgentReplayManager()
