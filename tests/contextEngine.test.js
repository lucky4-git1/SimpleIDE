import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ContextChunk, CHUNK_TYPES, CHUNK_PRIORITY, estimateTokens } from '../src/services/agentEngine/ContextChunk.js'
import { ContextPackage } from '../src/services/agentEngine/ContextPackage.js'
import { ContextBudgetManager } from '../src/services/agentEngine/ContextBudgetManager.js'
import { ObservationManager } from '../src/services/agentEngine/ObservationManager.js'
import { ContextRetrievalPipeline } from '../src/services/agentEngine/ContextRetrievalPipeline.js'
import { PromptContextFormatter } from '../src/services/agentEngine/PromptContextFormatter.js'
import { ContextEngine } from '../src/services/agentEngine/ContextEngine.js'
import { CodeIntelligenceService } from '../src/services/agentEngine/CodeIntelligenceService.js'

describe('Context Engine 2.0 — Milestone 3 Test Suite', () => {
  const root = 'C:/mock/workspace'

  test('1. Active file receives highest relevance score', async () => {
    const pipeline = new ContextRetrievalPipeline()
    const chunks = await pipeline.retrieveChunks({
      activeFile: 'src/App.jsx',
      activeFileContent: 'export function App() { return <div>App</div>; }'
    })

    const activeChunk = chunks.find(c => c.type === CHUNK_TYPES.ACTIVE_FILE)
    assert.ok(activeChunk)
    assert.equal(activeChunk.score, 1.0)
    assert.equal(activeChunk.path, 'src/App.jsx')
  })

  test('2. Selection receives critical priority', async () => {
    const pipeline = new ContextRetrievalPipeline()
    const chunks = await pipeline.retrieveChunks({
      activeFile: 'src/App.jsx',
      activeFileContent: 'const x = 10;',
      selection: 'const x = 10;'
    })

    const selChunk = chunks.find(c => c.type === CHUNK_TYPES.SELECTION)
    assert.ok(selChunk)
    assert.equal(selChunk.priority, CHUNK_PRIORITY.CRITICAL)
  })

  test('3. Exact symbol match ranks highly', async () => {
    const codeIntel = new CodeIntelligenceService(root)
    codeIntel.indexFile('src/authService.js', 'export function authenticateUser(u, p) { return true; }')

    const pipeline = new ContextRetrievalPipeline({ codeIntelligence: codeIntel })
    const chunks = await pipeline.retrieveChunks({
      task: 'Fix authenticateUser validation logic'
    })

    const symChunk = chunks.find(c => c.type === CHUNK_TYPES.SYMBOL && c.metadata?.symbol === 'authenticateUser')
    assert.ok(symChunk)
    assert.equal(symChunk.score, 0.90)
    assert.equal(symChunk.priority, CHUNK_PRIORITY.CRITICAL)
  })

  test('4. Direct dependency outranks unrelated lexical files', async () => {
    const codeIntel = new CodeIntelligenceService(root)
    codeIntel.indexFile('src/auth.js', 'export function login() {}')
    codeIntel.indexFile('src/App.js', 'import { login } from "./auth";')

    const pipeline = new ContextRetrievalPipeline({ codeIntelligence: codeIntel })
    const chunks = await pipeline.retrieveChunks({
      activeFile: 'src/App.js',
      activeFileContent: 'import { login } from "./auth";'
    })

    const depChunk = chunks.find(c => c.type === CHUNK_TYPES.DEPENDENCY)
    assert.ok(depChunk)
    assert.equal(depChunk.score, 0.80)
    assert.equal(depChunk.priority, CHUNK_PRIORITY.HIGH)
  })

  test('5. Dependent file retrieval works via CodeIntelligenceService', async () => {
    const codeIntel = new CodeIntelligenceService(root)
    codeIntel.indexFile('src/utils.js', 'export function helper() {}')
    codeIntel.indexFile('src/index.js', 'import { helper } from "./utils";')

    const dependents = codeIntel.getDependents('src/utils.js')
    assert.ok(dependents.includes('src/index.js'))
  })

  test('6. Lexical retrieval integrates ranked candidate files', async () => {
    const mockFileIndex = {
      files: [
        { path: 'src/authService.js', content: 'authentication login token' },
        { path: 'src/theme.js', content: 'color palette background' }
      ]
    }

    const pipeline = new ContextRetrievalPipeline({ fileIndex: mockFileIndex })
    const chunks = await pipeline.retrieveChunks({
      task: 'authentication token'
    })

    const lexChunk = chunks.find(c => c.type === CHUNK_TYPES.FILE && c.path === 'src/authService.js')
    assert.ok(lexChunk)
    assert.equal(lexChunk.score, 0.60)
  })

  test('7. Irrelevant files are excluded from top context', async () => {
    const manager = new ContextBudgetManager({ totalTokens: 3000, reservedOutputTokens: 500, reservedSystemTokens: 500 })
    const chunks = [
      new ContextChunk({ id: 'c1', type: CHUNK_TYPES.ACTIVE_FILE, content: 'active content', priority: CHUNK_PRIORITY.HIGH, score: 1.0 }),
      new ContextChunk({ id: 'c2', type: CHUNK_TYPES.FILE, content: 'x'.repeat(10000), priority: CHUNK_PRIORITY.LOW, score: 0.1 })
    ]

    const packed = manager.packChunks(chunks)
    assert.equal(packed.includedChunks.length, 1)
    assert.equal(packed.includedChunks[0].id, 'c1')
    assert.equal(packed.discardedChunks.length, 1)
  })

  test('8. Graph expansion respects depth parameter', async () => {
    const codeIntel = new CodeIntelligenceService(root)
    codeIntel.indexFile('src/a.js', 'export function a() {}')
    codeIntel.indexFile('src/b.js', 'import { a } from "./a"; export function b() {}')
    codeIntel.indexFile('src/c.js', 'import { b } from "./b";')

    const pipeline = new ContextRetrievalPipeline({ codeIntelligence: codeIntel })
    const chunks = await pipeline.retrieveChunks({ activeFile: 'src/c.js', activeFileContent: 'import { b } from "./b";', graphDepth: 1 })

    const depPaths = chunks.filter(c => c.type === CHUNK_TYPES.DEPENDENCY).map(c => c.path)
    assert.ok(depPaths.includes('src/b.js'))
  })

  test('9. Context budget is strictly respected', () => {
    const manager = new ContextBudgetManager({ totalTokens: 1000, reservedOutputTokens: 200, reservedSystemTokens: 100 })
    const chunks = [
      new ContextChunk({ id: '1', type: CHUNK_TYPES.FILE, content: 'a'.repeat(2000), priority: CHUNK_PRIORITY.HIGH, score: 0.8 }),
      new ContextChunk({ id: '2', type: CHUNK_TYPES.FILE, content: 'b'.repeat(2000), priority: CHUNK_PRIORITY.HIGH, score: 0.7 })
    ]

    const packed = manager.packChunks(chunks)
    assert.ok(packed.tokenBudget.used <= 1000)
    assert.equal(packed.includedChunks.length, 1)
  })

  test('10. High-priority chunks survive budget pressure over low-priority chunks', () => {
    const manager = new ContextBudgetManager({ totalTokens: 2500, reservedOutputTokens: 500, reservedSystemTokens: 500 })
    const lowPriority = new ContextChunk({ id: 'low', type: CHUNK_TYPES.FILE, content: 'low'.repeat(800), priority: CHUNK_PRIORITY.LOW, score: 0.2 })
    const criticalPriority = new ContextChunk({ id: 'critical', type: CHUNK_TYPES.DIAGNOSTIC, content: 'compiler error at L42', priority: CHUNK_PRIORITY.CRITICAL, score: 0.95 })

    const packed = manager.packChunks([lowPriority, criticalPriority])
    assert.equal(packed.includedChunks[0].id, 'critical')
  })

  test('11. Low-priority chunks are discarded first when budget is constrained', () => {
    const manager = new ContextBudgetManager({ totalTokens: 1010, reservedOutputTokens: 500, reservedSystemTokens: 500 }) // 10 available tokens
    const c1 = new ContextChunk({ id: 'c1', type: CHUNK_TYPES.ACTIVE_FILE, content: 'active', priority: CHUNK_PRIORITY.HIGH, score: 1.0 }) // ~2 tokens
    const c2 = new ContextChunk({ id: 'c2', type: CHUNK_TYPES.FILE, content: 'random listing string that exceeds budget limit', priority: CHUNK_PRIORITY.LOW, score: 0.1 }) // ~12 tokens

    const packed = manager.packChunks([c1, c2])
    assert.ok(packed.includedChunks.some(c => c.id === 'c1'))
    assert.ok(packed.discardedChunks.some(c => c.id === 'c2'))
  })

  test('12. Duplicate chunks are automatically removed', () => {
    const manager = new ContextBudgetManager()
    const dup1 = new ContextChunk({ id: 'same_id', type: CHUNK_TYPES.FILE, path: 'src/dup.js', content: 'code', priority: CHUNK_PRIORITY.MEDIUM, score: 0.5 })
    const dup2 = new ContextChunk({ id: 'same_id', type: CHUNK_TYPES.FILE, path: 'src/dup.js', content: 'code', priority: CHUNK_PRIORITY.MEDIUM, score: 0.5 })

    const packed = manager.packChunks([dup1, dup2])
    assert.equal(packed.includedChunks.length, 1)
  })

  test('13. Changed files invalidate cached context', () => {
    const pipeline = new ContextRetrievalPipeline()
    pipeline.chunkCache.set('src/App.js', { content: 'old' })
    pipeline.invalidateFile('src/App.js')

    assert.equal(pipeline.chunkCache.has('src/App.js'), false)
  })

  test('14. Structured observations tracking and priority classification', () => {
    const obsManager = new ObservationManager()
    const errorObs = obsManager.addObservation({ turn: 1, tool: 'run_command', status: 'failed', details: 'TypeScript error: TS2304' })
    const writeObs = obsManager.addObservation({ turn: 2, tool: 'write_file', status: 'success', summary: 'Updated src/App.js' })

    assert.equal(errorObs.importance, 'high')
    assert.equal(writeObs.importance, 'medium')
  })

  test('15. Old observations can be compressed into compact summaries', () => {
    const obsManager = new ObservationManager()
    for (let i = 1; i <= 10; i++) {
      obsManager.addObservation({ turn: i, tool: 'list_files', status: 'success', summary: `List dir turn ${i}` })
    }

    const compressed = obsManager.compressObservations({ maxRecentDetailed: 3 })
    assert.equal(compressed.length, 10)
    const oldestChunk = compressed[0]
    assert.equal(oldestChunk.metadata.compressed, true)
    assert.equal(oldestChunk.priority, CHUNK_PRIORITY.LOW)
  })

  test('16. Diagnostics receive critical priority', async () => {
    const pipeline = new ContextRetrievalPipeline()
    const chunks = await pipeline.retrieveChunks({
      diagnostics: ['src/App.jsx:42: Unexpected token']
    })

    const diagChunk = chunks.find(c => c.type === CHUNK_TYPES.DIAGNOSTIC)
    assert.ok(diagChunk)
    assert.equal(diagChunk.priority, CHUNK_PRIORITY.CRITICAL)
    assert.equal(diagChunk.score, 0.95)
  })

  test('17. ContextPackage contains expected canonical structure and metadata', async () => {
    const engine = new ContextEngine()
    const pkg = await engine.buildContextPackage({
      task: 'Add dark mode toggle',
      activeFile: 'src/App.jsx',
      activeFileContent: 'function App() {}'
    })

    assert.ok(pkg instanceof ContextPackage)
    assert.equal(pkg.task, 'Add dark mode toggle')
    assert.equal(pkg.activeFile, 'src/App.jsx')
    assert.ok(Array.isArray(pkg.includedChunks))
    assert.ok(Array.isArray(pkg.discardedChunks))
    assert.ok(pkg.tokenBudget.total > 0)
    assert.ok(pkg.retrievalMetadata.rankingMethod)

    const debugStr = PromptContextFormatter.formatDebugSummary(pkg)
    assert.ok(debugStr.includes('CONTEXT PACKAGE DEBUG DIAGNOSTICS'))
  })

  test('18. Performance Benchmark for Context Engine 2.0', async () => {
    const codeIntel = new CodeIntelligenceService(root)
    for (let i = 0; i < 50; i++) {
      codeIntel.indexFile(`src/file${i}.js`, `
        import { helper } from './file${(i + 1) % 50}';
        export function func${i}() { return ${i}; }
      `)
    }

    const engine = new ContextEngine()
    engine.setCodeIntelligence(codeIntel)

    // Benchmark Retrieval Latency
    const t0 = performance.now()
    const pkg = await engine.buildContextPackage({
      task: 'Fix func25 in file25',
      activeFile: 'src/file25.js',
      activeFileContent: 'import { helper } from "./file26"; export function func25() { return 25; }'
    })
    const tRetrieve = performance.now() - t0

    // Benchmark Context Assembly Latency
    const t1 = performance.now()
    const promptText = PromptContextFormatter.formatPromptContext(pkg)
    const tAssemble = performance.now() - t1

    // Benchmark Token Estimation Latency
    const t2 = performance.now()
    const tokens = estimateTokens(promptText)
    const tTokens = performance.now() - t2

    console.log(`[Context Engine 2.0 Benchmark] Retrieval latency: ${tRetrieve.toFixed(2)}ms`)
    console.log(`[Context Engine 2.0 Benchmark] Assembly latency: ${tAssemble.toFixed(2)}ms`)
    console.log(`[Context Engine 2.0 Benchmark] Token estimation latency: ${tTokens.toFixed(3)}ms (Tokens: ${tokens})`)

    assert.ok(tRetrieve < 100, 'Context retrieval should complete under 100ms')
    assert.ok(tAssemble < 50, 'Prompt assembly should complete under 50ms')
    assert.ok(tTokens < 10, 'Token estimation should complete under 10ms')
  })
})
