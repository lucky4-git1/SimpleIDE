import fs from 'fs'

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

export class CompactNeuralRuntime {
  constructor(modelData) {
    this.format = modelData.format || 'simpleide-compact-laya-v1'
    this.version = modelData.version || '1.0.0'
    this.inputDim = modelData.inputDim || 1024
    this.hiddenDim = modelData.hiddenDim || 128
    this.temperature = modelData.temperature || 1.10
    this.vocab = new Map(Object.entries(modelData.vocab || {}))
    this.idf = new Map(Object.entries(modelData.idf || {}))

    this.W_hidden = new Float32Array(modelData.W_hidden)
    this.b_hidden = new Float32Array(modelData.b_hidden)

    this.heads = {}
    for (const [k, v] of Object.entries(modelData.heads || {})) {
      this.heads[k] = {
        classes: v.classes,
        W: new Float32Array(v.W),
        b: new Float32Array(v.b)
      }
    }

    this.bHeads = {}
    for (const [k, v] of Object.entries(modelData.bHeads || {})) {
      this.bHeads[k] = {
        W: new Float32Array(v.W),
        b: Number(v.b)
      }
    }
  }

  tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9_\-\.\/]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && w.length <= 40)
  }

  vectorize(text, state = '', file = '') {
    const vec = new Float32Array(this.inputDim)
    const tokens = this.tokenize(`${text} ${state} ${file}`)
    for (const t of tokens) {
      const id = this.vocab.get(t)
      if (id !== undefined && id < this.inputDim) {
        vec[id] += this.idf.get(t) || 1.0
      }
    }
    let norm = 0
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i]
    norm = Math.sqrt(norm) || 1.0
    for (let i = 0; i < vec.length; i++) vec[i] /= norm
    return vec
  }

  forward(x) {
    // Shared Layer
    const h = new Float32Array(this.hiddenDim)
    for (let j = 0; j < this.hiddenDim; j++) {
      let sum = this.b_hidden[j]
      const offset = j * this.inputDim
      for (let i = 0; i < this.inputDim; i++) {
        if (x[i] !== 0) {
          sum += x[i] * this.W_hidden[offset + i]
        }
      }
      h[j] = Math.max(0, sum)
    }

    const predictions = {}
    const rawLogits = {}

    // Discrete heads
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

    // Binary heads
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

    return { predictions, rawLogits }
  }

  predict(request, state = 'IDLE', file = '') {
    const x = this.vectorize(request, state, file)
    const { predictions, rawLogits } = this.forward(x)

    const intent = predictions.intent?.value || 'explain'
    const actionClass = predictions.actionClass?.value || 'main_llm'
    const toolFamily = predictions.toolFamily?.value || 'none'

    return {
      intent,
      actionClass,
      toolFamily,
      confidence: predictions.intent?.confidence || 0.95,
      symbol_navigation: predictions.symbol_navigation?.value || 'none',
      semantic_navigation_required: Boolean(predictions.semantic_navigation_required?.value),
      context_breadth: predictions.context_breadth?.value || 'minimal',
      graph_depth: predictions.graph_depth?.value || '0',
      risk: predictions.risk?.value || 'low',
      needsVerification: Boolean(predictions.verification_required?.value),
      tests_required: Boolean(predictions.tests_required?.value),
      stuck: Boolean(predictions.stuck?.value),
      strategy_change: Boolean(predictions.strategy_change?.value),
      needsLLM: !['local_tool', 'verification', 'recovery'].includes(actionClass),
      inferenceSource: 'neural_tensor',
      modelVersion: `simpleide-laya-compact-v${this.version}`,
      logits: rawLogits
    }
  }

  static loadFromFile(filePath) {
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return new CompactNeuralRuntime(parsed)
  }
}
