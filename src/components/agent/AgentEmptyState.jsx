import React from 'react'
import {
  Sparkles,
  Wrench,
  HelpCircle,
  FileCode2,
  Terminal,
  Layers,
  ArrowRight
} from 'lucide-react'

const SUGGESTIONS = [
  {
    id: 'fix',
    label: 'Fix this bug',
    icon: Wrench,
    prompt: 'Diagnose and fix the bug in this file.'
  },
  {
    id: 'explain',
    label: 'Explain this file',
    icon: HelpCircle,
    prompt: 'Explain the structure and responsibilities of this file.'
  },
  {
    id: 'refactor',
    label: 'Refactor this code',
    icon: Layers,
    prompt: 'Refactor this code for readability, type safety, and error handling.'
  },
  {
    id: 'test',
    label: 'Run tests & verify',
    icon: Terminal,
    prompt: 'Run the project tests and fix any failing test cases.'
  }
]

export const AgentEmptyState = React.memo(function AgentEmptyState({
  activeFileName,
  onSelectSuggestion
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center p-6 my-auto select-none max-w-sm mx-auto agent-fade-in">
      {/* Icon Emblem */}
      <div className="relative mb-3 flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-b from-cyan-500/20 to-indigo-500/10 border border-cyan-500/30 shadow-lg shadow-cyan-500/5">
        <Sparkles className="w-6 h-6 text-cyan-400" />
      </div>

      {/* Title & Description */}
      <h2 className="text-sm font-semibold text-[var(--agent-text)] mb-1">
        Prime AI Command Center
      </h2>
      <p className="text-xs text-[var(--agent-text-muted)] leading-relaxed mb-5 max-w-[280px]">
        Autonomous agent for inspecting codebase context, applying edits, and verifying results.
      </p>

      {/* Active File Context Pill */}
      {activeFileName && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 mb-5 rounded-full bg-[var(--agent-surface-elevated)] border border-[var(--agent-border)] text-[11px] text-[var(--agent-text-secondary)]">
          <FileCode2 size={12} className="text-cyan-400 shrink-0" />
          <span className="truncate max-w-[200px]">Active: {activeFileName}</span>
        </div>
      )}

      {/* Quick Action Suggestions */}
      <div className="w-full flex flex-col gap-1.5 text-left">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--agent-text-faint)] px-1">
          Quick Workflows
        </span>
        {SUGGESTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelectSuggestion?.(item.prompt)}
            className="group flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--agent-surface)] hover:bg-[var(--agent-surface-elevated)] border border-[var(--agent-border)] hover:border-[var(--agent-border-strong)] transition-all text-xs text-[var(--agent-text-secondary)] hover:text-[var(--agent-text)]"
          >
            <div className="flex items-center gap-2">
              <item.icon size={13} className="text-cyan-400/80 group-hover:text-cyan-400 shrink-0 transition-colors" />
              <span className="font-medium">{item.label}</span>
            </div>
            <ArrowRight size={12} className="opacity-0 group-hover:opacity-100 -translate-x-1 group-hover:translate-x-0 transition-all text-cyan-400" />
          </button>
        ))}
      </div>
    </div>
  )
})

