import React, { useState } from 'react'
import {
  AlertTriangle,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  XCircle
} from 'lucide-react'

export const AgentError = React.memo(function AgentError({
  summary = '',
  status = 'failed',
  onRetry
}) {
  const [showDetail, setShowDetail] = useState(false)
  if (status !== 'failed' && status !== 'cancelled') return null

  const isCancelled = status === 'cancelled'

  return (
    <div
      role="alert"
      className={`flex flex-col gap-2.5 p-3 rounded-xl border shadow-sm agent-fade-in select-none ${
        isCancelled
          ? 'bg-zinc-900/40 border-zinc-700/50 text-zinc-300'
          : 'bg-rose-950/20 border-rose-500/40 text-rose-200'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isCancelled ? (
            <XCircle size={15} className="text-zinc-400 shrink-0" />
          ) : (
            <AlertTriangle size={15} className="text-rose-400 shrink-0" />
          )}
          <span className="text-xs font-semibold uppercase tracking-wider">
            {isCancelled ? 'Task Cancelled' : 'Task Failed'}
          </span>
        </div>

        {onRetry && !isCancelled && (
          <button
            type="button"
            onClick={onRetry}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/30 transition-colors cursor-pointer"
          >
            <RotateCcw size={11} />
            <span>Retry</span>
          </button>
        )}
      </div>

      {summary && (
        <p className="text-xs text-[var(--agent-text-secondary)] leading-relaxed">
          {summary}
        </p>
      )}
    </div>
  )
})

