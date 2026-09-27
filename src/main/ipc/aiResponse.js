// Pure helpers for AI provider responses. This module has no Electron
// dependencies so it can be unit-tested with plain node:test. It is shared
// by the Electron main-process IPC handlers (src/main/ipc/ai.ipc.js).

export function extractErrorMessage(data, status) {
  if (!data) return `API request failed (${status})`
  if (typeof data?.error === 'string') return data.error
  if (typeof data?.error?.message === 'string') return data.error.message
  if (typeof data?.message === 'string') return data.message
  return `API request failed (${status})`
}

// Classify provider-side gateway/overload failures so the UI can tell them
// apart from application errors. The strings preserve the original provider
// message. HTTP 503/504 statuses can only come from upstream; per-request
// timeouts (Phase 5, opt-in via timeoutMs) are classified separately below
// and never confused with user cancellation.
export function classifyProviderError(status, data) {
  const message = extractErrorMessage(data, status)
  const text = String(message || '')
  if (status === 504) {
    return { category: 'PROVIDER_GATEWAY_TIMEOUT', message: `NVIDIA gateway timeout (provider-side): ${text}. The model did not respond before the provider gateway gave up — retrying may succeed.` }
  }
  if (status === 503 || /ResourceExhausted/i.test(text) || /temporarily overloaded/i.test(text) || /overloaded/i.test(text)) {
    return { category: 'PROVIDER_OVERLOADED', message: `NVIDIA provider overloaded: ${text}. Wait a moment and retry.` }
  }
  return { category: null, message }
}

// Classify a per-request timeout (no HTTP response arrived in time). Distinct
// from cancellation (user-initiated abort) and from HTTP gateway errors.
// Retryable within the agent's bounded retry policy.
export function timeoutError(timeoutMs) {
  const seconds = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs / 1000) : null
  const when = seconds !== null ? ` after ${seconds}s` : ''
  return {
    category: 'PROVIDER_TIMEOUT',
    message: `Provider request timed out${when} without a response (provider-side; the model did not answer in time). A bounded retry may succeed.`
  }
}

// Split one parsed SSE data packet into reasoning vs visible text.
// Reasoning models (e.g. Nemotron Ultra on NVIDIA) stream
// choices[].delta.reasoning_content before any choices[].delta.content.
// Returns { thinking, text }; either may be ''. Missing/null/non-string
// fields safely yield ''.
export function extractStreamDeltas(packet) {
  const rawDelta = packet?.choices?.[0]?.delta ?? packet?.delta ?? {}
  const thinking = typeof rawDelta?.reasoning_content === 'string' ? rawDelta.reasoning_content : ''
  const text = typeof rawDelta === 'string'
    ? rawDelta
    : (typeof rawDelta?.content === 'string' ? rawDelta.content : '')
  return { thinking, text }
}
