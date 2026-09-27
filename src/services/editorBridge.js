/**
 * editorBridge.js
 *
 * Direct bridge between SimpleIDE Agent Engine and Monaco Editor instances.
 * Enables zero-reload, incremental executeEdits patching with full undo-stack preservation.
 */

import { PatchEngine } from './agentEngine/PatchEngine.js'

function normalizePath(p) {
  return String(p || '')
    .trim()
    .replace(/^file:\/\/\//i, '')
    .replace(/\\/g, '/')
    .toLowerCase()
}

class MonacoEditorBridge {
  constructor() {
    this.editors = new Map() // normalizedPath -> { editor, monaco, filePath }
    this.listeners = new Set()
  }

  registerEditor(filePath, editor, monaco) {
    if (!filePath || !editor) return
    const key = normalizePath(filePath)
    this.editors.set(key, { editor, monaco, filePath })
  }

  unregisterEditor(filePath, editor) {
    if (!filePath) return
    const key = normalizePath(filePath)
    const existing = this.editors.get(key)
    if (existing && (!editor || existing.editor === editor)) {
      this.editors.delete(key)
    }
  }

  getEditor(filePath) {
    if (!filePath) return null
    return this.editors.get(normalizePath(filePath)) || null
  }

  isEditorOpen(filePath) {
    return this.getEditor(filePath) !== null
  }

  /**
   * Applies structured edits directly to a mounted Monaco editor instance using executeEdits.
   * This updates the editor model in-place, preserves cursor position, and adds a step to the undo stack.
   */
  applyEditsToEditor(filePath, rawEdits, { source = 'prime-agent' } = {}) {
    const entry = this.getEditor(filePath)
    if (!entry || !entry.editor) {
      return { success: false, reason: 'editor_not_open' }
    }

    const { editor, monaco } = entry
    const model = editor.getModel()
    if (!model) {
      return { success: false, reason: 'no_editor_model' }
    }

    try {
      const normalized = PatchEngine.normalizeEdits(rawEdits, model.getValue())
      const monacoEdits = PatchEngine.toMonacoEdits(normalized, monaco)

      if (monacoEdits.length === 0) {
        return { success: true, count: 0 }
      }

      // Execute edits incrementally inside Monaco
      editor.pushUndoStop?.()
      editor.executeEdits(source, monacoEdits)
      editor.pushUndoStop?.()

      this.notifyListeners({
        type: 'edits_applied',
        filePath,
        editsCount: monacoEdits.length,
        source
      })

      return {
        success: true,
        count: monacoEdits.length,
        newContent: model.getValue()
      }
    } catch (err) {
      console.warn(`[editorBridge] Failed to execute edits on ${filePath}:`, err?.message)
      return { success: false, error: err?.message }
    }
  }

  addListener(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notifyListeners(event) {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        console.warn('[editorBridge] Listener error:', err)
      }
    }
  }

  clear() {
    this.editors.clear()
    this.listeners.clear()
  }
}

export const editorBridge = new MonacoEditorBridge()
