import test from 'node:test'
import assert from 'node:assert/strict'
import { CodeIntelligenceService } from '../src/services/agentEngine/CodeIntelligenceService.js'
import { ToolRunner } from '../src/services/agentEngine/ToolRunner.js'
import { globalLanguageRegistry } from '../src/services/agentEngine/LanguageRegistry.js'

test('Phase 1 — AST Parser extracts symbols, callers, callees, and implementations', () => {
  const parser = globalLanguageRegistry.getParser('auth.js')
  assert.ok(parser, 'Babel parser should be available for .js')

  const code = `
import { hashPassword } from './crypto.js'

export class AuthService {
  login(username, password) {
    const valid = this.verifyUser(username, password)
    return generateToken(username)
  }

  verifyUser(u, p) {
    return hashPassword(p)
  }
}

export function generateToken(user) {
  return signJwt(user)
}

function signJwt(payload) {
  return 'jwt_token_' + payload
}
`

  const result = parser.parse(code, 'src/auth/authService.js')
  assert.ok(result, 'Parse result should not be null')
  assert.equal(result.symbols.length >= 4, true)

  // Verify symbols
  const symNames = result.symbols.map(s => s.name)
  assert.ok(symNames.includes('AuthService'))
  assert.ok(symNames.includes('login'))
  assert.ok(symNames.includes('generateToken'))
  assert.ok(symNames.includes('signJwt'))

  // Verify calls
  const loginCalls = result.calls.filter(c => c.caller === 'AuthService.login')
  const calledNames = loginCalls.map(c => c.callee)
  assert.ok(calledNames.includes('generateToken'))

  const tokenCalls = result.calls.filter(c => c.caller === 'generateToken')
  assert.ok(tokenCalls.map(c => c.callee).includes('signJwt'))
})

test('Phase 1 — AST Parser captures diagnostics on invalid syntax', () => {
  const parser = globalLanguageRegistry.getParser('invalid.js')
  const badCode = `
function broken( {
  return 42
`
  const result = parser.parse(badCode, 'src/invalid.js')
  assert.ok(result.diagnostics.length > 0, 'Should have syntax diagnostics')
  assert.equal(result.diagnostics[0].severity, 'error')
})

test('Phase 1 — CodeIntelligenceService indexes and answers semantic queries', () => {
  const codeIntel = new CodeIntelligenceService('/workspace')

  // Index file 1: Token service
  codeIntel.indexFile('src/auth/token.js', `
export function generateToken(user, options = {}) {
  return 'token_' + user
}

export function verifyToken(token) {
  return token.startsWith('token_')
}
`)

  // Index file 2: Login controller calling generateToken
  codeIntel.indexFile('src/controllers/login.js', `
import { generateToken } from '../auth/token.js'

export function handleLogin(req, res) {
  const token = generateToken(req.user)
  res.json({ token })
}
`)

  // Index file 3: Test file testing generateToken
  codeIntel.indexFile('tests/token.test.js', `
import { generateToken } from '../src/auth/token.js'

test('generates valid token', () => {
  const t = generateToken('alice')
  expect(t).toBeDefined()
})
`)

  // 1. findDefinition
  const defs = codeIntel.findDefinition('generateToken')
  assert.equal(defs.length, 1)
  assert.equal(defs[0].file, 'src/auth/token.js')
  assert.equal(defs[0].kind, 'function')
  assert.match(defs[0].signature, /generateToken/)

  // 2. getCallers
  const callers = codeIntel.getCallers('generateToken')
  assert.equal(callers.length >= 2, true)
  const callerNames = callers.map(c => c.caller)
  assert.ok(callerNames.includes('handleLogin'))

  // 3. findReferences
  const refs = codeIntel.findReferences('generateToken')
  assert.equal(refs.length >= 2, true)

  // 4. getSymbolOverview (Machine-readable Phase 1 spec)
  const overview = codeIntel.getSymbolOverview('generateToken')
  assert.equal(overview.symbol, 'generateToken')
  assert.ok(overview.definition)
  assert.equal(overview.definition.file, 'src/auth/token.js')
  assert.ok(overview.callers.length >= 2)
  assert.ok(overview.tests.includes('tests/token.test.js'), 'Related test file should be detected automatically')

  // 5. getImportGraph
  const importGraph = codeIntel.getImportGraph('src/auth/token.js')
  assert.equal(importGraph.file, 'src/auth/token.js')
  assert.ok(importGraph.importedBy.includes('src/controllers/login.js'))
})

test('Phase 1 — ToolRunner executes 7 Code Intelligence Tools', async () => {
  const mockApi = {
    readFile: async (p) => {
      if (p.includes('service.js')) {
        return {
          success: true,
          content: `
export class BaseService {}
export class UserService extends BaseService {
  findUser(id) { return null }
}
`
        }
      }
      return { success: false, error: 'File not found' }
    },
    listFiles: async () => ({ success: true, children: [] }),
    writeFile: async () => ({ success: true }),
    deleteFile: async () => ({ success: true }),
    moveFile: async () => ({ success: true })
  }

  const codeIntel = new CodeIntelligenceService('/workspace', { api: mockApi })
  codeIntel.indexFile('src/service.js', `
export class BaseService {}
export class UserService extends BaseService {
  findUser(id) { return null }
}
`)

  const runner = new ToolRunner('/workspace', { api: mockApi, codeIntelligence: codeIntel })

  // 1. find_definition
  const defResult = await runner.run('find_definition', { symbol: 'UserService' })
  assert.equal(defResult.success, true)
  assert.equal(defResult.data.symbol, 'UserService')

  // 2. find_symbol
  const symResult = await runner.run('find_symbol', { query: 'User' })
  assert.equal(symResult.success, true)
  assert.equal(symResult.data.symbols.length >= 1, true)

  // 3. find_implementations
  const implResult = await runner.run('find_implementations', { symbol: 'BaseService' })
  assert.equal(implResult.success, true)
  assert.equal(implResult.data.implementations.length, 1)
  assert.equal(implResult.data.implementations[0].name, 'UserService')

  // 4. get_diagnostics
  const diagResult = await runner.run('get_diagnostics', {})
  assert.equal(diagResult.success, true)
  assert.equal(diagResult.data.errorCount, 0)

  // 5. get_import_graph
  const graphResult = await runner.run('get_import_graph', { path: 'src/service.js' })
  assert.equal(graphResult.success, true)
  assert.equal(graphResult.data.file, 'src/service.js')

  // 6. Incremental update on write
  await runner.run('write_file', {
    path: 'src/token.js',
    content: 'export function makeToken() { return 123 }'
  })

  const newDef = await runner.run('find_definition', { symbol: 'makeToken' })
  assert.equal(newDef.success, true)
  assert.equal(newDef.data.symbol, 'makeToken')
})
