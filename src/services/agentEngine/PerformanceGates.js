/**
 * PerformanceGates.js
 *
 * Implements Phase 27: Performance Gates
 * Enforces strict latency budgets on all major agent and code intelligence operations.
 * Ensures SimpleIDE responsiveness is never sacrificed for agent sophistication.
 */

export const PERFORMANCE_BUDGETS_MS = {
  LAYA_DECISION: 15,
  CONTEXT_BUILD: 50,
  SYMBOL_LOOKUP: 10,
  TOOL_SELECTION: 5,
  PTY_STARTUP: 100,
  INDEX_UPDATE: 20
}

export class PerformanceGates {
  constructor() {
    this.records = []
  }

  async measure(gateName, fn) {
    const started = performance.now()
    let result
    let error = null

    try {
      result = await fn()
    } catch (err) {
      error = err
    }

    const durationMs = performance.now() - started
    const budget = PERFORMANCE_BUDGETS_MS[gateName] || 50
    const passed = durationMs <= budget

    const record = {
      gate: gateName,
      durationMs: Number(durationMs.toFixed(2)),
      budgetMs: budget,
      passed,
      timestamp: Date.now()
    }

    this.records.push(record)

    if (error) throw error
    return { result, record }
  }

  getAuditSummary() {
    const total = this.records.length
    const passed = this.records.filter(r => r.passed).length
    return {
      totalMeasured: total,
      passedGates: passed,
      failedGates: total - passed,
      complianceRate: total > 0 ? `${((passed / total) * 100).toFixed(1)}%` : '100%',
      metrics: this.records.slice(-20)
    }
  }

  clear() {
    this.records = []
  }
}

export const performanceGates = new PerformanceGates()
