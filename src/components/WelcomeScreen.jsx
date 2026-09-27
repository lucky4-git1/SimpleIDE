import { Bot, Command, FileSearch, FolderOpen, Search } from 'lucide-react'

function getFolderName(folderPath) {
  if (!folderPath) return 'No folder open'
  return folderPath.split(/[/\\]/).filter(Boolean).pop() || folderPath
}

export default function WelcomeScreen({
  currentFolder,
  projectIndex = [],
  isIndexing,
  onOpenFolder,
  onQuickOpen,
  onWorkspaceSearch,
  onCommandPalette,
  onAIPanel,
  isDark
}) {
  const totalSize = (projectIndex || []).reduce((sum, file) => sum + (file.size || 0), 0)
  const projectSize = totalSize > 1000000 ? `${(totalSize / 1000000).toFixed(1)} MB` : `${Math.max(1, Math.round(totalSize / 1000))} KB`

  const actions = [
    { label: 'Open Folder', icon: FolderOpen, action: onOpenFolder },
    { label: 'Quick Open', icon: FileSearch, action: onQuickOpen, disabled: !currentFolder },
    { label: 'Search Workspace', icon: Search, action: onWorkspaceSearch, disabled: !currentFolder },
    { label: 'Command Palette', icon: Command, action: onCommandPalette },
    { label: 'AI Assistant', icon: Bot, action: onAIPanel }
  ]

  return (
    <div className={`flex h-full w-full flex-col items-center justify-center overflow-y-auto p-4 sm:p-6 md:p-8 ${isDark ? 'bg-[#101014] text-zinc-300' : 'bg-white text-zinc-700'}`}>
      <div className="w-full max-w-5xl my-auto">
        <div className="mb-6 sm:mb-8">
          <div className={`text-xs font-semibold uppercase tracking-wider ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>
            Simple IDE
          </div>
          <h1 className={`mt-1.5 text-2xl sm:text-3xl font-bold tracking-tight truncate max-w-full ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            {getFolderName(currentFolder)}
          </h1>
          <div className={`mt-3 flex flex-wrap items-center gap-2 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
            <span className={`inline-flex items-center rounded-md border px-2.5 py-1 font-medium ${isDark ? 'border-white/10 bg-white/5 text-zinc-300' : 'border-zinc-200 bg-zinc-100 text-zinc-700'}`}>
              {isIndexing ? (
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
                  Indexing...
                </span>
              ) : (
                `${projectIndex.length} indexed files`
              )}
            </span>
            {currentFolder && (
              <span className={`inline-flex items-center rounded-md border px-2.5 py-1 font-medium ${isDark ? 'border-white/10 bg-white/5 text-zinc-300' : 'border-zinc-200 bg-zinc-100 text-zinc-700'}`}>
                {projectSize}
              </span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(165px,1fr))] gap-2.5 sm:gap-3">
          {actions.map(action => {
            const Icon = action.icon
            return (
              <button
                key={action.label}
                onClick={action.action}
                disabled={action.disabled}
                className={`group flex items-center gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
                  isDark
                    ? 'border-white/10 bg-zinc-900/60 hover:border-blue-500/40 hover:bg-blue-500/10 hover:shadow-md hover:shadow-blue-500/5'
                    : 'border-zinc-200 bg-zinc-50/80 hover:border-blue-300 hover:bg-blue-50/80 hover:shadow-md'
                }`}
              >
                <span className={`flex shrink-0 items-center justify-center rounded-md p-2 transition-colors ${
                  isDark 
                    ? 'bg-blue-500/10 text-blue-400 group-hover:bg-blue-500/20 group-hover:text-blue-300' 
                    : 'bg-blue-100 text-blue-600 group-hover:bg-blue-200'
                }`}>
                  <Icon size={18} />
                </span>
                <span className={`text-sm font-medium whitespace-nowrap overflow-hidden text-ellipsis ${
                  isDark ? 'text-zinc-200 group-hover:text-white' : 'text-zinc-700 group-hover:text-zinc-900'
                }`}>
                  {action.label}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
