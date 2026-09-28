/**
 * inlineDiffService.js
 *
 * Manages inline AI diff experiences in Monaco:
 * - Green highlights for insertions and modifications.
 * - Red highlights and view-zone displays for deletions.
 * - Floating inline accept / reject widget.
 * - Keyboard shortcuts: Ctrl+Shift+Y to accept, Ctrl+Shift+N to reject.
 * - Multi-file session tracking and persistence.
 */

import { PatchEngine } from './agentEngine/PatchEngine.js'
import { editorBridge } from './editorBridge.js'

function normalizePath(p) {
  return String(p || '')
    .trim()
    .replace(/^file:\/\/\//i, '')
    .replace(/\\/g, '/')
    .toLowerCase()
}

/**
 * Computes line-level diff hunks between before and after text.
 */
export function computeLineDiff(beforeText = '', afterText = '') {
  const beforeLines = String(beforeText || '').split(/\r?\n/)
  const afterLines = String(afterText || '').split(/\r?\n/)

  // Prefix match
  let prefix = 0
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++
  }

  // Suffix match
  let suffixBefore = beforeLines.length - 1
  let suffixAfter = afterLines.length - 1
  while (
    suffixBefore >= prefix &&
    suffixAfter >= prefix &&
    beforeLines[suffixBefore] === afterLines[suffixAfter]
  ) {
    suffixBefore--
    suffixAfter--
  }

  const deletedLines = beforeLines.slice(prefix, suffixBefore + 1)
  const insertedLines = afterLines.slice(prefix, suffixAfter + 1)

  const startLine = prefix + 1
  const endLine = Math.max(startLine, startLine + insertedLines.length - 1)

  return {
    startLine,
    endLine: insertedLines.length > 0 ? endLine : startLine,
    insertedCount: insertedLines.length,
    deletedCount: deletedLines.length,
    deletedText: deletedLines.join('\n'),
    insertedText: insertedLines.join('\n'),
    hasChanges: insertedLines.length > 0 || deletedLines.length > 0
  }
}

export class InlineDiffService {
  constructor() {
    this.sessions = new Map() // key -> session
    this.listeners = new Set()
  }

  hasActiveDiff(filePath) {
    return this.sessions.has(normalizePath(filePath))
  }

  getActiveDiff(filePath) {
    return this.sessions.get(normalizePath(filePath)) || null
  }

  getAllActiveDiffs() {
    return [...this.sessions.values()]
  }

  /**
   * Shows inline diff decorations and floating widget in Monaco.
   */
  showDiff(filePath, before, after, options = {}) {
    const key = normalizePath(filePath)
    const diff = computeLineDiff(before, after)

    if (!diff.hasChanges && !options.force) {
      this.clearDiff(filePath)
      return null
    }

    // Clean up any existing session for this file
    this.clearDecorations(filePath)

    const session = {
      filePath,
      key,
      before,
      after,
      patch: options.patch || PatchEngine.createPatch(filePath, before, after),
      edits: options.edits || [],
      diff,
      decorationIds: [],
      widget: null,
      viewZoneId: null,
      onAccept: options.onAccept,
      onReject: options.onReject,
      timestamp: Date.now()
    }

    this.sessions.set(key, session)

    // Render in active Monaco editor if mounted
    const entry = editorBridge.getEditor(filePath)
    if (entry && entry.editor) {
      this.renderDiffInEditor(entry.editor, entry.monaco, session)
    }

    this.notify({ type: 'diff_shown', filePath, session })
    return session
  }

  /**
   * Renders decorations, view zones, and floating accept/reject widget on editor instance.
   */
  renderDiffInEditor(editor, monaco, session) {
    if (!editor || !monaco || !session) return
    const model = editor.getModel()
    if (!model) return

    const { diff } = session
    const decorations = []

    // 1. Insertions / modified lines decorations
    if (diff.insertedCount > 0) {
      decorations.push({
        range: new monaco.Range(
          diff.startLine,
          1,
          diff.endLine,
          model.getLineMaxColumn(Math.min(model.getLineCount(), diff.endLine))
        ),
        options: {
          isWholeLine: true,
          className: 'inline-diff-insert-line',
          marginClassName: 'inline-diff-insert-gutter',
          overviewRuler: {
            color: 'rgba(34, 197, 94, 0.8)',
            position: monaco.editor.OverviewRulerLane?.Right || 4
          },
          hoverMessage: {
            value: `**AI Modification** (+${diff.insertedCount}, -${diff.deletedCount})\n\nPress **Ctrl+Shift+Y** to Accept or **Ctrl+Shift+N** to Reject.`
          }
        }
      })
    }

    // Apply decorations
    session.decorationIds = editor.deltaDecorations(session.decorationIds || [], decorations)

    // 2. Deleted lines display via Monaco ViewZone (if lines were deleted)
    if (diff.deletedCount > 0) {
      editor.changeViewZones(changeAccessor => {
        if (session.viewZoneId) {
          changeAccessor.removeZone(session.viewZoneId)
          session.viewZoneId = null
        }

        const domNode = createDomElement('div', 'inline-diff-delete-zone')
        domNode.innerHTML = `
          <div class="inline-diff-delete-zone-header">
            <span class="inline-diff-delete-tag">− ${diff.deletedCount} removed</span>
          </div>
          <pre class="inline-diff-delete-text">${escapeHtml(diff.deletedText)}</pre>
        `

        const lineCount = Math.min(10, diff.deletedCount)
        session.viewZoneId = changeAccessor.addZone({
          afterLineNumber: Math.max(0, diff.startLine - 1),
          heightInLines: Math.max(2, lineCount + 1),
          domNode
        })
      })
    }

    // 3. Floating Content Widget (Accept / Reject)
    this.createContentWidget(editor, monaco, session)

    // 4. Keyboard Shortcuts registered directly in Monaco
    this.registerEditorShortcuts(editor, monaco, session.filePath)
  }

  createContentWidget(editor, monaco, session) {
    if (session.widget) {
      try { editor.removeContentWidget(session.widget) } catch {}
      session.widget = null
    }

    const { diff, filePath } = session
    const widgetId = `inline-diff-widget-${session.key}`

    const domNode = createDomElement('div', 'inline-diff-widget')
    domNode.innerHTML = `
      <div class="inline-diff-widget-badge">
        <span class="inline-diff-sparkle">✦</span>
        <span class="inline-diff-title">AI Suggestion</span>
        <span class="inline-diff-stats">+${diff.insertedCount} −${diff.deletedCount}</span>
      </div>
      <div class="inline-diff-widget-actions">
        <button class="inline-diff-btn inline-diff-btn-accept" title="Accept edit (Ctrl+Shift+Y)">
          Accept <span class="inline-diff-key">Ctrl+Shift+Y</span>
        </button>
        <button class="inline-diff-btn inline-diff-btn-reject" title="Reject edit (Ctrl+Shift+N)">
          Reject <span class="inline-diff-key">Ctrl+Shift+N</span>
        </button>
      </div>
    `

    // Click handlers
    const acceptBtn = domNode.querySelector('.inline-diff-btn-accept')
    const rejectBtn = domNode.querySelector('.inline-diff-btn-reject')

    acceptBtn?.addEventListener('click', (e) => {
      e.stopPropagation()
      this.acceptDiff(filePath)
    })

    rejectBtn?.addEventListener('click', (e) => {
      e.stopPropagation()
      this.rejectDiff(filePath)
    })

    const widget = {
      getId: () => widgetId,
      getDomNode: () => domNode,
      getPosition: () => ({
        position: {
          lineNumber: Math.max(1, diff.startLine),
          column: 1
        },
        preference: [
          monaco.editor.ContentWidgetPositionPreference?.ABOVE || 1,
          monaco.editor.ContentWidgetPositionPreference?.BELOW || 2
        ]
      })
    }

    editor.addContentWidget(widget)
    session.widget = widget
  }

  registerEditorShortcuts(editor, monaco, filePath) {
    if (editor._diffShortcutsRegistered) return
    editor._diffShortcutsRegistered = true

    // Ctrl+Shift+Y -> Accept
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyY,
      () => {
        if (this.hasActiveDiff(filePath)) {
          this.acceptDiff(filePath)
        }
      }
    )

    // Ctrl+Shift+N -> Reject
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyN,
      () => {
        if (this.hasActiveDiff(filePath)) {
          this.rejectDiff(filePath)
        }
      }
    )
  }

  /**
   * Accepts the diff: removes decorations and widget, keeps current code.
   */
  async acceptDiff(filePath) {
    const key = normalizePath(filePath)
    const session = this.sessions.get(key)
    if (!session) return { success: false, reason: 'no_session' }

    this.clearDecorations(filePath)
    this.sessions.delete(key)

    try {
      if (session.onAccept) {
        await session.onAccept(session)
      }
    } catch (err) {
      console.warn(`[inlineDiffService] Error in onAccept callback for ${filePath}:`, err)
    }

    this.notify({ type: 'diff_accepted', filePath, session })
    return { success: true, filePath }
  }

  /**
   * Rejects the diff: reverts content in editor, store, and on disk.
   */
  async rejectDiff(filePath) {
    const key = normalizePath(filePath)
    const session = this.sessions.get(key)
    if (!session) return { success: false, reason: 'no_session' }

    const { before } = session

    // Revert editor model
    const entry = editorBridge.getEditor(filePath)
    if (entry && entry.editor) {
      const model = entry.editor.getModel()
      if (model) {
        entry.editor.pushUndoStop?.()
        entry.editor.executeEdits('prime-agent-reject', [{
          range: model.getFullModelRange(),
          text: before
        }])
        entry.editor.pushUndoStop?.()
      }
    }

    this.clearDecorations(filePath)
    this.sessions.delete(key)

    try {
      if (session.onReject) {
        await session.onReject(session)
      }
    } catch (err) {
      console.warn(`[inlineDiffService] Error in onReject callback for ${filePath}:`, err)
    }

    this.notify({ type: 'diff_rejected', filePath, before, session })
    return { success: true, filePath, revertedTo: before }
  }

  /**
   * Removes decorations, view zones, and widgets for a file.
   */
  clearDecorations(filePath) {
    const key = normalizePath(filePath)
    const session = this.sessions.get(key)
    if (!session) return

    const entry = editorBridge.getEditor(filePath)
    if (entry && entry.editor) {
      // Clear decorations
      if (session.decorationIds && session.decorationIds.length > 0) {
        session.decorationIds = entry.editor.deltaDecorations(session.decorationIds, [])
      }

      // Clear view zone
      if (session.viewZoneId) {
        entry.editor.changeViewZones(changeAccessor => {
          changeAccessor.removeZone(session.viewZoneId)
        })
        session.viewZoneId = null
      }

      // Clear content widget
      if (session.widget) {
        try { entry.editor.removeContentWidget(session.widget) } catch {}
        session.widget = null
      }
    }
  }

  clearDiff(filePath) {
    this.clearDecorations(filePath)
    this.sessions.delete(normalizePath(filePath))
    this.notify({ type: 'diff_cleared', filePath })
  }

  clearAll() {
    for (const key of this.sessions.keys()) {
      this.clearDecorations(key)
    }
    this.sessions.clear()
    this.notify({ type: 'diff_cleared_all' })
  }

  /**
   * Called when an editor mounts or switches to render pending diffs.
   */
  attachToEditor(filePath, editor, monaco) {
    const session = this.getActiveDiff(filePath)
    if (session) {
      this.renderDiffInEditor(editor, monaco, session)
    }
  }

  detachFromEditor(filePath, editor) {
    const session = this.getActiveDiff(filePath)
    if (session && session.widget) {
      try { editor?.removeContentWidget(session.widget) } catch {}
      session.widget = null
    }
  }

  addListener(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify(event) {
    for (const listener of this.listeners) {
      try { listener(event) } catch (err) { console.warn('[inlineDiffService] Listener error:', err) }
    }
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function createDomElement(tag, className = '') {
  if (typeof document !== 'undefined') {
    const el = document.createElement(tag)
    if (className) el.className = className
    return el
  }
  return {
    className,
    innerHTML: '',
    children: [],
    style: {},
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => []
  }
}

export const inlineDiffService = new InlineDiffService()
