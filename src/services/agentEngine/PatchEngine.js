/**
 * PatchEngine.js
 *
 * Core engine for structured, incremental code editing in SimpleIDE.
 * Supports:
 * - Structured edit operations: insert, replace, delete, move, rename, multi-range edit.
 * - Canonical patch representation: { file: string, edits: [{ startLine, endLine, startColumn, endColumn, replacement }] }.
 * - Bottom-up atomic application preserving non-overlapping line and column offsets.
 * - Diff generation and translation to Monaco executeEdits operations.
 */

export class PatchEngine {
  /**
   * Normalize an edit or array of edits into canonical range edits:
   * { startLine, startColumn, endLine, endColumn, replacement, type }
   * Lines and columns are 1-indexed.
   */
  static normalizeEdits(rawEdits, content = '') {
    if (!Array.isArray(rawEdits)) {
      if (rawEdits && typeof rawEdits === 'object') {
        rawEdits = [rawEdits]
      } else {
        return []
      }
    }

    const lines = String(content).split(/\r?\n/)
    const totalLines = Math.max(1, lines.length)
    const normalized = []

    for (const edit of rawEdits) {
      if (!edit || typeof edit !== 'object') continue

      const type = edit.type || (edit.fromStartLine ? 'move' : edit.find ? 'rename' : edit.endLine !== undefined ? 'replace' : 'insert')

      if (type === 'move') {
        const fromStart = Math.max(1, Math.min(totalLines, edit.fromStartLine || edit.startLine || 1))
        const fromEnd = Math.max(fromStart, Math.min(totalLines, edit.fromEndLine || edit.endLine || fromStart))
        const toLine = Math.max(1, Math.min(totalLines + 1, edit.toLine || 1))

        const movedLines = lines.slice(fromStart - 1, fromEnd)
        const movedText = movedLines.join('\n') + (movedLines.length > 0 ? '\n' : '')

        // Represent move as an atomic operation or compound edit
        normalized.push({
          type: 'move',
          fromStartLine: fromStart,
          fromEndLine: fromEnd,
          toLine,
          text: movedText
        })
        continue
      }

      if (type === 'rename') {
        const findStr = edit.find || edit.search
        const replaceStr = edit.replace ?? edit.replacement ?? ''
        if (!findStr) continue

        const isWordOnly = edit.wholeWord ?? true
        const regex = new RegExp(isWordOnly ? `\\b${escapeRegExp(findStr)}\\b` : escapeRegExp(findStr), 'g')

        for (let i = 0; i < lines.length; i++) {
          const lineNum = i + 1
          const lineText = lines[i]
          let match
          while ((match = regex.exec(lineText)) !== null) {
            const startCol = match.index + 1
            const endCol = startCol + match[0].length
            normalized.push({
              type: 'replace',
              startLine: lineNum,
              startColumn: startCol,
              endLine: lineNum,
              endColumn: endCol,
              replacement: replaceStr
            })
          }
        }
        continue
      }

      if (type === 'insert') {
        const line = Math.max(1, edit.line || edit.startLine || 1)
        const col = Math.max(1, edit.column || edit.startColumn || 1)
        const text = edit.text ?? edit.replacement ?? ''
        normalized.push({
          type: 'insert',
          startLine: line,
          startColumn: col,
          endLine: line,
          endColumn: col,
          replacement: text
        })
        continue
      }

      if (type === 'delete') {
        const startLine = Math.max(1, edit.startLine || edit.line || 1)
        const endLine = Math.max(startLine, edit.endLine || startLine)
        const isLineLevel = edit.startColumn === undefined && edit.endColumn === undefined

        if (isLineLevel) {
          const maxColOnEnd = (lines[endLine - 1] || '').length + 1
          // If deleting whole lines, also delete the trailing newline if not last line
          const hasNextLine = endLine < lines.length
          normalized.push({
            type: 'delete',
            startLine,
            startColumn: 1,
            endLine: hasNextLine ? endLine + 1 : endLine,
            endColumn: hasNextLine ? 1 : maxColOnEnd,
            replacement: ''
          })
        } else {
          normalized.push({
            type: 'delete',
            startLine,
            startColumn: edit.startColumn || 1,
            endLine,
            endColumn: edit.endColumn || (lines[endLine - 1] || '').length + 1,
            replacement: ''
          })
        }
        continue
      }

      // Default: 'replace'
      const startLine = Math.max(1, edit.startLine || 1)
      const endLine = Math.max(startLine, edit.endLine || startLine)
      const isLineLevel = edit.startColumn === undefined && edit.endColumn === undefined

      let startColumn = edit.startColumn || 1
      let endColumn = edit.endColumn
      let replacement = edit.replacement ?? edit.text ?? ''

      if (isLineLevel) {
        // Line-level replacement: replaces the entire lines
        startColumn = 1
        endColumn = (lines[endLine - 1] || '').length + 1
      } else {
        if (endColumn === undefined) {
          endColumn = (lines[endLine - 1] || '').length + 1
        }
      }

      normalized.push({
        type: 'replace',
        startLine,
        startColumn,
        endLine,
        endColumn,
        replacement
      })
    }

    return normalized
  }

  /**
   * Sorts edits so they can be safely applied sequentially from bottom to top
   * (highest startLine and startColumn first), avoiding line-offset shifts.
   */
  static sortEditsBottomUp(edits) {
    return [...edits].sort((a, b) => {
      const lineDiff = (b.startLine || b.fromStartLine || 0) - (a.startLine || a.fromStartLine || 0)
      if (lineDiff !== 0) return lineDiff
      return (b.startColumn || 0) - (a.startColumn || 0)
    })
  }

  /**
   * Checks if any edits have overlapping ranges.
   */
  static validateNonOverlapping(edits) {
    const rangeEdits = edits.filter(e => e.startLine !== undefined && e.endLine !== undefined)
    const sorted = [...rangeEdits].sort((a, b) => {
      if (a.startLine !== b.startLine) return a.startLine - b.startLine
      return (a.startColumn || 1) - (b.startColumn || 1)
    })

    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i]
      const next = sorted[i + 1]

      const curEndLine = cur.endLine
      const curEndCol = cur.endColumn || Infinity
      const nextStartLine = next.startLine
      const nextStartCol = next.startColumn || 1

      if (curEndLine > nextStartLine || (curEndLine === nextStartLine && curEndCol > nextStartCol)) {
        throw new Error(
          `Overlapping edits detected: [L${cur.startLine}:${cur.startColumn || 1}-L${cur.endLine}:${cur.endColumn || 1}] overlaps with [L${next.startLine}:${next.startColumn || 1}-L${next.endLine}:${next.endColumn || 1}]`
        )
      }
    }
  }

  /**
   * Applies an array of structured edits to original string content.
   * Returns updated string content.
   */
  static applyEdits(content, rawEdits) {
    const original = String(content ?? '')
    const isCRLF = original.includes('\r\n')
    const normalizedOriginal = original.replace(/\r\n/g, '\n')
    let lines = normalizedOriginal.split('\n')

    // Handle 'move' operations first if present
    const normalized = this.normalizeEdits(rawEdits, normalizedOriginal)
    const moves = normalized.filter(e => e.type === 'move')
    const standardEdits = normalized.filter(e => e.type !== 'move')

    if (moves.length > 0) {
      for (const move of moves) {
        const { fromStartLine, fromEndLine, toLine } = move
        const movedChunk = lines.slice(fromStartLine - 1, fromEndLine)
        lines.splice(fromStartLine - 1, fromEndLine - fromStartLine + 1)
        const adjustedTo = toLine > fromEndLine ? toLine - (fromEndLine - fromStartLine + 1) : toLine
        lines.splice(Math.max(0, adjustedTo - 1), 0, ...movedChunk)
      }
    }

    if (standardEdits.length === 0) {
      const joined = lines.join('\n')
      return isCRLF ? joined.replace(/\n/g, '\r\n') : joined
    }

    this.validateNonOverlapping(standardEdits)
    const sorted = this.sortEditsBottomUp(standardEdits)

    for (const edit of sorted) {
      const { startLine, startColumn = 1, endLine, endColumn, replacement = '' } = edit

      // Line bounds clamping
      const actualStartLine = Math.min(startLine, lines.length)
      const actualEndLine = Math.min(endLine, lines.length)

      if (actualStartLine < 1 || actualEndLine < actualStartLine) {
        continue
      }

      const beforePrefix = (lines[actualStartLine - 1] || '').slice(0, Math.max(0, startColumn - 1))
      const afterLineText = lines[actualEndLine - 1] || ''
      const afterSuffix = endColumn !== undefined && endColumn <= afterLineText.length + 1
        ? afterLineText.slice(Math.max(0, endColumn - 1))
        : ''

      const replacementLines = replacement.split('\n')
      if (replacementLines.length === 1) {
        const combined = beforePrefix + replacementLines[0] + afterSuffix
        lines.splice(actualStartLine - 1, actualEndLine - actualStartLine + 1, combined)
      } else {
        const firstLine = beforePrefix + replacementLines[0]
        const lastLine = replacementLines[replacementLines.length - 1] + afterSuffix
        const middleLines = replacementLines.slice(1, -1)
        lines.splice(actualStartLine - 1, actualEndLine - actualStartLine + 1, firstLine, ...middleLines, lastLine)
      }
    }

    const result = lines.join('\n')
    return isCRLF ? result.replace(/\n/g, '\r\n') : result
  }

  /**
   * Generates a structured patch object from before & after text.
   * { file: string, edits: [{ startLine, endLine, replacement }] }
   */
  static createPatch(file, beforeText, afterText) {
    const beforeLines = String(beforeText || '').split(/\r?\n/)
    const afterLines = String(afterText || '').split(/\r?\n/)

    // Simple prefix-suffix line diffing for clean minimal range edit
    let start = 0
    while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
      start++
    }

    let beforeEnd = beforeLines.length - 1
    let afterEnd = afterLines.length - 1
    while (beforeEnd >= start && afterEnd >= start && beforeLines[beforeEnd] === afterLines[afterEnd]) {
      beforeEnd--
      afterEnd--
    }

    const startLine = start + 1
    const endLine = beforeEnd + 1
    const replacementLines = afterLines.slice(start, afterEnd + 1)
    const replacement = replacementLines.join('\n')

    const edits = []
    if (startLine <= endLine || replacement.length > 0) {
      edits.push({
        startLine: Math.max(1, startLine),
        endLine: Math.max(1, endLine),
        replacement
      })
    }

    return {
      file,
      edits
    }
  }

  /**
   * Converts structured edits into Monaco editor IIdentifiedSingleEditOperation format.
   * Compatible with editor.executeEdits(source, edits).
   */
  static toMonacoEdits(edits, monaco = null) {
    if (!Array.isArray(edits)) return []

    return edits.map(edit => {
      const startLineNumber = edit.startLine || edit.line || 1
      const startColumn = edit.startColumn || edit.column || 1
      const endLineNumber = edit.endLine || startLineNumber
      const endColumn = edit.endColumn || (edit.endLine ? 999999 : startColumn)
      const text = edit.replacement ?? edit.text ?? ''

      const range = monaco?.Range
        ? new monaco.Range(startLineNumber, startColumn, endLineNumber, endColumn)
        : { startLineNumber, startColumn, endLineNumber, endColumn }

      return {
        range,
        text,
        forceMoveMarkers: true
      }
    })
  }
}

function escapeRegExp(string) {
  return String(string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
