import React from 'react'
import {
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Terminal,
  ShieldCheck
} from 'lucide-react'

export const AgentVerification = React.memo(function AgentVerification({
  verification,
  isWorking = false
}) {
  if (!verification || (!verification.attempted && !isWorking)) return null

  const isPassed = Boolean(verification.passed || verification.success)
  const isFailed = Boolean(verification.failed || (verification.attempted && !isPassed && !isWorking))
  const isRunning = isWorking && !isPassed && !isFailed

  const detailText = typeof verification.detail === 'string'
    ? verification.detail
    : (verification.detail ? String(verification.detail.message || JSON.stringify(verification.detail)) : '')

  const command = typeof verification.command === 'string' ? verification.command : ''
  const output = typeof verification.output === 'string' ? verification.output : (typeof verification.stdout === 'string' ? verification.stdout : '')

  return (
    <div
      className={`flex flex-col gap-2 p-3 rounded-xl border shadow-sm agent-fade-in select-none min-w-0 max-w-full overflow-hidden ${
        isPassed
          ? 'bg-emerald-950/15 border-emerald-500/30'
          : isFailed
          ? 'bg-rose-950/15 border-rose-500/30'
          : 'bg-cyan-950/15 border-cyan-500/30'
      }`}
    >
      <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <ShieldCheck
            size={13}
            className={
              isPassed
                ? 'text-emerald-400'
                : isFailed
                ? 'text-rose-400'
                : 'text-cyan-400'
            }
          />
          <span
            className={
              isPassed
                ? 'text-emerald-400'
                : isFailed
                ? 'text-rose-400'
                : 'text-cyan-400'
            }
          >
            Verification Check
          </span>
        </div>

        {isRunning && <Loader2 size={11} className="text-cyan-400 animate-spin shrink-0" />}
      </div>

      <div className="flex items-start gap-2 text-xs min-w-0">
        <div className="mt-0.5 shrink-0">
          {isPassed ? (
            <CheckCircle2 size={15} className="text-emerald-400" />
          ) : isFailed ? (
            <AlertTriangle size={15} className="text-rose-400" />
          ) : (
            <Loader2 size={15} className="text-cyan-400 animate-spin" />
          )}
        </div>

        <div className="flex flex-col min-w-0 flex-1">
          <span className="font-semibold text-[var(--agent-text)]">
            {isPassed
              ? 'Verification passed'
              : isFailed
              ? 'Verification check failed'
              : 'Running verification checks…'}
          </span>
          {command && (
            <div className="flex items-center gap-1 text-[11px] text-[var(--agent-text-muted)] font-mono mt-0.5 truncate">
              <Terminal size={10} className="shrink-0" />
              <span className="truncate">{command}</span>
            </div>
          )}
          {detailText && (
            <span className="text-[11px] text-[var(--agent-text-secondary)] mt-0.5 break-words">
              {detailText}
            </span>
          )}
          {isFailed && output && (
            <pre className="mt-1.5 p-2 rounded bg-black/40 border border-rose-500/20 text-[10px] font-mono text-rose-300 max-h-24 overflow-y-auto whitespace-pre-wrap break-all select-text">
              {output.slice(0, 1000)}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
})

