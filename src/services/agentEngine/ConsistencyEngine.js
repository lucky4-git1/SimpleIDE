// ── ConsistencyEngine.js ──────────────────────────────────────────────────
// Evidence-backed consistency engine and contradiction validator.
// ─────────────────────────────────────────────────────────────────────────────

export const EVIDENCE_TYPES = Object.freeze({
  FILE_CHANGE:          'FILE_CHANGE',
  FILE_EXISTS:          'FILE_EXISTS',
  TOOL_SUCCESS:         'TOOL_SUCCESS',
  COMMAND_SUCCESS:      'COMMAND_SUCCESS',
  BROWSER_VERIFICATION: 'BROWSER_VERIFICATION',
  TEST_SUCCESS:         'TEST_SUCCESS',
  BUILD_SUCCESS:        'BUILD_SUCCESS',
  USER_APPROVAL:        'USER_APPROVAL',
  OBSERVATION_MATCH:    'OBSERVATION_MATCH'
})

export class EvidenceRecord {
  constructor({ type, target, details = {}, timestamp = Date.now() }) {
    this.id = `ev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`
    this.type = type
    this.target = target // e.g. file path, command, selector, step text
    this.details = details
    this.timestamp = timestamp
  }
}

export class ConsistencyEngine {
  constructor(workspaceRoot, { api } = {}) {
    this.root = workspaceRoot
    this.api = api || globalThis.window?.api
    this.evidenceList = []
    this.warnings = []
    this.corrections = []
  }

  getApi() {
    return this.api || globalThis.window?.api
  }

  clear() {
    this.evidenceList = []
    this.warnings = []
    this.corrections = []
  }

  /**
   * Record concrete empirical evidence of work.
   */
  recordEvidence(type, target, details = {}) {
    if (!EVIDENCE_TYPES[type]) {
      console.warn(`[ConsistencyEngine] Unknown evidence type: ${type}`)
    }
    const record = new EvidenceRecord({ type, target, details })
    this.evidenceList.push(record)
    return record
  }

  /**
   * Check if specific evidence has been recorded.
   */
  hasEvidence(type, targetMatcher = null) {
    return this.evidenceList.some(ev => {
      if (ev.type !== type) return false
      if (!targetMatcher) return true
      if (typeof targetMatcher === 'string') {
        return String(ev.target || '').toLowerCase().includes(targetMatcher.toLowerCase())
      }
      if (typeof targetMatcher === 'function') {
        return targetMatcher(ev)
      }
      return false
    })
  }

  /**
   * Validate durable TODO items against evidence.
   * If a step is marked 'complete' but lacks required evidence, returns 'working' or 'pending'.
   */
  validateAndReconcileTodos(todos = []) {
    if (!Array.isArray(todos)) return []

    const reconciled = todos.map(todo => {
      const status = todo.status || 'pending'
      if (status !== 'complete') return todo

      const text = String(todo.text || todo.title || '').toLowerCase()

      // 1. File creation / editing step
      if (/\b(create|write|implement|edit|add|build|update)\s+.*\.(html|css|js|jsx|ts|tsx|json|md|svg)\b/i.test(text)) {
        const fileMatch = text.match(/[\w/\\.-]+\.(html|css|js|jsx|ts|tsx|json|md|svg)/i)
        const targetFile = fileMatch ? fileMatch[0] : null

        const hasWriteEvidence = this.hasEvidence(EVIDENCE_TYPES.FILE_CHANGE, targetFile) ||
                                 this.hasEvidence(EVIDENCE_TYPES.FILE_EXISTS, targetFile) ||
                                 this.hasEvidence(EVIDENCE_TYPES.TOOL_SUCCESS, targetFile)

        if (!hasWriteEvidence) {
          this._addWarning('TODO_EVIDENCE_MISSING', `Step "${todo.text}" was marked complete without verified file mutation evidence.`, todo)
          this._addCorrection('STEP_REVERTED', todo.text, 'complete', 'working')
          return { ...todo, status: 'working', note: 'Reverted: missing file evidence' }
        }
      }

      // 2. Verification step
      if (/\b(verify|check|test|lint|typecheck|audit)\b/i.test(text)) {
        const hasVerifEvidence = this.hasEvidence(EVIDENCE_TYPES.COMMAND_SUCCESS) ||
                                 this.hasEvidence(EVIDENCE_TYPES.TEST_SUCCESS) ||
                                 this.hasEvidence(EVIDENCE_TYPES.BUILD_SUCCESS) ||
                                 this.hasEvidence(EVIDENCE_TYPES.BROWSER_VERIFICATION) ||
                                 this.hasEvidence(EVIDENCE_TYPES.TOOL_SUCCESS, 'validate_standalone_html')

        if (!hasVerifEvidence) {
          this._addWarning('VERIFICATION_EVIDENCE_MISSING', `Step "${todo.text}" marked complete without execution evidence.`, todo)
          this._addCorrection('STEP_REVERTED', todo.text, 'complete', 'pending')
          return { ...todo, status: 'pending', note: 'Reverted: missing verification evidence' }
        }
      }

      return todo
    })

    return reconciled
  }

  /**
   * Validate whether AGENT_STATES.COMPLETED transition is valid given current state & evidence.
   */
  validateCompletionState({ todos = [], requiresVerification = false, hasVerified = false, writtenFiles = [] } = {}) {
    const issues = []

    // 1. Check uncompleted mandatory TODOs
    const incomplete = todos.filter(t => t.status !== 'complete')
    if (incomplete.length > 0) {
      issues.push(`Mandatory TODO items remain incomplete: ${incomplete.map(t => t.text || t.title).join(', ')}`)
    }

    // 2. Check verification requirement
    if (requiresVerification && writtenFiles.length > 0 && !hasVerified) {
      const hasAnyCheckPass = this.hasEvidence(EVIDENCE_TYPES.BUILD_SUCCESS) ||
                              this.hasEvidence(EVIDENCE_TYPES.TEST_SUCCESS) ||
                              this.hasEvidence(EVIDENCE_TYPES.COMMAND_SUCCESS) ||
                              this.hasEvidence(EVIDENCE_TYPES.BROWSER_VERIFICATION)
      if (!hasAnyCheckPass) {
        issues.push('Project requires verification after file changes, but no verification check has passed.')
      }
    }

    return {
      valid: issues.length === 0,
      issues
    }
  }

  _addWarning(code, message, data = {}) {
    const warning = { code, message, data, timestamp: Date.now() }
    this.warnings.push(warning)
    this._logToDb('CONSISTENCY_WARNING', warning)
  }

  _addCorrection(type, target, fromState, toState) {
    const correction = { type, target, fromState, toState, timestamp: Date.now() }
    this.corrections.push(correction)
    this._logToDb('STATE_CORRECTED', correction)
  }

  _logToDb(type, payload) {
    const api = this.getApi()
    if (api?.db?.logAgentEvent) {
      try {
        api.db.logAgentEvent({ type, payload })
      } catch {}
    }
  }
}
