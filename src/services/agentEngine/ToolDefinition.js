import { z } from 'zod'

export const TOOL_PERMISSIONS = {
  SAFE: 'safe',
  CAUTION: 'caution',
  APPROVAL: 'approval',
  BLOCKED: 'blocked'
}

export const TOOL_CATEGORIES = {
  READ: 'READ',
  WRITE: 'WRITE',
  DELETE: 'DELETE',
  EXECUTE: 'EXECUTE',
  NETWORK: 'NETWORK',
  GIT: 'GIT',
  BROWSER: 'BROWSER',
  MEMORY: 'MEMORY'
}

/**
 * Standardized Tool Call representation
 */
export class ToolCall {
  constructor({ id, name, args = {} }) {
    this.id = id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
    this.name = name
    this.args = args && typeof args === 'object' ? args : {}
  }
}

/**
 * Standardized Tool Result representation
 */
export class ToolResult {
  constructor({ toolCallId, name, success, output = {}, error = null }) {
    this.toolCallId = toolCallId || `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
    this.name = name || 'unknown'
    this.success = Boolean(success)
    this.output = output
    this.error = error
  }
}

/**
 * Structured Native Tool Definition
 */
export class ToolDefinition {
  constructor({
    name,
    description,
    inputSchema,
    permission = TOOL_PERMISSIONS.SAFE,
    category = TOOL_CATEGORIES.READ,
    execute
  }) {
    if (!name || typeof name !== 'string') throw new Error('ToolDefinition requires a string name.')
    if (!description || typeof description !== 'string') throw new Error('ToolDefinition requires a description.')
    if (!execute || typeof execute !== 'function') throw new Error('ToolDefinition requires an execute function.')

    this.name = name
    this.description = description
    this.inputSchema = inputSchema || z.object({}).passthrough()
    this.permission = permission
    this.category = category
    this.execute = execute
  }

  validateArgs(args = {}) {
    return this.inputSchema.safeParse(args)
  }

  toJSONSchema() {
    return zodToJsonSchema(this.inputSchema)
  }
}

/**
 * Converts a Zod Schema to a simple JSON Schema object for LLM Provider Tool Definitions
 */
export function zodToJsonSchema(schema) {
  if (!schema) return { type: 'object', properties: {} }

  try {
    // Zod v4 ships a native exporter. Prefer it so array item types, defaults,
    // nested objects, enums, and descriptions survive into the provider tool schema.
    if (typeof z.toJSONSchema === 'function') {
      const exported = z.toJSONSchema(schema, { target: 'draft-7' })
      if (exported && typeof exported === 'object') {
        const { $schema, ...jsonSchema } = exported
        return jsonSchema
      }
    }

    // Compatibility fallback for older Zod installations.
    let shape = {}
    if (typeof schema.shape === 'function') {
      shape = schema.shape()
    } else if (schema.shape && typeof schema.shape === 'object') {
      shape = schema.shape
    } else if (typeof schema._def?.shape === 'function') {
      shape = schema._def.shape()
    } else if (schema._def?.shape) {
      shape = schema._def.shape
    }

    const properties = {}
    const required = []

    for (const [key, value] of Object.entries(shape)) {
      let node = value
      let isOptional = false
      let description = node?._def?.description || ''

      while (node && node._def) {
        const typeStr = String(node._def.type || node._def.typeName || '').toLowerCase()
        if (typeStr === 'optional' || typeStr === 'zodoptional' || typeStr === 'default' || typeStr === 'zoddefault') {
          isOptional = true
          if (node._def.description) description = node._def.description
          node = node._def.innerType
        } else {
          break
        }
      }

      const typeStr = String(node?._def?.type || node?._def?.typeName || '').toLowerCase()
      let type = 'string'
      if (typeStr.includes('number')) type = 'number'
      else if (typeStr.includes('boolean')) type = 'boolean'
      else if (typeStr.includes('array')) type = 'array'
      else if (typeStr.includes('object')) type = 'object'

      if (node?._def?.description) description = node._def.description

      if (!isOptional) required.push(key)

      properties[key] = {
        type,
        ...(description ? { description } : {})
      }
    }

    return {
      type: 'object',
      properties,
      ...(required.length ? { required } : {})
    }
  } catch {
    return { type: 'object', properties: {} }
  }
}
