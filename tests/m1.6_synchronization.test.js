import { test } from 'node:test'
import assert from 'node:assert'
import { ProjectIndexer } from '../src/services/agentEngine/ProjectIndexer.js'
import { globalContextEngine } from '../src/services/agentEngine/ContextEngine.js'
import { ToolRunner } from '../src/services/agentEngine/ToolRunner.js'
import { CHUNK_TYPES } from '../src/services/agentEngine/ContextChunk.js'

test('M1.6 Synchronization — Suite', async (t) => {
  const root = 'C:/test/m16_workspace'

  const files = {
    'C:/test/m16_workspace/src/auth/authService.js': `
export function authenticateUser(username, password) {
  return true;
}
    `,
    'C:/test/m16_workspace/src/components/Login.jsx': `
import { authenticateUser } from "../auth/authService.js"

export function Login() {
  authenticateUser('admin', '123')
}
    `
  }

  const mockApi = {
    listFiles: async (dir) => {
      if (dir === 'C:/test/m16_workspace') {
        return { success: true, children: [{ name: 'src', isDirectory: true, path: 'C:/test/m16_workspace/src' }] }
      }
      if (dir === 'C:/test/m16_workspace/src') {
        return {
          success: true,
          children: [
            { name: 'auth', isDirectory: true, path: 'C:/test/m16_workspace/src/auth' },
            { name: 'components', isDirectory: true, path: 'C:/test/m16_workspace/src/components' }
          ]
        }
      }
      if (dir === 'C:/test/m16_workspace/src/auth') {
        return {
          success: true,
          children: files['C:/test/m16_workspace/src/auth/authService.js'] !== undefined
            ? [{ name: 'authService.js', isDirectory: false, path: 'C:/test/m16_workspace/src/auth/authService.js' }]
            : []
        }
      }
      if (dir === 'C:/test/m16_workspace/src/components') {
        return {
          success: true,
          children: files['C:/test/m16_workspace/src/components/Login.jsx'] !== undefined
            ? [{ name: 'Login.jsx', isDirectory: false, path: 'C:/test/m16_workspace/src/components/Login.jsx' }]
            : []
        }
      }
      return { success: false, error: 'Not found' }
    },
    readFile: async (path) => {
      const content = files[path]
      if (content !== undefined) return { success: true, content }
      return { success: false, error: 'ENOENT' }
    },
    writeFile: async (path, content) => {
      files[path] = content
      return { success: true }
    },
    deleteFile: async (path) => {
      delete files[path]
      return { success: true }
    },
    moveFile: async (from, to) => {
      files[to] = files[from]
      delete files[from]
      return { success: true }
    }
  }

  globalThis.window = { api: mockApi }

  // Setup runner & context engine
  const indexer = new ProjectIndexer(root, { api: mockApi })
  await indexer.buildIndex()

  globalContextEngine.setCodeIntelligence(indexer.codeIntelligence)
  globalContextEngine.updateState({ workspacePath: root })

  const runner = new ToolRunner(root, {
    api: mockApi,
    onChange: change => {
      globalContextEngine.notifyFileChange(change.path, change.after, change.operation)
    }
  })

  await t.test('A. Turn-to-turn freshness', async () => {
    // 1. Initial state check
    const initialSym = indexer.codeIntelligence.findSymbol('authenticateUser')
    assert.strictEqual(initialSym.length, 1, 'Initial authenticateUser symbol should exist')

    // 2. Agent modifies file in Turn 1
    runner.beginTransaction('turn-1-task')
    await runner.run('write_file', {
      path: 'src/auth/authService.js',
      content: `
export function authenticateUserV2(username, password) {
  return true;
}
      `
    })

    // 3. Turn 2 context retrieval immediately reflects V2, not original
    const newSym = indexer.codeIntelligence.findSymbol('authenticateUserV2')
    const oldSym = indexer.codeIntelligence.findSymbol('authenticateUser')

    assert.strictEqual(newSym.length, 1, 'authenticateUserV2 should exist immediately after write')
    assert.strictEqual(oldSym.length, 0, 'authenticateUser should be gone immediately after write')

    const pkg = await globalContextEngine.buildContextPackage({ task: 'Fix authenticateUserV2' })
    const hasV2 = pkg.includedChunks.some(c => c.type === CHUNK_TYPES.SYMBOL && c.metadata.symbol === 'authenticateUserV2')
    assert.ok(hasV2, 'ContextPackage should contain authenticateUserV2')
  })

  await t.test('B. Rollback freshness', async () => {
    // Current state has V2 from task 'turn-1-task'
    assert.strictEqual(indexer.codeIntelligence.findSymbol('authenticateUserV2').length, 1)

    // Roll back task
    await runner.rollbackTransaction('turn-1-task')

    // Restored state check
    const oldSym = indexer.codeIntelligence.findSymbol('authenticateUser')
    const rolledBackV2 = indexer.codeIntelligence.findSymbol('authenticateUserV2')

    assert.strictEqual(oldSym.length, 1, 'authenticateUser should be restored after rollback')
    assert.strictEqual(rolledBackV2.length, 0, 'authenticateUserV2 should be absent after rollback')

    const pkg = await globalContextEngine.buildContextPackage({ task: 'Fix authenticateUser' })
    const hasOriginal = pkg.includedChunks.some(c => c.type === CHUNK_TYPES.SYMBOL && c.metadata.symbol === 'authenticateUser')
    assert.ok(hasOriginal, 'ContextPackage should contain restored authenticateUser')
  })

  await t.test('C. Delete synchronization', async () => {
    runner.beginTransaction('delete-task')

    // Delete Login.jsx via ToolRunner (with approved: true for approval-gated tool)
    await runner.run('delete_file', { path: 'src/components/Login.jsx' }, { approved: true })

    const loginSym = indexer.codeIntelligence.findSymbol('Login')
    assert.strictEqual(loginSym.length, 0, 'Login symbol should be removed immediately on delete')

    const pkg = await globalContextEngine.buildContextPackage({ task: 'Fix Login' })
    const hasLoginChunk = pkg.includedChunks.some(c => c.path === 'src/components/Login.jsx' || c.source === 'src/components/Login.jsx')
    assert.strictEqual(hasLoginChunk, false, 'Deleted file should not appear in ContextPackage')

    await runner.rollbackTransaction('delete-task')
  })

  await t.test('D. Dependency graph mutation', async () => {
    runner.beginTransaction('dep-task')

    // Change Login.jsx imports to import from a new utils file
    await runner.run('write_file', {
      path: 'src/components/Login.jsx',
      content: `
import { newHelper } from "../auth/newHelper.js"
export function Login() { newHelper() }
      `
    })

    const imports = indexer.codeIntelligence.getImports('src/components/Login.jsx')
    assert.strictEqual(imports.length, 1)
    assert.strictEqual(imports[0].source, '../auth/newHelper.js')

    await runner.rollbackTransaction('dep-task')
  })

  await t.test('E. Workspace isolation', async () => {
    const workspaceB = 'C:/test/m16_workspace_B'
    const indexerB = new ProjectIndexer(workspaceB, { api: mockApi })
    await indexerB.buildIndex()

    assert.strictEqual(indexerB.codeIntelligence.findSymbol('authenticateUser').length, 0, 'Workspace B should not leak symbols from A')
  })
})
