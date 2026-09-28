/**
 * DevServerManager.js
 *
 * Implements Phase 9: Dev Server Management
 * Manages long-running development servers and persistent processes.
 * States: STARTING, RUNNING, FAILED, STOPPING, STOPPED.
 * Automatically parses active local ports from stdout/stderr.
 */

export const DEV_SERVER_STATES = {
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  FAILED: 'FAILED',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED'
}

const PORT_PATTERNS = [
  /https?:\/\/localhost:(\d+)/i,
  /https?:\/\/127\.0\.0\.1:(\d+)/i,
  /https?:\/\/0\.0\.0\.0:(\d+)/i,
  /\blocal:\s*https?:\/\/[^:]+:(\d+)/i,
  /\bnetwork:\s*https?:\/\/[^:]+:(\d+)/i,
  /\bport\s+(\d+)/i,
  /\blistening on.*?(\d{4,5})\b/i
]

export function extractPort(text) {
  if (!text) return null
  const str = String(text)
  for (const pattern of PORT_PATTERNS) {
    const match = str.match(pattern)
    if (match && match[1]) {
      const port = parseInt(match[1], 10)
      if (port > 0 && port < 65536) return port
    }
  }
  return null
}

export class DevServerManager {
  constructor({ api } = {}) {
    this.api = api || globalThis.window?.api
    this.servers = new Map() // id -> record
    this.listeners = new Set()
  }

  getApi() {
    return this.api || globalThis.window?.api
  }

  async startDevServer({ command, cwd, id } = {}) {
    if (!command) throw new Error('Command is required to start a development server.')
    const serverId = id || `dev-server-${Date.now()}`
    const api = this.getApi()

    if (this.servers.has(serverId)) {
      const existing = this.servers.get(serverId)
      if (existing.status === DEV_SERVER_STATES.RUNNING || existing.status === DEV_SERVER_STATES.STARTING) {
        return existing
      }
    }

    const record = {
      processId: serverId,
      command,
      cwd: cwd || '.',
      status: DEV_SERVER_STATES.STARTING,
      port: null,
      startedAt: Date.now(),
      exitedAt: null,
      stdout: [],
      stderr: []
    }

    this.servers.set(serverId, record)
    this.notify({ type: 'server_state_changed', server: record })

    if (api?.startProcess) {
      const res = await api.startProcess({
        command,
        cwd,
        id: serverId
      })

      if (!res.success) {
        record.status = DEV_SERVER_STATES.FAILED
        this.notify({ type: 'server_state_changed', server: record })
        throw new Error(res.error || 'Failed to start dev server process.')
      }

      record.status = DEV_SERVER_STATES.RUNNING
      this.notify({ type: 'server_state_changed', server: record })
    } else {
      // In-memory simulation / test mode
      record.status = DEV_SERVER_STATES.RUNNING
      const detectedPort = extractPort(command)
      if (detectedPort) record.port = detectedPort
      this.notify({ type: 'server_state_changed', server: record })
    }

    return record
  }

  feedOutput(id, stream, chunk) {
    const record = this.servers.get(id)
    if (!record) return

    const text = String(chunk || '')
    if (stream === 'stderr') {
      record.stderr.push(text)
      if (record.stderr.length > 200) record.stderr.shift()
    } else {
      record.stdout.push(text)
      if (record.stdout.length > 200) record.stdout.shift()
    }

    if (!record.port) {
      const port = extractPort(text)
      if (port) {
        record.port = port
        record.status = DEV_SERVER_STATES.RUNNING
        this.notify({ type: 'port_detected', server: record, port })
      }
    }

    this.notify({ type: 'output', serverId: id, stream, text })
  }

  async inspectDevServer(id) {
    const record = this.servers.get(id)
    if (!record) return { found: false, server: null }

    const api = this.getApi()
    if (api?.getProcess) {
      const res = await api.getProcess(id)
      if (res.success && res.process) {
        record.status = res.process.status?.toUpperCase() || record.status
        if (Array.isArray(res.process.output)) {
          for (const item of res.process.output) {
            if (!record.port) {
              const p = extractPort(item.text)
              if (p) record.port = p
            }
          }
        }
      }
    }

    return { found: true, server: record }
  }

  async stopDevServer(id) {
    const record = this.servers.get(id)
    if (!record) return { success: false, error: 'Server not found' }

    record.status = DEV_SERVER_STATES.STOPPING
    this.notify({ type: 'server_state_changed', server: record })

    const api = this.getApi()
    if (api?.stopProcess) {
      await api.stopProcess(id)
    }

    record.status = DEV_SERVER_STATES.STOPPED
    record.exitedAt = Date.now()
    this.notify({ type: 'server_state_changed', server: record })

    return { success: true, server: record }
  }

  async restartDevServer(id) {
    const record = this.servers.get(id)
    if (!record) throw new Error(`Dev server ${id} not found.`)

    await this.stopDevServer(id)
    return this.startDevServer({
      command: record.command,
      cwd: record.cwd,
      id: record.processId
    })
  }

  listDevServers() {
    return [...this.servers.values()]
  }

  addListener(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify(event) {
    for (const listener of this.listeners) {
      try { listener(event) } catch (err) { console.warn('[DevServerManager] Listener error:', err) }
    }
  }
}

export const devServerManager = new DevServerManager()
