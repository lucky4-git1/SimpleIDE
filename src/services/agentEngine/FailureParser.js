/**
 * FailureParser.js
 *
 * Implements Phase 12: Smart Failure Attention
 * Parses test, compiler, and runtime failure logs into structured attention windows:
 * - Error type & message
 * - Failing file & line number
 * - Expected vs. Received assertions
 * - Stack trace frames
 * - Extracted symbol names & likely root cause
 */

const STACK_FRAME_PATTERNS = [
  /at\s+(?:async\s+)?(?:([^\s(]+)\s+\()?([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+):(\d+)(?::(\d+))?\)?/g,
  /([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+):(\d+):(\d+)/g,
  /File\s+"([^"]+)",\s+line\s+(\d+),\s+in\s+([a-zA-Z0-9_]+)/g
]

const ASSERTION_PATTERNS = [
  /(?:Expected|expected):\s*([^\n\r]+)[\s\S]*?(?:Received|actual):\s*([^\n\r]+)/i,
  /assert\.(?:equal|strictEqual|deepEqual)\((?:.*?)\)[\s\S]*?Expected:\s*([^\n\r]+)[\s\S]*?Actual:\s*([^\n\r]+)/i,
  /expected\s+([^\n\r]+)\s+to\s+(?:equal|be)\s+([^\n\r]+)/i
]

export class FailureParser {
  static parse(rawOutput) {
    const text = String(rawOutput || '').trim()
    if (!text) {
      return { hasFailure: false, formattedSummary: 'No failure detected.' }
    }

    const lines = text.split(/\r?\n/)
    let errorType = 'Error'
    let errorMessage = ''
    let failingFile = null
    let failingLine = null
    let expected = null
    let received = null
    const stackFrames = []
    const relatedSymbols = new Set()

    // 1. Error Type & Message Extraction
    const errorMatch = text.match(/\b([A-Z][a-zA-Z0-9_]*(?:Error|Exception|Failure)):\s*([^\r\n]+)/)
    if (errorMatch) {
      errorType = errorMatch[1]
      errorMessage = errorMatch[2].trim()
    } else {
      const failLine = lines.find(l => /FAIL|Error|failed|assertion/i.test(l))
      errorMessage = failLine ? failLine.trim() : 'Command returned a non-zero exit code.'
    }

    // 2. Assertion Expected vs Received
    for (const pattern of ASSERTION_PATTERNS) {
      const match = text.match(pattern)
      if (match) {
        expected = match[1].trim()
        received = match[2].trim()
        break
      }
    }

    // 3. Stack Trace & Failing File/Line
    for (const line of lines) {
      const atMatch = /at\s+(?:async\s+)?(?:([^\s(]+)\s+\()?([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+):(\d+)(?::(\d+))?\)?/.exec(line)
      if (atMatch) {
        const symbol = atMatch[1]
        const file = atMatch[2].replace(/\\/g, '/')
        const lineNum = parseInt(atMatch[3], 10)

        if (!file.includes('node_modules') && !file.includes('internal/')) {
          if (!failingFile) {
            failingFile = file
            failingLine = lineNum
          }
          stackFrames.push({ symbol: symbol || null, file, line: lineNum })
          if (symbol) relatedSymbols.add(symbol)
        }
      }
    }

    // Extract symbol identifiers from error message
    const symbolMatches = (errorMessage + ' ' + (expected || '') + ' ' + (received || '')).match(/\b[a-zA-Z_$][a-zA-Z0-9_$]{2,}\b/g) || []
    for (const sym of symbolMatches.slice(0, 5)) {
      if (!['true', 'false', 'null', 'undefined', 'expected', 'received', 'error'].includes(sym.toLowerCase())) {
        relatedSymbols.add(sym)
      }
    }

    const likelyRootCause = this.inferRootCause(errorType, errorMessage, expected, received)

    return {
      hasFailure: true,
      errorType,
      errorMessage,
      failingFile,
      failingLine,
      expected,
      received,
      stackFrames: stackFrames.slice(0, 5),
      relatedSymbols: [...relatedSymbols].slice(0, 6),
      likelyRootCause,
      formattedSummary: this.formatAttentionWindow({
        errorType,
        errorMessage,
        failingFile,
        failingLine,
        expected,
        received,
        stackFrames,
        relatedSymbols: [...relatedSymbols],
        likelyRootCause
      })
    }
  }

  static inferRootCause(type, msg, exp, rec) {
    if (exp && rec) return `Assertion failed: expected "${exp}" but received "${rec}".`
    if (type === 'TypeError' && msg.includes('undefined')) return 'Null or undefined property access.'
    if (type === 'ReferenceError') return 'Unresolved variable or symbol reference.'
    if (/import|module not found/i.test(msg)) return 'Missing dependency or invalid module path.'
    return msg || 'Test or build execution failed.'
  }

  static formatAttentionWindow({ errorType, failingFile, failingLine, expected, received, stackFrames, relatedSymbols, likelyRootCause }) {
    const out = ['[SMART FAILURE ATTENTION]']
    out.push(`Type: ${errorType}`)
    if (failingFile) out.push(`Location: ${failingFile}${failingLine ? ':' + failingLine : ''}`)
    if (expected || received) {
      if (expected) out.push(`Expected: ${expected}`)
      if (received) out.push(`Received: ${received}`)
    }
    if (stackFrames.length) {
      out.push(`Trace: ${stackFrames.map(f => f.symbol ? `${f.symbol} (${f.file}:${f.line})` : `${f.file}:${f.line}`).join(' → ')}`)
    }
    if (relatedSymbols.length) {
      out.push(`Related Symbols: ${relatedSymbols.join(', ')}`)
    }
    out.push(`Likely Cause: ${likelyRootCause}`)
    return out.join('\n')
  }
}
