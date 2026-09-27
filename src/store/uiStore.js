import { create } from 'zustand'

const readPreference = (key, fallback) => {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : JSON.parse(value)
  } catch {
    return fallback
  }
}

const savePreference = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Storage is optional. */ }
}

export const useUIStore = create((set, get) => ({
  isDark: readPreference('ide_theme_dark', true),
  activePanel: 'explorer',
  isSidebarOpen: readPreference('ide_sidebar_open', true),
  isTerminalOpen: readPreference('ide_terminal_open', true),
  isAIPanelOpen: false,
  isFocusMode: false,
  sidebarWidth: readPreference('ide_sidebar_width', 256),
  aiPanelWidth: Number(localStorage.getItem('ide_ai_panel_width')) || 320,
  terminalHeight: readPreference('ide_terminal_height', 192),
  isCommandPaletteOpen: false,
  isQuickOpenOpen: false,
  isSearchOpen: false,
  isAISettingsOpen: false,
  terminalOutput: '',

  setIsDark: (isDark) => { savePreference('ide_theme_dark', isDark); set({ isDark }) },
  setActivePanel: (activePanel) => set({ activePanel }),
  setIsSidebarOpen: (isSidebarOpen) => { savePreference('ide_sidebar_open', isSidebarOpen); set({ isSidebarOpen }) },
  setIsTerminalOpen: (isTerminalOpen) => { savePreference('ide_terminal_open', isTerminalOpen); set({ isTerminalOpen }) },
  setIsAIPanelOpen: (isAIPanelOpen) => set({ isAIPanelOpen }),
  setIsFocusMode: (isFocusMode) => set({ isFocusMode }),
  setSidebarWidth: (sidebarWidth) => { savePreference('ide_sidebar_width', sidebarWidth); set({ sidebarWidth }) },
  setAIPanelWidth: (aiPanelWidth) => set({ aiPanelWidth }),
  setTerminalHeight: (terminalHeight) => { savePreference('ide_terminal_height', terminalHeight); set({ terminalHeight }) },
  setIsCommandPaletteOpen: (isCommandPaletteOpen) => set({ isCommandPaletteOpen }),
  setIsQuickOpenOpen: (isQuickOpenOpen) => set({ isQuickOpenOpen }),
  setIsSearchOpen: (isSearchOpen) => set({ isSearchOpen }),
  setIsAISettingsOpen: (isAISettingsOpen) => set({ isAISettingsOpen }),

  appendTerminalOutput: (text) => set((state) => ({
    terminalOutput: state.terminalOutput + text
  })),
  clearTerminalOutput: () => set({ terminalOutput: '' }),
  setTerminalOutput: (output) => set({ terminalOutput: typeof output === 'function' ? output(get().terminalOutput) : output })
}))
