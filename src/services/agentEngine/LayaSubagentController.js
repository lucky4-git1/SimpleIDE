/**
 * LayaSubagentController.js
 *
 * Implements Phase 11: Laya Subagent Controller
 * Evaluates whether delegation to parallel read-only subagents is worthwhile.
 * Prevents worker sprawl on trivial tasks.
 * Selects targeted worker configurations for complex investigations.
 */

import { SUBAGENT_ROLES } from './SubagentManager.js'

const TRIVIAL_PATTERNS = [
  /^(rename|change)\s+(variable|const|let|var)\s+\w+/i,
  /^fix\s+(typo|spelling|whitespace|indentation)/i,
  /^add\s+comment/i,
  /^console\.log/i
]

const COMPLEX_INVESTIGATION_PATTERNS = [
  /analyze\s+why|investigate\s+why|find\s+cause/i,
  /across\s+(the\s+)?(app|application|workspace|project|codebase)/i,
  /refactor\s+(auth|authentication|database|architecture)/i,
  /security\s+(audit|vulnerability|check)/i,
  /why\s+(tests?|suite)\s+(are\s+)?failing/i
]

export class LayaSubagentController {
  constructor({ localModelRuntime } = {}) {
    this.localModelRuntime = localModelRuntime
  }

  /**
   * Evaluates a user task prompt and decides whether to spawn read-only subagents.
   */
  decideDelegation(taskPrompt, { context = {} } = {}) {
    const text = String(taskPrompt || '').trim()

    // 1. Trivial task filter -> strictly no workers
    if (TRIVIAL_PATTERNS.some(p => p.test(text))) {
      return {
        shouldDelegate: false,
        workers: [],
        reason: 'Task is trivial; direct execution is faster and cheaper without delegation.',
        confidence: 0.98
      }
    }

    // 2. Complex exploration detection
    const isComplex = COMPLEX_INVESTIGATION_PATTERNS.some(p => p.test(text)) || text.length > 200

    if (isComplex) {
      const selectedWorkers = []

      if (/test/i.test(text)) {
        selectedWorkers.push(SUBAGENT_ROLES.TEST_ANALYZER)
      }
      if (/dep|package|import|library|module/i.test(text)) {
        selectedWorkers.push(SUBAGENT_ROLES.DEPENDENCY_ANALYZER)
      }
      if (/why|cause|investigate|audit|scan|search/i.test(text)) {
        selectedWorkers.push(SUBAGENT_ROLES.CODE_SCANNER)
      }
      if (/doc|framework|api|best practice|library/i.test(text)) {
        selectedWorkers.push(SUBAGENT_ROLES.RESEARCHER)
      }

      // Default to code scanner and test analyzer if none matched
      if (selectedWorkers.length === 0) {
        selectedWorkers.push(SUBAGENT_ROLES.CODE_SCANNER, SUBAGENT_ROLES.TEST_ANALYZER)
      }

      return {
        shouldDelegate: true,
        workers: [...new Set(selectedWorkers)].slice(0, 3),
        reason: 'Complex or multi-file investigation benefits from parallel read-only analysis.',
        confidence: 0.92
      }
    }

    // 3. Moderate / standard task: no subagents by default to conserve resources
    return {
      shouldDelegate: false,
      workers: [],
      reason: 'Standard single-focus task; direct agent workflow is optimal.',
      confidence: 0.85
    }
  }
}

export const layaSubagentController = new LayaSubagentController()
