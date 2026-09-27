export class VerificationManager {
  constructor(workspaceRoot, runner, { api } = {}) {
    this.root = workspaceRoot
    this.runner = runner
    this.api = api || globalThis.window?.api
  }

  getApi() {
    return this.api || globalThis.window?.api
  }

  async getChecks(scannerState = {}) {
    const checks = []
    const lang = scannerState.language || 'unknown'
    const api = this.getApi()

    // ─── Node.js / JavaScript / TypeScript ───
    if (lang === 'javascript' || lang === 'typescript') {
      if (api) {
        const pkg = await api.readFile(`${this.root}/package.json`)
        if (pkg && pkg.success) {
          try {
            const parsedScripts = JSON.parse(pkg.content).scripts || {}
            if (parsedScripts.lint) checks.push({ id: 'lint', command: 'npm run lint', ecosystem: 'node' })
            if (parsedScripts.typecheck) checks.push({ id: 'typecheck', command: 'npm run typecheck', ecosystem: 'node' })
            if (parsedScripts.test) checks.push({ id: 'test', command: 'npm test', ecosystem: 'node' })
            if (parsedScripts.build) checks.push({ id: 'build', command: 'npm run build', ecosystem: 'node' })
          } catch { /* ignore */ }
        }
      }
    }

    // ─── Python ───
    if (lang === 'python') {
      const testRunner = scannerState.testRunner || 'pytest'
      checks.push({ id: 'test', command: testRunner === 'unittest' ? 'python -m unittest discover' : 'pytest', ecosystem: 'python' })
      if (api) {
        const reqContent = (await api.readFile(`${this.root}/requirements.txt`))?.content || ''
        if (/mypy/i.test(reqContent)) checks.push({ id: 'typecheck', command: 'mypy .', ecosystem: 'python' })
        if (/ruff/i.test(reqContent)) checks.push({ id: 'lint', command: 'ruff check .', ecosystem: 'python' })
        else if (/flake8/i.test(reqContent)) checks.push({ id: 'lint', command: 'flake8 .', ecosystem: 'python' })
      }
    }

    // ─── Go ───
    if (lang === 'go') {
      checks.push({ id: 'build', command: 'go build ./...', ecosystem: 'go' })
      checks.push({ id: 'test', command: 'go test ./...', ecosystem: 'go' })
      checks.push({ id: 'lint', command: 'go vet ./...', ecosystem: 'go' })
    }

    // ─── Rust ───
    if (lang === 'rust') {
      checks.push({ id: 'build', command: 'cargo build', ecosystem: 'rust' })
      checks.push({ id: 'test', command: 'cargo test', ecosystem: 'rust' })
      checks.push({ id: 'lint', command: 'cargo clippy', ecosystem: 'rust' })
    }

    // ─── Java ───
    if (lang === 'java') {
      const bt = scannerState.buildTool || 'maven'
      if (bt === 'maven') {
        checks.push({ id: 'build', command: 'mvn compile', ecosystem: 'java' })
        checks.push({ id: 'test', command: 'mvn test', ecosystem: 'java' })
      } else {
        checks.push({ id: 'build', command: 'gradle build', ecosystem: 'java' })
        checks.push({ id: 'test', command: 'gradle test', ecosystem: 'java' })
      }
    }

    // ─── C# / .NET ───
    if (lang === 'csharp') {
      checks.push({ id: 'build', command: 'dotnet build', ecosystem: 'dotnet' })
      checks.push({ id: 'test', command: 'dotnet test', ecosystem: 'dotnet' })
    }

    // ─── C/C++ ───
    if (lang === 'c/c++') {
      const bt = scannerState.buildTool || 'make'
      if (bt === 'cmake') {
        checks.push({ id: 'build', command: 'cmake --build .', ecosystem: 'cpp' })
      } else {
        checks.push({ id: 'build', command: 'make', ecosystem: 'cpp' })
      }
    }

    return checks
  }

  async isVerificationCommand(command, scannerState = {}) {
    if (!command || typeof command !== 'string') return false
    const trimmed = command.trim()

    // Match against detected project checks
    const checks = await this.getChecks(scannerState)
    if (checks.some(c => c.command === trimmed)) return true

    // Match against standard build/test/lint verification tools
    const verificationPatterns = [
      /^npm\s+(run\s+)?(test|build|lint|typecheck|check)\b/i,
      /^pnpm\s+(run\s+)?(test|build|lint|typecheck|check)\b/i,
      /^yarn\s+(test|build|lint|typecheck|check)\b/i,
      /^npx\s+(tsc|eslint|jest|vitest|mocha)\b/i,
      /^pytest\b/i,
      /^python\d?\s+-m\s+(unittest|pytest)\b/i,
      /^mypy\b/i,
      /^ruff\s+check\b/i,
      /^cargo\s+(test|build|clippy)\b/i,
      /^go\s+(test|build|vet)\b/i,
      /^mvn\s+(test|compile)\b/i,
      /^gradle\s+(test|build)\b/i,
      /^dotnet\s+(test|build)\b/i,
      /^make(\s+test|\s+check)?\b/i
    ]

    return verificationPatterns.some(pattern => pattern.test(trimmed))
  }

  async verify({ preferred, scannerState, runId } = {}) {
    const checks = await this.getChecks(scannerState)
    const selected = preferred ? checks.filter(check => check.id === preferred) : checks.slice(-1)
    if (!selected.length) {
      return {
        attempted: false,
        success: true,
        skipped: true,
        command: '',
        stdout: '',
        stderr: '',
        durationMs: 0,
        results: []
      }
    }
    const results = []
    let lastResult = null
    const api = this.getApi()
    for (const check of selected) {
      const outcome = await this.runner.run('run_command', { command: check.command, timeoutMs: 180000 })
      const resData = outcome.data || {}
      const resItem = {
        id: check.id,
        command: check.command,
        success: outcome.success,
        stdout: resData.stdout || '',
        stderr: resData.stderr || outcome.error || '',
        durationMs: resData.durationMs || 0
      }
      results.push(resItem)

      if (api?.db?.logVerification && runId) {
        try {
          api.db.logVerification({
            runId,
            command: check.command,
            status: outcome.success ? 'passed' : 'failed',
            exitCode: outcome.success ? 0 : 1,
            stdout: resData.stdout || '',
            stderr: resData.stderr || outcome.error || '',
            durationMs: resData.durationMs || 0
          })
        } catch (err) {
          console.warn('[VerificationManager] Failed to log verification to DB:', err?.message)
        }
      }

      lastResult = {
        attempted: true,
        success: outcome.success,
        command: check.command,
        stdout: resData.stdout || '',
        stderr: resData.stderr || outcome.error || '',
        durationMs: resData.durationMs || 0,
        results
      }
      if (!outcome.success) {
        return lastResult
      }
    }
    return lastResult || { attempted: false, success: true, skipped: true, command: '', stdout: '', stderr: '', durationMs: 0, results: [] }
  }

  validateMarkupContent(filePath, content) {
    const text = String(content || '')
    const issues = []

    if (/\.html?$/i.test(filePath)) {
      if (/src\s*=\s*["']\[https?:\/\/[^"'\s]+\]\(https?:\/\/[^"'\s]+\)["']/i.test(text) ||
          /href\s*=\s*["']\[https?:\/\/[^"'\s]+\]\(https?:\/\/[^"'\s]+\)["']/i.test(text)) {
        issues.push('Contains malformed Markdown URL in HTML attribute: [url](url). Use raw URL.')
      }
      if (/<img\b(?![^>]*\balt=)[^>]*>/i.test(text)) {
        issues.push('Contains <img> tag missing alt attribute.')
      }
    }

    if (/\.css$/i.test(filePath)) {
      if (/\bweight\s*:/i.test(text)) {
        issues.push('Contains invalid CSS property "weight"; use "font-weight".')
      }
      if (/\b\d+(?:\.\d+)?u\b/.test(text)) {
        issues.push('Contains invalid CSS unit "u".')
      }
    }

    return {
      valid: issues.length === 0,
      issues
    }
  }
}

