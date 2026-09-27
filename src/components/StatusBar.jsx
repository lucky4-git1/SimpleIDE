import { AlertCircle, Bot, Files, Focus, Globe, Moon, PanelLeft, Sun } from 'lucide-react'

export default function StatusBar({
  activeFile,
  cursorPosition,
  language,
  markersCount = 0,
  indexedFileCount = 0,
  isIndexing = false,
  isFocusMode = false,
  isDark,
  toggleTheme,
  isAIPanelOpen,
  toggleAIPanel,
  isSidebarOpen,
  toggleSidebar,
  toggleFocusMode,
  onOpenInBrowser
}) {
  return (
    <div className={`h-6 flex items-center justify-between px-3 text-xs border-t transition-colors ${
      isDark 
        ? 'bg-[#007acc] text-white border-[#333333]' 
        : 'bg-[#007acc] text-white border-[#dddddd]'
    }`}>
      <div className="flex items-center gap-4">
        <button 
          onClick={toggleSidebar}
          className={`flex items-center gap-1 px-1 rounded transition-colors ${isSidebarOpen ? 'bg-white/30' : 'hover:bg-white/20'}`}
          title="Toggle Sidebar (Ctrl+B)"
        >
          <PanelLeft size={12} />
        </button>
        <span className="flex items-center gap-1.5">
          {activeFile ? activeFile.name : 'No file open'}
          {activeFile?.isDirty && (
            <span className={`w-2 h-2 rounded-full ${isDark ? 'bg-white' : 'bg-black'} opacity-80`} title="Unsaved changes"></span>
          )}
        </span>
      </div>
      
      <div className="flex items-center gap-4">
        {activeFile && cursorPosition && (
          <span>Ln {cursorPosition.lineNumber}, Col {cursorPosition.column}</span>
        )}
        {markersCount > 0 && (
          <span className="flex items-center gap-1 text-yellow-200" title="Problems in current file">
            <AlertCircle size={12} />
            {markersCount}
          </span>
        )}
        {activeFile && (
          <span className="capitalize">{language}</span>
        )}
        {indexedFileCount > 0 && (
          <span className="flex items-center gap-1 text-zinc-200/90" title={isIndexing ? 'Indexing workspace' : 'Indexed workspace files'}>
            <Files size={12} />
            {isIndexing ? 'Indexing' : indexedFileCount}
          </span>
        )}
        {activeFile?.name?.endsWith('.html') && (
          <div className="flex items-center gap-2 border-l border-white/20 pl-2 ml-1">
            <div className="flex items-center gap-1.5 text-zinc-300" title="Live Server is running">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
              <span>Live</span>
            </div>
            <button
              onClick={onOpenInBrowser}
              className="flex items-center gap-1 hover:bg-white/20 px-1 rounded transition-colors text-green-300 hover:text-green-200"
              title="Open in Browser (Local Server)"
            >
              <Globe size={12} />
              <span>Live Test</span>
            </button>
          </div>
        )}
        <button 
          onClick={toggleTheme}
          className="flex items-center gap-1 hover:bg-white/20 px-1 rounded transition-colors"
          title="Toggle Theme"
        >
          {isDark ? <Sun size={12} /> : <Moon size={12} />}
          <span>{isDark ? 'Light' : 'Dark'}</span>
        </button>
        <button
          onClick={toggleFocusMode}
          className={`flex items-center gap-1 px-1 rounded transition-colors ${isFocusMode ? 'bg-white/30' : 'hover:bg-white/20'}`}
          title="Toggle Focus Mode"
        >
          <Focus size={12} />
          <span>Focus</span>
        </button>
        <button 
          onClick={toggleAIPanel}
          className={`flex items-center gap-1 px-1.5 rounded transition-colors ${isAIPanelOpen ? 'bg-white/30' : 'hover:bg-white/20'}`}
          title="Toggle AI Panel"
        >
          <Bot size={12} />
          <span>AI</span>
        </button>
      </div>
    </div>
  )
}
