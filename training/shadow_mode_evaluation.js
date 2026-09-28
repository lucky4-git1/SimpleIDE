import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { PrimeRouter, LAYA_ROLLOUT_MODES } from '../src/services/agentEngine/PrimeRouter.js'
import { ROUTER_MODES } from '../src/services/agentEngine/primeRouterSchemas.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Realistic 50-task SimpleIDE workload across 10 categories
const WORKLOAD_TASKS = [
  // 1. Navigation & Symbol Lookups
  { id: 'nav-01', category: 'navigation', request: 'Where is generateToken defined in tokenService.js?', expectedIntent: 'navigate' },
  { id: 'nav-02', category: 'navigation', request: 'Find definition of verifyToken and who calls it', expectedIntent: 'navigate' },
  { id: 'nav-03', category: 'navigation', request: 'Where is authenticateUser implemented?', expectedIntent: 'navigate' },
  { id: 'nav-04', category: 'navigation', request: 'Find all callers of handleLogin across controllers', expectedIntent: 'navigate' },
  { id: 'nav-05', category: 'navigation', request: 'Find references of SessionStore in src/session', expectedIntent: 'navigate' },

  // 2. Refactoring & Structural Edits
  { id: 'ref-01', category: 'refactor', request: 'Refactor verifyToken signature to accept token options object', expectedIntent: 'refactor' },
  { id: 'ref-02', category: 'refactor', request: 'Rename method getUserById to fetchUserRecord across all files', expectedIntent: 'refactor' },
  { id: 'ref-03', category: 'refactor', request: 'Extract method parseHeaders from authenticateUser', expectedIntent: 'refactor' },
  { id: 'ref-04', category: 'refactor', request: 'Move token validation logic into a new helper function', expectedIntent: 'refactor' },
  { id: 'ref-05', category: 'refactor', request: 'Refactor database connection pool singleton', expectedIntent: 'refactor' },

  // 3. Testing & Validation
  { id: 'tst-01', category: 'testing', request: 'npm test tests/token.test.js', expectedIntent: 'test' },
  { id: 'tst-02', category: 'testing', request: 'Run unit test for authController', expectedIntent: 'test' },
  { id: 'tst-03', category: 'testing', request: 'Run jest suite on session module', expectedIntent: 'test' },
  { id: 'tst-04', category: 'testing', request: 'Run all unit tests across the workspace', expectedIntent: 'test' },
  { id: 'tst-05', category: 'testing', request: 'Check tests in tests/m1.5_integration.test.js', expectedIntent: 'test' },

  // 4. Debugging & Diagnostics
  { id: 'dbg-01', category: 'debugging', request: 'Debug 401 Unauthorized in authMiddleware when verifying token', expectedIntent: 'debug' },
  { id: 'dbg-02', category: 'debugging', request: 'Why did test in token.test.js fail with AssertionError?', expectedIntent: 'debug' },
  { id: 'dbg-03', category: 'debugging', request: 'Debug TypeError: cannot read properties of undefined in Login.jsx', expectedIntent: 'debug' },
  { id: 'dbg-04', category: 'debugging', request: 'Investigate stack trace from crash recovery handler', expectedIntent: 'debug' },
  { id: 'dbg-05', category: 'debugging', request: 'Fix broken assertion in auth pipeline test', expectedIntent: 'debug' },

  // 5. Git & VCS Operations
  { id: 'git-01', category: 'git', request: 'git status', expectedIntent: 'git' },
  { id: 'git-02', category: 'git', request: 'git diff HEAD', expectedIntent: 'git' },
  { id: 'git-03', category: 'git', request: 'git log -n 5', expectedIntent: 'git' },
  { id: 'git-04', category: 'git', request: 'git checkout feat/modern-agent-ui', expectedIntent: 'git' },
  { id: 'git-05', category: 'git', request: 'git branch --list', expectedIntent: 'git' },

  // 6. Search & Exploration
  { id: 'src-01', category: 'search', request: 'Search for JWT_SECRET in config files', expectedIntent: 'search' },
  { id: 'src-02', category: 'search', request: 'Find all occurrences of localStorage.getItem', expectedIntent: 'search' },
  { id: 'src-03', category: 'search', request: 'Grep for FIXME comments in src/', expectedIntent: 'search' },
  { id: 'src-04', category: 'search', request: 'Locate database connection string', expectedIntent: 'search' },
  { id: 'src-05', category: 'search', request: 'Find where cors middleware is configured', expectedIntent: 'search' },

  // 7. Hard Negatives: UI & CSS Styling (Non-Symbol)
  { id: 'neg-01', category: 'hard_negative_styling', request: 'Change button background color to dark navy in theme.css', expectedIntent: 'edit' },
  { id: 'neg-02', category: 'hard_negative_styling', request: 'Adjust padding and margin of header bar in HeaderComponent.jsx', expectedIntent: 'edit' },
  { id: 'neg-03', category: 'hard_negative_styling', request: 'Fix heading text font size in Login.jsx', expectedIntent: 'edit' },
  { id: 'neg-04', category: 'hard_negative_styling', request: 'Change flex alignment of navigation tab items', expectedIntent: 'edit' },
  { id: 'neg-05', category: 'hard_negative_styling', request: 'Update primary button hover state background color', expectedIntent: 'edit' },

  // 8. Documentation & Explanation
  { id: 'doc-01', category: 'documentation', request: 'Explain how the ContextEngine pipeline retrieves chunks', expectedIntent: 'explain' },
  { id: 'doc-02', category: 'documentation', request: 'Explain the difference between SymbolGraph and lexical search', expectedIntent: 'explain' },
  { id: 'doc-03', category: 'documentation', request: 'Update README.md with installation instructions for ONNX runtime', expectedIntent: 'edit' },
  { id: 'doc-04', category: 'documentation', request: 'Document the recovery protocol in docs/architecture.md', expectedIntent: 'edit' },
  { id: 'doc-05', category: 'documentation', request: 'What is the purpose of LocalModelRuntime?', expectedIntent: 'explain' },

  // 9. Localized Syntax Fixes
  { id: 'stx-01', category: 'localized_syntax', request: 'Fix syntax error on line 42 of authController.js', expectedIntent: 'edit' },
  { id: 'stx-02', category: 'localized_syntax', request: 'Fix syntax bug in return statement in tokenService.js', expectedIntent: 'edit' },
  { id: 'stx-03', category: 'localized_syntax', request: 'Fix syntax issue missing closing bracket in Login.jsx', expectedIntent: 'edit' },
  { id: 'stx-04', category: 'localized_syntax', request: 'Fix syntax error unexpected token in database.js', expectedIntent: 'edit' },
  { id: 'stx-05', category: 'localized_syntax', request: 'Fix syntax bug trailing comma in package.json', expectedIntent: 'edit' },

  // 10. Stuck Loop & Error Recovery
  { id: 'stk-01', category: 'recovery', request: 'Stuck in infinite loop while attempting to parse token', state: 'STUCK', expectedIntent: 'debug' },
  { id: 'stk-02', category: 'recovery', request: 'Command timed out three times consecutively in runner', state: 'RECOVERY', expectedIntent: 'debug' },
  { id: 'stk-03', category: 'recovery', request: 'Failed edit on authService.js after 3 attempts with syntax error', state: 'RECOVERY', expectedIntent: 'debug' },
  { id: 'stk-04', category: 'recovery', request: 'Agent is repeating the same search without making progress', state: 'STUCK', expectedIntent: 'debug' },
  { id: 'stk-05', category: 'recovery', request: 'Terminal output continuously hangs on dev server startup', state: 'STUCK', expectedIntent: 'debug' }
]

async function runShadowModeEvaluation() {
  console.log('========================================================================')
  console.log('Phase 9: Real Shadow Mode & Live Telemetry Evaluation (50 Workloads)')
  console.log('========================================================================\n')

  // Setup Legacy Router simulating existing production router
  const legacyRouter = new PrimeRouter({
    layaMode: LAYA_ROLLOUT_MODES.SHADOW,
    mode: ROUTER_MODES.ACTIVE,
    adapter: {
      async predict({ request, state }) {
        const lower = String(request).toLowerCase()
        const isStuck = state === 'STUCK' || state === 'RECOVERY'

        if (lower.startsWith('git ')) {
          return { intent: 'git', actionClass: 'local_tool', toolFamily: 'git', needsLLM: false, needsVerification: false, confidence: 0.90, modelVersion: 'legacy-prime-0.1.0' }
        }
        if (lower.includes('npm test') || lower.includes('unit test') || lower.includes('run test') || lower.includes('jest')) {
          return { intent: 'test', actionClass: 'local_tool', toolFamily: 'testing', needsLLM: false, needsVerification: true, confidence: 0.91, modelVersion: 'legacy-prime-0.1.0' }
        }
        if (lower.includes('search for') || lower.includes('find all') || lower.includes('grep for') || lower.includes('locate ')) {
          return { intent: 'search', actionClass: 'local_tool', toolFamily: 'search', needsLLM: false, needsVerification: false, confidence: 0.88, modelVersion: 'legacy-prime-0.1.0' }
        }
        if (lower.includes('where is') || lower.includes('find definition') || lower.includes('find references') || lower.includes('callers of')) {
          // Legacy router often treated search/navigation as local search without AST symbol graph
          return { intent: 'search', actionClass: 'local_tool', toolFamily: 'search', needsLLM: false, needsVerification: false, confidence: 0.86, modelVersion: 'legacy-prime-0.1.0' }
        }
        if (lower.includes('debug') || lower.includes('why did') || lower.includes('stack trace') || isStuck) {
          return { intent: 'debug', actionClass: 'main_llm', toolFamily: 'filesystem', needsLLM: true, needsVerification: true, confidence: 0.87, modelVersion: 'legacy-prime-0.1.0' }
        }
        if (lower.includes('explain') || lower.includes('what is')) {
          return { intent: 'explain', actionClass: 'main_llm', toolFamily: 'none', needsLLM: true, needsVerification: false, confidence: 0.89, modelVersion: 'legacy-prime-0.1.0' }
        }
        return { intent: 'edit', actionClass: 'main_llm', toolFamily: 'editor', needsLLM: true, needsVerification: false, confidence: 0.85, modelVersion: 'legacy-prime-0.1.0' }
      }
    }
  })

  const results = []

  for (const task of WORKLOAD_TASKS) {
    const t0 = performance.now()
    const authoritativeDecision = await legacyRouter.decide({
      request: task.request,
      state: task.state || 'IDLE'
    })
    const lat = performance.now() - t0

    results.push({
      id: task.id,
      category: task.category,
      request: task.request,
      authoritativeDecision
    })
  }

  // Flush pending shadow predictions
  await legacyRouter.flushShadowTelemetry()

  const telemetry = legacyRouter.getShadowTelemetry()
  const summary = legacyRouter.getShadowTelemetrySummary()

  console.log('--- Shadow Mode Evaluation Summary ---')
  console.log(`Total Workload Decisions:     ${summary.totalDecisions}`)
  console.log(`Agreement Rate:               ${summary.agreementRate}% (${summary.totalDecisions - Math.round(summary.totalDecisions * summary.disagreementRate / 100)} / ${summary.totalDecisions})`)
  console.log(`Disagreement Rate:            ${summary.disagreementRate}%`)
  console.log(`Fallback Frequency:           ${summary.fallbackFrequency}%`)
  console.log(`Legacy Latency (ms):          p50: ${summary.legacyLatency.p50}ms, p95: ${summary.legacyLatency.p95}ms, p99: ${summary.legacyLatency.p99}ms, mean: ${summary.legacyLatency.mean}ms`)
  console.log(`Laya Latency (ms):            p50: ${summary.layaLatency.p50}ms, p95: ${summary.layaLatency.p95}ms, p99: ${summary.layaLatency.p99}ms, mean: ${summary.layaLatency.mean}ms`)
  console.log('\n--- Confidence Distribution (Laya) ---')
  console.log(`  < 0.60:                     ${summary.confidenceDistribution.below60}`)
  console.log(`  0.60 - 0.85:                ${summary.confidenceDistribution.medium60to85}`)
  console.log(`  0.85 - 0.95:                ${summary.confidenceDistribution.high85to95}`)
  console.log(`  >= 0.95:                    ${summary.confidenceDistribution.veryHigh95plus}`)
  console.log('\n--- Disagreements by Category ---')
  console.log(`  Intent Disagreements:       ${summary.categoryDisagreements.intent}`)
  console.log(`  Action Class Disagreements: ${summary.categoryDisagreements.actionClass}`)
  console.log(`  Tool Family Disagreements:  ${summary.categoryDisagreements.toolFamily}`)
  console.log(`  needsLLM Disagreements:     ${summary.categoryDisagreements.needsLLM}`)
  console.log(`Context Selection Differences: ${summary.contextSelectionDifferences} (tasks where Laya suppressed graph traversal)`)

  // Save detailed evaluation records
  const outputData = {
    evaluatedAt: new Date().toISOString(),
    totalTasks: summary.totalDecisions,
    summary,
    telemetry
  }

  const outputPath = path.join(__dirname, 'shadow_mode_results.json')
  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2), 'utf8')
  console.log(`\nDetailed shadow telemetry saved to: ${outputPath}`)

  return outputData
}

runShadowModeEvaluation().catch(err => {
  console.error('Shadow evaluation failed:', err)
  process.exit(1)
})
