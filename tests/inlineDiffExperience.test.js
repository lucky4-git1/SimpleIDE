import test from 'node:test'
import assert from 'node:assert/strict'
import { inlineDiffService, computeLineDiff } from '../src/services/inlineDiffService.js'
import { editorBridge } from '../src/services/editorBridge.js'

test('Phase 6 — computeLineDiff: calculates insertions, deletions, and line ranges', () => {
  // 1. Insertion
  const before1 = 'line 1\nline 3'
  const after1 = 'line 1\nline 2\nline 3'
  const diff1 = computeLineDiff(before1, after1)
  assert.equal(diff1.hasChanges, true)
  assert.equal(diff1.insertedCount, 1)
  assert.equal(diff1.deletedCount, 0)
  assert.equal(diff1.startLine, 2)
  assert.equal(diff1.insertedText, 'line 2')

  // 2. Deletion
  const before2 = 'line 1\nline 2\nline 3'
  const after2 = 'line 1\nline 3'
  const diff2 = computeLineDiff(before2, after2)
  assert.equal(diff2.hasChanges, true)
  assert.equal(diff2.insertedCount, 0)
  assert.equal(diff2.deletedCount, 1)
  assert.equal(diff2.deletedText, 'line 2')

  // 3. Replacement
  const before3 = 'const x = 1'
  const after3 = 'const x = 99\nconst y = 100'
  const diff3 = computeLineDiff(before3, after3)
  assert.equal(diff3.hasChanges, true)
  assert.equal(diff3.insertedCount, 2)
  assert.equal(diff3.deletedCount, 1)

  // 4. Identical
  const diff4 = computeLineDiff('same', 'same')
  assert.equal(diff4.hasChanges, false)
})

test('Phase 6 — inlineDiffService: session lifecycle (showDiff, acceptDiff, rejectDiff)', async () => {
  const filePath = 'd:/workspace/app.js'
  const before = 'function calc() {\n  return 1\n}'
  const after = 'function calc() {\n  // updated logic\n  return 42\n}'

  let accepted = false
  let rejected = false

  // Show diff
  const session = inlineDiffService.showDiff(filePath, before, after, {
    onAccept: () => { accepted = true },
    onReject: () => { rejected = true }
  })

  assert.ok(session)
  assert.equal(inlineDiffService.hasActiveDiff(filePath), true)
  assert.equal(inlineDiffService.getActiveDiff(filePath).filePath, filePath)

  // Accept diff
  const acceptResult = await inlineDiffService.acceptDiff(filePath)
  assert.equal(acceptResult.success, true)
  assert.equal(accepted, true)
  assert.equal(inlineDiffService.hasActiveDiff(filePath), false)

  // Show diff again and reject
  inlineDiffService.showDiff(filePath, before, after, {
    onReject: () => { rejected = true }
  })
  assert.equal(inlineDiffService.hasActiveDiff(filePath), true)

  const rejectResult = await inlineDiffService.rejectDiff(filePath)
  assert.equal(rejectResult.success, true)
  assert.equal(rejected, true)
  assert.equal(rejectResult.revertedTo, before)
  assert.equal(inlineDiffService.hasActiveDiff(filePath), false)
})

test('Phase 6 — Monaco integration: decorations, floating widget, and view zone creation', () => {
  const filePath = 'd:/workspace/decorated.js'
  let currentModelText = 'line 1\nline 2 (new)\nline 3'

  let appliedDecorations = []
  let addedWidgets = []
  let addedZones = []
  let registeredCommands = []

  const mockModel = {
    getValue: () => currentModelText,
    getLineCount: () => 3,
    getLineMaxColumn: () => 50,
    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 50 })
  }

  const mockEditor = {
    getModel: () => mockModel,
    deltaDecorations: (oldDecs, newDecs) => {
      appliedDecorations = newDecs
      return ['dec-1', 'dec-2']
    },
    changeViewZones: (callback) => {
      const accessor = {
        addZone: (zone) => {
          addedZones.push(zone)
          return 'zone-1'
        },
        removeZone: (id) => {
          addedZones = addedZones.filter(z => z !== id)
        }
      }
      callback(accessor)
    },
    addContentWidget: (widget) => {
      addedWidgets.push(widget)
    },
    removeContentWidget: (widget) => {
      addedWidgets = addedWidgets.filter(w => w !== widget)
    },
    addCommand: (keybinding, handler) => {
      registeredCommands.push({ keybinding, handler })
    },
    pushUndoStop: () => {},
    executeEdits: (source, edits) => {
      for (const edit of edits) {
        currentModelText = edit.text
      }
    }
  }

  const mockMonaco = {
    Range: function(sl, sc, el, ec) {
      return { startLineNumber: sl, startColumn: sc, endLineNumber: el, endColumn: ec }
    },
    KeyMod: { CtrlCmd: 2048, Shift: 1024 },
    KeyCode: { KeyY: 55, KeyN: 44 },
    editor: {
      OverviewRulerLane: { Right: 4 },
      ContentWidgetPositionPreference: { ABOVE: 1, BELOW: 2 }
    }
  }

  // Register mock editor in editorBridge
  editorBridge.registerEditor(filePath, mockEditor, mockMonaco)

  const before = 'line 1\nline 2 (old to replace)\nline 3'
  const after = 'line 1\nline 2 (new)\nline 3'

  const session = inlineDiffService.showDiff(filePath, before, after)
  assert.ok(session)

  // Verify decorations were applied
  assert.ok(appliedDecorations.length > 0)
  assert.equal(appliedDecorations[0].options.className, 'inline-diff-insert-line')

  // Verify floating accept/reject widget was created
  assert.equal(addedWidgets.length, 1)
  assert.equal(addedWidgets[0].getId(), `inline-diff-widget-${filePath.toLowerCase()}`)

  // Verify view zone was created for replaced/deleted line
  assert.equal(addedZones.length, 1)
  assert.ok(addedZones[0].domNode.className.includes('inline-diff-delete-zone'))

  // Verify keyboard commands (Ctrl+Shift+Y, Ctrl+Shift+N) registered
  assert.equal(registeredCommands.length, 2)

  // Test rejecting diff via session
  inlineDiffService.rejectDiff(filePath)
  assert.equal(inlineDiffService.hasActiveDiff(filePath), false)
  assert.equal(currentModelText, before) // Model reverted to original

  editorBridge.unregisterEditor(filePath, mockEditor)
})

test('Phase 6 — Multi-file isolation: diffs on different files remain independent', () => {
  inlineDiffService.clearAll()

  const fileA = 'd:/workspace/a.js'
  const fileB = 'd:/workspace/b.js'

  inlineDiffService.showDiff(fileA, 'a1', 'a2')
  inlineDiffService.showDiff(fileB, 'b1', 'b2')

  assert.equal(inlineDiffService.getAllActiveDiffs().length, 2)
  assert.equal(inlineDiffService.hasActiveDiff(fileA), true)
  assert.equal(inlineDiffService.hasActiveDiff(fileB), true)

  inlineDiffService.acceptDiff(fileA)
  assert.equal(inlineDiffService.hasActiveDiff(fileA), false)
  assert.equal(inlineDiffService.hasActiveDiff(fileB), true)

  inlineDiffService.rejectDiff(fileB)
  assert.equal(inlineDiffService.hasActiveDiff(fileB), false)
  assert.equal(inlineDiffService.getAllActiveDiffs().length, 0)
})
