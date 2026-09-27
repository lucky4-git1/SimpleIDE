import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseManager } from '../electron/database/DatabaseManager.js'
import { SkillValidator } from '../src/services/agentEngine/skills/SkillValidator.js'
import { SkillSelector } from '../src/services/agentEngine/skills/SkillSelector.js'
import { SkillContextBuilder } from '../src/services/agentEngine/skills/SkillContextBuilder.js'

const dbFile = path.join(os.tmpdir(), `simple-ide-skills-${Date.now()}.db`); const db = new DatabaseManager(dbFile); db.initialize(); const a = db.getOrCreateWorkspace('/tmp/skills-a'); const b = db.getOrCreateWorkspace('/tmp/skills-b')
test.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(dbFile + suffix) } catch {} })
test('skill CRUD, workspace isolation, disable and immutable usage snapshot', () => {
 const created = db.createSkill(SkillValidator.validate({ name:'Three.js Expert',slug:'threejs-expert',description:'3D work',scope:'WORKSPACE',workspaceId:a.id,instructions:'Inspect WebGL support.',metadata:{ triggers:['three.js'], verificationRules:['render scene'] } }))
 assert.equal(db.listSkills({ workspaceId:a.id }).length, 1); assert.equal(db.listSkills({ workspaceId:b.id }).length, 0)
 const updated = db.updateSkill(created.id, { ...created, instructions:'Changed later.', metadata:{ triggers:['three.js'] } }); assert.equal(updated.version, 2)
 db.recordSkillUsage({ skillId:created.id, version:1, contentHash:'abc', snapshot:{ instructions:'Inspect WebGL support.' }, selectionSource:'EXPLICIT' }); db.deleteSkill(created.id)
 assert.equal(db.db.prepare('SELECT snapshot_json FROM skill_usage').get().snapshot_json.includes('Inspect WebGL'), true)
})
test('validation, deterministic explicit ranking, conflicts and bounded context', () => {
 assert.throws(() => SkillValidator.validate({ name:'x',slug:'Bad Slug',instructions:'x' }))
 const selector = new SkillSelector(); const skills = [
 { id:'f',slug:'frontend-development',name:'Frontend',scope:'BUILTIN',enabled:true,instructions:'f'.repeat(50),version:1,metadata:{triggers:['react'],conflictsWith:[]}},
 { id:'b',slug:'browser-qa',name:'Browser',scope:'BUILTIN',enabled:true,instructions:'b'.repeat(50),version:1,metadata:{triggers:['responsive'],conflictsWith:['frontend-development']}},
 { id:'t',slug:'testing',name:'Testing',scope:'BUILTIN',enabled:true,instructions:'t'.repeat(50),version:1,metadata:{triggers:['test'],conflictsWith:[]}},
 { id:'d',slug:'disabled',name:'Disabled',scope:'BUILTIN',enabled:false,instructions:'d',version:1,metadata:{triggers:['react']}}
 ]; const result = selector.select(skills,{request:'Build a responsive React page and test it',explicitSlugs:['testing']}); assert.equal(result.selected[0].slug,'testing'); assert.equal(result.selected.some(x=>x.slug==='disabled'),false); assert.equal(result.conflicts[0].type,'SKILL_CONFLICT'); assert.ok(SkillContextBuilder.build(result.selected,{maxChars:120}).text.length <= 200)
})
