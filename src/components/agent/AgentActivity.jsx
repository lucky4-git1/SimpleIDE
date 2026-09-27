import React, { useState } from 'react'
import {
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Terminal,
  FileCode2,
  Search,
  BrainCircuit,
  Wrench,
  Copy,
  Check
} from 'lucide-react'

export function AgentActivity({ activity }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  if (!activity) return null

  const isWorking = activity.status === 'working'
  const isFailed = activity.status === 'failed'

  const getCategoryIcon = () => {
    switch (activity.category) {
      case 'verify':
        return <Terminal size={12} className="text-amber-400" />
      case 'edit':
        return <FileCode2 size={12} className="text-emerald-400" />
      case 'inspect':
        return <Search size={12} className="text-cyan-400" />
      case 'skill':
        return <BrainCircuit size={12} className="text-indigo-400" />
      default:
        return <Wrench size={12} className="text-[var(--agent-text-muted)]" />
    }
  }

  const copyDetail = async (e) => {
    e.stopPropagation()
    if (!activity.detail) return
    await navigator.clipboard?.writeText(activity.detail)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="flex flex-col rounded-lg bg-[var(--agent-surface)] border border-[var(--agent-border)] overflow-hidden transition-all text-xs">
      <button
        type="button"
        onClick={() => activity.detail && setIsExpanded(!isExpanded)}
        className={`flex items-center justify-between p-2.5 hover:bg-[var(--agent-surface-hover)] transition-colors text-left w-full select-none ${
          activity.detail ? 'cursor-pointer' : 'cursor-default'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {activity.detail ? (
            <ChevronRight
              size={13}
              className={`text-[var(--agent-text-muted)] shrink-0 transition-transform duration-150 ${
                isExpanded ? 'rotate-90' : ''
              }`}
            />
          ) : (
            <div className="w-3" />
          )}

          <div className="shrink-0">{getCategoryIcon()}</div>

          <span className="font-medium text-[var(--agent-text)] truncate">
            {activity.title}
          </span>
        </div>

        <div className="shrink-0 flex items-center gap-2 ml-2">
          {activity.duration && (
            <span className="text-[10px] text-[var(--agent-text-faint)] font-mono">
              {activity.duration}
            </span>
          )}

          {isWorking ? (
            <Loader2 size={13} className="text-cyan-400 animate-spin" />
          ) : isFailed ? (
            <AlertTriangle size={13} className="text-rose-400" />
          ) : (
            <CheckCircle2 size={13} className="text-emerald-400" />
          )}
        </div>
      </button>

      {/* Expandable Detail View */}
      {isExpanded && activity.detail && (
        <div className="px-3 py-2 border-t border-[var(--agent-border-subtle)] bg-[var(--agent-surface-elevated)] flex flex-col gap-1.5 agent-fade-in">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-[var(--agent-text-muted)] font-semibold">
            <span>Activity Output</span>
            <button
              type="button"
              onClick={copyDetail}
              className="flex items-center gap-1 text-[var(--agent-text-secondary)] hover:text-[var(--agent-text)] transition-colors cursor-pointer"
              title="Copy output"
            >
              {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <pre className="font-mono text-[11px] text-[var(--agent-text-secondary)] bg-[var(--agent-surface-sunken)] p-2 rounded border border-[var(--agent-border-subtle)] max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
            {activity.detail.slice(0, 3000)}
            {activity.detail.length > 3000 && (
              <span className="text-[var(--agent-text-faint)] block mt-1">
                ...[{activity.detail.length - 3000} characters truncated]
              </span>
            )}
          </pre>
        </div>
      )}
    </div>
  )
}
