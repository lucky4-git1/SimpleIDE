/**
 * AgentMemoryHierarchy.js
 *
 * Implements Phase 20: Agent Memory Hierarchy
 * Five distinct memory tiers with isolated lifespans:
 * - Tier 1: Immediate Context (turn lifetime)
 * - Tier 2: Working Memory (subtask / scratchpad lifetime)
 * - Tier 3: Run Memory (single agent task run lifetime)
 * - Tier 4: Project Memory (workspace lifetime, persistent)
 * - Tier 5: User Preferences (global user lifetime, persistent)
 */

export class AgentMemoryHierarchy {
  constructor(runId, workspaceRoot, { projectMemory, preferences = {} } = {}) {
    this.runId = runId
    this.workspaceRoot = workspaceRoot
    this.projectMemory = projectMemory

    // Tier 1: Immediate Context (reset per turn)
    this.immediate = null

    // Tier 2: Working Memory (reset per subtask)
    this.working = new Map() // key -> value

    // Tier 3: Run Memory (lasts for task duration)
    this.run = {
      runId,
      startedAt: Date.now(),
      steps: [],
      filesChanged: new Set(),
      testsRun: [],
      checkpoints: []
    }

    // Tier 4: Project Memory reference
    this.projectFacts = []

    // Tier 5: Persistent User Preferences
    this.preferences = { ...preferences }
  }

  // Tier 1: Immediate
  setImmediate(attentionWindow) {
    this.immediate = attentionWindow
  }

  getImmediate() {
    return this.immediate
  }

  clearImmediate() {
    this.immediate = null
  }

  // Tier 2: Working
  setWorking(key, value) {
    this.working.set(key, { value, timestamp: Date.now() })
  }

  getWorking(key) {
    return this.working.get(key)?.value ?? null
  }

  clearWorking() {
    this.working.clear()
  }

  // Tier 3: Run
  recordStep(step) {
    this.run.steps.push({ ...step, timestamp: Date.now() })
  }

  recordFileChange(filePath) {
    this.run.filesChanged.add(filePath)
  }

  recordTestResult(testResult) {
    this.run.testsRun.push({ ...testResult, timestamp: Date.now() })
  }

  getRunSummary() {
    return {
      runId: this.run.runId,
      stepsCount: this.run.steps.length,
      filesChanged: [...this.run.filesChanged],
      testsCount: this.run.testsRun.length,
      durationMs: Date.now() - this.run.startedAt
    }
  }

  // Tier 4: Project
  addProjectFact(fact) {
    this.projectFacts.push({ fact, timestamp: Date.now() })
  }

  getProjectFacts() {
    return this.projectFacts.map(f => f.fact)
  }

  // Tier 5: Preferences
  getPreference(key, fallback = null) {
    return this.preferences[key] !== undefined ? this.preferences[key] : fallback
  }

  setPreference(key, value) {
    this.preferences[key] = value
  }

  /**
   * Synthesizes a structured memory snapshot without dumping raw turn histories.
   */
  snapshot() {
    return {
      tier1_immediate: this.immediate ? 'active' : 'idle',
      tier2_workingCount: this.working.size,
      tier3_run: this.getRunSummary(),
      tier4_projectFactsCount: this.projectFacts.length,
      tier5_preferences: Object.keys(this.preferences)
    }
  }
}
