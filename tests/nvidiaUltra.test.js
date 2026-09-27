import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  getModelCapabilities,
  getModelRequestProfile,
  MODEL_REQUEST_PROFILES,
  LLMRouter
} from '../src/services/agentEngine/LLMRouter.js'
import { classifyProviderError, extractStreamDeltas } from '../src/main/ipc/aiResponse.js'

const ULTRA = 'nvidia/nemotron-3-ultra-550b-a55b'
const LIGHTNING = 'nvidia/nemotron-3.5-lightning-30b-a3b'
const router = new LLMRouter(async () => ({}))

describe('Ultra model request profile', () => {
  test('Ultra resolves to the validated profile', () => {
    assert.deepStrictEqual(getModelRequestProfile('nvidia', ULTRA), {
      temperature: 1,
      top_p: 0.95,
      maxTokens: 16384
    })
  })

  test('profile lookup is case-insensitive on the model id', () => {
    assert.ok(getModelRequestProfile('nvidia', ULTRA.toUpperCase()))
  })

  test('Lightning has no profile (existing behavior preserved)', () => {
    assert.strictEqual(getModelRequestProfile('nvidia', LIGHTNING), null)
  })

  test('other NVIDIA models have no profile', () => {
    assert.strictEqual(getModelRequestProfile('nvidia', 'meta/llama-3.1-70b-instruct'), null)
    assert.strictEqual(getModelRequestProfile('nvidia', 'qwen/qwen2.5-coder-32b-instruct'), null)
  })

  test('Ultra profile never applies to other providers', () => {
    assert.strictEqual(getModelRequestProfile('openai', ULTRA), null)
    assert.strictEqual(getModelRequestProfile('openrouter', ULTRA), null)
  })

  test('profile contains no hosted-rejected parameters', () => {
    const profiles = Object.values(MODEL_REQUEST_PROFILES)
    assert.ok(profiles.length > 0)
    for (const entry of profiles) {
      assert.ok(!('reasoning_budget' in entry))
      assert.ok(!('thinking_token_budget' in entry))
      assert.ok(!('chat_template_kwargs' in entry))
    }
  })

  test('Ultra payload uses profile values', () => {
    const payload = router.formatPayload('nvidia', ULTRA, 'sys', 'hi', 4096, 0.3)
    assert.strictEqual(payload.model, ULTRA)
    assert.strictEqual(payload.max_tokens, 16384)
    assert.strictEqual(payload.temperature, 1)
    assert.strictEqual(payload.top_p, 0.95)
  })

  test('Ultra payload keeps tools wiring alongside profile values', () => {
    const tools = [{ type: 'function', function: { name: 'read_file', description: 'r', parameters: {} } }]
    const payload = router.formatPayload('nvidia', ULTRA, 'sys', 'hi', 4096, 0.15, { tools })
    assert.strictEqual(payload.max_tokens, 16384)
    assert.strictEqual(payload.temperature, 1)
    assert.strictEqual(payload.top_p, 0.95)
    assert.strictEqual(payload.tools, tools)
    assert.strictEqual(payload.tool_choice, 'auto')
    assert.strictEqual(payload.parallel_tool_calls, false)
  })

  test('Lightning payload is byte-identical to pre-profile behavior', () => {
    const payload = router.formatPayload('nvidia', LIGHTNING, 'sys', 'hi', 4096, 0.3)
    assert.deepStrictEqual(payload, {
      model: LIGHTNING,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' }
      ],
      max_tokens: 4096,
      temperature: 0.3
    })
    assert.ok(!('top_p' in payload))
  })

  test('other providers are unaffected (openai / anthropic / gemini)', () => {
    const openai = router.formatPayload('openai', 'gpt-4o', 'sys', 'hi', 4096, 0.3)
    assert.strictEqual(openai.max_tokens, 4096)
    assert.strictEqual(openai.temperature, 0.3)
    assert.ok(!('top_p' in openai))

    const anthropic = router.formatPayload('anthropic', 'claude-x', 'sys', 'hi', 4096, 0.3)
    assert.strictEqual(anthropic.max_tokens, 4096)
    assert.ok(!('top_p' in anthropic))

    const gemini = router.formatPayload('gemini', 'gemini-2.0-flash', 'sys', 'hi', 4096, 0.3)
    assert.strictEqual(gemini.generationConfig.maxOutputTokens, 4096)
  })
})

describe('Ultra capability metadata', () => {
  test('Ultra reports the documented hosted context window', () => {
    const caps = getModelCapabilities('nvidia', ULTRA)
    assert.strictEqual(caps.contextWindowTokens, 262144)
  })

  test('Lightning capabilities are unchanged', () => {
    const caps = getModelCapabilities('nvidia', LIGHTNING)
    assert.strictEqual(caps.contextWindowTokens, 128000)
    assert.strictEqual(caps.supportsNativeTools, true)
    assert.strictEqual(caps.maxOutputTokens, 4096)
  })
})

describe('SSE reasoning delta extraction (captured live chunk shapes)', () => {
  test('reasoning-only chunk yields thinking, no text', () => {
    const packet = { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'The' }, finish_reason: null }] }
    assert.deepStrictEqual(extractStreamDeltas(packet), { thinking: 'The', text: '' })
  })

  test('mixed chunk yields both thinking and text', () => {
    const packet = { choices: [{ index: 0, delta: { content: 'The sea', role: 'assistant', reasoning_content: '.' }, finish_reason: null }] }
    assert.deepStrictEqual(extractStreamDeltas(packet), { thinking: '.', text: 'The sea' })
  })

  test('content-only chunk yields text, no thinking', () => {
    const packet = { choices: [{ index: 0, delta: { content: ' stretches', role: 'assistant' }, finish_reason: null }] }
    assert.deepStrictEqual(extractStreamDeltas(packet), { thinking: '', text: ' stretches' })
  })

  test('role-only chunk yields neither (empty-stream input)', () => {
    const packet = { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }
    assert.deepStrictEqual(extractStreamDeltas(packet), { thinking: '', text: '' })
  })

  test('missing, null, and non-string fields are safe', () => {
    assert.deepStrictEqual(extractStreamDeltas({}), { thinking: '', text: '' })
    assert.deepStrictEqual(extractStreamDeltas(null), { thinking: '', text: '' })
    assert.deepStrictEqual(
      extractStreamDeltas({ choices: [{ delta: { reasoning_content: null, content: 42 } }] }),
      { thinking: '', text: '' }
    )
  })

  test('reasoning-first ordering survives a full captured sequence', () => {
    const chunks = [
      { choices: [{ delta: { role: 'assistant', reasoning_content: 'The' } }] },
      { choices: [{ delta: { role: 'assistant', reasoning_content: ' user wants two short' } }] },
      { choices: [{ delta: { content: 'The sea', role: 'assistant', reasoning_content: '.' } }] },
      { choices: [{ delta: { content: ' stretches', role: 'assistant' } }] }
    ]
    const events = []
    for (const chunk of chunks) {
      const split = extractStreamDeltas(chunk)
      if (split.thinking) events.push(['thinking', split.thinking])
      if (split.text) events.push(['delta', split.text])
    }
    assert.deepStrictEqual(events.map((entry) => entry[0]), ['thinking', 'thinking', 'thinking', 'delta', 'delta'])
    assert.strictEqual(events[0][1], 'The')
    assert.strictEqual(events[3][1], 'The sea')
  })
})

describe('provider gateway error classification', () => {
  test('504 maps to PROVIDER_GATEWAY_TIMEOUT and keeps the provider message', () => {
    const result = classifyProviderError(504, { error: { message: 'Gateway Timeout', type: 'Timeout' } })
    assert.strictEqual(result.category, 'PROVIDER_GATEWAY_TIMEOUT')
    assert.ok(result.message.includes('Gateway Timeout'))
    assert.ok(result.message.includes('provider-side'))
    assert.ok(!result.message.toLowerCase().includes('application timed out'))
  })

  test('503 maps to PROVIDER_OVERLOADED', () => {
    const result = classifyProviderError(503, { error: { message: 'Service temporarily overloaded', type: 'Service Unavailable', code: 503 } })
    assert.strictEqual(result.category, 'PROVIDER_OVERLOADED')
    assert.ok(result.message.includes('Service temporarily overloaded'))
  })

  test('ResourceExhausted maps to PROVIDER_OVERLOADED', () => {
    const result = classifyProviderError(503, { error: { message: 'ResourceExhausted: Worker local total request limit reached (163/32)', type: 'Service Unavailable' } })
    assert.strictEqual(result.category, 'PROVIDER_OVERLOADED')
    assert.ok(result.message.includes('ResourceExhausted'))
  })

  test('ordinary 400 errors stay unclassified but actionable', () => {
    const result = classifyProviderError(400, { error: { message: 'thinking_token_budget is not yet supported', type: 'Bad Request' } })
    assert.strictEqual(result.category, null)
    assert.ok(result.message.includes('thinking_token_budget'))
  })

  test('missing body still produces a status-based message', () => {
    const result = classifyProviderError(504, null)
    assert.strictEqual(result.category, 'PROVIDER_GATEWAY_TIMEOUT')
    assert.ok(result.message.includes('504'))
  })
})
