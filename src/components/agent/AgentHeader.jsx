import React from 'react'
import {
  Sparkles,
  Plus,
  Settings,
  BrainCircuit,
  Database,
  History,
  Trash2,
  Undo2,
  ChevronDown
} from 'lucide-react'

export const AgentHeader = React.memo(function AgentHeader({
  taskTitle = 'Prime AI',
  state = 'idle',
  isWorking = false,
  elapsedSeconds = 0,
  chats = [],
  activeChatId = null,
  onSwitchChat,
  onNewChat,
  onCancel,
  onOpenSettings,
  onOpenSkills,
  onToggleMemory,
  onToggleHistory,
  onClearHistory,
  onUndoEdit,
  canUndo = false
}) {
  const formatTime = (seconds) => {
    if (!seconds) return '0s'
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
  }

  const renderStatusBadge = () => {
    switch (state) {
      case 'running':
      case 'planning':
        return (
          <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium leading-none bg-cyan-500/10 text-cyan-400 border border-cyan-500/25 shrink-0">
            <span className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse" />
            <span>{state === 'planning' ? 'Plan' : 'Run'}</span>
            {elapsedSeconds > 0 && <span className="opacity-70 font-mono text-[9px]">· {formatTime(elapsedSeconds)}</span>}
          </div>
        )
      case 'waiting_approval':
        return (
          <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium leading-none bg-amber-500/10 text-amber-400 border border-amber-500/25 shrink-0">
            <span className="w-1 h-1 rounded-full bg-amber-400" />
            <span>Approval</span>
          </div>
        )
      case 'review':
        return (
          <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium leading-none bg-indigo-500/10 text-indigo-400 border border-indigo-500/25 shrink-0">
            <span className="w-1 h-1 rounded-full bg-indigo-400" />
            <span>Review</span>
          </div>
        )
      case 'completed':
        return (
          <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium leading-none bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 shrink-0">
            <span className="w-1 h-1 rounded-full bg-emerald-400" />
            <span>Done</span>
          </div>
        )
      case 'failed':
        return (
          <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium leading-none bg-rose-500/10 text-rose-400 border border-rose-500/25 shrink-0">
            <span className="w-1 h-1 rounded-full bg-rose-400" />
            <span>Failed</span>
          </div>
        )
      case 'cancelled':
        return (
          <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium leading-none bg-zinc-500/10 text-zinc-400 border border-zinc-500/25 shrink-0">
            <span>Cancelled</span>
          </div>
        )
      default:
        return (
          <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium leading-none bg-white/5 text-zinc-400 border border-white/10 shrink-0">
            <span className="w-1 h-1 rounded-full bg-emerald-400/80" />
            <span>Ready</span>
          </div>
        )
    }
  }

  return (
    <header className="flex flex-col gap-1.5 px-3 py-2 border-b border-[var(--agent-border)] bg-[var(--agent-surface)] select-none overflow-hidden shrink-0">
      <div className="flex items-center justify-between gap-1.5 min-w-0">
        {/* Brand & Task Title */}
        <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
          <div className="flex items-center justify-center w-5 h-5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shrink-0">
            <Sparkles size={12} />
          </div>
          <span className="text-xs font-semibold text-[var(--agent-text)] truncate" title={taskTitle}>
            {taskTitle}
          </span>
          {renderStatusBadge()}
        </div>

        {/* Global Actions */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={onNewChat}
            className="p-1.5 rounded text-[var(--agent-text-muted)] hover:text-[var(--agent-text)] hover:bg-[var(--agent-surface-hover)] transition-colors"
            title="New task / chat"
            aria-label="New task"
          >
            <Plus size={14} />
          </button>

          {canUndo && (
            <button
              type="button"
              onClick={onUndoEdit}
              className="p-1.5 rounded text-[var(--agent-text-muted)] hover:text-[var(--agent-text)] hover:bg-[var(--agent-surface-hover)] transition-colors"
              title="Undo last agent modification"
              aria-label="Undo edit"
            >
              <Undo2 size={15} />
            </button>
          )}

          <button
            type="button"
            onClick={onToggleHistory}
            className="p-1.5 rounded text-[var(--agent-text-muted)] hover:text-[var(--agent-text)] hover:bg-[var(--agent-surface-hover)] transition-colors"
            title="Task History"
            aria-label="History"
          >
            <History size={15} />
          </button>

          <button
            type="button"
            onClick={onOpenSkills}
            className="p-1.5 rounded text-[var(--agent-text-muted)] hover:text-[var(--agent-text)] hover:bg-[var(--agent-surface-hover)] transition-colors"
            title="Agent Skills"
            aria-label="Skills"
          >
            <BrainCircuit size={15} />
          </button>

          <button
            type="button"
            onClick={onToggleMemory}
            className="p-1.5 rounded text-[var(--agent-text-muted)] hover:text-[var(--agent-text)] hover:bg-[var(--agent-surface-hover)] transition-colors"
            title="Workspace Memory"
            aria-label="Memory"
          >
            <Database size={15} />
          </button>

          <button
            type="button"
            onClick={onOpenSettings}
            className="p-1.5 rounded text-[var(--agent-text-muted)] hover:text-[var(--agent-text)] hover:bg-[var(--agent-surface-hover)] transition-colors"
            title="AI Settings"
            aria-label="Settings"
          >
            <Settings size={15} />
          </button>
        </div>
      </div>

      {/* Session Quick-Switch Row (when chats exist) */}
      {chats.length > 1 && (
        <div className="flex items-center gap-1.5 text-xs text-[var(--agent-text-muted)] pt-1 border-t border-[var(--agent-border-subtle)]">
          <span className="text-[11px] shrink-0 font-medium">Session:</span>
          <div className="relative flex-1 min-w-0">
            <select
              value={activeChatId || ''}
              onChange={(e) => onSwitchChat?.(e.target.value)}
              className="w-full bg-[var(--agent-surface-elevated)] border border-[var(--agent-border)] rounded px-2 py-0.5 text-[11px] text-[var(--agent-text-secondary)] outline-none cursor-pointer truncate appearance-none pr-5 hover:border-[var(--agent-border-strong)] transition-colors"
            >
              {chats.map((c) => (
                <option key={c.id} value={c.id} className="bg-[#0e141f] text-gray-200">
                  {c.title || 'Untitled task'}
                </option>
              ))}
            </select>
            <ChevronDown size={11} className="absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none opacity-60" />
          </div>
        </div>
      )}
    </header>
  )
})

