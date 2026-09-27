import React from 'react'
import {
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Terminal,
  ShieldCheck
} from 'lucide-react'

export function AgentVerification({
  verification,
  isWorking = false
}) {
  if (!verification || (!verification.attempted && !isWorking)) return null

  const isPassed = verification.passed
  const isFailed = verification.failed
  const isRunning = isWorking && !isPassed && !isFailed

  return (
    <div
      className={`flex flex-col gap-2 p-3 rounded-xl border shadow-sm agent-fade-in select-none ${
        isPassed
          ? 'bg-emerald-950/15 border-emerald-500/30'
          : isFailed
          ? 'bg-rose-950/15 border-rose-500/30'
          : 'bg-cyan-950/15 border-cyan-500/30'
      }`}
    >
      <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider">
        <div className="flex items-center gap-1.5">
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

        {isRunning && <Loader2 size={11} className="text-cyan-400 animate-spin" />}
      </div>

      <div className="flex items-center gap-2 text-xs">
        {isPassed ? (
          <CheckCircle2 size={15} className="text-emerald-400 shrink-0" />
        ) : isFailed ? (
          <AlertTriangle size={15} className="text-rose-400 shrink-0" />
        ) : (
          <Loader2 size={15} className="text-cyan-400 animate-spin shrink-0" />
        )}

        <div className="flex flex-col min-w-0">
          <span className="font-semibold text-[var(--agent-text)]">
            {isPassed
              ? 'Verification passed'
              : isFailed
              ? 'Verification check failed'
              : 'Running verification checks…'}
          </span>
          {verification.detail && (
            <span className="text-[11px] text-[var(--agent-text-secondary)] mt-0.5 truncate">
              {verification.detail}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
