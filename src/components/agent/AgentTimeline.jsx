import React from 'react'
import { AgentActivityGroup } from './AgentActivityGroup'
import { AgentActivity } from './AgentActivity'
import { Loader2, Activity } from 'lucide-react'

export function AgentTimeline({
  activityGroups = [],
  isWorking = false
}) {
  if (!activityGroups.length && !isWorking) return null

  return (
    <div className="flex flex-col gap-2 select-none">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--agent-text-muted)] flex items-center gap-1.5">
          <Activity size={12} className="text-cyan-400" />
          <span>Activity Timeline</span>
        </span>
        {activityGroups.length > 0 && (
          <span className="text-[10px] font-mono text-[var(--agent-text-faint)]">
            {activityGroups.length} {activityGroups.length === 1 ? 'event' : 'events'}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        {activityGroups.map((group) => {
          if (group.type === 'inspect_group' || group.type === 'edit_group') {
            return <AgentActivityGroup key={group.id} group={group} />
          }
          return <AgentActivity key={group.id} activity={group} />
        })}

        {activityGroups.length === 0 && isWorking && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--agent-surface)] border border-[var(--agent-border)] text-xs text-[var(--agent-text-muted)]">
            <Loader2 size={13} className="text-cyan-400 animate-spin" />
            <span>Scanning project context and tools…</span>
          </div>
        )}
      </div>
    </div>
  )
}
