import { ipcMain } from 'electron'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { isPathInWorkspace } from './pathSanitizer.js'
import { getWatchedWorkspacePath } from './fs.ipc.js'

const execPromise = promisify(exec)
const managedProcesses = new Map()
const activeCommands = new Map()
const terminalSessions = new Map()
const runProcesses = new Map()
let processSequence = 0

export function validateProcessCwd(cwd) {
  const workspaceRoot = getWatchedWorkspacePath()
  if (!workspaceRoot) {
    return { ok: true, cwd: cwd || undefined }
  }
  const effectiveCwd = cwd || workspaceRoot
  if (!isPathInWorkspace(effectiveCwd, workspaceRoot)) {
    return { ok: false, error: 'Access denied: Working directory is outside the workspace.' }
  }
  return { ok: true, cwd: effectiveCwd }
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
        if (item.requestId) activeCommands.delete(item.requestId)
      } else if (item.type === 'process') {
        const record = item.record || managedProcesses.get(item.processId)
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

function cleanupRunProcessItem(runId, processId) {
  if (!runId || !runProcesses.has(runId)) return
  const set = runProcesses.get(runId)
  for (const item of set) {
    if (item.processId === processId) {
      set.delete(item)
      break
    }
  }
  if (set.size === 0) runProcesses.delete(runId)
}

function serializeProcess(record) {
  return {
    id: record.id, command: record.command, cwd: record.cwd, status: record.status,
    startedAt: record.startedAt, exitedAt: record.exitedAt || null, exitCode: record.exitCode ?? null,
    output: record.output.slice(-120), pid: record.child?.pid || null
  }
}

function appendProcessOutput(record, stream, chunk) {
  record.output.push({ stream, text: String(chunk), timestamp: Date.now() })
  if (record.output.length > 500) record.output.splice(0, record.output.length - 500)
}

export function registerProcessIPC() {
  ipcMain.handle('terminal-start', async (event, { id = 'default', cwd } = {}) => {
    try {
      const cwdCheck = validateProcessCwd(cwd)
      if (!cwdCheck.ok) {
        return { success: false, error: cwdCheck.error }
      }
      const effectiveCwd = cwdCheck.cwd

      const existing = terminalSessions.get(id)
      if (existing?.child && !existing.child.killed) {
        return { success: true, session: { id, cwd: existing.cwd } }
      }

      const shellPath = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/bash')
      const shellArgs = process.platform === 'win32' ? ['/Q', '/K'] : ['-i']
      const child = spawn(shellPath, shellArgs, {
        cwd: effectiveCwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      const session = { id, cwd: effectiveCwd || '', child, sender: event.sender }
      terminalSessions.set(id, session)
      const publish = (stream, chunk) => event.sender.send('terminal-data', { id, stream, text: String(chunk) })
      child.stdout.on('data', chunk => publish('stdout', chunk))
      child.stderr.on('data', chunk => publish('stderr', chunk))
      child.on('error', error => publish('stderr', `${error.message}\n`))
      child.on('close', code => {
        publish('system', `\n[terminal exited with code ${code ?? 'unknown'}]\n`)
        terminalSessions.delete(id)
      })
      return { success: true, session: { id, cwd: session.cwd } }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('terminal-write', async (_, { id = 'default', input } = {}) => {
    const session = terminalSessions.get(id)
    if (!session?.child?.stdin?.writable) return { success: false, error: 'Terminal is not running.' }
    session.child.stdin.write(`${String(input ?? '')}\n`)
    return { success: true }
  })

  ipcMain.handle('terminal-stop', async (_, { id = 'default' } = {}) => {
    const session = terminalSessions.get(id)
    if (!session) return { success: true }
    session.child.kill()
    terminalSessions.delete(id)
    return { success: true }
  })

  ipcMain.handle('run-code', async (_, command) => {
    try {
      const { stdout, stderr } = await execPromise(command, { timeout: 10000 })
      return { success: true, stdout, stderr }
    } catch (error) {
      let errorMessage = error.stderr || error.message
      if (error.killed) errorMessage = 'Execution timed out after 10 seconds.'
      return { success: false, stdout: error.stdout || '', stderr: errorMessage }
    }
  })

  ipcMain.handle('run-command', async (_, { command, cwd, timeoutMs, requestId, runId }) => {
    const cwdCheck = validateProcessCwd(cwd)
    if (!cwdCheck.ok) {
      return { success: false, stdout: '', stderr: cwdCheck.error, durationMs: 0 }
    }
    const effectiveCwd = cwdCheck.cwd
    const startedAt = Date.now()
    return new Promise(resolve => {
      let child
      const finish = (error, stdout = '', stderr = '') => {
        if (requestId) activeCommands.delete(requestId)
        if (runId && runProcesses.has(runId)) {
          const set = runProcesses.get(runId)
          for (const item of set) {
            if (item.child === child) {
              set.delete(item)
              break
            }
          }
          if (set.size === 0) runProcesses.delete(runId)
        }
        let errorMessage = error?.stderr || stderr || error?.message || ''
        if (error?.killed) errorMessage = 'Command cancelled or timed out.'
        resolve(error
          ? { success: false, stdout: error.stdout || stdout || '', stderr: errorMessage, durationMs: Date.now() - startedAt, cancelled: Boolean(error?.killed) }
          : { success: true, stdout, stderr, durationMs: Date.now() - startedAt })
      }
      child = exec(command, {
        cwd: effectiveCwd,
        timeout: Math.min(Math.max(Number(timeoutMs) || 120000, 1000), 15 * 60 * 1000),
        maxBuffer: 1024 * 1024 * 4
      }, finish)
      if (requestId) activeCommands.set(requestId, child)
      if (runId) {
        if (!runProcesses.has(runId)) runProcesses.set(runId, new Set())
        runProcesses.get(runId).add({ type: 'command', child, requestId })
      }
    })
  })

  ipcMain.on('run-command:cancel', (_, identifier) => {
    if (typeof identifier === 'string') {
      const child = activeCommands.get(identifier)
      if (child && !child.killed) child.kill()
      cleanupProcessesForRun(identifier)
    } else if (identifier && typeof identifier === 'object') {
      if (identifier.requestId) {
        const child = activeCommands.get(identifier.requestId)
        if (child && !child.killed) child.kill()
      }
      if (identifier.runId) {
        cleanupProcessesForRun(identifier.runId)
      }
    }
  })

  ipcMain.handle('process-cleanup-run', async (_, runId) => {
    return { success: true, ...cleanupProcessesForRun(runId) }
  })

  ipcMain.handle('process-start', async (_, { command, cwd, id, runId }) => {
    try {
      if (!command) throw new Error('Command is required.')
      const cwdCheck = validateProcessCwd(cwd)
      if (!cwdCheck.ok) throw new Error(cwdCheck.error)
      const effectiveCwd = cwdCheck.cwd
      const processId = id || `agent-process-${++processSequence}`
      if (managedProcesses.has(processId) && managedProcesses.get(processId).status === 'running') {
        throw new Error(`Process ${processId} is already running.`)
      }
      const child = spawn(command, { cwd: effectiveCwd, shell: true, windowsHide: true, detached: false })
      const record = { id: processId, command, cwd: effectiveCwd || '', child, status: 'running', startedAt: Date.now(), output: [], runId: runId || null }
      managedProcesses.set(processId, record)
      if (runId) {
        if (!runProcesses.has(runId)) runProcesses.set(runId, new Set())
        runProcesses.get(runId).add({ type: 'process', record, processId })
      }
      child.stdout?.on('data', chunk => appendProcessOutput(record, 'stdout', chunk))
      child.stderr?.on('data', chunk => appendProcessOutput(record, 'stderr', chunk))
      child.on('error', error => {
        appendProcessOutput(record, 'stderr', error.message)
        record.status = 'failed'
        record.exitedAt = Date.now()
        cleanupRunProcessItem(runId, processId)
      })
      child.on('close', code => {
        record.exitCode = code
        record.exitedAt = Date.now()
        record.status = code === 0 ? 'stopped' : 'failed'
        cleanupRunProcessItem(runId, processId)
      })
      return { success: true, process: serializeProcess(record) }
    } catch (error) { return { success: false, error: error.message } }
  })

  ipcMain.handle('process-list', async () => ({ success: true, processes: [...managedProcesses.values()].map(serializeProcess) }))
  
  ipcMain.handle('process-get', async (_, id) => {
    const record = managedProcesses.get(id)
    return record ? { success: true, process: serializeProcess(record) } : { success: false, error: `Unknown process: ${id}` }
  })

  ipcMain.handle('process-output', async (_, { id, limit = 120 }) => {
    const record = managedProcesses.get(id)
    return record ? { success: true, output: record.output.slice(-Math.min(Number(limit) || 120, 500)) } : { success: false, error: `Unknown process: ${id}` }
  })

  ipcMain.handle('process-stop', async (_, id) => {
    const record = managedProcesses.get(id)
    if (!record) return { success: false, error: `Unknown process: ${id}` }
    if (record.status === 'running') record.child.kill()
    record.status = 'stopped'; record.exitedAt = Date.now()
    return { success: true, process: serializeProcess(record) }
  })

  ipcMain.handle('process-restart', async (_, id) => {
    const record = managedProcesses.get(id)
    if (!record) return { success: false, error: `Unknown process: ${id}` }
    if (record.status === 'running') record.child.kill()
    const child = spawn(record.command, { cwd: record.cwd || undefined, shell: true, windowsHide: true, detached: false })
    record.child = child; record.status = 'running'; record.startedAt = Date.now(); record.exitedAt = null; record.exitCode = null; record.output = []
    child.stdout?.on('data', chunk => appendProcessOutput(record, 'stdout', chunk))
    child.stderr?.on('data', chunk => appendProcessOutput(record, 'stderr', chunk))
    child.on('error', error => { appendProcessOutput(record, 'stderr', error.message); record.status = 'failed'; record.exitedAt = Date.now() })
    child.on('close', code => { record.exitCode = code; record.exitedAt = Date.now(); record.status = code === 0 ? 'stopped' : 'failed' })
    return { success: true, process: serializeProcess(record) }
  })
}

