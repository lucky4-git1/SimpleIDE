const PROMPT_TEMPLATES = {
  explain: (code) => `Explain this code clearly and concisely:\n\n\`\`\`\n${code}\n\`\`\``,
  fix: (code) => `Find and fix any errors or bugs in this code. Return the corrected code with brief explanations:\n\n\`\`\`\n${code}\n\`\`\``,
  optimize: (code) => `Optimize this code for better performance and readability. Return the improved code with explanations:\n\n\`\`\`\n${code}\n\`\`\``,
  custom: (code, question) => `Regarding this code:\n\n\`\`\`\n${code}\n\`\`\`\n\n${question}`,
  convert: (code, targetLang) => `Convert the following code to ${targetLang}. Ensure idiomatic patterns for the target language:\n\n\`\`\`\n${code}\n\`\`\``,
  test: (code) => `Generate comprehensive unit tests for the following code. Include edge cases:\n\n\`\`\`\n${code}\n\`\`\``,
  generate: (code, description) => `Based on this context:\n\n\`\`\`\n${code}\n\`\`\`\n\nGenerate the following: ${description}`,
  comment: (code) => `Add clear, helpful comments to this code to explain its logic and purpose:\n\n\`\`\`\n${code}\n\`\`\``,
  readme: (projectSummary) => `Generate a professional README.md for this project based on these files:\n\n${projectSummary}`,
  explain_project: (projectSummary) => `Explain the overall architecture and purpose of this project based on its file structure and content:\n\n${projectSummary}`,
}

// Simple in-memory cache and rate limiting
const responseCache = new Map()
let lastRequestTime = 0
const RATE_LIMIT_MS = 2000

// Catalog entries are deliberately explicit rather than fetched at runtime, so the
// settings dialog remains usable offline and always presents known-compatible IDs.
export const PROVIDER_CATALOG = {
  openai: {
    label: 'OpenAI',
    keyPlaceholder: 'sk-...',
    models: [
      'gpt-5.6-sol',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'gpt-4o',
      'gpt-4o-mini'
    ]
  },
  nvidia: {
    label: 'NVIDIA NIM (Free endpoints available)',
    keyPlaceholder: 'nvapi-...',
    // These NVIDIA API Catalog models use the OpenAI-compatible chat endpoint.
    models: [
      'google/gemma-4-31b-it',
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'minimaxai/minimax-m3',
      'nvidia/nemotron-3-ultra-550b-a55b',
      'stepfun-ai/step-3.7-flash',
      'meta/llama-3.1-70b-instruct',
      'meta/llama-3.1-8b-instruct',
      'qwen/qwen2.5-coder-32b-instruct',
      'mistralai/mixtral-8x7b-instruct'
    ]
  },
  openrouter: {
    label: 'OpenRouter',
    keyPlaceholder: 'sk-or-...',
    models: [
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'openrouter/free',
      'qwen/qwen3-next-80b-a3b-instruct:free',
      'meta-llama/llama-3.3-70b-instruct:free',
      'meta-llama/llama-3.2-3b-instruct:free',
      'google/gemma-3-27b-it:free'
    ]
  },
  groq: {
    label: 'Groq (Free tier available)',
    keyPlaceholder: 'gsk_...',
    models: [
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'meta-llama/llama-4-maverick-17b-128e-instruct',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'moonshotai/kimi-k2-instruct',
      'qwen/qwen3-32b',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant'
    ]
  },
  xai: {
    label: 'xAI (Grok)',
    keyPlaceholder: 'xai-...',
    models: ['grok-4', 'grok-3', 'grok-3-mini']
  },
  deepseek: {
    label: 'DeepSeek',
    keyPlaceholder: 'sk-...',
    models: ['deepseek-chat', 'deepseek-reasoner']
  },
  mistral: {
    label: 'Mistral AI',
    keyPlaceholder: '...',
    models: ['mistral-large-latest', 'codestral-latest', 'mistral-small-latest']
  },
  anthropic: {
    label: 'Anthropic',
    keyPlaceholder: 'sk-ant-...',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229']
  },
  ollama: {
    label: 'Ollama (Local)',
    keyPlaceholder: 'Not required',
    requiresApiKey: false,
    models: ['qwen2.5-coder:7b', 'llama3.2', 'deepseek-coder-v2']
  },
  lmstudio: {
    label: 'LM Studio (Local)',
    keyPlaceholder: 'Not required',
    requiresApiKey: false,
    models: ['local-model']
  }
}

export async function getApiConfig() {
  const config = await window.api.getAIConfig()
  return { ...config, apiKey: config.hasApiKey ? 'configured' : '' }
}

export async function saveApiConfig({ apiKey, model, provider }) {
  const result = await window.api.saveAIConfig({ apiKey: apiKey?.trim(), model, provider })
  if (!result.success) throw new Error(result.error)
  return result
}

// ── Live model discovery ─────────────────────────────────────────────────
// Returns the models the current key can actually call, so selectors show
// "current model + what my key gives me" instead of a hardcoded list.
// Results are cached per provider for 24h; catalog IDs are the fallback.
const liveModelsCache = new Map()
const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const modelsCacheKey = (provider) => `prime_ai_models_${provider}`

function readModelsCache(provider) {
  if (liveModelsCache.has(provider)) return liveModelsCache.get(provider)
  try {
    const raw = localStorage.getItem(modelsCacheKey(provider))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.models)) return null
    const entry = { ...parsed, source: 'cache' }
    liveModelsCache.set(provider, entry)
    return entry
  } catch {
    return null
  }
}

function writeModelsCache(provider, models) {
  const entry = { models, fetchedAt: Date.now(), source: 'live' }
  liveModelsCache.set(provider, entry)
  try {
    localStorage.setItem(modelsCacheKey(provider), JSON.stringify({ models, fetchedAt: entry.fetchedAt }))
  } catch { /* storage full — memory cache still works */ }
}

function isCacheFresh(entry) {
  return Boolean(entry?.fetchedAt) && (Date.now() - entry.fetchedAt) < MODELS_CACHE_TTL_MS
}

/**
 * List models accessible with the stored key (or a candidate `apiKey`
 * that has not been saved yet, e.g. while typing in settings).
 * Never throws — returns { models, source, error? }.
 */
export async function listProviderModels(provider, { apiKey, force = false } = {}) {
  const catalogModels = [...(PROVIDER_CATALOG[provider]?.models || [])]
  if (!window.api?.listModels) return { models: catalogModels, source: 'catalog' }
  if (!force) {
    const cached = readModelsCache(provider)
    if (cached && isCacheFresh(cached) && cached.models.length) return cached
  }
  try {
    const result = await window.api.listModels({ provider, apiKey })
    if (!result?.success || !Array.isArray(result.models)) {
      const cached = readModelsCache(provider)
      if (cached?.models?.length) return { ...cached, error: result?.error }
      return { models: catalogModels, source: 'catalog', error: result?.error }
    }
    // Keep catalog IDs the provider no longer advertises (custom/proxy
    // deployments), then the live list.
    const live = result.models.filter(id => !catalogModels.includes(id))
    const merged = [...catalogModels, ...live]
    writeModelsCache(provider, result.models)
    return { models: merged, liveModels: result.models, source: 'live' }
  } catch (error) {
    const cached = readModelsCache(provider)
    if (cached?.models?.length) return { ...cached, error: error.message }
    return { models: catalogModels, source: 'catalog', error: error.message }
  }
}

/**
 * Build selector options: current model pinned first, then live models,
 * then any remaining catalog IDs. Guarantees the current model is listed
 * even when the provider no longer advertises it.
 */
export function resolveModelOptions({ provider, currentModel, liveModels }) {
  const catalogModels = [...(PROVIDER_CATALOG[provider]?.models || [])]
  const live = Array.isArray(liveModels) ? liveModels : []
  const ordered = []
  const seen = new Set()
  const push = (id, meta = {}) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    ordered.push({ id, ...meta })
  }
  if (currentModel) push(currentModel, { current: true, live: live.includes(currentModel) })
  for (const id of live) push(id, { live: true })
  for (const id of catalogModels) push(id, { live: live.includes(id) })
  return ordered
}

import { globalRouter } from './agentEngine/LLMRouter.js'

function getEndpoint(provider) {
  return globalRouter.getEndpoint(provider)
}

export async function requestAIText({
  systemMessage,
  userMessage,
  useCache = true,
  temperature = 0.3,
  maxTokens = 4096,
  waitForRateLimit = false,
  signal,
  tools = null,
  messages = null,
  returnRaw = false,
  // Phase 1 bounded runs: optional observation-only measurement hook.
  // Absent by default; existing callers and return values are unchanged.
  usageSink = null,
  callType = 'agent',
  // Phase 5: optional per-request guard for hung provider connections.
  // Null preserves today's unbounded behavior; agent runs pass an explicit
  // documented default. Chat/autocomplete callers are unchanged.
  timeoutMs = null
}) {
  const throwIfCancelled = () => {
    if (signal?.aborted) {
      const error = new Error('Agent cancelled.')
      error.name = 'AbortError'
      throw error
    }
  }
  throwIfCancelled()
  const { apiKey, model, provider } = await getApiConfig()

  if (!apiKey && PROVIDER_CATALOG[provider]?.requiresApiKey !== false) {
    throw new Error('API key not configured. Go to AI Settings to add your key.')
  }

  const now = Date.now()
  if (now - lastRequestTime < RATE_LIMIT_MS) {
    if (!waitForRateLimit) {
      throw new Error('Please wait a moment before sending another request.')
    }
    // Abort-aware wait so Stop works even during rate-limit backoff.
    await new Promise((resolve, reject) => {
      const waitMs = RATE_LIMIT_MS - (now - lastRequestTime)
      const onAbort = () => {
        clearTimeout(timer)
        const error = new Error('Agent cancelled.')
        error.name = 'AbortError'
        reject(error)
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, waitMs)
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    throwIfCancelled()
  }
  lastRequestTime = now

  const cacheKey = `${provider}-${model}-${systemMessage}-${userMessage}-${JSON.stringify(messages || [])}`
  if (useCache && !returnRaw && responseCache.has(cacheKey)) {
    return responseCache.get(cacheKey)
  }

  const response = await globalRouter.routeRequest(
    { systemMessage, userMessage, maxTokens, temperature, tools, messages, returnRaw, usageSink, callType, timeoutMs },
    async (requestArgs) => {
      const requestId = crypto.randomUUID()
      const cancel = () => window.api.cancelAIRequest?.(requestId)
      signal?.addEventListener('abort', cancel, { once: true })
      const result = await window.api.aiRequest({ ...requestArgs, requestId })
      signal?.removeEventListener('abort', cancel)
      throwIfCancelled()
      if (result.error) {
        // Preserve the provider classification for bounded-retry decisions.
        const failure = new Error(result.error)
        if (result.category) failure.category = result.category
        throw failure
      }
      return result.data
    }
  )

  if (useCache && !returnRaw) responseCache.set(cacheKey, response)
  return response
}

export async function requestAIStream({ systemMessage, userMessage, onDelta, onRequestId, onThinking, timeoutMs = null }) {
  const { apiKey, model, provider } = await getApiConfig()
  if (!apiKey && PROVIDER_CATALOG[provider]?.requiresApiKey !== false) {
    throw new Error('API key not configured. Go to AI Settings to add your key.')
  }
  const requestId = crypto.randomUUID()
  onRequestId?.(requestId)
  // Sampling configuration comes from the model profile inside
  // formatPayload (Ultra: temperature 1, top_p 0.95, max_tokens 16384);
  // unlisted models keep the historical 4096 / 0.3 values.
  const body = globalRouter.formatPayload(provider, model, systemMessage, userMessage, 4096, 0.3)
  
  let endpoint = getEndpoint(provider)
  if (provider === 'gemini') {
    endpoint = `${endpoint}/${model}:streamGenerateContent`
  }

  return new Promise((resolve, reject) => {
    const unsubscribe = window.api.onAIStreamEvent(event => {
      if (event.requestId !== requestId) return
      if (event.type === 'delta') onDelta?.(event.delta)
      if (event.type === 'thinking') onThinking?.(event.thinking)
      if (event.type === 'done') { unsubscribe(); resolve() }
      if (event.type === 'cancelled') { unsubscribe(); resolve({ cancelled: true }) }
      if (event.type === 'error') {
        unsubscribe()
        const failure = new Error(event.error)
        if (event.category) failure.category = event.category
        reject(failure)
      }
    })
    window.api.startAIStream({ requestId, endpoint, provider, body, timeoutMs })
  })
}

export async function askAI({ prompt, code, action = 'custom', question = '', context = '' }) {
  const systemMessage = 'You are a helpful coding assistant integrated into a desktop IDE. Be concise and precise. When returning code, use markdown code blocks with the appropriate language.'

  let userMessage
  if (action === 'custom' && code) {
    userMessage = PROMPT_TEMPLATES.custom(code, question || prompt)
  } else if (action === 'custom') {
    userMessage = prompt
  } else if (PROMPT_TEMPLATES[action]) {
    userMessage = PROMPT_TEMPLATES[action](code || context)
  } else {
    userMessage = prompt
  }

  return requestAIText({ systemMessage, userMessage })
}

export { PROMPT_TEMPLATES }
