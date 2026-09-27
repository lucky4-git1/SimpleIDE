import test from 'node:test'
import assert from 'node:assert/strict'
import { PTYManager } from '../src/main/ipc/PTYManager.js'
import { DevServerManager, extractPort, DEV_SERVER_STATES } from '../src/services/agentEngine/DevServerManager.js'
import { ToolRunner } from '../src/services/agentEngine/ToolRunner.js'

test('Phase 8 — PTYManager: interactive terminal session lifecycle, write, and resize', async () => {
  const ptyMgr = new PTYManager()

  let receivedData = []
  const session = ptyMgr.startSession({
    id: 'test-pty-1',
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    onData: (stream, text) => receivedData.push({ stream, text })
  })

  assert.ok(session)
  assert.equal(session.id, 'test-pty-1')
  assert.equal(session.status, 'running')
  assert.equal(session.cols, 80)

  // Test write
  const writeRes = ptyMgr.write('test-pty-1', 'echo test\n')
  assert.equal(writeRes.success, true)

  // Test resize
  const resizeRes = ptyMgr.resize('test-pty-1', 120, 36)
  assert.equal(resizeRes.success, true)
  assert.equal(resizeRes.cols, 120)

  // Test session list
  const list = ptyMgr.listSessions()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'test-pty-1')

  // Stop session
  const stopRes = ptyMgr.stopSession('test-pty-1')
  assert.equal(stopRes.success, true)
  assert.equal(ptyMgr.getSession('test-pty-1'), null)
})

test('Phase 9 — DevServerManager: port extraction and state transitions', async () => {
  assert.equal(extractPort('VITE v5.2.0  ready in 250 ms\n  ➜  Local:   http://localhost:5173/'), 5173)
  assert.equal(extractPort('Listening on http://127.0.0.1:3000'), 3000)
  assert.equal(extractPort('Server running on port 8080'), 8080)
  assert.equal(extractPort('No port here'), null)

  const devMgr = new DevServerManager()

  // Start dev server
  const server = await devMgr.startDevServer({
    command: 'npm run dev',
    id: 'test-server-1'
  })

  assert.equal(server.status, DEV_SERVER_STATES.RUNNING)
  assert.equal(server.port, null)

  // Feed stdout line with port
  devMgr.feedOutput('test-server-1', 'stdout', '  ➜  Local:   http://localhost:5173/\n')
  assert.equal(server.port, 5173)

  // Inspect dev server
  const inspected = await devMgr.inspectDevServer('test-server-1')
  assert.equal(inspected.found, true)
  assert.equal(inspected.server.port, 5173)

  // Stop dev server
  const stopRes = await devMgr.stopDevServer('test-server-1')
  assert.equal(stopRes.success, true)
  assert.equal(stopRes.server.status, DEV_SERVER_STATES.STOPPED)
})

test('Phase 9 — ToolRunner: start_dev_server, inspect_dev_server, and stop_dev_server integration', async () => {
  const runner = new ToolRunner(process.cwd(), {
    api: {
      listFiles: async () => ({ success: true, children: [] }),
      readFile: async () => ({ success: true, content: '' })
    }
  })

  const startTool = runner.registry.get('start_dev_server')
  const inspectTool = runner.registry.get('inspect_dev_server')
  const stopTool = runner.registry.get('stop_dev_server')

  assert.ok(startTool)
  assert.ok(inspectTool)
  assert.ok(stopTool)

  const server = await startTool.execute({ command: 'node server.js --port 4000', id: 'api-server' })
  assert.ok(server)
  assert.equal(server.status, DEV_SERVER_STATES.RUNNING)

  const inspected = await inspectTool.execute({ id: 'api-server' })
  assert.equal(inspected.found, true)

  const stopped = await stopTool.execute({ id: 'api-server' })
  assert.equal(stopped.success, true)
})
