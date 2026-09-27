import { useState, useEffect } from 'react'
import { GitBranch, Plus, Minus, Check, RefreshCw, ArrowUp, ArrowDown, FileText, AlertCircle } from 'lucide-react'

export default function GitPanel({ currentFolder, isDark, setTerminalOutput }) {
  const [status, setStatus] = useState(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)

  const fetchStatus = async () => {
    if (!currentFolder) return
    setIsLoading(true)
    setError(null)
    const result = await window.api.gitStatus(currentFolder)
    if (result.success) {
      setStatus(result.status)
    } else {
      setError(result.error)
    }
    setIsLoading(false)
  }

  useEffect(() => {
    fetchStatus()
  }, [currentFolder])

  const handleStage = async (filePath) => {
    const result = await window.api.gitStage({ folderPath: currentFolder, filePath })
    if (result.success) fetchStatus()
  }

  const handleUnstage = async (filePath) => {
    const result = await window.api.gitUnstage({ folderPath: currentFolder, filePath })
    if (result.success) fetchStatus()
  }

  const handleCommit = async () => {
    if (!commitMessage.trim()) return
    setIsLoading(true)
    const result = await window.api.gitCommit({ folderPath: currentFolder, message: commitMessage })
    if (result.success) {
      setCommitMessage('')
      fetchStatus()
    } else {
      alert(`Commit failed: ${result.error}`)
    }
    setIsLoading(false)
  }

  const handlePush = async () => {
    setIsLoading(true)
    const result = await window.api.gitPush(currentFolder)
    if (result.success) {
      setTerminalOutput(prev => prev + '\nGit: Pushed successfully')
      fetchStatus()
    } else {
      setTerminalOutput(prev => prev + `\nGit Push Error: ${result.error}`)
    }
    setIsLoading(false)
  }

  const handlePull = async () => {
    setIsLoading(true)
    const result = await window.api.gitPull(currentFolder)
    if (result.success) {
      setTerminalOutput(prev => prev + '\nGit: Pulled successfully')
      fetchStatus()
    } else {
      setTerminalOutput(prev => prev + `\nGit Pull Error: ${result.error}`)
    }
    setIsLoading(false)
  }

  if (!currentFolder) {
    return (
      <div className={`p-8 text-center ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
        <GitBranch size={48} className="mx-auto mb-4 opacity-20" />
        <p className="text-sm">Open a folder to use Source Control</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className={`p-8 text-center ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
        <AlertCircle size={48} className="mx-auto mb-4 text-red-500 opacity-50" />
        <p className="text-sm mb-4">Git repository not found or error occurred.</p>
        <button 
          onClick={() => fetchStatus()}
          className="px-4 py-1.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    )
  }

  const staged = status?.staged || []
  const modified = status?.modified || []
  const untracked = status?.not_added || []
  const allUnstaged = [...modified, ...untracked]

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className={`flex items-center justify-between px-4 py-2 border-b ${isDark ? 'border-[#333] bg-[#252526]' : 'border-zinc-200 bg-zinc-50'}`}>
        <span className={`text-xs font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>Source Control</span>
        <div className="flex items-center gap-1">
          <button onClick={fetchStatus} disabled={isLoading} className="p-1 hover:bg-zinc-700 rounded transition-colors">
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          </button>
          <button onClick={handlePush} disabled={isLoading} className="p-1 hover:bg-zinc-700 rounded transition-colors" title="Push">
            <ArrowUp size={14} />
          </button>
          <button onClick={handlePull} disabled={isLoading} className="p-1 hover:bg-zinc-700 rounded transition-colors" title="Pull">
            <ArrowDown size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Commit Input */}
        <div className="p-4 space-y-2">
          <textarea
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="Message (Ctrl+Enter to commit)"
            className={`w-full p-2 text-sm rounded border focus:outline-none focus:border-blue-500 ${
              isDark ? 'bg-[#2d2d2d] border-[#444] text-zinc-200' : 'bg-white border-zinc-300 text-zinc-800'
            }`}
            rows={3}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                handleCommit()
              }
            }}
          />
          <button
            onClick={handleCommit}
            disabled={isLoading || !commitMessage.trim() || staged.length === 0}
            className={`w-full py-1.5 flex items-center justify-center gap-2 rounded text-sm font-medium transition-colors ${
              isLoading || !commitMessage.trim() || staged.length === 0
                ? 'bg-zinc-700 text-zinc-500 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            <Check size={16} /> Commit
          </button>
        </div>

        {/* Changes List */}
        <div className="px-4 py-2 space-y-4">
          {/* Staged Changes */}
          {staged.length > 0 && (
            <div>
              <h3 className={`text-[11px] font-bold uppercase mb-2 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>Staged Changes ({staged.length})</h3>
              <div className="space-y-1">
                {staged.map((file, i) => (
                  <div key={i} className="flex items-center justify-between group py-1">
                    <div className="flex items-center gap-2 text-sm truncate">
                      <FileText size={14} className="text-zinc-500" />
                      <span className={isDark ? 'text-zinc-300' : 'text-zinc-700'}>{file}</span>
                    </div>
                    <button 
                      onClick={() => handleUnstage(file)}
                      className="opacity-0 group-hover:opacity-100 p-1 hover:bg-zinc-700 rounded"
                    >
                      <Minus size={14} className="text-zinc-400" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Unstaged Changes */}
          {allUnstaged.length > 0 && (
            <div>
              <h3 className={`text-[11px] font-bold uppercase mb-2 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>Changes ({allUnstaged.length})</h3>
              <div className="space-y-1">
                {allUnstaged.map((file, i) => (
                  <div key={i} className="flex items-center justify-between group py-1">
                    <div className="flex items-center gap-2 text-sm truncate">
                      <FileText size={14} className="text-zinc-500" />
                      <span className={isDark ? 'text-zinc-300' : 'text-zinc-700'}>{file}</span>
                    </div>
                    <button 
                      onClick={() => handleStage(file)}
                      className="opacity-0 group-hover:opacity-100 p-1 hover:bg-zinc-700 rounded"
                    >
                      <Plus size={14} className="text-zinc-400" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {staged.length === 0 && allUnstaged.length === 0 && (
            <p className={`text-sm italic py-4 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>No changes detected</p>
          )}
        </div>
      </div>
    </div>
  )
}
