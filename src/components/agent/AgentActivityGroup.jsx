import React, { useState } from 'react'
import {
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Search,
  FileCode2,
  FileText
} from 'lucide-react'

export function AgentActivityGroup({ group }) {
  const [isExpanded, setIsExpanded] = useState(false)
  if (!group) return null

  const isInspect = group.type === 'inspect_group'
  const isWorking = group.status === 'working'
  const isFailed = group.status === 'failed'

  const GroupIcon = isInspect ? Search : FileCode2

  return (
    <div className="flex flex-col rounded-lg bg-[var(--agent-surface)] border border-[var(--agent-border)] overflow-hidden transition-all text-xs">
      {/* Header Row */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center justify-between p-2.5 hover:bg-[var(--agent-surface-hover)] transition-colors text-left w-full cursor-pointer select-none"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <ChevronRight
            size={13}
            className={`text-[var(--agent-text-muted)] shrink-0 transition-transform duration-150 ${
              isExpanded ? 'rotate-90' : ''
            }`}
          />
          <div className="shrink-0 text-[var(--agent-text-secondary)]">
            <GroupIcon size={13} />
          </div>
          <span className="font-medium text-[var(--agent-text)] truncate">
            {group.title}
          </span>
          <span className="text-[10px] text-[var(--agent-text-muted)] font-mono shrink-0">
            ({group.fileCount} file{group.fileCount === 1 ? '' : 's'})
          </span>
        </div>

        <div className="shrink-0 flex items-center gap-1.5 ml-2">
          {isWorking ? (
            <Loader2 size={13} className="text-cyan-400 animate-spin" />
          ) : isFailed ? (
            <AlertTriangle size={13} className="text-rose-400" />
          ) : (
            <CheckCircle2 size={13} className="text-emerald-400" />
          )}
        </div>
      </button>

      {/* Expanded File List */}
      {isExpanded && group.fileList?.length > 0 && (
        <div className="px-3 py-2 border-t border-[var(--agent-border-subtle)] bg-[var(--agent-surface-elevated)] flex flex-col gap-1 font-mono text-[11px] text-[var(--agent-text-muted)] agent-fade-in">
          {group.fileList.map((file, idx) => (
            <div key={idx} className="flex items-center gap-2 truncate">
              <FileText size={11} className="shrink-0 text-cyan-400/70" />
              <span className="truncate text-[var(--agent-text-secondary)]" title={file}>
                {file}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
