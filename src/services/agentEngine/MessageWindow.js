// ── MessageWindow.js ────────────────────────────────────────────────────
// Phase 2 (Bounded Runs): bounded model-request context for agent runs.
//
// Replaces the previously unbounded nativeMessages array with a deterministic
// window: SYSTEM anchor + IMMUTABLE FACTS + CURRENT TASK STATE + recent
// exchange units, cut only at unit boundaries so tool-call/result protocol
// integrity is preserved for every provider shape (OpenAI-compatible,
// Anthropic, Gemini).
//
// What this is NOT (later phases): no summarization, no budgets, no stopping.
// Evicted raw content remains available in the run's observations[] and the
// persisted event log; this window only shapes what is SENT per request.
//
// Token unit: estimateTokens (chars/3.8), consistent with RunLedger input
// estimates and ContextBudgetManager.
// ─────────────────────────────────────────────────────────────────────────────
import { estimateTokens } from './ContextChunk.js'
import { renderSummary, isValidSummary, EVICTED_EXCHANGE_CHARS, MAX_EVICTED_EXCHANGES_PER_SUMMARY } from './RollingSummarizer.js'

export const MESSAGE_KINDS = Object.freeze({
  SYSTEM: 'system',
  PROMPT: 'prompt',
  USER: 'user',
  ASSISTANT_TEXT: 'assistant_text',
  ASSISTANT_TOOLS: 'assistant_tools',
  TOOL_RESULT: 'tool_result',
  SCAFFOLD: 'scaffold',
  FACT: 'fact',
  TASK_STATE: 'task_state'
})

// reasoningHistoryPolicy values (approved architecture §21.B). Phase 2 exposes
// the hook and preserves existing behavior for every policy except 'none';
// provider-specific enforcement belongs to a later phase.
export const REASONING_POLICIES = Object.freeze({
  NONE: 'none',
  SUMMARY_ONLY: 'summary_only',
  PRESERVE_RECENT: 'preserve_recent',
  PROVIDER_REQUIRED: 'provider_required'
})

function hasToolCalls(msg) {
  if (!msg || typeof msg !== 'object') return false
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true
  const content = msg.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && (block.type === 'tool_use' || block.type === 'functionCall' || block.functionCall)) return true
    }
  }
  if (Array.isArray(msg.parts)) {
    for (const part of msg.parts) {
      if (part && (part.functionCall || part.type === 'functionCall')) return true
    }
  }
  return false
}

function hasReasoningContent(msg) {
  if (!msg || typeof msg !== 'object') return false
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) return true
  if (typeof msg.reasoning === 'string' && msg.reasoning) return true
  const content = msg.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && (block.type === 'reasoning' || block.type === 'thinking' || block.reasoning_content)) return true
    }
  }
  return false
}

function stripReasoningFields(msg) {
  if (!hasReasoningContent(msg)) return { msg, stripped: false }
  const copy = { ...msg }
  delete copy.reasoning_content
  delete copy.reasoning
  if (Array.isArray(copy.content)) {
    copy.content = copy.content.filter(block => !(block && (block.type === 'reasoning' || block.type === 'thinking' || block.reasoning_content)))
  }
  return { msg: copy, stripped: true }
}

function detectKind(msg, hint) {
  if (hint && Object.values(MESSAGE_KINDS).includes(hint)) return hint
  if (!msg || typeof msg !== 'object') return null
  if (msg.role === 'system') return MESSAGE_KINDS.SYSTEM
  if (msg.role === 'tool') return MESSAGE_KINDS.TOOL_RESULT
  if (msg.role === 'assistant' || msg.role === 'model') {
    return hasToolCalls(msg) ? MESSAGE_KINDS.ASSISTANT_TOOLS : MESSAGE_KINDS.ASSISTANT_TEXT
  }
  if (msg.role === 'user') {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && (block.type === 'tool_result' || block.type === 'tool_use')) return MESSAGE_KINDS.TOOL_RESULT
      }
    }
    return MESSAGE_KINDS.USER
  }
  // Unknown shapes are treated as standalone units: they never require a
  // predecessor, so they can never create an invalid leading edge.
  return MESSAGE_KINDS.USER
}

function tokensOf(msg) {
  try {
    return estimateTokens(typeof msg === 'string' ? msg : JSON.stringify(msg))
  } catch {
    return 0
  }
}

/** Readable text for summarizer feeds; bounded by the caller. */
function entryText(entry) {
  const msg = entry && entry.msg
  if (!msg || typeof msg !== 'object') return ''
  if (typeof msg.content === 'string') return msg.content
  try {
    return JSON.stringify(msg.content ?? msg)
  } catch {
    return ''
  }
}

/** Classify one provider message without storing it. Null when not a message object. */
export function classifyMessage(msg, hint = null) {
  return detectKind(msg, hint)
}

/**
 * Partition entries into atomic units shared by the window and checkpoint
 * migration. A unit never splits a tool exchange: tool results join the
 * current unit, every other kind starts a new one.
 */
export function partitionMessageUnits(entries) {
  const units = []
  let current = null
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.kind === MESSAGE_KINDS.TOOL_RESULT && current) {
      current.entries.push(entry)
      current.tokens += entry.tokens || 0
    } else {
      current = { entries: [entry], tokens: entry.tokens || 0 }
      units.push(current)
    }
  }
  return units
}

export class MessageWindow {
  /**
   * @param {object} options
   * @param {number} [options.maxWindowTokens=60000] - Hard cap for the composed
   *   request context (facts + task state + retained units, excluding the
   *   always-pinned system anchor only insofar as it is counted separately).
   *   Callers should derive this from model capabilities, not hard-code it.
   * @param {number} [options.maxMessages=200] - Safety cap on retained entries.
   * @param {string} [options.reasoningPolicy='preserve_recent'] - One of
   *   REASONING_POLICIES. Only 'none' alters messages in Phase 2.
   * @param {number} [options.maxFacts=50] - Bound on pinned facts.
   * @param {number} [options.factChars=1000] - Per-fact clip length.
   */
  constructor({ maxWindowTokens = 60000, maxMessages = 200, reasoningPolicy = REASONING_POLICIES.PRESERVE_RECENT, maxFacts = 50, factChars = 1000 } = {}) {
    this.maxWindowTokens = Number.isFinite(maxWindowTokens) && maxWindowTokens > 0 ? Math.floor(maxWindowTokens) : 60000
    this.maxMessages = Number.isFinite(maxMessages) && maxMessages > 0 ? Math.floor(maxMessages) : 200
    this.reasoningPolicy = Object.values(REASONING_POLICIES).includes(reasoningPolicy) ? reasoningPolicy : REASONING_POLICIES.PRESERVE_RECENT
    this.maxFacts = Number.isFinite(maxFacts) && maxFacts > 0 ? Math.floor(maxFacts) : 50
    this.factChars = Number.isFinite(factChars) && factChars > 0 ? Math.floor(factChars) : 1000
    this.entries = []
    this.facts = []
    this.factsOverflow = 0
    // Rolling summary (Phase 3): validated object or null. Replaced only via
    // setSummary with a valid candidate — atomic update, never partial.
    this.summary = null
    this.droppedMalformed = 0
    this.evictedTotal = 0
    this.builds = 0
  }

  get length() {
    return this.entries.length
  }

  isEmpty() {
    return this.entries.length === 0
  }

  /** Append one provider message. Returns the classified kind, or null when dropped. */
  push(msg, hint = null) {
    const kind = detectKind(msg, hint)
    if (kind === null) {
      this.droppedMalformed += 1
      return null
    }
    this.entries.push({ msg, tokens: tokensOf(msg), kind, hasReasoning: hasReasoningContent(msg) })
    return kind
  }

  /** Seed initial messages (system + first user prompt) with anchor kinds. */
  seed(messages = []) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') {
        this.droppedMalformed += 1
        continue
      }
      const kind = msg.role === 'system' ? MESSAGE_KINDS.SYSTEM : MESSAGE_KINDS.PROMPT
      this.entries.push({ msg, tokens: tokensOf(msg), kind, hasReasoning: hasReasoningContent(msg) })
    }
  }

  /** Pin an immutable fact. Exact duplicates ignored; oldest dropped past cap (counted). */
  addFact(text) {
    const clean = String(text || '').trim()
    if (!clean) return false
    const clipped = clean.length > this.factChars ? clean.slice(0, this.factChars) : clean
    if (this.facts.includes(clipped)) return false
    this.facts.push(clipped)
    if (this.facts.length > this.maxFacts) {
      this.facts.shift()
      this.factsOverflow += 1
    }
    return true
  }

  /** Atomically replace the rolling summary. Invalid candidates are ignored,
   * leaving the previous valid summary intact. Returns true on commit. */
  setSummary(candidate) {
    if (!isValidSummary(candidate)) return false
    this.summary = candidate
    return true
  }

  /** Partition retained entries into atomic units. A unit never splits a tool exchange. */
  partitionUnits(entries) {
    return partitionMessageUnits(entries)
  }

  /**
   * Drop a trailing incomplete tool exchange (assistant tool calls with no
   * following results). Sending such a prefix is a provider 400; dropping is
   * explicit and counted. Returns the number of messages removed.
   */
  dropTrailingIncompleteExchange() {
    let removed = 0
    while (this.entries.length > 0) {
      const last = this.entries[this.entries.length - 1]
      if (last.kind !== MESSAGE_KINDS.ASSISTANT_TOOLS) break
      this.entries.pop()
      removed += 1
    }
    return removed
  }

  /**
   * Compose the bounded request context.
   * @param {object} options
   * @param {string|null} [options.taskState] - Current task-state text from live
   *   run state (not stored; composed by the caller each turn).
   */
  build({ taskState = null } = {}) {
    this.builds += 1
    const tokensBefore = this.entries.reduce((sum, entry) => sum + entry.tokens, 0)

    // 1. Partition into atomic units first: every cap below operates on whole
    // units so tool exchanges are never split at any stage. The system anchor
    // (entries[0] when system-role) is pinned outside the windowed region and
    // always leads the composed context.
    const anchorEntry = this.entries.length > 0 && this.entries[0].kind === MESSAGE_KINDS.SYSTEM
      ? this.entries[0]
      : null
    const windowedEntries = anchorEntry ? this.entries.slice(1) : this.entries
    const units = this.partitionUnits(windowedEntries)

    // 2. Enforce the raw message-count safety cap on whole units (oldest
    // first). The newest unit always survives.
    let evicted = 0
    const countUnits = () => units.reduce((sum, unit) => sum + unit.entries.length, 0)
    while (countUnits() > this.maxMessages && units.length > 1) {
      const [dropped] = units.splice(0, 1)
      evicted += dropped.entries.length
    }

    // 3. Compose the fixed prefix first so facts, task state, and the rolling
    // summary reserve budget before recent exchanges accumulate. The prefix
    // is bounded by construction (fact caps, task-state clip, summary cap).
    const prefixMessages = []
    let factsIncluded = 0
    if (this.facts.length > 0) {
      prefixMessages.push({ role: 'user', content: `[IMMUTABLE FACTS — always in effect]\n${this.facts.map(fact => `- ${fact}`).join('\n')}` })
      factsIncluded = this.facts.length
    }
    const cleanTaskState = typeof taskState === 'string' ? taskState.trim() : ''
    if (cleanTaskState) {
      prefixMessages.push({ role: 'user', content: `[CURRENT TASK STATE]\n${cleanTaskState}` })
    }
    if (this.summary) {
      prefixMessages.push({ role: 'user', content: `[ROLLING SUMMARY — condensed history; facts and task state above take precedence]\n${renderSummary(this.summary)}` })
    }
    const prefixTokens = prefixMessages.reduce((sum, msg) => sum + tokensOf(msg), 0)

    // 4. Accumulate units from the tail while the token budget allows.
    let takeUnits = 0
    let acc = prefixTokens
    for (let i = units.length - 1; i >= 0; i--) {
      if (takeUnits > 0 && acc + units[i].tokens > this.maxWindowTokens) break
      acc += units[i].tokens
      takeUnits += 1
    }
    // takeUnits >= 1 whenever units exist: the newest unit is always kept
    // (overflow recorded instead of producing an empty context).
    let firstUnit = Math.max(0, units.length - takeUnits)
    let retainedEntries = []
    for (let i = firstUnit; i < units.length; i++) retainedEntries.push(...units[i].entries)

    // 5. Drop leading orphans: tool results without their assistant call are
    // invalid as a leading edge for every provider shape.
    let orphansDropped = 0
    while (retainedEntries.length > 0 && retainedEntries[0].kind === MESSAGE_KINDS.TOOL_RESULT) {
      const orphan = retainedEntries.shift()
      acc -= orphan.tokens
      orphansDropped += 1
    }

    // 6. Evict everything outside the retained window from storage. The
    // pinned system anchor is not part of the windowed region and stays.
    // Evicted entries feed the summarizer through the bounded report below.
    const retainedSet = new Set(retainedEntries)
    const kept = anchorEntry ? [anchorEntry] : []
    const evictedEntries = []
    let evictedByWindow = 0
    for (const entry of windowedEntries) {
      if (retainedSet.has(entry)) kept.push(entry)
      else {
        evictedByWindow += 1
        evictedEntries.push(entry)
      }
    }
    this.entries = kept
    evicted += evictedByWindow
    this.evictedTotal += evicted

    // 7. Compose: system anchor + prefix (facts + task state + summary) +
    // retained units. System always leads, matching provider convention.
    const messages = []
    if (anchorEntry) messages.push(this.applyReasoningPolicy(anchorEntry.msg))
    messages.push(...prefixMessages)
    let exchangesRetained = 0
    for (const entry of retainedEntries) {
      if (entry.kind === MESSAGE_KINDS.ASSISTANT_TOOLS) exchangesRetained += 1
      messages.push(this.applyReasoningPolicy(entry.msg))
    }

    const tokensAfter = messages.reduce((sum, msg) => sum + tokensOf(msg), 0)
    const overflow = tokensAfter > this.maxWindowTokens

    return {
      messages,
      retained: retainedEntries.length,
      evicted,
      orphansDropped,
      exchangesRetained,
      factsIncluded,
      summaryIncluded: Boolean(this.summary),
      // Bounded feed for the summarizer: most-recent evicted exchanges only,
      // each clipped. Never the full transcript.
      evictedContent: evictedEntries.slice(-MAX_EVICTED_EXCHANGES_PER_SUMMARY).map(entry => ({
        kind: entry.kind,
        text: entryText(entry).slice(0, EVICTED_EXCHANGE_CHARS)
      })).filter(item => item.text.trim()),
      tokensBefore,
      tokensAfter,
      systemIncluded: Boolean(anchorEntry),
      overflow,
      droppedMalformed: this.droppedMalformed,
      factsOverflow: this.factsOverflow
    }
  }

  /** Phase 2 reasoning hook: only 'none' alters messages; all other policies preserve. */
  applyReasoningPolicy(msg) {
    if (this.reasoningPolicy !== REASONING_POLICIES.NONE) return msg
    return stripReasoningFields(msg).msg
  }
}
