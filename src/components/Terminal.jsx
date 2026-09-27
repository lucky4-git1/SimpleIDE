import { Terminal as TerminalIcon, Trash2, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react'
import { useRef, useEffect, useState } from 'react'

export default function Terminal({ output, onClear, onRunCommand, isDark, isOpen, onToggle }) {
  const scrollRef = useRef(null)
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState([])
  const [historyIndex, setHistoryIndex] = useState(-1)

  useEffect(() => {
    if (scrollRef.current && isOpen) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [output, isOpen])

  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      onClear()
    } else if (e.key === 'Enter' && command.trim()) {
      const cmd = command.trim()
      if (cmd === 'clear') {
        onClear()
      } else {
        onRunCommand(cmd)
      }
      setHistory(prev => [...prev, cmd])
      setHistoryIndex(-1)
      setCommand('')
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (history.length > 0) {
        const nextIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1)
        setHistoryIndex(nextIndex)
        setCommand(history[nextIndex])
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIndex !== -1) {
        const nextIndex = historyIndex + 1
        if (nextIndex >= history.length) {
          setHistoryIndex(-1)
          setCommand('')
        } else {
          setHistoryIndex(nextIndex)
          setCommand(history[nextIndex])
        }
      }
    }
  }

  return (
    <div className={`flex flex-col h-full ${isDark ? 'bg-[#1e1e1e]' : 'bg-white'}`}>
      <div className={`flex items-center justify-between px-4 py-1.5 border-b ${isDark ? 'border-[#333333] bg-[#252526]' : 'border-zinc-200 bg-zinc-50'}`}>
        <div className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>
          <TerminalIcon size={14} />
          Integrated Terminal
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onToggle}
            className={`p-1 rounded transition-colors ${isDark ? 'text-zinc-400 hover:text-white hover:bg-[#333333]' : 'text-zinc-500 hover:text-black hover:bg-zinc-200'}`}
            title={isOpen ? "Minimize" : "Expand"}
          >
            {isOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
          <button
            onClick={onClear}
            className={`p-1 rounded transition-colors ${isDark ? 'text-zinc-400 hover:text-white hover:bg-[#333333]' : 'text-zinc-500 hover:text-black hover:bg-zinc-200'}`}
            title="Clear Output"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {isOpen && (
        <>
          <div 
            ref={scrollRef}
            className={`flex-1 p-4 font-mono text-sm overflow-y-auto whitespace-pre-wrap ${isDark ? 'text-zinc-300' : 'text-zinc-800'}`}
          >
            {output || <span className="text-zinc-600 italic">No output yet...</span>}
          </div>
          <div className={`flex items-center px-2 py-1 border-t ${isDark ? 'bg-[#252526] border-[#333333]' : 'bg-zinc-50 border-zinc-200'}`}>
            <ChevronRight size={16} className="text-zinc-500 mr-1" />
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a command…  (↑↓ history, Ctrl+L clear)"
              className={`flex-1 bg-transparent font-mono text-sm focus:outline-none ${isDark ? 'text-zinc-300 placeholder-zinc-600' : 'text-zinc-800 placeholder-zinc-400'}`}
            />
          </div>
        </>
      )}
    </div>
  )
}
