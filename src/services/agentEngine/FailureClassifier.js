// ── FailureClassifier.js ──────────────────────────────────────────────────
// Structured failure classification and strategy recommendation engine.
// ─────────────────────────────────────────────────────────────────────────────

export const FAILURE_CATEGORIES = Object.freeze({
  PATH_ERROR:        'PATH_ERROR',
  PERMISSION_ERROR:  'PERMISSION_ERROR',
  COMMAND_ERROR:     'COMMAND_ERROR',
  MISSING_RUNTIME:   'MISSING_RUNTIME',
  DEPENDENCY_ERROR:  'DEPENDENCY_ERROR',
  SYNTAX_ERROR:      'SYNTAX_ERROR',
  VALIDATION_ERROR:  'VALIDATION_ERROR',
  NETWORK_ERROR:     'NETWORK_ERROR',
  TIMEOUT:           'TIMEOUT',
  TOOL_ERROR:        'TOOL_ERROR',
  UNKNOWN:           'UNKNOWN'
})

export class FailureClassifier {
  /**
   * Classify a tool execution failure based on structured parameters.
   *
   * @param {object} params
   * @param {string} [params.tool]
   * @param {string} [params.command]
   * @param {string} [params.stderr]
   * @param {string} [params.stdout]
   * @param {number} [params.exitCode]
   * @param {string|Error} [params.error]
   * @returns {{ category: string, confidence: number, retryable: boolean, strategy: string, reason: string, evidence: object }}
   */
  static classify({ tool = 'unknown', command = '', stderr = '', stdout = '', exitCode = null, error = null }) {
    const errText = String(error?.message || error || '').trim()
    const stdErr = String(stderr || '').trim()
    const stdOut = String(stdout || '').trim()
    const combined = `${errText}\n${stdErr}\n${stdOut}`.toLowerCase()
    const cmd = String(command || '').toLowerCase()

    // 1. MISSING_RUNTIME
    if (
      /is not recognized as an internal or external command/i.test(combined) ||
      /command not found/i.test(combined) ||
      /enoent/i.test(combined) && (cmd.includes('python') || cmd.includes('pytest') || cmd.includes('pip') || cmd.includes('cargo') || cmd.includes('go') || cmd.includes('mvn') || cmd.includes('gradle')) ||
      /python\s+is\s+not\s+installed/i.test(combined) ||
      /cannot\s+find\s+module/i.test(combined) && /executable/i.test(combined)
    ) {
      return {
        category: FAILURE_CATEGORIES.MISSING_RUNTIME,
        confidence: 0.95,
        retryable: false,
        strategy: 'AVOID_RUNTIME_USE_NATIVE_TOOLS',
        reason: `The requested runtime environment or executable is not available on this system.`,
        evidence: { tool, command, error: errText || stdErr }
      }
    }

    // 2. PATH_ERROR
    if (
      /no such file or directory/i.test(combined) ||
      /does not exist/i.test(combined) ||
      /path must remain inside/i.test(combined) ||
      /cannot find path/i.test(combined) ||
      /enoent/i.test(combined)
    ) {
      return {
        category: FAILURE_CATEGORIES.PATH_ERROR,
        confidence: 0.9,
        retryable: true,
        strategy: 'VERIFY_OR_CREATE_FILE_PATH',
        reason: `Target file or directory path was not found or is outside the workspace.`,
        evidence: { tool, command, error: errText }
      }
    }

    // 3. PERMISSION_ERROR
    if (
      /permission denied/i.test(combined) ||
      /eacces/i.test(combined) ||
      /eperm/i.test(combined) ||
      /access is denied/i.test(combined) ||
      /denied by user/i.test(combined)
    ) {
      return {
        category: FAILURE_CATEGORIES.PERMISSION_ERROR,
        confidence: 0.95,
        retryable: false,
        strategy: 'PROPOSE_PREAPPROVED_ALTERNATIVE_OR_ASK_USER',
        reason: `Operation was blocked due to file or OS permissions or user refusal.`,
        evidence: { tool, command, error: errText }
      }
    }

    // 4. TIMEOUT
    if (
      /timeout/i.test(combined) ||
      /timed out/i.test(combined) ||
      /etimedout/i.test(combined) ||
      /exceeded maximum execution time/i.test(combined)
    ) {
      return {
        category: FAILURE_CATEGORIES.TIMEOUT,
        confidence: 0.9,
        retryable: true,
        strategy: 'INCREASE_TIMEOUT_OR_CHOP_WORK',
        reason: `The operation timed out before completing.`,
        evidence: { tool, command, timeout: true }
      }
    }

    // 5. DEPENDENCY_ERROR
    if (
      /module_not_found/i.test(combined) ||
      /cannot find module/i.test(combined) ||
      /package\s+.*\s+is\s+not\s+installed/i.test(combined) ||
      /import\s+error/i.test(combined) ||
      /unresolved dependency/i.test(combined)
    ) {
      return {
        category: FAILURE_CATEGORIES.DEPENDENCY_ERROR,
        confidence: 0.85,
        retryable: true,
        strategy: 'INSTALL_MISSING_DEPENDENCY_OR_USE_BUILTIN',
        reason: `A required package or module dependency is missing.`,
        evidence: { tool, command, error: errText || stdErr }
      }
    }

    // 6. SYNTAX_ERROR
    if (
      /syntaxerror/i.test(combined) ||
      /unexpected token/i.test(combined) ||
      /parse error/i.test(combined) ||
      /invalid syntax/i.test(combined) ||
      /the syntax of the command is incorrect/i.test(combined) ||
      /contains invalid css/i.test(combined) ||
      /refusing to write an incomplete/i.test(combined)
    ) {
      return {
        category: FAILURE_CATEGORIES.SYNTAX_ERROR,
        confidence: 0.9,
        retryable: true,
        strategy: 'CORRECT_SYNTAX_OR_FORMAT',
        reason: `Command or file markup contains syntax errors.`,
        evidence: { tool, command, error: errText || stdErr }
      }
    }

    // 7. VALIDATION_ERROR
    if (
      /invalid tool arguments/i.test(combined) ||
      /validation failed/i.test(combined) ||
      /missing required/i.test(combined) ||
      /zod/i.test(combined)
    ) {
      return {
        category: FAILURE_CATEGORIES.VALIDATION_ERROR,
        confidence: 0.95,
        retryable: true,
        strategy: 'FIX_TOOL_ARGUMENTS',
        reason: `Tool input schema validation rejected the provided parameters.`,
        evidence: { tool, error: errText }
      }
    }

    // 8. NETWORK_ERROR
    if (
      /fetch failed/i.test(combined) ||
      /enotfound/i.test(combined) ||
      /econnrefused/i.test(combined) ||
      /net::err/i.test(combined)
    ) {
      return {
        category: FAILURE_CATEGORIES.NETWORK_ERROR,
        confidence: 0.85,
        retryable: true,
        strategy: 'RETRY_WITH_BACKOFF_OR_USE_LOCAL',
        reason: `Network request or external resource lookup failed.`,
        evidence: { tool, error: errText }
      }
    }

    // 9. COMMAND_ERROR
    if (exitCode !== null && exitCode !== 0) {
      return {
        category: FAILURE_CATEGORIES.COMMAND_ERROR,
        confidence: 0.8,
        retryable: true,
        strategy: 'INSPECT_STDERR_AND_REPAIR',
        reason: `Command exited with non-zero exit code (${exitCode}).`,
        evidence: { tool, command, exitCode, stdErr: stdErr.slice(0, 300) }
      }
    }

    if (tool && tool !== 'unknown') {
      return {
        category: FAILURE_CATEGORIES.TOOL_ERROR,
        confidence: 0.7,
        retryable: true,
        strategy: 'INSPECT_TOOL_OUTPUT_AND_RETRY',
        reason: `Tool execution failed.`,
        evidence: { tool, error: errText }
      }
    }

    return {
      category: FAILURE_CATEGORIES.UNKNOWN,
      confidence: 0.5,
      retryable: true,
      strategy: 'DIAGNOSE_AND_RECOVER',
      reason: `Unclassified failure.`,
      evidence: { tool, command, error: errText || stdErr }
    }
  }
}
