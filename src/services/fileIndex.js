/**
 * Simple file indexing for codebase awareness
 */

export async function buildFileIndex(rootPath) {
  if (!rootPath) return []

  const index = []
  const ignoredDirectories = new Set([
    'node_modules',
    '.git',
    'dist',
    'dist-electron',
    'dist-release',
    'release',
    '.next',
    'coverage'
  ])
  const ignoredExtensions = new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'pdf',
    'zip',
    'exe',
    'dll',
    'so',
    'dylib',
    'ico',
    'woff',
    'woff2',
    'ttf',
    'eot',
    'asar',
    'pak'
  ])
  
  async function traverse(dirPath) {
    const result = await window.api.listFiles(dirPath)
    if (!result.success) return

    const nodes = result.children || []
    for (const node of nodes) {
      if (node.isDirectory) {
        if (ignoredDirectories.has(node.name)) continue
        await traverse(node.path)
      } else {
        const ext = node.name.includes('.') ? node.name.split('.').pop().toLowerCase() : ''
        if (ignoredExtensions.has(ext)) continue

        try {
          const contentResult = await window.api.readFile(node.path)
          if (contentResult.success && contentResult.content.length <= 300000) {
            index.push({
              path: node.path,
              name: node.name,
              content: contentResult.content,
              size: contentResult.content.length
            })
          }
        } catch (e) {
          console.error(`Failed to index file: ${node.path}`, e)
        }
      }
    }
  }

  await traverse(rootPath)
  return index
}

export function getProjectSummary(index) {
  if (!index || index.length === 0) return ""

  let summary = "Project Structure and Content Summary:\n\n"
  
  // Group by folders for a cleaner overview
  const files = index.slice(0, 50) // Limit to 50 files for context window
  
  files.forEach(file => {
    summary += `File: ${file.path}\n`
    summary += `Content (first 300 chars):\n${file.content.substring(0, 300)}...\n`
    summary += `-------------------\n`
  })

  return summary
}

function findIndexedFile(index, fileName) {
  return (index || []).find(file => file.name?.toLowerCase() === fileName.toLowerCase())
}

function parsePackageManifest(index) {
  const packageFile = findIndexedFile(index, 'package.json')
  if (!packageFile?.content) return null
  try {
    return JSON.parse(packageFile.content)
  } catch {
    return null
  }
}

function hasDependency(manifest, name) {
  return Boolean(manifest?.dependencies?.[name] || manifest?.devDependencies?.[name])
}

function packageManagerFor(index) {
  if (findIndexedFile(index, 'pnpm-lock.yaml')) return 'pnpm'
  if (findIndexedFile(index, 'yarn.lock')) return 'yarn'
  return 'npm'
}

function buildPackageCommand(packageManager, script) {
  if (packageManager === 'yarn') return `yarn ${script}`
  return `${packageManager} run ${script}`
}

/**
 * Derives deterministic workspace facts used by the agent before it asks a model
 * to reason about a task. This deliberately prefers real project files over
 * provider-generated guesses.
 */
export function getWorkspaceProfile(index = []) {
  const names = new Set(index.map(file => file.name?.toLowerCase()))
  const manifest = parsePackageManifest(index)
  const packageManager = packageManagerFor(index)
  const scripts = manifest?.scripts || {}
  const hasHtml = index.some(file => /\.html?$/i.test(file.name || ''))
  const hasCss = index.some(file => /\.css$/i.test(file.name || ''))
  const hasJavaScript = index.some(file => /\.(?:[cm]?js|jsx|ts|tsx)$/i.test(file.name || ''))

  if (!manifest && hasHtml) {
    return {
      kind: 'static-web',
      label: 'Static HTML/CSS/JavaScript site',
      packageManager: null,
      scripts: {},
      verification: {
        kind: 'source-review',
        command: null,
        description: 'Re-read changed source files, then use the IDE Live Preview for visual validation. Do not run npm or a dev server.'
      },
      facts: [hasCss ? 'CSS stylesheets present' : 'No stylesheet detected', hasJavaScript ? 'JavaScript files present' : 'No JavaScript files detected']
    }
  }

  if (manifest) {
    const framework = hasDependency(manifest, 'next')
      ? 'Next.js'
      : hasDependency(manifest, 'vite')
        ? 'Vite'
        : hasDependency(manifest, '@vue/cli-service') || hasDependency(manifest, 'vue')
          ? 'Vue'
          : hasDependency(manifest, 'react')
            ? 'React'
            : 'Node.js'
    const isElectron = hasDependency(manifest, 'electron')
    const verificationScript = scripts.build ? 'build' : scripts.lint ? 'lint' : scripts.test ? 'test' : null

    return {
      kind: isElectron ? 'electron' : 'node-web',
      label: isElectron ? `Electron + ${framework}` : framework,
      packageManager,
      scripts,
      verification: verificationScript
        ? {
            kind: 'command',
            command: buildPackageCommand(packageManager, verificationScript),
            description: `Run the ${verificationScript} script after a relevant change. Never use the long-running dev script as verification.`
          }
        : {
            kind: 'source-review',
            command: null,
            description: 'No build, lint, or test script is defined. Re-read changed files and state that no automated verification is available.'
          },
      facts: [
        `package manager: ${packageManager}`,
        `scripts: ${Object.keys(scripts).join(', ') || 'none'}`,
        hasHtml ? 'HTML entry points present' : 'No HTML entry point indexed'
      ]
    }
  }

  if (names.has('pyproject.toml') || names.has('requirements.txt')) {
    return {
      kind: 'python',
      label: 'Python project',
      packageManager: null,
      scripts: {},
      verification: { kind: 'source-review', command: null, description: 'No project test command was detected. Inspect changed files and ask before installing or running project-specific tools.' },
      facts: ['Python project files detected']
    }
  }

  if (names.has('cargo.toml')) {
    return {
      kind: 'rust',
      label: 'Rust project',
      packageManager: 'cargo',
      scripts: {},
      verification: { kind: 'command', command: 'cargo check', description: 'Use cargo check for a fast verification pass.' },
      facts: ['Cargo manifest detected']
    }
  }

  return {
    kind: 'unknown',
    label: 'Unclassified workspace',
    packageManager: null,
    scripts: {},
    verification: { kind: 'source-review', command: null, description: 'Inspect the workspace before selecting a command. Do not start a long-running process as verification.' },
    facts: ['No recognized build manifest detected']
  }
}

function queryTerms(query) {
  return [...new Set(String(query || '').toLowerCase().match(/[a-z0-9_/-]{3,}/g) || [])]
}

function excerptFor(content, terms, maxLength = 1800) {
  const lower = content.toLowerCase()
  const firstMatch = terms
    .map(term => lower.indexOf(term))
    .find(index => index >= 0)
  const start = Math.max(0, (firstMatch ?? 0) - 280)
  const excerpt = content.slice(start, start + maxLength)
  return `${start > 0 ? '…' : ''}${excerpt}${start + maxLength < content.length ? '\n…' : ''}`
}

// Lightweight lexical retrieval keeps context local and deterministic. It is used
// as a fallback until an embedding provider is configured, not as fake semantic search.
export function selectRelevantFiles(index, query, { limit = 6, maxChars = 9000 } = {}) {
  const terms = queryTerms(query)
  if (!terms.length) return []

  const ranked = index
    .map(file => {
      const path = `${file.path} ${file.name}`.toLowerCase()
      const content = String(file.content || '').toLowerCase()
      const score = terms.reduce((total, term) => {
        const pathHits = path.split(term).length - 1
        const contentHits = content.split(term).length - 1
        return total + pathHits * 12 + Math.min(contentHits, 20)
      }, 0)
      return { file, score }
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))

  const results = []
  let remaining = maxChars
  for (const { file, score } of ranked) {
    if (results.length >= limit || remaining < 300) break
    const content = excerptFor(String(file.content || ''), terms, Math.min(1800, remaining))
    results.push({ path: file.path, name: file.name, score, content })
    remaining -= content.length
  }
  return results
}
