/**
 * AdaptiveContextWindow.js
 *
 * Implements Phase 17 (Adaptive Context Window) & Phase 19 (Agent Attention Windows).
 * Stages: PLANNING, IMPLEMENTATION, DEBUGGING, VERIFICATION, FINAL_RESPONSE.
 * Manages CURRENT ATTENTION: focused high-density window containing only what the agent currently needs.
 */

export const AGENT_STAGES = {
  PLANNING: 'PLANNING',
  IMPLEMENTATION: 'IMPLEMENTATION',
  DEBUGGING: 'DEBUGGING',
  VERIFICATION: 'VERIFICATION',
  FINAL_RESPONSE: 'FINAL_RESPONSE'
}

export class CurrentAttention {
  constructor({ currentTask, currentFile, currentSymbol, currentError, relevantCallers = [], relevantTest, recentDecision } = {}) {
    this.currentTask = currentTask || null
    this.currentFile = currentFile || null
    this.currentSymbol = currentSymbol || null
    this.currentError = currentError || null
    this.relevantCallers = relevantCallers
    this.relevantTest = relevantTest || null
    this.recentDecision = recentDecision || null
  }

  format() {
    const lines = ['[CURRENT ATTENTION WINDOW]']
    if (this.currentTask) lines.push(`Task: ${this.currentTask}`)
    if (this.currentFile) lines.push(`Active File: ${this.currentFile}`)
    if (this.currentSymbol) lines.push(`Active Symbol: ${this.currentSymbol}`)
    if (this.currentError) lines.push(`Active Error: ${this.currentError}`)
    if (this.relevantCallers.length) lines.push(`Callers: ${this.relevantCallers.join(', ')}`)
    if (this.relevantTest) lines.push(`Target Test: ${this.relevantTest}`)
    if (this.recentDecision) lines.push(`Recent Decision: ${this.recentDecision}`)
    return lines.join('\n')
  }
}

export class AdaptiveContextWindow {
  static buildContext(stage, { task, attention, failure, changedFiles = [], testResults, projectSummary, symbolOverview } = {}) {
    const activeAttention = attention instanceof CurrentAttention ? attention : new CurrentAttention(attention || { currentTask: task })
    const sections = []

    // 1. Attention anchor is always present
    sections.push(activeAttention.format())

    // 2. Stage-adapted context projection
    switch (stage) {
      case AGENT_STAGES.PLANNING:
        sections.push('[STAGE: PLANNING]')
        if (projectSummary) sections.push(`Project Overview:\n${projectSummary}`)
        sections.push('Focus: High-level architecture, module decomposition, and dependency order.')
        break

      case AGENT_STAGES.IMPLEMENTATION:
        sections.push('[STAGE: IMPLEMENTATION]')
        if (symbolOverview?.definition) {
          sections.push(`Symbol Definition (${symbolOverview.name}):\n${symbolOverview.definition}`)
        }
        sections.push('Focus: Precision editing, maintaining type signatures, local assertions.')
        break

      case AGENT_STAGES.DEBUGGING:
        sections.push('[STAGE: DEBUGGING]')
        if (failure?.formattedSummary) {
          sections.push(failure.formattedSummary)
        }
        sections.push('Focus: Trace stack frames to failing assertions, isolate root cause, repair minimal footprint.')
        break

      case AGENT_STAGES.VERIFICATION:
        sections.push('[STAGE: VERIFICATION]')
        sections.push(`Modified Files (${changedFiles.length}): ${changedFiles.join(', ') || 'none'}`)
        if (testResults) sections.push(`Verification Results:\n${testResults}`)
        sections.push('Focus: Build, test, and typecheck verification. Do not add unverified features.')
        break

      case AGENT_STAGES.FINAL_RESPONSE:
        sections.push('[STAGE: FINAL_RESPONSE]')
        sections.push(`Completed Files: ${changedFiles.join(', ')}`)
        sections.push('Focus: Concise deliverable summary and verification proof.')
        break

      default:
        sections.push(`[STAGE: ${stage}]`)
    }

    return sections.join('\n\n')
  }
}
