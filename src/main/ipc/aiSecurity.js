// ── aiSecurity.js ─────────────────────────────────────────────────────────────
// SSRF and credential exfiltration protection for AI IPC endpoints.
// ─────────────────────────────────────────────────────────────────────────────

export const ALLOWED_AI_HOST_PATTERNS = [
  /^https:\/\/api\.openai\.com(?::443)?(?:\/.*)?$/i,
  /^https:\/\/api\.anthropic\.com(?::443)?(?:\/.*)?$/i,
  /^https:\/\/generativelanguage\.googleapis\.com(?::443)?(?:\/.*)?$/i,
  /^https:\/\/api\.groq\.com(?::443)?(?:\/.*)?$/i,
  /^https:\/\/api\.x\.ai(?::443)?(?:\/.*)?$/i,
  /^https:\/\/integrate\.api\.nvidia\.com(?::443)?(?:\/.*)?$/i,
  /^https:\/\/openrouter\.ai(?::443)?(?:\/.*)?$/i,
  /^https:\/\/api\.deepseek\.com(?::443)?(?:\/.*)?$/i,
  /^https:\/\/api\.mistral\.ai(?::443)?(?:\/.*)?$/i,
  /^http:\/\/(?:127\.0\.0\.1|localhost):11434(?:\/.*)?$/i,
  /^http:\/\/(?:127\.0\.0\.1|localhost):1234(?:\/.*)?$/i,
]

/**
 * Validates that an AI provider endpoint matches the approved provider allowlist.
 * Prevents malicious renderer scripts from exfiltrating stored API credentials via SSRF.
 *
 * @param {string} endpoint
 * @returns {boolean}
 */
export function isAllowedAIEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') return false
  try {
    const parsed = new URL(endpoint)
    if (parsed.protocol === 'http:') {
      if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return false
    } else if (parsed.protocol !== 'https:') {
      return false
    }
    return ALLOWED_AI_HOST_PATTERNS.some(pattern => pattern.test(parsed.origin + parsed.pathname))
  } catch {
    return false
  }
}
