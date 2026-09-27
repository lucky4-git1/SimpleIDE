import { useState, useCallback, useEffect } from 'react'

const SIDEBAR_MIN_WIDTH = 180
const SIDEBAR_MAX_WIDTH = 520
const AI_PANEL_MIN_WIDTH = 280
const AI_PANEL_MAX_WIDTH = 720

export default function Layout({ activityBar, sidebar, tabs, editor, terminal, aiPanel, isAIPanelOpen, isSidebarOpen = true, isDark = true, terminalHeight, onTerminalResize, isTerminalOpen, sidebarWidth, onSidebarResize, aiPanelWidth, onAIPanelResize, isAIWorking = false }) {
  const [resizeTarget, setResizeTarget] = useState(null)

  const startResizing = useCallback((target) => {
    setResizeTarget(target)
  }, [])

  const stopResizing = useCallback(() => {
    setResizeTarget(null)
  }, [])

  const resize = useCallback((e) => {
    if (resizeTarget === 'terminal') {
      const newHeight = window.innerHeight - e.clientY - 24 // 24px is approximate status bar height
      const boundedHeight = Math.max(100, Math.min(newHeight, window.innerHeight * 0.8))
      onTerminalResize(boundedHeight)
    } else if (resizeTarget === 'sidebar') {
      const boundedWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(e.clientX - 48, SIDEBAR_MAX_WIDTH))
      onSidebarResize(boundedWidth)
    } else if (resizeTarget === 'ai') {
      const boundedWidth = Math.max(AI_PANEL_MIN_WIDTH, Math.min(window.innerWidth - e.clientX, AI_PANEL_MAX_WIDTH))
      onAIPanelResize(boundedWidth)
    }
  }, [onAIPanelResize, onSidebarResize, onTerminalResize, resizeTarget])

  useEffect(() => {
    if (resizeTarget) {
      window.addEventListener('mousemove', resize)
      window.addEventListener('mouseup', stopResizing)
    } else {
      window.removeEventListener('mousemove', resize)
      window.removeEventListener('mouseup', stopResizing)
    }
    return () => {
      window.removeEventListener('mousemove', resize)
      window.removeEventListener('mouseup', stopResizing)
    }
  }, [resizeTarget, resize, stopResizing])

  return (
    <div className={`flex w-full h-full overflow-hidden ${isDark ? 'bg-transparent text-[#cccccc]' : 'bg-white text-[#333333]'}`}>
      {/* Activity Bar */}
      <div className="activity-bar flex flex-col shrink-0">
        {activityBar}
      </div>

      {/* Sidebar - Toggleable */}
      <div 
        className={`sidebar border-r flex flex-col overflow-hidden ${resizeTarget === 'sidebar' ? '' : 'transition-[width] duration-200'} ${isDark ? 'border-white/5 bg-black/20' : 'border-[#dddddd] bg-[#f3f3f3]'}`}
        style={{ width: isSidebarOpen ? `${sidebarWidth}px` : '0px', minWidth: isSidebarOpen ? `${sidebarWidth}px` : '0px' }}
      >
        {sidebar}
      </div>

      {isSidebarOpen && (
        <div
          className={`panel-resizer panel-resizer-vertical ${resizeTarget === 'sidebar' ? 'is-resizing' : ''}`}
          onMouseDown={() => startResizing('sidebar')}
          role="separator"
          aria-label="Resize Explorer panel"
        />
      )}

      {/* Main Content - Flex */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Editor Area */}
        <div className={`editor-container flex-1 flex flex-col min-h-0 ${isDark ? 'bg-black/20' : 'bg-white'}`}>
          {/* Tabs */}
          <div className={`tabs-container h-10 flex items-center overflow-x-auto custom-scrollbar no-scrollbar-y border-b ${isDark ? 'bg-white/5 border-white/5' : 'bg-[#ececec] border-[#cccccc]'}`}>
            {tabs}
          </div>
          {/* Code Editor */}
          <div className="flex-1 min-h-0 relative">
            {editor}
          </div>
        </div>

        {/* Resizer Handle */}
        {isTerminalOpen && (
          <div 
            className={`h-1 cursor-row-resize ${isDark ? 'bg-white/5 hover:bg-blue-500/50' : 'bg-[#dddddd] hover:bg-blue-400'} transition-colors z-10`}
            onMouseDown={() => startResizing('terminal')}
          />
        )}

        {/* Terminal Area */}
        <div 
          className={`terminal-container flex flex-col ${isDark ? 'bg-black/40' : 'bg-white'}`}
          style={{ height: isTerminalOpen ? `${terminalHeight}px` : '36px' }}
        >
          {terminal}
        </div>
      </div>

      {/* AI Panel - Right sidebar (Mounted constantly to preserve memory state) */}
      <div
        className={`panel-resizer panel-resizer-vertical ${resizeTarget === 'ai' ? 'is-resizing' : ''}`}
        onMouseDown={() => startResizing('ai')}
        role="separator"
        aria-label="Resize AI panel"
        style={{ display: isAIPanelOpen ? 'block' : 'none' }}
      />
      <div 
        className={`ai-panel-wrapper flex flex-col ${isAIWorking ? 'ai-working' : ''}`} 
        style={{ 
          width: `${aiPanelWidth}px`, 
          display: isAIPanelOpen ? 'flex' : 'none' 
        }}
      >
        {aiPanel}
      </div>
    </div>
  )
}
