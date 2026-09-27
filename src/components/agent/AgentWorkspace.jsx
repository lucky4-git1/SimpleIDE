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
import { AgentComposer } from './AgentComposer'
import { ArrowDown, Copy, Check, Play, BrainCircuit } from 'lucide-react'
import './agentTokens.css'

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
  onResolveApproval,
  lastChange = null,
  onReviewChanges,
  onRetry,
  onResume,
  onApplyCode
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
        <div key={key} className="my-2 rounded-lg bg-[var(--agent-surface-sunken)] border border-[var(--agent-border-subtle)] overflow-hidden font-mono text-[11px]">
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
          <pre className="p-2.5 overflow-x-auto text-[var(--agent-text-secondary)] leading-normal">
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
        className="flex-1 overflow-y-auto p-3 flex flex-col gap-3 relative"
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
              <div className="flex flex-col gap-2.5">
                {messages.map((message, idx) => (
                  <div
                    key={message.id || idx}
                    className={`flex flex-col p-2.5 rounded-xl text-xs ${
                      message.role === 'user'
                        ? 'bg-[var(--agent-surface-elevated)] border border-[var(--agent-border-subtle)] text-[var(--agent-text)] ml-4'
                        : 'bg-[var(--agent-surface)] border border-[var(--agent-border)] text-[var(--agent-text-secondary)] mr-2'
                    }`}
                  >
                    <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-[var(--agent-text-muted)] mb-1 select-none">
                      <span>{message.role === 'user' ? 'You' : 'Prime AI'}</span>
                      {message.context && (
                        <span className="font-mono text-[10px] opacity-75">{message.context}</span>
                      )}
                    </div>
                    <div>{renderMessageContent(message.content)}</div>
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
              />
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

            {/* Execution Summary / Completion Card */}
            {viewModel.summary && viewModel.state !== 'failed' && (
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
