import React from 'react'
import {
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Check,
  X,
  AlertTriangle
} from 'lucide-react'

export const AgentApproval = React.memo(function AgentApproval({
  pendingApproval,
  onResolveApproval
}) {
  if (!pendingApproval) return null

  const isDestructive = Boolean(
    pendingApproval.isDestructive ||
    /rm|delete|drop|remove|destroy|unlink/i.test(pendingApproval.tool || '') ||
    /rm|del|rmdir|format/i.test(JSON.stringify(pendingApproval.args || ''))
  )

  const argsFormatted = typeof pendingApproval.args === 'string'
    ? pendingApproval.args
    : JSON.stringify(pendingApproval.args, null, 2)

  return (
    <div
      role="alertdialog"
      aria-label="Action requires approval"
      className={`flex flex-col gap-2.5 p-3.5 rounded-xl border shadow-lg agent-fade-in select-none ${
        isDestructive
          ? 'bg-rose-950/20 border-rose-500/40 text-rose-200 shadow-rose-950/20'
          : 'bg-amber-950/20 border-amber-500/40 text-amber-200 shadow-amber-950/20'
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        {isDestructive ? (
          <ShieldAlert size={16} className="text-rose-400 shrink-0" />
        ) : (
          <ShieldCheck size={16} className="text-amber-400 shrink-0" />
        )}
        <div className="flex flex-col">
          <span className="text-xs font-semibold uppercase tracking-wider">
            {isDestructive ? 'Destructive Action Requires Approval' : 'Action Requires Approval'}
          </span>
          <span className="text-[11px] font-mono text-[var(--agent-text)]">
            Tool: {pendingApproval.tool}
          </span>
        </div>
      </div>

      {/* Reason */}
      {pendingApproval.reason && (
        <p className="text-xs text-[var(--agent-text-secondary)] leading-relaxed">
          {pendingApproval.reason}
        </p>
      )}

      {/* Target Args / Command Snippet */}
      {argsFormatted && (
        <pre className="p-2 rounded bg-black/40 border border-white/5 font-mono text-[11px] text-[var(--agent-text)] max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
          {argsFormatted.slice(0, 1000)}
        </pre>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={() => onResolveApproval?.(false)}
          className="flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium bg-white/5 hover:bg-white/10 text-[var(--agent-text-secondary)] hover:text-white border border-white/10 transition-colors cursor-pointer"
        >
          <X size={12} />
          <span>Deny</span>
        </button>

        <button
          type="button"
          onClick={() => onResolveApproval?.(true)}
          className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium text-white shadow-sm transition-all cursor-pointer ${
            isDestructive
              ? 'bg-rose-600 hover:bg-rose-500'
              : 'bg-emerald-600 hover:bg-emerald-500'
          }`}
        >
          <Check size={12} />
          <span>{isDestructive ? 'Allow dangerous action' : 'Allow & Proceed'}</span>
        </button>
      </div>
    </div>
  )
})

