import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { CompactNeuralRuntime } from '../src/main/primeRouter/CompactNeuralRuntime.js'
import { LocalModelRuntime } from '../src/main/primeRouter/LocalModelRuntime.js'

describe('Compact Neural Laya Decision Engine (Path 2 Bundled Model)', () => {
  const modelPath = path.resolve('assets/models/laya/simpleide-laya-compact.json')

  it('successfully loads compact neural model from bundled assets', () => {
    const runtime = CompactNeuralRuntime.loadFromFile(modelPath)
    assert.ok(runtime, 'CompactNeuralRuntime must load successfully')
    assert.equal(runtime.version, '1.0.0')
    assert.equal(runtime.inputDim, 1024)
    assert.equal(runtime.hiddenDim, 128)
    assert.ok(runtime.vocab.size > 100, 'Vocabulary must have indexed features')
  })

  it('predicts testing and verification tasks with high confidence', () => {
    const runtime = CompactNeuralRuntime.loadFromFile(modelPath)
    const result = runtime.predict('npm test --coverage')
    assert.equal(result.intent, 'test')
    assert.equal(result.actionClass, 'local_tool')
    assert.equal(result.toolFamily, 'testing')
    assert.equal(result.needsVerification, true)
    assert.equal(result.needsLLM, false)
    assert.equal(result.inferenceSource, 'neural_tensor')
    assert.ok(result.confidence > 0.9, 'Confidence should exceed 0.90')
  })

  it('predicts git repository tasks as local tools', () => {
    const runtime = CompactNeuralRuntime.loadFromFile(modelPath)
    const result = runtime.predict('git status')
    assert.equal(result.intent, 'git')
    assert.equal(result.actionClass, 'local_tool')
    assert.equal(result.toolFamily, 'git')
    assert.equal(result.needsLLM, false)
    assert.equal(result.inferenceSource, 'neural_tensor')
  })

  it('predicts semantic navigation and activates symbol graph with graph depth', () => {
    const runtime = CompactNeuralRuntime.loadFromFile(modelPath)
    const result = runtime.predict('Explore the 2nd-degree dependency graph around function startBackgroundServer')
    assert.equal(result.intent, 'navigate')
    assert.equal(result.toolFamily, 'symbol_graph')
    assert.equal(result.symbol_navigation, 'required')
    assert.equal(result.semantic_navigation_required, true)
    assert.equal(result.graph_depth, '2')
    assert.equal(result.needsLLM, true)
  })

  it('correctly classifies hard-negative explanation requests without triggering tools', () => {
    const runtime = CompactNeuralRuntime.loadFromFile(modelPath)
    const result = runtime.predict('What is the algorithmic purpose of method executeIncrementalEdits in PatchEngine.js?')
    assert.equal(result.intent, 'explain')
    assert.equal(result.actionClass, 'main_llm')
    assert.equal(result.toolFamily, 'none')
    assert.equal(result.semantic_navigation_required, false)
    assert.equal(result.needsLLM, true)
  })

  it('integrates natively into LocalModelRuntime and reports neural_tensor inferenceSource', async () => {
    const runtime = new LocalModelRuntime()
    await runtime.initInBackground()
    await new Promise(r => setTimeout(r, 150))

    const status = runtime.getStatus()
    assert.equal(status.initialized, true)
    assert.equal(status.ready, true)
    assert.equal(status.hasCompactNeuralModel, true)
    assert.equal(status.inferenceSource, 'neural_tensor')

    const decision = await runtime.predict({ request: 'git diff HEAD~1' })
    assert.equal(decision.intent, 'git')
    assert.equal(decision.inferenceSource, 'neural_tensor')
    assert.ok(decision.latencyMs < 50, `Latency must be fast, got ${decision.latencyMs}ms`)
  })
})
