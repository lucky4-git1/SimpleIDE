import { getApiConfig } from './aiService'

let lastRequestTime = 0
const AUTOCOMPLETE_RATE_LIMIT = 500 // ms

export async function getInlineCompletions(prefix, suffix) {
  const { apiKey, model, provider } = getApiConfig()
  
  if (!apiKey) return null

  const now = Date.now()
  if (now - lastRequestTime < AUTOCOMPLETE_RATE_LIMIT) return null
  lastRequestTime = now

  const prompt = `You are an inline code completion engine. Complete the code between the prefix and suffix.
Return ONLY the completion text that should be inserted at the cursor position. Do not include any explanations, markdown, or backticks.

PREFIX:
${prefix}

SUFFIX:
${suffix}

COMPLETION:`

  const endpoint = provider === 'openai' 
    ? 'https://api.openai.com/v1/responses' 
    : provider === 'groq' 
      ? 'https://api.groq.com/openai/v1/chat/completions'
      : 'https://api.x.ai/v1/chat/completions'

  let body
  if (provider === 'openai') {
    body = {
      model: 'gpt-4.1-mini', // Use a fast model for autocomplete
      instructions: "Return ONLY the code completion. No prose.",
      input: prompt
    }
  } else {
    body = {
      model: provider === 'groq' ? 'llama3-8b-8192' : 'grok-beta',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 100,
      temperature: 0.1
    }
  }

  try {
    const result = await window.api.aiRequest({ endpoint, apiKey, body })
    if (result.success) {
      let text = provider === 'openai' 
        ? result.data.output_text 
        : result.data.choices?.[0]?.message?.content
      
      return text?.replace(/^```[a-z]*\n|```$/g, '').trimEnd()
    }
  } catch (e) {
    console.error("Autocomplete error:", e)
  }
  
  return null
}
