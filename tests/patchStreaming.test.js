import test from 'node:test'
import assert from 'node:assert/strict'
import { PatchStreamingManager } from '../src/services/agentEngine/PatchStreamingManager.js'
import { editorBridge } from '../src/services/editorBridge.js'

test('Phase 7 — PatchStreaming: progressive hunk feeding and Monaco live preview', async () => {
  const filePath = 'd:/workspace/streamTest.js'
  const original = 'line 1\nline 2\nline 3'
  let currentEditorText = original

  const mockEditor = {
    getModel: () => ({
      getValue: () => currentEditorText,
      getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 50 })
    }),
    executeEdits: (source, edits) => {
      for (const edit of edits) {
        if (edit.text.includes('line 2 (streamed)')) {
          currentEditorText = 'line 1\nline 2 (streamed)\nline 3'
        }
      }
    },
    pushUndoStop: () => {}
  }

  editorBridge.registerEditor(filePath, mockEditor)

  let writtenToDisk = false
  const mockApi = {
    writeFile: async (p, content) => {
      writtenToDisk = true
      return { success: true }
    }
  }

  let progressEvents = []
  const streamer = new PatchStreamingManager(filePath, original, {
    api: mockApi,
    onChange: (evt) => progressEvents.push(evt)
  })

  // Feed chunks simulating LLM streaming
  streamer.feedChunk('{"file": "streamTest.js", "edits": [')
  assert.equal(writtenToDisk, false, 'Must not persist partial stream to disk')
  assert.equal(progressEvents.length, 0)

  // Feed first complete hunk
  streamer.feedChunk('{"startLine": 2, "endLine": 2, "replacement": "line 2 (streamed)"}')
  assert.equal(progressEvents.length, 1)
  assert.equal(progressEvents[0].progressCount, 1)
  assert.equal(writtenToDisk, false, 'Must not persist to disk before finalize')

  // Finalize
  await streamer.finalize()
  assert.equal(writtenToDisk, true, 'Disk write only occurs on finalize')
  assert.equal(streamer.isFinalized, true)

  editorBridge.unregisterEditor(filePath, mockEditor)
})

test('Phase 7 — PatchStreaming: stream abort rolls back Monaco preview to original content', async () => {
  const filePath = 'd:/workspace/abortTest.js'
  const original = 'const original = 100'
  let currentEditorText = original

  const mockEditor = {
    getModel: () => ({
      getValue: () => currentEditorText,
      getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 50 })
    }),
    executeEdits: (source, edits) => {
      currentEditorText = edits[0].text
    },
    pushUndoStop: () => {}
  }

  editorBridge.registerEditor(filePath, mockEditor)

  let diskWritten = false
  const streamer = new PatchStreamingManager(filePath, original, {
    api: { writeFile: async () => { diskWritten = true; return { success: true } } }
  })

  // Feed hunk that modifies preview
  streamer.feedChunk('[{"startLine": 1, "endLine": 1, "replacement": "const modified = 200"}]')
  assert.equal(currentEditorText, 'const modified = 200')

  // Abort stream
  await streamer.abort(new Error('User cancelled generation'))
  assert.equal(currentEditorText, original, 'Monaco must revert to original on abort')
  assert.equal(diskWritten, false, 'Disk was never touched')
  assert.equal(streamer.isAborted, true)

  editorBridge.unregisterEditor(filePath, mockEditor)
})
