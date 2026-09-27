import MonacoEditor from '@monaco-editor/react'
import { useRef, useEffect } from 'react'
import { getLanguageFromFile } from '../utils/language'
import { getInlineCompletions } from '../services/autocompleteService'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import { editorBridge } from '../services/editorBridge'

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
        editorBridge.unregisterEditor(file.path, editor)
      }
    }
  }

  useEffect(() => {
    return () => {
      if (file?.path && editorRef.current) {
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
