import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentViewModel } from '../src/components/agent/AgentAdapter.js'

test('Agent UI Integration — Empty state view model', () => {
  const vm = buildAgentViewModel({
    agentRun: null,
    messages: [],
    isLoading: false,
    pendingApproval: null
  })

  assert.equal(vm.hasRun, false)
  assert.equal(vm.state, 'idle')
  assert.equal(vm.isWorking, false)
  assert.equal(vm.currentAction, null)
  assert.equal(vm.planSteps.length, 0)
  assert.equal(vm.activityGroups.length, 0)
})

test('Agent UI Integration — Planning state view model', () => {
  const agentRun = {
    task: 'Create authentication tests',
    status: 'planning',
    stages: {
      inspect: { status: 'working', detail: 'Analyzing test directory' }
    },
    tools: []
  }

  const vm = buildAgentViewModel({
    agentRun,
    messages: [{ role: 'user', content: 'Create authentication tests' }],
    isLoading: true
  })

  assert.equal(vm.hasRun, true)
  assert.equal(vm.state, 'planning')
  assert.equal(vm.isWorking, true)
  assert.equal(vm.taskTitle, 'Create authentication tests')
  assert.equal(vm.currentAction.type, 'planning')
})

test('Agent UI Integration — Review state view model with plan steps', () => {
  const rawPlan = `
1. Inspect authentication tokens
2. Implement refresh lock
3. Run verification test suite
`
  const agentRun = {
    task: 'Fix auth refresh race condition',
    status: 'review',
    plan: rawPlan,
    stages: {},
    tools: []
  }

  const vm = buildAgentViewModel({
    agentRun,
    messages: [{ role: 'user', content: 'Fix auth refresh race condition' }],
    isLoading: false
  })

  assert.equal(vm.hasRun, true)
  assert.equal(vm.state, 'review')
  assert.equal(vm.isReview, true)
  assert.equal(vm.planSteps.length, 3)
  assert.equal(vm.planSteps[0].text, 'Inspect authentication tokens')
})

test('Agent UI Integration — Pending approval view model', () => {
  const pendingApproval = {
    tool: 'run_command',
    reason: 'Deleting build directory requires authorization',
    args: { command: 'rmdir /s dist' },
    isDestructive: true
  }

  const vm = buildAgentViewModel({
    agentRun: { task: 'Clean artifacts', status: 'working', tools: [] },
    isLoading: true,
    pendingApproval
  })

  assert.equal(vm.state, 'waiting_approval')
  assert.equal(vm.currentAction.type, 'approval')
  assert.equal(vm.currentAction.isDestructive, true)
  assert.equal(vm.pendingApproval.isDestructive, true)
})

test('Agent UI Integration — Running execution with grouped activities and current action', () => {
  const tools = [
    { id: '1', type: 'read_file', path: 'package.json', status: 'complete' },
    { id: '2', type: 'read_file', path: 'tsconfig.json', status: 'complete' },
    { id: '3', type: 'read_file', path: 'src/auth.ts', status: 'complete' },
    { id: '4', type: 'replace_in_file', path: 'src/auth.ts', status: 'complete' },
    { id: '5', type: 'run_command', command: 'npm test', status: 'working' }
  ]

  const agentRun = {
    task: 'Refactor auth service',
    status: 'working',
    stages: {
      inspect: { status: 'complete' },
      edit: { status: 'complete' },
      verify: { status: 'working', detail: 'Running npm test' }
    },
    tools,
    changedFiles: ['src/auth.ts']
  }

  const vm = buildAgentViewModel({
    agentRun,
    isLoading: true
  })

  assert.equal(vm.state, 'running')
  assert.equal(vm.isWorking, true)
  assert.equal(vm.currentAction.type, 'verify')
  assert.equal(vm.currentAction.title, 'npm test')
  assert.equal(vm.activityGroups.length, 3)
  assert.equal(vm.activityGroups[0].type, 'inspect_group')
  assert.equal(vm.activityGroups[0].fileCount, 3)
  assert.equal(vm.activityGroups[1].type, 'edit_group')
  assert.equal(vm.activityGroups[1].fileCount, 1)
  assert.equal(vm.activityGroups[2].type, 'single')
  assert.equal(vm.activityGroups[2].status, 'working')
})

test('Agent UI Integration — Completed run view model with verification and diagnostics', () => {
  const agentRun = {
    task: 'Add health check endpoint',
    status: 'complete',
    summary: 'Created healthcheck route and verified 200 OK response.',
    stages: {
      inspect: { status: 'complete' },
      edit: { status: 'complete' },
      verify: { status: 'complete', detail: 'All checks passed' }
    },
    tools: [
      { id: '1', type: 'write_file', path: 'routes/health.js', status: 'complete' },
      { id: '2', type: 'run_command', command: 'npm test', status: 'complete' }
    ],
    changedFiles: ['routes/health.js']
  }

  const vm = buildAgentViewModel({
    agentRun,
    isLoading: false,
    runDiagnostics: { turns: 3, durationMs: 4200, model: 'gpt-4o' }
  })

  assert.equal(vm.state, 'completed')
  assert.equal(vm.verification.passed, true)
  assert.equal(vm.changedFiles.length, 1)
  assert.equal(vm.diagnostics.turns, 3)
  assert.equal(vm.summary.includes('healthcheck'), true)
})

test('Agent UI Integration — Failed and cancelled runs', () => {
  const failedRun = {
    task: 'Fix failing test',
    status: 'failed',
    summary: 'Verification failed with 2 test failures.',
    stages: {
      verify: { status: 'failed', detail: '2 tests failed' }
    },
    tools: []
  }

  const failedVm = buildAgentViewModel({ agentRun: failedRun, isLoading: false })
  assert.equal(failedVm.state, 'failed')
  assert.equal(failedVm.verification.failed, true)

  const cancelledRun = {
    task: 'Long search',
    status: 'cancelled',
    summary: 'Cancelled by user.',
    stages: {},
    tools: []
  }

  const cancelledVm = buildAgentViewModel({ agentRun: cancelledRun, isLoading: false })
  assert.equal(cancelledVm.state, 'cancelled')
})
