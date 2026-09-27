import test from 'node:test'
import assert from 'node:assert/strict'
import { SymbolGraph, SymbolNode, SymbolEdge, NODE_KINDS, EDGE_KINDS } from '../src/services/agentEngine/SymbolGraph.js'
import { CodeIntelligenceService } from '../src/services/agentEngine/CodeIntelligenceService.js'
import { ToolRunner } from '../src/services/agentEngine/ToolRunner.js'

test('Phase 2 — SymbolGraph constructs nodes, edges, and answers usage queries', () => {
  const graph = new SymbolGraph('/workspace')

  // Add nodes: AuthService, LoginController, SessionMiddleware, UserController, auth.test.ts
  const authService = new SymbolNode({
    id: 'class:src/services/AuthService.js:AuthService',
    name: 'AuthService',
    kind: NODE_KINDS.CLASS,
    file: 'src/services/AuthService.js',
    line: 5
  })
  const loginController = new SymbolNode({
    id: 'function:src/controllers/LoginController.js:LoginController',
    name: 'LoginController',
    kind: NODE_KINDS.FUNCTION,
    file: 'src/controllers/LoginController.js',
    line: 12
  })
  const sessionMiddleware = new SymbolNode({
    id: 'function:src/middleware/SessionMiddleware.js:SessionMiddleware',
    name: 'SessionMiddleware',
    kind: NODE_KINDS.FUNCTION,
    file: 'src/middleware/SessionMiddleware.js',
    line: 8
  })
  const userController = new SymbolNode({
    id: 'function:src/controllers/UserController.js:UserController',
    name: 'UserController',
    kind: NODE_KINDS.FUNCTION,
    file: 'src/controllers/UserController.js',
    line: 20
  })
  const testFile = new SymbolNode({
    id: 'file:tests/auth.test.ts',
    name: 'auth.test.ts',
    kind: NODE_KINDS.TEST,
    file: 'tests/auth.test.ts',
    line: 1
  })

  graph.addNode(authService)
  graph.addNode(loginController)
  graph.addNode(sessionMiddleware)
  graph.addNode(userController)
  graph.addNode(testFile)

  // Add edges to AuthService
  graph.addEdge(loginController.id, authService.id, EDGE_KINDS.CALLS)
  graph.addEdge(sessionMiddleware.id, authService.id, EDGE_KINDS.REFERENCES)
  graph.addEdge(userController.id, authService.id, EDGE_KINDS.CALLS)
  graph.addEdge(testFile.id, authService.id, EDGE_KINDS.TESTS)

  // Query "Who uses AuthService?"
  const result = graph.queryUsages('AuthService')
  assert.equal(result.found, true)
  assert.equal(result.target, 'AuthService')
  assert.equal(result.usages.length, 4)

  const names = result.usages.map(u => u.name)
  assert.ok(names.includes('LoginController'))
  assert.ok(names.includes('SessionMiddleware'))
  assert.ok(names.includes('UserController'))
  assert.ok(names.includes('auth.test.ts'))

  // Verify formatted ASCII tree
  assert.match(result.treeText, /^AuthService/)
  assert.match(result.treeText, /LoginController \[calls\]/)
  assert.match(result.treeText, /SessionMiddleware \[references\]/)
  assert.match(result.treeText, /UserController \[calls\]/)
  assert.match(result.treeText, /auth\.test\.ts \[tests\]/)
})

test('Phase 2 — SymbolGraph queryDependencies and call graph exploration', () => {
  const graph = new SymbolGraph('/workspace')

  const funcA = new SymbolNode({ id: 'func:a', name: 'processPayment', kind: NODE_KINDS.FUNCTION, file: 'payment.js', line: 10 })
  const funcB = new SymbolNode({ id: 'func:b', name: 'validateCard', kind: NODE_KINDS.FUNCTION, file: 'card.js', line: 5 })
  const funcC = new SymbolNode({ id: 'func:c', name: 'chargeStripe', kind: NODE_KINDS.FUNCTION, file: 'stripe.js', line: 15 })

  graph.addNode(funcA)
  graph.addNode(funcB)
  graph.addNode(funcC)

  graph.addEdge(funcA.id, funcB.id, EDGE_KINDS.CALLS)
  graph.addEdge(funcA.id, funcC.id, EDGE_KINDS.CALLS)

  const deps = graph.queryDependencies('processPayment')
  assert.equal(deps.found, true)
  assert.equal(deps.dependencies.length, 2)
  const depNames = deps.dependencies.map(d => d.name)
  assert.ok(depNames.includes('validateCard'))
  assert.ok(depNames.includes('chargeStripe'))

  // Multi-hop call hierarchy
  const callGraph = graph.queryCallGraph('processPayment', 'callees', 2)
  assert.equal(callGraph.found, true)
  assert.equal(callGraph.graph.length, 2)
  assert.match(callGraph.treeText, /processPayment \[callees\]/)
  assert.match(callGraph.treeText, /validateCard/)
})

test('Phase 2 — Incremental file removal cleans nodes and edges without full rebuild', () => {
  const graph = new SymbolGraph('/workspace')

  const fileA = 'src/a.js'
  const fileB = 'src/b.js'

  const nodeA = new SymbolNode({ id: 'func:a:foo', name: 'foo', file: fileA })
  const nodeB = new SymbolNode({ id: 'func:b:bar', name: 'bar', file: fileB })

  graph.addNode(nodeA)
  graph.addNode(nodeB)
  graph.addEdge(nodeA.id, nodeB.id, EDGE_KINDS.CALLS)

  assert.equal(graph.nodes.size, 2)
  assert.equal(graph.queryUsages('bar').usages.length, 1)

  // Remove fileA incrementally
  graph.removeFile(fileA)

  assert.equal(graph.nodes.size, 1)
  assert.equal(graph.getNode(nodeA.id), null)
  assert.equal(graph.getNode(nodeB.id) !== null, true)
  assert.equal(graph.queryUsages('bar').usages.length, 0, 'Incoming edge from removed file should be cleaned')
})

test('Phase 2 — CodeIntelligenceService & ToolRunner query_symbol_graph integration', async () => {
  const mockApi = {
    readFile: async () => ({ success: true, content: '' }),
    listFiles: async () => ({ success: true, children: [] }),
    writeFile: async () => ({ success: true }),
    deleteFile: async () => ({ success: true }),
    moveFile: async () => ({ success: true })
  }

  const codeIntel = new CodeIntelligenceService('/workspace', { api: mockApi })

  // Index AuthService file
  codeIntel.indexFile('src/services/AuthService.js', `
export class AuthService {
  login(user, pass) {
    return true
  }
}
`)

  // Index LoginController calling AuthService
  codeIntel.indexFile('src/controllers/LoginController.js', `
import { AuthService } from '../services/AuthService.js'

export function LoginController(req, res) {
  const auth = new AuthService()
  return auth.login(req.user, req.pass)
}
`)

  // Index test file
  codeIntel.indexFile('tests/auth.test.js', `
import { AuthService } from '../src/services/AuthService.js'

test('AuthService logs in', () => {
  const a = new AuthService()
  a.login('u', 'p')
})
`)

  const runner = new ToolRunner('/workspace', { api: mockApi, codeIntelligence: codeIntel })

  // Run query_symbol_graph for AuthService usages
  const usageResult = await runner.run('query_symbol_graph', { symbol: 'AuthService', direction: 'usages' })
  assert.equal(usageResult.success, true)
  assert.equal(usageResult.data.target, 'AuthService')
  assert.ok(usageResult.data.treeText.includes('AuthService'))

  // Run query_symbol_graph for dependencies
  const depResult = await runner.run('query_symbol_graph', { symbol: 'LoginController', direction: 'dependencies' })
  assert.equal(depResult.success, true)
  assert.equal(depResult.data.target, 'LoginController')
})
