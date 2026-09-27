import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ToolDefinition, ToolCall, ToolResult, TOOL_PERMISSIONS, TOOL_CATEGORIES } from '../src/services/agentEngine/ToolDefinition.js'
import { NativeToolAdapter } from '../src/services/agentEngine/NativeToolAdapter.js'
import { getModelCapabilities, globalRouter } from '../src/services/agentEngine/LLMRouter.js'
import { ToolRunner } from '../src/services/agentEngine/ToolRunner.js'
import { ProjectIndexer } from '../src/services/agentEngine/ProjectIndexer.js'
import { globalContextEngine } from '../src/services/agentEngine/ContextEngine.js'
import { runAgentTask } from '../src/services/agentService.js'
import { z } from 'zod'

describe('Milestone 2 — True Native Provider Tool Calling Test Matrix', () => {

  const sampleTools = [
    new ToolDefinition({
      name: 'read_file',
      description: 'Read a workspace file',
      inputSchema: z.object({ path: z.string() }),
      permission: TOOL_PERMISSIONS.SAFE,
      category: TOOL_CATEGORIES.READ,
      execute: async () => ({ success: true })
    }),
    new ToolDefinition({
      name: 'write_file',
      description: 'Write a workspace file',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      permission: TOOL_PERMISSIONS.CAUTION,
      category: TOOL_CATEGORIES.WRITE,
      execute: async () => ({ success: true })
    })
  ]

  test('1. OpenAI-style tool schema formatting', () => {
    const schemas = NativeToolAdapter.formatToolsForProvider('openai', sampleTools)
    assert.strictEqual(schemas.length, 2)
    assert.strictEqual(schemas[0].type, 'function')
    assert.strictEqual(schemas[0].function.name, 'read_file')
    assert.strictEqual(schemas[0].function.description, 'Read a workspace file')
    assert.ok(schemas[0].function.parameters.properties.path)
  })

  test('2. Anthropic-style tool schema formatting', () => {
    const schemas = NativeToolAdapter.formatToolsForProvider('anthropic', sampleTools)
    assert.strictEqual(schemas.length, 2)
    assert.strictEqual(schemas[0].name, 'read_file')
    assert.strictEqual(schemas[0].description, 'Read a workspace file')
    assert.ok(schemas[0].input_schema.properties.path)
  })

  test('3. Gemini-style function declaration formatting', () => {
    const schemas = NativeToolAdapter.formatToolsForProvider('gemini', sampleTools)
    assert.strictEqual(schemas.length, 1)
    assert.ok(Array.isArray(schemas[0].functionDeclarations))
    assert.strictEqual(schemas[0].functionDeclarations.length, 2)
    assert.strictEqual(schemas[0].functionDeclarations[0].name, 'read_file')
  })

  test('4. Native response -> canonical ToolCall (OpenAI)', () => {
    const rawData = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_abc123',
                function: {
                  name: 'read_file',
                  arguments: JSON.stringify({ path: 'src/App.jsx' })
                }
              }
            ]
          }
        }
      ]
    }
    const calls = NativeToolAdapter.extractNativeToolCalls('openai', rawData)
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0].id, 'call_abc123')
    assert.strictEqual(calls[0].name, 'read_file')
    assert.strictEqual(calls[0].args.path, 'src/App.jsx')
  })

  test('5. Multiple native tool calls in single response', () => {
    const rawData = {
      choices: [
        {
          message: {
            tool_calls: [
              { id: 'call_1', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.js' }) } },
              { id: 'call_2', function: { name: 'read_file', arguments: JSON.stringify({ path: 'b.js' }) } }
            ]
          }
        }
      ]
    }
    const calls = NativeToolAdapter.extractNativeToolCalls('openai', rawData)
    assert.strictEqual(calls.length, 2)
    assert.strictEqual(calls[0].name, 'read_file')
    assert.strictEqual(calls[1].name, 'read_file')
    assert.strictEqual(calls[0].args.path, 'a.js')
    assert.strictEqual(calls[1].args.path, 'b.js')
  })

  test('6. Native ToolCall -> ToolRunner execution', async () => {
    const root = 'C:/test/m2_workspace'
    const mockApi = {
      readFile: async () => ({ success: true, content: 'export const x = 1' })
    }
    const runner = new ToolRunner(root, { api: mockApi })
    const toolCall = new ToolCall({ id: 'tc1', name: 'read_file', args: { path: 'src/file.js' } })
    
    const outcome = await runner.run(toolCall)
    assert.strictEqual(outcome.success, true)
    assert.strictEqual(outcome.data.content, 'export const x = 1')
  })

  test('7. Zod schema rejection of invalid arguments', async () => {
    const root = 'C:/test/m2_workspace'
    const runner = new ToolRunner(root)
    const toolCall = new ToolCall({ id: 'tc2', name: 'read_file', args: {} }) // missing required path
    
    const outcome = await runner.run(toolCall)
    assert.strictEqual(outcome.success, false)
    assert.ok(outcome.error.includes('invalid') || outcome.error.includes('path') || outcome.error.includes('Required'))
  })

  test('8. Permission rejection (BLOCKED permission)', async () => {
    const root = 'C:/test/m2_workspace'
    const runner = new ToolRunner(root)
    runner.register(new ToolDefinition({
      name: 'blocked_tool',
      description: 'Dangerous operation',
      permission: TOOL_PERMISSIONS.BLOCKED,
      execute: async () => ({ success: true })
    }))

    const toolCall = new ToolCall({ id: 'tc3', name: 'blocked_tool', args: {} })
    const outcome = await runner.run(toolCall)
    assert.strictEqual(outcome.success, false)
    assert.ok(outcome.error.includes('permanently blocked'))
  })

  test('9. AWAITING_USER_APPROVAL for APPROVAL-gated tools', async () => {
    const root = 'C:/test/m2_workspace'
    const runner = new ToolRunner(root)
    const toolCall = new ToolCall({ id: 'tc4', name: 'delete_file', args: { path: 'file.js' } })
    
    // Execute without approval flag
    const outcome = await runner.run(toolCall)
    assert.strictEqual(outcome.success, false)
    assert.strictEqual(outcome.data.status, 'AWAITING_USER_APPROVAL')
  })

  test('10. Blocked operation pattern rejection (rm -rf)', async () => {
    const root = 'C:/test/m2_workspace'
    const runner = new ToolRunner(root)
    const toolCall = new ToolCall({ id: 'tc5', name: 'run_command', args: { command: 'rm -rf /' } })
    
    const outcome = await runner.run(toolCall)
    assert.strictEqual(outcome.success, false)
    assert.ok(outcome.error.includes('blocked for safety'))
  })

  test('11. Canonical ToolResult -> Provider native tool result message', () => {
    const toolResult = new ToolResult({
      toolCallId: 'call_123',
      name: 'read_file',
      success: true,
      output: { content: 'hello world' }
    })

    const openaiMsg = NativeToolAdapter.formatToolResultMessage('openai', toolResult)
    assert.strictEqual(openaiMsg.role, 'tool')
    assert.strictEqual(openaiMsg.tool_call_id, 'call_123')
    assert.ok(openaiMsg.content.includes('hello world'))

    const anthropicMsg = NativeToolAdapter.formatToolResultMessage('anthropic', toolResult)
    assert.strictEqual(anthropicMsg.role, 'user')
    assert.strictEqual(anthropicMsg.content[0].type, 'tool_result')
    assert.strictEqual(anthropicMsg.content[0].tool_use_id, 'call_123')

    const geminiMsg = NativeToolAdapter.formatToolResultMessage('gemini', toolResult)
    assert.strictEqual(geminiMsg.role, 'user')
    assert.ok(geminiMsg.parts[0].functionResponse)
    assert.strictEqual(geminiMsg.parts[0].functionResponse.name, 'read_file')
  })

  test('12. Multi-turn native execution assistant message formatting', () => {
    const rawData = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{}' } }]
          }
        }
      ]
    }
    const asstMsg = NativeToolAdapter.formatAssistantMessage('openai', rawData)
    assert.strictEqual(asstMsg.role, 'assistant')
    assert.ok(Array.isArray(asstMsg.tool_calls))
    assert.strictEqual(asstMsg.tool_calls[0].id, 'call_1')
  })

  test('13. Fallback to LEGACY_STRUCTURED_JSON protocol for non-native providers', () => {
    const ollamaCaps = getModelCapabilities('ollama', 'llama3')
    const lmStudioCaps = getModelCapabilities('lmstudio', 'local-model')
    const unknownCaps = getModelCapabilities('custom_provider', 'custom_model')

    assert.strictEqual(ollamaCaps.supportsNativeTools, false)
    assert.strictEqual(lmStudioCaps.supportsNativeTools, false)
    assert.strictEqual(unknownCaps.supportsNativeTools, false)
  })

  test('14. Malformed native response fails safely', () => {
    const calls = NativeToolAdapter.extractNativeToolCalls('openai', { invalid: true })
    assert.strictEqual(calls.length, 0)
  })

  test('15. Missing capability metadata fallback', () => {
    const caps = getModelCapabilities(null, null)
    assert.strictEqual(caps.supportsNativeTools, false)
  })

  test('16. Native tool call -> M1.6 synchronous code intelligence AST update', async () => {
    globalThis.localStorage = {
      store: new Map(),
      getItem(k) { return this.store.get(k) || null },
      setItem(k, v) { this.store.set(k, v) },
      removeItem(k) { this.store.delete(k) }
    }

    const root = 'C:/test/m2_m16_workspace'
    const files = {
      'C:/test/m2_m16_workspace/src/auth.js': 'export function login() {}'
    }
    const mockApi = {
      getAIConfig: async () => ({ hasApiKey: true, model: 'gpt-5.6-sol', provider: 'openai' }),
      listFiles: async (dir) => {
        if (dir === 'C:/test/m2_m16_workspace') {
          return { success: true, children: [{ name: 'src', isDirectory: true, path: 'C:/test/m2_m16_workspace/src' }] }
        }
        if (dir === 'C:/test/m2_m16_workspace/src') {
          return { success: true, children: [{ name: 'auth.js', isDirectory: false, path: 'C:/test/m2_m16_workspace/src/auth.js' }] }
        }
        return { success: true, children: [] }
      },
      readFile: async (p) => {
        if (files[p] !== undefined) return { success: true, content: files[p] }
        return { success: false, error: 'ENOENT' }
      },
      writeFile: async (p, c) => { files[p] = c; return { success: true } }
    }

    globalThis.window = { api: mockApi }

    const indexer = new ProjectIndexer(root, { api: mockApi })
    await indexer.buildIndex()

    globalContextEngine.setCodeIntelligence(indexer.codeIntelligence)
    globalContextEngine.updateState({ workspacePath: root })

    let requestCount = 0
    mockApi.getAIConfig = async () => ({ hasApiKey: true, model: 'gpt-5.6-sol', provider: 'openai' })
    mockApi.aiRequest = async (args) => {
      requestCount++
      if (requestCount === 1) {
        return {
          success: true,
          data: {
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: 'call_native_edit',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({
                          path: 'src/auth.js',
                          content: 'export function loginV2() {}'
                        })
                      }
                    }
                  ]
                }
              }
            ]
          }
        }
      }
      return {
        success: true,
        data: {
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'call_native_finish',
                    function: {
                      name: 'finish',
                      arguments: JSON.stringify({ message: 'Done' })
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    }

    const result = await runAgentTask({
      task: 'Update login function',
      context: { currentFolder: root },
      tools: { api: mockApi },
      onEvent: (evt) => { if (evt.type === 'state.error' || evt.type === 'error') console.log('EVENT:', JSON.stringify(evt)) }
    })

    console.log('RESULT:', result.status, result.error, result.summary)
    assert.strictEqual(result.status, 'Completed')

    // Verify AST symbol was synchronously updated to loginV2
    const v2Sym = indexer.codeIntelligence.findSymbol('loginV2')
    const oldSym = indexer.codeIntelligence.findSymbol('login')
    assert.strictEqual(v2Sym.length, 1, 'loginV2 should exist in AST index immediately after native tool write')
    assert.strictEqual(oldSym.length, 0, 'old login symbol should be gone')
  })

  test('17. Native tool call + rollback synchronization', async () => {
    const root = 'C:/test/m2_rollback_workspace'
    const files = {
      'C:/test/m2_rollback_workspace/src/auth.js': 'export function login() {}'
    }
    const mockApi = {
      listFiles: async () => ({ success: true, children: [] }),
      readFile: async (p) => ({ success: true, content: files[p] || '' }),
      writeFile: async (p, c) => { files[p] = c; return { success: true } },
      deleteFile: async (p) => { delete files[p]; return { success: true } }
    }

    const indexer = new ProjectIndexer(root, { api: mockApi })
    await indexer.buildIndex()

    globalContextEngine.setCodeIntelligence(indexer.codeIntelligence)
    globalContextEngine.updateState({ workspacePath: root })

    const runner = new ToolRunner(root, {
      api: mockApi,
      onChange: change => globalContextEngine.notifyFileChange(change.path, change.after, change.operation)
    })

    runner.beginTransaction('native-tx-1')
    await runner.run(new ToolCall({
      id: 'nc1',
      name: 'write_file',
      args: { path: 'src/auth.js', content: 'export function loginV2() {}' }
    }))

    assert.strictEqual(indexer.codeIntelligence.findSymbol('loginV2').length, 1)

    // Rollback
    await runner.rollbackTransaction('native-tx-1')

    assert.strictEqual(indexer.codeIntelligence.findSymbol('login').length, 1)
    assert.strictEqual(indexer.codeIntelligence.findSymbol('loginV2').length, 0)
  })

  test('18. Large tool-result bounding (clip at 12000 chars)', () => {
    const largeText = 'A'.repeat(20000)
    const res = new ToolResult({ toolCallId: 'c1', name: 'read_file', success: true, output: largeText })
    const msg = NativeToolAdapter.formatToolResultMessage('openai', res)
    assert.ok(msg.content.length < 13000)
    assert.ok(msg.content.includes('[output truncated:'))
  })

  test('19. Cancellation during native execution', async () => {
    const root = 'C:/test/m2_cancel_workspace'
    const controller = new AbortController()
    const runner = new ToolRunner(root, { abortSignal: controller.signal })
    runner.beginTransaction('cancel-tx')
    
    controller.abort()

    await assert.rejects(async () => {
      await runner.run(new ToolCall({ id: 'c1', name: 'read_file', args: { path: 'test.js' } }))
    }, (err) => err.name === 'AbortError' || err.message.includes('cancelled'))
  })

})
