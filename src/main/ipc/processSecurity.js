// ── processSecurity.js ──────────────────────────────────────────────────────
// Working directory validation and process tracking per agent run.
// ─────────────────────────────────────────────────────────────────────────────

import { isPathInWorkspace } from './pathSanitizer.js'

let currentWorkspaceRoot = null

export function setProcessSecurityWorkspace(workspaceRoot) {
  currentWorkspaceRoot = workspaceRoot
}

export function getProcessSecurityWorkspace() {
  return currentWorkspaceRoot
}

/**
 * Validates a working directory against the active workspace boundary.
 * If workspace is active, cwd must reside inside it.
 *
 * @param {string} cwd
 * @param {string} [workspaceRoot]
 * @returns {{ ok: boolean, cwd?: string, error?: string }}
 */
export function validateProcessCwd(cwd, workspaceRoot = currentWorkspaceRoot) {
  if (!workspaceRoot) {
    return { ok: true, cwd: cwd || undefined }
  }
  const effectiveCwd = cwd || workspaceRoot
  if (!isPathInWorkspace(effectiveCwd, workspaceRoot)) {
    return { ok: false, error: 'Access denied: Working directory is outside the workspace.' }
  }
  return { ok: true, cwd: effectiveCwd }
}

const runProcesses = new Map()

export function registerRunProcess(runId, item) {
  if (!runId || !item) return
  if (!runProcesses.has(runId)) runProcesses.set(runId, new Set())
  runProcesses.get(runId).add(item)
}

export function unregisterRunProcess(runId, itemRef) {
  if (!runId || !runProcesses.has(runId)) return
  const set = runProcesses.get(runId)
  for (const item of set) {
    if (item === itemRef || item.child === itemRef || item.processId === itemRef || item.requestId === itemRef) {
      set.delete(item)
      break
    }
  }
  if (set.size === 0) runProcesses.delete(runId)
}

export function cleanupProcessesForRun(runId) {
  if (!runId || !runProcesses.has(runId)) return { cleaned: 0 }
  const procs = runProcesses.get(runId)
  let count = 0
  for (const item of procs) {
    try {
      if (item.type === 'command') {
        if (item.child && !item.child.killed) {
          item.child.kill('SIGTERM')
          count++
        }
      } else if (item.type === 'process') {
        const record = item.record
        if (record && record.status === 'running') {
          record.child?.kill('SIGTERM')
          record.status = 'stopped'
          record.exitedAt = Date.now()
          count++
        }
      }
    } catch (err) {
      console.warn('[cleanupProcessesForRun]', err.message)
    }
  }
  runProcesses.delete(runId)
  return { cleaned: count }
}

export function getRunProcessesCount(runId) {
  return runProcesses.get(runId)?.size || 0
}
