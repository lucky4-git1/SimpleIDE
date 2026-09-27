import { create } from 'zustand'

export const useEditorStore = create((set, get) => ({
  openFiles: [],
  activeFilePath: null,
  cursorPosition: null,
  selectedCode: '',
  markers: [],
  pendingReveal: null,

  setOpenFiles: (openFiles) => set({ openFiles }),
  setActiveFilePath: (activeFilePath) => set({ activeFilePath }),
  setCursorPosition: (cursorPosition) => set({ cursorPosition }),
  setSelectedCode: (selectedCode) => set({ selectedCode }),
  setMarkers: (markers) => set({ markers }),
  setPendingReveal: (pendingReveal) => set({ pendingReveal }),

  openFile: (file) => set((state) => {
    const existing = state.openFiles.find((f) => f.path === file.path)
    if (existing) {
      return { activeFilePath: file.path }
    }
    return {
      openFiles: [...state.openFiles, file],
      activeFilePath: file.path
    }
  }),

  closeFile: (filePath) => set((state) => {
    const newFiles = state.openFiles.filter((f) => f.path !== filePath)
    let nextActive = state.activeFilePath
    if (state.activeFilePath === filePath) {
      nextActive = newFiles.length > 0 ? newFiles[newFiles.length - 1].path : null
    }
    return {
      openFiles: newFiles,
      activeFilePath: nextActive
    }
  }),

  updateFileContent: (filePath, newContent) => set((state) => ({
    openFiles: state.openFiles.map((f) =>
      f.path === filePath ? { ...f, content: newContent, isDirty: true } : f
    )
  })),

  markFileSaved: (filePath) => set((state) => ({
    openFiles: state.openFiles.map((f) =>
      f.path === filePath ? { ...f, isDirty: false } : f
    )
  })),

  persistState: async (workspaceId) => {
    const api = globalThis.window?.api
    const state = get()
    if (api?.db?.saveWorkspaceState && workspaceId) {
      try {
        const fileList = state.openFiles.map(f => ({ path: f.path, name: f.name }))
        await api.db.saveWorkspaceState({
          workspaceId,
          state: {
            openFiles: fileList,
            activeFilePath: state.activeFilePath,
            cursorPosition: state.cursorPosition
          }
        })
      } catch (err) {
        console.warn('[editorStore] Failed to persist editor state:', err?.message)
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
          if (Array.isArray(saved.openFiles)) set({ openFiles: saved.openFiles })
          if (saved.activeFilePath) set({ activeFilePath: saved.activeFilePath })
          if (saved.cursorPosition) set({ cursorPosition: saved.cursorPosition })
          return saved
        }
      } catch (err) {
        console.warn('[editorStore] Failed to restore editor state:', err?.message)
      }
    }
    return null
  }
}))
