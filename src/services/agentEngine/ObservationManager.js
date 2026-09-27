import { ContextChunk, CHUNK_TYPES, CHUNK_PRIORITY } from './ContextChunk.js'

export class StructuredObservation {
  constructor({
    id,
    turn = 1,
    tool = 'unknown',
    status = 'success',
    summary = '',
    details = '',
    timestamp = Date.now(),
    importance = 'medium'
  }) {
    this.id = id || `obs_${turn}_${tool}_${Math.random().toString(36).substr(2, 6)}`
    this.turn = turn
    this.tool = tool
    this.status = status // 'success' | 'failed' | 'blocked' | 'cancelled'
    this.summary = summary
    this.details = details
    this.timestamp = timestamp
    this.importance = importance // 'high' | 'medium' | 'low'
  }
}

export class ObservationManager {
  constructor() {
    this.observations = []
  }

  addObservation({ turn, tool, status, summary, details }) {
    const isError = status === 'failed' || status === 'blocked' || String(details || summary).toLowerCase().includes('failed') || String(details || summary).toLowerCase().includes('error')
    const isWrite = ['write_file', 'edit_file', 'replace_in_file', 'create_file', 'delete_file'].includes(tool)
    const importance = isError ? 'high' : isWrite ? 'medium' : 'low'

    const obs = new StructuredObservation({
      turn,
      tool,
      status: isError ? 'failed' : status,
      summary: summary || `${tool} ${status}`,
      details: details || summary,
      importance
    })

    this.observations.push(obs)
    return obs
  }

  getStructuredObservations() {
    return this.observations
  }

  compressObservations({ maxRecentDetailed = 5 } = {}) {
    const chunks = []
    const total = this.observations.length

    for (let index = 0; index < total; index++) {
      const obs = this.observations[index]
      const isRecent = index >= total - maxRecentDetailed

      if (obs.importance === 'high' || isRecent) {
        // High importance or recent: retain details
        const priority = obs.importance === 'high' ? CHUNK_PRIORITY.CRITICAL : CHUNK_PRIORITY.MEDIUM
        chunks.push(new ContextChunk({
          id: obs.id,
          type: CHUNK_TYPES.TOOL_RESULT,
          source: obs.tool,
          content: `[Turn ${obs.turn}] ${obs.tool} (${obs.status}):\n${obs.details}`,
          summary: `Turn ${obs.turn}: ${obs.tool} (${obs.status})`,
          score: obs.importance === 'high' ? 0.95 : 0.6,
          priority,
          metadata: { turn: obs.turn, tool: obs.tool, status: obs.status }
        }))
      } else {
        // Older low/medium observations: compress into 1-line summary
        chunks.push(new ContextChunk({
          id: obs.id,
          type: CHUNK_TYPES.TOOL_RESULT,
          source: obs.tool,
          content: `[Turn ${obs.turn}] ${obs.tool} -> ${obs.summary.slice(0, 120)}`,
          summary: `Turn ${obs.turn}: ${obs.tool}`,
          score: 0.3,
          priority: CHUNK_PRIORITY.LOW,
          metadata: { turn: obs.turn, tool: obs.tool, status: obs.status, compressed: true }
        }))
      }
    }

    return chunks
  }

  clear() {
    this.observations = []
  }
}
