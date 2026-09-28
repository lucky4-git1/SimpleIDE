import test from 'node:test'
import assert from 'node:assert/strict'
import { ContextPlanner, HARD_CONTEXT_LIMITS } from '../src/services/agentEngine/ContextPlanner.js'
import { ContextEngine } from '../src/services/agentEngine/ContextEngine.js'
import { CodeIntelligenceService } from '../src/services/agentEngine/CodeIntelligenceService.js'
import { LayaDecisionAdapter } from '../src/services/agentEngine/LayaDecisionAdapter.js'
import { CHUNK_TYPES } from '../src/services/agentEngine/ContextChunk.js'

test('Phase 8: Laya-Controlled ContextEngine & SymbolGraph Integration', async (t) => {
  const root = 'D:/test/workspace'

  function setupCodeIntelligence() {
    const codeIntel = new CodeIntelligenceService(root)
    codeIntel.indexFile('src/auth/tokenService.js', `
      import { db } from "../db/database";
      export function generateToken(payload) {
        return "jwt_" + payload.id;
      }
      export function verifyToken(token) {
        return token.startsWith("jwt_");
      }
    `)
    codeIntel.indexFile('src/controllers/authController.js', `
      import { generateToken, verifyToken } from "../auth/tokenService";
      export function login(req) {
        return generateToken(req.user);
      }
    `)
    codeIntel.indexFile('src/ui/HeaderComponent.jsx', `
      // This file mentions generateToken in a comment: // TODO: check generateToken
      export function Header() {
        return <div className="header-nav">SimpleIDE</div>;
      }
    `)
    codeIntel.indexFile('tests/auth.test.js', `
      import { generateToken } from "../src/auth/tokenService";
      test("generates token", () => {
        generateToken({ id: 1 });
      });
    `)
    return codeIntel
  }

  await t.test('1. Context decision routing: Laya controls breadth and depth for symbol query', async () => {
    const codeIntel = setupCodeIntelligence()
    const planner = new ContextPlanner({ codeIntelligence: codeIntel })

    const { plan, observability } = await planner.planContext({
      task: 'Where is generateToken defined and who calls it?',
      activeFile: 'src/controllers/authController.js'
    })

    assert.equal(plan.semanticNavigationRequired, true)
    assert.ok(plan.graphDepth >= 1)
    assert.ok(plan.symbolsToQuery.includes('generateToken'))
    assert.equal(observability.decision.semanticNavigationRequired, true)
    assert.equal(observability.inferenceSource, 'fallback') // unweighted/headless test fallback
    assert.ok(observability.latencyMs >= 0)
    assert.match(observability.reasonForExpansion, /symbol/i)
  })

  await t.test('2. Hard negative suppression: Pure CSS/styling suppresses SymbolGraph traversal', async () => {
    const codeIntel = setupCodeIntelligence()
    const planner = new ContextPlanner({ codeIntelligence: codeIntel })

    const { plan, observability } = await planner.planContext({
      task: 'Change the header button background color and padding in CSS',
      activeFile: 'src/ui/HeaderComponent.jsx'
    })

    // Strict assertions: semantic navigation must be suppressed
    assert.equal(plan.semanticNavigationRequired, false)
    assert.equal(plan.graphDepth, 0)
    assert.equal(observability.graphDepth, 0)
    assert.equal(observability.symbolsQueried.length, 0)
    assert.match(observability.reasonForStopping, /Semantic navigation suppressed/i)
  })

  await t.test('3. Bounded expansion & early stopping on context sufficiency', async () => {
    const codeIntel = setupCodeIntelligence()
    const planner = new ContextPlanner({ codeIntelligence: codeIntel })

    const { plan, observability } = await planner.planContext({
      task: 'Refactor generateToken signature and update callers',
      activeFile: 'src/auth/tokenService.js',
      symbolQuery: 'generateToken'
    })

    assert.ok(plan.allowedFiles.includes('src/auth/tokenService.js'))
    assert.ok(plan.allowedFiles.some(f => f.includes('authController.js')))
    assert.ok(observability.filesSelected.length <= HARD_CONTEXT_LIMITS.MAX_FILES)
    assert.match(observability.reasonForStopping, /Context sufficient/i)
  })

  await t.test('4. Deterministic hard budget limits cannot be bypassed by Laya', async () => {
    const codeIntel = setupCodeIntelligence()

    // Mock Laya adapter requesting excessive depth and breadth
    const greedyLaya = {
      predict: async () => ({
        intent: 'refactor',
        context_breadth: 'wide',
        graph_depth: 10, // Exceeds hard limit 2
        semantic_navigation_required: true,
        tests_required: true,
        verification_required: true,
        confidence: 0.99,
        inferenceSource: 'onnx'
      })
    }

    const planner = new ContextPlanner({
      layaAdapter: greedyLaya,
      codeIntelligence: codeIntel,
      hardLimits: { MAX_GRAPH_DEPTH: 2, MAX_FILES: 3 }
    })

    const { plan } = await planner.planContext({
      task: 'Analyze entire project tree for generateToken',
      symbolQuery: 'generateToken'
    })

    // Assert hard limits strictly clamped Laya's recommendations
    assert.equal(plan.graphDepth, 2, 'Graph depth must be clamped to MAX_GRAPH_DEPTH (2)')
    assert.ok(plan.allowedFiles.length <= 3, 'Allowed files must not exceed MAX_FILES (3)')
  })

  await t.test('5. Adversarial case: Comments mentioning symbols do NOT trigger false AST relevance', async () => {
    const codeIntel = setupCodeIntelligence()
    const planner = new ContextPlanner({ codeIntelligence: codeIntel })

    // HeaderComponent.jsx only mentions generateToken in a comment
    const relevance = planner._scoreSymbolRelevance('generateToken', 'Fix CSS in Header', 'src/ui/HeaderComponent.jsx')

    // Since HeaderComponent does not declare generateToken, score does not receive activeFile declaration boost
    assert.ok(relevance < 0.90)

    // A completely fake symbol mentioned in text
    const fakeRelevance = planner._scoreSymbolRelevance('NonExistentSymbol123', 'Check NonExistentSymbol123', 'src/ui/HeaderComponent.jsx')
    assert.ok(fakeRelevance < HARD_CONTEXT_LIMITS.MIN_RELEVANCE_SCORE, 'Spurious symbol must be filtered below threshold')
  })

  await t.test('6. Observability log contains required fields with zero secrets', async () => {
    const codeIntel = setupCodeIntelligence()
    const planner = new ContextPlanner({ codeIntelligence: codeIntel })

    const sensitivePrompt = 'Bearer secret_token_abc12345: Where is generateToken defined?'
    const { observability } = await planner.planContext({
      task: sensitivePrompt,
      activeFile: 'src/auth/tokenService.js'
    })

    // Required fields check
    assert.ok(observability.modelVersion)
    assert.ok(observability.inferenceSource)
    assert.ok(observability.decision)
    assert.ok(typeof observability.confidence === 'number')
    assert.ok(observability.requestedContextBreadth)
    assert.ok(typeof observability.graphDepth === 'number')
    assert.ok(Array.isArray(observability.symbolsQueried))
    assert.ok(Array.isArray(observability.filesSelected))
    assert.ok(typeof observability.tokensAdded === 'number')
    assert.ok(observability.reasonForExpansion)
    assert.ok(observability.reasonForStopping)
    assert.ok(typeof observability.latencyMs === 'number')
    assert.ok(typeof observability.fallbackStatus === 'boolean')

    // Secret protection check
    const logStr = JSON.stringify(observability)
    assert.equal(logStr.includes('secret_token_abc12345'), false, 'Sensitive tokens must be redacted')
  })

  await t.test('7. Low confidence fallback behavior (<0.60)', async () => {
    const codeIntel = setupCodeIntelligence()

    // Mock low-confidence adapter
    const lowConfAdapter = {
      predict: async () => ({
        intent: 'edit',
        context_breadth: 'focused',
        graph_depth: 1,
        semantic_navigation_required: false,
        confidence: 0.42, // Low confidence
        inferenceSource: 'onnx'
      })
    }

    const planner = new ContextPlanner({
      layaAdapter: lowConfAdapter,
      codeIntelligence: codeIntel
    })

    const { plan, observability } = await planner.planContext({ task: 'update code' })
    assert.equal(observability.fallbackStatus, true)
    assert.match(observability.fallbackReason, /Low model confidence/i)
  })

  await t.test('8. End-to-end ContextEngine integration attaches Laya observability to package', async () => {
    const codeIntel = setupCodeIntelligence()
    const engine = new ContextEngine()
    engine.setCodeIntelligence(codeIntel)

    const fileIndex = [
      { path: 'src/auth/tokenService.js' },
      { path: 'src/controllers/authController.js' }
    ]
    engine.setFileIndex(fileIndex)

    const pkg = await engine.buildContextPackage({
      task: 'Where is generateToken defined?',
      activeFile: 'src/auth/tokenService.js',
      activeFileContent: 'export function generateToken() {}'
    })

    assert.ok(pkg)
    assert.ok(pkg.retrievalMetadata)
    assert.ok(pkg.retrievalMetadata.layaObservability)
    assert.equal(pkg.retrievalMetadata.layaObservability.symbolsQueried.includes('generateToken'), true)
  })
})
