/**
 * LayaDebuggingController.js
 *
 * Implements Phase 14: Laya Debugging Controller
 * Decides dynamic recovery and debugging actions after a failure:
 * - retry_same, retry_modified
 * - inspect_definition, find_references
 * - inspect_test, inspect_dependency
 * - run_diagnostic, change_strategy
 * - escalate_model, ask_user, stop
 * Prevents loop lock by never repeating failed strategies.
 */

export const DEBUG_STRATEGIES = {
  RETRY_SAME: 'retry_same',
  RETRY_MODIFIED: 'retry_modified',
  INSPECT_DEFINITION: 'inspect_definition',
  FIND_REFERENCES: 'find_references',
  INSPECT_TEST: 'inspect_test',
  INSPECT_DEPENDENCY: 'inspect_dependency',
  RUN_DIAGNOSTIC: 'run_diagnostic',
  CHANGE_STRATEGY: 'change_strategy',
  ESCALATE_MODEL: 'escalate_model',
  ASK_USER: 'ask_user',
  STOP: 'stop'
}

export class LayaDebuggingController {
  constructor() {
    this.failureHistory = new Map() // runId or errorSignature -> { count, strategiesUsed: [] }
  }

  getSignature(parsedFailure) {
    if (!parsedFailure) return 'unknown_error'
    return `${parsedFailure.errorType}:${parsedFailure.failingFile || ''}:${parsedFailure.failingLine || ''}:${(parsedFailure.errorMessage || '').slice(0, 40)}`
  }

  decideNextAction(parsedFailure, { attempt = 1, currentStrategy = null, maxAttempts = 5 } = {}) {
    const signature = this.getSignature(parsedFailure)
    let history = this.failureHistory.get(signature)
    if (!history) {
      history = { count: 0, strategiesUsed: [] }
      this.failureHistory.set(signature, history)
    }

    history.count++
    if (currentStrategy) {
      history.strategiesUsed.push(currentStrategy)
    }

    const { errorType, failingFile, relatedSymbols = [] } = parsedFailure || {}

    // Hard ceiling: if we've failed too many times, ask user or stop
    if (attempt >= maxAttempts || history.count >= maxAttempts) {
      return {
        strategy: DEBUG_STRATEGIES.ASK_USER,
        reason: `Exceeded maximum automated repair attempts (${attempt}/${maxAttempts}) for this failure signature. Requesting user input.`,
        confidence: 0.95
      }
    }

    // Loop detection: if previous strategy already failed on identical error, change strategy!
    if (history.strategiesUsed.filter(s => s === currentStrategy).length >= 2) {
      return {
        strategy: DEBUG_STRATEGIES.CHANGE_STRATEGY,
        reason: `Strategy "${currentStrategy}" failed repeatedly. Forcing strategy change to break loop.`,
        suggestedFocus: relatedSymbols[0] || failingFile,
        confidence: 0.92
      }
    }

    // 1st attempt: inspect definition or test
    if (attempt === 1) {
      if (errorType === 'ReferenceError' || errorType === 'TypeError') {
        return {
          strategy: DEBUG_STRATEGIES.INSPECT_DEFINITION,
          targetSymbol: relatedSymbols[0] || null,
          reason: `Unresolved symbol or type error: inspecting definition of ${relatedSymbols[0] || 'target symbol'}.`,
          confidence: 0.90
        }
      }
      if (/test/i.test(failingFile || '')) {
        return {
          strategy: DEBUG_STRATEGIES.INSPECT_TEST,
          targetFile: failingFile,
          reason: `Assertion failed in test file ${failingFile}. Inspecting test specification.`,
          confidence: 0.88
        }
      }
      return {
        strategy: DEBUG_STRATEGIES.RETRY_MODIFIED,
        reason: 'Initial failure: attempting localized repair with targeted edits.',
        confidence: 0.85
      }
    }

    // 2nd attempt: expand to dependencies or references
    if (attempt === 2) {
      if (relatedSymbols.length > 0) {
        return {
          strategy: DEBUG_STRATEGIES.FIND_REFERENCES,
          targetSymbol: relatedSymbols[0],
          reason: `Initial fix did not resolve error: inspecting all callers and references of ${relatedSymbols[0]}.`,
          confidence: 0.87
        }
      }
      return {
        strategy: DEBUG_STRATEGIES.INSPECT_DEPENDENCY,
        reason: 'Inspecting module imports and upstream dependencies.',
        confidence: 0.82
      }
    }

    // 3rd attempt: run diagnostics or escalate model
    if (attempt === 3) {
      return {
        strategy: DEBUG_STRATEGIES.RUN_DIAGNOSTIC,
        reason: 'Running AST and syntax diagnostics across the repair area.',
        confidence: 0.85
      }
    }

    // 4th attempt: escalate model reasoning
    return {
      strategy: DEBUG_STRATEGIES.ESCALATE_MODEL,
      reason: 'Standard local repairs exhausted; escalating to high-capacity reasoning model.',
      confidence: 0.90
    }
  }

  reset(signature = null) {
    if (signature) this.failureHistory.delete(signature)
    else this.failureHistory.clear()
  }
}

export const layaDebuggingController = new LayaDebuggingController()
