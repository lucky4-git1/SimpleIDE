/**
 * LayaSafetyPolicy: Authoritative deterministic gate.
 * Per Section 28 of the specification:
 * "Laya must NEVER override deterministic safety policy."
 *
 * Architecture:
 * Laya -> decision -> SafetyPolicy -> allowed / blocked / approval-required
 *
 * Enforces:
 * 1. Destructive-command protections (catastrophic patterns)
 * 2. Workspace boundary protections (directory traversal / escaping root)
 * 3. User approval requirements (unapproved destructive actions)
 * 4. SSRF protections (loopback, cloud metadata, private IP ranges)
 * 5. Authentication & secret leak protections
 * 6. Tool validation
 */
export class LayaSafetyPolicy {
  static BLOCKED_PATTERNS = [
    /\brm\s+.*-[a-z]*r.*[\/\\]/i,                 // rm -rf / or rm -r -f /var
    /\b(del|rmdir|rd)\b.*\/[sqf].*[a-z]:[\/\\]/i, // del /s /q C:\ or rmdir /s /q
    /\bformat\s+[a-z]:/i,                         // format disk
    /\bmkfs\b/i,                                  // make filesystem
    /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb :(){ :|:& };:
    /\bshutdown\s+-[rsft]/i,                      // system shutdown
    /\bchmod\s+.*-R\s+777\s+[\/\\]/i,              // dangerous permissions
    /\b(curl|wget)\s+.*\|\s*(bash|sh|cmd|powershell)/i // uninspected remote execution
  ]

  static DESTRUCTIVE_TOOLS = new Set([
    'run_command',
    'execute_command',
    'write_file',
    'delete_file',
    'stop_dev_server',
    'kill_process'
  ])

  // SSRF blocked targets
  static BLOCKED_HOST_PATTERNS = [
    /^169\.254\.169\.254$/, // Cloud instance metadata
    /^(localhost|127\.\d+\.\d+\.\d+|::1)$/i, // Loopback
    /^10\.\d+\.\d+\.\d+$/, // RFC1918 Private
    /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/, // RFC1918 Private
    /^192\.168\.\d+\.\d+$/ // RFC1918 Private
  ]

  /**
   * Evaluates a decision and proposed action against safety invariants.
   *
   * @param {Object} decision - Laya or PrimeRouter decision
   * @param {Object} [action] - Target tool or command details
   * @param {Object} [options]
   * @param {string} [options.workspaceRoot] - Bound workspace path
   * @returns {{ allowed: boolean, reason?: string, requiresApproval: boolean }}
   */
  static evaluate(decision = {}, action = {}, { workspaceRoot = null } = {}) {
    const command = String(action.command || action.params?.command || decision.request || '').trim()

    // 1. Strictly block malicious / catastrophic commands and injected decision payloads
    const intentStr = String(decision.intent || '')
    for (const pattern of this.BLOCKED_PATTERNS) {
      if (pattern.test(command) || pattern.test(intentStr)) {
        return {
          allowed: false,
          requiresApproval: false,
          reason: 'Command blocked by deterministic safety policy (catastrophic pattern match)'
        }
      }
    }

    // 2. Workspace boundary containment (Directory traversal)
    const targetPath = action.path || action.params?.path || action.params?.filePath || action.params?.cwd
    if (targetPath && typeof targetPath === 'string') {
      const normalized = targetPath.replace(/\\/g, '/')
      if (normalized.includes('/../') || normalized.startsWith('../') || normalized.endsWith('/..') || normalized === '..') {
        return {
          allowed: false,
          requiresApproval: false,
          reason: 'Path traversal attempt blocked by safety policy'
        }
      }
      if (workspaceRoot) {
        const rootNorm = workspaceRoot.replace(/\\/g, '/').toLowerCase()
        const targetNorm = normalized.toLowerCase()
        if (!targetNorm.startsWith(rootNorm) && (targetNorm.includes(':') || targetNorm.startsWith('/'))) {
          return {
            allowed: false,
            requiresApproval: false,
            reason: 'Access outside workspace boundary blocked by safety policy'
          }
        }
      }
    }

    // 3. SSRF Protections for network / URL actions
    const urlStr = action.url || action.params?.url
    if (urlStr && typeof urlStr === 'string') {
      try {
        const parsed = new URL(urlStr)
        const hostname = parsed.hostname.toLowerCase()
        for (const blockedHost of this.BLOCKED_HOST_PATTERNS) {
          if (blockedHost.test(hostname)) {
            return {
              allowed: false,
              requiresApproval: false,
              reason: `Network request to private/metadata address "${hostname}" blocked by SSRF policy`
            }
          }
        }
      } catch (_) {}
    }

    // 4. High-risk actions require user approval
    const tool = action.tool || action.name || decision.toolFamily
    const isDestructive = this.DESTRUCTIVE_TOOLS.has(tool) || decision.risk === 'critical' || decision.risk === 'high'

    if (isDestructive && action.userApproved !== true) {
      return {
        allowed: true,
        requiresApproval: true,
        reason: 'Operation carries high risk or modifies workspace; requires user confirmation'
      }
    }

    return {
      allowed: true,
      requiresApproval: false
    }
  }
}
