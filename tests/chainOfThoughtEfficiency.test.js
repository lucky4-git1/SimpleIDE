import test from 'node:test'
import assert from 'node:assert/strict'
import { LLMRouter } from '../src/services/agentEngine/LLMRouter.js'
import { MessageWindow, REASONING_POLICIES } from '../src/services/agentEngine/MessageWindow.js'
import { NativeToolAdapter } from '../src/services/agentEngine/NativeToolAdapter.js'
import { ToolCall } from '../src/services/agentEngine/ToolDefinition.js'

test('Chain of Thought & Reasoning Efficiency Suite', async (t) => {
  const router = new LLMRouter()

  await t.test('1. Extracts reasoning_content from DeepSeek/OpenAI compatible models', () => {
    const raw = {
      choices: [{
        message: {
          role: 'assistant',
          content: 'Here is the fixed file.',
          reasoning_content: 'The user has a missing import in index.js. I should add `import express from "express"`.'
        }
      }]
    }

    const reasoning = router.extractReasoning('deepseek', raw)
    assert.strictEqual(reasoning, 'The user has a missing import in index.js. I should add `import express from "express"`.')
    
    const visibleText = router.extractResponse('deepseek', raw)
    assert.strictEqual(visibleText, 'Here is the fixed file.')
  })

  await t.test('2. Extracts inline <thought> and <thinking> tags and strips them from visible response', () => {
    const raw = {
      choices: [{
        message: {
          role: 'assistant',
          content: '<thought>Inspecting workspace files first to understand structure.</thought>\nAll files inspected.'
        }
      }]
    }

    const reasoning = router.extractReasoning('openai', raw)
    assert.strictEqual(reasoning, 'Inspecting workspace files first to understand structure.')

    const visibleText = router.extractResponse('openai', raw)
    assert.strictEqual(visibleText, 'All files inspected.')
  })

  await t.test('3. Extracts Anthropic Claude 3.7 style thinking blocks', () => {
    const raw = {
      content: [
        { type: 'thinking', thinking: 'Analyzing the component hierarchy to prevent CSS overflow.' },
        { type: 'text', text: 'I updated the style to use max-w-full.' }
      ]
    }

    const reasoning = router.extractReasoning('anthropic', raw)
    assert.strictEqual(reasoning, 'Analyzing the component hierarchy to prevent CSS overflow.')

    const visibleText = router.extractResponse('anthropic', raw)
    assert.strictEqual(visibleText, 'I updated the style to use max-w-full.')
  })

  await t.test('4. Extracts Gemini 2.0 Flash Thinking thought parts', () => {
    const raw = {
      candidates: [{
        content: {
          parts: [
            { text: 'Planning to write index.html with responsive Tailwind layout.', thought: true },
            { text: 'Done creating index.html.' }
          ]
        }
      }]
    }

    const reasoning = router.extractReasoning('gemini', raw)
    assert.strictEqual(reasoning, 'Planning to write index.html with responsive Tailwind layout.')

    const visibleText = router.extractResponse('gemini', raw)
    assert.strictEqual(visibleText, 'Done creating index.html.')
  })

  await t.test('5. MessageWindow strips reasoning blocks on subsequent turns to maximize reasoning efficiency', () => {
    const window = new MessageWindow({ maxWindowTokens: 2000, reasoningPolicy: REASONING_POLICIES.NONE })
    window.seed([
      { role: 'user', content: 'Create a landing page' },
      {
        role: 'assistant',
        content: 'I will create index.html',
        reasoning_content: 'Step 1: Check existing assets. Step 2: Write html.',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'write_file', arguments: '{"path":"index.html"}' } }]
      }
    ])

    const report = window.build({ taskState: 'working' })
    const builtAssistant = report.messages.find(m => m.role === 'assistant')
    
    // Reasoning should be stripped from context window messages sent back to LLM
    assert.strictEqual(builtAssistant.reasoning_content, undefined)
    assert.ok(builtAssistant.tool_calls)
  })

  await t.test('6. NativeToolAdapter extracts tool calls from markdown when model outputs tool in text', () => {
    const textWithJson = 'I will now inspect the project files:\n```json\n{\n  "name": "list_files",\n  "arguments": { "path": "." }\n}\n```'
    const calls = NativeToolAdapter.extractToolCallsFromText(textWithJson)
    
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0].name, 'list_files')
    assert.deepStrictEqual(calls[0].args, { path: '.' })
  })
})
