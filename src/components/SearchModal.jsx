import { useState, useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'

export default function SearchModal({ isOpen, onClose, openFiles, onSelectFile, isDark }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const inputRef = useRef(null)

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50)
      setQuery('')
      setResults([])
    }
  }, [isOpen])

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }
    
    const lowerQuery = query.toLowerCase()
    const matches = []
    
    for (const file of openFiles) {
      const lines = file.content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(lowerQuery)) {
          matches.push({
            file,
            line: i + 1,
            content: lines[i].trim()
          })
          if (matches.length > 50) break // limit results
        }
      }
    }
    setResults(matches)
  }, [query, openFiles])

  if (!isOpen) return null

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') onClose()
  }

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center pt-20 bg-black/40 backdrop-blur-sm">
      <div 
        className={`w-full max-w-2xl rounded-lg shadow-2xl border flex flex-col max-h-[70vh] overflow-hidden ${
          isDark ? 'bg-[#252526] border-[#333333]' : 'bg-white border-zinc-200'
        }`}
      >
        <div className={`flex items-center px-4 py-3 border-b ${isDark ? 'border-[#333333]' : 'border-zinc-200'}`}>
          <Search size={18} className={isDark ? 'text-zinc-400' : 'text-zinc-500'} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search across open files..."
            className={`flex-1 bg-transparent px-3 outline-none text-sm ${
              isDark ? 'text-zinc-200 placeholder-zinc-500' : 'text-zinc-800 placeholder-zinc-400'
            }`}
          />
          <button onClick={onClose} className={`p-1 rounded ${isDark ? 'hover:bg-[#333] text-zinc-400' : 'hover:bg-zinc-100 text-zinc-500'}`}>
            <X size={16} />
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto">
          {results.length === 0 && query.trim() ? (
            <div className={`p-4 text-sm text-center ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              No matches found
            </div>
          ) : (
            results.map((result, i) => (
              <div 
                key={i}
                onClick={() => {
                  onSelectFile(result.file.path)
                  onClose()
                }}
                className={`flex flex-col px-4 py-2 cursor-pointer border-b ${
                  isDark 
                    ? 'border-[#333] hover:bg-[#2a2d2e]' 
                    : 'border-zinc-100 hover:bg-zinc-50'
                }`}
              >
                <div className={`text-xs font-semibold ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>
                  {result.file.name} <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>line {result.line}</span>
                </div>
                <div className={`text-sm truncate font-mono mt-1 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                  {result.content}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
