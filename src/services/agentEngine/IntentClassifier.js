/**
 * IntentClassifier — Local-first intent recognition for Prime AI.
 *
 * Classifies user messages into intents BEFORE any LLM call or workspace scan.
 * Simple patterns (greetings, thanks, farewells) are resolved instantly with
 * zero latency. Ambiguous messages fall back to a cheap LLM classification call.
 */

// ── Intent Constants ────────────────────────────────────────────────────────

export const INTENTS = {
  GREETING: 'greeting',
  CONVERSATION: 'conversation',
  QUESTION: 'question',
  CODE_EXPLANATION: 'code_explanation',
  CODE_REVIEW: 'code_review',
  BUG_FIX: 'bug_fix',
  FEATURE_REQUEST: 'feature_request',
  REFACTORING: 'refactoring',
  PROJECT_GENERATION: 'project_generation',
  WORKSPACE_ANALYSIS: 'workspace_analysis',
  DOCUMENTATION: 'documentation',
  TERMINAL_COMMAND: 'terminal_command',
  GIT_OPERATION: 'git_operation',
  PLANNING: 'planning',
  ARCHITECTURE: 'architecture',
  GENERAL_KNOWLEDGE: 'general_knowledge',
  DEBUGGING: 'debugging',
  OTHER: 'other'
}

// ── Tool Requirements Per Intent ────────────────────────────────────────────

export const INTENT_TOOLS = {
  [INTENTS.GREETING]:            { needsLLM: false, needsWorkspace: false, needsAgent: false },
  [INTENTS.CONVERSATION]:        { needsLLM: true,  needsWorkspace: false, needsAgent: false },
  [INTENTS.QUESTION]:            { needsLLM: true,  needsWorkspace: false, needsAgent: false },
  [INTENTS.GENERAL_KNOWLEDGE]:   { needsLLM: true,  needsWorkspace: false, needsAgent: false },
  [INTENTS.CODE_EXPLANATION]:    { needsLLM: true,  needsWorkspace: false, needsAgent: false },
  [INTENTS.CODE_REVIEW]:         { needsLLM: true,  needsWorkspace: true,  needsAgent: false },
  [INTENTS.BUG_FIX]:             { needsLLM: true,  needsWorkspace: true,  needsAgent: true  },
  [INTENTS.DEBUGGING]:           { needsLLM: true,  needsWorkspace: true,  needsAgent: true  },
  [INTENTS.FEATURE_REQUEST]:     { needsLLM: true,  needsWorkspace: true,  needsAgent: true  },
  [INTENTS.REFACTORING]:         { needsLLM: true,  needsWorkspace: true,  needsAgent: true  },
  [INTENTS.PROJECT_GENERATION]:  { needsLLM: true,  needsWorkspace: true,  needsAgent: true  },
  [INTENTS.WORKSPACE_ANALYSIS]:  { needsLLM: true,  needsWorkspace: true,  needsAgent: false },
  [INTENTS.DOCUMENTATION]:       { needsLLM: true,  needsWorkspace: true,  needsAgent: false },
  [INTENTS.TERMINAL_COMMAND]:    { needsLLM: true,  needsWorkspace: false, needsAgent: true  },
  [INTENTS.GIT_OPERATION]:       { needsLLM: true,  needsWorkspace: false, needsAgent: true  },
  [INTENTS.PLANNING]:            { needsLLM: true,  needsWorkspace: true,  needsAgent: false },
  [INTENTS.ARCHITECTURE]:        { needsLLM: true,  needsWorkspace: true,  needsAgent: false },
  [INTENTS.OTHER]:               { needsLLM: true,  needsWorkspace: false, needsAgent: false }
}

// ── Pattern Tables (evaluated in order, first match wins) ───────────────────

const GREETING_PATTERNS = [
  /^(hi|hello|hey|howdy|hola|sup|yo|hii+|heyy+|helloo+)[\s!.?]*$/i,
  /^good\s*(morning|afternoon|evening|night|day)[\s!.?]*$/i,
  /^what'?s?\s*up[\s!.?]*$/i,
  /^how\s*(are|r)\s*(you|u|ya)[\s!.?,]*$/i,
  /^greetings[\s!.?]*$/i
]

const FAREWELL_PATTERNS = [
  /^(bye|goodbye|see\s*ya|later|ciao|peace|take\s*care)[\s!.?]*$/i,
  /^good\s*night[\s!.?]*$/i
]

const THANKS_PATTERNS = [
  /^(thanks?|thank\s*you|thx|ty|cheers|appreciated?|nice|great|cool|awesome|perfect|got\s*it|ok|okay)[\s!.?]*$/i
]

const GIT_PATTERNS = [
  /\b(git\s+(commit|push|pull|merge|branch|checkout|stash|rebase|log|diff|status|clone|init|add|reset))\b/i,
  /\b(commit|push|pull)\s+(the|this|my|all)?\s*(changes?|code|files?)?\b/i
]

const TERMINAL_PATTERNS = [
  /\b(run|execute|terminal|shell|cmd|command|npm|yarn|pnpm|pip|cargo|make)\s/i,
  /^(npm|yarn|pnpm|pip|cargo|make|node|python|go|java|dotnet|docker)\s/i
]

const CODE_TASK_PATTERNS = [
  // Bug fix / debugging
  { pattern: /\b(fix|debug|solve|troubleshoot|repair|patch|resolve|broken|error|bug|issue|crash|fail|not\s*working|doesn'?t\s*work)\b/i, intent: INTENTS.BUG_FIX },
  // Feature request
  { pattern: /\b(create|add|build|make|implement|generate|set\s*up|scaffold|new)\b/i, intent: INTENTS.FEATURE_REQUEST },
  // Refactoring
  { pattern: /\b(refactor|rename|extract|clean\s*up|restructure|reorganize|simplify|optimize|improve|rewrite)\b/i, intent: INTENTS.REFACTORING },
  // Code explanation
  { pattern: /\b(explain|what\s*(does|is)|how\s*does|walk\s*me\s*through|describe|tell\s*me\s*about)\b/i, intent: INTENTS.CODE_EXPLANATION },
  // Code review
  { pattern: /\b(review|audit|check|inspect|evaluate|assess|analyze|analyse)\b.*\b(code|file|project|repo|codebase)\b/i, intent: INTENTS.CODE_REVIEW },
  // Workspace analysis
  { pattern: /\b(analyze|analyse|scan|overview|summarize|summary|structure)\b.*\b(project|workspace|repo|codebase|folder)\b/i, intent: INTENTS.WORKSPACE_ANALYSIS },
  // Documentation
  { pattern: /\b(document|readme|docs|jsdoc|comment|annotate)\b/i, intent: INTENTS.DOCUMENTATION },
  // Planning
  { pattern: /\b(plan|outline|strategy|roadmap|steps|approach)\b/i, intent: INTENTS.PLANNING },
  // Architecture
  { pattern: /\b(architect|design|system\s*design|high.level|module|structure)\b/i, intent: INTENTS.ARCHITECTURE },
  // Project generation
  { pattern: /\b(scaffold|bootstrap|init|initialize|start\s*a\s*new|project\s*from\s*scratch|boilerplate)\b/i, intent: INTENTS.PROJECT_GENERATION },
  // Testing
  { pattern: /\b(test|spec|unit\s*test|e2e|integration\s*test|coverage)\b/i, intent: INTENTS.FEATURE_REQUEST },
  // Debugging
  { pattern: /\b(debug|breakpoint|trace|stack\s*trace|log|console)\b/i, intent: INTENTS.DEBUGGING }
]

const QUESTION_PATTERNS = [
  /^(what|how|why|when|where|who|which|can|could|would|should|is|are|do|does|did|will|has|have)\b/i,
  /\?$/
]

// ── Quick Responses for Greetings / Farewells / Thanks ──────────────────────

const GREETING_RESPONSES = [
  "Hi! 👋 How can I help you today?",
  "Hey there! 👋 What can I do for you?",
  "Hello! Ready to help — what are you working on?",
  "Hi! 👋 Need help with anything?"
]

const FAREWELL_RESPONSES = [
  "See you later! 👋 Happy coding!",
  "Bye! Let me know if you need anything. 🚀",
  "Take care! I'll be here when you need me. 👋"
]

const THANKS_RESPONSES = [
  "You're welcome! Let me know if there's anything else. 😊",
  "Happy to help! 🎉",
  "Anytime! What's next?",
  "Glad I could help! 👍"
]

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ── Classifier ──────────────────────────────────────────────────────────────

export class IntentClassifier {

  /**
   * Classify a user message into an intent.
   * Returns { intent, confidence, quickResponse?, toolReqs }
   *
   * @param {string} message         The raw user message
   * @param {Array}  history         Recent conversation messages [{role, content}]
   * @param {object} context         { hasActiveFile, hasSelectedCode, hasWorkspace }
   * @returns {{ intent: string, confidence: number, quickResponse?: string, toolReqs: object }}
   */
  static classify(message, history = [], context = {}) {
    const trimmed = (message || '').trim()
    if (!trimmed) {
      return { intent: INTENTS.GREETING, confidence: 1, quickResponse: pickRandom(GREETING_RESPONSES), toolReqs: INTENT_TOOLS[INTENTS.GREETING] }
    }

    // ── Instant pattern matches (no LLM needed) ───────────────────────────

    // Greetings
    if (GREETING_PATTERNS.some(p => p.test(trimmed))) {
      return { intent: INTENTS.GREETING, confidence: 1, quickResponse: pickRandom(GREETING_RESPONSES), toolReqs: INTENT_TOOLS[INTENTS.GREETING] }
    }

    // Farewells
    if (FAREWELL_PATTERNS.some(p => p.test(trimmed))) {
      return { intent: INTENTS.CONVERSATION, confidence: 1, quickResponse: pickRandom(FAREWELL_RESPONSES), toolReqs: INTENT_TOOLS[INTENTS.CONVERSATION] }
    }

    // Thanks
    if (THANKS_PATTERNS.some(p => p.test(trimmed))) {
      return { intent: INTENTS.CONVERSATION, confidence: 1, quickResponse: pickRandom(THANKS_RESPONSES), toolReqs: INTENT_TOOLS[INTENTS.CONVERSATION] }
    }

    // ── Domain-specific patterns ──────────────────────────────────────────

    // Git operations
    if (GIT_PATTERNS.some(p => p.test(trimmed))) {
      return { intent: INTENTS.GIT_OPERATION, confidence: 0.9, toolReqs: INTENT_TOOLS[INTENTS.GIT_OPERATION] }
    }

    // Terminal commands
    if (TERMINAL_PATTERNS.some(p => p.test(trimmed))) {
      return { intent: INTENTS.TERMINAL_COMMAND, confidence: 0.85, toolReqs: INTENT_TOOLS[INTENTS.TERMINAL_COMMAND] }
    }

    // Code task patterns (ordered by specificity)
    for (const { pattern, intent } of CODE_TASK_PATTERNS) {
      if (pattern.test(trimmed)) {
        // If user has selected code, "explain" targets explanation specifically
        if (intent === INTENTS.CODE_EXPLANATION && context.hasSelectedCode) {
          return { intent: INTENTS.CODE_EXPLANATION, confidence: 0.95, toolReqs: INTENT_TOOLS[INTENTS.CODE_EXPLANATION] }
        }
        return { intent, confidence: 0.85, toolReqs: INTENT_TOOLS[intent] }
      }
    }

    // ── Contextual heuristics ─────────────────────────────────────────────

    // Short conversational follow-ups that reference prior context
    const isShortFollowUp = trimmed.split(/\s+/).length <= 6 && history.length > 0
    const referencesContext = /\b(it|that|this|the\s+(same|page|file|component|function|thing))\b/i.test(trimmed)

    if (isShortFollowUp && referencesContext) {
      // Look at what the last assistant response was about to determine if this is a code task
      const lastAssistant = [...history].reverse().find(m => m.role === 'assistant')
      if (lastAssistant) {
        // If the prior turn was about code, this follow-up is likely a code task
        const priorWasCode = /```|file|function|component|class|import|export/i.test(lastAssistant.content || '')
        if (priorWasCode) {
          // Re-classify the follow-up combined with the prior context
          const combined = `${trimmed} (referring to previous: ${(lastAssistant.content || '').slice(0, 200)})`
          for (const { pattern, intent } of CODE_TASK_PATTERNS) {
            if (pattern.test(combined)) {
              return { intent, confidence: 0.75, toolReqs: INTENT_TOOLS[intent] }
            }
          }
          return { intent: INTENTS.FEATURE_REQUEST, confidence: 0.7, toolReqs: INTENT_TOOLS[INTENTS.FEATURE_REQUEST] }
        }
      }
    }

    // General questions
    if (QUESTION_PATTERNS.some(p => p.test(trimmed))) {
      // If the question mentions code/file/project terms, it's code-related
      if (/\b(code|file|function|class|component|module|api|bug|error|project|app|program)\b/i.test(trimmed)) {
        return { intent: INTENTS.CODE_EXPLANATION, confidence: 0.75, toolReqs: INTENT_TOOLS[INTENTS.CODE_EXPLANATION] }
      }
      return { intent: INTENTS.QUESTION, confidence: 0.8, toolReqs: INTENT_TOOLS[INTENTS.QUESTION] }
    }

    // Very short messages without clear code intent → likely conversation
    if (trimmed.split(/\s+/).length <= 3 && !/[{}()<>/\\;=]/.test(trimmed)) {
      return { intent: INTENTS.CONVERSATION, confidence: 0.6, toolReqs: INTENT_TOOLS[INTENTS.CONVERSATION] }
    }

    // ── Fallback: treat as a general request ──────────────────────────────
    // If workspace is open and message is complex, assume it might be a code task
    if (context.hasWorkspace && trimmed.split(/\s+/).length > 5) {
      return { intent: INTENTS.FEATURE_REQUEST, confidence: 0.5, toolReqs: INTENT_TOOLS[INTENTS.FEATURE_REQUEST] }
    }

    return { intent: INTENTS.OTHER, confidence: 0.5, toolReqs: INTENT_TOOLS[INTENTS.OTHER] }
  }
}
