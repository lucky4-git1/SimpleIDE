import MonacoEditor, { DiffEditor } from '@monaco-editor/react'
import { useRef, useEffect } from 'react'
import { getLanguageFromFile } from '../utils/language'
import { getInlineCompletions } from '../services/autocompleteService'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import { editorBridge } from '../services/editorBridge'
import { inlineDiffService } from '../services/inlineDiffService'

export default function Editor({ file, revealLine, revealKey }) {
  const editorRef = useRef(null)
  const monacoRef = useRef(null)
  const isDark = useUIStore((state) => state.isDark)
  const updateFileContent = useEditorStore((state) => state.updateFileContent)
  const setCursorPosition = useEditorStore((state) => state.setCursorPosition)
  const setSelectedCode = useEditorStore((state) => state.setSelectedCode)
  const setMarkers = useEditorStore((state) => state.setMarkers)

  useEffect(() => {
    if (!revealLine || !editorRef.current) return

    editorRef.current.revealLineInCenter(revealLine)
    editorRef.current.setPosition({ lineNumber: revealLine, column: 1 })
    editorRef.current.focus()
  }, [file?.path, revealLine, revealKey])

  const handleEditorDidMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    const model = editor.getModel()

    if (file?.path) {
      editorBridge.registerEditor(file.path, editor, monaco)
      inlineDiffService.attachToEditor(file.path, editor, monaco)
    }

    // Listen for markers (errors/warnings)
    monaco.editor.onDidChangeMarkers(([uri]) => {
      if (uri.toString() === model?.uri?.toString()) {
        const markers = monaco.editor.getModelMarkers({ resource: uri })
        setMarkers(markers)
      }
    })

    // Register Inline Completion Provider
    const provider = monaco.languages.registerInlineCompletionsProvider(
      getLanguageFromFile(file.name),
      {
        provideInlineCompletions: async (model, position) => {
          const textBefore = model.getValueInRange({
            startLineNumber: Math.max(1, position.lineNumber - 10),
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column
          })
          const textAfter = model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: Math.min(model.getLineCount(), position.lineNumber + 5),
            endColumn: model.getLineMaxColumn(Math.min(model.getLineCount(), position.lineNumber + 5))
          })

          const completion = await getInlineCompletions(textBefore, textAfter)
          
          if (!completion) return { items: [] }

          return {
            items: [
              {
                insertText: completion,
                range: {
                  startLineNumber: position.lineNumber,
                  startColumn: position.column,
                  endLineNumber: position.lineNumber,
                  endColumn: position.column
                }
              }
            ]
          }
        },
        freeInlineCompletions: () => {}
      }
    )

    editor.onDidChangeCursorPosition((e) => {
      setCursorPosition({
        lineNumber: e.position.lineNumber,
        column: e.position.column
      })
    })

    // Track text selection changes
    editor.onDidChangeCursorSelection(() => {
      const selection = editor.getSelection()
      const selectedText = editor.getModel()?.getValueInRange(selection) || ''
      setSelectedCode(selectedText)
    })

    return () => {
      provider.dispose()
      if (file?.path) {
        inlineDiffService.detachFromEditor(file.path, editor)
        editorBridge.unregisterEditor(file.path, editor)
      }
    }
  }

  useEffect(() => {
    return () => {
      if (file?.path && editorRef.current) {
        inlineDiffService.detachFromEditor(file.path, editorRef.current)
        editorBridge.unregisterEditor(file.path, editorRef.current)
      }
    }
  }, [file?.path])

  const handleChange = (value) => {
    if (file?.path) {
      updateFileContent(file.path, value || '')
    }
  }

  if (!file) return null

  if (file.isDiff) {
    return (
      <div className="absolute inset-0 flex flex-col bg-[#1e1e1e]">
        {/* Diff Review Bar */}
        <div className="flex items-center justify-between px-4 py-2 bg-[#252526] border-b border-white/10 text-xs select-none">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-cyan-400">Diff Review:</span>
            <span className="font-mono text-zinc-200">{file.originalPath || file.name}</span>
            <span className="text-[10px] text-zinc-400">(Original on left · Proposed patch on right)</span>
          </div>
          <div className="flex items-center gap-2">
            {file.onReject && (
              <button
                type="button"
                onClick={() => file.onReject()}
                className="flex items-center gap-1 px-3 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 text-xs font-medium cursor-pointer transition-colors"
                title="Reject patch and restore original file"
              >
                Reject Patch
              </button>
            )}
            {file.onAccept && (
              <button
                type="button"
                onClick={() => file.onAccept()}
                className="flex items-center gap-1 px-3 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 text-xs font-medium cursor-pointer transition-colors"
                title="Accept and apply patch"
              >
                Accept Patch
              </button>
            )}
          </div>
        </div>

        {/* Side-by-Side Monaco Diff Editor */}
        <div className="flex-1 relative">
          <DiffEditor
            height="100%"
            width="100%"
            theme={isDark ? "vs-dark" : "light"}
            original={file.original || ''}
            modified={file.modified || file.content || ''}
            language={getLanguageFromFile(file.originalPath || file.name)}
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              fontSize: 14,
              fontLigatures: true,
              wordWrap: 'on',
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              automaticLayout: true,
              padding: { top: 12 }
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="absolute inset-0">
      <MonacoEditor
        height="100%"
        width="100%"
        theme={isDark ? "vs-dark" : "light"}
        path={file.path}
        language={getLanguageFromFile(file.name)}
        value={file.content}
        onChange={handleChange}
        onMount={handleEditorDidMount}
        options={{
          minimap: { enabled: false },
          fontSize: 14,
          fontLigatures: true,
          wordWrap: 'on',
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          automaticLayout: true,
          padding: { top: 16 },
          bracketPairColorization: { enabled: true },
          guides: { bracketPairs: 'active', indentation: true },
          stickyScroll: { enabled: true },
          renderWhitespace: 'selection',
          cursorSmoothCaretAnimation: 'on',
          inlineSuggest: { enabled: true },
          suggestOnTriggerCharacters: true,
        }}
      />
    </div>
  )
}
