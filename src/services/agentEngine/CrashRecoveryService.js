// ── CrashRecoveryService.js ───────────────────────────────────────────────
// Reconciles persisted SQLite agent runs against filesystem state on startup.
// ─────────────────────────────────────────────────────────────────────────────

export class CrashRecoveryService {
  constructor(workspaceRoot, { api } = {}) {
    this.root = workspaceRoot
    this.api = api || globalThis.window?.api
  }

  getApi() {
    return this.api || globalThis.window?.api
  }

  /**
   * Reconcile unfinished agent runs in the workspace and determine safe resumption point.
   *
   * @param {string} workspaceId
   * @returns {Promise<{ hasUnfinished: boolean, run?: object, checkpoint?: object, reconciledSteps?: Array, status: string }>}
   */
  async recoverWorkspaceRuns(workspaceId = this.root) {
    const api = this.getApi()
    if (!api?.db) {
      return { hasUnfinished: false, status: 'DB_UNAVAILABLE' }
    }

    try {
      const res = await api.db.getUnfinishedRuns({ workspaceId })
      const unfinishedRuns = res?.success && Array.isArray(res.runs) ? res.runs : []
      if (!unfinishedRuns.length) {
        return { hasUnfinished: false, status: 'CLEAN' }
      }

      const activeRun = unfinishedRuns[0]
      const runId = activeRun.id

      // Fetch persisted run components
      const [eventsRes, toolsRes, stepsRes, changesRes, verifRes] = await Promise.all([
        api.db.getAgentEvents({ runId }),
        api.db.getToolExecutions({ runId }),
        api.db.getPlanSteps({ runId }),
        api.db.getFileChanges({ runId }),
        api.db.getVerifications({ runId })
      ])

      const events = eventsRes?.events || []
      const tools = toolsRes?.executions || []
      const steps = stepsRes?.steps || []
      const changes = changesRes?.changes || []
      const verifications = verifRes?.verifications || []

      // Log recovery start event
      await api.db.logAgentEvent({ runId, sequence: events.length + 1, type: 'RECOVERY_STARTED', payload: { runId, state: activeRun.state } })

      // Filesystem Reconciliation: inspect recorded file changes on disk
      const verifiedFiles = new Set()
      const inconsistentFiles = []

      for (const change of changes) {
        const filePath = change.file_path
        const diskRes = await api.readFile(filePath)

        if (diskRes.success) {
          verifiedFiles.add(filePath)
        } else {
          inconsistentFiles.push(filePath)
        }
      }

      // Reconcile plan steps based on disk evidence
      const reconciledSteps = steps.map(step => {
        const title = String(step.title || '').toLowerCase()
        const matchingFile = Array.from(verifiedFiles).find(f => title.includes(f.split(/[/\\]/).pop().toLowerCase()))

        if (matchingFile) {
          return { ...step, status: 'complete', reconciled: true }
        }
        if (inconsistentFiles.some(f => title.includes(f.split(/[/\\]/).pop().toLowerCase()))) {
          return { ...step, status: 'pending', reconciled: true, note: 'Reverted: missing file on disk' }
        }
        return step
      })

      // Construct safe resume checkpoint
      const checkpoint = {
        runId,
        userPrompt: activeRun.user_prompt,
        lastState: activeRun.state,
        verifiedFiles: Array.from(verifiedFiles),
        inconsistentFiles,
        reconciledSteps,
        lastVerification: verifications.slice(-1)[0] || null,
        toolCount: tools.length,
        resumable: true
      }

      await api.db.logAgentEvent({ runId, sequence: events.length + 2, type: 'RECOVERY_RECONCILIATION', payload: checkpoint })

      return {
        hasUnfinished: true,
        run: activeRun,
        checkpoint,
        reconciledSteps,
        status: 'RECONCILED'
      }
    } catch (err) {
      console.warn('[CrashRecoveryService] Recovery error:', err.message)
      return { hasUnfinished: false, status: 'ERROR', error: err.message }
    }
  }
}
