import { requestAIText, getApiConfig } from './aiService.js'
import { selectRelevantFiles } from './fileIndex.js'
import { ToolRunner } from './agentEngine/ToolRunner.js'
import { VerificationManager } from './agentEngine/VerificationManager.js'
import { WorkspaceScanner } from './agentEngine/WorkspaceScanner.js'
import { IntentClassifier, INTENTS } from './agentEngine/IntentClassifier.js'
import { globalContextEngine } from './agentEngine/ContextEngine.js'
import { AgentRuntime, AGENT_STATES, AGENT_EVENTS } from './agentEngine/AgentRuntime.js'
import { NativeToolAdapter } from './agentEngine/NativeToolAdapter.js'
import { ToolResult } from './agentEngine/ToolDefinition.js'
import { globalRouter, filterToolsByFamily } from './agentEngine/LLMRouter.js'
import { PrimeRouter } from './agentEngine/PrimeRouter.js'
import { MainProcessRouterAdapter } from './agentEngine/MainProcessRouterAdapter.js'
import { RunLedger } from './agentEngine/RunLedger.js'
import { MessageWindow, MESSAGE_KINDS } from './agentEngine/MessageWindow.js'
import { buildCheckpointV2, migrateCheckpoint, restoreIntoWindow } from './agentEngine/RunCheckpoint.js'
import {
  SUMMARIZER_SYSTEM_PROMPT,
  SUMMARIZER_INPUT_MAX_TOKENS,
  SUMMARIZER_MAX_TOKENS,
  MAX_SUMMARIZER_CALLS_PER_RUN,
  buildSummarizerInput,
  mergeWithDeterministic,
  canSummarize,
  summarize
} from './agentEngine/RollingSummarizer.js'
import {
  BUDGET_STATES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_CONSECUTIVE_MALFORMED,
  MAX_MODEL_ATTEMPTS_PER_TURN,
  BudgetPolicy,
  withBoundedRetries
} from './agentEngine/BudgetPolicy.js'
import { RunTimeline, TimelineTypes, classifyFailureClass } from './agentEngine/RunTimeline.js'
import { CodeIntelligenceService } from './agentEngine/CodeIntelligenceService.js'
import { ConsistencyEngine, EVIDENCE_TYPES } from './agentEngine/ConsistencyEngine.js'
import { FailureClassifier, FAILURE_CATEGORIES } from './agentEngine/FailureClassifier.js'
import { CrashRecoveryService } from './agentEngine/CrashRecoveryService.js'
import { SkillRegistry } from './agentEngine/skills/SkillRegistry.js'

const MAX_FILE_OUTPUT = 18000
const MAX_MEMORY_ENTRIES = 8
const MAX_MEMORY_CHARS = 6000
const MAX_INDEXED_FILES_IN_PROMPT = 80
const MAX_RELEVANT_CONTEXT_CHARS = 5200
const WRITE_ACTION_TYPES = new Set(['write_file', 'create_file', 'replace_in_file', 'edit_file', 'delete_file', 'rename_file', 'move_file'])

const BLOCKED_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\brmdir\s+\/s\b/i,
  /\bdel\s+\/[sq]\b/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-fd\b/i,
  /\bRemove-Item\b.*\b-Recurse\b/i
]

function clip(text, maxLength = MAX_FILE_OUTPUT) {
  if (!text) return ''
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}\n\n[output truncated: ${text.length - maxLength} more characters]`
}

function normalizeSlashes(value) {
  return String(value || '').replace(/\\/g, '/')
}

function normalizePathForComparison(value) {
  return normalizeSlashes(value).replace(/\/+$/, '').toLowerCase()
}

function isPathInsideWorkspace(filePath, workspaceRoot) {
  const file = normalizePathForComparison(filePath)
  const root = normalizePathForComparison(workspaceRoot)
  return Boolean(file && root && (file === root || file.startsWith(`${root}/`)))
}

// Exact single-file recreation prompts are especially vulnerable to a model
// stopping after it has produced only a scaffold. Keep the detection narrow so
// ordinary HTML edits retain the normal autonomous completion behaviour.
function requiresStandaloneHtmlValidation(task) {
  const text = String(task || '')
  return /\b(?:one|single|standalone)\s+(?:file\s*:?\s*)?index\.html\b/i.test(text)
    && /\b(?:html|pixel[- ]for[- ]pixel|exact assets|do not invent)\b/i.test(text)
}

// UI state can briefly contain tabs/index entries from the previous folder
// while a workspace switch is being indexed.  Never pass those paths to the
// model, context retrieval, or agent tools.
function sanitizeWorkspaceContext(context = {}) {
  const workspaceRoot = context.currentFolder
  if (!workspaceRoot) return context

  const belongsHere = item => isPathInsideWorkspace(item?.path || item, workspaceRoot)
  const activeFile = belongsHere(context.activeFile) ? context.activeFile : null
  const openFiles = Array.isArray(context.openFiles) ? context.openFiles.filter(belongsHere) : []
  const projectIndex = Array.isArray(context.projectIndex)
    ? context.projectIndex.filter(entry => belongsHere(entry))
    : []
  const attachedFiles = Array.isArray(context.attachedFiles)
    ? context.attachedFiles.filter(entry => belongsHere(entry?.path || entry))
    : []

  return {
    ...context,
    activeFile,
    openFiles,
    projectIndex,
    attachedFiles,
    // A selection without its source file is ambiguous and can leak stale code.
    selectedCode: activeFile ? context.selectedCode : ''
  }
}

function getRelativePath(filePath, rootPath) {
  if (!rootPath) return filePath
  const normalizedFile = normalizeSlashes(filePath)
  const normalizedRoot = normalizeSlashes(rootPath)
  if (!normalizedFile.toLowerCase().startsWith(normalizedRoot.toLowerCase())) return filePath
  return normalizedFile.slice(normalizedRoot.length).replace(/^\//, '')
}

function extractJsonObject(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return JSON.parse(fenced[1])

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1))
  }

  throw new Error('The model did not return valid JSON.')
}

import { memoryManager } from './memory/memoryManager.js'

function loadAgentMemory(currentFolder) {
  if (!currentFolder) return []
  memoryManager.init(currentFolder)
  return memoryManager.executions.history.slice(-MAX_MEMORY_ENTRIES)
}

export function getWorkspaceMemory(currentFolder) {
  return loadAgentMemory(currentFolder)
}

function saveAgentMemory(currentFolder, entry) {
  if (!currentFolder) return
  memoryManager.init(currentFolder)
  memoryManager.executions.history.push(entry)
  if (memoryManager.executions.history.length > MAX_MEMORY_ENTRIES) {
    memoryManager.executions.history = memoryManager.executions.history.slice(-MAX_MEMORY_ENTRIES)
  }
  memoryManager.executions.save()
}

function formatExecutionMemory(entries = []) {
  const summaries = entries
    .slice(-MAX_MEMORY_ENTRIES)
    .map(entry => {
      const task = clip(String(entry.task || ''), 500)
      const result = clip(String(entry.result || ''), 700)
      const files = Array.isArray(entry.files) && entry.files.length ? ` Files: ${entry.files.join(', ')}.` : ''
      const status = entry.status ? ` Status: ${entry.status}.` : ''
      const plan = entry.plan ? `\n  Approved plan: ${clip(String(entry.plan), 1800)}` : ''
      return task && result ? `- Previous task: ${task}\n  Outcome: ${result}${status}${files}${plan}` : ''
    })
    .filter(Boolean)

  return clip(summaries.join('\n'), MAX_MEMORY_CHARS)
}

function formatConversationMemory(history = []) {
  const recent = history
    .filter(message => message?.content && (message.role === 'user' || message.role === 'assistant'))
    .slice(-20)
    .map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${clip(String(message.content), 2000)}`)

  return clip(recent.join('\n'), MAX_MEMORY_CHARS)
}

function formatWorkspaceMemory(events = []) {
  return clip(events
    .slice(-8)
    .map(event => `- ${event.type || 'event'}${event.file ? ` (${event.file})` : ''}: ${clip(String(event.detail || event.diff || ''), 500)}`)
    .join('\n'), 3000)
}

async function ensureAgentContextServices(context, { signal } = {}) {
  const workspaceRoot = context?.currentFolder
  if (!workspaceRoot) return

  memoryManager.init(workspaceRoot)
  globalContextEngine.resetWorkspace(workspaceRoot)
  globalContextEngine.setFileIndex(Array.isArray(context.projectIndex) ? context.projectIndex : [])

  const existingIndex = globalContextEngine.codeIntelligence
  if (existingIndex?.root === workspaceRoot) return

  const codeIntelligence = new CodeIntelligenceService(workspaceRoot, { api: context.api, abortSignal: signal })
  globalContextEngine.setCodeIntelligence(codeIntelligence)
  await codeIntelligence.indexWorkspace()
}

function rememberProjectFacts(workspace) {
  const facts = [
    ['runtime', 'framework', workspace?.framework],
    ['runtime', 'language', workspace?.language],
    ['tooling', 'packageManager', workspace?.packageManager],
    ['tooling', 'buildTool', workspace?.buildTool]
  ]

  for (const [category, key, value] of facts) {
    if (value && value !== 'unknown') {
      memoryManager.projects.addRecord({
        category,
        key,
        value,
        source: 'PROJECT_DETECTED',
        confidence: 0.95
      })
    }
  }
}

function isCommandBlocked(command) {
  return BLOCKED_COMMAND_PATTERNS.some(pattern => pattern.test(command))
}

// Tool observations can contain arbitrary source text.  Never infer a failed
// tool call just because a file, test name, or comment happens to use the word
// "failed"; executeAction always prefixes real failures with the tool name.
function observationFailed(observation) {
  return /^(?:[a-z_]+ failed:|[a-z_]+ blocked:|[a-z_]+ denied by user:|run_command blocked)/i.test(String(observation || '').trim())
}

function completionSummary(modelSummary, changedFiles, verification) {
  const summary = String(modelSummary || '').trim()
  const isGeneric = !summary || /^(?:done|completed|task complete)[.!\s]*$/i.test(summary)
  if (!isGeneric) return summary

  const files = [...changedFiles]
  const changeText = files.length
    ? `Changed ${files.length === 1 ? files[0] : `${files.length} files: ${files.join(', ')}`}.`
    : 'Inspected the workspace; no file changes were required.'
  const verificationText = verification?.attempted
    ? (verification.success ? ` Verification passed${verification.command ? ` (${verification.command})` : ''}.` : ' Verification did not pass.')
    : ''
  return `Completed. ${changeText}${verificationText}`
}

function buildSystemPrompt({ task = '', nativeTools = false, commandApproval = 'auto', readyToComplete = false, workspace = {} } = {}) {
  // Keep specialised design instructions out of non-UI tasks: a large visual
  // prompt makes debugging and backend work less precise.
  const taskText = `${task} ${(workspace?.task || '')}`
  const isUI = /\b(ui|ux|website|web page|landing page|portfolio|dashboard|frontend|css|html|responsive|design|component|visual)\b/i.test(taskText)
  const isExactSpec = /\b(pixel[- ]for[- ]pixel|exact assets|do not invent|use (?:these|the) urls only|standalone file)\b/i.test(taskText)
  const designBrief = isUI ? `
DESIGN BRIEF (CRITICAL FOR UI & PORTFOLIO TASKS):
- Visual QA is mandatory when a local preview is available. Use \`browser_navigate\`, then test both a desktop and mobile viewport with \`browser_set_viewport\`, \`browser_audit\`, \`browser_screenshot\`, and \`browser_console_errors\` before completing.
- Follow a premium aesthetic: Avoid generic plain colors. Use curated HSL color palettes (sleek dark modes, glowing accents).
- Use modern typography (Google Fonts like Inter, Outfit, or Roboto) instead of browser defaults.
- Use smooth gradients, subtle card borders (\`border border-white/10\`), and dynamic micro-animations (\`transition-all duration-300 hover:scale-105\`).
- To include real photographs & images (portraits, workspace setups, product shots), call \`search_images\` to fetch high quality working image URLs, or create custom vector graphics with \`create_svg_asset\`.
` : ''
  const nativeToolsInstruction = nativeTools ? `Use the provided tools directly. Do not serialize tool calls in JSON or Markdown. When the task is complete, return a concise plain-text summary with files changed and verification evidence. Do not call a "finish" tool; no such tool exists.` : `Return ONLY one JSON object. Use this exact shape:
{
  "status": "One of: Understanding, Inspecting, Planning, Editing, Executing, Verifying, Recovering, Completed, Cancelled, Failed",
  "thought": "short execution rationale safe to show to the user",
  "plan": ["inspect relevant files", "make a targeted change", "verify the result"],
  "actions": [
    { "type": "search_files", "query": "text" },
    { "type": "search_images", "query": "developer portrait", "count": 4 },
    { "type": "search_web", "query": "tech documentation or example" },
    { "type": "update_plan", "steps": [{ "text": "Inspect relevant code", "status": "working" }] },
    { "type": "read_file", "path": "src/App.jsx" },
    { "type": "list_files", "path": "src" },
    { "type": "write_file", "path": "src/file.js", "content": "complete file content" },
    { "type": "create_svg_asset", "path": "assets/hero-illustration.svg", "svg": "complete accessible SVG markup" },
    { "type": "replace_in_file", "path": "src/file.js", "find": "exact existing text", "replace": "replacement text" },
    { "type": "run_command", "command": "npm run build" },
    { "type": "start_process", "command": "npm run dev", "id": "dev-server" },
    { "type": "read_process_output", "id": "dev-server" },
    { "type": "browser_set_viewport", "width": 1440, "height": 900 },
    { "type": "browser_audit" },
    { "type": "browser_screenshot" },
    { "type": "validate_standalone_html", "path": "index.html" },
    { "type": "finish", "message": "summary for the user" }
  ]
}

Choose the smallest useful actions. Do not ask for clarification when the relevant files can be inspected or created. Finish only when the requested work is complete, verified where practical, or blocked by a genuine external issue.`;

  return `You are an autonomous Software Engineering Agent embedded in a desktop IDE.

You must follow the standard engineering lifecycle:
UNDERSTAND → DISCOVER → RETRIEVE KNOWLEDGE → INSPECT → CREATE PLAN → EXECUTE → OBSERVE → EVALUATE → REPAIR → VERIFY → COMPLETE.

- If you encounter unfamiliar APIs, use search_documentation or search_coding_knowledge.
- Never invent paths or APIs. Use discovery tools.
- Treat command failures as evidence: inspect the error, find the relevant source, edit, and retry.
- Use verify only for build, test, lint, or typecheck. Use run_command for arbitrary shell commands such as wc, git status, or package inspection.
- Do not use destructive commands.
- ALWAYS format inserted code beautifully.
- If you hit a roadblock, attempt self-healing.
- Do not stop at the first failure. Diagnose and Repair.
- When an approved implementation plan is present, call update_plan before work begins and after each meaningful plan item. Do not finish until every applicable item is complete or clearly blocked, and verification evidence is collected.
${isExactSpec ? '- SPEC FIDELITY MODE: The user supplied a detailed reference specification. Their exact copy, asset URLs, dimensions, tokens, and layout rules override generic design advice. Do not substitute, simplify, invent, or leave placeholders. If the file is too large for one tool call, build it in complete verified sections with write_file then edit_file. Before completion, call validate_standalone_html; a document containing ellipses, TODOs, “similar structure”, invalid CSS units, or incomplete tags is a failure, not a deliverable.' : ''}
${commandApproval === 'review' ? '- Command review is enabled: every shell command (run_command, verify, start_process) pauses for explicit user approval before it runs. File inspection and edits proceed normally; verification commands also need approval, so propose the exact command and wait for the decision.' : '- Safe workspace commands are pre-approved; only destructive operations pause for user approval. Still never run destructive commands.'}
${designBrief}
CRITICAL — UI and layout tasks:
- Treat every website, landing page, dashboard, or portfolio request as a product-design task, not merely a file-generation task. Before editing, establish a deliberate visual direction: target audience, page hierarchy, colour palette, type scale, spacing rhythm, component shapes, and interaction character.
- Do not ship a generic starter template. Avoid vague stock copy (for example “exceptional digital experiences”), empty feature grids, emoji as the primary icon system, default browser typography, and labelled placeholder boxes. Write specific, believable content for the requested product and give every section a purpose.
- Build a small design system first: use a maximum of two complementary font families, define reusable colour/type/spacing/radius/shadow tokens, strong heading-to-body contrast, visible focus states, and a clear primary action. Use a responsive layout that remains intentional at mobile, tablet, and desktop widths.
- For marketing sites, portfolios, and creative pages, create at least one purposeful visual asset unless the user explicitly requests a text-only design. Prefer a bespoke, accessible SVG illustration, diagram, decorative pattern, or data visual created with create_svg_asset and stored in the project. Never pretend an abstract illustration is a real person or product photo. Use remote image URLs only when the user supplies them or when their license/source is known.
- Make visuals serve the content: use real image alt text, reserve image dimensions to avoid layout shift, and do not use an image merely as decoration when typography, hierarchy, or an SVG illustration would communicate better.
- Convert the user's request into explicit, checkable outcomes before editing (for example: target = navigation bar; action = place the “Get Started” control at the far right; constraint = reduce its height).
- Locate the target in markup first, then read the CSS that controls both the target and its parent layout. Never assume a selector is active just because it sounds relevant.
- For positioning, inspect the actual DOM relationship and use an explicit layout rule on the real parent (such as flex/grid plus alignment). A rule for a missing or unrelated wrapper does not satisfy the task.
- After every UI edit, re-read the changed CSS/markup and check that each requested outcome is represented. Do not report completion if no write occurred for a requested visual change.
- When a local preview can be started, use browser_navigate, browser_audit, browser_screenshot, and browser_console_errors before completion. Repair horizontal overflow, clipped controls, unreadable contrast, missing image alt text, broken links, and console errors. Do not claim visual verification unless these checks ran.
- State the exact selector and properties changed in the final summary, not merely “Done”.

CRITICAL — Tool Usage & Modifications:
- Prefer \`write_file\` for creating new files, rewriting files, or files under 300 lines with complete desired content. This avoids fragile string matching.
- Use \`edit_file\` / \`replace_in_file\` only for surgical edits in large existing files. When using \`edit_file\`, include 2-3 lines of surrounding context in \`find\` to guarantee unique matching.


${readyToComplete ? 'The changed file has been re-read successfully. If it satisfies the stated task, complete now; do not spend more turns re-reading the same file.' : ''}

Current project facts: framework=${workspace?.framework || 'unknown'}, language=${workspace?.language || 'unknown'}, package manager=${workspace?.packageManager || 'unknown'}, build tool=${workspace?.buildTool || 'unknown'}.
- Live Web Server: Simple IDE automatically provides a live development server with hot-reload at http://localhost:3000. Do not attempt to start a new server on port 3000.

CRITICAL — Turn Latency & Deliverable Checklist Guidelines:
- Batch Related File Generations: When creating a project or feature that involves multiple files (e.g. index.html, style.css, script.js), emit all necessary file actions together in a single turn (\`actions: [{type: 'write_file', path: 'index.html', ...}, {type: 'write_file', path: 'style.css', ...}]\`); Do not divide primary deliverables across separate sequential turns.
- Avoid Preliminary Inspection on New Projects: When tasked with generating a new page, website, or feature in an empty or fresh workspace, do not waste preliminary turns listing directories or reading non-existent files. Proceed immediately to generating the complete deliverables.
- Instant Deliverable Verification: For web applications and landing pages, verify files using validate_standalone_html. Do not attempt to spin up redundant local servers (npx serve, python http.server) since Simple IDE already serves http://localhost:3000.
- Complete Directly: Once all required files are written and verified, emit finish with a clear, professional summary. Avoid redundant post-write inspection cycles.

${nativeToolsInstruction}`;
}

function buildUserPrompt({ task, context, observations, memory, workspace, dynamicContextStr }) {
  const conversation = formatConversationMemory(context.conversationHistory)
  const executionMemory = formatExecutionMemory(memory)
  const workspaceMemory = formatWorkspaceMemory(memoryManager.workspaces.events)
  const attached = Array.isArray(context.attachedFiles) ? context.attachedFiles : []
  const attachedSection = attached.length
    ? `User-attached files (treat as primary context):\n${attached.map(file => {
      const name = getRelativePath(file.path || file.name || 'attached file', context.currentFolder)
      const content = clip(String(file.content || ''), 4000)
      return `--- ${name} ---\n${content}`
    }).join('\n\n')}\n`
    : ''
  return `Current workspace root (strict boundary): ${context.currentFolder || 'unknown'}
Only inspect, read, write, or mention files inside this workspace. Ignore paths from any other folder.

Task:
${task}

${dynamicContextStr}

${attachedSection}
${context.approvedPlan ? `Approved implementation plan (complete and verify every applicable item before finishing):\n${clip(context.approvedPlan, 12000)}\n` : ''}
${context.resumeFromCheckpoint ? `This is a continuation of an incomplete run. Do not restart scaffolding or repeat completed work. Continue from the first unfinished milestone using this checkpoint:\n${clip(JSON.stringify(context.checkpoint || {}), 10000)}` : ''}

${conversation ? `Recent conversation:\n${conversation}\n` : ''}
${executionMemory ? `Relevant completed agent work:\n${executionMemory}\n` : ''}
${workspaceMemory ? `Recent workspace events:\n${workspaceMemory}\n` : ''}

Indexed project files:
${(context.projectIndex || []).slice(0, 40).map(file => `- ${getRelativePath(file.path, context.currentFolder)}`).join('\n') || 'No index yet'}

Recent observations:
${observations.length ? observations.join('\n\n') : 'None yet'}`
}

export function normalizePlanToMarkdown(rawText = '') {
  const text = String(rawText || '').trim()
  if (!text) return ''

  // Strip wrapping markdown code blocks containing JSON if present
  let candidateJson = text
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenceMatch) {
    candidateJson = fenceMatch[1].trim()
  }

  // Attempt structured JSON normalization
  if (candidateJson.startsWith('{') && candidateJson.endsWith('}')) {
    try {
      const data = JSON.parse(candidateJson)
      if (typeof data === 'object' && data !== null) {
        const sections = []
        const goalStr = data.goal || data.title || data.objective || 'Autonomous Engineering Task'
        const shortTitle = goalStr.split('\n')[0].replace(/^#+\s*/, '')
        sections.push(`# Implementation Plan: ${shortTitle}`)

        sections.push(`## 1. Goal\n${goalStr}`)

        if (data.design_direction && !/^N\/?A\b/i.test(data.design_direction.trim())) {
          sections.push(`## 2. Design & Architecture\n${data.design_direction}`)
        } else if (data.architecture) {
          sections.push(`## 2. Design & Architecture\n${data.architecture}`)
        }

        const steps = data.steps || data.phases || data.milestones || data.tasks || []
        if (Array.isArray(steps) && steps.length > 0) {
          const formattedSteps = steps.map((s, idx) => {
            if (typeof s === 'string') {
              const clean = s.replace(/^(?:\d+[.)]|[-*]|\bstep\s*\d+:?)\s+/i, '').trim()
              return `${idx + 1}. ${clean}`
            }
            const stepTitle = s.title || s.name || s.text || `Step ${idx + 1}`
            const stepDesc = s.description || s.detail ? ` — ${s.description || s.detail}` : ''
            return `${idx + 1}. **${stepTitle}**${stepDesc}`
          }).join('\n')
          sections.push(`## 3. Implementation Steps\n${formattedSteps}`)
        }

        const files = data.affected_files || data.files || data.changed_files || []
        if (Array.isArray(files) && files.length > 0) {
          const formattedFiles = files.map(f => {
            const path = typeof f === 'string' ? f : (f.path || f.file || String(f))
            const action = typeof f === 'object' && f.action ? ` (${f.action})` : ''
            return `- \`${path}\`${action}`
          }).join('\n')
          sections.push(`## 4. Affected Files\n${formattedFiles}`)
        }

        if (data.verification || data.testing) {
          const verif = data.verification || data.testing
          let verifText = ''
          if (typeof verif === 'string') {
            verifText = /^(?:npm|yarn|pnpm|cargo|go|pytest|make|cd|node)\b/m.test(verif)
              ? `\`\`\`bash\n${verif}\n\`\`\``
              : verif
          } else if (Array.isArray(verif)) {
            verifText = verif.map(v => `- ${v}`).join('\n')
          } else {
            verifText = JSON.stringify(verif)
          }
          sections.push(`## 5. Verification Plan\n${verifText}`)
        }

        const risks = data.risks || data.edge_cases || []
        if (Array.isArray(risks) && risks.length > 0) {
          const formattedRisks = risks.map(r => `- ${typeof r === 'string' ? r : JSON.stringify(r)}`).join('\n')
          sections.push(`## 6. Risks & Mitigations\n${formattedRisks}`)
        } else if (typeof risks === 'string' && risks.trim()) {
          sections.push(`## 6. Risks & Mitigations\n${risks}`)
        }

        return sections.join('\n\n')
      }
    } catch {
      // Fall through to raw markdown if JSON parse fails
    }
  }

  return text
}

export async function runAgentPlan({ task, context, signal, ledger = null }) {
  context = sanitizeWorkspaceContext(context)
  await ensureAgentContextServices(context, { signal })
  const memory = loadAgentMemory(context.currentFolder)
  // Phase 5: same bounded transient retry and request guard as the run loop.
  const raw = await withBoundedRetries(() => requestAIText({
    systemMessage: `You are Prime AI, a Principal Software Architect and Staff Engineer embedded in a desktop IDE.

Your objective is to produce an exceptionally clear, highly intelligent, and actionable implementation plan in pure Markdown.

CRITICAL FORMATTING GUIDELINES:
- Output clean, professional GitHub-flavored Markdown.
- DO NOT wrap your entire output in a JSON object or a single json code block.
- Use clean Markdown headers (#, ##), numbered lists, code fences, and bullet points.

Format your response with these exact sections:
# Implementation Plan: [Short, descriptive task title]

[Executive summary outlining the problem, architecture, and overall strategy.]

## 1. Goal & Objectives
[Specific, measurable goals of this change.]

## 2. Design & Architecture
[Architectural approach, component hierarchy, state flow, and design direction.]

## 3. Implementation Steps
[Sequential numbered steps. For large tasks, group into clear milestones.]
1. **[Step 1 Title]** — [Specific implementation details]
2. **[Step 2 Title]** — [Specific implementation details]
3. **[Step 3 Title]** — [Specific implementation details]

## 4. Affected Files
[List files to be inspected, created, or modified with brief purpose:]
- \`path/to/file\` — [Purpose]

## 5. Verification Plan
[Precise verification steps and terminal commands:]
\`\`\`bash
npm test
\`\`\`

## 6. Risks & Mitigations
- [Key risk or edge case and how to prevent it]`,
    userMessage: buildUserPrompt({ task, context, observations: [], memory }),
    useCache: false,
    waitForRateLimit: false,
    temperature: 0.1,
    maxTokens: 2500,
    signal,
    // Phase 1 bounded runs: measure only. Null unless the caller runs inside
    // a ledger-owning agent run; behavior is unchanged either way.
    usageSink: ledger ? (call) => ledger.recordCall(call) : null,
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS
  }), { maxAttempts: MAX_MODEL_ATTEMPTS_PER_TURN, signal })

  return normalizePlanToMarkdown(raw.trim())
}

import { ToolCall } from './agentEngine/ToolDefinition.js'
import { PromptContextFormatter } from './agentEngine/PromptContextFormatter.js'

export function normalizeActionToToolCall(action) {
  if (action instanceof ToolCall) return action
  if (!action || typeof action !== 'object') return new ToolCall({ name: 'unknown', args: {} })

  const name = action.type || action.name || 'unknown'
  const args = { ...action }
  delete args.type
  delete args.name

  return new ToolCall({ name, args })
}

async function executeAction(action, context, tools, runner) {
  const toolCall = normalizeActionToToolCall(action)
  const name = toolCall.name
  const api = tools?.api || context?.api || globalThis.window?.api
  const runId = context?.runId || context?.activeTaskId

  let toolExecId = null
  if (api?.db?.logToolExecution && runId) {
    try {
      const res = await api.db.logToolExecution({
        runId,
        toolName: name,
        arguments: toolCall.args,
        status: 'running'
      })
      toolExecId = res?.execution?.id || res?.id
    } catch {}
  }

  const recordOutcome = async (outcomeResult, isError = false) => {
    if (!isError && context?.consistencyEngine) {
      try {
        if (['write_file', 'create_file', 'replace_in_file', 'edit_file'].includes(name)) {
          context.consistencyEngine.recordEvidence(EVIDENCE_TYPES.FILE_CHANGE, toolCall.args.path, { operation: name })
        } else if (name === 'run_command') {
          context.consistencyEngine.recordEvidence(EVIDENCE_TYPES.COMMAND_SUCCESS, toolCall.args.command)
        } else if (name.startsWith('browser_')) {
          context.consistencyEngine.recordEvidence(EVIDENCE_TYPES.BROWSER_VERIFICATION, name)
        } else {
          context.consistencyEngine.recordEvidence(EVIDENCE_TYPES.TOOL_SUCCESS, name)
        }
      } catch {}
    }
    if (api?.db?.updateToolExecution && toolExecId) {
      try {
        await api.db.updateToolExecution({
          id: toolExecId,
          result: outcomeResult,
          status: isError ? 'failed' : 'success',
          error: isError ? outcomeResult : null
        })
      } catch {}
    }
    return outcomeResult
  }

  // Shell commands that pause for an explicit user decision. In review mode
  // every command needs approval; otherwise only destructive tools gated by
  // the runner itself (e.g. delete_file) do.
  const REVIEW_GATED_TOOLS = new Set(['run_command', 'verify', 'start_process'])

  const askUser = async (reason) => {
    if (typeof tools?.requestApproval !== 'function') return false
    try {
      return Boolean(await tools.requestApproval({ tool: name, args: toolCall.args, reason }))
    } catch {
      return false
    }
  }

  const formatOutcome = (outcome) => {
    if (outcome.data?.status === 'AWAITING_USER_APPROVAL') {
      return `Tool '${name}' is waiting for user approval: ${JSON.stringify(toolCall.args)}.`
    }

    if (outcome.success) {
      const data = outcome.data
      if ((name === 'read_file' || name === 'read_files') && data) {
        if (data.exists === false) {
          return `read_file: File "${toolCall.args.path}" does NOT exist. Do NOT call read_file on this path again. Use write_file to create it with the required content.`
        }
        if (Array.isArray(data.files)) {
          const missing = data.files.filter(f => f.exists === false)
          if (missing.length) {
            const missingList = missing.map(f => f.path).join(', ')
            return `read_files:\n${clip(JSON.stringify(data), 12000)}\n\nMISSING FILES: ${missingList}. Do NOT retry read on these paths. Use write_file to create them.`
          }
        }
      }
      return `${name}:\n${clip(JSON.stringify(data), 12000)}`
    }

    const errMsg = String(outcome.error || '')
    if ((name === 'read_file' || name === 'edit_file' || name === 'replace_in_file') &&
        (errMsg.includes('does not exist') || errMsg.includes('ENOENT') || errMsg.includes('no such file'))) {
      return `${name} failed: ${errMsg}\nACTION REQUIRED: Use write_file to create "${toolCall.args.path}" with the full desired content.`
    }
    return `${name} failed: ${errMsg}`
  }

  if (name !== 'finish') {
    if (name === 'run_command' && isCommandBlocked(String(toolCall.args.command || ''))) {
      const msg = `run_command blocked for safety: ${toolCall.args.command}`
      return recordOutcome(msg, true)
    }

    if ((name === 'run_command' || name === 'start_process') &&
        /(?:serve|http\.server|http-server|live-server).*?\b3000\b/i.test(String(toolCall.args.command || ''))) {
      const msg = `Simple IDE Notice: Port 3000 is already actively running the built-in development server with live preview at http://localhost:3000. Do not start a separate server on port 3000 (avoided EADDRINUSE). The preview is already live.`
      return recordOutcome(msg, false)
    }

    // Review mode: ask BEFORE running any shell command.
    if (context.commandApproval === 'review' && REVIEW_GATED_TOOLS.has(name)) {
      const granted = await askUser('Command review is enabled: approve or deny this shell command.')
      if (!granted) {
        const msg = `${name} denied by user: the command was NOT run. Do not retry it; continue with inspection and edits, or finish with the exact command the user can run themselves.`
        context?.messageWindow?.addFact?.(`User denied ${name}; do not retry it without explicit new approval.`)
        return recordOutcome(msg, true)
      }
      const outcome = await runner.run(toolCall, {}, { approved: true })
      const resText = formatOutcome(outcome)
      return recordOutcome(resText, !outcome.success)
    }

    const outcome = await runner.run(toolCall)

    // Destructive tools (e.g. delete_file) pause in every mode until approved.
    if (outcome.data?.status === 'AWAITING_USER_APPROVAL') {
      const granted = await askUser(`Destructive operation '${name}' requires explicit user approval.`)
      if (!granted) {
        const msg = `${name} denied by user: the operation was NOT executed. Do not retry it; work around it or finish without it.`
        context?.messageWindow?.addFact?.(`User denied ${name}; do not retry it without explicit new approval.`)
        return recordOutcome(msg, true)
      }
      const approvedOutcome = await runner.run(toolCall, {}, { approved: true })
      const resText = formatOutcome(approvedOutcome)
      return recordOutcome(resText, !approvedOutcome.success)
    }

    const resText = formatOutcome(outcome)
    return recordOutcome(resText, !outcome.success)
  }

  const finishText = `finish: ${toolCall.args.message || action.message || 'Done.'}`
  return recordOutcome(finishText, false)
}

export class RunResult {
  constructor({
    taskId,
    status,
    completed = false,
    verified = false,
    cancelled = false,
    failed = false,
    changedFiles = [],
    verification = null,
    error = null,
    summary = '',
    checkpoint = null,
    diagnostics = null
  }) {
    this.taskId = taskId || `task-${Date.now()}`
    this.status = status || 'Completed'
    this.completed = Boolean(completed)
    this.verified = Boolean(verified)
    this.cancelled = Boolean(cancelled)
    this.failed = Boolean(failed)
    this.changedFiles = Array.isArray(changedFiles) ? changedFiles : []
    this.verification = verification || { attempted: false, success: false, command: '', stdout: '', stderr: '', durationMs: 0 }
    this.error = error || null
    this.summary = summary || ''
    this.checkpoint = checkpoint || null
    this.diagnostics = diagnostics || null
  }

  toString() {
    return this.summary
  }
}

export async function runAgentTask({ taskId, task, context, tools = {}, onEvent, maxTurns = 50, signal, budgets = null }) {
  context = sanitizeWorkspaceContext(context)
  const activeTaskId = taskId || `task-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
  const observations = []
  const writtenFiles = new Set()
  const actionAttempts = new Map()
  const memory = loadAgentMemory(context.currentFolder)
  let hasVerified = false
  let lastVerification = { attempted: false, success: false, command: '', stdout: '', stderr: '', durationMs: 0 }
  let postWriteInspection = false

  await ensureAgentContextServices({ ...context, api: context.api || tools.api }, { signal })
  globalContextEngine.observationManager.clear()

  const api = tools.api || context.api || globalThis.window?.api
  let eventSeq = 0
  const consistencyEngine = new ConsistencyEngine(context.currentFolder, { api })
  context = { ...context, runId: activeTaskId, consistencyEngine }

  // Skills are advisory prompt context only. They are resolved before planning,
  // while AgentRuntime, ToolRunner, ChangeManager, and verification remain the
  // authorities that execute and prove work.
  const explicitMatch = String(task).match(/^\/skill\s+([a-z0-9-]+)/i)
  const explicitSlugs = explicitMatch ? [explicitMatch[1].toLowerCase()] : (context.explicitSkills || [])
  const requestedTask = explicitMatch ? String(task).replace(/^\/skill\s+[a-z0-9-]+\s*/i, '').trim() : task
  const skillsApi = api?.skills
  const skillDatabase = skillsApi ? {
    listSkills: async ({ workspaceId }) => {
      const response = await skillsApi.list(workspaceId)
      return response?.success ? response.skills.map(skill => ({ ...skill, workspace_id: skill.scope === 'WORKSPACE' ? workspaceId : skill.workspace_id, enabled: Boolean(skill.enabled), metadata: JSON.parse(skill.metadata_json || '{}') })) : []
    },
    getSkillUsageStats: async () => ({})
  } : null
  const skillRegistry = new SkillRegistry({ database: skillDatabase })
  const skillResolution = await skillRegistry.resolve(requestedTask, { workspaceId: context.workspaceId, explicitSlugs })
  context.skillContext = skillResolution.context
  for (const conflict of skillResolution.conflicts) onEvent?.({ type: 'SKILL_CONFLICT', ...conflict })
  if (skillResolution.selected.length) {
    onEvent?.({ type: 'SKILL_ACTIVATED', skills: skillResolution.selected.map(s => ({ slug: s.slug, source: s.selectionSource })) })
    for (const skill of skillResolution.selected) {
      const content = `${skill.instructions}\n${JSON.stringify(skill.metadata)}`
      let hash = 2166136261; for (let i = 0; i < content.length; i++) hash = Math.imul(hash ^ content.charCodeAt(i), 16777619)
      skillsApi?.recordUsage?.({ skillId: skill.id, agentRunId: activeTaskId, workspaceId: context.workspaceId, version: skill.version, contentHash: (hash >>> 0).toString(16), snapshot: { name: skill.name, slug: skill.slug, instructions: skill.instructions, metadata: skill.metadata }, selectionSource: skill.selectionSource })
    }
  }

  if (api?.db?.createAgentRun) {
    try {
      await api.db.createAgentRun({
        id: activeTaskId,
        workspaceId: context.currentFolder,
        userPrompt: task,
        state: 'PLANNING'
      })
    } catch (err) {
      console.warn('[runAgentTask] Failed to create DB agent run:', err?.message)
    }
  }

  // ── Milestone 4: Formal Agent Runtime State Machine ──────────────────
  const runtime = new AgentRuntime({
    onTransition: (from, to, event, payload) => {
      eventSeq++
      if (api?.db?.logAgentEvent) {
        try {
          api.db.logAgentEvent({ runId: activeTaskId, sequence: eventSeq, type: event, payload })
        } catch {}
      }
      if (api?.db?.updateAgentRunState) {
        try {
          api.db.updateAgentRunState({ id: activeTaskId, state: to })
        } catch {}
      }
      onEvent?.({ type: 'state.transition', from, to, event, payload })
    },
    onError: (error, event, state) => {
      onEvent?.({ type: 'state.error', error, event, state })
    }
  })

  const scanner = new WorkspaceScanner(context.currentFolder)
  const scannerState = await scanner.scan()
  rememberProjectFacts(scannerState)
  // Only require verification if we detected a framework, build tool, or package manager
  const requiresVerification = context.commandApproval !== 'review' && (scannerState.packageManager !== 'unknown' || scannerState.buildTool !== 'unknown' || scannerState.framework !== 'unknown')
  const runner = new ToolRunner(context.currentFolder, {
    abortSignal: signal,
    api: tools.api || context.api,
    onChange: change => {
      writtenFiles.add(change.path)
      globalContextEngine.notifyFileChange(change.path, change.after, change.operation)
      tools.onFileWritten?.(change.path, change.after, change.before, change)
      onEvent?.({ type: 'file.changed', action: { type: change.operation === 'edit' ? 'edit_file' : 'write_file', path: change.path }, change })
    }
  })
  const verifier = new VerificationManager(context.currentFolder, runner, { api: tools.api || context.api })

  runner.beginTransaction(activeTaskId)
  runtime.transition(AGENT_EVENTS.TASK_STARTED, { taskId: activeTaskId })

  const apiConfig = await getApiConfig().catch(() => ({ provider: 'openai', model: 'gpt-5.6-sol' }))
  const capabilities = globalRouter.getModelCapabilities(apiConfig.provider, apiConfig.model)
  // Phase 1 bounded runs: per-run, observation-only accounting. The ledger
  // records every LLM call below; it never truncates, enforces, or stops.
  const ledger = new RunLedger({
    runId: activeTaskId,
    model: apiConfig.model,
    contextWindow: capabilities.contextWindowTokens
  })
  // Phase 6 observability: read-only run timeline, created before any
  // restore/loop activity so the full lifespan is observable.
  const runStartedAt = Date.now()
  const timeline = new RunTimeline({ runId: activeTaskId })
  let currentModel = apiConfig.model
  const mustValidateStandaloneHtml = requiresStandaloneHtmlValidation(task)
  // Phase 2 bounded runs: the message window replaces the previously
  // unbounded nativeMessages array. Window size derives from model
  // capabilities: half of the usable context window (after the same output +
  // system reserves ContextBudgetManager uses), floored so small-context
  // models keep a usable minimum. The other half remains for the system
  // prompt, tool schemas, retrieval context, and generated output.
  const messageWindowBudget = Math.max(
    8000,
    Math.floor((capabilities.contextWindowTokens - 4096 - 2000) * 0.5)
  )
  const messageWindow = new MessageWindow({ maxWindowTokens: messageWindowBudget })
  // Seed immutable facts deterministically from existing run state only.
  messageWindow.addFact(`Task objective: ${clip(task, 500)}`)
  if (context.approvedPlan) messageWindow.addFact(`Approved plan: ${clip(String(context.approvedPlan), 1000)}`)
  // Expose the window to the shared action executor so user denials (durable
  // decisions) survive compaction as facts. Nothing else writes facts.
  const primeRouter = new PrimeRouter({
    adapter: new MainProcessRouterAdapter(api),
    mode: context.primeRouterMode || 'assist'
  })
  context = { ...context, messageWindow, primeRouter }

  // Phase 4 bounded resume: reconstruct bounded execution state from a
  // migrated checkpoint (facts + summary + recent exchanges + ledger) instead
  // of resurrecting unlimited history. The existing checkpoint-text injection
  // in buildUserPrompt is unchanged.
  if (context.resumeFromCheckpoint && context.checkpoint) {
    timeline.emit(TimelineTypes.RESUME_STARTED, {})
    const { checkpoint: migrated, warnings } = migrateCheckpoint(context.checkpoint)
    if (migrated) {
      const restored = restoreIntoWindow({ window: messageWindow, checkpoint: migrated })
      for (const note of [...warnings, ...restored.warnings]) {
        observations.push(`Checkpoint note: ${note}`)
      }
      if (migrated.ledger) ledger.restore(migrated.ledger)
      timeline.emit(TimelineTypes.RESUME_COMPLETED, {
        restoredMessages: restored.restoredMessages,
        facts: messageWindow.facts.length,
        hasSummary: Boolean(messageWindow.summary),
        ledgerTurns: ledger.turns
      })
    } else {
      observations.push('Saved checkpoint was unusable; continuing fresh from the approved plan.')
      for (const note of warnings) observations.push(`Checkpoint note: ${note}`)
      timeline.emit(TimelineTypes.RESUME_COMPLETED, { freshStart: true, warnings: warnings.length })
    }
  }

  // Phase 5 budgets: one central policy decision point evaluated once per
  // turn. The baseline is captured AFTER resume restoration above, so a
  // resumed run continues the same allocation instead of silently resetting
  // usage. Dimensions: input / output / cost (only with pricing) / turns
  // (loop bound) / per-request share (observed via MessageWindow, enforced
  // there). No enforcement happens here at construction.
  const budgetPolicy = new BudgetPolicy({ contextWindow: capabilities.contextWindowTokens, budgets })
  const budgetBaseline = ledger.getTotals()
  let lastBudgetState = BUDGET_STATES.NORMAL
  let lastBudgetDecision = null
  let conservativeMode = false
  // Approved malformed-output safety cap: consecutive unparseable responses
  // (invalid JSON in fallback mode, or empty content with no tool calls in
  // native mode). Ordinary tool failures and refusals never count.
  let malformedStreak = 0

  // Bounded transient retry for model calls. Every attempt records through
  // the standard usageSink path (including failed attempts, conservatively);
  // aborts and non-transient errors rethrow immediately. Budget exhaustion is
  // never retried — the turn-top policy stops the run instead.
  // Phase 6: each attempt boundary emits read-only timeline events (request,
  // response with latency/outcome, retry progress). No policy influence.
  const requestWithRetry = (fn, kind = 'agent', turn = null) => withBoundedRetries(async () => {
    const startedAt = Date.now()
    timeline.emit(TimelineTypes.LLM_REQUEST, { turn, kind })
    try {
      const out = await fn()
      timeline.emit(TimelineTypes.LLM_RESPONSE, { turn, kind, durationMs: Date.now() - startedAt, ok: true })
      return out
    } catch (error) {
      timeline.emit(TimelineTypes.LLM_RESPONSE, {
        turn, kind,
        durationMs: Date.now() - startedAt,
        ok: false,
        category: (error && error.category) || null,
        failureClass: classifyFailureClass(error)
      })
      throw error
    }
  }, {
    maxAttempts: MAX_MODEL_ATTEMPTS_PER_TURN,
    signal,
    onEvent,
    onRetry: ({ attempt, maxAttempts, error, willRetry }) => {
      timeline.emit(willRetry ? TimelineTypes.RETRY_STARTED : TimelineTypes.RETRY_EXHAUSTED, {
        turn, kind,
        attempt,
        maxAttempts,
        category: (error && error.category) || null,
        failureClass: classifyFailureClass(error),
        model: currentModel
      })
      if (!willRetry && error && error.category === 'PROVIDER_TIMEOUT') {
        timeline.emit(TimelineTypes.PROVIDER_TIMEOUT, { turn, kind, model: currentModel, category: error.category })
      }
    }
  })

  // Clean incomplete stop shared by budget exhaustion and the malformed cap.
  // Mirrors the max-turns path: changes preserved, checkpoint attached for
  // manual recovery, run marked failed with an explicit resource reason.
  // Phase 6: emits the fatal transition event and attaches diagnostics.
  const stopRunIncomplete = async ({ error, summary, reason = 'budget' }) => {
    await runner.commitTransaction(activeTaskId)
    saveAgentMemory(context.currentFolder, {
      task: clip(task, 500),
      result: clip(summary, 700),
      files: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
      plan: context.approvedPlan ? clip(context.approvedPlan, 12000) : null,
      status: 'incomplete',
      timestamp: Date.now()
    })
    timeline.emit(reason === 'malformed' ? TimelineTypes.MALFORMED_OUTPUT : TimelineTypes.BUDGET_EXHAUSTED, {
      turn: ledger.turns, fatal: true, error: String(error).slice(0, 300)
    })
    return new RunResult({
      taskId: activeTaskId,
      status: 'Incomplete',
      completed: false,
      verified: false,
      cancelled: false,
      failed: true,
      changedFiles: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
      error,
      summary,
      checkpoint: createCheckpoint(),
      diagnostics: buildDiagnostics('failed', reason)
    })
  }

  // Phase 6 observability: model tracking, diagnostics builder, and the
  // shared sink stay here (after budget setup); the timeline itself was
  // created above so resume activity is observable too. Emitting never
  // influences execution; every policy input stays ledger/window/budget.
  const recordAndTrack = (call) => {
    if (call && call.model && call.model !== currentModel) {
      timeline.emit(TimelineTypes.MODEL_SWITCH, {
        turn: ledger.turns, from: currentModel, to: call.model,
        provider: (call && call.provider) || null
      })
      currentModel = call.model
    }
    return ledger.recordCall(call)
  }
  const modelMetrics = () => ledger.getSegments().map(segment => ({
    ...segment,
    retries: timeline.events.filter(event => event.type === TimelineTypes.RETRY_STARTED && event.model === segment.model).length
  }))
  const buildDiagnostics = (status, reason = null) => ({
    status,
    reason,
    runId: activeTaskId,
    durationMs: Date.now() - runStartedAt,
    turns: ledger.turns,
    model: currentModel,
    provider: apiConfig.provider,
    totals: ledger.getTotals(),
    outcomes: ledger.getOutcomeTotals(),
    models: modelMetrics(),
    gauges: budgetPolicy.gauges({
      totals: ledger.getTotals(),
      baseline: budgetBaseline,
      windowShare: lastWindowReport ? lastWindowReport.tokensAfter / capabilities.contextWindowTokens : 0,
      windowLimit: capabilities.contextWindowTokens,
      turn: ledger.turns,
      maxTurns
    }),
    budget: lastBudgetDecision,
    timeline: timeline.tail(100),
    timelineDropped: timeline.dropped,
    window: ledger.getWindow(),
    compaction: ledger.getCompaction(),
    failedCalls: ledger.getFailedCalls()
  })
  timeline.emit(TimelineTypes.RUN_STARTED, {
    model: apiConfig.model, provider: apiConfig.provider, maxTurns,
    budgets: { ...budgetPolicy.limits }
  })
  let useNativeTools = capabilities.supportsNativeTools
  let nativeToolMisses = 0

  // Phase 2 bounded runs: current task state is recomposed from live run
  // state every turn (never duplicated from history) and injected by the
  // message window alongside facts. Reuses existing clip/getRelativePath.
  const buildRunTaskState = (turn) => {
    const files = [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)).slice(0, 20)
    return [
      `Objective: ${clip(task, 500)}`,
      `Progress: turn ${turn} of up to ${maxTurns}.`,
      context.approvedPlan
        ? 'An approved implementation plan is in effect; complete its milestones before finishing.'
        : 'No approved plan; work directly toward the objective.',
      `Files changed so far: ${files.length ? files.join(', ') : 'none'}.`,
      `Verification: ${hasVerified ? 'passed' : (requiresVerification ? 'pending' : 'not required for this task')}.`
    ].join('\n')
  }

  // Phase 4: v2 state checkpoint built atomically in one synchronous call at
  // the loop boundary, so summary, facts, ledger, and recent context describe
  // the same turn. Never a transcript dump: recentMessages is unit-bounded.
  // Phase 6: emits a read-only creation event with version and byte size.
  const createCheckpoint = () => {
    const checkpoint = buildCheckpointV2({
    base: {
      task: clip(task, 2000),
      workspace: context.currentFolder,
      approvedPlan: clip(context.approvedPlan || '', 12000),
      changedFiles: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
      observations: observations.slice(-24).map(item => clip(String(item), 1800)),
      verification: lastVerification,
      runtimeHistory: runtime.getHistory().slice(-80)
    },
    ledger,
    messageWindow,
    meta: {
      model: apiConfig.model,
      provider: apiConfig.provider,
      runId: activeTaskId,
      turns: ledger.turns,
      maxTurns
    }
    })
    let checkpointBytes = 0
    try {
      checkpointBytes = JSON.stringify(checkpoint).length
    } catch {
      checkpointBytes = 0
    }
    timeline.emit(TimelineTypes.CHECKPOINT_CREATED, {
      version: checkpoint.version, bytes: checkpointBytes, turns: ledger.turns
    })
    return checkpoint
  }

  // This is deliberately run by the runtime, not just requested in the model
  // prompt. A model is therefore unable to report a partial landing page as a
  // successful delivery merely by skipping its own validation tool call.
  const validateRequiredDeliverable = async () => {
    if (!mustValidateStandaloneHtml) return true

    const outcome = await runner.run('validate_standalone_html', { path: 'index.html' })
    const report = outcome.success ? outcome.data : { valid: false, issues: [outcome.error || 'Unable to read index.html for validation.'] }
    const observation = `standalone deliverable validation:\n${clip(JSON.stringify(report), 12000)}`
    observations.push(observation)
    globalContextEngine.addObservation({
      turn: runtime.getHistory().length,
      tool: 'validate_standalone_html',
      status: report.valid ? 'success' : 'failed',
      summary: clip(observation, 300),
      details: clip(observation, 12000)
    })
    onEvent?.({ type: 'observation', message: observation })

    if (report.valid) return true
    const issueText = Array.isArray(report.issues) ? report.issues.join(' ') : 'The document is incomplete.'
    onEvent?.({ type: 'error', message: `Completion paused: index.html is not deliverable yet. ${issueText}` })
    return false
  }

  // Phase 3 rolling summarizer: per-run compaction state. lastWindowReport
  // carries the previous turn's evicted exchanges; lastSummarizedEvicted is
  // the compaction boundary marker so already-summarized material is never
  // summarized again.
  let lastWindowReport = null
  let lastSummarizedEvicted = 0

  // Run one summarization round and atomically commit a valid replacement.
  // Failures keep the previous summary and never fail the run (AbortError
  // propagates so cancellation still terminates immediately).
  const runSummarization = async (turn) => {
    const verificationText = lastVerification?.attempted
      ? `Verification ${lastVerification.success ? 'passed' : 'failed'}${lastVerification.command ? ` (${lastVerification.command})` : ''}.`
      : 'Verification has not run yet.'
    const input = buildSummarizerInput({
      previousSummary: messageWindow.summary,
      evictedExchanges: lastWindowReport?.evictedContent || [],
      facts: messageWindow.facts,
      taskState: buildRunTaskState(turn),
      verificationText,
      maxInputTokens: SUMMARIZER_INPUT_MAX_TOKENS
    })
    const startedAt = Date.now()
    timeline.emit(TimelineTypes.SUMMARIZATION_STARTED, { turn, inputTokens: input.stats.estimatedTokens, exchanges: input.stats.exchangesIncluded })
    let result
    try {
      result = await summarize({
        llmCall: (summarizerInput) => requestWithRetry(() => requestAIText({
          systemMessage: SUMMARIZER_SYSTEM_PROMPT,
          userMessage: summarizerInput.text,
          useCache: false,
          waitForRateLimit: true,
          temperature: 0,
          maxTokens: SUMMARIZER_MAX_TOKENS,
          signal,
          usageSink: recordAndTrack,
          callType: 'summarizer',
          timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS
        }), 'summarizer', turn),
        input
      })
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error
      result = { ok: false, reason: 'provider', error: error?.message || String(error) }
    }
    if (!result || !result.ok) {
      const reason = (result && result.reason) || 'unknown'
      observations.push(`Summarization skipped this turn (${reason}); keeping the previous summary.`)
      ledger.recordSummarizerFailure()
      timeline.emit(TimelineTypes.SUMMARIZATION_FAILED, { turn, reason, durationMs: Date.now() - startedAt })
      lastSummarizedEvicted = ledger.getWindow().evictedMessages
      return false
    }
    const merged = mergeWithDeterministic(result.summary, {
      objective: task,
      filesChanged: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
      verification: {
        status: !lastVerification?.attempted ? 'unknown' : (lastVerification.success ? 'passed' : 'failed'),
        command: lastVerification?.command || '',
        detail: ''
      },
      plan: context.approvedPlan ? String(context.approvedPlan).slice(0, 2000) : ''
    })
    if (!merged.ok || !messageWindow.setSummary(merged.summary)) {
      observations.push(`Summarizer produced an unusable summary (${(merged && merged.reason) || 'rejected'}); keeping the previous summary.`)
      ledger.recordSummarizerFailure()
      timeline.emit(TimelineTypes.SUMMARIZATION_FAILED, { turn, reason: (merged && merged.reason) || 'rejected', durationMs: Date.now() - startedAt })
      lastSummarizedEvicted = ledger.getWindow().evictedMessages
      return false
    }
    lastSummarizedEvicted = ledger.getWindow().evictedMessages
    timeline.emit(TimelineTypes.SUMMARIZATION_COMPLETED, { turn, durationMs: Date.now() - startedAt })
    onEvent?.({ type: 'status', message: 'Compacted older history into a rolling summary.' })
    return true
  }

  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      ledger.advanceTurn()
      if (signal?.aborted) {
        runtime.transition(AGENT_EVENTS.USER_CANCELLED)
        await runner.cancelTaskProcesses()
        await runner.commitTransaction(activeTaskId)
        timeline.emit(TimelineTypes.RUN_CANCELLED, { turns: ledger.turns })
        return new RunResult({
          taskId: activeTaskId,
          status: 'Cancelled',
          completed: false,
          verified: false,
          cancelled: true,
          failed: false,
          changedFiles: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
          error: 'Agent task was cancelled by user.',
          summary: 'Agent cancelled. Completed changes were preserved.',
          diagnostics: buildDiagnostics('cancelled', 'user-cancel')
        })
      }

      onEvent?.({ type: 'thinking', message: `Execution step ${turn}...` })

      // Phase 5 budgets: single central evaluation per turn, AFTER summarizer
      // spend so exhaustion accounts it. WARNING only announces; CONSERVATIVE
      // narrows optional work below; EXHAUSTED stops cleanly with checkpoint.
      const budgetDecision = budgetPolicy.evaluate({
        totals: ledger.getTotals(),
        baseline: budgetBaseline,
        windowShare: lastWindowReport ? lastWindowReport.tokensAfter / capabilities.contextWindowTokens : 0,
        turn,
        maxTurns
      })
      if (budgetDecision.state !== lastBudgetState) {
        lastBudgetState = budgetDecision.state
        lastBudgetDecision = budgetDecision
        if (budgetDecision.state !== BUDGET_STATES.NORMAL) {
          onEvent?.({ type: 'status', message: `Resource budget ${budgetDecision.state}: ${budgetDecision.message}` })
        }
        // Read-only transition events for diagnostics; policy already decided.
        if (budgetDecision.state === BUDGET_STATES.WARNING) {
          timeline.emit(TimelineTypes.BUDGET_WARNING, { turn, dimension: budgetDecision.dimension, message: budgetDecision.message })
        } else if (budgetDecision.state === BUDGET_STATES.CONSERVATIVE) {
          timeline.emit(TimelineTypes.CONSERVATIVE_MODE, { turn, dimension: budgetDecision.dimension, message: budgetDecision.message })
        }
      } else {
        lastBudgetDecision = budgetDecision
      }
      if (budgetDecision.state === BUDGET_STATES.EXHAUSTED) {
        const exhaustedSummary = `Agent paused: run resource budget exhausted (${budgetDecision.dimension}). ${budgetDecision.message} Completed changes were preserved, and a checkpoint was saved; resume starts a fresh allocation with prior usage retained in history.`
        return await stopRunIncomplete({ error: budgetDecision.message, summary: exhaustedSummary, reason: 'budget' })
      }
      conservativeMode = budgetDecision.state === BUDGET_STATES.CONSERVATIVE

      // Phase 3 rolling summarizer: compact history the window could not
      // retain, at most MAX_SUMMARIZER_CALLS_PER_RUN times per run and only
      // when genuinely new exchanges were evicted since the last summary.
      // Skipped in conservative mode (no new compaction spend under pressure).
      // Observation only — no budgets enforced, no behavior forced.
      if (!conservativeMode && lastWindowReport && lastWindowReport.evicted > 0) {
        const evictedTotal = ledger.getWindow().evictedMessages
        if (canSummarize({
          summarizerCalls: ledger.getCompaction().calls,
          maxCalls: MAX_SUMMARIZER_CALLS_PER_RUN,
          evictedSinceSummary: evictedTotal - lastSummarizedEvicted
        })) {
          await runSummarization(turn)
        }
      }

      globalContextEngine.updateState({
        workspacePath: context.currentFolder,
        activeFile: context.activeFile ? getRelativePath(context.activeFile.path, context.currentFolder) : null,
        selection: context.selectedCode,
        openTabs: context.openFiles?.map(f => getRelativePath(f.path, context.currentFolder)) || []
      })

      // Prime Router local decision pass
      const routerDecision = await primeRouter.decide({
        request: requestedTask,
        state: runtime.getState(),
        availableTools: runner.getAvailableTools().map(t => t.name || t),
        recentContext: observations.slice(-5),
        runContext: { turn, activeTaskId },
        signal
      })
      timeline.emit('ROUTE_DECIDED', { turn, ...routerDecision })
      onEvent?.({ type: 'prime_router.decided', decision: routerDecision })

      const relActiveFile = context.activeFile ? getRelativePath(context.activeFile.path, context.currentFolder) : null
      // Conservative mode narrows optional retrieval to half the window.
      // Facts, tools, verification, and task state are never touched.
      const retrievalTokens = conservativeMode
        ? Math.floor(capabilities.contextWindowTokens / 2)
        : capabilities.contextWindowTokens
      const contextPackage = await globalContextEngine.buildContextPackage({
        task: requestedTask,
        activeFile: relActiveFile,
        selection: context.selectedCode,
        openTabs: context.openFiles?.map(f => getRelativePath(f.path, context.currentFolder)) || [],
        writtenFiles,
        activeFileContent: context.activeFile?.content || null,
        totalTokens: retrievalTokens,
        symbolQuery: routerDecision?.symbol_query
      })

      const userMessageStr = PromptContextFormatter.formatPromptContext(contextPackage)
      const executionPrompt = buildUserPrompt({
        task,
        context,
        observations: observations.slice(-16),
        memory,
        workspace: scannerState,
        dynamicContextStr: `${context.skillContext.text}\n\n${userMessageStr}`
      })

      if (useNativeTools) {
        const systemMessage = buildSystemPrompt({
          task,
          hasWritten: writtenFiles.size > 0,
          hasVerified,
          requiresVerification,
          workspace: scannerState,
          nativeTools: true,
          readyToComplete: postWriteInspection && !requiresVerification,
          commandApproval: context.commandApproval
        })
        if (messageWindow.isEmpty()) {
          messageWindow.seed(NativeToolAdapter.createInitialMessages(apiConfig.provider, systemMessage, executionPrompt))
        }
        const activeTools = filterToolsByFamily(runner.getAvailableTools(), routerDecision?.toolFamily, routerDecision?.suggested_tools)
        const formattedTools = NativeToolAdapter.formatToolsForProvider(apiConfig.provider, activeTools)
        // Phase 2 bounded runs: the request context is the composed window
        // (system anchor + facts + task state + recent exchanges), never the
        // raw unbounded history. Sizes are recorded to the ledger as
        // observations only; nothing is enforced.
        const windowReport = messageWindow.build({ taskState: buildRunTaskState(turn) })
        ledger.recordWindow(windowReport)
        lastWindowReport = windowReport
        timeline.emit(TimelineTypes.WINDOW_BUILT, {
          turn,
          tokensBefore: windowReport.tokensBefore,
          tokensAfter: windowReport.tokensAfter,
          retained: windowReport.retained,
          evicted: windowReport.evicted,
          orphansDropped: windowReport.orphansDropped,
          exchangesRetained: windowReport.exchangesRetained,
          factsIncluded: windowReport.factsIncluded,
          summaryIncluded: windowReport.summaryIncluded,
          overflow: windowReport.overflow
        })
        const rawResponse = await requestWithRetry(() => requestAIText({
          systemMessage,
          userMessage: executionPrompt,
          useCache: false,
          waitForRateLimit: true,
          temperature: 0.15,
          maxTokens: 4096,
          signal,
          tools: formattedTools,
          messages: windowReport.messages,
          returnRaw: true,
          usageSink: recordAndTrack,
          timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS
        }), 'agent', turn)

        if (signal?.aborted) {
          runtime.transition(AGENT_EVENTS.USER_CANCELLED)
          await runner.cancelTaskProcesses()
          await runner.commitTransaction(activeTaskId)
          timeline.emit(TimelineTypes.RUN_CANCELLED, { turns: ledger.turns })
          return new RunResult({
            taskId: activeTaskId,
            status: 'Cancelled',
            completed: false,
            verified: false,
            cancelled: true,
            failed: false,
            changedFiles: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
            error: 'Agent task was cancelled by user.',
            summary: 'Agent cancelled. Completed changes were preserved.',
            diagnostics: buildDiagnostics('cancelled', 'user-cancel')
          })
        }

        const nativeCalls = NativeToolAdapter.extractNativeToolCalls(apiConfig.provider, rawResponse)

        if (nativeCalls.length > 0) {
          nativeToolMisses = 0
          // A parseable tool-call response resets the malformed streak.
          malformedStreak = 0
          runtime.transition(AGENT_EVENTS.PLAN_RECEIVED, { turn })
          const asstMsg = NativeToolAdapter.formatAssistantMessage(apiConfig.provider, rawResponse)
          if (asstMsg) messageWindow.push(asstMsg)
          let shouldFinish = false
          let finishMessage = 'Done.'
          const isAllReadOnly = nativeCalls.length > 1 && nativeCalls.every(tc => NativeToolAdapter.isReadOnlyTool(tc.name))

          if (isAllReadOnly) {
            onEvent?.({ type: 'status', message: `Executing ${nativeCalls.length} read operations concurrently...` })
            const results = await Promise.all(nativeCalls.map(async (toolCall) => {
              onEvent?.({ type: 'tool', action: { type: toolCall.name, ...toolCall.args } })
              const fingerprint = `${toolCall.name}:${toolCall.args?.path || toolCall.args?.command || toolCall.args?.query || toolCall.args?.id || ''}`
              const attempts = (actionAttempts.get(fingerprint) || 0) + 1
              actionAttempts.set(fingerprint, attempts)

              const observation = attempts > 3
                ? `${toolCall.name} blocked: this identical action has already been attempted three times. Diagnose the previous output and choose a different action.`
                : await executeAction(toolCall, context, {
                    ...tools,
                    onFileWritten: (...fileArgs) => {
                      const [filePath] = fileArgs
                      writtenFiles.add(filePath)
                      tools.onFileWritten?.(...fileArgs)
                    }
                  }, runner)

              const failed = observationFailed(observation)
              return {
                toolCall,
                observation,
                failed,
                toolRes: new ToolResult({
                  toolCallId: toolCall.id,
                  name: toolCall.name,
                  success: !failed,
                  output: observation,
                  error: failed ? observation : null
                })
              }
            }))

            for (const res of results) {
              if (res.toolCall.name === 'finish') {
                shouldFinish = true
                finishMessage = res.toolCall.args?.message || 'Done.'
              }
              observations.push(res.observation)
              globalContextEngine.addObservation({
                turn,
                tool: res.toolCall.name,
                status: res.failed ? 'failed' : 'success',
                summary: clip(res.observation, 300),
                details: clip(res.observation, 12000)
              })
              onEvent?.({ type: 'observation', message: res.observation })
              messageWindow.push(NativeToolAdapter.formatToolResultMessage(apiConfig.provider, res.toolRes))
            }
            runtime.transition(AGENT_EVENTS.ACTION_COMPLETED, { tool: 'parallel_read_batch', turn })
          } else {
            for (const [callIndex, toolCall] of nativeCalls.entries()) {
              if (callIndex > 0 && runtime.getState() === AGENT_STATES.EVALUATING) {
                runtime.transition(AGENT_EVENTS.MORE_ACTIONS, { turn })
              }
              onEvent?.({ type: 'tool', action: { type: toolCall.name, ...toolCall.args } })
              
              const fingerprint = `${toolCall.name}:${toolCall.args.path || toolCall.args.command || toolCall.args.query || toolCall.args.id || ''}`
              const attempts = (actionAttempts.get(fingerprint) || 0) + 1
              actionAttempts.set(fingerprint, attempts)

              const observation = attempts > 3
                ? `${toolCall.name} blocked: this identical action has already been attempted three times. Diagnose the previous output and choose a different action.`
                : await executeAction(toolCall, context, {
                    ...tools,
                    onFileWritten: (...fileArgs) => {
                      const [filePath] = fileArgs
                      writtenFiles.add(filePath)
                      tools.onFileWritten?.(...fileArgs)
                    }
                  }, runner)

              observations.push(observation)
              globalContextEngine.addObservation({
                turn,
                tool: toolCall.name,
                status: observationFailed(observation) ? 'failed' : 'success',
                summary: clip(observation, 300),
                details: clip(observation, 12000)
              })
              onEvent?.({ type: 'observation', message: observation })
              runtime.transition(AGENT_EVENTS.ACTION_COMPLETED, { tool: toolCall.name, turn })

              const failed = observationFailed(observation)
              const toolRes = new ToolResult({
                toolCallId: toolCall.id,
                name: toolCall.name,
                success: !failed,
                output: observation,
                error: failed ? observation : null
              })
              messageWindow.push(NativeToolAdapter.formatToolResultMessage(apiConfig.provider, toolRes))

              // Inject reflection meta-prompt. Skipped in conservative mode:
              // optional context spend is the first thing shed under pressure.
              if (!conservativeMode) {
                messageWindow.push({
                role: 'user',
                content: `REFLECTION on the last action:
- Tool: ${toolCall.name}
- Result: ${clip(observation, 500)}

Before your next action, answer internally:
1. Did this action succeed or fail?
2. Does the result match what I expected?
3. Am I closer to completing the task?
4. Should I continue this approach, or pivot to a different strategy?
5. What is the most important next action?

Then proceed with your next tool call.`
                }, MESSAGE_KINDS.SCAFFOLD)
              }

              if (WRITE_ACTION_TYPES.has(toolCall.name) && !failed) {
                hasVerified = false
                postWriteInspection = false
              } else if (toolCall.name === 'read_file' && writtenFiles.size > 0 && !failed) {
                postWriteInspection = true
              }

              if (toolCall.name === 'run_command' && !failed) {
                const isVerif = await verifier.isVerificationCommand(toolCall.args.command, scannerState)
                if (isVerif) {
                  hasVerified = true
                  lastVerification = { attempted: true, success: true, command: toolCall.args.command, stdout: observation, stderr: '', durationMs: 0 }
                }
              }

              if (toolCall.name === 'finish') {
                shouldFinish = true
                finishMessage = toolCall.args.message || 'Done.'
              }
            }
          }

          if (shouldFinish) {
            if (!(await validateRequiredDeliverable())) {
              messageWindow.push({
                role: 'user',
                content: 'Completion is blocked because the standalone index.html validation failed. Repair every reported issue using tools, validate again, and only then complete the task.'
              }, MESSAGE_KINDS.SCAFFOLD)
              continue
            }
            const finishResult = runtime.transition(AGENT_EVENTS.FINISH_REQUESTED, {
              requiresVerification,
              hasWrittenFiles: writtenFiles.size > 0,
              hasVerified
            })

            if (runtime.getState() === AGENT_STATES.VERIFYING) {
              onEvent?.({ type: 'verification.started', message: 'Running the project\u2019s detected verification command.' })
              const verification = await verifier.verify({ scannerState, runId: activeTaskId })
              lastVerification = verification
              const verificationObservation = `automatic verification:\n${clip(JSON.stringify(verification), 12000)}`
              observations.push(verificationObservation)
              onEvent?.({ type: 'observation', message: verificationObservation })
              if (verification.success) {
                hasVerified = true
                runtime.transition(AGENT_EVENTS.VERIFICATION_PASSED)
              } else {
                runtime.transition(AGENT_EVENTS.VERIFICATION_FAILED)
                onEvent?.({ type: 'error', message: 'Verification failed. Diagnosing and recovering.' })
                continue
              }
            }

            if (runtime.getState() === AGENT_STATES.REPAIRING) {
              continue
            }

            await runner.commitTransaction(activeTaskId)
            if (writtenFiles.size) tools.onWorkspaceChanged?.([...writtenFiles])
            saveAgentMemory(context.currentFolder, {
              task: clip(task, 500),
              result: clip(completionSummary(finishMessage, writtenFiles, lastVerification), 700),
              files: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
              plan: context.approvedPlan ? clip(context.approvedPlan, 12000) : null,
              timestamp: Date.now()
            })

            timeline.emit(TimelineTypes.RUN_COMPLETED, { turns: ledger.turns })
            return new RunResult({
              taskId: activeTaskId,
              status: 'Completed',
              completed: true,
              verified: hasVerified,
              cancelled: false,
              failed: false,
              changedFiles: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
              verification: lastVerification,
              summary: completionSummary(finishMessage, writtenFiles, lastVerification),
              runtimeHistory: runtime.getHistory(),
              diagnostics: buildDiagnostics('completed')
            })
          }

          continue
        } else {
          // A native model signals completion by replying with ordinary assistant text.
          const textContent = globalRouter.extractResponse(apiConfig.provider, rawResponse)
          if (!String(textContent || '').trim()) {
            // Narrowly defined malformed case: no tool calls and no readable
            // text. Tool failures and refusals carry text and never count.
            malformedStreak += 1
            observations.push(`Empty model response (${malformedStreak}/${MAX_CONSECUTIVE_MALFORMED}). Asking it to recover.`)
            timeline.emit(TimelineTypes.MALFORMED_OUTPUT, { turn, kind: 'empty-response', streak: malformedStreak, fatal: malformedStreak >= MAX_CONSECUTIVE_MALFORMED })
            if (malformedStreak >= MAX_CONSECUTIVE_MALFORMED) {
              return await stopRunIncomplete({
                error: `Model returned unusable output ${MAX_CONSECUTIVE_MALFORMED} times in a row (no tool calls and no readable text). Stopping to avoid wasting further calls; completed changes were preserved in the checkpoint.`,
                summary: `Stopped after ${MAX_CONSECUTIVE_MALFORMED} consecutive unusable model responses. Completed changes were preserved and can be resumed from the checkpoint.`,
                reason: 'malformed'
              })
            }
            continue
          }
          malformedStreak = 0
          if (runtime.getState() === AGENT_STATES.PLANNING) {
            const assistantMessage = NativeToolAdapter.formatAssistantMessage(apiConfig.provider, rawResponse)
            if (assistantMessage) messageWindow.push(assistantMessage)
            nativeToolMisses += 1
            messageWindow.push({
              role: 'user',
              content: 'This is an autonomous coding task, not a chat response. Inspect the workspace with the appropriate tool before reporting completion. Use a tool now.'
            }, MESSAGE_KINDS.SCAFFOLD)
            if (nativeToolMisses >= 2) {
              useNativeTools = false
              onEvent?.({ type: 'status', message: 'This model did not produce native tool calls; switching to the compatible action protocol.' })
            }
            onEvent?.({ type: 'error', message: 'The model tried to finish before inspecting the workspace; requesting tool use.' })
            continue
          }
          if (!(await validateRequiredDeliverable())) {
            messageWindow.push({
              role: 'user',
              content: 'Completion is blocked because the standalone index.html validation failed. Use tools to repair the document and validate it again; do not return a final response yet.'
            }, MESSAGE_KINDS.SCAFFOLD)
            continue
          }

          runtime.transition(AGENT_EVENTS.FINISH_REQUESTED, {
            requiresVerification,
            hasWrittenFiles: writtenFiles.size > 0,
            hasVerified
          })

          if (runtime.getState() === AGENT_STATES.VERIFYING) {
            onEvent?.({ type: 'verification.started', message: 'Verifying the completed changes.' })
            const verification = await verifier.verify({ scannerState, runId: activeTaskId })
            lastVerification = verification
            const verificationObservation = `automatic verification:\n${clip(JSON.stringify(verification), 12000)}`
            observations.push(verificationObservation)
            onEvent?.({ type: 'observation', message: verificationObservation })
            if (!verification.success) {
              runtime.transition(AGENT_EVENTS.VERIFICATION_FAILED)
              messageWindow.push({
                role: 'user',
                content: `Your attempted completion did not verify. Here is the structured verification result:\n${verificationObservation}\nContinue with tools: diagnose, edit, and rerun the relevant verification. Do not return a final answer yet.`
              }, MESSAGE_KINDS.SCAFFOLD)
              onEvent?.({ type: 'error', message: 'Verification failed. Returning the failure to the agent for repair.' })
              continue
            }
            hasVerified = true
            runtime.transition(AGENT_EVENTS.VERIFICATION_PASSED)
          }

          if (runtime.getState() === AGENT_STATES.REPAIRING) continue

          await runner.commitTransaction(activeTaskId)
          if (writtenFiles.size) tools.onWorkspaceChanged?.([...writtenFiles])
          saveAgentMemory(context.currentFolder, {
            task: clip(task, 500),
            result: clip(completionSummary(textContent, writtenFiles, lastVerification), 700),
            files: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
            plan: context.approvedPlan ? clip(context.approvedPlan, 12000) : null,
            timestamp: Date.now()
          })

          timeline.emit(TimelineTypes.RUN_COMPLETED, { turns: ledger.turns })
          return new RunResult({
            taskId: activeTaskId,
            status: 'Completed',
            completed: true,
            verified: hasVerified,
            cancelled: false,
            failed: false,
            changedFiles: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
            verification: lastVerification,
            summary: completionSummary(textContent, writtenFiles, lastVerification),
            runtimeHistory: runtime.getHistory(),
            diagnostics: buildDiagnostics('completed')
          })
        }
      }

      // Legacy Text JSON Protocol Fallback
      const raw = await requestWithRetry(() => requestAIText({
        systemMessage: buildSystemPrompt({ task, hasWritten: writtenFiles.size > 0, hasVerified, requiresVerification, workspace: scannerState, readyToComplete: postWriteInspection && !requiresVerification, commandApproval: context.commandApproval }),
        userMessage: executionPrompt,
        useCache: false,
        waitForRateLimit: true,
        temperature: 0.15,
        maxTokens: 4096,
        signal,
        usageSink: recordAndTrack,
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS
      }), 'agent', turn)

      if (signal?.aborted) {
        runtime.transition(AGENT_EVENTS.USER_CANCELLED)
        await runner.cancelTaskProcesses()
        await runner.commitTransaction(activeTaskId)
        timeline.emit(TimelineTypes.RUN_CANCELLED, { turns: ledger.turns })
        return new RunResult({
          taskId: activeTaskId,
          status: 'Cancelled',
          completed: false,
          verified: false,
          cancelled: true,
          failed: false,
          changedFiles: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
          error: 'Agent task was cancelled by user.',
          summary: 'Agent cancelled. Completed changes were preserved.',
          diagnostics: buildDiagnostics('cancelled', 'user-cancel')
        })
      }

      let plan
      try {
        plan = extractJsonObject(raw)
        runtime.transition(AGENT_EVENTS.PLAN_RECEIVED, { turn })
        malformedStreak = 0
      } catch (error) {
        malformedStreak += 1
        observations.push(`Invalid JSON from model:\n${clip(raw, 4000)}\nError: ${error.message}`)
        onEvent?.({ type: 'error', message: 'The model returned invalid agent JSON. Asking it to recover.' })
        timeline.emit(TimelineTypes.MALFORMED_OUTPUT, { turn, kind: 'invalid-json', streak: malformedStreak, fatal: malformedStreak >= MAX_CONSECUTIVE_MALFORMED })
        if (malformedStreak >= MAX_CONSECUTIVE_MALFORMED) {
          return await stopRunIncomplete({
            error: `Model returned invalid agent JSON ${MAX_CONSECUTIVE_MALFORMED} times in a row. Stopping to avoid wasting further calls; completed changes were preserved in the checkpoint.`,
            summary: `Stopped after ${MAX_CONSECUTIVE_MALFORMED} consecutive malformed model responses. Completed changes were preserved and can be resumed from the checkpoint.`,
            reason: 'malformed'
          })
        }
        continue
      }

      if (plan.status) {
        onEvent?.({ type: 'status', message: plan.status })
      }

      if (plan.thought) {
        onEvent?.({ type: 'thought', message: plan.thought })
      }

      if (Array.isArray(plan.plan) && plan.plan.length) {
        onEvent?.({ type: 'plan', message: plan.plan.slice(0, 4).map((step, index) => `${index + 1}. ${step}`).join('\n') })
      }

      const actions = Array.isArray(plan.actions) ? plan.actions.slice(0, 12) : []
      if (!actions.length) {
        observations.push('No actions returned. Choose a useful tool or finish.')
        continue
      }

      for (const [actionIndex, action] of actions.entries()) {
        if (actionIndex > 0 && runtime.getState() === AGENT_STATES.EVALUATING) {
          runtime.transition(AGENT_EVENTS.MORE_ACTIONS, { turn })
        }
        onEvent?.({ type: 'tool', action })
        if (signal?.aborted) {
          runtime.transition(AGENT_EVENTS.USER_CANCELLED)
          await runner.cancelTaskProcesses()
          await runner.commitTransaction(activeTaskId)
          timeline.emit(TimelineTypes.RUN_CANCELLED, { turns: ledger.turns })
          return new RunResult({
            taskId: activeTaskId,
            status: 'Cancelled',
            completed: false,
            verified: false,
            cancelled: true,
            failed: false,
            changedFiles: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
            error: 'Agent task was cancelled by user.',
            summary: 'Agent cancelled. Completed changes were preserved.',
            diagnostics: buildDiagnostics('cancelled', 'user-cancel')
          })
        }

        const fingerprint = `${action.type}:${action.path || action.command || action.query || action.id || ''}`
        const attempts = (actionAttempts.get(fingerprint) || 0) + 1
        actionAttempts.set(fingerprint, attempts)
        const observation = attempts > 3
          ? `${action.type} blocked: this identical action has already been attempted three times. Diagnose the previous output and choose a different action.`
          : await executeAction(action, context, {
          ...tools,
          onFileWritten: (...fileArgs) => {
            const [filePath] = fileArgs
            writtenFiles.add(filePath)
            tools.onFileWritten?.(...fileArgs)
          }
        }, runner)

        observations.push(observation)
        
        // Reflection for fallback JSON mode
        const reflectionObservation = `\n[REFLECTION INSTRUCTION]\nBased on the result of ${action.type || action.name}, evaluate if the action succeeded, if you are closer to completing the task, and what the next strategy should be before outputting the next JSON action.`;
        observations.push(reflectionObservation)

        globalContextEngine.addObservation({
          turn,
          tool: action.type || action.name || 'unknown',
          status: observationFailed(observation) ? 'failed' : 'success',
          summary: clip(observation, 300),
          details: clip(observation, 12000)
        })
        onEvent?.({ type: 'observation', message: observation })
        runtime.transition(AGENT_EVENTS.ACTION_COMPLETED, { tool: action.type, turn })

        if (WRITE_ACTION_TYPES.has(action.type) && !observationFailed(observation)) {
          hasVerified = false
          postWriteInspection = false
        } else if ((action.type === 'read_file' || action.type === 'read_files') && writtenFiles.size > 0 && !observationFailed(observation)) {
          postWriteInspection = true
        }

        // Verification invariant: ONLY mark verified if run_command is a trusted verification tool
        if (action.type === 'run_command' && !observationFailed(observation)) {
          const isVerif = await verifier.isVerificationCommand(action.command, scannerState)
          if (isVerif) {
            hasVerified = true
            lastVerification = {
              attempted: true,
              success: true,
              command: action.command,
              stdout: observation,
              stderr: '',
              durationMs: 0
            }
          }
        }

        if (action.type === 'finish') {
          if (!(await validateRequiredDeliverable())) {
            // Leave the runtime in its current evaluating state and give the
            // compatible JSON protocol another turn to repair the file.
            break
          }
          // Runtime evaluates whether verification is needed
          const finishResult = runtime.transition(AGENT_EVENTS.FINISH_REQUESTED, {
            requiresVerification,
            hasWrittenFiles: writtenFiles.size > 0,
            hasVerified
          })

          if (runtime.getState() === AGENT_STATES.VERIFYING) {
            onEvent?.({ type: 'verification.started', message: 'Running the project\u2019s detected verification command.' })
            const verification = await verifier.verify({ scannerState, runId: activeTaskId })
            lastVerification = verification
            const verificationObservation = `automatic verification:\n${clip(JSON.stringify(verification), 12000)}`
            observations.push(verificationObservation)
            onEvent?.({ type: 'observation', message: verificationObservation })
            if (verification.success) {
              hasVerified = true
              runtime.transition(AGENT_EVENTS.VERIFICATION_PASSED)
            } else {
              runtime.transition(AGENT_EVENTS.VERIFICATION_FAILED)
              onEvent?.({ type: 'error', message: 'Verification failed. Diagnosing and recovering.' })
              break
            }
          }

          // If still not verified after the verification attempt, break to let the loop continue repair
          if (runtime.getState() === AGENT_STATES.REPAIRING) {
            break
          }

          // Reaching here means COMPLETED (either verification passed or not required)
          await runner.commitTransaction(activeTaskId)
          if (writtenFiles.size) tools.onWorkspaceChanged?.([...writtenFiles])
          saveAgentMemory(context.currentFolder, {
            task: clip(task, 500),
            result: clip(completionSummary(action.message, writtenFiles, lastVerification), 700),
            files: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
            plan: context.approvedPlan ? clip(context.approvedPlan, 12000) : null,
            timestamp: Date.now()
          })

          timeline.emit(TimelineTypes.RUN_COMPLETED, { turns: ledger.turns })
          return new RunResult({
            taskId: activeTaskId,
            status: 'Completed',
            completed: true,
            verified: hasVerified,
            cancelled: false,
            failed: false,
            changedFiles: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
            verification: lastVerification,
            summary: completionSummary(action.message, writtenFiles, lastVerification),
            runtimeHistory: runtime.getHistory(),
            diagnostics: buildDiagnostics('completed')
          })
        }
      }
    }

    // A model can occasionally keep calling tools after it has made and re-read
    // a complete change, especially with providers that omit a final message.
    // For projects without a detected verification command, that re-read is a
    // sufficient completion witness; do not mislabel the finished task as a
    // step-limit failure.
    if (writtenFiles.size > 0 && postWriteInspection && !requiresVerification && await validateRequiredDeliverable()) {
      runtime.transition(AGENT_EVENTS.FINISH_REQUESTED, {
        requiresVerification: false,
        hasWrittenFiles: true,
        hasVerified: false
      })
      await runner.commitTransaction(activeTaskId)
      tools.onWorkspaceChanged?.([...writtenFiles])
      const summary = completionSummary('', writtenFiles, lastVerification)
      saveAgentMemory(context.currentFolder, {
        task: clip(task, 500),
        result: clip(summary, 700),
        files: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
        plan: context.approvedPlan ? clip(context.approvedPlan, 12000) : null,
        timestamp: Date.now()
      })
      timeline.emit(TimelineTypes.RUN_COMPLETED, { turns: ledger.turns, heuristic: true })
      return new RunResult({
        taskId: activeTaskId,
        status: 'Completed',
        completed: true,
        verified: false,
        cancelled: false,
        failed: false,
        changedFiles: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
        verification: lastVerification,
        summary,
        runtimeHistory: runtime.getHistory(),
        diagnostics: buildDiagnostics('completed')
      })
    }

    // Max turns reached without explicit completion. Preserve the user's workspace;
    // task-scoped undo remains available through ChangeManager.
    runtime.transition(AGENT_EVENTS.MAX_TURNS)
    await runner.commitTransaction(activeTaskId)
    const resultSummary = 'Agent paused after reaching its step limit. Completed changes were preserved, and this approved plan can continue from its checkpoint without restarting.'
    timeline.emit(TimelineTypes.RUN_FAILED, { reason: 'max-turns', turns: ledger.turns })
    saveAgentMemory(context.currentFolder, {
      task: clip(task, 500),
      result: clip(resultSummary, 700),
      files: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
      plan: context.approvedPlan ? clip(context.approvedPlan, 12000) : null,
      status: 'incomplete',
      timestamp: Date.now()
    })
    
    return new RunResult({
      taskId: activeTaskId,
      status: 'Incomplete',
      completed: false,
      verified: false,
      cancelled: false,
      failed: true,
      changedFiles: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
      error: 'Max turns reached without task completion.',
      summary: resultSummary,
      checkpoint: createCheckpoint(),
      diagnostics: buildDiagnostics('failed', 'max-turns')
    })
  } catch (error) {
    await runner.commitTransaction(activeTaskId)
    if (error.name === 'AbortError' || signal?.aborted) {
      runtime.transition(AGENT_EVENTS.USER_CANCELLED)
      await runner.cancelTaskProcesses()
      timeline.emit(TimelineTypes.RUN_CANCELLED, { turns: ledger.turns })
      return new RunResult({
        taskId: activeTaskId,
        status: 'Cancelled',
        completed: false,
        verified: false,
        cancelled: true,
        failed: false,
        changedFiles: [...writtenFiles].map(file => getRelativePath(file, context.currentFolder)),
        error: 'Agent task was cancelled by user.',
        summary: 'Agent cancelled. Completed changes were preserved.',
        runtimeHistory: runtime.getHistory(),
        diagnostics: buildDiagnostics('cancelled', 'user-cancel')
      })
    }
    runtime.transition(AGENT_EVENTS.FATAL_ERROR, { error: error.message })
    timeline.emit(TimelineTypes.RUN_FAILED, { reason: 'fatal', error: String(error.message).slice(0, 300) })
    return new RunResult({
      taskId: activeTaskId,
      status: 'Failed',
      completed: false,
      verified: false,
      cancelled: false,
      failed: true,
      changedFiles: [],
      error: error.message,
      summary: `Task execution failed: ${error.message}. Completed changes were preserved and can be undone.`,
      checkpoint: createCheckpoint(),
      runtimeHistory: runtime.getHistory(),
      diagnostics: buildDiagnostics('failed', 'fatal')
    })
  }
}


// ── Smart Chat: Intent-aware routing ──────────────────────────────────────

const CONVERSATIONAL_SYSTEM_PROMPT = `You are Prime AI, an intelligent senior software engineer embedded in Simple IDE.

Behavior rules:
- Strictly Chat: You are currently running in conversational Chat mode. You do NOT have autonomous workspace write tools or terminal execution in this mode. You must never claim you have edited files or run shell commands. Your purpose is advice, code review, architectural design, debugging guidance, code drafting, and planning.
- Be natural, articulate, and highly competent.
- **Default Planning**: For any task, feature request, bug fix, or architecture question, always include a concise **Step-by-Step Execution Plan** outlining affected components, key steps, and verification before presenting code or final answers.
- For feature requests or project transformations (e.g. "turn this into a landing page", "add authentication", "build a dashboard", "create a dark theme"):
  1. **Research & Design Thinking**: Provide a concise 2-3 sentence analysis of best practices (modern layout, UX flow, color scheme, typography).
  2. **Execution Roadmap / Plan**: List the step-by-step file structure, file modifications, and safe sequence of steps.
  3. **Hand-Off Confirmation**: State clearly: "I am ready to hand over this job to the Autonomous Agent to inspect, generate, and verify these files in your workspace." (A button will appear for the user to hand over to the Autonomous Agent with 1 click).
- You remember the full conversation history. Resolve pronouns ("it", "the page", "this file") seamlessly.
- Format code with fenced markdown code blocks with appropriate language identifiers.`

/**
 * Route a user message through intent classification before deciding
 * which tools and services to invoke.
 *
 * @param {object} params
 * @param {string}   params.message          The user's raw message
 * @param {Array}    params.conversationHistory  Full [{role, content}] history
 * @param {object}   params.context           { currentFolder, activeFile, selectedCode, projectIndex, openFiles, projectSummary }
 * @param {Function} params.onDelta            Streaming delta callback
 * @param {Function} params.onRequestId        Stream request ID callback
 * @returns {{ intent: string, quickResponse?: string, streamed?: boolean }}
 */
export async function runSmartChat({ mode = 'assistant', message, conversationHistory = [], context = {}, onDelta, onRequestId, onThinking }) {
  const classificationContext = {
    hasActiveFile: Boolean(context.activeFile),
    hasSelectedCode: Boolean(context.selectedCode),
    hasWorkspace: Boolean(context.currentFolder)
  }

  const result = IntentClassifier.classify(message, conversationHistory, classificationContext)

  // ── Instant responses (no LLM call) ──────────────────────────────────
  if (result.quickResponse) {
    return { intent: result.intent, quickResponse: result.quickResponse }
  }

  // ── Build the user message with appropriate context ───────────────────
  const parts = []

  // Include conversation history for continuity (pronoun resolution)
  if (conversationHistory.length > 0) {
    const recentMessages = conversationHistory
      .filter(m => m.content && (m.role === 'user' || m.role === 'assistant'))
      .slice(-48)
    let usedChars = 0
    const recent = []
    for (const item of recentMessages.reverse()) {
      const formatted = `${item.role === 'user' ? 'User' : 'Assistant'}: ${String(item.content).slice(0, 1200)}`
      if (usedChars + formatted.length > 36000) break
      recent.unshift(formatted)
      usedChars += formatted.length
    }
    if (recent.length) parts.push(`Recent conversation:\n${recent.join('\n')}`)
  }

  // Include code context only when the intent needs it
  const needsCode = result.toolReqs.needsWorkspace ||
    [INTENTS.CODE_EXPLANATION, INTENTS.CODE_REVIEW, INTENTS.DOCUMENTATION].includes(result.intent)

  if (needsCode) {
    if (context.selectedCode) {
      parts.push(`Selected code:\n\`\`\`\n${context.selectedCode.slice(0, 4000)}\n\`\`\``)
    } else if (context.activeFile?.content) {
      const fileName = context.activeFile.name || 'active file'
      parts.push(`Active file (${fileName}):\n\`\`\`\n${context.activeFile.content.slice(0, 6000)}\n\`\`\``)
    }
  }

  const attached = Array.isArray(context.attachedFiles) ? context.attachedFiles : []
  if (attached.length) {
    parts.push(`Attached files:\n${attached.map(file => {
      const name = file.path ? String(file.path).split(/[/\\]/).pop() : (file.name || 'attached file')
      return `--- ${name} ---\n\`\`\`\n${String(file.content || '').slice(0, 4000)}\n\`\`\``
    }).join('\n\n')}`)
  }

  parts.push(message)

  const fullUserMessage = parts.join('\n\n')

  // ── Stream the LLM response ──────────────────────────────────────────
  let modeSystemPrompt = CONVERSATIONAL_SYSTEM_PROMPT
  if (mode === 'architect') {
    modeSystemPrompt += '\n\nIMPORTANT: You are now acting in ARCHITECT mode. Focus on high-level system design, architecture, folder structures, design patterns, and scalability. Provide architectural diagrams using Mermaid.js where appropriate. Do not focus on micro-optimizations; focus on the big picture and system layout.'
  } else if (mode === 'reviewer') {
    modeSystemPrompt += '\n\nIMPORTANT: You are now acting in REVIEWER mode. Analyze the provided code for bugs, security vulnerabilities, performance issues, and code smells. Suggest specific refactoring steps and point out violations of best practices. Be strict and thorough in your code review.'
  } else if (mode === 'debugger') {
    modeSystemPrompt += '\n\nIMPORTANT: You are now acting in DEBUGGER mode. Focus heavily on identifying the root cause of bugs, analyzing stack traces, and fixing runtime errors. Provide step-by-step debugging strategies and exact code fixes to resolve the issue.'
  }

  const { requestAIStream } = await import('./aiService')
  await requestAIStream({
    systemMessage: modeSystemPrompt,
    userMessage: fullUserMessage,
    onDelta,
    onRequestId,
    onThinking
  })

  return { intent: result.intent, streamed: true }
}

/**
 * Programmatic helper to check and reconcile unfinished runs for a workspace.
 */
export async function checkCrashRecovery(workspaceRoot, options = {}) {
  const service = new CrashRecoveryService(workspaceRoot, options)
  return await service.recoverWorkspaceRuns(workspaceRoot)
}

