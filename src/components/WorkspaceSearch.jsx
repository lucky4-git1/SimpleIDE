import { useEffect, useMemo, useRef, useState } from 'react'
import { FileSearch, Loader2, Search, X } from 'lucide-react'

const MAX_RESULTS = 200

function getRelativePath(filePath, rootPath) {
  if (!rootPath) return filePath
  const normalizedFile = filePath.replace(/\\/g, '/')
  const normalizedRoot = rootPath.replace(/\\/g, '/')
  if (!normalizedFile.toLowerCase().startsWith(normalizedRoot.toLowerCase())) return filePath
  return normalizedFile.slice(normalizedRoot.length).replace(/^\//, '')
}

function highlightMatch(text, query, isDark) {
  const index = text.toLowerCase().indexOf(query.toLowerCase())
  if (index === -1) return text

  return (
    <>
      {text.slice(0, index)}
      <mark className={isDark ? 'bg-yellow-500/30 text-yellow-100' : 'bg-yellow-200 text-zinc-900'}>
        {text.slice(index, index + query.length)}
      </mark>
      {text.slice(index + query.length)}
    </>
  )
}

export default function WorkspaceSearch({ currentFolder, projectIndex, isIndexing, onOpenResult, isDark }) {
  const [query, setQuery] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const results = useMemo(() => {
    const trimmed = query.trim()
    if (!trimmed || !projectIndex.length) return []

    const matches = []
    const lowerQuery = trimmed.toLowerCase()

    for (const file of projectIndex) {
      const relativePath = getRelativePath(file.path, currentFolder)
      const pathMatch = relativePath.toLowerCase().includes(lowerQuery)
      const lines = file.content.split('\n')

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.toLowerCase().includes(lowerQuery)) {
          matches.push({
            file,
            relativePath,
            lineNumber: i + 1,
            preview: line.trim() || line
          })
        }

        if (matches.length >= MAX_RESULTS) return matches
      }

      if (pathMatch && !matches.some(result => result.file.path === file.path)) {
        matches.push({
          file,
          relativePath,
          lineNumber: 1,
          preview: 'File name match'
        })
      }

      if (matches.length >= MAX_RESULTS) return matches
    }

    return matches
  }, [currentFolder, projectIndex, query])

  return (
    <div className={`flex h-full flex-col ${isDark ? 'bg-[#252526] text-zinc-300' : 'bg-[#f3f3f3] text-zinc-700'}`}>
      <div className={`flex items-center justify-between px-4 py-2 border-b ${isDark ? 'border-[#333333]' : 'border-[#dddddd]'}`}>
        <span className={`text-xs font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>Search</span>
        {isIndexing && <Loader2 size={14} className="animate-spin text-blue-400" />}
      </div>

      <div className="p-3">
        <div className={`flex items-center gap-2 rounded border px-2 py-1.5 ${isDark ? 'border-[#3a3a3a] bg-[#1e1e1e]' : 'border-zinc-300 bg-white'}`}>
          <Search size={15} className={isDark ? 'text-zinc-500' : 'text-zinc-400'} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workspace"
            className={`min-w-0 flex-1 bg-transparent text-sm outline-none ${isDark ? 'placeholder-zinc-600 text-zinc-200' : 'placeholder-zinc-400 text-zinc-900'}`}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className={`rounded p-0.5 ${isDark ? 'text-zinc-500 hover:bg-[#333] hover:text-zinc-200' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700'}`}
              title="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {!currentFolder ? (
          <div className="px-4 py-8 text-center text-sm text-zinc-500">Open a folder to search</div>
        ) : !query.trim() ? (
          <div className="px-4 py-8 text-center text-sm text-zinc-500">Type to search files and content</div>
        ) : results.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-zinc-500">
            {isIndexing ? 'Indexing workspace...' : 'No matches found'}
          </div>
        ) : (
          <div className="pb-3">
            <div className={`px-4 pb-2 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {results.length === MAX_RESULTS ? `${MAX_RESULTS}+` : results.length} results
            </div>
            {results.map((result, index) => (
              <button
                key={`${result.file.path}:${result.lineNumber}:${index}`}
                onClick={() => onOpenResult(result.file.path, result.lineNumber)}
                className={`group flex w-full flex-col px-4 py-2 text-left text-sm border-l-2 border-transparent ${
                  isDark ? 'hover:bg-[#2a2d2e] hover:border-blue-400' : 'hover:bg-[#e8e8e8] hover:border-blue-500'
                }`}
              >
                <span className={`flex min-w-0 items-center gap-1.5 font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                  <FileSearch size={14} className="shrink-0 text-blue-400" />
                  <span className="truncate">{result.relativePath}</span>
                </span>
                <span className={`mt-1 truncate font-mono text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                  <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>{result.lineNumber}: </span>
                  {highlightMatch(result.preview, query.trim(), isDark)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
