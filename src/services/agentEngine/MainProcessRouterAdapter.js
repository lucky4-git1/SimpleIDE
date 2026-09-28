/**
 * MainProcessRouterAdapter: Bridges PrimeRouter in the renderer with
 * LocalModelRuntime running in the Electron main process via contextBridge.
 */
export class MainProcessRouterAdapter {
  constructor(api = typeof window !== 'undefined' ? window?.api : null) {
    this.api = api
  }

  async predict(params) {
    if (this.api?.primeRouter?.decide) {
      const response = await this.api.primeRouter.decide(params)
      if (response?.success && response.decision) {
        return response.decision
      }
      if (response?.error) {
        throw new Error(response.error)
      }
    }

    // Fallback for tests / headless environments outside Electron
    const req = String(params?.request || '').toLowerCase()
    if (/\b(git status|git diff)\b/.test(req)) {
      return {
        intent: 'git',
        actionClass: 'local_tool',
        toolFamily: 'git',
        needsLLM: false,
        needsVerification: false,
        confidence: 0.95
      }
    }
    if (/\b(npm test|run test)\b/.test(req)) {
      return {
        intent: 'test',
        actionClass: 'local_tool',
        toolFamily: 'testing',
        needsLLM: false,
        needsVerification: true,
        confidence: 0.94
      }
    }
    if (/\b(find|search)\b/.test(req)) {
      return {
        intent: 'search',
        actionClass: 'local_tool',
        toolFamily: 'search',
        needsLLM: false,
        needsVerification: false,
        confidence: 0.91
      }
    }
    if (/\b(open|read|view)\b/.test(req)) {
      return {
        intent: 'inspect',
        actionClass: 'local_tool',
        toolFamily: 'filesystem',
        needsLLM: false,
        needsVerification: false,
        confidence: 0.92
      }
    }

    return {
      intent: 'chat',
      actionClass: 'main_llm',
      toolFamily: 'none',
      needsLLM: true,
      needsVerification: false,
      confidence: 0.70
    }
  }

  async batchPredict(items, opts) {
    if (this.api?.primeRouter?.batchDecide) {
      const response = await this.api.primeRouter.batchDecide(items)
      if (response?.success && Array.isArray(response.decisions)) {
        return response.decisions
      }
    }
    return Promise.all(items.map(item => this.predict({ ...item, ...opts })))
  }

  async getStatus() {
    if (this.api?.primeRouter?.getStatus) {
      const res = await this.api.primeRouter.getStatus()
      return res?.status || null
    }
    return null
  }
}
