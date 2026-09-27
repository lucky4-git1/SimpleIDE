export const DEFAULT_SKILL_SCORING = Object.freeze({ explicit: 1000, trigger: 100, workspace: 50, tag: 60, capability: 25, historicalSuccess: 20, maxActive: 3 })
const words = text => new Set(String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) || [])
export class SkillSelector {
  constructor({ scoring = DEFAULT_SKILL_SCORING } = {}) { this.scoring = { ...DEFAULT_SKILL_SCORING, ...scoring } }
  select(skills, { request = '', workspaceId = null, explicitSlugs = [], capabilities = [], usageStats = {} } = {}) {
    const terms = words(request); const explicit = new Set(explicitSlugs.map(s => s.toLowerCase()))
    const ranked = skills.filter(s => s.enabled !== false && (s.scope !== 'WORKSPACE' || s.workspace_id === workspaceId || s.workspaceId === workspaceId)).map(skill => {
      const meta = typeof skill.metadata_json === 'string' ? JSON.parse(skill.metadata_json || '{}') : (skill.metadata || {})
      let score = 0; const reasons = []
      if (explicit.has(skill.slug)) { score += this.scoring.explicit; reasons.push('explicit') }
      const matches = values => (values || []).some(x => terms.has(String(x).toLowerCase()) || String(request).toLowerCase().includes(String(x).toLowerCase()))
      if (matches(meta.triggers)) { score += this.scoring.trigger; reasons.push('trigger') }
      if (skill.scope === 'WORKSPACE' && (skill.workspace_id || skill.workspaceId) === workspaceId) { score += this.scoring.workspace; reasons.push('workspace') }
      if (matches(meta.tags)) { score += this.scoring.tag; reasons.push('tag') }
      if ((meta.capabilities || []).some(c => capabilities.includes(c))) { score += this.scoring.capability; reasons.push('capability') }
      if ((usageStats[skill.id]?.successRate || 0) >= .8) { score += this.scoring.historicalSuccess; reasons.push('history') }
      return { ...skill, metadata: meta, score, reasons, selectionSource: explicit.has(skill.slug) ? 'EXPLICIT' : 'AUTOMATIC' }
    }).filter(s => s.score > 0 || explicit.has(s.slug)).sort((a,b) => b.score - a.score || a.slug.localeCompare(b.slug))
    const selected = []; const conflicts = []
    for (const candidate of ranked) {
      const collision = selected.find(active => (candidate.metadata.conflictsWith || []).includes(active.slug) || (active.metadata.conflictsWith || []).includes(candidate.slug))
      if (collision) { conflicts.push({ type: 'SKILL_CONFLICT', skills: [collision.slug, candidate.slug] }); continue }
      if (selected.length < this.scoring.maxActive) selected.push(candidate)
    }
    return { selected, conflicts, ranked }
  }
}
