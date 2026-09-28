import fsPromises from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { LayaModelManager } from '../src/services/agentEngine/LayaModelManager.js'
import { LayaDecisionAdapter } from '../src/services/agentEngine/LayaDecisionAdapter.js'
import { ContextPlanner } from '../src/services/agentEngine/ContextPlanner.js'
import { ContextEngine } from '../src/services/agentEngine/ContextEngine.js'
import { CodeIntelligenceService } from '../src/services/agentEngine/CodeIntelligenceService.js'
import { fileURLToPath } from 'node:url'
import { PrimeRouter, LAYA_ROLLOUT_MODES } from '../src/services/agentEngine/PrimeRouter.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function percentile(arr, p) {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

export async function profileCompleteSystem() {
  console.log('========================================================================')
  console.log('Phase 13: End-to-End System Performance & Resource Profiling')
  console.log('========================================================================\n')

  const metrics = {
    lifecycle: {},
    inference: {},
    contextAndGraph: {},
    decisionComparison: {},
    resources: {}
  }

  const initialMem = process.memoryUsage()
  const initialCpu = process.cpuUsage()

  // 1. Module / Application Startup
  const startupStart = performance.now()
  const codeIntel = new CodeIntelligenceService('D:/test/workspace')
  codeIntel.indexFile('src/auth/tokenService.js', `
    export function generateToken(payload) { return "jwt_" + payload.id; }
    export function verifyToken(token) { return token.startsWith("jwt_"); }
  `)
  codeIntel.indexFile('src/controllers/authController.js', `
    import { generateToken, verifyToken } from "../auth/tokenService";
    export function handleLogin(req) { return generateToken(req.user); }
  `)
  const startupDuration = performance.now() - startupStart
  metrics.lifecycle.applicationStartupMs = Number(startupDuration.toFixed(2))
  console.log(`1. Application / Component Startup: ${startupDuration.toFixed(2)} ms`)

  // 2. Model Acquisition (Stream -> Temp Staging -> SHA-256 -> Atomic Rename)
  const tempDir = path.join(os.tmpdir(), `laya-p13-${Date.now()}`)
  await fsPromises.mkdir(tempDir, { recursive: true })
  const manager = new LayaModelManager({ cacheDir: tempDir })

  const chunk100Mb = Buffer.alloc(100 * 1024 * 1024, 0x42)
  const expectedSha = crypto.createHash('sha256').update(chunk100Mb).digest('hex')

  const acqStart = performance.now()
  await manager.installModelAtomically(chunk100Mb, 'simpleide', expectedSha)
  const acqDuration = performance.now() - acqStart
  const throughputMBs = 100 / (acqDuration / 1000)
  metrics.lifecycle.modelAcquisitionMs = Number(acqDuration.toFixed(2))
  metrics.lifecycle.acquisitionThroughputMBs = Number(throughputMBs.toFixed(2))
  console.log(`2. Model Acquisition: ${acqDuration.toFixed(2)} ms (${throughputMBs.toFixed(2)} MB/s)`)

  // 3. Disk -> RAM Model Load
  const installedPath = manager.resolveLocalModelPath('simpleide')
  const diskStart = performance.now()
  const readBuffer = await fsPromises.readFile(installedPath)
  const diskDuration = performance.now() - diskStart
  const diskThroughputMBs = (readBuffer.length / (1024 * 1024)) / (diskDuration / 1000)
  metrics.lifecycle.diskToRamLoadMs = Number(diskDuration.toFixed(2))
  metrics.lifecycle.diskReadThroughputMBs = Number(diskThroughputMBs.toFixed(2))
  console.log(`3. Disk -> RAM Model Load: ${diskDuration.toFixed(2)} ms (${diskThroughputMBs.toFixed(2)} MB/s)`)

  // 4. ONNX Session Initialization
  const adapter = new LayaDecisionAdapter({ modelPath: installedPath })
  const sessionStart = performance.now()
  await adapter.initialize()
  const sessionDuration = performance.now() - sessionStart
  metrics.lifecycle.onnxSessionInitMs = Number(sessionDuration.toFixed(2))
  console.log(`4. ONNX Session Initialization: ${sessionDuration.toFixed(2)} ms`)

  // 5. First Inference (Cold Start)
  const coldStart = performance.now()
  await adapter.predict({ task: 'Cold start prediction query' })
  const coldDuration = performance.now() - coldStart
  metrics.inference.coldStartInferenceMs = Number(coldDuration.toFixed(2))
  console.log(`5. First Inference (Cold Start): ${coldDuration.toFixed(2)} ms`)

  // 6. Warm Inference Distribution (100 runs)
  const warmLatencies = []
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now()
    await adapter.predict({ task: `Warm inference query iteration ${i}` })
    warmLatencies.push(performance.now() - t0)
  }
  metrics.inference.warmP50Ms = Number(percentile(warmLatencies, 50).toFixed(3))
  metrics.inference.warmP95Ms = Number(percentile(warmLatencies, 95).toFixed(3))
  metrics.inference.warmP99Ms = Number(percentile(warmLatencies, 99).toFixed(3))
  metrics.inference.warmMeanMs = Number((warmLatencies.reduce((a, b) => a + b, 0) / warmLatencies.length).toFixed(3))
  console.log(`6. Warm Inference (100 runs): p50=${metrics.inference.warmP50Ms}ms, p95=${metrics.inference.warmP95Ms}ms, p99=${metrics.inference.warmP99Ms}ms`)

  // 7. ContextPlanner Latency
  const planner = new ContextPlanner({ codeIntelligence: codeIntel, layaAdapter: adapter })
  const plannerLatencies = []
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now()
    await planner.planContext({ task: 'Where is generateToken defined?', activeFile: 'src/controllers/authController.js' })
    plannerLatencies.push(performance.now() - t0)
  }
  metrics.contextAndGraph.contextPlannerP50Ms = Number(percentile(plannerLatencies, 50).toFixed(3))
  metrics.contextAndGraph.contextPlannerMeanMs = Number((plannerLatencies.reduce((a, b) => a + b, 0) / plannerLatencies.length).toFixed(3))
  console.log(`7. ContextPlanner Latency: p50=${metrics.contextAndGraph.contextPlannerP50Ms}ms, mean=${metrics.contextAndGraph.contextPlannerMeanMs}ms`)

  // 8. SymbolGraph Query Latency
  const graphLatencies = []
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now()
    codeIntel.symbolGraph.traverseContextGraph(['generateToken'], { maxDepth: 2 })
    graphLatencies.push(performance.now() - t0)
  }
  metrics.contextAndGraph.symbolGraphP50Ms = Number(percentile(graphLatencies, 50).toFixed(3))
  metrics.contextAndGraph.symbolGraphMeanMs = Number((graphLatencies.reduce((a, b) => a + b, 0) / graphLatencies.length).toFixed(3))
  console.log(`8. SymbolGraph Traversal Latency (depth=2): p50=${metrics.contextAndGraph.symbolGraphP50Ms}ms, mean=${metrics.contextAndGraph.symbolGraphMeanMs}ms`)

  // 9. Total Decision Overhead Comparison (Legacy vs Laya)
  const legacyRouter = new PrimeRouter({ layaMode: LAYA_ROLLOUT_MODES.LEGACY })
  const layaRouter = new PrimeRouter({ layaMode: LAYA_ROLLOUT_MODES.LAYA, adapter })

  const legacyTimes = []
  const layaTimes = []
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now()
    await legacyRouter.decide({ request: 'Where is generateToken defined?' })
    legacyTimes.push(performance.now() - t0)

    const t1 = performance.now()
    await layaRouter.decide({ request: 'Where is generateToken defined?' })
    layaTimes.push(performance.now() - t1)
  }

  metrics.decisionComparison = {
    legacyMeanMs: Number((legacyTimes.reduce((a, b) => a + b, 0) / legacyTimes.length).toFixed(3)),
    legacyP95Ms: Number(percentile(legacyTimes, 95).toFixed(3)),
    layaMeanMs: Number((layaTimes.reduce((a, b) => a + b, 0) / layaTimes.length).toFixed(3)),
    layaP95Ms: Number(percentile(layaTimes, 95).toFixed(3)),
    deltaMs: Number(((layaTimes.reduce((a, b) => a + b, 0) / layaTimes.length) - (legacyTimes.reduce((a, b) => a + b, 0) / legacyTimes.length)).toFixed(3))
  }
  console.log(`9. Decision Overhead Comparison: Legacy=${metrics.decisionComparison.legacyMeanMs}ms vs Laya=${metrics.decisionComparison.layaMeanMs}ms (delta: +${metrics.decisionComparison.deltaMs}ms)`)

  // 10. Memory & CPU Consumption
  const finalMem = process.memoryUsage()
  const finalCpu = process.cpuUsage(initialCpu)

  metrics.resources = {
    peakRssMB: Number((finalMem.rss / (1024 * 1024)).toFixed(2)),
    heapUsedMB: Number((finalMem.heapUsed / (1024 * 1024)).toFixed(2)),
    heapTotalMB: Number((finalMem.heapTotal / (1024 * 1024)).toFixed(2)),
    externalMB: Number((finalMem.external / (1024 * 1024)).toFixed(2)),
    cpuUserMs: Number((finalCpu.user / 1000).toFixed(2)),
    cpuSystemMs: Number((finalCpu.system / 1000).toFixed(2))
  }
  console.log(`10. Resource Footprint: Peak RSS=${metrics.resources.peakRssMB}MB, Heap Used=${metrics.resources.heapUsedMB}MB, CPU User=${metrics.resources.cpuUserMs}ms`)

  // Cleanup temp dir
  await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {})

  const outputPath = path.join(__dirname, 'system_performance_results.json')
  fs.writeFileSync(outputPath, JSON.stringify(metrics, null, 2), 'utf8')
  console.log(`\nSystem profiling results written to: ${outputPath}`)

  return metrics
}

profileCompleteSystem().catch(err => {
  console.error('System profiling failed:', err)
  process.exit(1)
})
