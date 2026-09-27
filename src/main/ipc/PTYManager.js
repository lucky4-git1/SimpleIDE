/**
 * PTYManager.js
 *
 * Implements Phase 8: Interactive PTY Architecture
 * Architecture: Renderer ↕ IPC ↕ PTY Manager ↕ (node-pty / Shell Stream) ↕ Shell
 * Supports:
 * - Interactive commands with stdin, stdout, stderr
 * - Dynamic terminal resize (cols, rows)
 * - Environment and working directory validation
 * - Graceful fallback if native node-pty binary is not present
 */

import { spawn } from 'child_process'
import { isPathInWorkspace } from './pathSanitizer.js'

export function validateTerminalCwd(cwd, root) {
  if (!cwd) return { ok: true, cwd: root || process.cwd() }
  if (root && !isPathInWorkspace(cwd, root)) {
    return { ok: false, error: 'Access denied: Working directory is outside the workspace.' }
  }
  return { ok: true, cwd }
}

let nodePty = null
try {
  // Optional native dependency
  nodePty = await import('node-pty').catch(() => null)
} catch {
  nodePty = null
}

export class PTYManager {
  constructor() {
    this.sessions = new Map() // id -> session
  }

  isNativePtyAvailable() {
    return Boolean(nodePty && typeof nodePty.spawn === 'function')
  }

  startSession({ id = 'default', cwd, workspaceRoot, env = {}, cols = 80, rows = 24, onData, onExit } = {}) {
    const cwdCheck = validateTerminalCwd(cwd, workspaceRoot)
    if (!cwdCheck.ok) {
      throw new Error(cwdCheck.error || 'Invalid working directory')
    }
    const effectiveCwd = cwdCheck.cwd

    if (this.sessions.has(id)) {
      const existing = this.sessions.get(id)
      if (existing.status === 'running') {
        return existing
      }
      this.stopSession(id)
    }

    const isWin = process.platform === 'win32'
    const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/bash')
    const combinedEnv = { ...process.env, ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }

    let ptyProcess
    let isNative = false

    if (this.isNativePtyAvailable()) {
      try {
        ptyProcess = nodePty.spawn(shell, [], {
          name: 'xterm-256color',
          cols: Math.max(10, cols || 80),
          rows: Math.max(5, rows || 24),
          cwd: effectiveCwd,
          env: combinedEnv
        })
        isNative = true

        ptyProcess.onData(data => {
          onData?.('stdout', data)
        })

        ptyProcess.onExit(({ exitCode }) => {
          session.status = 'stopped'
          session.exitCode = exitCode
          session.exitedAt = Date.now()
          onExit?.(exitCode)
        })
      } catch (err) {
        console.warn('[PTYManager] Native node-pty spawn failed, falling back to piped child process:', err?.message)
      }
    }

    // Fallback: child_process spawn with bi-directional stream pipes
    if (!ptyProcess) {
      const shellArgs = isWin ? ['/Q', '/K'] : ['-i']
      const child = spawn(shell, shellArgs, {
        cwd: effectiveCwd,
        env: combinedEnv,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      child.stdout.on('data', chunk => onData?.('stdout', String(chunk)))
      child.stderr.on('data', chunk => onData?.('stderr', String(chunk)))
      child.on('error', err => onData?.('stderr', `\n[process error: ${err.message}]\n`))
      child.on('close', code => {
        session.status = 'stopped'
        session.exitCode = code
        session.exitedAt = Date.now()
        onExit?.(code)
      })

      ptyProcess = {
        pid: child.pid,
        write: data => child.stdin.write(data),
        resize: (newCols, newRows) => {
          session.cols = newCols
          session.rows = newRows
        },
        kill: () => child.kill('SIGTERM'),
        child
      }
    }

    const session = {
      id,
      pty: ptyProcess,
      isNative,
      cwd: effectiveCwd,
      status: 'running',
      cols,
      rows,
      startedAt: Date.now(),
      exitedAt: null,
      exitCode: null
    }

    this.sessions.set(id, session)
    return session
  }

  write(id, data) {
    const session = this.sessions.get(id)
    if (!session || session.status !== 'running') {
      return { success: false, error: `Terminal ${id} is not running` }
    }
    session.pty.write(data)
    return { success: true }
  }

  resize(id, cols, rows) {
    const session = this.sessions.get(id)
    if (!session || session.status !== 'running') {
      return { success: false, error: `Terminal ${id} is not running` }
    }
    if (typeof session.pty.resize === 'function') {
      session.pty.resize(Math.max(10, cols), Math.max(5, rows))
    }
    session.cols = cols
    session.rows = rows
    return { success: true, cols, rows }
  }

  stopSession(id) {
    const session = this.sessions.get(id)
    if (!session) return { success: true }
    try {
      session.pty.kill()
    } catch {}
    session.status = 'stopped'
    session.exitedAt = Date.now()
    this.sessions.delete(id)
    return { success: true }
  }

  getSession(id) {
    return this.sessions.get(id) || null
  }

  listSessions() {
    return [...this.sessions.values()].map(s => ({
      id: s.id,
      cwd: s.cwd,
      status: s.status,
      cols: s.cols,
      rows: s.rows,
      isNative: s.isNative,
      startedAt: s.startedAt
    }))
  }

  stopAll() {
    for (const id of this.sessions.keys()) {
      this.stopSession(id)
    }
  }
}

export const ptyManager = new PTYManager()
