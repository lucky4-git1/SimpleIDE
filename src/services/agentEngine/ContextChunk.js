export const CHUNK_TYPES = {
  ACTIVE_FILE: 'ACTIVE_FILE',
  SELECTION: 'SELECTION',
  SYMBOL: 'SYMBOL',
  DEFINITION: 'DEFINITION',
  REFERENCE: 'REFERENCE',
  CALLER: 'CALLER',
  CALLEE: 'CALLEE',
  TEST: 'TEST',
  FILE: 'FILE',
  DEPENDENCY: 'DEPENDENCY',
  DEPENDENT: 'DEPENDENT',
  CONFIG: 'CONFIG',
  DIAGNOSTIC: 'DIAGNOSTIC',
  TOOL_RESULT: 'TOOL_RESULT',
  MEMORY: 'MEMORY',
  DOCUMENTATION: 'DOCUMENTATION'
}

export const CHUNK_PRIORITY = {
  CRITICAL: 100, // Active selection, compiler/test error, exact symbol definition
  HIGH: 75,     // Active file, direct dependency, direct dependent
  MEDIUM: 50,   // Open tab, lexical search match, project memory
  LOW: 25       // Secondary file list, redundant logs
}

/**
 * Lightweight deterministic token estimation (approx 3.8 chars per token for code/text)
 */
export function estimateTokens(text) {
  if (!text) return 0
  const str = typeof text === 'string' ? text : JSON.stringify(text)
  return Math.ceil(str.length / 3.8)
}

/**
 * Structured Context Chunk representation
 */
export class ContextChunk {
  constructor({
    id,
    type,
    source,
    path = null,
    content = '',
    summary = '',
    score = 0.0,
    priority = CHUNK_PRIORITY.MEDIUM,
    tokens = null,
    metadata = {}
  }) {
    this.id = id || `${type}:${path || source}:${Math.random().toString(36).substr(2, 6)}`
    this.type = type
    this.source = source
    this.path = path
    this.content = content || summary
    this.summary = summary || (content.length > 200 ? `${content.slice(0, 200)}...` : content)
    this.score = Number(score) || 0.0
    this.priority = Number(priority) || CHUNK_PRIORITY.MEDIUM
    this.tokens = tokens !== null && tokens !== undefined ? tokens : estimateTokens(this.content)
    this.metadata = metadata
  }
}
