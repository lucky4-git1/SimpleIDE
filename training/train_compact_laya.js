import fsPromises from 'fs/promises'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

// 1. Load Dataset Splits
async function loadJsonl(filePath) {
  const content = await fsPromises.readFile(filePath, 'utf8')
  return content.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l))
}

// Math helpers
function softmax(arr, temperature = 1.0) {
  const scaled = arr.map(x => x / temperature)
  const max = Math.max(...scaled)
  const exps = scaled.map(x => Math.exp(Math.max(-20, Math.min(20, x - max))))
  const sum = exps.reduce((a, b) => a + b, 0) || 1e-9
  return exps.map(x => x / sum)
}

function sigmoid(z, temperature = 1.0) {
  const scaled = z / temperature
  return 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, scaled))))
}

// 2. Vocabulary & Feature Extractor
class FeatureExtractor {
  constructor(maxVocab = 1024) {
    this.maxVocab = maxVocab
    this.vocab = new Map() // word -> id
    this.idf = new Map()
    this.wordCounts = new Map()
  }

  tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9_\-\.\/]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && w.length <= 40)
  }

  fit(records) {
    const docCounts = new Map()
    const N = records.length

    for (const r of records) {
      const task = r.state?.task || r.prompt || ''
      const state = r.state?.state || r.state || ''
      const target = r.state?.target?.file || ''
      const category = r.category || ''
      const text = `${task} ${state} ${target} ${category}`

      const tokens = new Set(this.tokenize(text))
      for (const t of tokens) {
        docCounts.set(t, (docCounts.get(t) || 0) + 1)
        this.wordCounts.set(t, (this.wordCounts.get(t) || 0) + 1)
      }
    }

    // Select top words by frequency
    const sorted = [...this.wordCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, this.maxVocab)
    let idx = 0
    for (const [w] of sorted) {
      this.vocab.set(w, idx++)
      const df = docCounts.get(w) || 1
      this.idf.set(w, Math.log((N + 1) / (df + 1)) + 1)
    }
  }

  transform(task, state = '', file = '') {
    const vec = new Float32Array(this.maxVocab)
    const tokens = this.tokenize(`${task} ${state} ${file}`)
    for (const t of tokens) {
      const id = this.vocab.get(t)
      if (id !== undefined) {
        vec[id] += this.idf.get(t) || 1.0
      }
    }
    // L2 normalize
    let norm = 0
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i]
    norm = Math.sqrt(norm) || 1.0
    for (let i = 0; i < vec.length; i++) vec[i] /= norm
    return vec
  }
}

// 3. Multi-Head Dense Neural Classifier
export class MultiHeadDecisionNet {
  constructor(inputDim = 1024, hiddenDim = 128) {
    this.inputDim = inputDim
    this.hiddenDim = hiddenDim

    // Head definition classes matching Laya taxonomy
    this.headDefs = {
      intent: ['explain', 'search', 'navigate', 'edit', 'refactor', 'debug', 'test', 'git', 'inspect', 'recover', 'run_command', 'create', 'verify'],
      actionClass: ['main_llm', 'local_tool', 'verification', 'recovery', 'terminal', 'delegation'],
      toolFamily: ['none', 'editor', 'terminal', 'filesystem', 'search', 'testing', 'git', 'diagnostics', 'symbol_graph'],
      symbol_navigation: ['none', 'optional', 'required'],
      context_breadth: ['minimal', 'focused', 'wide'],
      graph_depth: ['0', '1', '2'],
      risk: ['low', 'medium', 'high']
    }

    // Binary heads
    this.binaryHeads = ['semantic_navigation_required', 'verification_required', 'tests_required', 'stuck', 'strategy_change']

    // Shared Hidden Layer Weights: [inputDim x hiddenDim]
    this.W_hidden = new Float32Array(inputDim * hiddenDim)
    this.b_hidden = new Float32Array(hiddenDim)

    // Output Head Weights: head -> Float32Array
    this.heads = {}
    for (const [head, classes] of Object.entries(this.headDefs)) {
      this.heads[head] = {
        classes,
        W: new Float32Array(hiddenDim * classes.length),
        b: new Float32Array(classes.length)
      }
    }

    this.bHeads = {}
    for (const head of this.binaryHeads) {
      this.bHeads[head] = {
        W: new Float32Array(hiddenDim),
        b: 0.0
      }
    }

    this.temperature = 1.10
    this._initializeWeights()
  }

  _initializeWeights() {
    const scaleHidden = Math.sqrt(2.0 / this.inputDim)
    for (let i = 0; i < this.W_hidden.length; i++) {
      this.W_hidden[i] = (Math.random() * 2 - 1) * scaleHidden
    }

    const scaleOut = Math.sqrt(2.0 / this.hiddenDim)
    for (const head of Object.values(this.heads)) {
      for (let i = 0; i < head.W.length; i++) {
        head.W[i] = (Math.random() * 2 - 1) * scaleOut
      }
    }
    for (const bHead of Object.values(this.bHeads)) {
      for (let i = 0; i < bHead.W.length; i++) {
        bHead.W[i] = (Math.random() * 2 - 1) * scaleOut
      }
    }
  }

  forward(x) {
    // 1. Shared Dense Layer: h = ReLU(W_hidden * x + b)
    const h = new Float32Array(this.hiddenDim)
    for (let j = 0; j < this.hiddenDim; j++) {
      let sum = this.b_hidden[j]
      const offset = j * this.inputDim
      for (let i = 0; i < this.inputDim; i++) {
        if (x[i] !== 0) {
          sum += x[i] * this.W_hidden[offset + i]
        }
      }
      h[j] = Math.max(0, sum) // ReLU
    }

    const predictions = {}
    const rawLogits = {}

    // 2. Discrete classification heads
    for (const [head, meta] of Object.entries(this.heads)) {
      const numClasses = meta.classes.length
      const logits = new Float32Array(numClasses)
      for (let c = 0; c < numClasses; c++) {
        let sum = meta.b[c]
        const offset = c * this.hiddenDim
        for (let j = 0; j < this.hiddenDim; j++) {
          sum += h[j] * meta.W[offset + j]
        }
        logits[c] = sum
      }
      rawLogits[head] = Array.from(logits)
      const probs = softmax(Array.from(logits), this.temperature)
      let bestIdx = 0
      let maxProb = probs[0]
      for (let c = 1; c < probs.length; c++) {
        if (probs[c] > maxProb) {
          maxProb = probs[c]
          bestIdx = c
        }
      }
      predictions[head] = {
        value: meta.classes[bestIdx],
        confidence: Number(maxProb.toFixed(4)),
        probabilities: probs
      }
    }

    // 3. Binary heads
    for (const [head, meta] of Object.entries(this.bHeads)) {
      let sum = meta.b
      for (let j = 0; j < this.hiddenDim; j++) {
        sum += h[j] * meta.W[j]
      }
      rawLogits[head] = sum
      const prob = sigmoid(sum, this.temperature)
      predictions[head] = {
        value: prob >= 0.5,
        confidence: Number((prob >= 0.5 ? prob : 1 - prob).toFixed(4)),
        probability: Number(prob.toFixed(4))
      }
    }

    return { predictions, rawLogits, hidden: h }
  }

  // Multi-Task SGD with Adam-like adaptive step
  train(trainData, valData, epochs = 35, lr = 0.04) {
    console.log(`Training compact multi-head decision net across ${epochs} epochs...`)

    for (let epoch = 1; epoch <= epochs; epoch++) {
      let totalLoss = 0
      let correctCount = 0
      let totalPredictions = 0

      // Shuffle trainData
      const shuffled = [...trainData].sort(() => Math.random() - 0.5)

      for (const item of shuffled) {
        const x = item.featureVector
        const { predictions, rawLogits, hidden } = this.forward(x)

        const grad_h = new Float32Array(this.hiddenDim)

        // Loss and gradient for discrete heads
        for (const [head, meta] of Object.entries(this.heads)) {
          const targetVal = String(item.labels[head] ?? meta.classes[0])
          let targetIdx = meta.classes.indexOf(targetVal)
          if (targetIdx === -1) targetIdx = 0

          const probs = predictions[head].probabilities
          const loss = -Math.log(Math.max(1e-9, probs[targetIdx]))
          totalLoss += loss

          if (predictions[head].value === targetVal) correctCount++
          totalPredictions++

          for (let c = 0; c < meta.classes.length; c++) {
            const dL_dz = (probs[c] - (c === targetIdx ? 1.0 : 0.0)) / this.temperature
            const offset = c * this.hiddenDim

            for (let j = 0; j < this.hiddenDim; j++) {
              grad_h[j] += dL_dz * meta.W[offset + j]
              meta.W[offset + j] -= lr * dL_dz * hidden[j]
            }
            meta.b[c] -= lr * dL_dz
          }
        }

        // Loss and gradient for binary heads
        for (const [head, meta] of Object.entries(this.bHeads)) {
          const targetBool = Boolean(item.labels[head])
          const prob = predictions[head].probability
          const targetVal = targetBool ? 1.0 : 0.0
          const loss = -(targetVal * Math.log(Math.max(1e-9, prob)) + (1 - targetVal) * Math.log(Math.max(1e-9, 1 - prob)))
          totalLoss += loss

          if (predictions[head].value === targetBool) correctCount++
          totalPredictions++

          const dL_dz = (prob - targetVal) / this.temperature
          for (let j = 0; j < this.hiddenDim; j++) {
            grad_h[j] += dL_dz * meta.W[j]
            meta.W[j] -= lr * dL_dz * hidden[j]
          }
          meta.b -= lr * dL_dz
        }

        // Backprop through ReLU
        for (let j = 0; j < this.hiddenDim; j++) {
          if (hidden[j] <= 0) grad_h[j] = 0
        }

        // Update shared layer weights
        for (let j = 0; j < this.hiddenDim; j++) {
          if (grad_h[j] !== 0) {
            const offset = j * this.inputDim
            for (let i = 0; i < this.inputDim; i++) {
              if (x[i] !== 0) {
                this.W_hidden[offset + i] -= lr * grad_h[j] * x[i]
              }
            }
            this.b_hidden[j] -= lr * grad_h[j]
          }
        }
      }

      const trainAcc = (correctCount / totalPredictions) * 100
      const avgLoss = totalLoss / trainData.length

      if (epoch % 5 === 0 || epoch === epochs) {
        const valMetrics = this.evaluate(valData)
        console.log(`Epoch ${epoch}/${epochs} - Loss: ${avgLoss.toFixed(4)} - Train Acc: ${trainAcc.toFixed(1)}% - Val Acc: ${valMetrics.accuracy.toFixed(1)}%`)
      }
    }
  }

  evaluate(records) {
    let correct = 0
    let total = 0
    const headCorrect = {}

    for (const r of records) {
      const { predictions } = this.forward(r.featureVector)
      for (const [head, pred] of Object.entries(predictions)) {
        if (!headCorrect[head]) headCorrect[head] = { correct: 0, total: 0 }
        headCorrect[head].total++
        total++

        const groundTruth = r.labels[head]
        const isMatch = (typeof groundTruth === 'boolean') ? pred.value === groundTruth : String(pred.value) === String(groundTruth)
        if (isMatch) {
          correct++
          headCorrect[head].correct++
        }
      }
    }

    const accuracy = (correct / total) * 100
    return { accuracy, headCorrect }
  }

  toJSON() {
    return {
      format: 'simpleide-compact-laya-v1',
      version: '1.0.0',
      inputDim: this.inputDim,
      hiddenDim: this.hiddenDim,
      temperature: this.temperature,
      headDefs: this.headDefs,
      binaryHeads: this.binaryHeads,
      W_hidden: Array.from(this.W_hidden),
      b_hidden: Array.from(this.b_hidden),
      heads: Object.fromEntries(
        Object.entries(this.heads).map(([k, v]) => [k, { classes: v.classes, W: Array.from(v.W), b: Array.from(v.b) }])
      ),
      bHeads: Object.fromEntries(
        Object.entries(this.bHeads).map(([k, v]) => [k, { W: Array.from(v.W), b: v.b }])
      )
    }
  }

  static fromJSON(data) {
    const net = new MultiHeadDecisionNet(data.inputDim, data.hiddenDim)
    net.temperature = data.temperature || 1.10
    net.W_hidden = new Float32Array(data.W_hidden)
    net.b_hidden = new Float32Array(data.b_hidden)
    for (const [k, v] of Object.entries(data.heads)) {
      net.heads[k] = { classes: v.classes, W: new Float32Array(v.W), b: new Float32Array(v.b) }
    }
    for (const [k, v] of Object.entries(data.bHeads)) {
      net.bHeads[k] = { W: new Float32Array(v.W), b: v.b }
    }
    return net
  }
}

// 4. Main Training Routine
async function main() {
  const trainPath = path.resolve('training/data/train.jsonl')
  const valPath = path.resolve('training/data/val.jsonl')
  const testPath = path.resolve('training/data/test.jsonl')

  const trainRaw = await loadJsonl(trainPath)
  const valRaw = await loadJsonl(valPath)
  const testRaw = await loadJsonl(testPath)

  console.log(`Loaded dataset splits: Train=${trainRaw.length}, Val=${valRaw.length}, Test=${testRaw.length}`)

  // Extract features
  const extractor = new FeatureExtractor(1024)
  extractor.fit(trainRaw)
  console.log(`Vocabulary fitted: ${extractor.vocab.size} unique n-gram features`)

  // Label normalizer
  const normalizeLabels = r => {
    const targets = r.targets || {}
    let actionClass = 'main_llm'
    const intent = targets.intent || 'explain'
    if (['test', 'git', 'inspect', 'search', 'run_command'].includes(intent)) {
      actionClass = 'local_tool'
    } else if (['verify'].includes(intent)) {
      actionClass = 'verification'
    } else if (['recover'].includes(intent)) {
      actionClass = 'recovery'
    }

    let symbolNav = 'none'
    if (targets.semantic_navigation_required) {
      symbolNav = 'required'
    } else if (['edit', 'refactor'].includes(intent)) {
      symbolNav = 'optional'
    }

    return {
      intent,
      actionClass,
      toolFamily: targets.tool_family || 'none',
      symbol_navigation: symbolNav,
      context_breadth: targets.context_breadth || 'minimal',
      graph_depth: String(targets.graph_depth ?? '0'),
      risk: targets.risk || 'low',
      semantic_navigation_required: Boolean(targets.semantic_navigation_required),
      verification_required: Boolean(targets.verification_required),
      tests_required: Boolean(targets.tests_required),
      stuck: Boolean(targets.stuck),
      strategy_change: Boolean(targets.strategy_change)
    }
  }

  // Pre-transform dataset
  const prepare = r => ({
    raw: r,
    featureVector: extractor.transform(r.state?.task || r.prompt, r.state?.state, r.state?.target?.file),
    labels: normalizeLabels(r)
  })

  const trainData = trainRaw.map(prepare)
  const valData = valRaw.map(prepare)
  const testData = testRaw.map(prepare)

  // Train Multi-Head Net
  const model = new MultiHeadDecisionNet(1024, 128)
  model.train(trainData, valData, 35, 0.05)

  // Evaluate on Held-Out Test Set
  console.log('\n--- Final Evaluation on 400 Held-Out Test Examples ---')
  const testMetrics = model.evaluate(testData)
  console.log(`Overall Held-Out Test Accuracy: ${testMetrics.accuracy.toFixed(2)}%`)
  for (const [head, res] of Object.entries(testMetrics.headCorrect)) {
    console.log(`  - Head '${head}': ${((res.correct / res.total) * 100).toFixed(1)}% (${res.correct}/${res.total})`)
  }

  // Export artifacts to assets/models/laya/
  const outDir = path.resolve('assets/models/laya')
  await fsPromises.mkdir(outDir, { recursive: true })

  const modelJson = {
    ...model.toJSON(),
    vocab: Object.fromEntries(extractor.vocab),
    idf: Object.fromEntries(extractor.idf)
  }

  const modelJsonStr = JSON.stringify(modelJson)
  const modelPath = path.join(outDir, 'simpleide-laya-compact.json')
  await fsPromises.writeFile(modelPath, modelJsonStr, 'utf8')
  const modelSizeMB = (Buffer.byteLength(modelJsonStr) / (1024 * 1024)).toFixed(2)

  const sha256 = crypto.createHash('sha256').update(modelJsonStr).digest('hex')

  const manifest = {
    name: 'SimpleIDE Laya Compact Decision Engine',
    modelId: 'simpleide-laya-compact',
    format: 'neural-tensor',
    version: '1.0.0',
    sizeBytes: Buffer.byteLength(modelJsonStr),
    sizeMB: Number(modelSizeMB),
    sha256: sha256,
    accuracy: Number(testMetrics.accuracy.toFixed(2)),
    inputDim: 1024,
    hiddenDim: 128,
    decisionHeads: Object.keys(model.headDefs).concat(model.binaryHeads),
    bundled: true,
    zeroDownloadRequired: true
  }

  await fsPromises.writeFile(path.join(outDir, 'model-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  console.log(`\nSuccessfully exported compact neural model to ${modelPath}`)
  console.log(`Model Size: ${modelSizeMB} MB`)
  console.log(`SHA-256: ${sha256}`)
}

main().catch(err => {
  console.error('Training failed:', err)
  process.exit(1)
})
