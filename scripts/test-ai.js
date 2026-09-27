// Test script for AI API providers
// Usage: node scripts/test-ai.js <provider> <api-key>
// Example: node scripts/test-ai.js openai sk-...
// Example: node scripts/test-ai.js xai xai-...

const provider = process.argv[2] || 'openai'
const apiKey = process.argv[3] || process.env.OPENAI_API_KEY

if (!apiKey) {
  console.error('❌ No API key provided.')
  console.error('Usage: node scripts/test-ai.js <provider> <api-key>')
  console.error('  Providers: openai, xai, groq')
  process.exit(1)
}

console.log(`\n🔑 Provider: ${provider}`)
console.log(`🔑 API Key length: ${apiKey.length} chars`)
console.log(`🔑 Key prefix: ${apiKey.substring(0, 6)}...`)

const configs = {
  openai: {
    endpoint: 'https://api.openai.com/v1/responses',
    body: {
      model: 'gpt-4.1-mini',
      input: 'Say hello in one sentence.',
    },
  },
  xai: {
    endpoint: 'https://api.x.ai/v1/chat/completions',
    body: {
      model: 'grok-3-mini',
      messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
      max_tokens: 50,
    },
  },
  groq: {
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    body: {
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
      max_tokens: 50,
    },
  },
}

const config = configs[provider]
if (!config) {
  console.error(`❌ Unknown provider: ${provider}`)
  console.error('  Use: openai, xai, or groq')
  process.exit(1)
}

async function test() {
  console.log(`\n📡 Endpoint: ${config.endpoint}`)
  console.log(`📡 Model: ${config.body.model}`)
  console.log('📡 Sending request...\n')

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(config.body),
    })

    console.log(`📊 Status: ${response.status} ${response.statusText}`)

    const data = await response.json()

    if (!response.ok) {
      console.error('\n❌ API Error:')
      console.error(JSON.stringify(data, null, 2))
      process.exit(1)
    }

    console.log('\n✅ Success!')
    if (provider === 'openai') {
      console.log('Response:', data.output_text || JSON.stringify(data, null, 2))
    } else {
      console.log('Response:', data.choices?.[0]?.message?.content || JSON.stringify(data, null, 2))
    }
  } catch (error) {
    console.error('\n❌ Fetch error:', error.message)
    process.exit(1)
  }
}

test()
