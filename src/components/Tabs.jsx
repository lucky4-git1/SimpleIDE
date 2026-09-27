import { X, Play } from 'lucide-react'

export default function Tabs({ files, activeFilePath, onTabClick, onTabClose, onRun, isDark }) {
  if (files.length === 0) return null

  return (
    <div className="flex h-full w-full items-center justify-between">
      <div className="flex h-full items-center flex-1 overflow-x-auto no-scrollbar">
        {files.map(file => {
          const isActive = file.path === activeFilePath
          return (
            <div
              key={file.path}
              onClick={() => onTabClick(file.path)}
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault()
                  onTabClose(file.path)
                }
              }}
              title={file.path}
              className={`group flex items-center h-full px-3 border-r cursor-pointer min-w-[120px] max-w-[200px] transition-colors ${
                isActive 
                  ? (isDark ? 'bg-[#1e1e1e] text-blue-400 border-[#1e1e1e]' : 'bg-white text-blue-600 border-[#cccccc]') 
                  : (isDark ? 'bg-[#2d2d2d] text-zinc-400 hover:bg-[#252526] border-[#1e1e1e]' : 'bg-[#ececec] text-zinc-600 hover:bg-[#e4e4e4] border-[#cccccc]')
              }`}
            >
              <div className="flex-1 truncate text-sm mr-2 flex items-center gap-1.5">
                <span className="truncate">{file.name}</span>
                {file.isDirty && <span className={`w-2 h-2 rounded-full inline-block ${isDark ? 'bg-blue-300' : 'bg-blue-600'}`} title="Unsaved changes"></span>}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onTabClose(file.path)
                }}
                className={`p-0.5 rounded transition-opacity ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'} ${isDark ? 'hover:bg-[#333333]' : 'hover:bg-[#d0d0d0]'}`}
                title={`Close ${file.name}`}
              >
                <X size={14} />
              </button>
            </div>
          )
        })}
      </div>
      
      {activeFilePath && (
        <div className="px-3 flex items-center h-full border-l border-[#1e1e1e]">
          <button
            onClick={onRun}
            className="flex items-center gap-1.5 px-2 py-1 text-sm bg-green-700/20 text-green-400 hover:bg-green-700/40 rounded transition-colors"
            title="Run Code (Auto-saves first)"
          >
            <Play size={14} />
            <span>Run</span>
          </button>
        </div>
      )}
    </div>
  )
}
