import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveTaskTitle,
  parsePlanSteps,
  categorizeAction,
  formatActionTitle,
  groupToolActivities,
  buildAgentViewModel
} from '../src/components/agent/AgentAdapter.js'

test('AgentAdapter — deriveTaskTitle', () => {
  assert.equal(deriveTaskTitle('fix authentication bug'), 'Fix authentication bug')
  assert.equal(deriveTaskTitle('Please help me refactor the API client'), 'Refactor the API client')
  assert.equal(deriveTaskTitle('   /fix broken login component\nAdditional context line 2'), 'Fix broken login component')
  assert.equal(deriveTaskTitle(''), 'Autonomous Task')
  assert.equal(deriveTaskTitle(null), 'Autonomous Task')
})

test('AgentAdapter — parsePlanSteps', () => {
  const markdownPlan = `
1. Inspect authentication tokens
2. Fix race condition in refresh
3. Run verification tests
`
  const steps = parsePlanSteps(markdownPlan, [], 'working')
  assert.equal(steps.length, 3)
  assert.equal(steps[0].text, 'Inspect authentication tokens')
  assert.equal(steps[0].status, 'active')
  assert.equal(steps[1].status, 'pending')

  const completedSteps = parsePlanSteps(markdownPlan, [], 'complete')
  assert.equal(completedSteps[0].status, 'completed')
  assert.equal(completedSteps[1].status, 'completed')
  assert.equal(completedSteps[2].status, 'completed')
})

test('AgentAdapter — categorizeAction and formatActionTitle', () => {
  assert.equal(categorizeAction('read_file'), 'inspect')
  assert.equal(categorizeAction('write_file'), 'edit')
  assert.equal(categorizeAction('run_command'), 'verify')
  assert.equal(categorizeAction('unknown'), 'other')

  assert.equal(formatActionTitle({ type: 'read_file', path: 'src/auth/token.js' }), 'Read token.js')
  assert.equal(formatActionTitle({ type: 'run_command', command: 'npm test -- --bail' }), 'npm test -- --bail')
})

test('AgentAdapter — groupToolActivities', () => {
  const tools = [
    { id: '1', type: 'read_file', path: 'package.json', status: 'complete' },
    { id: '2', type: 'read_file', path: 'vite.config.js', status: 'complete' },
    { id: '3', type: 'read_file', path: 'src/main.js', status: 'complete' },
    { id: '4', type: 'write_file', path: 'src/auth.js', status: 'complete' },
    { id: '5', type: 'run_command', command: 'npm test', status: 'working' }
  ]

  const groups = groupToolActivities(tools)
  assert.equal(groups.length, 3)
  assert.equal(groups[0].type, 'inspect_group')
  assert.equal(groups[0].count, 3)
  assert.equal(groups[0].fileCount, 3)
  assert.equal(groups[0].status, 'complete')

  assert.equal(groups[1].type, 'edit_group')
  assert.equal(groups[1].count, 1)

  assert.equal(groups[2].type, 'single')
  assert.equal(groups[2].category, 'verify')
  assert.equal(groups[2].status, 'working')
})

test('AgentAdapter — buildAgentViewModel', () => {
  const agentRun = {
    task: 'Fix token refresh bug',
    status: 'working',
    stages: {
      inspect: { status: 'complete' },
      edit: { status: 'working', detail: 'Writing patch' },
      verify: { status: 'pending' }
    },
    tools: [
      { id: '1', type: 'read_file', path: 'token.js', status: 'complete' },
      { id: '2', type: 'write_file', path: 'token.js', status: 'working' }
    ],
    changedFiles: ['src/token.js']
  }

  const vm = buildAgentViewModel({ agentRun, isLoading: true })
  assert.equal(vm.taskTitle, 'Fix token refresh bug')
  assert.equal(vm.state, 'running')
  assert.equal(vm.isWorking, true)
  assert.equal(vm.currentAction.title, 'Write token.js')
  assert.equal(vm.changedFiles.length, 1)
})
