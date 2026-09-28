import { memoryManager } from '../memory/memoryManager.js'
import { PatchEngine } from './PatchEngine.js'

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

export class ChangeManager {
  constructor(workspaceRoot, { api } = {}) {
    this.root = workspaceRoot;
    this.api = api || globalThis.window?.api;
    this.history = [];
    this.currentTaskChanges = [];
    this.currentTaskId = null;
  }

  getApi() {
    return this.api || globalThis.window?.api;
  }

  beginTransaction(taskId) {
    this.currentTaskId = taskId;
    this.currentTaskChanges = [];
  }

  async recordChange({ path, operation, before, after, patch, edits }) {
    if (!this.currentTaskId) throw new Error('No active transaction');
    
    const changeId = `change-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const computedPatch = patch || (before && after ? PatchEngine.createPatch(path, before, after) : null);
    const change = {
      taskId: this.currentTaskId,
      changeId,
      path,
      operation,
      timestamp: Date.now(),
      before: before || '',
      after: after || '',
      checksumBefore: hashString(before || ''),
      checksumAfter: hashString(after || ''),
      patch: computedPatch,
      edits: edits || computedPatch?.edits || []
    };
    
    this.currentTaskChanges.push(change);
    this.history.push(change);

    const api = this.getApi();
    if (api?.db?.logFileChange && this.currentTaskId) {
      try {
        api.db.logFileChange({
          runId: this.currentTaskId,
          filePath: path,
          beforeHash: change.checksumBefore,
          afterHash: change.checksumAfter,
          beforeContent: before || null,
          afterContent: after || null
        });
      } catch (err) {
        console.warn('[ChangeManager] Failed to log file change to DB:', err?.message);
      }
    }
    
    return change;
  }

  async commitTransaction(taskId) {
    const targetTaskId = taskId || this.currentTaskId;
    const changes = this.history.filter(c => c.taskId === targetTaskId);
    if (this.currentTaskId === targetTaskId) {
      this.currentTaskId = null;
      this.currentTaskChanges = [];
    }
    return changes;
  }

  async rollbackTransaction(taskId) {
    const targetTaskId = taskId || this.currentTaskId;
    if (!targetTaskId) return [];

    const changesToRollback = this.history.filter(c => c.taskId === targetTaskId).reverse();
    if (!changesToRollback.length) {
      if (this.currentTaskId === targetTaskId) {
        this.currentTaskId = null;
        this.currentTaskChanges = [];
      }
      return [];
    }

    const api = this.getApi();
    if (!api) throw new Error('No API implementation available for file operations during rollback.');

    const executedRollbacks = [];
    for (const change of changesToRollback) {
      const fullPath = change.path;
      try {
        const current = await api.readFile(fullPath);
        
        // Basic conflict detection: skip if externally modified
        if (current && current.success && hashString(current.content || '') !== change.checksumAfter) {
          console.warn(`[ChangeManager] Skipping rollback for ${fullPath}: File was modified externally.`);
          continue;
        }
        
        if (change.operation === 'create' || (change.operation === 'write' && !change.before)) {
          await api.deleteFile(fullPath);
        } else if (change.operation === 'move' || change.operation === 'rename') {
          if (change.from) {
            await api.moveFile(fullPath, change.from);
            await api.writeFile(change.from, change.before);
          }
        } else {
          await api.writeFile(fullPath, change.before);
        }
        executedRollbacks.push(change);
      } catch (err) {
        console.warn(`[ChangeManager] Error rolling back change on ${fullPath}: ${err.message}`);
      }
    }
    
    this.history = this.history.filter(c => c.taskId !== targetTaskId);
    if (this.currentTaskId === targetTaskId) {
      this.currentTaskId = null;
      this.currentTaskChanges = [];
    }

    if (api?.db?.logAgentEvent) {
      try {
        api.db.logAgentEvent({
          runId: targetTaskId,
          type: 'TRANSACTION_ROLLBACK',
          payload: { rolledBackCount: executedRollbacks.length, paths: executedRollbacks.map(c => c.path) }
        });
      } catch (err) {
        console.warn('[ChangeManager] Failed to log rollback event:', err?.message);
      }
    }

    return true;
  }
}

