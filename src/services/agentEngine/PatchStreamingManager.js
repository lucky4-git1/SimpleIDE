/**
 * PatchStreamingManager.js
 *
 * Implements Phase 7: Patch Streaming
 * - Streams progressive edit hunks into Monaco as LLM tokens arrive.
 * - Prevents premature disk persistence of partially streamed edits.
 * - Enforces validation before final commit.
 * - Reverts preview on stream cancellation or parse failure.
 */

import { PatchEngine } from './PatchEngine.js'
import { editorBridge } from '../editorBridge.js'
import { inlineDiffService } from '../inlineDiffService.js'

export class PatchStreamingManager {
  constructor(filePath, originalContent, { api, onChange, onComplete, onError } = {}) {
    this.filePath = filePath
    this.originalContent = String(originalContent || '')
    this.currentPreviewContent = this.originalContent
    this.api = api || globalThis.window?.api
    this.onChange = onChange
    this.onComplete = onComplete
    this.onError = onError

    this.rawBuffer = ''
    this.appliedHunks = []
    this.completedHunkCount = 0
    this.isValid = true
    this.isFinalized = false
    this.isAborted = false
  }

  /**
   * Feeds a streaming text chunk (e.g. from an LLM stream or tool argument delta).
   */
  feedChunk(chunk) {
    if (this.isFinalized || this.isAborted) return
    this.rawBuffer += String(chunk || '')

    // Attempt to extract complete edit objects from streaming buffer
    this.tryApplyProgressiveEdits()
  }

  /**
   * Attempts to parse completed edit objects from the accumulated buffer.
   * Format may be JSON array `[ { "startLine": 10, "endLine": 12, "replacement": "..." } ]`
   * or individual patch hunks.
   */
  tryApplyProgressiveEdits() {
    const candidateEdits = this.extractCompletedEdits(this.rawBuffer)
    if (candidateEdits.length > this.completedHunkCount) {
      const newEdits = candidateEdits.slice(this.completedHunkCount)
      for (const edit of newEdits) {
        try {
          // Validate range against original document
          const updated = PatchEngine.applyEdits(this.currentPreviewContent, [edit])
          this.currentPreviewContent = updated
          this.appliedHunks.push(edit)
          this.completedHunkCount++

          // Render progressive preview in Monaco if open
          if (editorBridge.isEditorOpen(this.filePath)) {
            editorBridge.applyEditsToEditor(this.filePath, [edit], { source: 'prime-patch-stream' })
          }

          this.onChange?.({
            filePath: this.filePath,
            previewContent: this.currentPreviewContent,
            hunk: edit,
            progressCount: this.completedHunkCount
          })
        } catch (err) {
          // If hunk validation fails, mark as invalid and record error
          this.isValid = false
          console.warn(`[PatchStreamingManager] Progressive edit validation failed on ${this.filePath}:`, err?.message)
          break
        }
      }
    }
  }

  /**
   * Extracts fully closed JSON edit objects from the raw streaming buffer.
   */
  extractCompletedEdits(buffer) {
    const edits = []
    // Match complete JSON objects inside an array: { ... }
    const objectRegex = /\{[^{}]*"(?:startLine|line|type)"[^{}]*\}/g
    let match
    while ((match = objectRegex.exec(buffer)) !== null) {
      try {
        const parsed = JSON.parse(match[0])
        if (parsed && (parsed.startLine !== undefined || parsed.line !== undefined || parsed.replacement !== undefined)) {
          edits.push(parsed)
        }
      } catch {
        // Incomplete JSON fragment, continue streaming
      }
    }
    return edits
  }

  /**
   * Finalizes the stream: validates the complete patch, commits to disk,
   * logs changes, and triggers the inline diff experience.
   */
  async finalize(finalContentOverride = null) {
    if (this.isFinalized || this.isAborted) return null
    this.isFinalized = true

    let finalContent = finalContentOverride !== null ? String(finalContentOverride) : this.currentPreviewContent

    // Final full patch validation
    if (!this.isValid || !finalContent) {
      await this.abort(new Error('Invalid or incomplete streaming patch'))
      return null
    }

    try {
      // 1. Persist final validated content to disk
      if (this.api?.writeFile) {
        const writeRes = await this.api.writeFile(this.filePath, finalContent)
        if (!writeRes.success) {
          throw new Error(writeRes.error || 'Failed to persist streamed patch to disk')
        }
      }

      // 2. Ensure Monaco has final content
      if (editorBridge.isEditorOpen(this.filePath)) {
        const entry = editorBridge.getEditor(this.filePath)
        if (entry?.editor?.getModel()?.getValue() !== finalContent) {
          entry.editor.executeEdits('prime-patch-finalize', [{
            range: entry.editor.getModel().getFullModelRange(),
            text: finalContent
          }])
        }
      }

      // 3. Trigger visual inline diff experience
      if (this.originalContent !== finalContent) {
        inlineDiffService.showDiff(this.filePath, this.originalContent, finalContent, {
          edits: this.appliedHunks
        })
      }

      const result = {
        success: true,
        filePath: this.filePath,
        content: finalContent,
        hunksApplied: this.appliedHunks.length
      }

      this.onComplete?.(result)
      return result
    } catch (err) {
      await this.abort(err)
      throw err
    }
  }

  /**
   * Reverts any progressive ephemeral edits in Monaco and restores original state.
   */
  async abort(reason = null) {
    if (this.isAborted) return
    this.isAborted = true

    // Revert Monaco editor model if it was partially modified
    if (editorBridge.isEditorOpen(this.filePath)) {
      const entry = editorBridge.getEditor(this.filePath)
      const model = entry?.editor?.getModel()
      if (model && model.getValue() !== this.originalContent) {
        entry.editor.pushUndoStop?.()
        entry.editor.executeEdits('prime-patch-abort', [{
          range: model.getFullModelRange(),
          text: this.originalContent
        }])
        entry.editor.pushUndoStop?.()
      }
    }

    this.currentPreviewContent = this.originalContent
    this.onError?.(reason || new Error('Patch stream cancelled'))
  }
}
