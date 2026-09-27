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
  MoreHorizontal,
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
import { getModelCapabilities } from '../services/agentEngine/LLMRouter'

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
    appendChatMessage(taskChatId, { role: 'user', content: resumeFromCheckpoint ? 'Continue the approved plan from the saved checkpoint.' : 'Approved the implementation plan. Proceed with the work.' })
    setAgentRun(previous => previous ? { ...previous, status: 'working', summary: '', stages: { ...emptyStages(), inspect: { status: 'working', detail: 'Starting the approved implementation plan.' } } } : createAgentRun(task))
    setRunDiagnostics(null)
    const controller = new AbortController()
    agentAbortRef.current = controller
    const taskId = `task-${Date.now()}`
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
            if (isViewingTaskChat()) {
              setLastChange(changeRecord)
              setAgentRun(previous => previous ? {
                ...previous,
                changedFiles: [...new Set([...previous.changedFiles, relativePath(filePath, currentFolder)])],
                stages: { ...previous.stages, edit: { status: 'complete', detail: 'Patch applied to the workspace.' } }
              } : previous)
            } else {
              // Backgrounded: fold progress into the origin chat's stored
              // snapshot without touching the chat currently on screen.
              const conv = memoryManager.conversations
              const stored = conv.getAgentState(taskChatId)
              const base = stored?.agentRun || createAgentRun(task)
              conv.setAgentState(taskChatId, {
                lastChange: changeRecord,
                agentRun: {
                  ...base,
                  changedFiles: [...new Set([...(base.changedFiles || []), relativePath(filePath, currentFolder)])],
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
            return
          }
          setAgentRun(previous => updateRunFromEvent(previous, event))
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
        stages: Object.fromEntries(Object.entries(previous.stages).map(([key, value]) => [key, value.status === 'working' ? { ...value, status: isCancelled || isFailed ? 'failed' : 'complete' } : value]))
      } : previous
      const resultMessage = { role: 'assistant', content: `Implementation result:\n${summaryText}\n\nChanged files: ${(result?.changedFiles || []).join(', ') || 'none'}.\nVerification: ${result?.verified ? 'passed' : result?.verification?.attempted ? 'did not pass' : 'not run'}.` }
      if (isViewingTaskChat()) {
        setAgentRun(finalizeRun)
        setMessages(previous => [...previous, resultMessage])
        if (result?.diagnostics) setRunDiagnostics(result.diagnostics)
      } else {
        const conv = memoryManager.conversations
        const stored = conv.getAgentState(taskChatId)
        conv.setAgentState(taskChatId, { agentRun: finalizeRun(stored?.agentRun || createAgentRun(task)) })
        writeToChat(taskChatId, previous => [...previous, resultMessage])
      }
    } catch (error) {
      if (isViewingTaskChat()) {
        setAgentRun(previous => previous ? { ...previous, status: error.name === 'AbortError' ? 'cancelled' : 'failed', summary: error.name === 'AbortError' ? 'Agent cancelled. Changes were rolled back for safety.' : error.message } : previous)
      } else {
        const conv = memoryManager.conversations
        const stored = conv.getAgentState(taskChatId)
        const base = stored?.agentRun || createAgentRun(task)
        conv.setAgentState(taskChatId, {
          agentRun: { ...base, status: error.name === 'AbortError' ? 'cancelled' : 'failed', summary: error.name === 'AbortError' ? 'Agent cancelled. Changes were rolled back for safety.' : error.message }
        })
      }
    } finally {
      agentAbortRef.current = null
      setIsLoading(false)
    }
  }, [activeFile, appendChatMessage, attachedFiles, autoApproveCommands, currentFolder, ensureProvider, includeActiveFile, includeOpenFiles, includeSelection, isLoading, messages, onAgentFileWrite, onAgentWorkspaceChange, openFiles, projectIndex, projectSummary, requestApproval, selectedCode, setMessages, writeToChat])

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
      const reviewRun = run => run ? { ...run, status: 'review', plan, summary: 'Review this implementation plan. You can edit it or add instructions before approving.' } : run
      if (isViewingTaskChat()) {
        setPlanDraft(plan)
        setAgentRun(reviewRun)
      } else {
        const conv = memoryManager.conversations
        const stored = conv.getAgentState(taskChatId)
        conv.setAgentState(taskChatId, { agentRun: reviewRun(stored?.agentRun || planningRun), planDraft: plan })
      }
      appendChatMessage(taskChatId, { role: 'assistant', content: `Implementation plan:\n${plan}` })
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
  }, [activeFile, appendChatMessage, attachedFiles, autoProceedPlan, currentFolder, ensureProvider, includeActiveFile, includeOpenFiles, includeSelection, input, isLoading, messages, openFiles, projectIndex, projectSummary, runApprovedAgentTask, selectedCode])

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
      setPlanRun({ task, content, status: 'complete' })
    } catch (error) {
      setPlanRun({ task, content: error.message, status: 'failed' })
    } finally {
      setIsLoading(false)
    }
  }, [activeFile, attachedFiles, currentFolder, ensureProvider, includeActiveFile, includeOpenFiles, includeSelection, input, isLoading, messages, openFiles, projectIndex, projectSummary, selectedCode])

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
    sendAgentTask(planOrTask)
  }, [sendAgentTask])

  const handleSubmit = useCallback(() => {
    if (input.trim() === '/skills' || input.trim() === '/skill create') {
      setShowSkills(true)
      setInput('')
      return
    }
    if (mode === 'agent') {
      if (agentRun?.status === 'review') {
        const feedback = input.trim()
        if (!feedback) return
        const revisedPlan = `${planDraft || agentRun.plan}\n\n## Reviewer additions\n${feedback}`
        setPlanDraft(revisedPlan)
        setAgentRun(previous => previous ? { ...previous, plan: revisedPlan, summary: 'Plan updated with your instructions. Review it, then choose Proceed.' } : previous)
        setMessages(previous => [...previous, { role: 'user', content: `Plan changes requested: ${feedback}` }])
        setInput('')
        return
      }
      return sendAgentTask()
    }
    return sendChat()
  }, [agentRun?.plan, agentRun?.status, input, mode, planDraft, sendAgentTask, sendChat, setMessages])

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

  const currentModeConfig = PRIMARY_MODES.find(m => m.id === mode) || PRIMARY_MODES[0]

  const modeHint = mode === 'agent'
    ? 'Describe a task for Prime AI (plans & executes)…'
    : 'Ask Prime AI anything (includes planning & explanations)…'

  return (
    <aside className={`prime-ai ${isDark ? 'prime-ai--dark' : 'prime-ai--light'}`} aria-label="Prime AI">
      <header className="prime-ai__header">
        <div className="prime-ai__brand">
          <Sparkles size={16} />
          <span>Prime AI</span>
          <span className="text-[10px] text-emerald-400 bg-emerald-950/60 border border-emerald-500/30 px-1.5 py-0.5 rounded ml-1 font-medium select-none" title="Prime Router local decision engine active">Ready</span>
          {chats.length > 0 && (
            <select
              className="prime-chat-selector flex-1 text-xs bg-black/40 border border-white/10 rounded px-1 py-0.5 ml-2 text-gray-300 max-w-[140px] truncate outline-none cursor-pointer"
              value={activeChatId || ''}
              onChange={e => handleSwitchChat(e.target.value)}
              title="Switch active chat session"
            >
              {chats.map(c => (
                <option key={c.id} value={c.id} className="bg-gray-900 text-gray-200">
                  {c.title || 'Untitled Chat'}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="prime-ai__header-actions">
          <button type="button" onClick={() => { setShowProjectMemory(!showProjectMemory); setShowChatHistory(false); }} title="Project Memory"><Database size={14} /></button>
          <button type="button" onClick={() => setShowSkills(true)} title="Skills"><BrainCircuit size={14} /></button>
          <button type="button" onClick={() => { setShowChatHistory(!showChatHistory); setShowProjectMemory(false); }} title="Chat History"><List size={14} /></button>
          <button type="button" onClick={handleNewChat} title="New Chat"><MessageSquarePlus size={14} /></button>
          {canUndoAgentEdit && <button type="button" onClick={onUndoAgentEdit} title="Undo last AI edit"><Undo2 size={14} /></button>}
          {canUndoAgentEdit && <button type="button" onClick={onUndoAgentTask} title="Undo last agent task"><History size={14} /></button>}
          <button type="button" onClick={clearHistory} title="Clear chat history"><Trash2 size={14} /></button>
          <button type="button" onClick={onOpenSettings} title="AI settings"><Settings size={14} /></button>
        </div>
      </header>
      <SkillsModal open={showSkills} onClose={() => setShowSkills(false)} workspaceId={currentFolder} onUse={slug => { setInput(`/skill ${slug} `); setShowSkills(false); inputRef.current?.focus() }} />

      <nav className="prime-ai__modes" aria-label="Prime AI mode">
        {PRIMARY_MODES.map(item => (
          <button
            key={item.id}
            type="button"
            className={mode === item.id ? 'is-active' : ''}
            onClick={() => setMode(item.id)}
            title={item.tooltip}
          >
            <item.icon size={13} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="prime-ai__context">
        <span><FileCode2 size={12} /> {activeFile?.name || 'No active file'}</span>
        <span>{projectIndex.length} indexed</span>
      </div>

      <main className="prime-ai__content" ref={scrollRef}>
        {showChatHistory && (
          <section className="prime-chat-history">
            <div className="prime-section-heading"><span>Recent Chats</span></div>
            {chats.map(chat => (
              <div key={chat.id} className={`prime-chat-item ${memoryManager.conversations.activeChatId === chat.id ? 'is-active' : ''}`} onClick={() => handleSwitchChat(chat.id)}>
                <div className="prime-chat-item__summary">
                  <div className="prime-chat-item__title-row">
                  <MessageSquare size={14} />
                  {editingChatId === chat.id
                    ? <input autoFocus value={chatTitleDraft} onClick={event => event.stopPropagation()} onChange={event => setChatTitleDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') saveChatTitle(event, chat.id); if (event.key === 'Escape') setEditingChatId(null) }} />
                    : <strong>{chat.title}</strong>}
                  </div>
                  <p>{getChatPreview(chat)}</p>
                </div>
                <div className="prime-chat-item__actions">
                  {editingChatId === chat.id ? <button type="button" onClick={(event) => saveChatTitle(event, chat.id)}><Check size={12}/></button> : <button type="button" onClick={(event) => beginRenameChat(event, chat)} title="Rename chat"><Pencil size={12}/></button>}
                  <button type="button" onClick={(e) => handleDeleteChat(e, chat.id)} title="Delete chat"><Trash2 size={12}/></button>
                </div>
              </div>
            ))}
          </section>
        )}

        {showProjectMemory && (
          <section className="prime-project-memory" style={{ padding: '16px' }}>
             <div className="prime-section-heading"><span>Project Memory</span></div>
             <p style={{ fontSize: '12px', color: '#888', marginBottom: '16px' }}>Facts Prime AI remembers about this workspace across chats.</p>
             {projectMemoryRecords.length === 0 && <span style={{ color: '#888' }}>No memory recorded yet.</span>}
             {Object.entries(projectMemoryRecords.reduce((acc, curr) => {
               if (!acc[curr.category]) acc[curr.category] = []
               acc[curr.category].push(curr)
               return acc
             }, {})).map(([category, records]) => (
               <div key={category} className="prime-memory-section" style={{ marginBottom: '16px' }}>
                 <strong style={{ display: 'block', marginBottom: '8px', textTransform: 'capitalize' }}>{category}</strong>
                 {records.map((item, i) => (
                   <div key={i} style={{ marginBottom: '8px', backgroundColor: '#111', padding: '8px', borderRadius: '4px' }}>
                     <div style={{ fontWeight: 600, fontSize: '13px' }}>{item.key}</div>
                     <div style={{ fontSize: '13px', color: '#ccc', margin: '4px 0' }}>{item.value}</div>
                     <div style={{ display: 'flex', gap: '8px', fontSize: '11px', color: '#666' }}>
                       <span>Source: {item.source}</span>
                       <span>Confidence: {item.confidence.toFixed(2)}</span>
                     </div>
                   </div>
                 ))}
               </div>
             ))}
          </section>
        )}

        {!showChatHistory && !showProjectMemory && mode === 'assistant' && (
          <section className="prime-chat-feed" aria-live="polite">
            {!messages.length && (
              <div className="prime-ai-empty">
                <Bot size={28} />
                <strong>Ask about your code</strong>
                <p>Prime AI provides plans, explanations, and code using your active file and selection context.</p>
                <div className="prime-chat-actions">
                  {CHAT_ACTIONS.map(action => <button key={action.id} type="button" onClick={() => sendChat(action.id)}><action.icon size={13} /> {action.label}</button>)}
                </div>
              </div>
            )}
            {messages.map(message => (
              <article className={`prime-chat-message prime-chat-message--${message.role} ${message.isError ? 'is-error' : ''}`} key={message.id || `${message.role}-${message.content.slice(0, 20)}`}>
                {message.role === 'user' && message.context && <span className="prime-chat-message__context">{message.context}</span>}
                {message.role === 'assistant' && message.thinking && (
                  <details className="prime-chat-message__thinking" style={{ fontSize: 10, opacity: 0.75, margin: '0 2px 6px' }}>
                    <summary style={{ cursor: 'pointer' }}>Reasoning</summary>
                    <p style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '4px 0 0' }}>{message.thinking}</p>
                  </details>
                )}
                <div className="prime-chat-message__body">
                  {message.role === 'assistant'
                    ? <MarkdownContent text={message.content} onApplyCode={onApplyCode} onCopy={copyToClipboard} copiedKey={copiedKey} />
                    : message.content}
                </div>
                {message.role === 'assistant' && message.content && !message.isError && (
                  <div className="flex items-center gap-2 mt-2 pt-1 border-t border-white/5">
                    <button type="button" className="prime-chat-message__copy" onClick={() => copyToClipboard(message.content, message.id || message.content)}>
                      {copiedKey === (message.id || message.content) ? <Check size={11} /> : <Copy size={11} />} Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => handleHandOffToAgent(message.content)}
                      className="px-2 py-1 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded text-xs flex items-center gap-1 font-semibold transition-all shadow-sm cursor-pointer"
                      title="Hand over this task to the Autonomous Agent to execute in the workspace"
                    >
                      <BrainCircuit size={13} />
                      Hand Over to Agent
                    </button>
                  </div>
                )}
              </article>
            ))}
            {isLoading && <div className="prime-loading-line"><Loader2 size={14} /> {isReasoning ? 'Reasoning…' : 'Thinking…'} <button type="button" onClick={cancelStreaming}>Cancel</button></div>}
            {!isLoading && lastChatRequest && <div className="prime-chat-retry"><button type="button" onClick={retryLastMessage}>Retry</button><button type="button" onClick={() => inputRef.current?.focus()}>Continue</button></div>}
          </section>
        )}

        {!showChatHistory && !showProjectMemory && mode === 'agent' && (
          <section className="prime-agent-session space-y-3">
            {messages.length > 0 && (
              <section className="prime-agent-transcript space-y-2" aria-label="Task transcript">
                {messages.map(message => (
                  <article className={`prime-chat-message prime-chat-message--${message.role} ${message.isError ? 'is-error' : ''}`} key={`agent-${message.id || `${message.role}-${message.content.slice(0, 20)}`}`}>
                    {message.role === 'user' && message.context && <span className="prime-chat-message__context">{message.context}</span>}
                    <div className="prime-chat-message__body">
                      {message.role === 'assistant'
                        ? <MarkdownContent text={message.content} onApplyCode={onApplyCode} onCopy={copyToClipboard} copiedKey={copiedKey} />
                        : message.content}
                    </div>
                  </article>
                ))}
              </section>
            )}

            {!agentRun ? (
              <div className="prime-ai-empty prime-ai-empty--agent">
                <BrainCircuit size={28} />
                <strong>Give Prime AI a coding task</strong>
                <p>It creates an execution plan, inspects the workspace, changes files directly, and verifies the result. Every edit remains inspectable and undoable.</p>
              </div>
            ) : (
              <div className="antigravity-trajectory-container space-y-2">
                {agentRun.plan && (
                  <PlanProgressBadge planTitle={agentRun.task ? `Task: ${agentRun.task.slice(0, 45)}…` : 'Implementation Plan'} commentCount={messages.length} />
                )}

                {agentRun.tools?.length > 0 && (
                  <WorkedBadge duration={`${Math.max(1, (agentRun.tools?.length || 0) * 4)}s`} tools={agentRun.tools || []} />
                )}

                {agentRun.changedFiles?.length > 0 && (
                  <FileChangesBadge count={agentRun.changedFiles.length} addLines={45} delLines={3} />
                )}

                {agentRun.status === 'complete' && (
                  <StepDivider label="Task execution & verification" />
                )}

                <section className="prime-agent-card">
                  <div className="prime-agent-card__heading"><strong>{agentRun.status === 'working' ? 'Working on it…' : agentRun.status === 'cancelled' ? 'Cancelled' : agentRun.status === 'failed' ? 'Needs attention' : 'Completed'}</strong>{agentRun.status === 'working' && <><Loader2 size={14} /><button type="button" onClick={cancelStreaming}>Cancel Agent</button></>}</div>
                  <div className="prime-agent-stages">
                    {AGENT_STAGES.map(stage => <AgentStage key={stage.id} stage={stage} state={agentRun.stages?.[stage.id]} />)}
                  </div>
                </section>

                {agentRun.plan && (
                  <section className="prime-agent-plan-card">
                    <div className="prime-section-heading">
                      <div><span>{agentRun.status === 'review' ? 'Implementation Plan — Review Required' : 'Approved Implementation Plan'}</span></div>
                    </div>
                    {agentRun.status === 'review'
                      ? <>
                          <textarea className="prime-plan-review-editor" value={planDraft} onChange={event => setPlanDraft(event.target.value)} aria-label="Implementation plan" />
                          <div className="prime-plan-review-actions">
                            <button type="button" onClick={() => { setAgentRun(previous => previous ? { ...previous, plan: planDraft, summary: 'Plan updated. Approve when you are ready to proceed.' } : previous); setMessages(previous => [...previous, { role: 'user', content: 'Edited the implementation plan.' }]) }}>Save plan edits</button>
                            <button type="button" className="is-primary" onClick={() => runApprovedAgentTask(agentRun.task, planDraft || agentRun.plan)} disabled={isLoading}>Proceed with plan <Play size={12} /></button>
                            <button type="button" onClick={() => { setAgentRun(null); setPlanDraft(''); setMessages(previous => [...previous, { role: 'user', content: 'Cancelled the proposed implementation plan.' }]) }}>Cancel</button>
                          </div>
                          <p className="prime-plan-review-hint">You can edit the plan directly, or add a note in the message box below. The agent will not edit files until you choose Proceed.</p>
                        </>
                      : <><div className="prime-agent-plan-body"><MarkdownContent text={agentRun.plan} onApplyCode={null} onCopy={copyToClipboard} copiedKey={copiedKey} /></div><ApprovedPlanChecklist plan={agentRun.plan} status={agentRun.status} todos={agentRun.todos} /></>}
                  </section>
                )}

                {agentRun.tools?.length > 0 && (
                  <section className="prime-tools-card mt-2">
                    <StreamingLog logs={agentRun.tools || []} status={agentRun.status} />
                  </section>
                )}

                {agentRun.summary && <section className={`prime-agent-summary ${agentRun.status === 'failed' ? 'is-error' : ''}`}>
                  <MarkdownContent text={agentRun.summary} onApplyCode={onApplyCode} onCopy={copyToClipboard} copiedKey={copiedKey} />
                  {agentRun.resumable && <button type="button" className="prime-agent-resume" onClick={() => runApprovedAgentTask(agentRun.task, agentRun.plan, true)} disabled={isLoading}><Play size={13} /> Continue from checkpoint</button>}
                  {runDiagnostics && (
                    <details style={{ marginTop: 8, fontSize: 10, opacity: 0.85 }}>
                      <summary style={{ cursor: 'pointer' }}>
                        Run diagnostics · {runDiagnostics.turns} turns · {Math.round((runDiagnostics.durationMs || 0) / 1000)}s · {runDiagnostics.model || 'unknown model'} · budget {runDiagnostics.gauges?.state || 'unknown'}
                      </summary>
                      <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                        {(runDiagnostics.gauges ? [runDiagnostics.gauges.requestContext, runDiagnostics.gauges.runInput, runDiagnostics.gauges.runOutput, runDiagnostics.gauges.runCost, runDiagnostics.gauges.runTurns] : [])
                          .filter(Boolean)
                          .map(gauge => (
                            <div key={gauge.dimension}>
                              {gauge.dimension}: {gauge.enabled === false
                                ? 'disabled (unknown)'
                                : `${Math.round(gauge.usage ?? 0)}/${Math.round(gauge.limit ?? 0)} (${Math.round((gauge.percent ?? 0) * 100)}%)`}
                            </div>
                          ))}
                        {Array.isArray(runDiagnostics.models) && runDiagnostics.models.length > 0 && (
                          <div>
                            Models: {runDiagnostics.models.map(m => `${m.model} calls=${m.calls} err=${m.errors || 0} timeouts=${m.timeouts || 0}${m.avgLatencyMs != null ? ` avg=${Math.round(m.avgLatencyMs)}ms` : ''}`).join(' · ')}
                          </div>
                        )}
                        {runDiagnostics.reason && runDiagnostics.reason !== 'completed' && (
                          <div>Outcome: {runDiagnostics.status} ({runDiagnostics.reason})</div>
                        )}
                        {Array.isArray(runDiagnostics.timeline) && runDiagnostics.timeline.length > 0 && (
                          <div>
                            Timeline (last {Math.min(runDiagnostics.timeline.length, 12)}):
                            {runDiagnostics.timeline.slice(-12).map(event => (
                              <div key={event.seq}>#{event.seq} {event.type}{event.model ? ` ${String(event.model).split('/').pop()}` : ''}{event.durationMs != null ? ` ${event.durationMs}ms` : ''}{event.dimension ? ` [${event.dimension}]` : ''}{event.category ? ` (${event.category})` : ''}</div>
                            ))}
                            {runDiagnostics.timelineDropped > 0 && <div>…{runDiagnostics.timelineDropped} older event(s) dropped from memory</div>}
                          </div>
                        )}
                      </div>
                    </details>
                  )}
                </section>}
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="prime-ai__composer">
        {pendingApproval && (
          <div className="prime-approval-card" role="alertdialog" aria-label="Agent approval requested">
            <div className="prime-approval-card__heading">
              <ShieldCheck size={14} />
              <strong>Agent needs approval</strong>
              <span>{pendingApproval.tool}</span>
            </div>
            <p className="prime-approval-card__reason">{pendingApproval.reason}</p>
            <pre className="prime-approval-card__args">{JSON.stringify(pendingApproval.args, null, 2)?.slice(0, 600)}</pre>
            <div className="prime-approval-card__actions">
              <button type="button" className="is-deny" onClick={() => resolveApproval(false)}>Deny</button>
              <button type="button" className="is-approve" onClick={() => resolveApproval(true)}><Check size={13} /> Approve &amp; run</button>
            </div>
          </div>
        )}
        {attachedFiles.length > 0 && (
          <div className="prime-attached-row" aria-label="Attached files">
            {attachedFiles.map(file => (
              <span className="prime-attached-chip" key={file.path} title={file.path}>
                <FileCode2 size={11} />
                <span>{file.name}</span>
                <button type="button" onClick={() => detachFile(file.path)} aria-label={`Remove ${file.name}`} title="Remove">
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="prime-composer">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={event => {
              setInput(event.target.value)
              event.target.style.height = 'auto'
              event.target.style.height = `${Math.min(event.target.scrollHeight, 112)}px`
            }}
            onKeyDown={handleKeyDown}
            placeholder={modeHint}
            disabled={isLoading}
          />
          <div className="prime-composer__toolbar">
            <button type="button" className={`prime-composer__approval ${autoApproveCommands ? 'is-active' : ''}`} onClick={() => setAutoApproveCommands(value => !value)} title={autoApproveCommands ? 'Approve for me: safe workspace commands run automatically; only destructive ones ask.' : 'Review commands: every shell command asks for approval before it runs.'}><ShieldCheck size={13} /> <span>{autoApproveCommands ? 'Approve for me' : 'Review commands'}</span></button>
            <button type="button" className="prime-composer__control" onClick={() => setShowComposerControls(value => !value)} aria-expanded={showComposerControls} title="Attach files and choose context"><Paperclip size={14} /></button>
            <select
              className="prime-composer__model"
              value={aiConfig?.model || ''}
              onChange={event => handleModelChange(event.target.value)}
              disabled={!aiConfig || modelsLoading}
              aria-label="Model"
              title={modelsError || (aiConfig ? `${modelOptions.length} models available with this key` : 'Model')}
            >
              {(modelOptions.length ? modelOptions : (aiConfig?.model ? [{ id: aiConfig.model, current: true }] : [])).map(option => (
                <option key={option.id} value={option.id}>
                  {option.current ? `● ${option.id} (current)` : option.id}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="prime-composer__control"
              onClick={() => aiConfig && loadModelOptions(aiConfig.provider, aiConfig.model, { force: true })}
              disabled={!aiConfig || modelsLoading}
              title={modelsLoading ? 'Checking your key…' : 'Re-check which models your key can use'}
              aria-label="Refresh models"
            >
              <RefreshCw size={13} className={modelsLoading ? 'prime-spin' : ''} />
            </button>
            <button type="button" className="prime-composer__context" onClick={() => setShowComposerControls(value => !value)} title="Context usage"><Gauge size={13} /> {Math.max(1, Math.round(estimatedContextTokens / 1000))}k / {Math.round(modelCapabilities.contextWindowTokens / 1000)}k</button>
            {isLoading
              ? <button type="button" className="prime-composer__stop" onClick={cancelStreaming} aria-label="Stop Prime AI" title="Stop"><Square size={12} fill="currentColor" /> <span>Stop</span></button>
              : <button type="button" className="prime-composer__send" onClick={handleSubmit} disabled={!input.trim()} aria-label="Send to Prime AI" title="Send"><Send size={16} /></button>}
          </div>
          {showComposerControls && (
            <div className="prime-composer__controls-panel">
              <strong>Context sources</strong>
              <label><input type="checkbox" checked={includeActiveFile} onChange={event => setIncludeActiveFile(event.target.checked)} /> Active file</label>
              <label><input type="checkbox" checked={includeSelection} onChange={event => setIncludeSelection(event.target.checked)} disabled={!selectedCode} /> Selection</label>
              <label><input type="checkbox" checked={includeOpenFiles} onChange={event => setIncludeOpenFiles(event.target.checked)} disabled={!openFiles.length} /> {openFiles.length} open files</label>
              <span>{includedFileCount} file{includedFileCount === 1 ? '' : 's'} included · {workspaceMemory.length} remembered tasks</span>
              <label title="When on, the agent starts implementing as soon as the plan is ready, without waiting for Proceed."><input type="checkbox" checked={autoProceedPlan} onChange={event => setAutoProceedPlan(event.target.checked)} /> Auto-proceed plans</label>
              <strong>Attach files</strong>
              {activeFile && !attachedFiles.some(file => file.path === activeFile.path) && (
                <button type="button" className="prime-attach-btn" onClick={() => attachFile({ path: activeFile.path, name: activeFile.name, content: activeFile.content })}>
                  <Paperclip size={12} /> Attach active file ({activeFile.name})
                </button>
              )}
              <input
                className="prime-attach-search"
                type="text"
                value={attachSearch}
                onChange={event => setAttachSearch(event.target.value)}
                placeholder="Search workspace files…"
                aria-label="Search workspace files to attach"
              />
              {attachSearchResults.map(file => (
                <button type="button" className="prime-attach-result" key={file.path} onClick={() => attachFile(file)} title={file.path}>
                  <FileCode2 size={12} /> <span>{relativePath(file.path, currentFolder) || file.name}</span>
                </button>
              ))}
              {attachSearch.trim() && !attachSearchResults.length && <span>No matching files.</span>}
              {attachedFiles.length > 0 && (
                <span>{attachedFiles.length} attached — click × on a chip to remove.</span>
              )}
            </div>
          )}
        </div>
        <p>{mode === 'agent' ? agentRun?.status === 'review' ? 'Add changes to the plan or choose Proceed when it is ready.' : 'Agent mode: plans first, then implements and verifies the approved plan.' : 'Assistant mode: uses the selected context and remembers this chat.'}{modelsError ? ` ${modelsError}` : ''}</p>
      </footer>
    </aside>
  )
}
