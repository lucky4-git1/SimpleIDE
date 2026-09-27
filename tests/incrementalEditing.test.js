import test from 'node:test'
import assert from 'node:assert/strict'
import { PatchEngine } from '../src/services/agentEngine/PatchEngine.js'
import { editorBridge } from '../src/services/editorBridge.js'
import { ToolRunner } from '../src/services/agentEngine/ToolRunner.js'

test('Phase 5 — PatchEngine: insert operation at line and column', () => {
  const content = 'line 1\nline 2\nline 3'
  // Insert at start of line 2
  const insertEdit = { type: 'insert', line: 2, column: 1, text: 'inserted line\n' }
  const result = PatchEngine.applyEdits(content, [insertEdit])
  assert.equal(result, 'line 1\ninserted line\nline 2\nline 3')

  // Insert within line 1
  const midEdit = { type: 'insert', line: 1, column: 5, text: ' awesome' }
  const resultMid = PatchEngine.applyEdits(content, [midEdit])
  assert.equal(resultMid, 'line awesome 1\nline 2\nline 3')
})

test('Phase 5 — PatchEngine: replace operation for line ranges and partial columns', () => {
  const content = 'function add(a, b) {\n  const sum = a + b\n  return sum\n}'
  
  // Replace line 2
  const lineReplace = { type: 'replace', startLine: 2, endLine: 2, replacement: '  // compute sum\n  const sum = a + b' }
  const resultLine = PatchEngine.applyEdits(content, [lineReplace])
  assert.equal(resultLine, 'function add(a, b) {\n  // compute sum\n  const sum = a + b\n  return sum\n}')

  // Replace sub-line (column-level)
  const colReplace = { type: 'replace', startLine: 1, startColumn: 10, endLine: 1, endColumn: 13, replacement: 'subtract' }
  const resultCol = PatchEngine.applyEdits(content, [colReplace])
  assert.equal(resultCol, 'function subtract(a, b) {\n  const sum = a + b\n  return sum\n}')
})

test('Phase 5 — PatchEngine: delete operation for full lines and column ranges', () => {
  const content = 'line 1\nline 2 (to delete)\nline 3'
  // Delete line 2
  const lineDelete = { type: 'delete', startLine: 2, endLine: 2 }
  const result = PatchEngine.applyEdits(content, [lineDelete])
  assert.equal(result, 'line 1\nline 3')

  // Delete partial columns
  const colDelete = { type: 'delete', startLine: 1, startColumn: 5, endLine: 1, endColumn: 7 }
  const resultCol = PatchEngine.applyEdits('hello world', [colDelete])
  assert.equal(resultCol, 'hellworld')
})

test('Phase 5 — PatchEngine: move operation moves blocks of lines', () => {
  const content = 'line 1\nline 2\nline 3\nline 4'
  // Move line 1 to after line 3 (to line 4)
  const moveEdit = { type: 'move', fromStartLine: 1, fromEndLine: 1, toLine: 4 }
  const result = PatchEngine.applyEdits(content, [moveEdit])
  assert.equal(result, 'line 2\nline 3\nline 1\nline 4')
})

test('Phase 5 — PatchEngine: rename operation across whole file', () => {
  const content = 'const foo = 1\nconsole.log(foo)\nfunction doFoo() { return foo + 2 }'
  const renameEdit = { type: 'rename', find: 'foo', replace: 'bar', wholeWord: true }
  const result = PatchEngine.applyEdits(content, [renameEdit])
  assert.equal(result, 'const bar = 1\nconsole.log(bar)\nfunction doFoo() { return bar + 2 }')
})

test('Phase 5 — PatchEngine: multi-range edit applies atomically in bottom-up order without offset drift', () => {
  const content = 'line 1\nline 2\nline 3\nline 4\nline 5'
  
  // Two discrete edits: modify line 2 and modify line 4
  const multiEdits = [
    { startLine: 2, endLine: 2, replacement: 'line 2 (updated with\nmultiple extra lines)' },
    { startLine: 4, endLine: 4, replacement: 'line 4 (modified)' }
  ]

  const result = PatchEngine.applyEdits(content, multiEdits)
  const expected = 'line 1\nline 2 (updated with\nmultiple extra lines)\nline 3\nline 4 (modified)\nline 5'
  assert.equal(result, expected)
})

test('Phase 5 — PatchEngine: detects and rejects overlapping edit ranges', () => {
  const content = 'line 1\nline 2\nline 3\nline 4'
  const overlapping = [
    { startLine: 1, endLine: 3, replacement: 'abc' },
    { startLine: 2, endLine: 4, replacement: 'def' }
  ]
  assert.throws(() => PatchEngine.applyEdits(content, overlapping), /Overlapping edits detected/)
})

test('Phase 5 — PatchEngine: createPatch generates minimal structured patch', () => {
  const before = 'const x = 1\nconst y = 2\nconst z = 3'
  const after = 'const x = 1\nconst y = 99\nconst z = 3'
  const patch = PatchEngine.createPatch('app.js', before, after)
  
  assert.equal(patch.file, 'app.js')
  assert.equal(patch.edits.length, 1)
  assert.equal(patch.edits[0].startLine, 2)
  assert.equal(patch.edits[0].endLine, 2)
  assert.equal(patch.edits[0].replacement, 'const y = 99')
})

test('Phase 5 — editorBridge: registers, unregisters, and applies executeEdits to Monaco instance', () => {
  let executedEdits = null
  let undoPushed = 0

  let currentText = 'first line\nsecond line\nthird line'
  const mockModel = {
    getValue: () => currentText,
    setValue: (val) => { currentText = val }
  }

  const mockEditor = {
    getModel: () => mockModel,
    executeEdits: (source, edits) => {
      executedEdits = { source, edits }
      // Simulate Monaco applying replacement
      for (const edit of edits) {
        currentText = currentText.replace('second line', edit.text)
      }
    },
    pushUndoStop: () => { undoPushed++ }
  }

  const mockMonaco = {
    Range: function(sl, sc, el, ec) {
      return { startLineNumber: sl, startColumn: sc, endLineNumber: el, endColumn: ec }
    }
  }

  const filePath = 'd:/workspace/test.js'
  editorBridge.registerEditor(filePath, mockEditor, mockMonaco)
  assert.equal(editorBridge.isEditorOpen(filePath), true)

  const edits = [{ startLine: 2, endLine: 2, replacement: 'second line (patched)' }]
  const applyResult = editorBridge.applyEditsToEditor(filePath, edits, { source: 'agent' })

  assert.equal(applyResult.success, true)
  assert.equal(applyResult.count, 1)
  assert.equal(executedEdits.source, 'agent')
  assert.equal(executedEdits.edits.length, 1)
  assert.equal(executedEdits.edits[0].text, 'second line (patched)')
  assert.ok(undoPushed >= 1)

  editorBridge.unregisterEditor(filePath, mockEditor)
  assert.equal(editorBridge.isEditorOpen(filePath), false)
})

test('Phase 5 — ToolRunner: apply_patch applies structured patch and records ChangeManager patch metadata', async () => {
  const files = {
    'd:/workspace/service.js': 'import a from "./a"\n\nfunction process() {\n  return 42\n}\n\nexport default process'
  }

  const mockApi = {
    readFile: async (p) => files[p] ? { success: true, content: files[p] } : { success: false, error: 'Not found' },
    writeFile: async (p, content) => { files[p] = content; return { success: true } },
    listFiles: async () => ({ success: true, children: [] }),
    searchWorkspace: async () => ({ success: true, results: [] })
  }

  let capturedChange = null
  const runner = new ToolRunner('d:/workspace', {
    api: mockApi,
    onChange: (change) => { capturedChange = change }
  })

  runner.beginTransaction('test-task-5')

  const patchArg = {
    file: 'service.js',
    edits: [
      { startLine: 4, endLine: 4, replacement: '  const result = 42\n  return result' }
    ]
  }

  const tool = runner.registry.get('apply_patch')
  assert.ok(tool, 'apply_patch tool must be registered in ToolRunner')

  const res = await tool.execute({ path: 'service.js', patch: patchArg })
  assert.equal(res.operation, 'patch')
  assert.ok(res.changed)
  assert.ok(files['d:/workspace/service.js'].includes('const result = 42'))

  // Verify ChangeManager recorded patch metadata
  assert.ok(capturedChange, 'onChange must be fired with change record')
  assert.equal(capturedChange.operation, 'patch')
  assert.ok(capturedChange.patch, 'capturedChange must include structured patch')
  assert.equal(capturedChange.patch.edits.length, 1)

  const committed = await runner.commitTransaction('test-task-5')
  assert.equal(committed.length, 1)
  assert.ok(committed[0].patch)
})
