import { ipcMain, app, safeStorage } from 'electron'
import { join } from 'path'
import fs from 'fs/promises'
import { classifyProviderError, extractErrorMessage, extractStreamDeltas, timeoutError } from './aiResponse.js'

const activeAIStreams = new Map()
const activeAIRequests = new Map()

// Phase 5: optional per-request guard for hung provider connections (opt-in
// via timeoutMs; absent preserves today's unbounded behavior). User
// cancellation always wins: only when the caller's controller did NOT abort
// is an abort classified as a provider timeout.
function requestSignal(controller, timeoutMs) {
  const ms = Number(timeoutMs)
  if (!Number.isFinite(ms) || ms <= 0 || typeof AbortSignal.timeout !== 'function') {
    return { signal: controller.signal, isTimeout: () => false }
  }
  const timeout = AbortSignal.timeout(ms)
  if (typeof AbortSignal.any !== 'function') {
    return { signal: controller.signal, isTimeout: () => false }
  }
  const signal = AbortSignal.any([controller.signal, timeout])
  return { signal, isTimeout: () => !controller.signal.aborted && signal.aborted }
}

const aiConfigPath = () => join(app.getPath('userData'), 'prime-ai-config.json')

const MODELS_ENDPOINTS = {
  openai: 'https://api.openai.com/v1/models',
  groq: 'https://api.groq.com/openai/v1/models',
  xai: 'https://api.x.ai/v1/models',
  nvidia: 'https://integrate.api.nvidia.com/v1/models',
  openrouter: 'https://openrouter.ai/api/v1/models',
  deepseek: 'https://api.deepseek.com/models',
  mistral: 'https://api.mistral.ai/v1/models',
  ollama: 'http://127.0.0.1:11434/v1/models',
  lmstudio: 'http://127.0.0.1:1234/v1/models'
}

// Non-chat entries the /models endpoints also return (audio, images,
// embeddings, moderation, rerankers). The IDE only needs chat models.
const NON_CHAT_MODEL_PATTERNS = [
  /whisper/i, /tts/i, /stt/i, /embed/i, /rerank/i, /moderation/i,
  /guard/i, /dall-?e/i, /imagen/i, /image/i, /vision/i, /asr/i,
  /transcri/i, /sora/i, /video/i, /audio/i
]

// Auth + attribution headers differ per provider. OpenRouter requires
// HTTP-Referer / X-Title on some keys and rejects bare requests;
// Anthropic uses x-api-key instead of Bearer; Gemini takes ?key=.
function buildProviderHeaders(provider, credential) {
  const headers = { 'Content-Type': 'application/json' }
  if (provider === 'anthropic') {
    if (credential) headers['x-api-key'] = credential
    headers['anthropic-version'] = '2023-06-01'
    return { headers, keyInQuery: false }
  }
  if (credential) headers['Authorization'] = `Bearer ${credential}`
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://simple-ide.local'
    headers['X-Title'] = 'Simple IDE'
  }
  return { headers, keyInQuery: provider === 'gemini' }
}

function withQueryKey(url, provider, credential) {
  if (provider === 'gemini' && credential) {
    return url.includes('?') ? `${url}&key=${encodeURIComponent(credential)}` : `${url}?key=${encodeURIComponent(credential)}`
  }
  return url
}

async function readResponseBody(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    // Gateways/proxies sometimes answer with plain text or HTML.
    return { message: text.slice(0, 500) }
  }
}

export async function readAIConfig() {
  try {
    const stored = JSON.parse(await fs.readFile(aiConfigPath(), 'utf-8'))
    const apiKey = stored.key && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(stored.key, 'base64'))
      : ''
    return { provider: stored.provider || 'openai', model: stored.model || 'gpt-5.6-sol', apiKey }
  } catch {
    return { provider: 'openai', model: 'gpt-5.6-sol', apiKey: '' }
  }
}

export async function saveAIConfig({ provider, model, apiKey }) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable on this device.')
  const previous = await readAIConfig()
  const key = apiKey === undefined || apiKey === '' ? previous.apiKey : apiKey
  const payload = {
    provider: provider || previous.provider,
    model: model || previous.model,
    key: key ? safeStorage.encryptString(key).toString('base64') : ''
  }
  await fs.writeFile(aiConfigPath(), JSON.stringify(payload), 'utf-8')
  return { provider: payload.provider, model: payload.model, hasApiKey: Boolean(key) }
}

export function registerAiIPC() {
  ipcMain.handle('ai-request', async (_, { endpoint, apiKey, provider, body, requestId, timeoutMs }) => {
    const controller = new AbortController()
    if (requestId) activeAIRequests.set(requestId, controller)
    const { signal: reqSignal, isTimeout } = requestSignal(controller, timeoutMs)
    try {
      const secureConfig = await readAIConfig()
      const isLocalProvider = provider === 'ollama' || provider === 'lmstudio'
      const credential = isLocalProvider ? '' : (secureConfig.apiKey || apiKey)
      if (!credential && !isLocalProvider && provider !== 'gemini') return { error: 'API key not configured. Open AI Settings to add a key.' }

      const { headers } = buildProviderHeaders(provider, credential)
      const response = await fetch(withQueryKey(endpoint, provider, credential), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: reqSignal
      })
      const data = await readResponseBody(response)
      if (!response.ok) {
        const { category, message } = classifyProviderError(response.status, data)
        return category ? { error: message, category } : { error: message }
      }
      return { success: true, data }
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        if (isTimeout()) {
          const { category, message } = timeoutError(timeoutMs)
          return { error: message, category }
        }
        return { error: 'Request cancelled.', cancelled: true }
      }
      return { error: error.message }
    } finally {
      if (requestId) activeAIRequests.delete(requestId)
    }
  })

  ipcMain.on('ai-request:cancel', (_, requestId) => activeAIRequests.get(requestId)?.abort())

  ipcMain.handle('ai-config:get', async () => {
    const config = await readAIConfig()
    return { provider: config.provider, model: config.model, hasApiKey: Boolean(config.apiKey) }
  })

  ipcMain.handle('ai-config:save', async (_, config) => {
    try {
      return { success: true, ...(await saveAIConfig(config)) }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // Live model discovery: GET the provider's OpenAI-compatible /models
  // endpoint with the stored key (or an explicitly passed candidate key).
  // This is what powers "only show models my key can actually use".
  ipcMain.handle('ai-models:list', async (_, { provider, apiKey } = {}) => {
    try {
      const modelsUrl = MODELS_ENDPOINTS[provider]
      if (!modelsUrl) return { error: `Model listing is not supported for provider '${provider}'.` }
      const secureConfig = await readAIConfig()
      const isLocalProvider = provider === 'ollama' || provider === 'lmstudio'
      const credential = isLocalProvider ? '' : (apiKey || secureConfig.apiKey)
      if (!credential && !isLocalProvider) return { error: 'API key not configured. Open AI Settings to add a key.' }

      const { headers } = buildProviderHeaders(provider, credential)
      const response = await fetch(modelsUrl, { method: 'GET', headers })
      const data = await readResponseBody(response)
      if (!response.ok) {
        return { error: extractErrorMessage(data, response.status) }
      }
      const ids = Array.isArray(data?.data)
        ? data.data.map(entry => entry?.id).filter(id => typeof id === 'string' && id.length > 0)
        : []
      const chatModels = ids.filter(id => !NON_CHAT_MODEL_PATTERNS.some(pattern => pattern.test(id)))
      chatModels.sort((a, b) => a.localeCompare(b))
      return { success: true, models: chatModels }
    } catch (error) {
      return { error: error.message }
    }
  })

  ipcMain.on('ai-stream:start', async (event, { requestId, endpoint, provider, body, timeoutMs }) => {
    const controller = new AbortController()
    activeAIStreams.set(requestId, controller)
    const { signal: reqSignal, isTimeout } = requestSignal(controller, timeoutMs)
    const send = (type, payload = {}) => event.sender.send('ai-stream:event', { requestId, type, ...payload })
    try {
      const secureConfig = await readAIConfig()
      const isLocalProvider = provider === 'ollama' || provider === 'lmstudio'
      const credential = isLocalProvider ? '' : secureConfig.apiKey
      if (!credential && !isLocalProvider && provider !== 'gemini') throw new Error('API key not configured. Open AI Settings to add a key.')

      const { headers } = buildProviderHeaders(provider, credential)
      const response = await fetch(withQueryKey(endpoint, provider, credential), {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, stream: true }),
        signal: reqSignal
      })
      if (!response.ok || !response.body) {
        const data = !response.body ? null : await readResponseBody(response).catch(() => null)
        const { category, message } = classifyProviderError(response.status, data)
        const classified = new Error(message)
        if (category) classified.category = category
        throw classified
      }
      
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let textDeltas = 0
      let thinkingDeltas = 0
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          try {
            const packet = JSON.parse(data)
            const { thinking, text } = extractStreamDeltas(packet)
            // Reasoning models (e.g. Nemotron Ultra) stream reasoning_content
            // deltas before any visible content. Forward them as distinct
            // thinking events; previously they were silently dropped, which
            // made long reasoning phases look like a hang.
            if (thinking) {
              thinkingDeltas += 1
              send('thinking', { thinking })
            }
            if (text) {
              textDeltas += 1
              send('delta', { delta: text })
            }
          } catch { /* Ignore keep-alive */ }
        }
      }
      if (textDeltas === 0 && thinkingDeltas === 0) {
        const empty = new Error('NVIDIA returned an empty stream: the connection closed without any content or reasoning events.')
        empty.category = 'PROVIDER_EMPTY_RESPONSE'
        throw empty
      }
      send('done')
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        if (isTimeout()) {
          const { category, message } = timeoutError(timeoutMs)
          send('error', { error: message, category })
        } else {
          send('cancelled')
        }
      }
      else send('error', { error: error.message, category: error.category || null })
    } finally {
      activeAIStreams.delete(requestId)
    }
  })

  ipcMain.on('ai-stream:cancel', (_, requestId) => activeAIStreams.get(requestId)?.abort())
}
