import { test } from 'node:test'
import assert from 'node:assert'
import { ProjectIndexer } from '../src/services/agentEngine/ProjectIndexer.js'
import { globalContextEngine } from '../src/services/agentEngine/ContextEngine.js'
import { runAgentTask } from '../src/services/agentService.js'
import * as aiService from '../src/services/aiService.js'
import { CHUNK_TYPES } from '../src/services/agentEngine/ContextChunk.js'
import { PromptContextFormatter } from '../src/services/agentEngine/PromptContextFormatter.js'

test('M1.5 Integration: Workspace -> CodeIntelligence -> ContextEngine -> PromptContextFormatter -> LLM', async () => {
  const root = 'C:/test/workspace'

  // Synthetic workspace state
  const files = {
    'C:/test/workspace/src/auth/authService.js': `
export function authenticateUser(username, password) {
  return true;
}
    `,
    'C:/test/workspace/src/components/Login.jsx': `
import { authenticateUser } from "../auth/authService.js"

export function Login() {
  authenticateUser('admin', '123')
}
    `
  }

  // Mock API
  const mockApi = {
    listFiles: async (dir) => {
      if (dir === 'C:/test/workspace') {
        return {
          success: true,
          children: [
            { name: 'src', isDirectory: true, path: 'C:/test/workspace/src' }
          ]
        }
      }
      if (dir === 'C:/test/workspace/src') {
        return {
          success: true,
          children: [
            { name: 'auth', isDirectory: true, path: 'C:/test/workspace/src/auth' },
            { name: 'components', isDirectory: true, path: 'C:/test/workspace/src/components' }
          ]
        }
      }
      if (dir === 'C:/test/workspace/src/auth') {
        return {
          success: true,
          children: [
            { name: 'authService.js', isDirectory: false, path: 'C:/test/workspace/src/auth/authService.js' }
          ]
        }
      }
      if (dir === 'C:/test/workspace/src/components') {
        return {
          success: true,
          children: [
            { name: 'Login.jsx', isDirectory: false, path: 'C:/test/workspace/src/components/Login.jsx' }
          ]
        }
      }
      return { success: false, error: 'Not found' }
    },
    readFile: async (path) => {
      const content = files[path]
      if (content !== undefined) return { success: true, content }
      return { success: false, error: 'ENOENT' }
    },
    runCode: async () => ({ success: true, stdout: '', stderr: '' }),
    writeFile: async () => ({ success: true }),
    getAIConfig: async () => ({ hasApiKey: true, model: 'mock-model', provider: 'mock-provider' })
  }

  globalThis.window = { api: mockApi }

  // 1. Workspace Initialization
  const indexer = new ProjectIndexer(root, { api: mockApi })
  await indexer.buildIndex()
  
  // Create lexical index fallback representation
  const lexicalIndex = Object.keys(files).map(p => ({
    path: p,
    name: p.split('/').pop(),
    content: files[p]
  }))

  // 2. Wiring
  globalContextEngine.setCodeIntelligence(indexer.codeIntelligence)
  globalContextEngine.setFileIndex(lexicalIndex)

  // 3. Mock LLM Boundary ONLY via aiRequest
  let capturedUserPrompt = ''
  
  mockApi.aiRequest = async (requestArgs) => {
    const messages = requestArgs.body?.messages || []
    capturedUserPrompt = messages.find(m => m.role === 'user')?.content || ''
    return {
      success: true,
      data: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                status: "Completed",
                thought: "I see the symbol and dependency.",
                plan: [],
                actions: [{ type: "finish", message: "Done" }]
              })
            }
          }
        ]
      }
    }
  }

  // Ensure config is set for AI Service
  globalThis.localStorage = {
    getItem: () => 'test-key',
    setItem: () => {}
  }

  try {
    // 4. Run Task using full production path
    const result = await runAgentTask({
      task: 'Fix authenticateUser',
      context: {
        currentFolder: root,
        activeFile: null,
        selectedCode: null,
        projectIndex: lexicalIndex,
        openFiles: []
      },
      tools: { api: mockApi }
    })

    assert.strictEqual(result.status, 'Completed')

    // Optional: Directly inspect ContextPackage retrieval to guarantee internal fields
    const pkg = await globalContextEngine.buildContextPackage({ task: 'Fix authenticateUser' })

    // 5. Verify the actual formatted prompt content sent to the LLM
    // It should contain the symbol and the related dependency file
    assert.ok(capturedUserPrompt.includes('[Code Intelligence Symbols]'), 'Should contain Code Intelligence header')
    assert.ok(capturedUserPrompt.includes('function authenticateUser'), 'Should contain the extracted symbol')
    
    assert.ok(capturedUserPrompt.includes('[Related File Dependencies]'), 'Should contain Related File Dependencies header')
    assert.ok(capturedUserPrompt.includes('src/components/Login.jsx'), 'Should contain the dependency file path')
    
    const hasSymbol = pkg.includedChunks.some(c => c.type === CHUNK_TYPES.SYMBOL && c.metadata.symbol === 'authenticateUser')
    const hasDependency = pkg.includedChunks.some(c => c.type === CHUNK_TYPES.DEPENDENCY && c.source === 'src/components/Login.jsx')
    
    assert.ok(hasSymbol, 'ContextPackage should contain SYMBOL chunk')
    assert.ok(hasDependency, 'ContextPackage should contain DEPENDENCY chunk')

  } finally {
    // Restore
  }
})
