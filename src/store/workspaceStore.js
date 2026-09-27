import { create } from 'zustand'

export const useWorkspaceStore = create((set) => ({
  currentFolder: null,
  fileTree: [],
  projectIndex: [],
  projectSummary: '',
  isIndexing: false,

  setCurrentFolder: (currentFolder) => set({ currentFolder }),
  setFileTree: (fileTree) => set({ fileTree }),
  setProjectIndex: (projectIndex) => set({ projectIndex }),
  setProjectSummary: (projectSummary) => set({ projectSummary }),
  setIsIndexing: (isIndexing) => set({ isIndexing }),

  updateSingleIndexedFile: (filePath, content) => set((state) => {
    const normalizedTarget = filePath.replace(/\\/g, '/').toLowerCase()
    const withoutTarget = state.projectIndex.filter(
      (file) => file.path.replace(/\\/g, '/').toLowerCase() !== normalizedTarget
    )
    if (content === null || content.length > 300000) {
      return { projectIndex: withoutTarget }
    }
    const name = filePath.split(/[/\\]/).pop()
    return {
      projectIndex: [
        ...withoutTarget,
        { path: filePath, name, content, size: content.length }
      ]
    }
  }),

  persistState: async () => {
    const api = globalThis.window?.api
    const state = useWorkspaceStore.getState()
    if (api?.db?.saveWorkspaceState && state.currentFolder) {
      try {
        await api.db.saveWorkspaceState({
          workspaceId: state.currentFolder,
          state: {
            currentFolder: state.currentFolder,
            projectSummary: state.projectSummary
          }
        })
      } catch (err) {
        console.warn('[workspaceStore] Failed to persist state:', err?.message)
      }
    }
  },

  restoreState: async (workspaceId) => {
    const api = globalThis.window?.api
    if (api?.db?.getWorkspaceState && workspaceId) {
      try {
        const res = await api.db.getWorkspaceState({ workspaceId })
        if (res?.success && res.state) {
          const saved = typeof res.state === 'string' ? JSON.parse(res.state) : res.state
          if (saved.currentFolder) set({ currentFolder: saved.currentFolder })
          if (saved.projectSummary) set({ projectSummary: saved.projectSummary })
          return saved
        }
      } catch (err) {
        console.warn('[workspaceStore] Failed to restore state:', err?.message)
      }
    }
    return null
  }
}))
