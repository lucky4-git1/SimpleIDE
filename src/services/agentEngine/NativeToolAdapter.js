import { ToolCall, ToolResult } from './ToolDefinition.js'

function clip(text, maxLength = 12000) {
  if (!text || typeof text !== 'string') return String(text || '')
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}\n\n[output truncated: ${text.length - maxLength} more characters]`
}

export class NativeToolAdapter {
  static READ_ONLY_TOOLS = new Set([
    'read_file',
    'read_files',
    'list_files',
    'search_files',
    'search_web',
    'search_images',
    'fetch_web_page',
    'get_symbol_definition',
    'find_definition',
    'find_references',
    'find_symbol',
    'find_implementations',
    'get_diagnostics',
    'get_callers',
    'get_import_graph',
    'search_documentation',
    'search_coding_knowledge',
    'browser_audit',
    'browser_screenshot',
    'browser_set_viewport',
    'validate_standalone_html',
    'browser_console_errors'
  ])

  static isReadOnlyTool(toolName) {
    return this.READ_ONLY_TOOLS.has(String(toolName || '').toLowerCase())
  }

  static createInitialMessages(provider, systemMessage, userMessage) {
    const p = String(provider || '').toLowerCase()
    if (p === 'anthropic') return [{ role: 'user', content: userMessage }]
    if (p === 'gemini') return [{ role: 'user', parts: [{ text: `${systemMessage}\n\n${userMessage}` }] }]
    return [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage }
    ]
  }

  /**
   * Converts canonical ToolDefinition array into provider-native tools declaration
   */
  static formatToolsForProvider(provider, toolsArray = []) {
    const p = String(provider || '').toLowerCase()
    if (!Array.isArray(toolsArray) || toolsArray.length === 0) return null

    if (p === 'anthropic') {
      return toolsArray.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.toJSONSchema ? t.toJSONSchema() : { type: 'object', properties: {} }
      }))
    }

    if (p === 'gemini') {
      return [{
        functionDeclarations: toolsArray.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.toJSONSchema ? t.toJSONSchema() : { type: 'object', properties: {} }
        }))
      }]
    }

    // Default OpenAI-compatible function declarations (openai, nvidia, groq, openrouter, deepseek, mistral, etc.)
    return toolsArray.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.toJSONSchema ? t.toJSONSchema() : { type: 'object', properties: {} }
      }
    }))
  }

  /**
   * Parses LLM response data and extracts an array of canonical ToolCall objects
   */
  static extractNativeToolCalls(provider, data) {
    const p = String(provider || '').toLowerCase()
    if (!data) return []

    const calls = []

    if (p === 'anthropic') {
      const contents = Array.isArray(data.content) ? data.content : []
      for (const item of contents) {
        if (item && item.type === 'tool_use') {
          calls.push(new ToolCall({
            id: item.id || `call_anthropic_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            name: item.name,
            args: item.input || {}
          }))
        }
      }
      return calls
    }

    if (p === 'gemini') {
      const parts = data.candidates?.[0]?.content?.parts || []
      for (let i = 0; i < parts.length; i++) {
        const fc = parts[i].functionCall
        if (fc && fc.name) {
          calls.push(new ToolCall({
            id: `call_gemini_${Date.now()}_${i}`,
            name: fc.name,
            args: fc.args || {}
          }))
        }
      }
      return calls
    }

    // OpenAI-compatible response format
    const choice = data.choices?.[0]
    const toolCalls = choice?.message?.tool_calls
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        if (tc && tc.function && tc.function.name) {
          let parsedArgs = {}
          try {
            parsedArgs = typeof tc.function.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : (tc.function.arguments || {})
          } catch (error) {
            calls.push(new ToolCall({
              id: tc.id || `call_openai_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
              name: tc.function.name,
              args: { __parseError: `Invalid JSON arguments: ${error.message}` }
            }))
            continue
          }
          calls.push(new ToolCall({
            id: tc.id || `call_openai_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            name: tc.function.name,
            args: parsedArgs
          }))
        }
      }
    }

    return calls
  }

  /**
   * Extracts the full assistant message object to store in conversation history
   */
  static formatAssistantMessage(provider, data) {
    const p = String(provider || '').toLowerCase()
    if (!data) return null

    if (p === 'anthropic') {
      return {
        role: 'assistant',
        content: data.content || []
      }
    }

    if (p === 'gemini') {
      return {
        role: 'model',
        parts: data.candidates?.[0]?.content?.parts || []
      }
    }

    // OpenAI-compatible format
    const msg = data.choices?.[0]?.message
    if (msg) {
      return {
        role: 'assistant',
        content: msg.content ?? null,
        tool_calls: msg.tool_calls || undefined
      }
    }

    return null
  }

  /**
   * Converts a canonical ToolResult into a provider-native tool result message
   */
  static formatToolResultMessage(provider, toolResult) {
    const p = String(provider || '').toLowerCase()
    const resultObj = toolResult instanceof ToolResult ? toolResult : new ToolResult(toolResult || {})
    const outputText = clip(resultObj.error ? `Error: ${resultObj.error}` : JSON.stringify(resultObj.output))

    if (p === 'anthropic') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: resultObj.toolCallId,
            content: outputText,
            is_error: !resultObj.success
          }
        ]
      }
    }

    if (p === 'gemini') {
      return {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: resultObj.name,
              response: {
                success: resultObj.success,
                output: resultObj.output,
                error: resultObj.error
              }
            }
          }
        ]
      }
    }

    // Default OpenAI-compatible format
    return {
      role: 'tool',
      tool_call_id: resultObj.toolCallId,
      content: outputText
    }
  }
}
