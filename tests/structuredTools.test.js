import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { ToolDefinition, ToolCall, TOOL_PERMISSIONS, TOOL_CATEGORIES, zodToJsonSchema } from '../src/services/agentEngine/ToolDefinition.js'
import { ToolRunner } from '../src/services/agentEngine/ToolRunner.js'
import { normalizeActionToToolCall } from '../src/services/agentService.js'

function createMockApi(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles))

  return {
    files,
    async readFile(path) {
      if (files.has(path)) return { success: true, content: files.get(path) }
      return { success: false, error: 'ENOENT: file not found' }
    },
    async writeFile(path, content) {
      files.set(path, content)
      return { success: true }
    },
    async deleteFile(path) {
      if (files.has(path)) {
        files.delete(path)
        return { success: true }
      }
      return { success: false, error: 'File does not exist' }
    },
    async runCommand({ command }) {
      return { success: true, stdout: 'ok', stderr: '', durationMs: 10 }
    }
  }
}

describe('Structured Native Tool Architecture — Milestone 2 Test Suite', () => {
  const root = 'C:/mock/workspace'

  test('1. Valid tool argument validation using Zod', async () => {
    const mockApi = createMockApi({ [`${root}/src/test.txt`]: 'hello' })
    const runner = new ToolRunner(root, { api: mockApi })

    const res = await runner.run('read_file', { path: 'src/test.txt' })
    assert.equal(res.success, true)
    assert.equal(res.data.content, 'hello')
  })

  test('2. Invalid tool argument validation fails with Zod error details', async () => {
    const mockApi = createMockApi()
    const runner = new ToolRunner(root, { api: mockApi })

    // Non-string path should fail Zod validation
    const res = await runner.run('read_file', { path: 12345 })
    assert.equal(res.success, false)
    assert.match(res.error, /Invalid tool arguments for 'read_file'/)
  })

  test('3. Legacy JSON action normalization to ToolCall', () => {
    const legacyAction = { type: 'write_file', path: 'src/file.js', content: 'const x = 1;' }
    const toolCall = normalizeActionToToolCall(legacyAction)

    assert.ok(toolCall instanceof ToolCall)
    assert.equal(toolCall.name, 'write_file')
    assert.equal(toolCall.args.path, 'src/file.js')
    assert.equal(toolCall.args.content, 'const x = 1;')
  })

  test('4. Permission metadata categorization', () => {
    const mockApi = createMockApi()
    const runner = new ToolRunner(root, { api: mockApi })
    const tools = runner.getAvailableTools()

    const readFileTool = tools.find(t => t.name === 'read_file')
    const deleteFileTool = tools.find(t => t.name === 'delete_file')

    assert.equal(readFileTool.permission, TOOL_PERMISSIONS.SAFE)
    assert.equal(deleteFileTool.permission, TOOL_PERMISSIONS.APPROVAL)
  })

  test('5. Category metadata tagging', () => {
    const mockApi = createMockApi()
    const runner = new ToolRunner(root, { api: mockApi })
    const tools = runner.getAvailableTools()

    assert.equal(tools.find(t => t.name === 'read_file').category, TOOL_CATEGORIES.READ)
    assert.equal(tools.find(t => t.name === 'write_file').category, TOOL_CATEGORIES.WRITE)
    assert.equal(tools.find(t => t.name === 'run_command').category, TOOL_CATEGORIES.EXECUTE)
    assert.equal(tools.find(t => t.name === 'git_status').category, TOOL_CATEGORIES.GIT)
    assert.equal(tools.find(t => t.name === 'browser_navigate').category, TOOL_CATEGORIES.BROWSER)
  })

  test('6. Destructive tool triggers AWAITING_USER_APPROVAL if unapproved', async () => {
    const mockApi = createMockApi({ [`${root}/delete_me.txt`]: 'trash' })
    const runner = new ToolRunner(root, { api: mockApi })

    // Unapproved execution
    const resUnapproved = await runner.run('delete_file', { path: 'delete_me.txt' })
    assert.equal(resUnapproved.success, false)
    assert.equal(resUnapproved.data.status, 'AWAITING_USER_APPROVAL')
    assert.equal(mockApi.files.has(`${root}/delete_me.txt`), true)

    // Approved execution
    const resApproved = await runner.run('delete_file', { path: 'delete_me.txt' }, { approved: true })
    assert.equal(resApproved.success, true)
    assert.equal(mockApi.files.has(`${root}/delete_me.txt`), false)
  })

  test('7. Direct execution of native ToolCall object', async () => {
    const mockApi = createMockApi()
    const runner = new ToolRunner(root, { api: mockApi })
    const toolCall = new ToolCall({ name: 'write_file', args: { path: 'hello.txt', content: 'world' } })

    const res = await runner.run(toolCall)
    assert.equal(res.success, true)
    assert.equal(mockApi.files.get(`${root}/hello.txt`), 'world')
  })

  test('8. JSON Schema generation from Zod definitions for LLM providers', () => {
    const sampleSchema = z.object({
      path: z.string().describe('Relative file path'),
      lines: z.number().optional()
    })

    const jsonSchema = zodToJsonSchema(sampleSchema)

    assert.equal(jsonSchema.type, 'object')
    assert.equal(jsonSchema.properties.path.type, 'string')
    assert.equal(jsonSchema.properties.lines.type, 'number')
    assert.deepEqual(jsonSchema.required, ['path'])
  })

  test('9. Blocked command pattern rejection', async () => {
    const mockApi = createMockApi()
    const runner = new ToolRunner(root, { api: mockApi })

    const res = await runner.run('run_command', { command: 'rm -rf /' })
    assert.equal(res.success, false)
    assert.match(res.error, /blocked for safety/)
  })

  test('10. Incomplete standalone HTML is rejected and cannot be validated as a delivery', async () => {
    const mockApi = createMockApi()
    const runner = new ToolRunner(root, { api: mockApi })
    const partialDocument = '<!doctype html><html><head><title>Draft</title></head><body><!-- Add more gradients as needed --><main style="width: 111u">...</main></body></html>'

    const write = await runner.run('write_file', { path: 'index.html', content: partialDocument })
    assert.equal(write.success, false)
    assert.match(write.error, /Refusing to write an incomplete standalone HTML document/)

    mockApi.files.set(`${root}/index.html`, partialDocument)
    const validation = await runner.run('validate_standalone_html', { path: 'index.html' })
    assert.equal(validation.success, true)
    assert.equal(validation.data.valid, false)
    assert.ok(validation.data.issues.length > 0)
  })
})
