import { ipcMain } from 'electron'
import { databaseManager } from '../../../electron/database/DatabaseManager.js'
import { SkillValidator } from '../../services/agentEngine/skills/SkillValidator.js'

const respond = fn => async (_, payload = {}) => { try { return { success: true, ...(await fn(payload)) } } catch (error) { return { success: false, error: error.message } } }
const resolveWorkspaceId = workspaceId => {
  if (!workspaceId) return null
  if (databaseManager.getWorkspaceByPath(workspaceId)) return databaseManager.getWorkspaceByPath(workspaceId).id
  return workspaceId
}
export function registerSkillsIPC() {
  ipcMain.handle('skills:list', respond(({ workspaceId }) => ({ skills: databaseManager.listSkills({ workspaceId: resolveWorkspaceId(workspaceId) }) })))
  ipcMain.handle('skills:get', respond(({ id }) => ({ skill: databaseManager.getSkill(id) })))
  ipcMain.handle('skills:create', respond(({ skill }) => ({ skill: databaseManager.createSkill(SkillValidator.validate({ ...skill, workspaceId: resolveWorkspaceId(skill.workspaceId || skill.workspace_id) })) })))
  ipcMain.handle('skills:update', respond(({ id, skill }) => ({ skill: databaseManager.updateSkill(id, SkillValidator.validate({ ...databaseManager.getSkill(id), ...skill })) })))
  ipcMain.handle('skills:delete', respond(({ id }) => ({ deleted: databaseManager.deleteSkill(id) })))
  ipcMain.handle('skills:enable', respond(({ id }) => ({ skill: databaseManager.updateSkill(id, { enabled: true }) })))
  ipcMain.handle('skills:disable', respond(({ id }) => ({ skill: databaseManager.updateSkill(id, { enabled: false }) })))
  ipcMain.handle('skills:usage', respond(data => ({ usage: databaseManager.recordSkillUsage(data) })))
}
