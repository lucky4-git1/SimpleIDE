import React, { useState } from 'react'
import {
  CheckCircle2,
  FileCode2,
  Play,
  Activity,
  Layers,
  ChevronDown,
  ChevronUp
} from 'lucide-react'

export const AgentSummary = React.memo(function AgentSummary({
  summary = '',
  status = 'complete',
  changedFiles = [],
  verification = null,
  resumable = false,
  onResume,
  diagnostics = null,
  isLoading = false
}) {
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  if (!summary && status !== 'complete') return null

  const isComplete = status === 'complete' || status === 'completed'

  return (
    <div className="flex flex-col gap-2.5 p-3 rounded-xl bg-gradient-to-b from-[var(--agent-surface)] to-[var(--agent-surface-elevated)] border border-[var(--agent-border)] shadow-sm agent-fade-in select-none">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
          <CheckCircle2 size={15} />
          <span>Task Completed</span>
        </div>

        {diagnostics && (
          <span className="text-[10px] text-[var(--agent-text-faint)] font-mono">
            {diagnostics.turns} turns · {Math.round((diagnostics.durationMs || 0) / 1000)}s
          </span>
        )}
      </div>

      {/* Summary Text */}
      {summary && (
        <div className="text-xs text-[var(--agent-text-secondary)] leading-relaxed whitespace-pre-wrap">
          {summary}
        </div>
      )}

      {/* Metrics Row */}
      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-[var(--agent-border-subtle)] text-[11px] text-[var(--agent-text-muted)]">
        {changedFiles.length > 0 && (
          <span className="flex items-center gap-1">
            <FileCode2 size={12} className="text-cyan-400" />
            <span>{changedFiles.length} {changedFiles.length === 1 ? 'file' : 'files'} changed</span>
          </span>
        )}

        {verification?.passed && (
          <span className="flex items-center gap-1 text-emerald-400">
            <CheckCircle2 size={12} />
            <span>Verification passed</span>
          </span>
        )}

        {resumable && (
          <button
            type="button"
            onClick={onResume}
            disabled={isLoading}
            className="flex items-center gap-1 ml-auto px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/25 transition-colors cursor-pointer"
          >
            <Play size={10} fill="currentColor" />
            <span>Continue from checkpoint</span>
          </button>
        )}
      </div>

      {/* Diagnostics Toggle */}
      {diagnostics && (
        <div className="pt-1">
          <button
            type="button"
            onClick={() => setShowDiagnostics(!showDiagnostics)}
            className="flex items-center gap-1 text-[10px] text-[var(--agent-text-faint)] hover:text-[var(--agent-text-muted)] transition-colors cursor-pointer"
          >
            <Activity size={10} />
            <span>Execution Diagnostics</span>
            {showDiagnostics ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </button>

          {showDiagnostics && (
            <div className="mt-1.5 p-2 rounded bg-[var(--agent-surface-sunken)] border border-[var(--agent-border-subtle)] text-[10px] font-mono text-[var(--agent-text-muted)] flex flex-col gap-1 agent-fade-in">
              <div>Model: {diagnostics.model || 'Auto-routed'}</div>
              <div>Budget state: {diagnostics.gauges?.state || 'Normal'}</div>
              {Array.isArray(diagnostics.models) && diagnostics.models.length > 0 && (
                <div>
                  Calls: {diagnostics.models.map(m => `${m.model} (${m.calls})`).join(', ')}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

