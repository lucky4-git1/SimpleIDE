import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgentTask } from '../src/services/agentService.js'

test('End-to-End Agent Creation with Chain of Thought & Reasoning Efficiency', async () => {
  const root = 'C:/test/cot_workspace'
  const files = {}
  const recordedEvents = []
  const recordedPayloads = []
  let requestCount = 0

  const mockApi = {
    listFiles: async () => ({ success: true, children: [] }),
    readFile: async (p) => ({ success: true, content: files[p] || '' }),
    writeFile: async (p, c) => { files[p] = c; return { success: true } },
    deleteFile: async (p) => { delete files[p]; return { success: true } },
    executeCommand: async () => ({ success: true, stdout: 'ok', stderr: '' }),
    getAIConfig: async () => ({ hasApiKey: true, model: 'deepseek-r1', provider: 'deepseek' }),
    aiRequest: async (args) => {
      requestCount++
      recordedPayloads.push(args)

      // Turn 1: Model generates Chain of Thought reasoning and calls write_file
      if (requestCount === 1) {
        return {
          success: true,
          data: {
            choices: [{
              message: {
                role: 'assistant',
                content: 'I will now create the HeroBanner component.',
                reasoning_content: '1. ORIENT: Build a responsive dark-mode hero banner.\n2. HYPOTHESIZE: Use Tailwind-style dark card styling with glowing accents.\n3. EXECUTE: Call write_file to src/HeroBanner.jsx.\n4. VERIFY: Ensure clean syntax.',
                tool_calls: [{
                  id: 'tc_hero_1',
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({
                      path: 'src/HeroBanner.jsx',
                      content: 'export default function HeroBanner() { return <section className="p-8 bg-zinc-950 text-white rounded-2xl border border-white/10"><h1>NextGen AI</h1></section> }'
                    })
                  }
                }]
              }
            }]
          }
        }
      }

      // Turn 2: Model finishes with completion summary and reasoning
      return {
        success: true,
        data: {
          choices: [{
            message: {
              role: 'assistant',
              content: 'Successfully created the HeroBanner component in src/HeroBanner.jsx with sleek dark theme and border accents.',
              reasoning_content: 'File creation succeeded. All deliverables are complete and verified.',
              tool_calls: [{
                id: 'tc_finish',
                type: 'function',
                function: {
                  name: 'finish',
                  arguments: JSON.stringify({ message: 'HeroBanner component created cleanly.' })
                }
              }]
            }
          }]
        }
      }
    }
  }

  const previousWindow = globalThis.window
  globalThis.window = { api: mockApi }

  try {
    const result = await runAgentTask({
      taskId: 'cot-test-1',
      task: 'Create a dark-mode HeroBanner component',
      context: { currentFolder: root, commandApproval: 'review' },
      tools: { api: mockApi },
      onEvent: (evt) => {
        recordedEvents.push(evt)
      }
    })

    // 1. Verify task completed successfully
    assert.strictEqual(result.status, 'Completed')

    // 2. Verify file was created by tool runner
    assert.ok(files['C:/test/cot_workspace/src/HeroBanner.jsx'], 'HeroBanner.jsx should be written')
    assert.ok(files['C:/test/cot_workspace/src/HeroBanner.jsx'].includes('NextGen AI'))

    // 3. Verify thinking event was captured with Chain of Thought
    const thinkingEvents = recordedEvents.filter(e => e.type === 'thinking')
    const cotEvents = thinkingEvents.filter(e => !e.message.startsWith('Execution step'))
    assert.strictEqual(cotEvents.length, 2, 'Should emit extracted reasoning for both turns')
    assert.ok(cotEvents[0].message.includes('1. ORIENT: Build a responsive dark-mode hero banner.'))
    assert.ok(cotEvents[1].message.includes('File creation succeeded.'))

    // 4. Verify reasoning efficiency: subsequent turn request payload must NOT contain reasoning_content
    assert.strictEqual(recordedPayloads.length, 2)
    const turn2Messages = recordedPayloads[1].body?.messages || []
    const turn2AssistantMsg = turn2Messages.find(m => m.role === 'assistant')
    assert.ok(turn2AssistantMsg, 'Turn 2 should include assistant message')
    assert.strictEqual(turn2AssistantMsg.reasoning_content, undefined, 'Previous turn reasoning_content must be stripped for context efficiency')

  } finally {
    globalThis.window = previousWindow
  }
})
