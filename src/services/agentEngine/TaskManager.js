export class TaskManager {
  constructor() {
    this.tasks = new Map();
    this.listeners = new Set();
  }

  createTask(description) {
    const task = {
      id: crypto.randomUUID(),
      description,
      status: 'queued', // queued, running, paused, waiting, completed, cancelled, failed
      progress: 0,
      logs: [],
      retryCount: 0,
      rollbackPoint: null,
      affectedFiles: [],
      startTime: null,
      endTime: null,
      duration: 0
    };
    this.tasks.set(task.id, task);
    this.emitUpdate(task);
    return task;
  }

  updateTask(id, updates) {
    const task = this.tasks.get(id);
    if (!task) return null;
    
    if (updates.status === 'running' && task.status === 'queued') {
      updates.startTime = Date.now();
    }
    if (['completed', 'cancelled', 'failed'].includes(updates.status) && !task.endTime) {
      updates.endTime = Date.now();
      updates.duration = updates.endTime - (task.startTime || updates.endTime);
    }
    
    const updated = { ...task, ...updates };
    this.tasks.set(id, updated);
    this.emitUpdate(updated);
    return updated;
  }

  addLog(id, logEntry) {
    const task = this.tasks.get(id);
    if (!task) return;
    task.logs.push({ timestamp: Date.now(), ...logEntry });
    this.emitUpdate(task);
  }

  getTask(id) {
    return this.tasks.get(id);
  }

  getAllTasks() {
    return Array.from(this.tasks.values());
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  emitUpdate(task) {
    this.listeners.forEach(listener => listener(task));
  }
}

export const globalTaskManager = new TaskManager();
