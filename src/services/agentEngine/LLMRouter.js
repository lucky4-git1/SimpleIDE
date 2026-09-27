import { estimateTokens } from './ContextChunk.js'
import { LEDGER_CALL_TYPES } from './RunLedger.js'

export const MODEL_CAPABILITY_REGISTRY = {
  'gpt-4.1': { contextWindow: 1000000, maxOutput: 8192, reasoning: true, nativeTools: true, latencyClass: 'standard', inputPerMTok: 2.0, outputPerMTok: 8.0 },
  'gpt-4.1-mini': { contextWindow: 1000000, maxOutput: 8192, reasoning: false, nativeTools: true, latencyClass: 'fast', inputPerMTok: 0.4, outputPerMTok: 1.6 },
  'gpt-4.1-nano': { contextWindow: 1000000, maxOutput: 4096, reasoning: false, nativeTools: true, latencyClass: 'fast', inputPerMTok: 0.1, outputPerMTok: 0.4 },
  'gpt-4o': { contextWindow: 128000, maxOutput: 4096, reasoning: false, nativeTools: true, latencyClass: 'standard', inputPerMTok: 2.5, outputPerMTok: 10.0 },
  'gpt-4o-mini': { contextWindow: 128000, maxOutput: 4096, reasoning: false, nativeTools: true, latencyClass: 'fast', inputPerMTok: 0.15, outputPerMTok: 0.6 },
  'deepseek-chat': { contextWindow: 128000, maxOutput: 4096, reasoning: false, nativeTools: true, latencyClass: 'fast', inputPerMTok: 0.14, outputPerMTok: 0.28 },
  'deepseek-reasoner': { contextWindow: 128000, maxOutput: 8192, reasoning: true, nativeTools: true, latencyClass: 'reasoning', inputPerMTok: 0.55, outputPerMTok: 2.19 },
  'llama-3.3-70b-versatile': { contextWindow: 128000, maxOutput: 4096, reasoning: false, nativeTools: true, latencyClass: 'fast', inputPerMTok: 0.59, outputPerMTok: 0.79 },
  'llama-3.1-8b-instant': { contextWindow: 128000, maxOutput: 4096, reasoning: false, nativeTools: true, latencyClass: 'fast', inputPerMTok: 0.05, outputPerMTok: 0.08 },
  'qwen2.5-coder:7b': { contextWindow: 32768, maxOutput: 2048, reasoning: false, nativeTools: true, latencyClass: 'fast', inputPerMTok: 0.0, outputPerMTok: 0.0 },
  'llama3.2': { contextWindow: 128000, maxOutput: 4096, reasoning: false, nativeTools: true, latencyClass: 'fast', inputPerMTok: 0.0, outputPerMTok: 0.0 },
  'nvidia/nemotron-3-ultra-550b-a55b': { contextWindow: 262144, maxOutput: 16384, reasoning: true, nativeTools: true, latencyClass: 'reasoning', inputPerMTok: 1.0, outputPerMTok: 3.0 }
}

export const TOOL_FAMILY_MAP = {
  filesystem: ['read_file', 'write_file', 'create_file', 'edit_file', 'replace_in_file', 'delete_file', 'rename_file', 'move_file', 'list_files', 'directory_tree'],
  editor: ['read_file', 'write_file', 'create_file', 'edit_file', 'replace_in_file', 'format_code'],
  search: ['search_workspace', 'read_file', 'list_files'],
  git: ['git_status', 'git_diff', 'git_stage', 'git_unstage', 'git_commit', 'git_push', 'git_pull'],
  terminal: ['run_command', 'read_process_output', 'stop_process', 'list_processes'],
  testing: ['run_command', 'verify', 'read_file'],
  browser: ['browser_action', 'open_in_browser'],
  diagnostics: ['read_file', 'run_command', 'rollback']
}

export function filterToolsByFamily(allTools, toolFamily) {
  if (!toolFamily || toolFamily === 'none' || !TOOL_FAMILY_MAP[toolFamily]) {
    return allTools
  }
  const allowed = new Set(TOOL_FAMILY_MAP[toolFamily])
  allowed.add('finish')
  allowed.add('read_file')

  const filtered = (allTools || []).filter(tool => {
    const name = typeof tool === 'string' ? tool : tool?.name
    return allowed.has(name)
  })

  return filtered.length >= 2 ? filtered : allTools
}

export function getModelCapabilities(provider, model) {
  const p = String(provider || '').toLowerCase()
  const m = String(model || '').toLowerCase()

  const knownNativeProviders = new Set([
    'openai', 'nvidia', 'groq', 'openrouter', 'xai', 'deepseek', 'mistral', 'anthropic'
  ])

  const registered = MODEL_CAPABILITY_REGISTRY[m]
  const contextWindowTokens = registered?.contextWindow || (p === 'anthropic' || p === 'gemini' ? 200000 : 128000)

  if (!knownNativeProviders.has(p)) {
    return {
      providerId: p || 'unknown',
      modelId: m || 'unknown',
      supportsNativeTools: false,
      supportsStreamingToolCalls: false,
      supportsStructuredOutput: false,
      supportsReasoning: false,
      contextWindowTokens,
      maxOutputTokens: registered?.maxOutput || 2048,
      latencyClass: registered?.latencyClass || 'standard',
      pricing: { input: registered?.inputPerMTok || 0, output: registered?.outputPerMTok || 0 }
    }
  }

  const supportsReasoning = registered?.reasoning ?? (m.includes('o1') || m.includes('o3') || m.includes('sol') || m.includes('reasoner'))

  return {
    providerId: p,
    modelId: m,
    supportsNativeTools: true,
    supportsStreamingToolCalls: p === 'openai',
    supportsStructuredOutput: true,
    supportsReasoning,
    contextWindowTokens,
    maxOutputTokens: registered?.maxOutput || 4096,
    latencyClass: registered?.latencyClass || (supportsReasoning ? 'reasoning' : 'standard'),
    pricing: { input: registered?.inputPerMTok || 0, output: registered?.outputPerMTok || 0 }
  }
}

// Per-model request profiles for the hosted NVIDIA endpoint
// (https://integrate.api.nvidia.com/v1). Measured 2026-09: Ultra needs
// ~28-56s TTFT on trivial prompts while Lightning answers in <2.5s, and the
// hosted tier returns 503 under load. Ultra shares one max_tokens budget
// between reasoning and visible output, so it requires NVIDIA's documented
// sampling configuration (temperature 1, top_p 0.95, large max_tokens).
//
// IMPORTANT: reasoning_budget / thinking_token_budget / chat_template_kwargs
// are REJECTED by this hosted endpoint
// (400: thinking_token_budget is not yet supported by the V2 model runner)
// and must never be added here. Only models listed below are affected;
// every other provider/model keeps existing behavior.
export const MODEL_REQUEST_PROFILES = {
  'nvidia/nemotron-3-ultra-550b-a55b': {
    temperature: 1,
    top_p: 0.95,
    maxTokens: 16384
  }
}

export function getModelRequestProfile(provider, model) {
  // Strict provider match: the same model id can appear under other
  // providers (e.g. OpenRouter), where this profile is untested and must
  // not leak. Only the NVIDIA hosted path is in scope.
  if (String(provider || '').toLowerCase() !== 'nvidia') return null
  const profile = MODEL_REQUEST_PROFILES[String(model || '').toLowerCase()]
  return profile ? { ...profile } : null
}

export class LLMRouter {
  constructor(apiConfigFetcher) {
    this.getConfig = apiConfigFetcher;
  }

  getModelCapabilities(provider, model) {
    return getModelCapabilities(provider, model)
  }

  getEndpoint(provider) {
    switch (provider) {
      case 'openai': return 'https://api.openai.com/v1/chat/completions';
      case 'anthropic': return 'https://api.anthropic.com/v1/messages';
      case 'gemini': return 'https://generativelanguage.googleapis.com/v1beta/models';
      case 'groq': return 'https://api.groq.com/openai/v1/chat/completions';
      case 'xai': return 'https://api.x.ai/v1/chat/completions';
      case 'nvidia': return 'https://integrate.api.nvidia.com/v1/chat/completions';
      case 'openrouter': return 'https://openrouter.ai/api/v1/chat/completions';
      case 'deepseek': return 'https://api.deepseek.com/chat/completions';
      case 'mistral': return 'https://api.mistral.ai/v1/chat/completions';
      case 'ollama': return 'http://127.0.0.1:11434/v1/chat/completions';
      case 'lmstudio': return 'http://127.0.0.1:1234/v1/chat/completions';
      default: return 'https://api.openai.com/v1/chat/completions';
    }
  }

  formatPayload(provider, model, systemMessage, userMessage, maxTokens, temperature, { tools = null, messages = null, topP = null } = {}) {
    const p = String(provider || '').toLowerCase()

    // A listed model profile overrides the caller-supplied sampling
    // configuration so chat, agent, and plan paths all send validated
    // values without per-callsite branching. Unlisted models are untouched.
    const profile = getModelRequestProfile(provider, model)
    const effectiveMaxTokens = profile?.maxTokens ?? maxTokens
    const effectiveTemperature = profile?.temperature ?? temperature
    const effectiveTopP = topP ?? profile?.top_p ?? null

    // Anthropic formatting
    if (p === 'anthropic') {
      const msgList = Array.isArray(messages) && messages.length > 0
        ? messages
        : [{ role: 'user', content: userMessage }]

      const payload = {
        model,
        system: systemMessage,
        messages: msgList,
        max_tokens: maxTokens,
        temperature
      }
      if (tools) payload.tools = tools
      return payload
    }

    // Gemini formatting
    if (p === 'gemini') {
      const msgList = Array.isArray(messages) && messages.length > 0
        ? messages
        : [{ role: 'user', parts: [{ text: `${systemMessage}\n\n${userMessage}` }] }]

      const payload = {
        contents: msgList,
        generationConfig: { maxOutputTokens: maxTokens, temperature }
      }
      if (tools) payload.tools = tools
      return payload
    }

    // Default OpenAI-compatible formatting
    const msgList = Array.isArray(messages) && messages.length > 0
      ? messages
      : [
          { role: 'system', content: systemMessage },
          { role: 'user', content: userMessage }
        ]

    const payload = {
      model,
      messages: msgList,
      max_tokens: effectiveMaxTokens,
      temperature: effectiveTemperature
    }
    if (effectiveTopP !== null && effectiveTopP !== undefined) payload.top_p = effectiveTopP
    if (tools) {
      payload.tools = tools
      payload.tool_choice = 'auto'
      payload.parallel_tool_calls = false
    }
    return payload
  }

  extractResponse(provider, data) {
    if (provider === 'anthropic') {
      return data.content?.[0]?.text || '';
    }
    if (provider === 'gemini') {
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
    // OpenAI-compatible response parsing
    return data.choices?.[0]?.message?.content || data.output_text || '';
  }

  /**
   * Normalize provider token-usage payloads to
   * { input, output, total, reasoning } (non-negative numbers or null).
   * Shapes differ per provider; anything unrecognized yields nulls rather
   * than throwing, so providers without usage never break requests.
   */
  extractUsage(provider, data) {
    const empty = { input: null, output: null, total: null, reasoning: null }
    if (!data || typeof data !== 'object') return { ...empty }
    const p = String(provider || '').toLowerCase()
    const num = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)

    // Anthropic Messages: { usage: { input_tokens, output_tokens } }
    if (p === 'anthropic') {
      const usage = data.usage || {}
      return {
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        total: num(usage.input_tokens) !== null && num(usage.output_tokens) !== null
          ? num(usage.input_tokens) + num(usage.output_tokens)
          : null,
        reasoning: null
      }
    }

    // Gemini: { usageMetadata: { promptTokenCount, candidatesTokenCount,
    // totalTokenCount, thoughtsTokenCount } }
    if (p === 'gemini') {
      const usage = data.usageMetadata || data.usage || {}
      return {
        input: num(usage.promptTokenCount),
        output: num(usage.candidatesTokenCount),
        total: num(usage.totalTokenCount),
        reasoning: num(usage.thoughtsTokenCount)
      }
    }

    // Default OpenAI-compatible: { usage: { prompt_tokens,
    // completion_tokens, total_tokens, completion_tokens_details: {
    // reasoning_tokens } } }
    const usage = data.usage || {}
    const details = usage.completion_tokens_details || {}
    return {
      input: num(usage.prompt_tokens),
      output: num(usage.completion_tokens),
      total: num(usage.total_tokens),
      reasoning: num(details.reasoning_tokens)
    }
  }

  async routeRequest(requestArgs, performNetworkRequest) {
    const { systemMessage, userMessage, maxTokens = 4096, temperature = 0.3, tools = null, messages = null, returnRaw = false, usageSink = null, callType = 'agent', timeoutMs = null } = requestArgs;
    const config = await this.getConfig();
    
    if (!config.hasApiKey && !['ollama', 'lmstudio'].includes(config.provider)) {
      throw new Error('API key not configured.');
    }

    const endpoint = this.getEndpoint(config.provider);
    let payload = this.formatPayload(config.provider, config.model, systemMessage, userMessage, maxTokens, temperature, { tools, messages });
    
    // For Gemini, endpoint needs model appended
    let finalEndpoint = endpoint;
    if (config.provider === 'gemini') {
      finalEndpoint = `${endpoint}/${config.model}:generateContent`;
    }

    const startedAt = Date.now()
    const data = await (async () => {
      try {
        return await performNetworkRequest({
          endpoint: finalEndpoint,
          apiKey: config.apiKey,
          provider: config.provider,
          body: payload,
          timeoutMs
        })
      } catch (error) {
        // Failed attempts still count: the prompt was composed and sent (or
        // attempted), so its estimate accrues conservatively with no output.
        // Outcome attribution distinguishes user cancel from provider failure.
        const cancelled = (error && error.name === 'AbortError') || false
        this.reportUsage(requestArgs, { usageSink, callType, provider: config.provider, model: config.model, payload, outputText: null, data: null, failed: !cancelled, durationMs: Date.now() - startedAt, outcome: cancelled ? 'cancelled' : 'failed', failureCategory: (error && error.category) || null });
        throw error
      }
    })();

    if (returnRaw) {
      this.reportUsage(requestArgs, { usageSink, callType, provider: config.provider, model: config.model, payload, outputText: null, data, durationMs: Date.now() - startedAt, outcome: 'ok' });
      return data
    }

    const text = this.extractResponse(config.provider, data);
    this.reportUsage(requestArgs, { usageSink, callType, provider: config.provider, model: config.model, payload, outputText: text, data, durationMs: Date.now() - startedAt, outcome: 'ok' });
    return text;
  }

  /**
   * Observation-only measurement hook for Phase 1 bounded runs. Computes a
   * deterministic input estimate from the exact payload sent, normalizes
   * provider usage, and forwards both to an optional sink. Never throws and
   * never alters the request or response.
   */
  reportUsage(requestArgs, { usageSink, callType, provider, model, payload, outputText, data, failed = false, durationMs = null, outcome = null, failureCategory = null }) {
    if (typeof usageSink !== 'function') return;
    try {
      let inputEst = 0;
      try {
        inputEst = estimateTokens(typeof payload === 'string' ? payload : JSON.stringify(payload));
      } catch {
        inputEst = 0;
      }
      usageSink({
        model,
        provider,
        callType: Object.values(LEDGER_CALL_TYPES).includes(callType) ? callType : LEDGER_CALL_TYPES.OTHER,
        inputEst,
        outputText,
        usage: this.extractUsage(provider, data),
        failed,
        durationMs,
        outcome: outcome === 'ok' || outcome === 'failed' || outcome === 'cancelled' ? outcome : (failed ? 'failed' : 'ok'),
        failureCategory: typeof failureCategory === 'string' && failureCategory ? failureCategory : null
      });
    } catch {
      // Measurement must never break a model call.
    }
  }
}

// Export a singleton instance if needed
export const globalRouter = new LLMRouter(async () => {
  return await window.api.getAIConfig();
});
