import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { CodeIntelligenceService, INDEX_STATE } from '../src/services/agentEngine/CodeIntelligenceService.js'
import { ProjectIndexer } from '../src/services/agentEngine/ProjectIndexer.js'
import { globalLanguageRegistry, SymbolRecord } from '../src/services/agentEngine/LanguageRegistry.js'

function createMockApi(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles))

  return {
    files,
    async readFile(path) {
      if (files.has(path)) {
        return { success: true, content: files.get(path) }
      }
      return { success: false, error: 'ENOENT: file not found' }
    },
    async listFiles(path) {
      const children = []
      for (const filePath of files.keys()) {
        if (filePath.startsWith(path)) {
          const rel = filePath.replace(path, '').replace(/^\//, '')
          const parts = rel.split('/')
          const isDir = parts.length > 1
          const name = parts[0]
          if (!children.some(c => c.name === name)) {
            children.push({ name, path: `${path}/${name}`, isDirectory: isDir })
          }
        }
      }
      return { success: true, children }
    }
  }
}

describe('Prime Code Intelligence V1 — Test Suite', () => {
  const root = 'C:/mock/project'

  test('1. JavaScript function extraction', () => {
    const code = `
      function authenticateUser(username, password) {
        return username === "admin";
      }
      const validateToken = (token) => Boolean(token);
    `
    const service = new CodeIntelligenceService(root)
    service.indexFile('src/auth.js', code)

    const symbols = service.getFileSymbols('src/auth.js')
    const authFunc = symbols.find(s => s.name === 'authenticateUser')
    const tokenFunc = symbols.find(s => s.name === 'validateToken')

    assert.ok(authFunc, 'authenticateUser function should be extracted')
    assert.equal(authFunc.kind, 'function')
    assert.ok(tokenFunc, 'validateToken function should be extracted')
    assert.equal(tokenFunc.kind, 'function')
  })

  test('2. TypeScript function extraction', () => {
    const code = `
      export function parsePayload<T>(input: string): T {
        return JSON.parse(input);
      }
    `
    const service = new CodeIntelligenceService(root)
    service.indexFile('src/parser.ts', code)

    const symbols = service.getFileSymbols('src/parser.ts')
    const parseFunc = symbols.find(s => s.name === 'parsePayload')

    assert.ok(parseFunc, 'TypeScript generic function should be extracted')
    assert.equal(parseFunc.kind, 'function')
    assert.equal(parseFunc.exported, true)
  })

  test('3. Class and method extraction', () => {
    const code = `
      export class UserService {
        async getUser(id) {
          return { id };
        }
      }
    `
    const service = new CodeIntelligenceService(root)
    service.indexFile('src/UserService.js', code)

    const symbols = service.getFileSymbols('src/UserService.js')
    const userClass = symbols.find(s => s.name === 'UserService' && s.kind === 'class')
    const getUserMethod = symbols.find(s => s.name === 'getUser' && s.kind === 'method')

    assert.ok(userClass, 'Class declaration should be extracted')
    assert.equal(userClass.exported, true)
    assert.ok(getUserMethod, 'Class method should be extracted')
    assert.equal(getUserMethod.parent, 'UserService')
  })

  test('4. React component extraction', () => {
    const code = `
      import React from 'react';
      export function UserProfile({ user }) {
        return <div>{user.name}</div>;
      }
      export const AdminBadge = () => <span className="badge">Admin</span>;
    `
    const service = new CodeIntelligenceService(root)
    service.indexFile('src/components/UserProfile.jsx', code)

    const symbols = service.getFileSymbols('src/components/UserProfile.jsx')
    const profileComp = symbols.find(s => s.name === 'UserProfile')
    const badgeComp = symbols.find(s => s.name === 'AdminBadge')

    assert.ok(profileComp, 'React UserProfile function component should be extracted')
    assert.equal(profileComp.kind, 'component')
    assert.ok(badgeComp, 'React AdminBadge arrow component should be extracted')
    assert.equal(badgeComp.kind, 'component')
  })

  test('5. Import extraction', () => {
    const code = `
      import { authenticateUser } from './auth';
      import React, { useState } from 'react';
    `
    const service = new CodeIntelligenceService(root)
    service.indexFile('src/App.jsx', code)

    const imports = service.getImports('src/App.jsx')
    assert.equal(imports.length, 2)
    assert.equal(imports[0].source, './auth')
    assert.equal(imports[1].source, 'react')
  })

  test('6. Export extraction', () => {
    const code = `
      export const API_URL = 'https://api.example.com';
      export default function main() {}
    `
    const service = new CodeIntelligenceService(root)
    service.indexFile('src/config.js', code)

    const exports = service.getExports('src/config.js')
    assert.equal(exports.length, 2)
    assert.ok(exports.some(e => e.name === 'API_URL'))
    assert.ok(exports.some(e => e.name === 'main' || e.name === 'default'))
  })

  test('7. Symbol lookup by name and search query', () => {
    const code = `
      export function calculateTotal(items) { return 100; }
      export function calculateTax(total) { return 10; }
    `
    const service = new CodeIntelligenceService(root)
    service.indexFile('src/calculator.js', code)

    const exact = service.findSymbol('calculateTotal')
    assert.equal(exact.length, 1)
    assert.equal(exact[0].name, 'calculateTotal')

    const searchResults = service.findSymbols('calculate')
    assert.equal(searchResults.length, 2)
  })

  test('8. File symbol lookup', () => {
    const code = `const x = 10; const y = 20;`
    const service = new CodeIntelligenceService(root)
    service.indexFile('src/constants.js', code)

    const fileSymbols = service.getFileSymbols('src/constants.js')
    assert.equal(fileSymbols.length, 2)
    assert.ok(fileSymbols.some(s => s.name === 'x'))
    assert.ok(fileSymbols.some(s => s.name === 'y'))
  })

  test('9. Dependency lookup & graph query', () => {
    const service = new CodeIntelligenceService(root)
    service.indexFile('src/auth.js', 'export function login() {}')
    service.indexFile('src/App.js', 'import { login } from "./auth";')

    const importedBy = service.getImportedBy('src/auth.js')
    assert.ok(importedBy.includes('src/App.js'), 'src/App.js should import src/auth.js')

    const dependents = service.getDependents('src/auth.js')
    assert.ok(dependents.includes('src/App.js'), 'Dependents of auth.js should include App.js')
  })

  test('10. Malformed source fallback does not crash service', () => {
    const malformed = `function brokenCode( { const = ;`
    const service = new CodeIntelligenceService(root)
    
    assert.doesNotThrow(() => {
      service.indexFile('src/broken.js', malformed)
    })

    const symbols = service.getFileSymbols('src/broken.js')
    assert.ok(Array.isArray(symbols), 'Symbols should return array even on malformed code')
  })

  test('11. Incremental file update updates symbol and import records', () => {
    const service = new CodeIntelligenceService(root)
    service.indexFile('src/feature.js', 'function oldFunc() {}')
    assert.equal(service.findSymbol('oldFunc').length, 1)

    service.updateFile('src/feature.js', 'function newFunc() {}')
    assert.equal(service.findSymbol('oldFunc').length, 0, 'oldFunc should be removed')
    assert.equal(service.findSymbol('newFunc').length, 1, 'newFunc should be indexed')
  })

  test('12. File deletion cleans symbol index and relationship graph', () => {
    const service = new CodeIntelligenceService(root)
    service.indexFile('src/temp.js', 'export function tempFunc() {}')
    assert.equal(service.findSymbol('tempFunc').length, 1)

    service.removeFile('src/temp.js')
    assert.equal(service.findSymbol('tempFunc').length, 0, 'tempFunc should be cleared')
    assert.equal(service.getFileSymbols('src/temp.js').length, 0)
  })

  test('13. Workspace indexing scans workspace directory asynchronously', async () => {
    const mockApi = createMockApi({
      [`${root}/src/index.js`]: 'export function main() {}',
      [`${root}/src/utils.js`]: 'export function helper() {}'
    })
    const service = new CodeIntelligenceService(root, { api: mockApi })
    const structure = await service.indexWorkspace()

    assert.equal(structure.filesCount, 2)
    assert.equal(structure.symbolsCount, 2)
    assert.equal(service.getState(), INDEX_STATE.READY)
  })

  test('14. Existing ProjectIndexer behavior remains fully functional', async () => {
    const mockApi = createMockApi({
      [`${root}/src/index.js`]: 'import { helper } from "./utils"; export function main() {}',
      [`${root}/src/utils.js`]: 'export function helper() {}',
      [`${root}/package.json`]: JSON.stringify({ dependencies: { react: '^18.0.0' } })
    })

    const indexer = new ProjectIndexer(root, { api: mockApi })
    const index = await indexer.buildIndex()

    assert.ok(index.files.includes('src/index.js'))
    assert.equal(index.dependencies.react, '^18.0.0')

    const lookup = indexer.lookupSymbol('main')
    assert.ok(lookup.some(s => s.name === 'main'))

    const dependents = indexer.getDependentFiles('utils')
    assert.ok(dependents.length > 0)
  })

  test('15. Performance Benchmark Baseline', () => {
    const service = new CodeIntelligenceService(root)

    // Benchmark initial file indexing (50 files)
    const t0 = performance.now()
    for (let i = 0; i < 50; i++) {
      service.indexFile(`src/file${i}.js`, `
        import { dep } from './file${(i + 1) % 50}';
        export class Class${i} {
          method${i}() { return ${i}; }
        }
        export function func${i}() { return "${i}"; }
      `)
    }
    const tInitial = performance.now() - t0

    // Benchmark single-file update
    const t1 = performance.now()
    service.updateFile('src/file10.js', 'export function updatedFunc10() {}')
    const tUpdate = performance.now() - t1

    // Benchmark symbol lookup
    const t2 = performance.now()
    const sym = service.findSymbol('func25')
    const tLookup = performance.now() - t2

    // Benchmark dependency lookup
    const t3 = performance.now()
    const deps = service.getDependents('src/file25.js')
    const tDepLookup = performance.now() - t3

    console.log(`[Performance Baseline] Initial 50-file indexing: ${tInitial.toFixed(2)}ms`)
    console.log(`[Performance Baseline] Single-file re-index: ${tUpdate.toFixed(2)}ms`)
    console.log(`[Performance Baseline] Symbol lookup time: ${tLookup.toFixed(3)}ms`)
    console.log(`[Performance Baseline] Dependency lookup time: ${tDepLookup.toFixed(3)}ms`)

    assert.ok(tInitial < 2000, 'Initial indexing should complete under 2000ms')
    assert.ok(tUpdate < 100, 'Single-file update should complete under 100ms')
    assert.ok(tLookup < 10, 'Symbol lookup should complete under 10ms')
  })
})
