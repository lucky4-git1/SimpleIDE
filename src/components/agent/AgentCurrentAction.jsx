import React from 'react'
import {
  Loader2,
  Terminal,
  FileCode2,
  Search,
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  BrainCircuit
} from 'lucide-react'

export const AgentCurrentAction = React.memo(function AgentCurrentAction({ currentAction }) {
  if (!currentAction) return null

  const getActionIcon = () => {
    switch (currentAction.type) {
      case 'verify':
        return <Terminal size={14} className="text-amber-400" />
      case 'edit':
        return <FileCode2 size={14} className="text-emerald-400" />
      case 'inspect':
        return <Search size={14} className="text-cyan-400" />
      case 'approval':
        return <ShieldCheck size={14} className="text-rose-400" />
      case 'planning':
        return <BrainCircuit size={14} className="text-indigo-400" />
      default:
        return <Loader2 size={14} className="text-cyan-400 animate-spin" />
    }
  }

  return (
    <div className="flex flex-col gap-1.5 p-3 rounded-xl bg-gradient-to-r from-[var(--agent-surface-elevated)] to-[var(--agent-surface)] border border-cyan-500/30 shadow-sm agent-fade-in select-none">
      <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-cyan-400">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
          <span>CURRENT ACTION</span>
        </div>
        <Loader2 size={11} className="animate-spin text-cyan-400" />
      </div>

      <div className="flex items-start gap-2.5 mt-0.5">
        <div className="mt-0.5 shrink-0 flex items-center justify-center w-6 h-6 rounded-md bg-white/5 border border-white/10">
          {getActionIcon()}
        </div>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-xs font-semibold text-[var(--agent-text)] leading-snug break-words">
            {currentAction.title}
          </span>
          {currentAction.detail && (
            <span className="text-[11px] text-[var(--agent-text-muted)] font-mono truncate mt-0.5" title={currentAction.detail}>
              {currentAction.detail}
            </span>
          )}
        </div>
      </div>
    </div>
  )
})

