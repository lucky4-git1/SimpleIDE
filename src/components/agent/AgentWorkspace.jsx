import React, { useRef, useEffect, useState } from 'react'
import { AgentHeader } from './AgentHeader'
import { AgentEmptyState } from './AgentEmptyState'
import { AgentCurrentAction } from './AgentCurrentAction'
import { AgentPlan } from './AgentPlan'
import { AgentTimeline } from './AgentTimeline'
import { AgentApproval } from './AgentApproval'
import { AgentVerification } from './AgentVerification'
import { AgentChanges } from './AgentChanges'
import { AgentSummary } from './AgentSummary'
import { AgentError } from './AgentError'
import {
  ArrowDown,
  Copy,
  Check,
  Play,
  BrainCircuit,
  Bot,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertTriangle,
  Eye,
  Loader2,
  Wrench,
  Sparkles
} from 'lucide-react'
import './agentTokens.css'

function ThinkingDisclosure({ thinking, isWorking }) {
  const [expanded, setExpanded] = useState(false)
  if (!thinking && !isWorking) return null

  return (
    <div className="my-1.5 rounded-lg border border-purple-500/20 bg-purple-950/20 overflow-hidden text-xs max-w-full">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] text-purple-300 hover:text-purple-200 hover:bg-purple-500/10 transition-colors cursor-pointer select-none"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <BrainCircuit size={12} className={isWorking ? 'animate-pulse text-purple-400 shrink-0' : 'text-purple-400 shrink-0'} />
          <span className="truncate">{isWorking ? 'Thinking…' : 'Reasoning trace'}</span>
        </div>
        <ChevronDown size={12} className={`transition-transform duration-200 shrink-0 ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && thinking && (
        <div className="p-2.5 border-t border-purple-500/15 font-mono text-[10.5px] text-purple-200/80 whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed select-text bg-black/25 break-words">
          {thinking}
        </div>
      )}
    </div>
  )
}

function MessageToolsView({ tools = [], onReviewChanges }) {
  const [expanded, setExpanded] = useState(true)
  if (!tools || tools.length === 0) return null

  const completedCount = tools.filter(t => t.status === 'complete').length
  const failedCount = tools.filter(t => t.status === 'failed').length
  const workingCount = tools.filter(t => t.status === 'working').length

  return (
    <div className="my-2 rounded-xl border border-[var(--agent-border-subtle)] bg-[var(--agent-surface-sunken)] overflow-hidden text-xs">
      <div
        onClick={() => setExpanded(v => !v)}
        className="flex items-center justify-between px-2.5 py-1.5 bg-white/5 border-b border-white/5 cursor-pointer select-none hover:bg-white/10 transition-colors"
      >
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--agent-text-secondary)]">
          <Wrench size={12} className="text-cyan-400 shrink-0" />
          <span>
            Tool actions ({completedCount}/{tools.length})
          </span>
          {workingCount > 0 && (
            <Loader2 size={10} className="animate-spin text-cyan-400 shrink-0 ml-1" />
          )}
          {failedCount > 0 && (
            <span className="text-rose-400 text-[10px] font-mono ml-1">({failedCount} failed)</span>
          )}
        </div>
        <ChevronDown size={12} className={`text-[var(--agent-text-muted)] transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
      </div>

      {expanded && (
        <div className="p-2 flex flex-col gap-1.5 max-h-60 overflow-y-auto">
          {tools.map((tool, idx) => {
            const isComplete = tool.status === 'complete'
            const isFailed = tool.status === 'failed'
            const isToolWorking = tool.status === 'working'

            const isWriteOrEdit = tool.type === 'write_file' || tool.type === 'edit_file' || (tool.action && (tool.action.type === 'write_file' || tool.action.type === 'edit_file'))

            return (
              <div
                key={tool.id || idx}
                className={`flex flex-col p-1.5 rounded-lg border text-[11px] ${
                  isComplete
                    ? 'bg-emerald-950/20 border-emerald-800/30 text-emerald-200'
                    : isFailed
                    ? 'bg-rose-950/20 border-rose-800/30 text-rose-200'
                    : 'bg-blue-950/20 border-blue-800/30 text-blue-200'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 truncate">
                    {isToolWorking ? (
                      <Loader2 size={11} className="animate-spin text-blue-400 shrink-0" />
                    ) : isComplete ? (
                      <CheckCircle2 size={11} className="text-emerald-400 shrink-0" />
                    ) : (
                      <AlertTriangle size={11} className="text-rose-400 shrink-0" />
                    )}
                    <span className="font-medium truncate">{tool.label || tool.type}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {isWriteOrEdit && onReviewChanges && tool.action && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onReviewChanges({ path: tool.action.path, before: tool.action.before, after: tool.action.after })
                        }}
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30 text-[10px] transition-colors cursor-pointer"
                        title="Inspect Diff in Monaco"
                      >
                        <Eye size={10} />
                        <span>Diff</span>
                      </button>
                    )}
                    <span className="text-[9.5px] uppercase font-mono opacity-60">
                      {tool.status}
                    </span>
                  </div>
                </div>
                {tool.detail && (
                  <pre className="mt-1 p-1 rounded bg-black/30 font-mono text-[9.5px] text-[var(--agent-text-muted)] max-h-20 overflow-y-auto whitespace-pre-wrap select-text leading-tight">
                    {tool.detail}
                  </pre>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function AgentWorkspace({
  viewModel,
  messages = [],
  input = '',
  onChangeInput,
  onSubmit,
  onKeyDown,
  onCancel,
  isWorking = false,
  mode = 'agent',
  onChangeMode,
  aiConfig = null,
  modelOptions = [],
  modelsLoading = false,
  modelsError = '',
  onModelChange,
  onRefreshModels,
  estimatedContextTokens = 0,
  maxContextTokens = 128000,
  attachedFiles = [],
  onDetachFile,
  showComposerControls = false,
  onToggleComposerControls,
  includeActiveFile = true,
  setIncludeActiveFile,
  includeSelection = true,
  setIncludeSelection,
  hasSelection = false,
  includeOpenFiles = true,
  setIncludeOpenFiles,
  openFilesCount = 0,
  autoApproveCommands = true,
  setAutoApproveCommands,
  autoProceedPlan = false,
  setAutoProceedPlan,
  activeFileName = '',
  onAttachActiveFile,
  attachSearch = '',
  setAttachSearch,
  attachSearchResults = [],
  onAttachFile,
  chats = [],
  activeChatId = null,
  onSwitchChat,
  onNewChat,
  onOpenSettings,
  onOpenSkills,
  onToggleMemory,
  onToggleHistory,
  onClearHistory,
  onUndoEdit,
  canUndo = false,
  planDraft = '',
  onChangePlanDraft,
  onProceedPlan,
  onCancelPlan,
  onSavePlanEdits,
  onOpenPlanInEditor,
  onResolveApproval,
  lastChange = null,
  onReviewChanges,
  onRetry,
  onResume,
  onApplyCode,
  onHandOffToAgent
}) {
  const scrollRef = useRef(null)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const [copiedKey, setCopiedKey] = useState(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  // Timer for active runs
  useEffect(() => {
    let timer = null
    if (isWorking) {
      const startTime = Date.now()
      timer = setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000))
      }, 1000)
    } else {
      setElapsedSeconds(0)
    }
    return () => clearInterval(timer)
  }, [isWorking])

  // Intelligent auto-scroll: sticks to bottom if user hasn't scrolled up
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight
      setShowScrollBottom(false)
    }
  }, [messages, viewModel.activityGroups.length, viewModel.summary, viewModel.currentAction])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const isUp = el.scrollHeight - el.scrollTop - el.clientHeight >= 120
    setShowScrollBottom(isUp)
  }

  const scrollToBottom = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setShowScrollBottom(false)
  }

  const copySnippet = async (text, key) => {
    await navigator.clipboard?.writeText(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1500)
  }

  // Format message text with clean code blocks
  const renderMessageContent = (content) => {
    if (!content) return null
    const parts = String(content).split(/(```[\s\S]*?```)/g)

    return parts.map((part, index) => {
      if (!part.startsWith('```')) {
        return (
          <span key={index} className="whitespace-pre-wrap leading-relaxed">
            {part}
          </span>
        )
      }

      const lines = part.split('\n')
      const language = lines[0].replace('```', '').trim() || 'code'
      const code = lines.slice(1, -1).join('\n')
      const key = `code-${index}-${code.length}`

      return (
        <div key={key} className="my-2 rounded-lg bg-[var(--agent-surface-sunken)] border border-[var(--agent-border-subtle)] overflow-hidden font-mono text-[11px] max-w-full">
          <div className="flex items-center justify-between px-2.5 py-1 bg-white/5 border-b border-white/5 text-[10px] text-[var(--agent-text-muted)] select-none">
            <span>{language}</span>
            <div className="flex items-center gap-1">
              {onApplyCode && (
                <button
                  type="button"
                  onClick={() => onApplyCode(code)}
                  className="flex items-center gap-1 hover:text-[var(--agent-text)] transition-colors cursor-pointer px-1 py-0.5"
                >
                  <Play size={10} />
                  <span>Apply</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => copySnippet(code, key)}
                className="hover:text-[var(--agent-text)] transition-colors cursor-pointer p-0.5"
                title="Copy code"
              >
                {copiedKey === key ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
              </button>
            </div>
          </div>
          <pre className="p-2.5 overflow-x-auto text-[var(--agent-text-secondary)] leading-normal max-w-full">
            {code}
          </pre>
        </div>
      )
    })
  }

  return (
    <div className="flex flex-col h-full w-full bg-[var(--agent-bg)] text-[var(--agent-text)] select-text relative overflow-hidden font-sans">
      {/* Header */}
      <AgentHeader
        taskTitle={viewModel.taskTitle}
        state={viewModel.state}
        isWorking={isWorking}
        elapsedSeconds={elapsedSeconds}
        chats={chats}
        activeChatId={activeChatId}
        onSwitchChat={onSwitchChat}
        onNewChat={onNewChat}
        onCancel={onCancel}
        onOpenSettings={onOpenSettings}
        onOpenSkills={onOpenSkills}
        onToggleMemory={onToggleMemory}
        onToggleHistory={onToggleHistory}
        onClearHistory={onClearHistory}
        onUndoEdit={onUndoEdit}
        canUndo={canUndo}
      />

      {/* Workspace Feed */}
      <main
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-3 flex flex-col gap-3 relative min-w-0 max-w-full overflow-x-hidden"
      >
        {!viewModel.hasRun ? (
          <AgentEmptyState
            activeFileName={activeFileName}
            onSelectSuggestion={(prompt) => {
              onChangeInput?.(prompt)
              onSubmit?.()
            }}
          />
        ) : (
          <>
            {/* Conversation Transcript (User requests & Assistant explanations) */}
            {messages.length > 0 && (
              <div className="flex flex-col gap-2.5 min-w-0 max-w-full">
                {messages.map((message, idx) => (
                  <div
                    key={message.id || idx}
                    className={`flex flex-col p-2.5 rounded-xl text-xs min-w-0 max-w-full overflow-hidden break-words ${
                      message.role === 'user'
                        ? 'bg-[var(--agent-surface-elevated)] border border-[var(--agent-border-subtle)] text-[var(--agent-text)] ml-4'
                        : 'bg-[var(--agent-surface)] border border-[var(--agent-border)] text-[var(--agent-text-secondary)] mr-2'
                    }`}
                  >
                    <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-[var(--agent-text-muted)] mb-1 select-none">
                      <div className="flex items-center gap-1.5">
                        <span>{message.role === 'user' ? 'You' : 'Prime AI'}</span>
                        {message.isWorking && (
                          <span className="flex items-center gap-1 text-[9px] text-cyan-400 font-mono lowercase">
                            <Loader2 size={9} className="animate-spin" />
                            working
                          </span>
                        )}
                      </div>
                      {message.context && (
                        <span className="font-mono text-[10px] opacity-75">{message.context}</span>
                      )}
                    </div>
                    {message.role === 'assistant' && (
                      <ThinkingDisclosure thinking={message.thinking} isWorking={message.isWorking} />
                    )}
                    {message.role === 'assistant' && message.tools && message.tools.length > 0 && (
                      <MessageToolsView tools={message.tools} onReviewChanges={onReviewChanges} />
                    )}
                    <div className="break-words min-w-0">{renderMessageContent(message.content)}</div>
                    {message.role === 'assistant' && /(?:hand\s*(?:it\s*)?over\s+to\s+(?:the\s+)?(?:autonomous\s+)?agent|ready\s+to\s+hand\s+over|switch\s+to\s+(?:the\s+)?(?:autonomous\s+)?agent|hand-off\s+confirmation|hand over this job)/i.test(String(message.content || '')) && (
                      <div className="mt-3 pt-2.5 border-t border-[var(--agent-border-subtle)] flex items-center justify-between gap-3 bg-indigo-500/10 p-2.5 rounded-lg border border-indigo-500/25 agent-fade-in">
                        <div className="flex items-center gap-2 text-indigo-300 text-xs font-medium min-w-0">
                          <Bot size={15} className="text-indigo-400 shrink-0" />
                          <span className="truncate">Autonomous Agent is ready to execute</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            let taskPrompt = ''
                            for (let i = idx - 1; i >= 0; i--) {
                              if (messages[i]?.role === 'user' && messages[i]?.content) {
                                taskPrompt = messages[i].content
                                break
                              }
                            }
                            if (!taskPrompt) taskPrompt = message.content
                            onHandOffToAgent?.(taskPrompt)
                          }}
                          disabled={isWorking}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs shadow-md transition-colors cursor-pointer shrink-0 disabled:opacity-50"
                        >
                          <span>Hand over to Agent</span>
                          <ArrowRight size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Structured Plan View */}
            {(viewModel.planSteps.length > 0 || viewModel.isReview) && (
              <AgentPlan
                planSteps={viewModel.planSteps}
                rawPlan={viewModel.planRaw}
                status={viewModel.state}
                isReview={viewModel.isReview}
                isLoading={isWorking}
                planDraft={planDraft}
                onChangePlanDraft={onChangePlanDraft}
                onProceedPlan={onProceedPlan}
                onCancelPlan={onCancelPlan}
                onSavePlanEdits={onSavePlanEdits}
                onOpenInEditor={onOpenPlanInEditor}
              />
            )}

            {/* Review Proceed Callout */}
            {viewModel.isReview && (
              <div className="flex items-center justify-between p-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-xs text-indigo-300 gap-2 min-w-0 max-w-full">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse shrink-0" />
                  <span className="truncate">Plan ready in editor. Click Proceed to begin work.</span>
                </div>
                <button
                  type="button"
                  onClick={onProceedPlan}
                  disabled={isWorking}
                  className="flex items-center gap-1 px-2.5 py-1 rounded bg-indigo-500 hover:bg-indigo-400 text-white font-medium transition-colors shrink-0 cursor-pointer"
                >
                  <span>Proceed</span>
                  <Play size={10} fill="currentColor" />
                </button>
              </div>
            )}

            {/* Dominant Current Action Banner */}
            {viewModel.currentAction && (
              <AgentCurrentAction currentAction={viewModel.currentAction} />
            )}

            {/* Interactive Approval Gate */}
            {viewModel.pendingApproval && (
              <AgentApproval
                pendingApproval={viewModel.pendingApproval}
                onResolveApproval={onResolveApproval}
              />
            )}

            {/* Compact Activity Timeline */}
            {viewModel.activityGroups.length > 0 && (
              <AgentTimeline
                activityGroups={viewModel.activityGroups}
                isWorking={isWorking}
              />
            )}

            {/* Verification Results */}
            {viewModel.verification?.attempted && (
              <AgentVerification
                verification={viewModel.verification}
                isWorking={isWorking}
              />
            )}

            {/* Code Modifications Summary */}
            {(viewModel.changedFiles.length > 0 || lastChange) && (
              <AgentChanges
                changedFiles={viewModel.changedFiles}
                lastChange={lastChange}
                onReview={onReviewChanges}
              />
            )}

            {/* Execution Summary / Completion Card (Only when task actually completed) */}
            {(viewModel.isComplete || (viewModel.summary && (viewModel.state === 'complete' || viewModel.state === 'completed'))) && (
              <AgentSummary
                summary={viewModel.summary}
                status={viewModel.state}
                changedFiles={viewModel.changedFiles}
                verification={viewModel.verification}
                resumable={viewModel.resumable}
                onResume={onResume}
                diagnostics={viewModel.diagnostics}
                isLoading={isWorking}
              />
            )}

            {/* Structured Error Card */}
            {(viewModel.state === 'failed' || viewModel.state === 'cancelled') && (
              <AgentError
                summary={viewModel.summary}
                status={viewModel.state}
                onRetry={onRetry}
              />
            )}
          </>
        )}

        {/* Scroll-to-bottom Floating Chip */}
        {showScrollBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="sticky bottom-2 mx-auto flex items-center gap-1.5 px-3 py-1 rounded-full bg-cyan-500 text-black font-medium text-xs shadow-lg hover:bg-cyan-400 transition-all z-20 cursor-pointer agent-fade-in"
          >
            <ArrowDown size={12} />
            <span>Latest activity</span>
          </button>
        )}
      </main>

      {/* Modern Composer */}
      <AgentComposer
        input={input}
        onChangeInput={onChangeInput}
        onSubmit={onSubmit}
        onKeyDown={onKeyDown}
        onStop={onCancel}
        isWorking={isWorking}
        mode={mode}
        onChangeMode={onChangeMode}
        aiConfig={aiConfig}
        modelOptions={modelOptions}
        modelsLoading={modelsLoading}
        modelsError={modelsError}
        onModelChange={onModelChange}
        onRefreshModels={onRefreshModels}
        estimatedContextTokens={estimatedContextTokens}
        maxContextTokens={maxContextTokens}
        attachedFiles={attachedFiles}
        onDetachFile={onDetachFile}
        showComposerControls={showComposerControls}
        onToggleComposerControls={onToggleComposerControls}
        includeActiveFile={includeActiveFile}
        setIncludeActiveFile={setIncludeActiveFile}
        includeSelection={includeSelection}
        setIncludeSelection={setIncludeSelection}
        hasSelection={hasSelection}
        includeOpenFiles={includeOpenFiles}
        setIncludeOpenFiles={setIncludeOpenFiles}
        openFilesCount={openFilesCount}
        autoApproveCommands={autoApproveCommands}
        setAutoApproveCommands={setAutoApproveCommands}
        autoProceedPlan={autoProceedPlan}
        setAutoProceedPlan={setAutoProceedPlan}
        activeFileName={activeFileName}
        onAttachActiveFile={onAttachActiveFile}
        attachSearch={attachSearch}
        setAttachSearch={setAttachSearch}
        attachSearchResults={attachSearchResults}
        onAttachFile={onAttachFile}
      />
    </div>
  )
}
