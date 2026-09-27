import React, { useState } from 'react'
import {
  CheckCircle2,
  CircleDot,
  Circle,
  AlertTriangle,
  Play,
  X,
  Edit3,
  ListTodo
} from 'lucide-react'

export const AgentPlan = React.memo(function AgentPlan({
  planSteps = [],
  rawPlan = '',
  status = 'working',
  isReview = false,
  isLoading = false,
  planDraft = '',
  onChangePlanDraft,
  onProceedPlan,
  onCancelPlan,
  onSavePlanEdits
}) {
  const [isEditingDraft, setIsEditingDraft] = useState(false)

  if (!planSteps.length && !rawPlan && !isReview) return null

  const getStepIcon = (stepStatus) => {
    switch (stepStatus) {
      case 'completed':
        return <CheckCircle2 size={13} className="text-emerald-400 shrink-0" />
      case 'active':
        return <CircleDot size={13} className="text-cyan-400 shrink-0 animate-pulse" />
      case 'blocked':
        return <AlertTriangle size={13} className="text-rose-400 shrink-0" />
      default:
        return <Circle size={13} className="text-[var(--agent-text-faint)] shrink-0" />
    }
  }

  // Interactive Plan Review Mode (Agent waiting for user approval of implementation plan)
  if (isReview) {
    return (
      <div className="flex flex-col gap-2.5 p-3 rounded-xl bg-[var(--agent-surface)] border border-indigo-500/40 shadow-sm agent-fade-in select-none">
        <div className="flex items-center justify-between text-xs font-semibold text-indigo-400">
          <div className="flex items-center gap-1.5">
            <ListTodo size={14} />
            <span>Implementation Plan — Review Required</span>
          </div>
          <button
            type="button"
            onClick={() => setIsEditingDraft(!isEditingDraft)}
            className="flex items-center gap-1 text-[11px] text-[var(--agent-text-muted)] hover:text-[var(--agent-text)] transition-colors cursor-pointer"
          >
            <Edit3 size={11} />
            <span>{isEditingDraft ? 'Preview' : 'Edit Plan'}</span>
          </button>
        </div>

        {isEditingDraft ? (
          <textarea
            value={planDraft || rawPlan}
            onChange={(e) => onChangePlanDraft?.(e.target.value)}
            className="w-full bg-[var(--agent-surface-sunken)] p-2.5 rounded-lg border border-[var(--agent-border)] text-xs font-mono text-[var(--agent-text)] outline-none min-h-[140px] resize-y"
            placeholder="Edit implementation plan steps…"
          />
        ) : (
          <div className="flex flex-col gap-1.5 py-1">
            {planSteps.map((step, idx) => (
              <div key={step.id || idx} className="flex items-start gap-2 text-xs">
                <div className="mt-0.5">{getStepIcon(step.status)}</div>
                <span className="text-[var(--agent-text-secondary)] leading-tight">{step.text}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-[var(--agent-border-subtle)]">
          <button
            type="button"
            onClick={onCancelPlan}
            className="px-2.5 py-1 rounded text-xs text-[var(--agent-text-muted)] hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer"
          >
            Cancel
          </button>

          <div className="flex items-center gap-2">
            {isEditingDraft && (
              <button
                type="button"
                onClick={() => {
                  onSavePlanEdits?.()
                  setIsEditingDraft(false)
                }}
                className="px-2.5 py-1 rounded text-xs font-medium bg-white/10 hover:bg-white/15 text-[var(--agent-text)] transition-colors cursor-pointer"
              >
                Save edits
              </button>
            )}
            <button
              type="button"
              onClick={onProceedPlan}
              disabled={isLoading}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white shadow-sm transition-all cursor-pointer"
            >
              <span>Proceed with plan</span>
              <Play size={11} fill="currentColor" />
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Active / Completed Plan Progress View
  return (
    <div className="flex flex-col gap-2 p-3 rounded-xl bg-[var(--agent-surface)] border border-[var(--agent-border)] shadow-sm select-none">
      <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-[var(--agent-text-muted)]">
        <div className="flex items-center gap-1.5">
          <ListTodo size={12} className="text-cyan-400" />
          <span>Execution Plan</span>
        </div>
        <span className="font-mono text-[10px] text-[var(--agent-text-faint)]">
          {planSteps.filter((s) => s.status === 'completed').length}/{planSteps.length} done
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {planSteps.map((step, idx) => (
          <div
            key={step.id || idx}
            className={`flex items-start gap-2 text-xs transition-opacity ${
              step.status === 'completed' ? 'opacity-80' : step.status === 'active' ? 'opacity-100 font-medium' : 'opacity-60'
            }`}
          >
            <div className="mt-0.5">{getStepIcon(step.status)}</div>
            <span
              className={`leading-snug break-words ${
                step.status === 'completed'
                  ? 'text-[var(--agent-text-muted)] line-through'
                  : step.status === 'active'
                  ? 'text-[var(--agent-text)]'
                  : 'text-[var(--agent-text-secondary)]'
              }`}
            >
              {step.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
})

