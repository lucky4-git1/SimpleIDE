import { useState, useEffect, useRef } from 'react'

export default function PromptModal({ isOpen, title, defaultValue, onSubmit, onCancel, isDark }) {
  const [value, setValue] = useState(defaultValue || '')
  const inputRef = useRef(null)

  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue || '')
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isOpen, defaultValue])

  if (!isOpen) return null

  const handleSubmit = (e) => {
    e.preventDefault()
    if (value.trim()) {
      onSubmit(value.trim())
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') onCancel()
  }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div 
        className={`w-full max-w-sm rounded-lg shadow-2xl border p-4 ${
          isDark ? 'bg-[#252526] border-[#333333]' : 'bg-white border-zinc-200'
        }`}
      >
        <h3 className={`text-sm font-semibold mb-3 ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
          {title}
        </h3>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className={`w-full px-3 py-1.5 text-sm border focus:outline-none focus:border-blue-500 rounded ${
              isDark 
                ? 'bg-[#3c3c3c] border-transparent text-zinc-200 focus:bg-[#3c3c3c]' 
                : 'bg-zinc-50 border-zinc-300 text-zinc-900 focus:bg-white'
            }`}
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={onCancel}
              className={`px-3 py-1 text-xs rounded transition-colors ${
                isDark ? 'hover:bg-[#333] text-zinc-300' : 'hover:bg-zinc-100 text-zinc-600'
              }`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!value.trim()}
              className="px-3 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
            >
              Confirm
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
