/**
 * RunHistoryManager.js
 *
 * Implements Phase 23: Run History
 * Allows users to inspect and reopen previous runs.
 * Tracks: task, duration, models used, files changed, tests run, outcome result, errors, and rollback state.
 */

export class RunHistoryManager {
  constructor({ maxRuns = 50 } = {}) {
    this.maxRuns = maxRuns
    this.runs = new Map() // runId -> record
  }

  recordRun({ runId, task, durationMs, models = [], filesChanged = [], tests = [], result = 'complete', error = null, checkpoint = null, rollbackAvailable = true }) {
    if (!runId) return null

    const record = {
      runId,
      task: String(task || 'Untitled Task').trim(),
      durationMs: Number(durationMs) || 0,
      models: [...new Set(models)],
      filesChanged: [...new Set(filesChanged)],
      tests: Array.isArray(tests) ? tests : [],
      result,
      error: error ? String(error?.message || error) : null,
      checkpoint,
      rollbackAvailable: Boolean(rollbackAvailable),
      timestamp: Date.now()
    }

    this.runs.set(runId, record)

    // Maintain max history bounds
    if (this.runs.size > this.maxRuns) {
      const oldestKey = this.runs.keys().next().value
      this.runs.delete(oldestKey)
    }

    return record
  }

  getRun(runId) {
    return this.runs.get(runId) || null
  }

  listRuns({ limit = 20 } = {}) {
    return [...this.runs.values()]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
  }

  reopenRun(runId) {
    const run = this.getRun(runId)
    if (!run) return { success: false, error: `Run ${runId} not found.` }

    return {
      success: true,
      run,
      resumable: Boolean(run.checkpoint),
      task: run.task,
      filesChanged: run.filesChanged
    }
  }

  clear() {
    this.runs.clear()
  }
}

export const runHistoryManager = new RunHistoryManager()
