import { BUILTIN_SKILLS } from './builtins.js'
import { SkillValidator } from './SkillValidator.js'
import { SkillSelector } from './SkillSelector.js'
import { SkillContextBuilder } from './SkillContextBuilder.js'
export class SkillRegistry {
 constructor({ database = null, scoring } = {}) { this.database = database; this.selector = new SkillSelector({ scoring }); this.builtins = BUILTIN_SKILLS.map(s => SkillValidator.validate(s, { builtin: true })); this.cache = null }
 async list(workspaceId = null) { const custom = this.database ? await this.database.listSkills({ workspaceId }) : []; return [...this.builtins, ...custom] }
 async resolve(request, { workspaceId, explicitSlugs = [], capabilities = [] } = {}) { const skills = await this.list(workspaceId); const usageStats = this.database ? await this.database.getSkillUsageStats() : {}; const result = this.selector.select(skills, { request, workspaceId, explicitSlugs, capabilities, usageStats }); return { ...result, context: SkillContextBuilder.build(result.selected) } }
}
