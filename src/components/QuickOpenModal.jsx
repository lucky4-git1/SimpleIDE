import { useEffect, useMemo, useRef, useState } from 'react'
import { File, FileCode, Loader2, Search } from 'lucide-react'
import { getLanguageFromFile } from '../utils/language'

const MAX_RESULTS = 80

function getRelativePath(filePath, rootPath) {
  if (!rootPath) return filePath
  const normalizedFile = filePath.replace(/\\/g, '/')
  const normalizedRoot = rootPath.replace(/\\/g, '/')
  if (!normalizedFile.toLowerCase().startsWith(normalizedRoot.toLowerCase())) return filePath
  return normalizedFile.slice(normalizedRoot.length).replace(/^\//, '')
}

function getFileScore(file, query) {
  if (!query) return 1

  const name = file.name.toLowerCase()
  const path = file.relativePath.toLowerCase()
  const lowerQuery = query.toLowerCase()

  if (name === lowerQuery) return 1000
  if (name.startsWith(lowerQuery)) return 800
  if (name.includes(lowerQuery)) return 600
  if (path.includes(lowerQuery)) return 400

  let queryIndex = 0
  for (let i = 0; i < path.length && queryIndex < lowerQuery.length; i++) {
    if (path[i] === lowerQuery[queryIndex]) queryIndex++
  }

  return queryIndex === lowerQuery.length ? 200 + queryIndex : 0
}

function getFileIcon(name) {
  const language = getLanguageFromFile(name)
  return ['javascript', 'typescript', 'python', 'html', 'css', 'json'].includes(language) ? FileCode : File
}

export default function QuickOpenModal({ isOpen, onClose, currentFolder, projectIndex, openFiles, isIndexing, onOpenFile, isDark }) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef(null)

  const files = useMemo(() => {
    const byPath = new Map()
    for (const file of projectIndex) {
      byPath.set(file.path, {
        path: file.path,
        name: file.name,
        relativePath: getRelativePath(file.path, currentFolder),
        isOpen: openFiles.some(openFile => openFile.path === file.path)
      })
    }

    for (const file of openFiles) {
      if (!byPath.has(file.path)) {
        byPath.set(file.path, {
          path: file.path,
          name: file.name,
          relativePath: getRelativePath(file.path, currentFolder),
          isOpen: true
        })
      }
    }

    return [...byPath.values()]
  }, [currentFolder, openFiles, projectIndex])

  const results = useMemo(() => {
    const trimmed = query.trim()
    return files
      .map(file => ({ ...file, score: getFileScore(file, trimmed) }))
      .filter(file => file.score > 0)
      .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
      .slice(0, MAX_RESULTS)
  }, [files, query])

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        setQuery('')
        setSelectedIndex(0)
        inputRef.current?.focus()
      }, 50)
    }
  }, [isOpen])

  const handleQueryChange = (value) => {
    setQuery(value)
    setSelectedIndex(0)
  }

  if (!isOpen) return null

  const openSelected = (file) => {
    if (!file) return
    onOpenFile(file.path)
    onClose()
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(prev => Math.min(prev + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      openSelected(results[selectedIndex])
    }
  }

  return (
    <div className="absolute inset-0 z-[65] flex items-start justify-center bg-black/25 pt-[12vh] backdrop-blur-sm" onClick={onClose}>
      <div
        className={`w-full max-w-2xl overflow-hidden rounded-lg border shadow-2xl ${
          isDark ? 'border-[#454545] bg-[#252526]' : 'border-zinc-300 bg-white'
        }`}
        onClick={e => e.stopPropagation()}
      >
        <div className={`flex items-center gap-2 border-b px-3 py-3 ${isDark ? 'border-[#454545]' : 'border-zinc-200'}`}>
          <Search size={18} className={isDark ? 'text-zinc-400' : 'text-zinc-500'} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search files by name"
            className={`min-w-0 flex-1 bg-transparent text-[15px] outline-none ${
              isDark ? 'text-zinc-200 placeholder-zinc-500' : 'text-zinc-800 placeholder-zinc-400'
            }`}
          />
          {isIndexing && <Loader2 size={16} className="animate-spin text-blue-400" />}
        </div>

        <div className="max-h-[56vh] overflow-y-auto py-1">
          {!currentFolder ? (
            <div className="p-6 text-center text-sm text-zinc-500">Open a folder to quick open files</div>
          ) : results.length === 0 ? (
            <div className="p-6 text-center text-sm text-zinc-500">
              {isIndexing ? 'Indexing workspace...' : 'No matching files'}
            </div>
          ) : (
            results.map((file, index) => {
              const Icon = getFileIcon(file.name)
              const isSelected = index === selectedIndex
              return (
                <button
                  key={file.path}
                  onClick={() => openSelected(file)}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left ${
                    isSelected
                      ? isDark ? 'bg-[#094771] text-white' : 'bg-blue-600 text-white'
                      : isDark ? 'text-zinc-300 hover:bg-[#2a2d2e]' : 'text-zinc-700 hover:bg-zinc-100'
                  }`}
                >
                  <Icon size={16} className={isSelected ? 'text-white' : 'text-blue-400'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{file.name}</span>
                    <span className={`block truncate text-xs ${isSelected ? 'opacity-80' : 'opacity-50'}`}>
                      {file.relativePath}
                    </span>
                  </span>
                  {file.isOpen && (
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${isSelected ? 'bg-white/20 text-white' : isDark ? 'bg-blue-500/15 text-blue-300' : 'bg-blue-100 text-blue-700'}`}>
                      open
                    </span>
                  )}
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
