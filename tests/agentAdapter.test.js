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

import { normalizePlanToMarkdown } from '../src/services/agentService.js'

test('AgentAdapter & Service — normalizePlanToMarkdown transforms raw JSON into structured Markdown', () => {
  const jsonPlan = JSON.stringify({
    goal: 'Analyze the existing GitDrop codebase and create an implementation plan.',
    design_direction: 'GitHub + VS Code aesthetic, minimal, fast, technical.',
    steps: [
      '1. **Audit Existing Codebase** - Read all existing source files',
      '2. **Create Implementation Plan** - Based on the audit and the 65-phase specification',
      '3. **Verify with automated tests**'
    ],
    affected_files: ['src/services/git.js', 'src/components/GitPanel.jsx'],
    verification: 'npm test',
    risks: ['Large repository context might exceed window']
  })

  const markdown = normalizePlanToMarkdown(jsonPlan)
  assert.match(markdown, /^# Implementation Plan: Analyze the existing GitDrop codebase/)
  assert.match(markdown, /## 1\. Goal\nAnalyze the existing GitDrop/)
  assert.match(markdown, /## 2\. Design & Architecture\nGitHub \+ VS Code/)
  assert.match(markdown, /## 3\. Implementation Steps/)
  assert.match(markdown, /1\. \*\*Audit Existing Codebase\*\* - Read all existing source files/)
  assert.match(markdown, /2\. \*\*Create Implementation Plan\*\*/)
  assert.match(markdown, /3\. \*\*Verify with automated tests\*\*/)
  assert.match(markdown, /## 4\. Affected Files\n- `src\/services\/git\.js`\n- `src\/components\/GitPanel\.jsx`/)
  assert.match(markdown, /```bash\nnpm test\n```/)
  assert.match(markdown, /## 6\. Risks & Mitigations\n- Large repository context might exceed window/)

  // Also verify fenced JSON block: ```json { ... } ```
  const fencedJson = `\`\`\`json\n${jsonPlan}\n\`\`\``
  const fromFenced = normalizePlanToMarkdown(fencedJson)
  assert.match(fromFenced, /^# Implementation Plan:/)
  assert.match(fromFenced, /## 1\. Goal/)

  // Normal markdown should be preserved untouched
  const normalMd = '# Custom Plan\n\n1. Do something\n2. Do something else'
  assert.equal(normalizePlanToMarkdown(normalMd), normalMd)
})

test('AgentAdapter — parsePlanSteps parses JSON plans and markdown checklists', () => {
  // Test raw JSON string passed to parsePlanSteps
  const jsonPlan = JSON.stringify({
    steps: [
      'Inspect repository structure',
      'Refactor git client service',
      'Add unit tests'
    ]
  })
  const jsonSteps = parsePlanSteps(jsonPlan, [], 'working')
  assert.equal(jsonSteps.length, 3)
  assert.equal(jsonSteps[0].text, 'Inspect repository structure')
  assert.equal(jsonSteps[0].status, 'active')
  assert.equal(jsonSteps[1].status, 'pending')

  // Test markdown checkbox checklist: - [ ] and - [x]
  const checklistPlan = `
# Plan
- [x] Phase 1: Setup workspace
- [ ] Phase 2: Implement UI redesign
- [ ] Phase 3: Run end-to-end verification
`
  const checklistSteps = parsePlanSteps(checklistPlan, [], 'working')
  assert.equal(checklistSteps.length, 3)
  assert.equal(checklistSteps[0].text, 'Phase 1: Setup workspace')
  assert.equal(checklistSteps[1].text, 'Phase 2: Implement UI redesign')
})

test('AgentAdapter — parsePlanSteps is section-aware and ignores non-step bullet lists', () => {
  const fullPlan = `
# Implementation Plan: Landing Page

## 1. Goal & Objectives
Build a modern dark-mode landing page with responsive layouts.

## 2. Design & Architecture
- Modern tech aesthetics
- High contrast typography
- Dynamic CSS grid

## 3. Implementation Steps
1. **Initialize Project Files** — Create index.html and style.css
2. **Implement Hero Section** — Title, CTA buttons, and badge
3. **Add Responsive Features Grid** — 3 column card layout

## 4. Affected Files
- \`index.html\` — Main markup
- \`style.css\` — Responsive stylesheet

## 5. Verification Plan
- \`npm test\`
- Inspect in browser preview

## 6. Risks & Mitigations
- Mobile layout clipping
`
  const steps = parsePlanSteps(fullPlan, [], 'working')
  assert.equal(steps.length, 3)
  assert.equal(steps[0].text, 'Initialize Project Files — Create index.html and style.css')
  assert.equal(steps[1].text, 'Implement Hero Section — Title, CTA buttons, and badge')
  assert.equal(steps[2].text, 'Add Responsive Features Grid — 3 column card layout')
  assert.equal(steps[0].status, 'active')
  assert.equal(steps[1].status, 'pending')
})

test('AgentAdapter — buildAgentViewModel normalizes verification from agentRun.verification', () => {
  const agentRun = {
    task: 'Create landing page',
    status: 'complete',
    verification: {
      attempted: true,
      success: true,
      command: 'npm test',
      stdout: 'All 12 tests passed'
    },
    tools: [],
    changedFiles: ['index.html']
  }

  const vm = buildAgentViewModel({ agentRun, isLoading: false })
  assert.equal(vm.verification.attempted, true)
  assert.equal(vm.verification.passed, true)
  assert.equal(vm.verification.failed, false)
  assert.equal(vm.verification.command, 'npm test')
  assert.equal(vm.verification.output, 'All 12 tests passed')
})

test('AgentAdapter — buildAgentViewModel normalizes failed verification cleanly', () => {
  const agentRun = {
    task: 'Create landing page',
    status: 'failed',
    verification: {
      attempted: true,
      success: false,
      command: 'npm test',
      stdout: 'AssertionError: expected true to be false',
      exitCode: 1
    },
    tools: [],
    changedFiles: []
  }

  const vm = buildAgentViewModel({ agentRun, isLoading: false })
  assert.equal(vm.verification.attempted, true)
  assert.equal(vm.verification.passed, false)
  assert.equal(vm.verification.failed, true)
  assert.match(vm.verification.detail, /npm test/)
})


