import React, { useState } from 'react'
import {
  FileCode2,
  Eye,
  ChevronDown,
  ChevronUp,
  FileCheck2
} from 'lucide-react'

export function AgentChanges({
  changedFiles = [],
  lastChange = null,
  onReview
}) {
  const [showDiff, setShowDiff] = useState(false)
  if (!changedFiles.length && !lastChange) return null

  const fileCount = changedFiles.length || (lastChange ? 1 : 0)

  return (
    <div className="flex flex-col gap-2 p-3 rounded-xl bg-[var(--agent-surface)] border border-[var(--agent-border)] shadow-sm agent-fade-in select-none">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileCheck2 size={14} className="text-cyan-400 shrink-0" />
          <div className="flex items-center gap-1.5 text-xs">
            <strong className="text-[var(--agent-text)] font-semibold">
              {fileCount} {fileCount === 1 ? 'file' : 'files'} modified
            </strong>
          </div>
        </div>

        {lastChange && (
          <button
            type="button"
            onClick={() => {
              if (onReview) onReview(lastChange)
              else setShowDiff(!showDiff)
            }}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-white/5 hover:bg-white/10 text-[var(--agent-text)] border border-white/10 transition-colors cursor-pointer"
          >
            <Eye size={12} />
            <span>Review</span>
            {showDiff ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
        )}
      </div>

      {/* File tags */}
      {changedFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {changedFiles.map((file, idx) => (
            <span
              key={idx}
              className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--agent-surface-elevated)] border border-[var(--agent-border-subtle)] text-[11px] font-mono text-[var(--agent-text-secondary)] truncate max-w-[200px]"
              title={file}
            >
              <FileCode2 size={11} className="text-cyan-400/80 shrink-0" />
              <span className="truncate">{file.split(/[/\\]/).pop()}</span>
            </span>
          ))}
        </div>
      )}

      {/* Inline Diff Preview if toggled */}
      {showDiff && lastChange && (
        <div className="mt-2 p-2 rounded-lg bg-[var(--agent-surface-sunken)] border border-[var(--agent-border-subtle)] font-mono text-[11px] agent-fade-in">
          <div className="text-[10px] text-[var(--agent-text-muted)] mb-1 pb-1 border-b border-white/5 truncate">
            {lastChange.path}
          </div>
          <div className="max-h-40 overflow-y-auto space-y-0.5">
            {lastChange.before && (
              <div className="text-rose-400 bg-rose-950/20 px-1 py-0.5 rounded line-through">
                - {lastChange.before.slice(0, 300)}
              </div>
            )}
            {lastChange.after && (
              <div className="text-emerald-400 bg-emerald-950/20 px-1 py-0.5 rounded">
                + {lastChange.after.slice(0, 300)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
