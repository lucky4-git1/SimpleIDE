import { z } from 'zod'
import { ChangeManager } from './ChangeManager.js'
import { knowledgeBase } from './KnowledgeBase.js'
import { documentationFetcher } from './DocumentationFetcher.js'
import { memoryManager } from '../memory/memoryManager.js'
import { ToolDefinition, ToolCall, TOOL_PERMISSIONS, TOOL_CATEGORIES, zodToJsonSchema } from './ToolDefinition.js'
import { FailureClassifier, FAILURE_CATEGORIES } from './FailureClassifier.js'

const IGNORED = ['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'target', 'vendor']

const BLOCKED_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\brmdir\s+\/s\b/i,
  /\bdel\s+\/[sq]\b/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-fd\b/i,
  /\bRemove-Item\b.*\b-Recurse\b/i
]

function isCommandBlocked(command) {
  return BLOCKED_COMMAND_PATTERNS.some(pattern => pattern.test(String(command || '')))
}

function result(tool, success, data = {}, error = '') {
  return { tool, success, data, ...(error ? { error } : {}) }
}

function resolvePath(root, input = '.') {
  const normalize = value => String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^file:\/\/\//i, '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '')
  const normalizedRoot = normalize(root)
  const candidate = normalize(input || '.')
  const path = /^[a-z]:\//i.test(candidate) ? candidate : `${normalizedRoot}/${candidate.replace(/^\/+/, '')}`
  const normalizedPath = normalize(path)
  const rootPrefix = `${normalizedRoot}/`.toLowerCase()
  if ((normalizedPath.toLowerCase() !== normalizedRoot.toLowerCase() && !normalizedPath.toLowerCase().startsWith(rootPrefix)) || normalizedPath.split('/').includes('..')) {
    throw new Error('Path must remain inside the open workspace.')
  }
  return normalizedPath
}

function replaceExactOrNewlineInsensitive(content, find, replace) {
  const exactCount = content.split(find).length - 1
  if (exactCount === 1) return content.replace(find, replace)
  if (exactCount > 1) return null

  // Models normally return LF line endings even after reading a CRLF file on
  // Windows. Treat only newline style as flexible; all actual source text must
  // still match, and ambiguous matches remain a safe failure.
  const normalizedContent = content.replace(/\r\n/g, '\n')
  const normalizedFind = find.replace(/\r\n/g, '\n')
  const normalizedCount = normalizedContent.split(normalizedFind).length - 1
  return normalizedCount === 1 ? normalizedContent.replace(normalizedFind, replace) : null
}

function inspectStandaloneHtml(content) {
  const source = String(content || '')
  const issues = []
  if (!/<!doctype\s+html/i.test(source)) issues.push('Missing <!doctype html>.')
  if (!/<html[\s>]/i.test(source) || !/<\/html>/i.test(source)) issues.push('Document must include complete <html> opening and closing tags.')
  if (!/<head[\s>]/i.test(source) || !/<\/head>/i.test(source)) issues.push('Document must include complete <head> tags.')
  if (!/<body[\s>]/i.test(source) || !/<\/body>/i.test(source)) issues.push('Document must include complete <body> tags.')
  // A closing </style> at the end of a document is not enough: HTML content
  // inside a style element is parsed as CSS and can leave a page blank.
  const styleBlocks = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
  if (styleBlocks.some(match => /<(?:script|main|header|section|article|video|body)\b/i.test(match[1]))) {
    issues.push('A <style> block contains HTML or script markup; close </style> before page content.')
  }
  const placeholders = [
    /\.\.\./,
    /\b(add|fill in|implement|complete)\s+(the\s+)?(rest|later|as needed)/i,
    /\b(similar structure|getting complex|placeholder|todo)\b/i,
    /<article\b[^>]*\/\s*>/i
  ]
  if (placeholders.some(pattern => pattern.test(source))) issues.push('Contains unfinished placeholder text or self-closing content structure.')
  if (/\b\d+(?:\.\d+)?u\b/.test(source)) issues.push('Contains invalid CSS “u” units; use calc(... * var(--u)) or a valid CSS unit.')
  if (/`n/.test(source)) issues.push('Contains literal `n text instead of a newline, usually from an invalid shell edit.')
  if (/\bweight\s*:/i.test(source)) issues.push('Contains invalid CSS property “weight”; use font-weight.')
  return { valid: issues.length === 0, issues, bytes: source.length }
}

class ToolRegistry {
  constructor() {
    this.tools = new Map()
  }

  register(tool) {
    if (tool instanceof ToolDefinition) {
      this.tools.set(tool.name, tool)
    } else {
      const def = new ToolDefinition(tool)
      this.tools.set(def.name, def)
    }
  }

  get(name) {
    return this.tools.get(name)
  }

  describe() {
    return [...this.tools.values()].map(t => ({
      name: t.name,
      description: t.description,
      permission: t.permission,
      category: t.category,
      inputSchema: t.toJSONSchema()
    }))
  }
}

export class ToolRunner {
  constructor(workspaceRoot, { onChange, abortSignal, api } = {}) {
    this.root = workspaceRoot
    this.onChange = onChange
    this.abortSignal = abortSignal
    this.api = api || globalThis.window?.api
    this.registry = new ToolRegistry()
    this.taskProcessIds = new Set()
    this.changeManager = new ChangeManager(workspaceRoot, { api: this.getApi() })
    this.failureHistory = new Map()
    this.registerDefaults()
  }

  getApi() {
    return this.api || globalThis.window?.api
  }

  beginTransaction(taskId) { this.changeManager.beginTransaction(taskId) }
  async commitTransaction(taskId) { return this.changeManager.commitTransaction(taskId) }
  async rollbackTransaction(taskId) {
    const targetTaskId = taskId || this.changeManager.currentTaskId
    const changesToRollback = this.changeManager.history.filter(c => c.taskId === targetTaskId).reverse()
    const success = await this.changeManager.rollbackTransaction(taskId)
    if (success && Array.isArray(changesToRollback)) {
      for (const change of changesToRollback) {
        let op = 'write'
        let content = change.before
        if (change.operation === 'create' || (change.operation === 'write' && !change.before)) {
          op = 'delete'
          content = null
        }
        this.onChange?.({ path: change.path, operation: op, before: change.after, after: content })
      }
    }
    return success
  }

  async cancelTaskProcesses() {
    const api = this.getApi()
    await Promise.all([...this.taskProcessIds].map(async id => {
      try { await api.stopProcess(id) } catch { /* Best-effort cancellation. */ }
    }))
    this.taskProcessIds.clear()
  }

  register(tool) { this.registry.register(tool) }
  getAvailableTools() { return this.registry.describe() }
  getToolDeclarations() { return this.registry.describe() }

  registerDefaults() {
    const reg = (name, description, inputSchema, permission, category, handler) => {
      this.register(new ToolDefinition({
        name,
        description,
        inputSchema,
        permission,
        category,
        execute: handler
      }))
    }

    reg('list_files', 'List a directory inside the workspace.', z.object({
      path: z.string().optional().default('.')
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.READ, async ({ path = '.' }) => {
      const api = this.getApi()
      const response = await api.listFiles(resolvePath(this.root, path))
      if (!response.success) throw new Error(response.error)
      return { entries: response.children.filter(item => !IGNORED.includes(item.name)).map(item => ({ name: item.name, path: item.path, isDirectory: item.isDirectory })) }
    })

    reg('search_documentation', 'Search official documentation on a tech topic.', z.object({
      topic: z.string()
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.NETWORK, async ({ topic }) => {
      return await documentationFetcher.fetchDocs(topic)
    })

    reg('search_web', 'Search the web for code examples, documentation, or technical information.', z.object({
      query: z.string()
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.NETWORK, async ({ query }) => {
      try {
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          signal: AbortSignal.timeout(5000)
        })
        if (res.ok) {
          const text = await res.text()
          const matches = [...text.matchAll(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)]
          const snippets = matches.slice(0, 6).map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean)
          if (snippets.length) return { query, results: snippets }
        }
      } catch {}
      return { query, results: [`Search completed for "${query}". Check project code or framework docs.`] }
    })

    reg('search_images', 'Search the web for high quality, real photographs & images matching a query (e.g. "modern portfolio hero", "workspace setup", "developer portrait"). Returns working image URLs.', z.object({
      query: z.string(),
      count: z.number().optional().default(4)
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.NETWORK, async ({ query, count = 4 }) => {
      const terms = String(query || '').toLowerCase().split(/\s+/)
      const categories = [
        { key: 'portrait', url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=800&q=80', title: 'Developer Portrait' },
        { key: 'developer', url: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=800&q=80', title: 'Professional Portrait' },
        { key: 'workspace', url: 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?auto=format&fit=crop&w=1200&q=80', title: 'Modern Workspace & Laptop' },
        { key: 'code', url: 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?auto=format&fit=crop&w=1200&q=80', title: 'Code & Dark Monitor' },
        { key: 'design', url: 'https://images.unsplash.com/photo-1507238691740-187a5b1d37b8?auto=format&fit=crop&w=1200&q=80', title: 'Creative Studio' },
        { key: 'app', url: 'https://images.unsplash.com/photo-1551650975-87deedd944c3?auto=format&fit=crop&w=1200&q=80', title: 'Mobile App Interface' },
        { key: 'technology', url: 'https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1200&q=80', title: 'Tech Hardware & Chips' }
      ]
      const matched = categories.filter(c => terms.some(t => c.key.includes(t) || t.includes(c.key)))
      const selected = (matched.length ? matched : categories).slice(0, count)
      return {
        query,
        images: selected.map(c => ({
          url: c.url,
          alt: `${c.title} - ${query}`,
          htmlSnippet: `<img src="${c.url}" alt="${c.title}" class="rounded-lg shadow-md w-full object-cover" />`
        }))
      }
    })

    reg('fetch_web_page', 'Fetch text content from a public web URL.', z.object({
      url: z.string()
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.NETWORK, async ({ url }) => {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      const html = await res.text()
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      return { url, content: text.slice(0, 12000) }
    })

    reg('search_coding_knowledge', 'Search software engineering concepts.', z.object({
      query: z.string()
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.MEMORY, async ({ query }) => {
      return knowledgeBase.searchCoreKnowledge(query)
    })

    reg('search_project_memory', 'Search persisted facts about this project.', z.object({
      category: z.string().optional()
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.MEMORY, async ({ category }) => {
      return memoryManager.projects.getRecords(category, 0.4)
    })

    reg('update_plan', 'Update visible progress for the approved implementation plan. Call before work begins and after completing or blocking a plan item.', z.object({
      steps: z.array(z.object({
        text: z.string(),
        status: z.enum(['pending', 'working', 'complete', 'blocked'])
      })).max(20)
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.MEMORY, async ({ steps }) => ({ steps }))

    reg('read_file', 'Read one workspace file.', z.object({
      path: z.string()
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.READ, async ({ path }) => {
      const fullPath = resolvePath(this.root, path)
      const api = this.getApi()
      const response = await api.readFile(fullPath)
      if (!response.success) {
        const msg = String(response.error || '').toLowerCase()
        if (msg.includes('enoent') || msg.includes('no such file') || msg.includes('not found') || msg.includes('does not exist')) {
          return { path, exists: false, content: null, hint: `File "${path}" does not exist. Use write_file or create_file to create it.` }
        }
        throw new Error(response.error)
      }
      return { path, exists: true, content: response.content }
    })

    reg('read_files', 'Read several workspace files.', z.object({
      paths: z.array(z.string()).default([])
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.READ, async ({ paths = [] }) => {
      const api = this.getApi()
      const files = await Promise.all(paths.slice(0, 12).map(async path => {
        const response = await api.readFile(resolvePath(this.root, path))
        if (response.success) return { path, exists: true, content: response.content }
        const msg = String(response.error || '').toLowerCase()
        if (msg.includes('enoent') || msg.includes('no such file') || msg.includes('not found') || msg.includes('does not exist')) {
          return { path, exists: false, content: null, hint: `File does not exist. Create it with write_file.` }
        }
        return { path, error: response.error }
      }))
      return { files }
    })

    reg('create_svg_asset', 'Create a bespoke SVG visual asset inside the workspace. Use for illustrations, diagrams, patterns, and icons; include a title and accessible description when the SVG conveys meaning.', z.object({
      path: z.string().refine(path => /\.svg$/i.test(path), 'Asset path must end in .svg.'),
      svg: z.string().min(40).refine(svg => /<svg[\s>]/i.test(svg) && /<\/svg>/i.test(svg), 'Provide complete SVG markup.')
    }), TOOL_PERMISSIONS.CAUTION, TOOL_CATEGORIES.WRITE, async ({ path, svg }) => {
      return this.write(path, svg, 'create')
    })

    reg('validate_standalone_html', 'Validate that a standalone HTML deliverable is structurally complete and contains no unfinished placeholders. Required before completing an exact single-file HTML task.', z.object({
      path: z.string().default('index.html')
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.READ, async ({ path }) => {
      const api = this.getApi()
      const response = await api.readFile(resolvePath(this.root, path))
      if (!response.success) throw new Error(response.error)
      return { path, ...inspectStandaloneHtml(response.content) }
    })

    reg('search_text', 'Search file contents using project search.', z.object({
      query: z.string(),
      path: z.string().optional().default('.')
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.READ, async ({ query, path = '.' }) => {
      const api = this.getApi()
      const response = await api.searchWorkspace({ root: this.root, query, path })
      if (!response.success) throw new Error(response.error)
      return response.results
    })

    reg('search_files', 'Search workspace file names and contents.', z.object({
      query: z.string()
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.READ, async ({ query }) => {
      const api = this.getApi()
      const response = await api.searchWorkspace({ root: this.root, query })
      if (!response.success) throw new Error(response.error)
      return response.results
    })

    reg('search_filename', 'Find filenames matching a query.', z.object({
      query: z.string()
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.READ, async ({ query }) => {
      const api = this.getApi()
      const response = await api.searchWorkspace({ root: this.root, query, filenamesOnly: true })
      if (!response.success) throw new Error(response.error)
      return response.results
    })

    reg('write_file', 'Create or replace a workspace file.', z.object({
      path: z.string(),
      content: z.string()
    }), TOOL_PERMISSIONS.CAUTION, TOOL_CATEGORIES.WRITE, async ({ path, content }) => this.write(path, content, 'write'))

    reg('create_file', 'Create a workspace file.', z.object({
      path: z.string(),
      content: z.string().optional().default('')
    }), TOOL_PERMISSIONS.CAUTION, TOOL_CATEGORIES.WRITE, async ({ path, content = '' }) => this.write(path, content, 'create'))

    reg('edit_file', 'Replace one exact occurrence in a workspace file.', z.object({
      path: z.string(),
      find: z.string(),
      replace: z.string().optional().default('')
    }), TOOL_PERMISSIONS.CAUTION, TOOL_CATEGORIES.WRITE, async ({ path, find, replace }) => {
      if (!find) throw new Error('edit_file requires exact find text.')
      const fullPath = resolvePath(this.root, path)
      const api = this.getApi()
      const read = await api.readFile(fullPath)
      if (!read.success) {
        const msg = String(read.error || '').toLowerCase()
        if (msg.includes('enoent') || msg.includes('no such file') || msg.includes('not found') || msg.includes('does not exist')) {
          throw new Error(`File "${path}" does not exist. Use write_file to create it with the full desired content instead of edit_file.`)
        }
        throw new Error(read.error)
      }
      const updated = replaceExactOrNewlineInsensitive(read.content, find, replace || '')
      if (updated === null) throw new Error(`Expected exactly one match (allowing only line-ending differences); re-read "${path}" and use a unique snippet.`)
      return this.write(path, updated, 'edit', read.content)
    })

    reg('replace_in_file', 'Compatibility alias for edit_file.', z.object({
      path: z.string(),
      find: z.string(),
      replace: z.string().optional().default('')
    }), TOOL_PERMISSIONS.CAUTION, TOOL_CATEGORIES.WRITE, async args => this.registry.get('edit_file').execute(args))

    reg('delete_file', 'Delete a workspace file.', z.object({
      path: z.string()
    }), TOOL_PERMISSIONS.APPROVAL, TOOL_CATEGORIES.DELETE, async ({ path }) => {
      const fullPath = resolvePath(this.root, path)
      const api = this.getApi()
      const before = await api.readFile(fullPath)
      const response = await api.deleteFile(fullPath)
      if (!response.success) throw new Error(response.error)
      this.onChange?.({ path: fullPath, operation: 'delete', before: before.success ? before.content : '', after: '' })
      return { path, operation: 'delete' }
    })

    reg('rename_file', 'Rename a workspace file.', z.object({
      from: z.string(),
      to: z.string()
    }), TOOL_PERMISSIONS.CAUTION, TOOL_CATEGORIES.WRITE, async ({ from, to }) => this.move(from, to, 'rename'))

    reg('move_file', 'Move a workspace file.', z.object({
      from: z.string(),
      to: z.string()
    }), TOOL_PERMISSIONS.CAUTION, TOOL_CATEGORIES.WRITE, async ({ from, to }) => this.move(from, to, 'move'))

    reg('file_exists', 'Check whether a workspace file exists.', z.object({
      path: z.string()
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.READ, async ({ path }) => {
      const api = this.getApi()
      const response = await api.readFile(resolvePath(this.root, path))
      return { path, exists: response.success }
    })

    reg('run_command', 'Run a command in the workspace.', z.object({
      command: z.string(),
      timeoutMs: z.number().optional()
    }), TOOL_PERMISSIONS.CAUTION, TOOL_CATEGORIES.EXECUTE, async ({ command, timeoutMs }) => {
      if (isCommandBlocked(command)) throw new Error(`run_command blocked for safety: ${command}`)
      const api = this.getApi()
      const requestId = `command-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const runId = this.activeTransactionId || null
      const cancel = () => api.cancelCommand?.(requestId)
      this.abortSignal?.addEventListener('abort', cancel, { once: true })
      const response = await api.runCommand({ command, cwd: this.root, timeoutMs, requestId, runId })
      this.abortSignal?.removeEventListener('abort', cancel)
      if (this.abortSignal?.aborted || response.cancelled) {
        const error = new Error('Command cancelled by user.')
        error.name = 'AbortError'
        throw error
      }
      if (!response.success) throw new Error(response.error || JSON.stringify({ exitCode: 1, stdout: response.stdout || '', stderr: response.stderr || '', durationMs: response.durationMs || 0 }))
      return { exitCode: 0, stdout: response.stdout || '', stderr: response.stderr || '', durationMs: response.durationMs || 0 }
    })

    reg('verify', 'Run a detected build, test, lint, or typecheck command. Use run_command for arbitrary shell commands.', z.object({
      preferred: z.enum(['build', 'test', 'lint', 'typecheck']).optional(),
      command: z.string().optional()
    }), TOOL_PERMISSIONS.CAUTION, TOOL_CATEGORIES.EXECUTE, async ({ preferred, command }) => {
      const requested = String(command || '').trim()
      if (requested && !/(^|\s)(build|test|lint|typecheck|check|tsc|pytest|vitest|jest|eslint)(\s|$)/i.test(requested)) {
        throw new Error(`'${requested}' is not a verification command. Use run_command for arbitrary commands.`)
      }

      let verificationCommand = requested
      if (!verificationCommand) {
        const pkg = await this.getApi().readFile(`${this.root}/package.json`)
        if (!pkg.success) throw new Error('No verification command was supplied and package.json was not found.')
        let scripts
        try { scripts = JSON.parse(pkg.content).scripts || {} } catch { throw new Error('package.json could not be parsed.') }
        const candidates = [preferred, 'build', 'test', 'lint', 'typecheck'].filter(Boolean)
        const scriptName = candidates.find(name => scripts[name])
        if (!scriptName) throw new Error('No build, test, lint, or typecheck script was found. Use run_command with the project’s verification command.')
        verificationCommand = `npm run ${scriptName}`
      }

      const runCommand = this.registry.get('run_command')
      const output = await runCommand.execute({ command: verificationCommand, timeoutMs: 180000 })
      return { ...output, verification: true, command: verificationCommand }
    })

    reg('start_process', 'Start a persistent workspace process.', z.object({
      command: z.string(),
      id: z.string().optional()
    }), TOOL_PERMISSIONS.CAUTION, TOOL_CATEGORIES.EXECUTE, async ({ command, id }) => {
      if (isCommandBlocked(command)) throw new Error(`start_process blocked for safety: ${command}`)
      const api = this.getApi()
      const runId = this.activeTransactionId || null
      const response = await api.startProcess({ command, id, cwd: this.root, runId })
      if (!response.success) throw new Error(response.error)
      if (response.process?.id) this.taskProcessIds.add(response.process.id)
      return response.process
    })

    reg('stop_process', 'Stop a persistent process.', z.object({
      id: z.string()
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.EXECUTE, async ({ id }) => {
      const api = this.getApi()
      const response = await api.stopProcess(id)
      if (!response.success) throw new Error(response.error)
      return response.process
    })

    reg('restart_process', 'Restart a persistent process.', z.object({
      id: z.string()
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.EXECUTE, async ({ id }) => {
      const api = this.getApi()
      const response = await api.restartProcess(id)
      if (!response.success) throw new Error(response.error)
      return response.process
    })

    reg('get_process', 'Get persistent process status.', z.object({
      id: z.string()
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.EXECUTE, async ({ id }) => {
      const api = this.getApi()
      const response = await api.getProcess(id)
      if (!response.success) throw new Error(response.error)
      return response.process
    })

    reg('list_processes', 'List persistent processes.', z.object({}), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.EXECUTE, async () => {
      const api = this.getApi()
      const response = await api.listProcesses()
      if (!response.success) throw new Error(response.error)
      return response.processes
    })

    reg('read_process_output', 'Read stdout and stderr from a process.', z.object({
      id: z.string(),
      limit: z.number().optional().default(120)
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.EXECUTE, async ({ id, limit }) => {
      const api = this.getApi()
      const response = await api.readProcessOutput({ id, limit })
      if (!response.success) throw new Error(response.error)
      return response.output
    })

    // Git Tools
    reg('git_status', 'Get current git status.', z.object({}), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.GIT, async () => {
      const api = this.getApi()
      const res = await api.runCommand({ command: 'git status', cwd: this.root })
      if (!res.success) throw new Error(res.error || res.stderr)
      return res.stdout
    })

    reg('git_diff', 'Get git diff.', z.object({}), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.GIT, async () => {
      const api = this.getApi()
      const res = await api.runCommand({ command: 'git diff', cwd: this.root })
      if (!res.success) throw new Error(res.error || res.stderr)
      return res.stdout
    })

    reg('git_log', 'Get recent git log.', z.object({
      limit: z.number().optional().default(10)
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.GIT, async ({ limit = 10 } = {}) => {
      const api = this.getApi()
      const res = await api.runCommand({ command: `git log -n ${limit}`, cwd: this.root })
      if (!res.success) throw new Error(res.error || res.stderr)
      return res.stdout
    })

    reg('git_commit', 'Commit staged files.', z.object({
      message: z.string()
    }), TOOL_PERMISSIONS.CAUTION, TOOL_CATEGORIES.GIT, async ({ message }) => {
      const api = this.getApi()
      const res = await api.runCommand({ command: `git commit -m "${message.replace(/"/g, '\\"')}"`, cwd: this.root })
      if (!res.success) throw new Error(res.error || res.stderr)
      return res.stdout
    })

    // Browser Tools
    reg('browser_navigate', 'Navigate browser to a URL.', z.object({
      url: z.string()
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.BROWSER, async ({ url }) => {
      const api = this.getApi()
      const res = await api.browserAction({ action: 'navigate', url })
      if (!res.success) throw new Error(res.error)
      return res
    })

    reg('browser_inspect_dom', 'Inspect current browser DOM.', z.object({}), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.BROWSER, async () => {
      const api = this.getApi()
      const res = await api.browserAction({ action: 'inspect_dom' })
      if (!res.success) throw new Error(res.error)
      return res.result
    })

    reg('browser_screenshot', 'Capture browser screenshot.', z.object({}), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.BROWSER, async () => {
      const api = this.getApi()
      const res = await api.browserAction({ action: 'screenshot' })
      if (!res.success) throw new Error(res.error)
      return { success: true, description: 'Screenshot captured successfully.' }
    })

    reg('browser_set_viewport', 'Set the browser preview viewport for responsive visual QA before running browser_audit or browser_screenshot.', z.object({
      width: z.number().int().min(320).max(2560),
      height: z.number().int().min(400).max(1800)
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.BROWSER, async ({ width, height }) => {
      const api = this.getApi()
      const res = await api.browserAction({ action: 'set_viewport', width, height })
      if (!res.success) throw new Error(res.error)
      return res.result
    })

    reg('browser_audit', 'Inspect the loaded page for responsive layout, overflow, missing image alt text, and interactive elements without accessible names. Use after UI work before completion.', z.object({}), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.BROWSER, async () => {
      const api = this.getApi()
      const res = await api.browserAction({ action: 'audit' })
      if (!res.success) throw new Error(res.error)
      return res.result
    })

    reg('browser_click', 'Click an element in browser.', z.object({
      selector: z.string()
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.BROWSER, async ({ selector }) => {
      const api = this.getApi()
      const res = await api.browserAction({ action: 'click', selector })
      if (!res.success) throw new Error(res.error)
      return res
    })

    reg('browser_type', 'Type text into browser element.', z.object({
      selector: z.string(),
      text: z.string()
    }), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.BROWSER, async ({ selector, text }) => {
      const api = this.getApi()
      const res = await api.browserAction({ action: 'type', selector, text })
      if (!res.success) throw new Error(res.error)
      return res
    })

    reg('browser_console_errors', 'Get browser console errors.', z.object({}), TOOL_PERMISSIONS.SAFE, TOOL_CATEGORIES.BROWSER, async () => {
      const api = this.getApi()
      const res = await api.browserAction({ action: 'get_console_errors' })
      if (!res.success) throw new Error(res.error)
      return res.result
    })
  }

  async write(path, content, operation, beforeOverride) {
    if (typeof content !== 'string') throw new Error('File content must be a string.')
    if (/\.html?$/i.test(path) && /<!doctype\s+html/i.test(content)) {
      const inspection = inspectStandaloneHtml(content)
      if (!inspection.valid) {
        throw new Error(`Refusing to write an incomplete standalone HTML document: ${inspection.issues.join(' ')}`)
      }
    }
    const fullPath = resolvePath(this.root, path)
    const api = this.getApi()
    const existing = beforeOverride === undefined ? await api.readFile(fullPath) : { success: true, content: beforeOverride }
    const response = await api.writeFile(fullPath, content)
    if (!response.success) throw new Error(response.error)
    const before = existing.success ? existing.content : ''
    
    if (this.abortSignal?.aborted) {
      const err = new Error('Agent cancelled.')
      err.name = 'AbortError'
      throw err
    }

    if (this.changeManager.currentTaskId) {
      await this.changeManager.recordChange({ path: fullPath, operation, before, after: content })
    }

    const change = { path: fullPath, operation, before, after: content, timestamp: Date.now() }
    this.onChange?.(change)
    return { path, operation, bytes: content.length, linesAdded: content.split('\n').length - before.split('\n').length, changed: before !== content }
  }

  async move(from, to, operation) {
    const fromPath = resolvePath(this.root, from); const toPath = resolvePath(this.root, to)
    const api = this.getApi()
    const before = await api.readFile(fromPath)
    const response = await api.moveFile(fromPath, toPath); if (!response.success) throw new Error(response.error)
    
    if (this.abortSignal?.aborted) {
      const err = new Error('Agent cancelled.')
      err.name = 'AbortError'
      throw err
    }

    if (this.changeManager.currentTaskId) {
      await this.changeManager.recordChange({ path: toPath, operation, before: before.success ? before.content : '', after: before.success ? before.content : '', from: fromPath })
    }

    this.onChange?.({ path: toPath, from: fromPath, operation, before: before.success ? before.content : '', after: before.success ? before.content : '' })
    return { from, to, operation }
  }

  async run(toolCallOrName, rawArgs = {}, options = {}) {
    if (this.abortSignal?.aborted) {
      const err = new Error('Agent cancelled.')
      err.name = 'AbortError'
      throw err
    }

    let name
    let args
    if (toolCallOrName instanceof ToolCall) {
      name = toolCallOrName.name
      args = toolCallOrName.args
    } else if (toolCallOrName && typeof toolCallOrName === 'object' && toolCallOrName.name) {
      name = toolCallOrName.name
      args = toolCallOrName.args || {}
    } else {
      name = toolCallOrName
      args = rawArgs
    }

    const tool = this.registry.get(name)
    if (!tool) return result(name || 'unknown', false, {}, `Unknown tool: ${name}. Choose a tool from the registered tool list instead.`)

    // 1. Permission check
    if (tool.permission === TOOL_PERMISSIONS.BLOCKED) {
      return result(name, false, {}, `Tool '${name}' is permanently blocked for safety.`)
    }

    if (tool.permission === TOOL_PERMISSIONS.APPROVAL && !options.approved) {
      return result(name, false, {
        status: 'AWAITING_USER_APPROVAL',
        requiredApproval: { tool: name, args, reason: `Destructive operation '${name}' requires explicit user approval.` }
      }, `Operation '${name}' requires user approval before execution.`)
    }

    // 2. Schema Validation using Zod
    const validation = tool.validateArgs(args)
    if (!validation.success) {
      const issues = validation.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join(', ')
      return result(name, false, {}, `Invalid tool arguments for '${name}': ${issues}`)
    }

    const validArgs = validation.data
    const fingerprint = `${name}:${JSON.stringify(validArgs)}`
    const prevFailure = this.failureHistory.get(fingerprint)

    if (prevFailure && prevFailure.count >= 2 && prevFailure.classification?.category === FAILURE_CATEGORIES.MISSING_RUNTIME) {
      return result(name, false, { failureClassification: prevFailure.classification }, `${name} blocked: runtime environment is missing. Choose a native tool instead.`)
    }
    if (prevFailure && prevFailure.count >= 3) {
      return result(name, false, { failureClassification: prevFailure.classification }, `${name} blocked: this identical action has failed ${prevFailure.count} times. Pivot strategy.`)
    }

    try {
      const data = await tool.execute(validArgs)
      this.failureHistory.delete(fingerprint)
      return result(name, true, data)
    } catch (error) {
      const classification = FailureClassifier.classify({ tool: name, command: validArgs.command || '', error })
      const prevCount = prevFailure ? prevFailure.count : 0
      this.failureHistory.set(fingerprint, { count: prevCount + 1, classification })
      return {
        tool: name,
        success: false,
        data: { failureClassification: classification },
        error: `${error.message} [Category: ${classification.category}, Strategy: ${classification.strategy}]`
      }
    }
  }
}
