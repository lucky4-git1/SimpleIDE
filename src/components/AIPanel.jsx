import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StreamingLog } from './ui/StreamingLog'
import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  Bug,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDot,
  Code2,
  Copy,
  Eye,
  FileCode2,
  FilePenLine,
  FileText,
  Gauge,
  History,
  Layers,
  Loader2,
  Map,
  MessageSquarePlus,
  Paperclip,
  Pencil,
  List,
  Database,
  Edit3,
  Save,
  MessageSquare,
  PanelTop,
  Play,
  RefreshCw,
  SearchCode,
  Send,
  Settings,
  ShieldCheck,
  Square,
  Sparkles,
  TerminalSquare,
  Trash2,
  Undo2,
  Wrench,
  X,
} from 'lucide-react'
import { getApiConfig, saveApiConfig, listProviderModels, resolveModelOptions } from '../services/aiService'
import { getWorkspaceMemory, runAgentPlan, runAgentTask, runSmartChat } from '../services/agentService'
import { SkillsModal } from './SkillsModal'
import './SkillsModal.css'
import { memoryManager } from '../services/memory/memoryManager'
import { IntentClassifier, INTENTS } from '../services/agentEngine/IntentClassifier'
import { getModelCapabilities } from '../services/agentEngine/LLMRouter'
import { useEditorStore } from '../store/editorStore'
import { AgentWorkspace } from './agent/AgentWorkspace'
import { buildAgentViewModel } from './agent/AgentAdapter'
import './agent/agentTokens.css'

const CHAT_ACTIONS = [
  { id: 'explain', label: 'Explain', icon: Sparkles },
  { id: 'fix', label: 'Fix', icon: Wrench },
  { id: 'test', label: 'Test', icon: Code2 }
]

const AGENT_STAGES = [
  { id: 'inspect', label: 'Inspect', description: 'Read relevant code and project context.' },
  { id: 'edit', label: 'Edit', description: 'Apply and record focused workspace changes.' },
  { id: 'verify', label: 'Verify', description: 'Run the smallest relevant check.' }
]

const PRIMARY_MODES = [
  { id: 'assistant', label: 'Assistant', icon: MessageSquare, tooltip: 'Chat, ask questions, get plan & explanations' },
  { id: 'agent', label: 'Agent', icon: BrainCircuit, tooltip: 'Autonomous coding agent — plans, inspects, edits, verifies' }
]

const ALL_MODES = [...PRIMARY_MODES]

function relativePath(filePath, rootPath) {
  const path = String(filePath || '').replace(/\\/g, '/')
  const root = String(rootPath || '').replace(/\\/g, '/').replace(/\/$/, '')
  return root && path.toLowerCase().startsWith(root.toLowerCase())
    ? path.slice(root.length).replace(/^\//, '')
    : path
}

function isLocalProvider(config) {
  return config.provider === 'ollama' || config.provider === 'lmstudio'
}

function getChatPreview(chat) {
  const message = [...(chat.messages || [])].reverse().find(item => String(item?.content || '').trim())
  if (!message) return 'No messages yet'
  const text = String(message.content).replace(/\s+/g, ' ').trim()
  const prefix = message.role === 'user' ? 'You: ' : 'Prime AI: '
  return `${prefix}${text.length > 86 ? `${text.slice(0, 86).trimEnd()}…` : text}`
}

function getPlanSteps(plan = '') {
  return String(plan)
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^\d+[.)]\s+/.test(line) || /^[-*]\s+/.test(line))
    .map(line => line.replace(/^(?:\d+[.)]|[-*])\s+/, ''))
    .slice(0, 12)
}

// Rebuild a read-only agent card from persisted chat bubbles when a stored
// agentRun snapshot is missing (older chats). Only triggers on the exact
// prefixes the agent itself writes, so assistant explanations never match.
function rehydrateAgentRunFromMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : []
  const firstUser = list.find(m => m?.role === 'user' && String(m.content || '').trim())
  const planMsg = [...list].reverse().find(m => m?.role === 'assistant' && String(m.content || '').startsWith('Implementation plan:\n'))
  const resultMsg = [...list].reverse().find(m => m?.role === 'assistant' && String(m.content || '').startsWith('Implementation result:\n'))
  if (!planMsg && !resultMsg) return null
  const task = String(firstUser?.content || 'Previous task').slice(0, 500)
  const run = createAgentRun(task)
  if (planMsg) run.plan = String(planMsg.content).replace(/^Implementation plan:\n/, '')
  if (resultMsg) {
    run.summary = String(resultMsg.content).replace(/^Implementation result:\n/, '')
    run.status = 'complete'
    run.stages = Object.fromEntries(
      Object.entries(run.stages).map(([key, value]) => [key, { ...value, status: 'complete' }])
    )
  } else {
    run.status = 'review'
    run.summary = 'Review this implementation plan. You can edit it or add instructions before approving.'
  }
  return run
}

function emptyStages() {
  return Object.fromEntries(AGENT_STAGES.map(stage => [stage.id, { status: 'pending', detail: stage.description }]))
}

function createAgentRun(task) {
  return {
    task,
    status: 'working',
    summary: '',
    plan: '',
    stages: {
      ...emptyStages(),
      inspect: { status: 'working', detail: 'Collecting the smallest useful context.' }
    },
    tools: [],
    changedFiles: [],
    todos: [],
    resumable: false
  }
}

function getActionStage(action) {
  if (['read_file', 'list_files', 'search_files'].includes(action?.type)) return 'inspect'
  if (['write_file', 'replace_in_file'].includes(action?.type)) return 'edit'
  if (action?.type === 'run_command') return 'verify'
  return null
}

function describeAction(action) {
  if (!action) return 'Working with the workspace'
  if (action.type === 'read_file') return `Read ${action.path}`
  if (action.type === 'write_file') return `Write ${action.path}`
  if (action.type === 'replace_in_file') return `Edit ${action.path}`
  if (action.type === 'list_files') return `List ${action.path || '.'}`
  if (action.type === 'search_files') return `Search ${action.query || 'workspace'}`
  if (action.type === 'run_command') return action.command
  if (action.type === 'finish') return 'Summarize result'
  return action.type
}

function eventIcon(event) {
  if (event?.action?.type === 'write_file' || event?.action?.type === 'replace_in_file') return FilePenLine
  if (event?.action?.type === 'read_file' || event?.action?.type === 'list_files') return FileText
  if (event?.action?.type === 'search_files') return SearchCode
  if (event?.action?.type === 'run_command') return TerminalSquare
  return BrainCircuit
}

function updateRunFromEvent(previous, event) {
  if (!previous) return previous

  const stages = { ...previous.stages }
  const tools = [...previous.tools]
  const action = event.action
  const stage = getActionStage(action)
  let plan = previous.plan || ''

  if (event.type === 'tool' && action?.type === 'update_plan' && Array.isArray(action.steps)) {
    return { ...previous, todos: action.steps }
  }

  if (event.type === 'plan' && !plan) {
    plan = event.message || plan
  }

  if (event.type === 'thinking' || event.type === 'plan' || event.type === 'thought') {
    stages.inspect = { status: stages.inspect.status === 'pending' ? 'working' : stages.inspect.status, detail: event.message || stages.inspect.detail }
  }

  if (event.type === 'tool' && stage) {
    if (stage !== 'inspect' && stages.inspect.status === 'working') {
      stages.inspect = { ...stages.inspect, status: 'complete', detail: 'Relevant context collected.' }
    }
    if (stage === 'verify' && stages.edit.status === 'working') {
      stages.edit = { ...stages.edit, status: 'complete', detail: 'Patch prepared for review.' }
    }
    stages[stage] = { status: 'working', detail: describeAction(action) }
    tools.push({
      id: `${Date.now()}-${tools.length}`,
      label: describeAction(action),
      type: action.type,
      icon: eventIcon(event),
      status: 'working'
    })
  }

  if (event.type === 'observation' && tools.length) {
    const lastTool = tools[tools.length - 1]
    // Observations often contain source code. A CSS class, user-facing copy,
    // or test fixture mentioning "error" must not turn a successful read into
    // a red failed step in the UI.
    const failed = /^(?:[a-z_]+ failed:|[a-z_]+ blocked:|[a-z_]+ denied by user:|run_command blocked)/i.test(String(event.message || '').trim())
    lastTool.status = failed ? 'failed' : 'complete'
    lastTool.detail = String(event.message || '').slice(0, 1200)
    const lastStage = getActionStage({ type: lastTool.type })
    if (lastStage && lastStage !== 'edit') {
      stages[lastStage] = {
        status: failed ? 'failed' : 'complete',
        detail: failed ? 'Needs attention before continuing.' : lastStage === 'verify' ? 'Check completed.' : 'Context collected.'
      }
    }
  }

  if (event.type === 'error') {
    const activeStage = AGENT_STAGES.find(item => stages[item.id].status === 'working')?.id
    if (activeStage) stages[activeStage] = { status: 'failed', detail: event.message || 'The step needs attention.' }
  }

  return { ...previous, stages, tools: tools.slice(-100), plan }
}

function compactDiff(before = '', after = '', limit = 7) {
  const oldLines = String(before).split('\n')
  const newLines = String(after).split('\n')
  const lineCount = Math.max(oldLines.length, newLines.length)
  const changed = []
  for (let index = 0; index < lineCount; index++) {
    if (oldLines[index] !== newLines[index]) {
      changed.push({ line: index + 1, before: oldLines[index], after: newLines[index] })
    }
    if (changed.length >= limit) break
  }
  return changed.length ? changed : [{ line: 1, before: before || '(new file)', after: after || '(empty)' }]
}

function MarkdownContent({ text, onApplyCode, onCopy, copiedKey }) {
  const parts = String(text || '').split(/(```[\s\S]*?```)/g)
  return parts.map((part, index) => {
    if (!part.startsWith('```')) return <span key={index} className="prime-ai-markdown-text">{part}</span>

    const lines = part.split('\n')
    const language = lines[0].replace('```', '').trim() || 'code'
    const code = lines.slice(1, -1).join('\n')
    const key = `code-${index}-${code.length}`
    return (
      <div className="prime-code-block" key={key}>
        <div className="prime-code-block__header">
          <span>{language}</span>
          <div className="prime-code-block__actions">
            {onApplyCode && <button type="button" onClick={() => onApplyCode(code)}><Play size={11} /> Apply</button>}
            <button type="button" onClick={() => onCopy(code, key)}>{copiedKey === key ? <Check size={12} /> : <Copy size={12} />}</button>
          </div>
        </div>
        <pre>{code}</pre>
      </div>
    )
  })
}

function AgentStage({ stage, state }) {
  const current = state || { status: 'pending', detail: stage?.description || '' }
  const StageIcon = current.status === 'complete' ? CheckCircle2 : current.status === 'working' ? CircleDot : current.status === 'failed' ? AlertTriangle : Circle
  return (
    <div className={`prime-agent-stage prime-agent-stage--${current.status}`}>
      <StageIcon size={16} />
      <div>
        <strong>{stage.label}</strong>
        <p>{current.detail}</p>
      </div>
    </div>
  )
}

function WorkedBadge({ duration = '42s', tools = [] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="antigravity-worked-badge my-1.5">
      <button type="button" onClick={() => setOpen(!open)} className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1.5 py-1 px-2.5 rounded-md bg-white/5 hover:bg-white/10 transition-all cursor-pointer border border-white/5">
        <span>Worked for {duration}</span>
        <ChevronDown size={12} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && tools.length > 0 && (
        <div className="pl-3 py-2 border-l border-white/10 my-1.5 space-y-1 text-xs text-gray-300">
          {tools.map((t, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <span className="text-indigo-400">•</span>
              <span>{t.label || t.type || 'Action'}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${t.status === 'complete' ? 'bg-emerald-950 text-emerald-300 border border-emerald-800/40' : t.status === 'failed' ? 'bg-rose-950 text-rose-300' : 'bg-blue-950 text-blue-300'}`}>{t.status || 'working'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PlanProgressBadge({ planTitle = 'Implementation Plan', commentCount = 3 }) {
  return (
    <div className="antigravity-plan-badge flex items-center gap-2 bg-[#1e1e1e] border border-white/10 text-gray-200 rounded-xl px-3.5 py-2 my-2 text-xs">
      <CheckCircle2 size={14} className="text-emerald-400 flex-shrink-0" />
      <span className="truncate">Proceeded with <strong className="text-white ml-1">{planTitle}</strong></span>
      {commentCount > 0 && (
        <span className="text-gray-400 ml-auto flex items-center gap-1 text-[11px]">
          <MessageSquare size={12}/> {commentCount}
        </span>
      )}
    </div>
  )
}

function FileChangesBadge({ count = 3, addLines = 62, delLines = 2, onReview }) {
  return (
    <div className="antigravity-files-badge flex items-center justify-between bg-[#1a1a1a] border border-white/10 rounded-xl px-3.5 py-2 my-2 text-xs">
      <div className="flex items-center gap-2 text-gray-200">
        <FileCode2 size={14} className="text-blue-400 flex-shrink-0" />
        <span><strong>{count} file{count === 1 ? '' : 's'} changed</strong> <span className="text-emerald-400 font-mono ml-1">+{addLines}</span> <span className="text-rose-400 font-mono">-{delLines}</span></span>
      </div>
      {onReview && (
        <button type="button" onClick={onReview} className="flex items-center gap-1 bg-white/10 hover:bg-white/15 text-gray-200 px-2.5 py-1 rounded-lg transition-all text-xs cursor-pointer border border-white/10">
          <Eye size={12} /> Review
        </button>
      )}
    </div>
  )
}

function StepDivider({ label = 'Verify build succeeds' }) {
  return (
    <div className="antigravity-step-divider flex items-center gap-3 my-3 text-xs text-gray-500">
      <div className="flex-1 h-px bg-white/10"></div>
      <span className="text-gray-400 font-medium">{label} finished</span>
      <div className="flex-1 h-px bg-white/10"></div>
    </div>
  )
}

function ApprovedPlanChecklist({ plan, status, todos = [] }) {
  const steps = todos.length ? todos : getPlanSteps(plan).map(text => ({ text, status: 'pending' }))
  if (!steps.length) return null
  const isDone = status === 'complete'
  const isFailed = status === 'failed' || status === 'cancelled'
  return (
    <ol className="prime-approved-plan-checklist" aria-label="Approved plan progress">
      {steps.map((step, index) => {
        const stepStatus = isDone ? 'complete' : (step.status || (!isFailed && index === 0 ? 'working' : 'pending'))
        const Icon = stepStatus === 'complete' ? CheckCircle2 : stepStatus === 'working' ? CircleDot : stepStatus === 'blocked' ? AlertTriangle : Circle
        return <li key={`${index}-${step.text}`} className={`is-${stepStatus}`}><Icon size={13} /> <span>{step.text}</span></li>
      })}
    </ol>
  )
}

function DiffPreview({ change }) {
  const [expanded, setExpanded] = useState(false)
  if (!change) return null
  const rows = compactDiff(change.before, change.after, expanded ? 180 : 7)
  const path = String(change.path || '').split('/').pop()
  const status = change.status === 'rejected' ? 'Rejected' : 'Applied'

  return (
    <section className="prime-diff-card" aria-label="Proposed change">
      <div className="prime-section-heading">
        <div>
          <span>Proposed change</span>
          <strong>{path || 'Untitled change'}</strong>
        </div>
        <span className={`prime-diff-status prime-diff-status--${change.status || 'applied'}`}>{status}</span>
      </div>
      <div className={`prime-diff-lines ${expanded ? 'is-expanded' : ''}`}>
        {rows.map(row => (
          <div className="prime-diff-line" key={`${row.line}-${row.before}-${row.after}`}>
            <span className="prime-diff-line__number">{row.line}</span>
            <div className="prime-diff-line__before">{row.before || ' '}</div>
            <div className="prime-diff-line__after">{row.after || ' '}</div>
          </div>
        ))}
      </div>
      <div className="prime-diff-card__footer">
        <button type="button" onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}{expanded ? 'Compact' : 'Preview'}</button>
      </div>
    </section>
  )
}

export default function AIPanel({
  isDark,
  selectedCode,
  activeFile,
  currentFolder,
  projectIndex = [],
  openFiles = [],
  onOpenSettings,
  onApplyCode,
  onOpenDiffTab,
  onAgentFileWrite,
  onAgentWorkspaceChange,
  onUndoAgentEdit,
  onUndoAgentTask,
  canUndoAgentEdit = false,
  projectSummary,
  onWorkingChange,
  settingsVersion = 0
}) {
  const [messages, _setMessages] = useState([])
  const [showSkills, setShowSkills] = useState(false)
  const [chats, setChats] = useState([])
  const [activeChatId, setActiveChatId] = useState(null)
  const [showChatHistory, setShowChatHistory] = useState(false)
  const [showProjectMemory, setShowProjectMemory] = useState(false)
  const [projectMemoryRecords, setProjectMemoryRecords] = useState([])
  const [editingChatId, setEditingChatId] = useState(null)
  const [chatTitleDraft, setChatTitleDraft] = useState('')
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  // True once the current chat stream has emitted reasoning deltas.
  // Warn-only progress for slow reasoning models (e.g. Nemotron Ultra with
  // ~30-50s TTFT): it never aborts or otherwise affects the request.
  const [isReasoning, setIsReasoning] = useState(false)
  const [copiedKey, setCopiedKey] = useState(null)
  const [mode, setMode] = useState('agent')
  const [activeStreamId, setActiveStreamId] = useState(null)
  const [lastChatRequest, setLastChatRequest] = useState(null)
  const [lastChange, setLastChange] = useState(null)
  const [agentRun, setAgentRun] = useState(null)
  const [planDraft, setPlanDraft] = useState('')
  const [planRun, setPlanRun] = useState(null)
  const [aiConfig, setAiConfig] = useState(null)
  const [showComposerControls, setShowComposerControls] = useState(false)
  const [autoApproveCommands, setAutoApproveCommands] = useState(true)
  const [autoProceedPlan, setAutoProceedPlan] = useState(false)
  const [includeActiveFile, setIncludeActiveFile] = useState(true)
  const [includeSelection, setIncludeSelection] = useState(true)
  const [includeOpenFiles, setIncludeOpenFiles] = useState(true)
  const [attachedFiles, setAttachedFiles] = useState([])
  const [attachSearch, setAttachSearch] = useState('')
  const [pendingApproval, setPendingApproval] = useState(null)
  // Phase 6: ephemeral run diagnostics snapshot from the last agent run
  // (gauges, per-model metrics, timeline tail). Never persisted; cleared on
  // each new task. Rendered collapsed inside the agent summary card.
  const [runDiagnostics, setRunDiagnostics] = useState(null)

  // Refs mirror state for synchronous flushes and for background tasks that
  // keep running after the user switched to another chat.
  const activeChatIdRef = useRef(null)
  const messagesRef = useRef([])
  const agentRunRef = useRef(null)
  const planDraftRef = useRef('')
  const lastChangeRef = useRef(null)
  const chatsRefreshTimerRef = useRef(null)

  const setActiveChatIdAndRef = useCallback((id) => {
    activeChatIdRef.current = id
    setActiveChatId(id)
  }, [])

  // Debounced history-list refresh so titles/previews update live while
  // streaming without re-rendering the list on every delta.
  const scheduleChatsRefresh = useCallback(() => {
    clearTimeout(chatsRefreshTimerRef.current)
    chatsRefreshTimerRef.current = setTimeout(() => {
      setChats(memoryManager.conversations.getChats())
    }, 600)
  }, [])

  // Load messages + agent work when changing folders (with flush of the
  // previous folder's active chat on cleanup so nothing is lost).
  useEffect(() => {
    if (!currentFolder) {
      _setMessages([])
      setChats([])
      setActiveChatIdAndRef(null)
      setAgentRun(null)
      setPlanDraft('')
      setLastChange(null)
      return
    }
    // SQLite restoration is asynchronous. Listen before initializing so the
    // first empty chat and previous chats appear as soon as storage responds.
    const unsubscribe = memoryManager.conversations.subscribe((nextChats, nextActiveId) => {
      setChats(nextChats)
      const active = memoryManager.conversations.getActiveChat()
      if (!active || nextActiveId === activeChatIdRef.current) return
      const restored = active.messages || []
      const storedState = memoryManager.conversations.getAgentState(active.id)
      messagesRef.current = restored
      agentRunRef.current = storedState?.agentRun || rehydrateAgentRunFromMessages(restored)
      planDraftRef.current = storedState?.planDraft || agentRunRef.current?.plan || ''
      lastChangeRef.current = storedState?.lastChange || null
      setActiveChatIdAndRef(active.id)
      _setMessages(restored)
      setAgentRun(agentRunRef.current)
      setPlanDraft(planDraftRef.current)
      setLastChange(lastChangeRef.current)
    })
    memoryManager.init(currentFolder)
    const activeChat = memoryManager.conversations.getActiveChat()
    const id = activeChat ? activeChat.id : null
    const restoredMessages = activeChat?.messages || []
    const stored = id ? memoryManager.conversations.getAgentState(id) : null
    const restoredRun = stored?.agentRun || rehydrateAgentRunFromMessages(restoredMessages)
    // Keep synchronous refs aligned before the debounced persistence effects
    // can run. This prevents an outgoing chat snapshot being written into the
    // chat that has just been restored.
    messagesRef.current = restoredMessages
    agentRunRef.current = restoredRun
    planDraftRef.current = stored?.planDraft || restoredRun?.plan || ''
    lastChangeRef.current = stored?.lastChange || null
    setActiveChatIdAndRef(id)
    _setMessages(restoredMessages)
    setAgentRun(restoredRun)
    setPlanDraft(planDraftRef.current)
    setLastChange(lastChangeRef.current)
    setChats(memoryManager.conversations.getChats())
    setProjectMemoryRecords(memoryManager.projects.records || [])

    // Inspect and recover incomplete agent runs from crashes or abnormal termination
    try {
      const recoveryService = new CrashRecoveryService(currentFolder)
      recoveryService.recoverWorkspaceRuns(currentFolder).then(recovery => {
        if (recovery?.hasUnfinished && recovery.checkpoint?.resumable) {
          console.info('[AIPanel] Detected unfinished agent run from crash:', recovery.run?.id)
          setAgentRun(prev => prev || {
            task: recovery.run?.user_prompt || 'Resumed agent task',
            status: 'review',
            plan: recovery.checkpoint.reconciledSteps?.map(s => s.title).join('\n') || '',
            stages: emptyStages(),
            tools: [],
            changedFiles: recovery.checkpoint.verifiedFiles || [],
            todos: recovery.checkpoint.reconciledSteps || [],
            resumable: true,
            recoveredRunId: recovery.run?.id
          })
        }
      }).catch(err => {
        console.warn('[AIPanel] Crash recovery detection failed:', err?.message)
      })
    } catch {}
    return () => {
      unsubscribe()
      clearTimeout(chatsRefreshTimerRef.current)
      const flushId = activeChatIdRef.current
      if (flushId) {
        memoryManager.conversations.setMessages(
          messagesRef.current.filter(m => m.content),
          flushId
        )
        memoryManager.conversations.setAgentState(flushId, {
          agentRun: agentRunRef.current,
          planDraft: planDraftRef.current,
          lastChange: lastChangeRef.current
        }, { touch: false })
      }
    }
  }, [currentFolder, setActiveChatIdAndRef])

  // Restore a chat's full previous work (bubbles + agent card + plan draft).
  const restoreChatView = useCallback((id) => {
    const chat = memoryManager.conversations.chats.find(c => c.id === id)
    if (!chat) return
    const restoredMessages = Array.isArray(chat.messages) ? chat.messages : []
    const stored = memoryManager.conversations.getAgentState(id)
    const restoredRun = stored?.agentRun || rehydrateAgentRunFromMessages(restoredMessages)
    const restoredPlanDraft = stored?.planDraft || restoredRun?.plan || ''
    const restoredLastChange = stored?.lastChange || null

    // Update refs before changing the active ID. A previous chat's pending
    // debounce must never save its messages into the newly selected chat.
    messagesRef.current = restoredMessages
    agentRunRef.current = restoredRun
    planDraftRef.current = restoredPlanDraft
    lastChangeRef.current = restoredLastChange
    setActiveChatIdAndRef(id)
    _setMessages(restoredMessages)
    setAgentRun(restoredRun)
    setPlanDraft(restoredPlanDraft)
    setLastChange(restoredLastChange)
    // A saved agent task should reopen in Agent mode so its plan, progress,
    // checkpoint, and Continue button are visible immediately.
    if (restoredRun) setMode('agent')
  }, [setActiveChatIdAndRef])

  const handleNewChat = () => {
    const flushId = activeChatIdRef.current
    if (flushId) {
      memoryManager.conversations.setMessages(
        messagesRef.current.filter(m => m.content),
        flushId
      )
      memoryManager.conversations.setAgentState(flushId, {
        agentRun: agentRunRef.current,
        planDraft: planDraftRef.current,
        lastChange: lastChangeRef.current
      }, { touch: false })
    }
    memoryManager.conversations.createNewChat()
    messagesRef.current = []
    agentRunRef.current = null
    planDraftRef.current = ''
    lastChangeRef.current = null
    setActiveChatIdAndRef(memoryManager.conversations.activeChatId)
    setChats(memoryManager.conversations.getChats())
    _setMessages([])
    setShowChatHistory(false)
    setAgentRun(null)
    setPlanDraft('')
    setLastChange(null)
    setPlanRun(null)
  }

  const handleSwitchChat = (id) => {
    if (id === activeChatIdRef.current) {
      setShowChatHistory(false)
      return
    }
    const flushId = activeChatIdRef.current
    if (flushId) {
      memoryManager.conversations.setMessages(
        messagesRef.current.filter(m => m.content),
        flushId
      )
      memoryManager.conversations.setAgentState(flushId, {
        agentRun: agentRunRef.current,
        planDraft: planDraftRef.current,
        lastChange: lastChangeRef.current
      }, { touch: false })
    }
    memoryManager.conversations.setActiveChat(id)
    restoreChatView(id)
    setChats(memoryManager.conversations.getChats())
    setShowChatHistory(false)
    setPlanRun(null)
  }

  const handleDeleteChat = (e, id) => {
    e.stopPropagation()
    if (!window.confirm('Delete this chat?')) return
    memoryManager.conversations.deleteChat(id)
    restoreChatView(memoryManager.conversations.activeChatId)
    setChats(memoryManager.conversations.getChats())
  }

  // UI-only setter. Persistence is handled by the effects below so saves
  // always target the correct chat and never run inside a state updater.
  const setMessages = useCallback((updater) => {
    _setMessages(updater)
  }, [])

  // Explicit write to a specific (possibly backgrounded) chat's storage.
  const writeToChat = useCallback((chatId, updater) => {
    const conv = memoryManager.conversations
    const chat = conv.chats.find(c => c.id === chatId)
    if (!chat) return
    const next = typeof updater === 'function' ? updater(chat.messages || []) : updater
    conv.setMessages(next.filter(m => m.content), chatId)
    scheduleChatsRefresh()
  }, [scheduleChatsRefresh])

  // Approval gate for destructive / review-mode shell commands. The agent
  // awaits this promise; Approve resumes the tool, Deny skips it.
  const requestApproval = useCallback((approval) => new Promise(resolve => {
    approvalResolverRef.current = resolve
    setPendingApproval(approval)
  }), [])

  const resolveApproval = useCallback((granted) => {
    approvalResolverRef.current?.(granted)
    approvalResolverRef.current = null
    setPendingApproval(null)
  }, [])

  // Attachments are workspace-scoped — drop them on folder switches.
  useEffect(() => {
    setAttachedFiles([])
    setAttachSearch('')
  }, [currentFolder])

  const attachFile = useCallback((entry) => {
    if (!entry?.path) return
    setAttachedFiles(previous => {
      if (previous.some(file => file.path === entry.path)) return previous
      return [...previous, {
        path: entry.path,
        name: entry.name || String(entry.path).split(/[/\\]/).pop(),
        content: typeof entry.content === 'string' ? entry.content : ''
      }].slice(0, 10)
    })
  }, [])

  const detachFile = useCallback((path) => {
    setAttachedFiles(previous => previous.filter(file => file.path !== path))
  }, [])


  const attachSearchResults = useMemo(() => {
    const query = attachSearch.trim().toLowerCase()
    if (!query) return []
    return (projectIndex || [])
      .filter(file => !attachedFiles.some(attached => attached.path === file.path))
      .map(file => {
        const name = String(file.name || '').toLowerCase()
        const path = String(file.path || '').toLowerCase()
        const score = name.includes(query) ? 2 : path.includes(query) ? 1 : 0
        return { file, score }
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(item => item.file)
  }, [attachSearch, projectIndex, attachedFiles])
  const approvalResolverRef = useRef(null)
  const scrollRef = useRef(null)
  const inputRef = useRef(null)
  const agentAbortRef = useRef(null)
  const persistMsgsTimerRef = useRef(null)
  const persistAgentTimerRef = useRef(null)
  // Accumulates reasoning_content deltas for the in-flight chat stream.
  // Kept in a ref to avoid re-rendering on every thinking chunk; attached
  // to the finished assistant bubble once, truncated.
  const thinkingRef = useRef('')

  // Mirror state into refs for synchronous flushes on chat/folder switches.
  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => { agentRunRef.current = agentRun }, [agentRun])
  useEffect(() => { planDraftRef.current = planDraft }, [planDraft])
  useEffect(() => { lastChangeRef.current = lastChange }, [lastChange])

  // Persist chat bubbles to the currently open chat (debounced for streaming).
  useEffect(() => {
    if (!currentFolder || !activeChatId) return undefined
    clearTimeout(persistMsgsTimerRef.current)
    persistMsgsTimerRef.current = setTimeout(() => {
      memoryManager.conversations.setMessages(
        messagesRef.current.filter(m => m.content),
        activeChatIdRef.current
      )
      scheduleChatsRefresh()
    }, 400)
    return () => clearTimeout(persistMsgsTimerRef.current)
  }, [messages, activeChatId, currentFolder, scheduleChatsRefresh])

  // Persist agent card / plan draft / diff preview per chat.
  useEffect(() => {
    if (!currentFolder || !activeChatId) return undefined
    clearTimeout(persistAgentTimerRef.current)
    persistAgentTimerRef.current = setTimeout(() => {
      memoryManager.conversations.setAgentState(activeChatIdRef.current, {
        agentRun: agentRunRef.current,
        planDraft: planDraftRef.current,
        lastChange: lastChangeRef.current
      }, { touch: false })
    }, 400)
    return () => clearTimeout(persistAgentTimerRef.current)
  }, [agentRun, planDraft, lastChange, activeChatId, currentFolder])

  // Update one streaming assistant bubble, routing to origin-chat storage
  // when the user switched chats mid-stream instead of corrupting the new one.
  const updateStreamMessage = useCallback((targetChatId, key, content, isError = false) => {
    if (activeChatIdRef.current === targetChatId) {
      _setMessages(previous => previous.map(message =>
        message.id === key ? { ...message, content, ...(isError ? { isError: true } : {}) } : message
      ))
    } else {
      const conv = memoryManager.conversations
      const chat = conv.chats.find(c => c.id === targetChatId)
      if (!chat) return
      chat.messages = (chat.messages || []).map(message =>
        message.id === key ? { ...message, content, ...(isError ? { isError: true } : {}) } : message
      )
      conv.save()
      scheduleChatsRefresh()
    }
  }, [scheduleChatsRefresh])

  // Append a message to a task's origin chat (UI if still viewing it).
  const appendChatMessage = useCallback((targetChatId, message) => {
    if (activeChatIdRef.current === targetChatId) {
      _setMessages(previous => [...previous, message])
    } else {
      writeToChat(targetChatId, previous => [...previous, message])
    }
  }, [writeToChat])

  const updateStreamMessageThinking = useCallback((targetChatId, key, thinkingDelta) => {
    const updater = msg => msg.id === key ? { ...msg, thinking: (msg.thinking || '') + thinkingDelta } : msg
    if (activeChatIdRef.current === targetChatId) {
      _setMessages(previous => previous.map(updater))
    } else {
      const conv = memoryManager.conversations
      const chat = conv.chats.find(c => c.id === targetChatId)
      if (!chat) return
      chat.messages = (chat.messages || []).map(updater)
      conv.save()
    }
  }, [])

  const appendToolToStreamMessage = useCallback((targetChatId, key, toolItem) => {
    const updater = msg => {
      if (msg.id !== key) return msg
      const existingTools = Array.isArray(msg.tools) ? msg.tools : []
      return { ...msg, tools: [...existingTools, toolItem] }
    }
    if (activeChatIdRef.current === targetChatId) {
      _setMessages(previous => previous.map(updater))
    } else {
      const conv = memoryManager.conversations
      const chat = conv.chats.find(c => c.id === targetChatId)
      if (!chat) return
      chat.messages = (chat.messages || []).map(updater)
      conv.save()
    }
  }, [])

  const updateLastToolInStreamMessage = useCallback((targetChatId, key, updates) => {
    const updater = msg => {
      if (msg.id !== key || !Array.isArray(msg.tools) || msg.tools.length === 0) return msg
      const tools = [...msg.tools]
      const lastIdx = tools.length - 1
      tools[lastIdx] = { ...tools[lastIdx], ...updates }
      return { ...msg, tools }
    }
    if (activeChatIdRef.current === targetChatId) {
      _setMessages(previous => previous.map(updater))
    } else {
      const conv = memoryManager.conversations
      const chat = conv.chats.find(c => c.id === targetChatId)
      if (!chat) return
      chat.messages = (chat.messages || []).map(updater)
      conv.save()
    }
  }, [])

  const updateStreamMessageFinal = useCallback((targetChatId, key, content, extra = {}) => {
    const updater = msg => msg.id === key ? { ...msg, content, isWorking: false, ...extra } : msg
    if (activeChatIdRef.current === targetChatId) {
      _setMessages(previous => previous.map(updater))
    } else {
      const conv = memoryManager.conversations
      const chat = conv.chats.find(c => c.id === targetChatId)
      if (!chat) return
      chat.messages = (chat.messages || []).map(updater)
      conv.save()
      scheduleChatsRefresh()
    }
  }, [scheduleChatsRefresh])

  useEffect(() => {
    let cancelled = false
    getApiConfig().then(setAiConfig).catch(() => { if (!cancelled) setAiConfig(null) })
    return () => { cancelled = true }
  }, [settingsVersion])

  // Dynamic model options: current model pinned first, then every model the
  // stored key can actually call, then remaining known IDs as fallback.
  const [modelOptions, setModelOptions] = useState([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')

  const loadModelOptions = useCallback(async (provider, currentModel, { force = false } = {}) => {
    if (!provider) {
      setModelOptions(currentModel ? [{ id: currentModel, current: true }] : [])
      return
    }
    setModelsLoading(true)
    try {
      const { models, liveModels, error } = await listProviderModels(provider, { force })
      setModelOptions(resolveModelOptions({ provider, currentModel, liveModels: liveModels || models }))
      setModelsError(error ? `Could not verify key (${error}); showing known models.` : '')
    } catch (error) {
      setModelOptions(resolveModelOptions({ provider, currentModel }))
      setModelsError(`Could not verify key (${error.message}); showing known models.`)
    } finally {
      setModelsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (aiConfig?.provider) loadModelOptions(aiConfig.provider, aiConfig.model)
  }, [aiConfig?.provider, aiConfig?.model, loadModelOptions])

  // Settings modal may have changed provider, key, or model — reload all.
  useEffect(() => {
    if (settingsVersion === 0) return
    let cancelled = false
    getApiConfig()
      .then(config => {
        if (cancelled) return
        setAiConfig(config)
        if (config?.provider) loadModelOptions(config.provider, config.model, { force: true })
      })
      .catch(() => { if (!cancelled) setAiConfig(null) })
    return () => { cancelled = true }
  }, [settingsVersion, loadModelOptions])

  const workspaceMemory = getWorkspaceMemory(currentFolder)
  const modelCapabilities = useMemo(() => getModelCapabilities(aiConfig?.provider, aiConfig?.model), [aiConfig?.model, aiConfig?.provider])
  const includedFileCount = (includeActiveFile && activeFile ? 1 : 0) + (includeOpenFiles ? openFiles.length : 0) + attachedFiles.length
  const estimatedContextTokens = useMemo(() => {
    const source = [
      includeActiveFile ? activeFile?.content : '',
      includeSelection ? selectedCode : '',
      ...(includeOpenFiles ? openFiles.map(file => file.content || '') : []),
      ...attachedFiles.map(file => file.content || ''),
      ...messages.slice(-8).map(message => message.content || '')
    ].join('\n')
    return Math.ceil(source.length / 4)
  }, [activeFile?.content, attachedFiles, includeActiveFile, includeOpenFiles, includeSelection, messages, openFiles, selectedCode])
  const contextChips = useMemo(() => {
    const chips = []
    if (activeFile?.name) chips.push(activeFile.name)
    if (selectedCode) chips.push('selection')
    if (openFiles.length) chips.push(`${openFiles.length} open`)
    if (attachedFiles.length) chips.push(`${attachedFiles.length} attached`)
    if (workspaceMemory.length) chips.push(`${workspaceMemory.length} remembered`)
    return chips.slice(0, 5)
  }, [activeFile?.name, attachedFiles.length, openFiles.length, selectedCode, workspaceMemory.length])

  useEffect(() => {
    onWorkingChange?.(isLoading)
    return () => onWorkingChange?.(false)
  }, [isLoading, onWorkingChange])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const isNearEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 160
    if (isNearEnd) element.scrollTop = element.scrollHeight
  }, [messages, agentRun?.tools.length, agentRun?.summary, planRun?.content])

  const copyToClipboard = useCallback(async (text, key) => {
    await navigator.clipboard?.writeText(text)
    setCopiedKey(key)
    window.setTimeout(() => setCopiedKey(null), 1600)
  }, [])

  const ensureProvider = useCallback(async () => {
    const config = await getApiConfig()
    if (!config.apiKey && !isLocalProvider(config)) {
      setMessages(previous => [...previous, {
        role: 'assistant',
        content: 'Add an API key in AI settings before using Prime AI.',
        isError: true
      }])
      return null
    }
    return config
  }, [setMessages])

  const handleModelChange = useCallback(async (model) => {
    if (!aiConfig || model === aiConfig.model) return
    try {
      await saveApiConfig({ provider: aiConfig.provider, model, apiKey: '' })
      setAiConfig(current => ({ ...current, model }))
      setModelOptions(previous => {
        const liveIds = previous.filter(option => option.live).map(option => option.id)
        return resolveModelOptions({ provider: aiConfig.provider, currentModel: model, liveModels: liveIds })
      })
    } catch (error) {
      setMessages(previous => [...previous, { role: 'assistant', content: `Could not switch model: ${error.message}`, isError: true }])
    }
  }, [aiConfig, setMessages])

  const runApprovedAgentTask = useCallback(async (task, approvedPlan, resumeFromCheckpoint = false) => {
    if (!task || isLoading || !(await ensureProvider())) return

    const taskChatId = activeChatIdRef.current
    const isViewingTaskChat = () => activeChatIdRef.current === taskChatId
    setInput('')
    setIsLoading(true)
    const userPromptContent = resumeFromCheckpoint
      ? 'Continue the approved plan from the saved checkpoint.'
      : (approvedPlan ? 'Approved the implementation plan. Proceed with the work.' : task)
    appendChatMessage(taskChatId, { role: 'user', content: userPromptContent })
    setAgentRun(previous => previous ? { ...previous, status: 'working', summary: '', stages: { ...emptyStages(), inspect: { status: 'working', detail: 'Starting the task.' } } } : createAgentRun(task))
    setRunDiagnostics(null)
    const controller = new AbortController()
    agentAbortRef.current = controller
    const taskId = `task-${Date.now()}`
    const responseKey = `agent-response-${Date.now()}`
    appendChatMessage(taskChatId, {
      id: responseKey,
      role: 'assistant',
      content: 'Analyzing your workspace and preparing changes…',
      thinking: '',
      tools: [],
      isWorking: true
    })
    try {
      const result = await runAgentTask({
        task,
        context: {
          currentFolder,
          activeFile: includeActiveFile ? activeFile : null,
          selectedCode: includeSelection ? selectedCode : null,
          projectIndex,
          projectSummary,
          openFiles: includeOpenFiles ? openFiles : [],
          attachedFiles,
          approvedPlan,
          resumeFromCheckpoint,
          commandApproval: autoApproveCommands ? 'auto' : 'review',
          conversationHistory: messages
            .filter(message => message.content && (message.role === 'user' || message.role === 'assistant'))
            .map(message => ({ role: message.role, content: String(message.content).slice(0, 2000) })),
          checkpoint: resumeFromCheckpoint
            ? {
                ...(agentRunRef.current?.checkpoint || {}),
                todos: agentRunRef.current?.todos || [],
                plan: approvedPlan
              }
            : null
        },
        tools: {
          onFileWritten: (filePath, content, previousContent, change) => {
            onAgentFileWrite?.(filePath, content, previousContent, { ...(change || {}), taskId })
            const changeRecord = { ...(change || { path: filePath, before: previousContent, after: content }), status: 'applied' }
            const relPath = relativePath(filePath, currentFolder)
            if (isViewingTaskChat()) {
              setLastChange(changeRecord)
              setAgentRun(previous => previous ? {
                ...previous,
                changedFiles: [...new Set([...previous.changedFiles, relPath])],
                stages: { ...previous.stages, edit: { status: 'complete', detail: 'Patch applied to the workspace.' } }
              } : previous)
            } else {
              const conv = memoryManager.conversations
              const stored = conv.getAgentState(taskChatId)
              const base = stored?.agentRun || createAgentRun(task)
              conv.setAgentState(taskChatId, {
                lastChange: changeRecord,
                agentRun: {
                  ...base,
                  changedFiles: [...new Set([...(base.changedFiles || []), relPath])],
                  stages: { ...base.stages, edit: { status: 'complete', detail: 'Patch applied to the workspace.' } }
                }
              }, { touch: false })
            }
          },
          onWorkspaceChanged: onAgentWorkspaceChange,
          requestApproval
        },
        onEvent: event => {
          if (!isViewingTaskChat()) {
            const conv = memoryManager.conversations
            const stored = conv.getAgentState(taskChatId)
            conv.setAgentState(taskChatId, {
              agentRun: updateRunFromEvent(stored?.agentRun || createAgentRun(task), event)
            }, { touch: false })
          } else {
            setAgentRun(previous => updateRunFromEvent(previous, event))
          }

          if (event.type === 'thinking') {
            const thinkingText = event.message || ''
            updateStreamMessageThinking(taskChatId, responseKey, thinkingText ? `${thinkingText}\n` : '')
          } else if (event.type === 'tool') {
            const toolAction = event.action || {}
            appendToolToStreamMessage(taskChatId, responseKey, {
              id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              label: describeAction(toolAction),
              type: toolAction.type,
              status: 'working',
              path: toolAction.path,
              command: toolAction.command,
              action: toolAction
            })
          } else if (event.type === 'observation') {
            const failed = /^(?:[a-z_]+ failed:|[a-z_]+ blocked:|[a-z_]+ denied by user:|run_command blocked)/i.test(String(event.message || '').trim())
            updateLastToolInStreamMessage(taskChatId, responseKey, {
              status: failed ? 'failed' : 'complete',
              detail: String(event.message || '').slice(0, 1200)
            })
          }
        },
        maxTurns: 100,
        signal: controller.signal
      })
      if (controller.signal.aborted) return
      const isCancelled = result?.cancelled
      const isFailed = result?.failed
      const summaryText = result?.summary || String(result)
      const finalStatus = isCancelled ? 'cancelled' : isFailed ? 'failed' : 'complete'
      const finalizeRun = previous => previous ? {
        ...previous,
        status: finalStatus,
        summary: summaryText,
        resumable: Boolean(result?.error === 'Max turns reached without task completion.'),
        checkpoint: result?.checkpoint || previous.checkpoint || null,
        verification: result?.verification || previous.verification || null,
        verified: Boolean(result?.verified),
        stages: Object.fromEntries(Object.entries(previous.stages).map(([key, value]) => [key, value.status === 'working' ? { ...value, status: isCancelled || isFailed ? 'failed' : 'complete' } : value]))
      } : previous

      let conversationalContent = ''
      if (isCancelled) {
        conversationalContent = 'I stopped working on this task. Any incomplete changes were rolled back for safety.'
      } else if (isFailed) {
        conversationalContent = `I encountered an issue while working on this task:\n\n${summaryText}`
      } else {
        const changedList = (result?.changedFiles || [])
        const filesBlock = changedList.length > 0
          ? `\n\n**Modified files (${changedList.length}):**\n${changedList.map(f => `- \`${f}\``).join('\n')}`
          : ''
        const verifBlock = result?.verified
          ? '\n\n✅ **Verification passed:** All tests and build checks completed successfully.'
          : (result?.verification?.attempted ? `\n\n⚠️ **Verification:** ${result.verification.command || 'Check'} did not pass.` : '')
        conversationalContent = `${summaryText}${filesBlock}${verifBlock}\n\nWhat would you like me to do next?`
      }

      if (isViewingTaskChat()) {
        setAgentRun(finalizeRun)
        updateStreamMessageFinal(taskChatId, responseKey, conversationalContent)
        if (result?.diagnostics) setRunDiagnostics(result.diagnostics)
      } else {
        const conv = memoryManager.conversations
        const stored = conv.getAgentState(taskChatId)
        conv.setAgentState(taskChatId, { agentRun: finalizeRun(stored?.agentRun || createAgentRun(task)) })
        updateStreamMessageFinal(taskChatId, responseKey, conversationalContent)
      }
    } catch (error) {
      const errMsg = error.name === 'AbortError' ? 'Agent cancelled. Changes were rolled back for safety.' : error.message
      if (isViewingTaskChat()) {
        setAgentRun(previous => previous ? { ...previous, status: error.name === 'AbortError' ? 'cancelled' : 'failed', summary: errMsg } : previous)
        updateStreamMessageFinal(taskChatId, responseKey, `I ran into an issue: ${errMsg}`, { isError: true })
      } else {
        const conv = memoryManager.conversations
        const stored = conv.getAgentState(taskChatId)
        const base = stored?.agentRun || createAgentRun(task)
        conv.setAgentState(taskChatId, {
          agentRun: { ...base, status: error.name === 'AbortError' ? 'cancelled' : 'failed', summary: errMsg }
        })
        updateStreamMessageFinal(taskChatId, responseKey, `I ran into an issue: ${errMsg}`, { isError: true })
      }
    } finally {
      agentAbortRef.current = null
      setIsLoading(false)
    }
  }, [activeFile, appendChatMessage, appendToolToStreamMessage, attachedFiles, autoApproveCommands, currentFolder, ensureProvider, includeActiveFile, includeOpenFiles, includeSelection, isLoading, messages, onAgentFileWrite, onAgentWorkspaceChange, openFiles, projectIndex, projectSummary, requestApproval, selectedCode, setMessages, updateLastToolInStreamMessage, updateStreamMessageFinal, updateStreamMessageThinking, writeToChat])

  const presentPlanInEditor = useCallback(async (planText) => {
    if (!planText) return
    const planFileName = 'implementation_plan.md'
    const planFilePath = currentFolder ? `${currentFolder.replace(/[/\\]+$/, '')}\\${planFileName}` : planFileName

    // Save to disk if window.api is available and workspace is open
    if (window.api?.writeFile && currentFolder) {
      try {
        await window.api.writeFile(planFilePath, planText)
      } catch (err) {
        // non-blocking fallback
      }
    }

    // Open directly in Monaco Editor
    useEditorStore.getState().openFile({
      path: planFilePath,
      name: planFileName,
      content: planText,
      isDirty: false
    })
  }, [currentFolder])

  const sendAgentTask = useCallback(async (prompt = '') => {
    const task = (typeof prompt === 'string' && prompt ? prompt : input).trim()
    if (!task || isLoading || !(await ensureProvider())) return

    const taskChatId = activeChatIdRef.current
    const isViewingTaskChat = () => activeChatIdRef.current === taskChatId
    setInput('')
    setIsLoading(true)
    // Planning gets its own controller so Stop works while the plan is
    // being prepared or the workspace is being indexed — previously Stop
    // was a no-op here because no signal existed yet.
    const planController = new AbortController()
    agentAbortRef.current = planController
    const planningRun = { ...createAgentRun(task), status: 'planning', summary: 'Preparing an implementation plan for your review.' }
    if (isViewingTaskChat()) {
      setAgentRun(planningRun)
    } else {
      memoryManager.conversations.setAgentState(taskChatId, { agentRun: planningRun }, { touch: false })
    }
    appendChatMessage(taskChatId, { role: 'user', content: task })
    try {
      const plan = await runAgentPlan({
        task,
        signal: planController.signal,
        context: {
          currentFolder,
          activeFile: includeActiveFile ? activeFile : null,
          selectedCode: includeSelection ? selectedCode : null,
          projectIndex,
          projectSummary,
          openFiles: includeOpenFiles ? openFiles : [],
          attachedFiles,
          conversationHistory: messages
            .filter(message => message.content && (message.role === 'user' || message.role === 'assistant'))
            .map(message => ({ role: message.role, content: String(message.content).slice(0, 900) }))
        }
      })
      await presentPlanInEditor(plan)
      const reviewRun = run => run ? { ...run, status: 'review', plan, summary: 'Review this implementation plan in the editor. Choose Proceed to begin.' } : run
      if (isViewingTaskChat()) {
        setPlanDraft(plan)
        setAgentRun(reviewRun)
      } else {
        const conv = memoryManager.conversations
        const stored = conv.getAgentState(taskChatId)
        conv.setAgentState(taskChatId, { agentRun: reviewRun(stored?.agentRun || planningRun), planDraft: plan })
      }
      appendChatMessage(taskChatId, {
        role: 'assistant',
        content: `📋 **Implementation plan generated and opened in editor: \`implementation_plan.md\`**\n\nReview the plan in the editor, and click **Proceed with plan** below to begin.`
      })
      if (autoProceedPlan) {
        // Stop during planning must not auto-start execution afterwards.
        if (planController.signal.aborted) return
        setIsLoading(false)
        await runApprovedAgentTask(task, plan)
        return
      }
    } catch (error) {
      const wasCancelled = error?.name === 'AbortError' || planController.signal.aborted
      const summary = wasCancelled ? 'Planning cancelled before any changes were made.' : error.message
      const status = wasCancelled ? 'cancelled' : 'failed'
      if (isViewingTaskChat()) {
        setAgentRun(previous => previous ? { ...previous, status, summary } : previous)
      } else {
        const conv = memoryManager.conversations
        const stored = conv.getAgentState(taskChatId)
        const base = stored?.agentRun || planningRun
        conv.setAgentState(taskChatId, { agentRun: { ...base, status, summary } })
      }
    } finally {
      if (agentAbortRef.current === planController) agentAbortRef.current = null
      setIsLoading(false)
    }
  }, [activeFile, appendChatMessage, attachedFiles, autoProceedPlan, currentFolder, ensureProvider, includeActiveFile, includeOpenFiles, includeSelection, input, isLoading, messages, openFiles, presentPlanInEditor, projectIndex, projectSummary, runApprovedAgentTask, selectedCode])

  const sendPlanTask = useCallback(async (prompt = '') => {
    const task = (prompt || input).trim()
    if (!task || isLoading || !(await ensureProvider())) return

    setInput('')
    setIsLoading(true)
    setPlanRun({ task, content: '', status: 'working' })
    try {
      const content = await runAgentPlan({
        task,
        context: { currentFolder, activeFile: includeActiveFile ? activeFile : null, selectedCode: includeSelection ? selectedCode : null, projectIndex, projectSummary, openFiles: includeOpenFiles ? openFiles : [], attachedFiles, conversationHistory: messages.slice(-4) }
      })
      await presentPlanInEditor(content)
      setPlanRun({ task, content, status: 'complete' })
    } catch (error) {
      setPlanRun({ task, content: error.message, status: 'failed' })
    } finally {
      setIsLoading(false)
    }
  }, [activeFile, attachedFiles, currentFolder, ensureProvider, includeActiveFile, includeOpenFiles, includeSelection, input, isLoading, messages, openFiles, presentPlanInEditor, projectIndex, projectSummary, selectedCode])

  const sendChat = useCallback(async (action = 'custom', prompt = '', retryRequest = null) => {
    const userMessage = retryRequest?.userMessage || (action === 'custom'
      ? (prompt || input)
      : `${action[0].toUpperCase()}${action.slice(1)} this ${selectedCode ? 'selection' : 'file'}`)
    if (!userMessage.trim() || isLoading || !(await ensureProvider())) return

    const codeContext = retryRequest?.codeContext ?? ((includeSelection && selectedCode) || (includeActiveFile && activeFile?.content) || '')
    if (!retryRequest) {
      setMessages(previous => [...previous, {
        role: 'user',
        content: userMessage,
        context: codeContext ? activeFile?.name || 'selection' : ''
      }])
    }
    setInput('')
    setIsLoading(true)
    setIsReasoning(false)
    thinkingRef.current = ''
    setLastChatRequest({ action, userMessage, codeContext })

    let response = ''
    const responseKey = `${Date.now()}-response`
    const targetChatId = activeChatIdRef.current
    setMessages(previous => [...previous, { id: responseKey, role: 'assistant', content: '' }])
    try {
      // Route through intent-aware smart chat
      const result = await runSmartChat({
        mode,
        message: userMessage,
        conversationHistory: messages
          .filter(m => m.content && (m.role === 'user' || m.role === 'assistant'))
          .map(m => ({ role: m.role, content: String(m.content).slice(0, 1000) })),
        context: {
          currentFolder,
          activeFile: includeActiveFile ? activeFile : null,
          selectedCode: codeContext || undefined,
          projectIndex,
          openFiles: includeOpenFiles ? openFiles : [],
          attachedFiles,
          projectSummary
        },
        onDelta: delta => {
          response += delta
          updateStreamMessage(targetChatId, responseKey, response)
        },
        onThinking: thinking => {
          thinkingRef.current += thinking
          setIsReasoning(true)
        },
        onRequestId: setActiveStreamId
      })

      // Attach the reasoning trace (collapsed in the UI) so the work the
      // model did before answering stays inspectable without crowding out
      // the final answer.
      if (thinkingRef.current && activeChatIdRef.current === targetChatId) {
        const trace = thinkingRef.current.slice(0, 6000)
        _setMessages(previous => previous.map(message =>
          message.id === responseKey ? { ...message, thinking: trace } : message
        ))
      }

      // If the classifier returned an instant response (greeting/thanks), show it directly
      if (result.quickResponse) {
        updateStreamMessage(targetChatId, responseKey, result.quickResponse)
      }
    } catch (error) {
      updateStreamMessage(targetChatId, responseKey, error.message, true)
    } finally {
      setIsLoading(false)
      setIsReasoning(false)
      setActiveStreamId(null)
    }
  }, [activeFile, attachedFiles, currentFolder, ensureProvider, includeActiveFile, includeOpenFiles, includeSelection, input, isLoading, messages, mode, openFiles, projectIndex, projectSummary, selectedCode, setMessages, updateStreamMessage])

  const handleHandOffToAgent = useCallback((planOrTask) => {
    setMode('agent')
    runApprovedAgentTask(planOrTask, null)
  }, [runApprovedAgentTask])

  const handleSubmit = useCallback(() => {
    const rawInput = input.trim()
    if (!rawInput) return

    if (rawInput === '/skills' || rawInput === '/skill create') {
      setShowSkills(true)
      setInput('')
      return
    }

    const classificationContext = {
      hasActiveFile: Boolean(activeFile),
      hasSelectedCode: Boolean(selectedCode),
      hasWorkspace: Boolean(currentFolder)
    }

    const intentResult = IntentClassifier.classify(rawInput, messages, classificationContext)

    // 1. If currently reviewing an implementation plan:
    if (agentRun?.status === 'review') {
      const isCancellation = /^(cancel|never\s*mind|stop|forget\s*it|abort|discard)\b/i.test(rawInput)
      if (isCancellation) {
        setAgentRun(null)
        setPlanDraft('')
        appendChatMessage(activeChatIdRef.current, { role: 'user', content: rawInput })
        appendChatMessage(activeChatIdRef.current, { role: 'assistant', content: 'Plan discarded. What would you like to work on instead?' })
        setInput('')
        return
      }

      // If user typed a greeting or conversational question, don't corrupt the plan with "Reviewer additions: hi"
      if (
        intentResult.intent === INTENTS.GREETING ||
        intentResult.intent === INTENTS.CONVERSATION ||
        intentResult.intent === INTENTS.QUESTION
      ) {
        setAgentRun(null)
        setPlanDraft('')
        sendChat('custom', rawInput)
        return
      }

      // If user provided a new task entirely instead of plan edits:
      if (
        !/^(step\s*\d+|change\s+step|add\s+step|revise|plan:|update\s+the\s+plan)\b/i.test(rawInput) &&
        (intentResult.intent === INTENTS.FEATURE_REQUEST || intentResult.intent === INTENTS.BUG_FIX || intentResult.intent === INTENTS.TERMINAL_COMMAND)
      ) {
        setAgentRun(null)
        setPlanDraft('')
        runApprovedAgentTask(rawInput, null)
        return
      }

      // Otherwise, treat as instructions to amend the plan:
      const revisedPlan = `${planDraft || agentRun.plan}\n\n## Reviewer additions\n${rawInput}`
      setPlanDraft(revisedPlan)
      setAgentRun(previous => previous ? { ...previous, plan: revisedPlan, summary: 'Plan updated with your instructions. Review it, then choose Proceed.' } : previous)
      appendChatMessage(activeChatIdRef.current, { role: 'user', content: `Plan changes requested: ${rawInput}` })
      setInput('')
      return
    }

    // 2. If intent is greeting, conversation, question, or general explanation (no agent tools needed):
    if (
      intentResult.toolReqs?.needsAgent === false ||
      intentResult.intent === INTENTS.GREETING ||
      intentResult.intent === INTENTS.CONVERSATION ||
      intentResult.intent === INTENTS.QUESTION ||
      intentResult.intent === INTENTS.CODE_EXPLANATION
    ) {
      sendChat('custom', rawInput)
      return
    }

    // 3. If explicit planning requested (starts with /plan, or intent is PLANNING):
    if (intentResult.intent === INTENTS.PLANNING || /^\/(?:plan|planning)\b/i.test(rawInput)) {
      const planTask = rawInput.replace(/^\/(?:plan|planning)\s*/i, '').trim() || rawInput
      sendAgentTask(planTask)
      return
    }

    // 4. Default for coding tasks (features, bug fixes, refactoring, commands, terminal, debugging):
    // Execute autonomously and conversationally, just like Antigravity!
    runApprovedAgentTask(rawInput, null)
  }, [activeFile, agentRun?.plan, agentRun?.status, appendChatMessage, currentFolder, input, messages, planDraft, runApprovedAgentTask, selectedCode, sendAgentTask, sendChat])

  const handleKeyDown = useCallback((event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSubmit()
    }
  }, [handleSubmit])

  const clearHistory = () => {
    if (!window.confirm('Clear Prime AI chat history?')) return
    setMessages([])
    setAgentRun(null)
    setPlanDraft('')
    setLastChange(null)
    setPlanRun(null)
    // Persist effects save the emptied chat; refresh the list immediately
    // so its title/preview update without reopening history.
    scheduleChatsRefresh()
  }

  const cancelStreaming = () => {
    const controller = agentAbortRef.current
    controller?.abort()
    // A stuck approval dialog must never hang the agent after cancelling.
    resolveApproval(false)
    if (controller) {
      setAgentRun(previous => previous ? {
        ...previous,
        status: 'cancelled',
        summary: 'Cancelling current work… Changes were rolled back for safety.',
        stages: Object.fromEntries(Object.entries(previous.stages).map(([key, value]) => [key, value.status === 'working' ? { ...value, status: 'failed', detail: 'Cancelled by user.' } : value]))
      } : previous)
    }
    if (activeStreamId) window.api.cancelAIStream(activeStreamId)
  }
  const retryLastMessage = () => lastChatRequest && sendChat(lastChatRequest.action, '', lastChatRequest)

  const beginRenameChat = (event, chat) => {
    event.stopPropagation()
    setEditingChatId(chat.id)
    setChatTitleDraft(chat.title)
  }

  const saveChatTitle = (event, chatId) => {
    event.stopPropagation()
    const title = chatTitleDraft.trim()
    if (title) memoryManager.conversations.renameChat(chatId, title)
    setChats(memoryManager.conversations.getChats())
    setEditingChatId(null)
  }

  const viewModel = useMemo(() => {
    return buildAgentViewModel({
      agentRun,
      messages,
      isLoading,
      pendingApproval,
      activeFile,
      currentFolder,
      runDiagnostics
    })
  }, [agentRun, messages, isLoading, pendingApproval, activeFile, currentFolder, runDiagnostics])

  return (
    <aside className={`prime-ai ${isDark ? 'prime-ai--dark' : 'prime-ai--light'} w-full h-full flex flex-col`} aria-label="Prime AI">
      <SkillsModal
        open={showSkills}
        onClose={() => setShowSkills(false)}
        workspaceId={currentFolder}
        onUse={slug => { setInput(`/skill ${slug} `); setShowSkills(false); inputRef.current?.focus() }}
      />

      {showChatHistory ? (
        <section className="prime-chat-history p-3 flex flex-col gap-2 overflow-y-auto h-full">
          <div className="flex items-center justify-between pb-2 border-b border-[var(--agent-border)]">
            <span className="font-semibold text-xs text-[var(--agent-text)]">Recent Tasks &amp; Chats</span>
            <button
              type="button"
              onClick={() => setShowChatHistory(false)}
              className="text-xs text-cyan-400 hover:underline cursor-pointer"
            >
              Back to workspace
            </button>
          </div>
          {chats.map(chat => (
            <div
              key={chat.id}
              className={`prime-chat-item p-2 rounded-lg border cursor-pointer transition-colors ${
                memoryManager.conversations.activeChatId === chat.id
                  ? 'bg-cyan-500/10 border-cyan-500/40 text-[var(--agent-text)]'
                  : 'bg-[var(--agent-surface)] border-[var(--agent-border)] text-[var(--agent-text-secondary)] hover:bg-[var(--agent-surface-hover)]'
              }`}
              onClick={() => handleSwitchChat(chat.id)}
            >
              <div className="flex items-center justify-between">
                <strong className="text-xs truncate max-w-[200px]">{chat.title || 'Untitled task'}</strong>
                <button
                  type="button"
                  onClick={(e) => handleDeleteChat(e, chat.id)}
                  title="Delete chat"
                  className="text-zinc-500 hover:text-rose-400 p-1"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <p className="text-[11px] text-[var(--agent-text-muted)] truncate mt-0.5">{getChatPreview(chat)}</p>
            </div>
          ))}
        </section>
      ) : showProjectMemory ? (
        <section className="prime-project-memory p-3 flex flex-col gap-2 overflow-y-auto h-full">
          <div className="flex items-center justify-between pb-2 border-b border-[var(--agent-border)]">
            <span className="font-semibold text-xs text-[var(--agent-text)]">Workspace Long-Term Memory</span>
            <button
              type="button"
              onClick={() => setShowProjectMemory(false)}
              className="text-xs text-cyan-400 hover:underline cursor-pointer"
            >
              Back to workspace
            </button>
          </div>
          <p className="text-[11px] text-[var(--agent-text-muted)]">Facts Prime AI retains about this project across sessions.</p>
          {projectMemoryRecords.length === 0 && (
            <span className="text-xs text-[var(--agent-text-muted)] italic">No memory records stored yet.</span>
          )}
          {projectMemoryRecords.map((item, i) => (
            <div key={i} className="p-2 rounded bg-[var(--agent-surface)] border border-[var(--agent-border)] text-xs flex flex-col gap-1">
              <span className="font-semibold text-cyan-400">{item.key}</span>
              <span className="text-[var(--agent-text-secondary)]">{item.value}</span>
            </div>
          ))}
        </section>
      ) : (
        <AgentWorkspace
          viewModel={viewModel}
          messages={messages}
          input={input}
          onChangeInput={setInput}
          onSubmit={handleSubmit}
          onKeyDown={handleKeyDown}
          onCancel={cancelStreaming}
          isWorking={isLoading}
          mode={mode}
          onChangeMode={setMode}
          aiConfig={aiConfig}
          modelOptions={modelOptions}
          modelsLoading={modelsLoading}
          modelsError={modelsError}
          onModelChange={handleModelChange}
          onRefreshModels={() => aiConfig && loadModelOptions(aiConfig.provider, aiConfig.model, { force: true })}
          estimatedContextTokens={estimatedContextTokens}
          maxContextTokens={modelCapabilities.contextWindowTokens}
          attachedFiles={attachedFiles}
          onDetachFile={detachFile}
          showComposerControls={showComposerControls}
          onToggleComposerControls={() => setShowComposerControls(v => !v)}
          includeActiveFile={includeActiveFile}
          setIncludeActiveFile={setIncludeActiveFile}
          includeSelection={includeSelection}
          setIncludeSelection={setIncludeSelection}
          hasSelection={Boolean(selectedCode)}
          includeOpenFiles={includeOpenFiles}
          setIncludeOpenFiles={setIncludeOpenFiles}
          openFilesCount={openFiles.length}
          autoApproveCommands={autoApproveCommands}
          setAutoApproveCommands={setAutoApproveCommands}
          autoProceedPlan={autoProceedPlan}
          setAutoProceedPlan={setAutoProceedPlan}
          activeFileName={activeFile?.name || ''}
          onAttachActiveFile={() => activeFile && attachFile({ path: activeFile.path, name: activeFile.name, content: activeFile.content })}
          attachSearch={attachSearch}
          setAttachSearch={setAttachSearch}
          attachSearchResults={attachSearchResults}
          onAttachFile={attachFile}
          chats={chats}
          activeChatId={activeChatId}
          onSwitchChat={handleSwitchChat}
          onNewChat={handleNewChat}
          onOpenSettings={onOpenSettings}
          onOpenSkills={() => setShowSkills(true)}
          onToggleMemory={() => { setShowProjectMemory(v => !v); setShowChatHistory(false) }}
          onToggleHistory={() => { setShowChatHistory(v => !v); setShowProjectMemory(false) }}
          onClearHistory={clearHistory}
          onUndoEdit={onUndoAgentEdit}
          canUndo={canUndoAgentEdit}
          planDraft={planDraft}
          onChangePlanDraft={setPlanDraft}
          onProceedPlan={() => runApprovedAgentTask(agentRun?.task, planDraft || agentRun?.plan)}
          onCancelPlan={() => { setAgentRun(null); setPlanDraft(''); }}
          onSavePlanEdits={() => { setAgentRun(p => p ? { ...p, plan: planDraft } : p) }}
          onOpenPlanInEditor={() => presentPlanInEditor(planDraft || agentRun?.plan)}
          onResolveApproval={resolveApproval}
          lastChange={lastChange}
          onReviewChanges={(change) => {
            setLastChange(change)
            onOpenDiffTab?.(change)
          }}
          onRetry={retryLastMessage}
          onResume={() => runApprovedAgentTask(agentRun?.task, agentRun?.plan, true)}
          onApplyCode={onApplyCode}
          onHandOffToAgent={handleHandOffToAgent}
        />
      )}
    </aside>
  )
}
