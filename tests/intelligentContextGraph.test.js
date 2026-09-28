import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ContextRetrievalPipeline } from '../src/services/agentEngine/ContextRetrievalPipeline.js'
import { ContextEngine } from '../src/services/agentEngine/ContextEngine.js'
import { CodeIntelligenceService } from '../src/services/agentEngine/CodeIntelligenceService.js'
import { ContextBudgetManager } from '../src/services/agentEngine/ContextBudgetManager.js'
import { CHUNK_TYPES, CHUNK_PRIORITY } from '../src/services/agentEngine/ContextChunk.js'

describe('Phase 4: Intelligent Context Graph', () => {
  const root = 'C:/mock/workspace'

  test('1. 9-point priority hierarchy orders graph neighbors over lexical search', async () => {
    const codeIntel = new CodeIntelligenceService(root)

    // Setup project files with relationships
    codeIntel.indexFile('src/config/jwtConfig.js', 'export const jwtConfig = { expiresIn: 3600 };')
    codeIntel.indexFile('src/utils/token.js', `
      import { jwtConfig } from "../config/jwtConfig";
      export function formatPayload(p) { return p; }
      export function generateToken(payload) {
        formatPayload(payload);
        return jwtConfig.expiresIn;
      }
    `)
    codeIntel.indexFile('src/controllers/authController.js', `
      import { generateToken } from "../utils/token";
      export function loginHandler(req) {
        return generateToken(req.user);
      }
    `)
    codeIntel.indexFile('src/middleware/authMiddleware.js', `
      import { generateToken } from "../utils/token";
      export const authMiddleware = { tokenGen: generateToken };
    `)
    codeIntel.indexFile('tests/token.test.js', `
      import { generateToken } from "../src/utils/token";
      describe("token tests", () => {
        it("generates token", () => {
          generateToken({ id: 1 });
        });
      });
    `)
    codeIntel.indexFile('docs/auth.md', '# Authentication Token Architecture')

    const fileIndex = [
      { path: 'src/utils/token.js' },
      { path: 'src/config/jwtConfig.js' },
      { path: 'src/controllers/authController.js' },
      { path: 'src/middleware/authMiddleware.js' },
      { path: 'tests/token.test.js' },
      { path: 'src/components/TokenBadge.jsx', content: 'export function TokenBadge() { return <span>token</span>; }' }
    ]

    const pipeline = new ContextRetrievalPipeline({ codeIntelligence: codeIntel, fileIndex })

    // Task specifies "Fix generateToken expiration"
    const chunks = await pipeline.retrieveChunks({
      task: 'Fix generateToken expiration',
      graphDepth: 2
    })

    // Verify presence of categorized chunks
    const symbolChunk = chunks.find(c => c.type === CHUNK_TYPES.SYMBOL && c.metadata?.symbol === 'generateToken')
    const callerChunk = chunks.find(c => c.type === CHUNK_TYPES.CALLER && c.metadata?.symbol === 'loginHandler')
    const calleeChunk = chunks.find(c => c.type === CHUNK_TYPES.CALLEE && c.metadata?.symbol === 'formatPayload')
    const testChunk = chunks.find(c => c.type === CHUNK_TYPES.TEST && c.path === 'tests/token.test.js')
    const configChunk = chunks.find(c => c.type === CHUNK_TYPES.CONFIG)
    const lexicalChunk = chunks.find(c => c.type === CHUNK_TYPES.FILE && c.path === 'src/components/TokenBadge.jsx')

    assert.ok(symbolChunk, 'Current symbol chunk must be present')
    assert.ok(callerChunk, 'Caller (loginHandler) chunk must be present')
    assert.ok(calleeChunk, 'Callee (formatPayload) chunk must be present')
    assert.ok(testChunk, 'Related test chunk must be present')
    assert.ok(configChunk, 'Configuration chunk must be present')
    assert.ok(lexicalChunk, 'Unrelated lexical file is captured as fallback search')

    // Verify Score & Priority ordering:
    // Current Symbol > Caller > Callee > Test > Config > Lexical Fallback
    assert.ok(symbolChunk.score > callerChunk.score, 'Symbol score must exceed caller score')
    assert.ok(callerChunk.score >= calleeChunk.score, 'Caller score must be >= callee score')
    assert.ok(calleeChunk.score > testChunk.score, 'Callee score must exceed test score')
    assert.ok(testChunk.score > configChunk.score, 'Test score must exceed config score')
    assert.ok(configChunk.score > lexicalChunk.score, 'Config score must exceed unrelated lexical score')
    assert.ok(configChunk.priority > lexicalChunk.priority, 'Config priority must exceed lexical priority')
  })

  test('2. Budget manager discards unrelated lexical files before graph-connected context', async () => {
    const codeIntel = new CodeIntelligenceService(root)
    codeIntel.indexFile('src/token.js', 'export function generateToken() { return "token"; }')
    codeIntel.indexFile('src/auth.js', 'import { generateToken } from "./token"; export function login() { generateToken(); }')
    codeIntel.indexFile('tests/token.test.js', 'import { generateToken } from "../src/token"; generateToken();')

    const fileIndex = [
      { path: 'src/token.js' },
      { path: 'src/auth.js' },
      { path: 'tests/token.test.js' },
      { path: 'src/ui/TokenView.jsx', content: 'tokens '.repeat(200) }
    ]

    const pipeline = new ContextRetrievalPipeline({ codeIntelligence: codeIntel, fileIndex })
    const chunks = await pipeline.retrieveChunks({
      task: 'Fix generateToken logic'
    })

    // Tight budget allows symbol, caller, test, but discards bulky unrelated lexical match
    const budgetManager = new ContextBudgetManager({
      totalTokens: 250,
      reservedOutputTokens: 50,
      reservedSystemTokens: 50
    })

    const packed = budgetManager.packChunks(chunks)
    const includedTypes = packed.includedChunks.map(c => c.type)

    assert.ok(includedTypes.includes(CHUNK_TYPES.SYMBOL), 'Symbol must be included in budget')
    const discardedPaths = packed.discardedChunks.map(c => c.path)
    assert.ok(discardedPaths.includes('src/ui/TokenView.jsx'), 'Unrelated lexical match must be discarded first')
  })

  test('3. Graph distance scales relevance for multi-hop callers', async () => {
    const codeIntel = new CodeIntelligenceService(root)
    // generateToken <- handlerA (distance 1) <- routeB (distance 2)
    codeIntel.indexFile('src/token.js', 'export function generateToken() {}')
    codeIntel.indexFile('src/handler.js', 'import { generateToken } from "./token"; export function handlerA() { generateToken(); }')
    codeIntel.indexFile('src/route.js', 'import { handlerA } from "./handler"; export function routeB() { handlerA(); }')

    const pipeline = new ContextRetrievalPipeline({ codeIntelligence: codeIntel })
    const chunks = await pipeline.retrieveChunks({
      task: 'generateToken',
      graphDepth: 2
    })

    const caller1 = chunks.find(c => c.type === CHUNK_TYPES.CALLER && c.metadata?.symbol === 'handlerA')
    const caller2 = chunks.find(c => c.type === CHUNK_TYPES.CALLER && c.metadata?.symbol === 'routeB')

    assert.ok(caller1, 'Direct caller handlerA must be present')
    assert.ok(caller2, '2nd-hop caller routeB must be present')
    assert.equal(caller1.metadata.graphDistance, 1)
    assert.equal(caller2.metadata.graphDistance, 2)
    assert.ok(caller1.score > caller2.score, 'Distance 1 caller must have higher score than distance 2 caller')
  })

  test('4. ContextEngine retrieveContextGraph API returns structured graph metrics', async () => {
    const engine = new ContextEngine()
    const codeIntel = new CodeIntelligenceService(root)
    codeIntel.indexFile('src/service.js', 'export function performAction() {}')
    codeIntel.indexFile('src/caller.js', 'import { performAction } from "./service"; export function doWork() { performAction(); }')
    engine.setCodeIntelligence(codeIntel)

    const graph = await engine.retrieveContextGraph({
      task: 'performAction',
      graphDepth: 2
    })

    assert.ok(graph.found)
    assert.ok(graph.categories.currentSymbols.length > 0)
    assert.ok(graph.categories.callers.length > 0)
    assert.equal(graph.categories.callers[0].name, 'doWork')
  })

  test('5. SymbolGraph traverseContextGraph handles symbol arrays and non-existent targets cleanly', () => {
    const codeIntel = new CodeIntelligenceService(root)
    codeIntel.indexFile('src/math.js', 'export function add(a, b) { return a + b; }')

    const resValid = codeIntel.symbolGraph.traverseContextGraph(['add'])
    assert.ok(resValid.found)
    assert.equal(resValid.categories.currentSymbols[0].name, 'add')

    const resMissing = codeIntel.symbolGraph.traverseContextGraph('nonExistentSymbol')
    assert.equal(resMissing.found, false)
    assert.deepEqual(resMissing.items, [])
  })
})
