import fs from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'

/**
 * validate_dataset.js:
 * Rigorously checks pilot dataset quality, distributions, hard-negatives, duplicates,
 * conflicting labels, and verifies zero leakage across train, val, and test splits.
 */

async function loadJsonl(filePath) {
  const content = await fsPromises.readFile(filePath, 'utf8')
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

export async function validateDataset(dataDir = 'training/data') {
  console.log('========================================================================')
  console.log('Phase 4 Pilot Dataset Quality & Leakage Validation')
  console.log('========================================================================\n')

  const train = await loadJsonl(path.join(dataDir, 'train.jsonl'))
  const val = await loadJsonl(path.join(dataDir, 'val.jsonl'))
  const test = await loadJsonl(path.join(dataDir, 'test.jsonl'))

  const allRecords = [...train, ...val, ...test]

  // 1. Dataset Counts
  console.log(`Total Dataset Examples: ${allRecords.length}`)
  console.log(`- Train: ${train.length} (${((train.length / allRecords.length) * 100).toFixed(1)}%)`)
  console.log(`- Validation: ${val.length} (${((val.length / allRecords.length) * 100).toFixed(1)}%)`)
  console.log(`- Test: ${test.length} (${((test.length / allRecords.length) * 100).toFixed(1)}%)\n`)

  // 2. Class Distribution (Intent, ToolFamily, ContextBreadth, Risk)
  const countDistribution = (records, key) => {
    const dist = {}
    for (const r of records) {
      const val = r.targets[key]
      dist[val] = (dist[val] || 0) + 1
    }
    return dist
  }

  console.log('--- Target Class Distributions (Train) ---')
  console.log('Intent:', countDistribution(train, 'intent'))
  console.log('Tool Family:', countDistribution(train, 'tool_family'))
  console.log('Context Breadth:', countDistribution(train, 'context_breadth'))
  console.log('Graph Depth:', countDistribution(train, 'graph_depth'))
  console.log('Risk Level:', countDistribution(train, 'risk'))
  console.log('Semantic Navigation Required:', countDistribution(train, 'semantic_navigation_required'))
  console.log('Verification Required:', countDistribution(train, 'verification_required'))
  console.log('Stuck State Detection:', countDistribution(train, 'stuck'))

  // 3. Label Source Distribution
  const labelSourceDist = {}
  for (const r of allRecords) {
    labelSourceDist[r.labelSource] = (labelSourceDist[r.labelSource] || 0) + 1
  }
  console.log('\n--- Label Source Distribution ---')
  for (const [src, count] of Object.entries(labelSourceDist)) {
    console.log(`- ${src}: ${count} (${((count / allRecords.length) * 100).toFixed(1)}%)`)
  }

  // 4. Hard Negatives Analysis
  const hardNegatives = allRecords.filter(r => r.isHardNegative)
  const hardNegPct = ((hardNegatives.length / allRecords.length) * 100).toFixed(1)
  console.log(`\n--- Hard Negatives ---`)
  console.log(`Hard Negatives Count: ${hardNegatives.length} (${hardNegPct}%)`)

  // 5. Duplicates & Conflicting Labels Check
  const promptToTargets = new Map()
  let duplicatePrompts = 0
  let conflictingLabels = 0

  for (const r of allRecords) {
    const promptKey = r.state.task.trim().toLowerCase()
    const targetSig = JSON.stringify(r.targets)
    if (promptToTargets.has(promptKey)) {
      duplicatePrompts++
      const prevSig = promptToTargets.get(promptKey)
      if (prevSig !== targetSig) {
        conflictingLabels++
      }
    } else {
      promptToTargets.set(promptKey, targetSig)
    }
  }

  console.log(`\n--- Duplicates & Conflict Analysis ---`)
  console.log(`Unique Prompts: ${promptToTargets.size}`)
  console.log(`Duplicate Prompts within splits: ${duplicatePrompts}`)
  console.log(`Conflicting Labels: ${conflictingLabels} (MUST be 0)`)

  // 6. Cross-Split Leakage Check (Train vs Val vs Test)
  const trainPrompts = new Set(train.map(r => r.state.task.trim().toLowerCase()))
  const valPrompts = new Set(val.map(r => r.state.task.trim().toLowerCase()))
  const testPrompts = new Set(test.map(r => r.state.task.trim().toLowerCase()))

  let trainValOverlap = 0
  let trainTestOverlap = 0
  let valTestOverlap = 0

  for (const p of valPrompts) {
    if (trainPrompts.has(p)) trainValOverlap++
  }
  for (const p of testPrompts) {
    if (trainPrompts.has(p)) trainTestOverlap++
    if (valPrompts.has(p)) valTestOverlap++
  }

  // Entity leakage check
  const trainEntities = new Set(train.map(r => r.sourceIdentity.split('/')[1]))
  const valEntities = new Set(val.map(r => r.sourceIdentity.split('/')[1]))
  const testEntities = new Set(test.map(r => r.sourceIdentity.split('/')[1]))

  let entityLeakage = 0
  for (const e of valEntities) {
    if (trainEntities.has(e)) entityLeakage++
  }
  for (const e of testEntities) {
    if (trainEntities.has(e) || valEntities.has(e)) entityLeakage++
  }

  console.log(`\n--- Cross-Split Leakage Analysis ---`)
  console.log(`Prompt Overlap Train <-> Val: ${trainValOverlap} (MUST be 0)`)
  console.log(`Prompt Overlap Train <-> Test: ${trainTestOverlap} (MUST be 0)`)
  console.log(`Prompt Overlap Val <-> Test: ${valTestOverlap} (MUST be 0)`)
  console.log(`Entity Namespace Overlap: ${entityLeakage} (MUST be 0)`)

  // 7. Representative Examples
  console.log(`\n--- Representative Dataset Examples ---`)
  const samples = [
    train.find(r => r.isHardNegative),
    train.find(r => r.category === 'semantic_navigation'),
    train.find(r => r.category === 'stuck_detection'),
    train.find(r => r.category === 'golden_auth_scenario')
  ]

  for (const s of samples) {
    if (!s) continue
    console.log(JSON.stringify({
      id: s.id,
      category: s.category,
      labelSource: s.labelSource,
      difficulty: s.difficulty,
      isHardNegative: s.isHardNegative,
      task: s.state.task,
      targets: {
        intent: s.targets.intent,
        tool_family: s.targets.tool_family,
        semantic_navigation_required: s.targets.semantic_navigation_required,
        stuck: s.targets.stuck,
        risk: s.targets.risk
      }
    }, null, 2))
  }

  const isValid = conflictingLabels === 0 &&
                  trainValOverlap === 0 &&
                  trainTestOverlap === 0 &&
                  valTestOverlap === 0 &&
                  entityLeakage === 0 &&
                  allRecords.length >= 2000 &&
                  allRecords.length <= 5000

  console.log(`\n========================================================================`)
  console.log(`Phase 4 Pilot Dataset Validation Status: ${isValid ? 'PASSED (STRICT QUALITY MET)' : 'FAILED'}`)
  console.log(`========================================================================`)

  return {
    isValid,
    totalRecords: allRecords.length,
    trainCount: train.length,
    valCount: val.length,
    testCount: test.length,
    conflictingLabels,
    trainValOverlap,
    trainTestOverlap,
    entityLeakage,
    hardNegPct,
    labelSourceDist
  }
}

if (process.argv[1]?.endsWith('validate_dataset.js')) {
  validateDataset().catch(console.error)
}
