import { z } from 'zod'

export const PRIME_ROUTER_INTENTS = [
  'chat',
  'explain',
  'inspect',
  'search',
  'create',
  'edit',
  'refactor',
  'debug',
  'test',
  'run_command',
  'git',
  'web',
  'plan',
  'continue',
  'verify',
  'finish',
  'recover'
]

export const PRIME_ROUTER_ACTION_CLASSES = [
  'local_tool',
  'main_llm',
  'verification',
  'recovery',
  'user_input',
  'complete'
]

export const PRIME_ROUTER_TOOL_FAMILIES = [
  'filesystem',
  'editor',
  'terminal',
  'git',
  'search',
  'browser',
  'diagnostics',
  'testing',
  'none'
]

export const ROUTER_MODES = Object.freeze({
  DISABLED: 'disabled',
  ASSIST: 'assist',
  ACTIVE: 'active'
})

export const CONFIDENCE_THRESHOLDS = Object.freeze({
  HIGH: 0.85,
  MEDIUM: 0.60
})

export const IntentSchema = z.enum(PRIME_ROUTER_INTENTS)
export const ActionClassSchema = z.enum(PRIME_ROUTER_ACTION_CLASSES)
export const ToolFamilySchema = z.enum(PRIME_ROUTER_TOOL_FAMILIES)

export const PrimeRouterInputSchema = z.object({
  request: z.string().min(1),
  state: z.string().optional().default('IDLE'),
  availableTools: z.array(z.string()).optional().default([]),
  recentContext: z.any().optional(),
  runContext: z.record(z.any()).optional().default({})
})

export const PrimeRouterDecisionSchema = z.object({
  intent: IntentSchema,
  actionClass: ActionClassSchema,
  toolFamily: ToolFamilySchema,
  needsLLM: z.boolean(),
  needsVerification: z.boolean(),
  confidence: z.number().min(0).max(1),
  modelVersion: z.string().default('prime-router-0.1.0'),
  latencyMs: z.number().nonnegative().default(0),
  reason: z.string().optional(),
  fallback: z.boolean().default(false)
})

/**
 * Creates a safe fallback decision that escalates to main LLM.
 */
export function createFallbackDecision({
  request = '',
  reason = 'Fallback to authoritative LLM',
  latencyMs = 0,
  modelVersion = 'prime-router-fallback'
} = {}) {
  const lower = String(request).toLowerCase()
  let intent = 'chat'
  let toolFamily = 'none'

  if (/\b(test|jest|vitest|npm test)\b/.test(lower)) {
    intent = 'test'
    toolFamily = 'testing'
  } else if (/\b(git status|git diff|git commit|git push)\b/.test(lower)) {
    intent = 'git'
    toolFamily = 'git'
  } else if (/\b(find|search|grep|locate)\b/.test(lower)) {
    intent = 'search'
    toolFamily = 'search'
  } else if (/\b(open|read|view|inspect)\b/.test(lower)) {
    intent = 'inspect'
    toolFamily = 'filesystem'
  } else if (/\b(fix|bug|error|failing|debug)\b/.test(lower)) {
    intent = 'debug'
    toolFamily = 'filesystem'
  } else if (/\b(create|write|add component|build)\b/.test(lower)) {
    intent = 'create'
    toolFamily = 'editor'
  }

  return {
    intent,
    actionClass: 'main_llm',
    toolFamily,
    needsLLM: true,
    needsVerification: intent === 'create' || intent === 'edit' || intent === 'test',
    confidence: 0.5,
    modelVersion,
    latencyMs,
    reason,
    fallback: true
  }
}
