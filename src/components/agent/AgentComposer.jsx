import React, { useRef, useEffect } from 'react'
import {
  Send,
  Square,
  Paperclip,
  X,
  FileCode2,
  RefreshCw,
  Gauge,
  ShieldCheck,
  BrainCircuit,
  MessageSquare
} from 'lucide-react'

export function AgentComposer({
  input = '',
  onChangeInput,
  onSubmit,
  onKeyDown,
  onStop,
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
  placeholder = 'Ask Prime AI or give an autonomous task…'
}) {
  const textareaRef = useRef(null)

  // Auto-resize textarea up to 130px
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 130)}px`
  }, [input])

  const contextK = Math.max(1, Math.round(estimatedContextTokens / 1000))
  const maxK = Math.round(maxContextTokens / 1000)

  return (
    <footer className="flex flex-col border-t border-[var(--agent-border)] bg-[var(--agent-surface)] p-2.5 gap-2 select-none">
      {/* Attached Files Chips */}
      {attachedFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pb-1">
          {attachedFiles.map((file) => (
            <span
              key={file.path}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[var(--agent-surface-elevated)] border border-[var(--agent-border)] text-[11px] text-[var(--agent-text-secondary)]"
              title={file.path}
            >
              <FileCode2 size={11} className="text-cyan-400 shrink-0" />
              <span className="truncate max-w-[140px]">{file.name}</span>
              <button
                type="button"
                onClick={() => onDetachFile?.(file.path)}
                className="text-[var(--agent-text-muted)] hover:text-rose-400 transition-colors"
                aria-label={`Remove ${file.name}`}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Main Composer Box */}
      <div className="relative flex flex-col rounded-xl bg-[var(--agent-surface-elevated)] border border-[var(--agent-border)] focus-within:border-[var(--agent-border-strong)] transition-all shadow-sm min-w-0 max-w-full overflow-hidden">
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(e) => onChangeInput?.(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={isWorking ? 'Prime is executing…' : placeholder}
          disabled={isWorking}
          className="w-full bg-transparent px-3 py-2 text-xs text-[var(--agent-text)] placeholder-[var(--agent-text-muted)] outline-none resize-none min-h-[38px] max-h-[130px] font-sans"
        />

        {/* Composer Action Bar */}
        <div className="flex items-center justify-between px-2.5 py-1.5 border-t border-[var(--agent-border-subtle)] text-[11px] text-[var(--agent-text-muted)] flex-wrap gap-y-1.5 gap-x-2 min-w-0 max-w-full">
          {/* Left tools: Mode, Attachments, Command approval */}
          <div className="flex items-center gap-1.5 min-w-0 shrink-0">
            {/* Mode Toggle Button */}
            <button
              type="button"
              onClick={() => onChangeMode?.(mode === 'agent' ? 'assistant' : 'agent')}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                mode === 'agent'
                  ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30'
                  : 'bg-white/5 text-[var(--agent-text-secondary)] border border-white/10'
              }`}
              title={mode === 'agent' ? 'Autonomous Agent: plans, edits & verifies' : 'Assistant: conversational coding help'}
            >
              {mode === 'agent' ? <BrainCircuit size={11} /> : <MessageSquare size={11} />}
              <span>{mode === 'agent' ? 'Agent' : 'Chat'}</span>
            </button>

            {/* Context / Attachments Trigger */}
            <button
              type="button"
              onClick={onToggleComposerControls}
              className={`p-1 rounded hover:bg-white/5 transition-colors ${
                showComposerControls ? 'text-cyan-400' : 'text-[var(--agent-text-muted)]'
              }`}
              title="Configure context and file attachments"
              aria-label="Context and attachments"
            >
              <Paperclip size={13} />
            </button>

            {/* Auto-Approve Toggle */}
            <button
              type="button"
              onClick={() => setAutoApproveCommands?.(!autoApproveCommands)}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                autoApproveCommands
                  ? 'text-emerald-400 hover:bg-emerald-500/10'
                  : 'text-amber-400 hover:bg-amber-500/10'
              }`}
              title={autoApproveCommands ? 'Auto-approve safe commands' : 'Review all commands before running'}
            >
              <ShieldCheck size={11} />
              <span className="hidden sm:inline">{autoApproveCommands ? 'Auto' : 'Review'}</span>
            </button>
          </div>

          {/* Right tools: Model, Tokens, Send/Stop */}
          <div className="flex items-center gap-1.5 min-w-0 ml-auto shrink-0">
            {/* Model Select */}
            <div className="relative flex items-center min-w-0">
              <select
                value={aiConfig?.model || ''}
                onChange={(e) => onModelChange?.(e.target.value)}
                disabled={!aiConfig || modelsLoading}
                className="bg-transparent text-[11px] text-[var(--agent-text-secondary)] outline-none cursor-pointer max-w-[85px] sm:max-w-[120px] truncate pr-1 hover:text-[var(--agent-text)] transition-colors"
                title={modelsError || (aiConfig ? `${modelOptions.length} models available` : 'Select model')}
              >
                {(modelOptions.length ? modelOptions : (aiConfig?.model ? [{ id: aiConfig.model, current: true }] : [])).map((option) => (
                  <option key={option.id} value={option.id} className="bg-[#0e141f] text-gray-200">
                    {option.id}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={onRefreshModels}
                disabled={!aiConfig || modelsLoading}
                className="p-0.5 text-[var(--agent-text-muted)] hover:text-[var(--agent-text)] transition-colors ml-0.5"
                title="Refresh model list"
                aria-label="Refresh models"
              >
                <RefreshCw size={10} className={modelsLoading ? 'animate-spin' : ''} />
              </button>
            </div>

            {/* Token Gauge */}
            <div
              className="flex items-center gap-1 text-[10px] text-[var(--agent-text-faint)] font-mono"
              title="Estimated context tokens"
            >
              <Gauge size={11} />
              <span>{contextK}k/{maxK}k</span>
            </div>

            {/* Send or Stop Button */}
            {isWorking ? (
              <button
                type="button"
                onClick={onStop}
                className="flex items-center justify-center w-6 h-6 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 border border-rose-500/30 transition-all cursor-pointer"
                title="Stop agent run"
                aria-label="Stop agent"
              >
                <Square size={11} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onSubmit}
                disabled={!input.trim()}
                className={`flex items-center justify-center w-6 h-6 rounded-lg transition-all ${
                  input.trim()
                    ? 'bg-cyan-500 hover:bg-cyan-400 text-black shadow-sm shadow-cyan-500/20 cursor-pointer'
                    : 'bg-white/5 text-[var(--agent-text-faint)] cursor-not-allowed'
                }`}
                title="Send request (Enter)"
                aria-label="Send"
              >
                <Send size={12} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Expandable Context & Attachment Drawer */}
      {showComposerControls && (
        <div className="flex flex-col gap-2 p-2.5 rounded-lg bg-[var(--agent-surface-elevated)] border border-[var(--agent-border)] text-xs text-[var(--agent-text-secondary)] agent-fade-in">
          <div className="flex items-center justify-between font-semibold text-[11px] text-[var(--agent-text)]">
            <span>Context Inclusion</span>
            <span className="text-[10px] font-normal text-[var(--agent-text-muted)]">
              {openFilesCount} open tabs
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={includeActiveFile}
                onChange={(e) => setIncludeActiveFile?.(e.target.checked)}
                className="rounded accent-cyan-400"
              />
              <span>Active file</span>
            </label>
            <label className={`flex items-center gap-1.5 ${hasSelection ? 'cursor-pointer' : 'opacity-50'}`}>
              <input
                type="checkbox"
                checked={includeSelection}
                onChange={(e) => setIncludeSelection?.(e.target.checked)}
                disabled={!hasSelection}
                className="rounded accent-cyan-400"
              />
              <span>Selection</span>
            </label>
            <label className={`flex items-center gap-1.5 ${openFilesCount > 0 ? 'cursor-pointer' : 'opacity-50'}`}>
              <input
                type="checkbox"
                checked={includeOpenFiles}
                onChange={(e) => setIncludeOpenFiles?.(e.target.checked)}
                disabled={openFilesCount === 0}
                className="rounded accent-cyan-400"
              />
              <span>Open files</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer" title="Auto-proceed with plan without waiting for approval">
              <input
                type="checkbox"
                checked={autoProceedPlan}
                onChange={(e) => setAutoProceedPlan?.(e.target.checked)}
                className="rounded accent-cyan-400"
              />
              <span>Auto-proceed plan</span>
            </label>
          </div>

          {/* Quick Attach Active File */}
          {activeFileName && !attachedFiles.some((f) => f.name === activeFileName) && (
            <button
              type="button"
              onClick={onAttachActiveFile}
              className="flex items-center gap-1.5 py-1 px-2 rounded bg-white/5 hover:bg-white/10 text-[11px] text-cyan-400 font-medium transition-colors text-left"
            >
              <Paperclip size={11} />
              <span>Attach active file ({activeFileName})</span>
            </button>
          )}

          {/* Workspace Search Attachment */}
          <div className="flex flex-col gap-1 pt-1 border-t border-[var(--agent-border-subtle)]">
            <input
              type="text"
              value={attachSearch}
              onChange={(e) => setAttachSearch?.(e.target.value)}
              placeholder="Search project files to attach…"
              className="w-full bg-[var(--agent-surface)] border border-[var(--agent-border)] rounded px-2 py-1 text-[11px] text-[var(--agent-text)] placeholder-[var(--agent-text-muted)] outline-none"
            />
            {attachSearchResults.slice(0, 5).map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => onAttachFile?.(file)}
                className="flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-white/5 text-[11px] text-left truncate text-[var(--agent-text-secondary)] hover:text-[var(--agent-text)] transition-colors"
              >
                <FileCode2 size={11} className="shrink-0 text-cyan-400" />
                <span className="truncate">{file.name || file.path}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </footer>
  )
}
