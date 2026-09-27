import { useState, useEffect, useRef } from 'react'
import { Command, ChevronRight } from 'lucide-react'

function getCommandScore(cmd, query) {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return 1

  const name = cmd.name.toLowerCase()
  const description = cmd.description?.toLowerCase() || ''
  const keywords = cmd.keywords?.join(' ').toLowerCase() || ''
  const haystack = `${name} ${description} ${keywords}`

  if (name === trimmed) return 1000
  if (name.startsWith(trimmed)) return 800
  if (name.includes(trimmed)) return 600
  if (haystack.includes(trimmed)) return 400

  const tokens = trimmed.split(/\s+/).filter(Boolean)
  return tokens.every(token => haystack.includes(token)) ? 250 : 0
}

export default function CommandPalette({ isOpen, onClose, commands, isDark }) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef(null)
  
  const filteredCommands = commands
    .map(cmd => ({ ...cmd, score: getCommandScore(cmd, query) }))
    .filter(cmd => cmd.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))

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

  const executeCommand = (cmd) => {
    onClose()
    cmd.action()
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(prev => Math.min(prev + 1, filteredCommands.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filteredCommands[selectedIndex]) {
        executeCommand(filteredCommands[selectedIndex])
      }
    }
  }

  return (
    <div className="absolute inset-0 z-[60] flex items-start justify-center pt-[15vh] bg-black/20 backdrop-blur-sm" onClick={onClose}>
      <div 
        className={`w-full max-w-2xl rounded-lg shadow-2xl border flex flex-col overflow-hidden ${
          isDark ? 'bg-[#252526] border-[#454545]' : 'bg-white border-zinc-300'
        }`}
        onClick={e => e.stopPropagation()}
      >
        <div className={`flex items-center px-3 py-3 border-b ${isDark ? 'border-[#454545]' : 'border-zinc-200'}`}>
          <ChevronRight size={18} className={isDark ? 'text-zinc-400' : 'text-zinc-500'} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            className={`flex-1 bg-transparent px-2 outline-none text-[15px] ${
              isDark ? 'text-zinc-200 placeholder-zinc-500' : 'text-zinc-800 placeholder-zinc-400'
            }`}
          />
        </div>
        
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {filteredCommands.length === 0 ? (
            <div className={`p-4 text-sm text-center ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              No matching commands
            </div>
          ) : (
            filteredCommands.map((cmd, i) => (
              <div 
                key={i}
                onClick={() => executeCommand(cmd)}
                className={`flex flex-col px-4 py-2 cursor-pointer ${
                  i === selectedIndex
                    ? (isDark ? 'bg-[#094771] text-white' : 'bg-blue-600 text-white')
                    : (isDark ? 'text-zinc-300 hover:bg-[#2a2d2e]' : 'text-zinc-700 hover:bg-zinc-100')
                }`}
              >
                <div className="flex items-center gap-2">
                  <Command size={14} className={i === selectedIndex ? 'opacity-100' : 'opacity-50'} />
                  <span className="min-w-0 flex-1 truncate text-sm">{cmd.name}</span>
                  {cmd.shortcut && (
                    <span className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${i === selectedIndex ? 'bg-white/15 text-white' : isDark ? 'bg-black/20 text-zinc-500' : 'bg-zinc-100 text-zinc-500'}`}>
                      {cmd.shortcut}
                    </span>
                  )}
                </div>
                {cmd.description && (
                  <div className={`text-xs mt-0.5 ml-6 ${i === selectedIndex ? 'opacity-80' : 'opacity-50'}`}>
                    {cmd.description}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
