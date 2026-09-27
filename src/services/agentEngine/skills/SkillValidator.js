const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SCOPES = new Set(['BUILTIN', 'GLOBAL_USER', 'WORKSPACE'])
export class SkillValidator {
  static validate(input, { builtin = false } = {}) {
    const skill = { ...input, metadata: input.metadata || input.metadata_json || {} }
    if (!String(skill.name || '').trim()) throw new Error('Skill name is required')
    if (!SLUG.test(String(skill.slug || ''))) throw new Error('Skill slug must use lowercase letters, numbers, and hyphens')
    if (!SCOPES.has(skill.scope || (builtin ? 'BUILTIN' : 'GLOBAL_USER'))) throw new Error('Invalid skill scope')
    if ((skill.scope === 'WORKSPACE') && !skill.workspace_id && !skill.workspaceId) throw new Error('Workspace skills require a workspace id')
    if (!String(skill.instructions || '').trim()) throw new Error('Skill instructions are required')
    const metadata = typeof skill.metadata === 'string' ? JSON.parse(skill.metadata) : skill.metadata
    for (const field of ['triggers', 'tags', 'capabilities', 'preferredTools', 'verificationRules', 'recovery', 'conflictsWith']) {
      if (metadata[field] != null && !Array.isArray(metadata[field])) throw new Error(`Skill metadata.${field} must be an array`)
    }
    return { ...skill, name: skill.name.trim(), slug: skill.slug.trim(), metadata }
  }
}
