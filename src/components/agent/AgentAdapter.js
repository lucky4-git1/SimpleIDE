/**
 * AgentAdapter.js
 *
 * Normalizes raw agent engine events and state snapshots into a consistent,
 * UI-friendly view model for the Modern Agent UI.
 *
 * Engine (untouched) -> AgentAdapter -> Modern React UI
 */

/**
 * Derives a clean, concise task title from the user prompt.
 * Uses deterministic heuristics without making costly LLM calls.
 * @param {string} prompt
 * @returns {string}
 */
export function deriveTaskTitle(prompt) {
  if (!prompt || typeof prompt !== 'string') return 'Autonomous Task'
  const cleaned = prompt.trim().replace(/^[\/#!*>\-\s]+/, '')
  if (!cleaned) return 'Autonomous Task'

  // Extract first line or sentence
  const firstLine = cleaned.split(/\r?\n/)[0].replace(/[.:;!?]+$/, '').trim()

  // Common imperative prefixes to retain
  const matches = firstLine.match(/^(?:please\s+)?(?:can\s+you\s+)?(?:i\s+want\s+to\s+)?(?:help\s+me\s+)?(.+)/i)
  const core = (matches ? matches[1] : firstLine).trim()

  // Capitalize first letter
  const formatted = core.charAt(0).toUpperCase() + core.slice(1)
  return formatted.length > 56 ? `${formatted.slice(0, 53).trimEnd()}…` : formatted
}

function cleanStepText(text) {
  if (typeof text !== 'string') return String(text || '')
  return text
    .replace(/^\[[ xX]\]\s*/, '')
    .replace(/^\*\*(?:Step\s*\d+:?\s*)?([^*]+)\*\*(?:\s*[-—:]\s*)?/i, '$1 — ')
    .replace(/\*\*/g, '')
    .trim()
}

/**
 * Parses markdown plan into structured step objects.
 * @param {string} planText
 * @param {Array<{ text: string, status?: string }>} existingTodos
 * @param {string} runStatus
 * @returns {Array<{ id: string, text: string, status: 'completed'|'active'|'pending'|'blocked' }>}
 */
export function parsePlanSteps(planText = '', existingTodos = [], runStatus = 'working') {
  if (Array.isArray(existingTodos) && existingTodos.length > 0) {
    return existingTodos.map((todo, idx) => ({
      id: `step-${idx}`,
      text: typeof todo === 'string' ? cleanStepText(todo) : cleanStepText(todo.text || todo.title || `Step ${idx + 1}`),
      status: normalizeStepStatus(todo?.status, idx, existingTodos.length, runStatus)
    }))
  }

  const raw = String(planText || '').trim()
  if (!raw) return []

  const isComplete = runStatus === 'complete' || runStatus === 'completed'
  const isFailed = runStatus === 'failed' || runStatus === 'cancelled'

  // If input is a raw JSON string or JSON code fence, extract steps directly
  let candidateJson = raw
  const fenceMatch = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenceMatch) candidateJson = fenceMatch[1].trim()

  if (candidateJson.startsWith('{') && candidateJson.endsWith('}')) {
    try {
      const data = JSON.parse(candidateJson)
      const rawSteps = data.steps || data.phases || data.milestones || data.tasks
      if (Array.isArray(rawSteps) && rawSteps.length > 0) {
        return rawSteps.slice(0, 15).map((step, idx) => {
          let stepText = typeof step === 'string'
            ? cleanStepText(step.replace(/^(?:[-*]\s*\[[ xX]\]|\d+[.)]|[-*]|\bstep\s*\d+:?)\s+/i, ''))
            : cleanStepText(step.text || step.name || step.title || `Step ${idx + 1}`)
          let status = 'pending'
          if (isComplete) status = 'completed'
          else if (!isFailed) {
            status = idx === 0 ? 'active' : 'pending'
          }
          return { id: `plan-step-${idx}`, text: stepText, status }
        })
      }
    } catch {}
  }

  // Look for dedicated implementation steps / plan section first
  let stepsSection = ''
  const sectionMatch = raw.match(/(?:##+\s*(?:\d+\.\s*)?(?:Implementation\s+Steps?|Execution\s+Plan|Plan\s+Steps?|Steps?|Milestones?|Tasks?)[^\n]*)\s*\n+([\s\S]*?)(?=\n##+|\n#+|$)/i)
  if (sectionMatch && sectionMatch[1]?.trim()) {
    stepsSection = sectionMatch[1].trim()
  }

  const targetText = stepsSection || raw
  const stepLines = []
  const rawLines = targetText.split(/\r?\n/)

  for (const line of rawLines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // If scanning whole document, avoid non-step sections or file lists
    if (!stepsSection) {
      if (/^#+\s+(?:Affected Files|Files|Risks|Design|Architecture|Goal|Verification|Review)/i.test(trimmed)) {
        continue
      }
      if (/^[-*]\s+`[^`]+`/i.test(trimmed)) {
        continue
      }
    }

    const match = trimmed.match(/^(?:#+\s+)?(?:[-*]\s*\[[ xX]\]|\d+[.)]|[-*]|\b(?:step|phase|milestone)\s*\d+:?|\*\*(?:step|phase|milestone)\s*\d+[:*]*)\s+(.*)/i)
    if (match && match[1]) {
      const cleaned = cleanStepText(match[1])
      if (cleaned && cleaned.length > 2 && !/^`[^`]+`(?:\s*—.*)?$/.test(cleaned)) {
        stepLines.push(cleaned)
      }
    } else if (stepsSection && /^###\s+(.*)/i.test(trimmed)) {
      const cleaned = cleanStepText(trimmed.replace(/^###\s+/, ''))
      if (cleaned) stepLines.push(cleaned)
    }
  }

  const finalLines = stepLines.slice(0, 15)

  if (!finalLines.length) {
    if (raw && !isFailed) {
      return [{
        id: 'plan-step-0',
        text: 'Execute implementation plan',
        status: isComplete ? 'completed' : 'active'
      }]
    }
    return []
  }

  return finalLines.map((text, idx) => {
    let status = 'pending'
    if (isComplete) {
      status = 'completed'
    } else if (!isFailed) {
      if (idx === 0) status = 'active'
      else status = 'pending'
    }
    return { id: `plan-step-${idx}`, text, status }
  })
}

function normalizeStepStatus(status, index, total, runStatus) {
  if (runStatus === 'complete' || runStatus === 'completed') return 'completed'
  if (status === 'complete' || status === 'completed' || status === 'done') return 'completed'
  if (status === 'working' || status === 'active' || status === 'in_progress') return 'active'
  if (status === 'blocked' || status === 'failed') return 'blocked'
  if (index === 0 && runStatus === 'working') return 'active'
  return 'pending'
}

/**
 * Categorizes a tool action into operational categories.
 * @param {string} toolType
 * @returns {'inspect'|'edit'|'verify'|'skill'|'other'}
 */
export function categorizeAction(toolType) {
  const type = String(toolType || '').toLowerCase()
  if (['read_file', 'list_files', 'search_files', 'find_by_name', 'view_file', 'grep_search', 'list_dir'].includes(type)) {
    return 'inspect'
  }
  if (['write_file', 'replace_in_file', 'create_file', 'edit_file', 'delete_file', 'rename_file'].includes(type)) {
    return 'edit'
  }
  if (['run_command', 'test', 'verify', 'build'].includes(type)) {
    return 'verify'
  }
  if (['skill', 'run_skill', 'create_skill'].includes(type)) {
    return 'skill'
  }
  return 'other'
}

/**
 * Generates a concise human-readable title for a tool call.
 * @param {{ type: string, path?: string, command?: string, query?: string }} action
 * @returns {string}
 */
export function formatActionTitle(action) {
  if (!action) return 'Operational activity'
  const type = action.type || 'action'

  switch (type) {
    case 'read_file':
    case 'view_file':
      return `Read ${getFilename(action.path || action.AbsolutePath)}`
    case 'write_file':
    case 'create_file':
      return `Write ${getFilename(action.path || action.TargetFile)}`
    case 'replace_in_file':
    case 'edit_file':
      return `Edit ${getFilename(action.path || action.TargetFile)}`
    case 'list_files':
    case 'list_dir':
      return `List ${getFilename(action.path || action.DirectoryPath || '.')}`
    case 'search_files':
    case 'grep_search':
      return `Search "${action.query || action.Query || 'codebase'}"`
    case 'run_command':
      return action.command ? action.command.slice(0, 48) : 'Run command'
    case 'verify':
      return 'Run verification check'
    case 'update_plan':
      return 'Updated plan checklist'
    default:
      return type.replace(/_/g, ' ')
  }
}

function getFilename(filePath) {
  if (!filePath) return 'file'
  const norm = String(filePath).replace(/\\/g, '/')
  const parts = norm.split('/')
  return parts[parts.length - 1] || norm
}

/**
 * Groups a sequence of flat tool events into high-level activities.
 * Groups consecutive inspections, batch edits, and verification phases.
 * @param {Array<any>} tools
 * @returns {Array<any>} Grouped activity items
 */
export function groupToolActivities(tools = []) {
  if (!Array.isArray(tools) || !tools.length) return []

  const groups = []
  let currentGroup = null

  for (const tool of tools) {
    const category = categorizeAction(tool.type)
    const isInspection = category === 'inspect'
    const isEdit = category === 'edit'

    if (isInspection) {
      if (currentGroup && currentGroup.type === 'inspect_group') {
        currentGroup.items.push(tool)
        currentGroup.files.add(tool.path || tool.label)
        if (tool.status === 'failed') currentGroup.hasFailure = true
      } else {
        if (currentGroup) groups.push(finalizeGroup(currentGroup))
        currentGroup = {
          id: `inspect-grp-${tool.id || groups.length}`,
          type: 'inspect_group',
          title: 'Inspected workspace',
          category: 'inspect',
          items: [tool],
          files: new Set([tool.path || tool.label]),
          status: tool.status,
          hasFailure: tool.status === 'failed',
          timestamp: tool.timestamp || Date.now()
        }
      }
    } else if (isEdit) {
      if (currentGroup && currentGroup.type === 'edit_group') {
        currentGroup.items.push(tool)
        currentGroup.files.add(tool.path || tool.label)
        if (tool.status === 'failed') currentGroup.hasFailure = true
      } else {
        if (currentGroup) groups.push(finalizeGroup(currentGroup))
        currentGroup = {
          id: `edit-grp-${tool.id || groups.length}`,
          type: 'edit_group',
          title: 'Modified files',
          category: 'edit',
          items: [tool],
          files: new Set([tool.path || tool.label]),
          status: tool.status,
          hasFailure: tool.status === 'failed',
          timestamp: tool.timestamp || Date.now()
        }
      }
    } else {
      if (currentGroup) {
        groups.push(finalizeGroup(currentGroup))
        currentGroup = null
      }
      groups.push({
        id: tool.id || `act-${groups.length}`,
        type: 'single',
        category,
        title: tool.label || formatActionTitle(tool),
        detail: tool.detail,
        status: tool.status || 'complete',
        duration: tool.duration,
        raw: tool,
        timestamp: tool.timestamp || Date.now()
      })
    }
  }

  if (currentGroup) {
    groups.push(finalizeGroup(currentGroup))
  }

  return groups
}

function finalizeGroup(group) {
  const fileCount = group.files.size
  const isWorking = group.items.some(i => i.status === 'working')
  const status = isWorking ? 'working' : group.hasFailure ? 'failed' : 'complete'

  let title = group.title
  if (group.type === 'inspect_group') {
    title = fileCount > 1 ? `Inspected ${fileCount} files` : 'Inspected context'
  } else if (group.type === 'edit_group') {
    title = fileCount > 1 ? `Modified ${fileCount} files` : 'Modified file'
  }

  return {
    ...group,
    title,
    count: group.items.length,
    fileCount,
    status,
    fileList: Array.from(group.files).filter(Boolean)
  }
}

/**
 * Builds the complete unified view model from raw agent state.
 * @param {object} params
 * @returns {object} Normalized view model
 */
export function buildAgentViewModel({
  agentRun,
  messages = [],
  isLoading = false,
  pendingApproval = null,
  activeFile = null,
  currentFolder = '',
  runDiagnostics = null
}) {
  const taskTitle = deriveTaskTitle(agentRun?.task || messages.find(m => m.role === 'user')?.content)
  const isReview = agentRun?.status === 'review'
  const isCancelled = agentRun?.status === 'cancelled'
  const isFailed = agentRun?.status === 'failed'
  const isComplete = (agentRun?.status === 'complete' || agentRun?.status === 'completed') && !isLoading
  const isPlanning = agentRun?.status === 'planning'
  const isWorking = isLoading || agentRun?.status === 'working'

  // Map to unified lifecycle state
  let state = 'idle'
  if (pendingApproval) state = 'waiting_approval'
  else if (isReview) state = 'review'
  else if (isPlanning) state = 'planning'
  else if (isWorking) state = 'running'
  else if (isComplete) state = 'completed'
  else if (isCancelled) state = 'cancelled'
  else if (isFailed) state = 'failed'

  // Determine current active operation (only one primary action dominates)
  let currentAction = null
  if (pendingApproval) {
    currentAction = {
      type: 'approval',
      title: 'Waiting for approval',
      detail: pendingApproval.reason || pendingApproval.tool,
      isDestructive: Boolean(pendingApproval.isDestructive || /delete|rm|drop/i.test(pendingApproval.tool || ''))
    }
  } else if (isPlanning) {
    currentAction = {
      type: 'planning',
      title: 'Developing implementation plan',
      detail: 'Analyzing context and formulating steps'
    }
  } else if (isWorking) {
    const tools = agentRun?.tools || []
    const lastWorkingTool = [...tools].reverse().find(t => t.status === 'working')
    if (lastWorkingTool) {
      currentAction = {
        type: categorizeAction(lastWorkingTool.type),
        title: lastWorkingTool.label || formatActionTitle(lastWorkingTool),
        detail: lastWorkingTool.detail || lastWorkingTool.path || ''
      }
    } else {
      const activeStage = Object.entries(agentRun?.stages || {}).find(([_, s]) => s?.status === 'working')
      if (activeStage) {
        currentAction = {
          type: activeStage[0],
          title: activeStage[0] === 'verify' ? 'Running verification suite' : activeStage[0] === 'edit' ? 'Applying code modifications' : 'Inspecting workspace context',
          detail: activeStage[1]?.detail || ''
        }
      } else {
        currentAction = {
          type: 'general',
          title: 'Executing agent instructions',
          detail: ''
        }
      }
    }
  }

  // Parse plan checklist
  const planSteps = parsePlanSteps(agentRun?.plan, agentRun?.todos, agentRun?.status)

  // Group activities
  const activityGroups = groupToolActivities(agentRun?.tools || [])

  // Changes summary
  const changedFiles = agentRun?.changedFiles || []

  // Verification status - safely normalize from both lastVerification and stages
  const rawVerification = (agentRun?.verification && typeof agentRun.verification === 'object') ? agentRun.verification : {}
  const stageVerify = (agentRun?.stages?.verify && typeof agentRun.stages.verify === 'object') ? agentRun.stages.verify : {}

  const attempted = Boolean(
    rawVerification.attempted ||
    (stageVerify.status && stageVerify.status !== 'pending')
  )

  const passed = Boolean(
    rawVerification.success === true ||
    rawVerification.passed === true ||
    stageVerify.status === 'complete' ||
    stageVerify.status === 'success'
  )

  const failed = Boolean(
    (!passed && (rawVerification.attempted || stageVerify.status === 'failed')) ||
    rawVerification.failed === true ||
    (rawVerification.attempted && rawVerification.success === false) ||
    stageVerify.status === 'failed'
  )

  const command = typeof rawVerification.command === 'string' ? rawVerification.command : ''
  const output = typeof rawVerification.stdout === 'string'
    ? rawVerification.stdout
    : (typeof rawVerification.output === 'string' ? rawVerification.output : (typeof rawVerification.stderr === 'string' ? rawVerification.stderr : ''))

  let detail = ''
  if (typeof rawVerification.detail === 'string' && rawVerification.detail) {
    detail = rawVerification.detail
  } else if (typeof stageVerify.detail === 'string' && stageVerify.detail) {
    detail = stageVerify.detail
  } else if (command) {
    detail = `${passed ? 'Passed' : failed ? 'Failed' : 'Executed'}: ${command}`
  }

  const verification = {
    attempted,
    passed,
    failed,
    detail,
    command,
    output
  }

  return {
    hasRun: Boolean(agentRun || messages.length > 0),
    taskTitle,
    state,
    isWorking,
    isReview,
    isComplete,
    currentAction,
    planSteps,
    planRaw: agentRun?.plan || '',
    activityGroups,
    rawTools: agentRun?.tools || [],
    changedFiles,
    verification,
    summary: isReview ? '' : (agentRun?.summary || ''),
    reviewMessage: isReview ? (agentRun?.summary || 'Review this implementation plan. You can edit it or add instructions before approving.') : '',
    resumable: Boolean(agentRun?.resumable),
    pendingApproval,
    diagnostics: runDiagnostics
  }
}
