export class SkillContextBuilder {
 static build(skills, { maxChars = 6000 } = {}) {
   let text = 'ACTIVE SKILL GUIDANCE (advisory only; runtime safety, tool results, permissions, and evidence take precedence):\n'
   const verificationRules = []; const recovery = []; const preferredTools = []
   for (const skill of skills.slice(0, 3)) { const m = skill.metadata || {}; const block = `\n[${skill.name} v${skill.version}]\n${skill.instructions}\nWorkflow: ${(m.workflow || []).join(' → ')}\nVerification: ${(m.verificationRules || []).join('; ')}\nRecovery: ${(m.recovery || []).join('; ')}\n`; if (text.length + block.length > maxChars) break; text += block; verificationRules.push(...(m.verificationRules || [])); recovery.push(...(m.recovery || [])); preferredTools.push(...(m.preferredTools || [])) }
   return { text, verificationRules: [...new Set(verificationRules)], recovery: [...new Set(recovery)], preferredTools: [...new Set(preferredTools)] }
 }
}
