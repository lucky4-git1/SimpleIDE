import * as babelParser from '@babel/parser'

/**
 * Normalized Symbol Record representation
 */
export class SymbolRecord {
  constructor({
    id,
    name,
    kind,
    file,
    startLine = 1,
    endLine = 1,
    startColumn = 0,
    endColumn = 0,
    exported = false,
    parent = null,
    signature = ''
  }) {
    this.id = id || `${file}:${startLine}:${kind}:${name}`
    this.name = name
    this.symbol = name
    this.kind = kind // 'function' | 'class' | 'method' | 'variable' | 'constant' | 'interface' | 'type' | 'enum' | 'component' | 'export'
    this.file = file
    this.startLine = startLine
    this.endLine = endLine
    this.startColumn = startColumn
    this.endColumn = endColumn
    this.exported = Boolean(exported)
    this.parent = parent || null
    this.signature = signature || ''
  }
}

/**
 * AST-based parser for JavaScript, TypeScript, JSX, and TSX files
 */
class BabelAstParser {
  parse(source, relPath) {
    const symbols = []
    const imports = []
    const exports = []
    const calls = []
    const implementations = []
    const diagnostics = []
    const isTest = /\.(?:test|spec)\.[jt]sx?$/i.test(relPath) || /(?:^|\/)(?:__tests__|tests|specs)\//i.test(relPath)

    const ext = relPath.split('.').pop()?.toLowerCase() || 'js'
    const isTypeScript = ext === 'ts' || ext === 'tsx' || ext === 'mts' || ext === 'cts'
    const isJsx = ext === 'jsx' || ext === 'tsx'

    const plugins = [
      'classProperties',
      'classPrivateProperties',
      'classPrivateMethods',
      'decorators-legacy',
      'dynamicImport',
      'exportDefaultFrom',
      'exportNamespaceFrom',
      'objectRestSpread',
      'asyncGenerators',
      'optionalChaining',
      'nullishCoalescingOperator'
    ]

    if (isTypeScript) plugins.push('typescript')
    if (isJsx) plugins.push('jsx')

    let ast
    try {
      ast = babelParser.parse(source, {
        sourceType: 'module',
        plugins,
        errorRecovery: true
      })
    } catch (err) {
      diagnostics.push({
        file: relPath,
        line: err.loc?.line || 1,
        column: err.loc?.column || 0,
        message: err.message || 'Syntax parse error',
        severity: 'error'
      })
      // Fallback for non-module or script files
      try {
        ast = babelParser.parse(source, {
          sourceType: 'script',
          plugins,
          errorRecovery: true
        })
      } catch {
        return { symbols, imports, exports, calls, implementations, diagnostics, isTest }
      }
    }

    if (ast?.errors?.length) {
      for (const err of ast.errors) {
        diagnostics.push({
          file: relPath,
          line: err.loc?.line || 1,
          column: err.loc?.column || 0,
          message: err.message,
          severity: 'error'
        })
      }
    }

    if (!ast || !ast.program) {
      return { symbols, imports, exports, calls, implementations, diagnostics, isTest }
    }

    const body = ast.program.body || []

    for (const node of body) {
      this.processNode(node, relPath, symbols, imports, exports, calls, implementations, source)
    }

    return { symbols, imports, exports, calls, implementations, diagnostics, isTest }
  }

  processNode(node, relPath, symbols, imports, exports, calls, implementations, source, parentName = null, isExported = false) {
    if (!node) return

    // ── Import Statements ──
    if (node.type === 'ImportDeclaration') {
      const importSource = node.source?.value
      if (importSource) {
        const specifiers = (node.specifiers || []).map(s => {
          if (s.type === 'ImportDefaultSpecifier') return { name: 'default', local: s.local?.name }
          if (s.type === 'ImportNamespaceSpecifier') return { name: '*', local: s.local?.name }
          return { name: s.imported?.name || s.local?.name, local: s.local?.name }
        })
        imports.push({ file: relPath, source: importSource, specifiers })
      }
      return
    }

    // ── Export Named / Default Declarations ──
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        this.processNode(node.declaration, relPath, symbols, imports, exports, calls, implementations, source, parentName, true)
      }
      if (node.specifiers) {
        for (const spec of node.specifiers) {
          const exportName = spec.exported?.name || spec.local?.name
          if (exportName) {
            exports.push({ file: relPath, name: exportName, isDefault: false })
          }
        }
      }
      return
    }

    if (node.type === 'ExportDefaultDeclaration') {
      const decl = node.declaration
      let name = 'default'
      if (decl?.id?.name) {
        name = decl.id.name
      } else if (decl?.name) {
        name = decl.name
      }
      exports.push({ file: relPath, name, isDefault: true })
      if (decl && typeof decl === 'object') {
        this.processNode(decl, relPath, symbols, imports, exports, calls, implementations, source, parentName, false)
      }
      return
    }

    // ── Function Declarations ──
    if (node.type === 'FunctionDeclaration') {
      const name = node.id?.name
      if (name) {
        const isComponent = /^[A-Z]/.test(name)
        const kind = isComponent ? 'component' : 'function'
        const sig = this.extractSignature(node, source)
        symbols.push(new SymbolRecord({
          name,
          kind,
          file: relPath,
          startLine: node.loc?.start.line || 1,
          endLine: node.loc?.end.line || 1,
          startColumn: node.loc?.start.column || 0,
          endColumn: node.loc?.end.column || 0,
          exported: isExported,
          parent: parentName,
          signature: sig
        }))
        if (isExported) exports.push({ file: relPath, name, isDefault: false })
        if (node.body) {
          this.extractCallsFromBody(node.body, name, relPath, calls)
        }
      }
      return
    }

    // ── Class Declarations ──
    if (node.type === 'ClassDeclaration') {
      const name = node.id?.name
      if (name) {
        const superClass = node.superClass?.name || (node.superClass?.type === 'MemberExpression' ? `${node.superClass.object?.name}.${node.superClass.property?.name}` : null)
        const implementsList = (node.implements || []).map(i => i.id?.name || i.expression?.name).filter(Boolean)
        implementations.push({
          name,
          extends: superClass,
          implements: implementsList,
          file: relPath
        })

        symbols.push(new SymbolRecord({
          name,
          kind: 'class',
          file: relPath,
          startLine: node.loc?.start.line || 1,
          endLine: node.loc?.end.line || 1,
          startColumn: node.loc?.start.column || 0,
          endColumn: node.loc?.end.column || 0,
          exported: isExported,
          parent: parentName,
          signature: `class ${name}${superClass ? ` extends ${superClass}` : ''}`
        }))
        if (isExported) exports.push({ file: relPath, name, isDefault: false })

        // Extract class methods
        const classBody = node.body?.body || []
        for (const member of classBody) {
          if (member.type === 'ClassMethod' && member.key?.name) {
            const methodName = member.key.name
            symbols.push(new SymbolRecord({
              name: methodName,
              kind: 'method',
              file: relPath,
              startLine: member.loc?.start.line || 1,
              endLine: member.loc?.end.line || 1,
              startColumn: member.loc?.start.column || 0,
              endColumn: member.loc?.end.column || 0,
              exported: false,
              parent: name,
              signature: `${name}.${methodName}()`
            }))
            if (member.body) {
              this.extractCallsFromBody(member.body, `${name}.${methodName}`, relPath, calls)
            }
          }
        }
      }
      return
    }

    // ── Variable / Constant Declarations ──
    if (node.type === 'VariableDeclaration') {
      const isConst = node.kind === 'const'
      for (const declarator of node.declarations || []) {
        const name = declarator.id?.name
        if (name) {
          const initType = declarator.init?.type
          const isFuncInit = initType === 'ArrowFunctionExpression' || initType === 'FunctionExpression'
          const isComponent = isFuncInit && /^[A-Z]/.test(name)
          const kind = isComponent ? 'component' : isFuncInit ? 'function' : isConst ? 'constant' : 'variable'

          symbols.push(new SymbolRecord({
            name,
            kind,
            file: relPath,
            startLine: declarator.loc?.start.line || node.loc?.start.line || 1,
            endLine: declarator.loc?.end.line || node.loc?.end.line || 1,
            startColumn: declarator.loc?.start.column || 0,
            endColumn: declarator.loc?.end.column || 0,
            exported: isExported,
            parent: parentName,
            signature: `${node.kind} ${name}`
          }))
          if (isExported) exports.push({ file: relPath, name, isDefault: false })

          if (isFuncInit && declarator.init?.body) {
            this.extractCallsFromBody(declarator.init.body, name, relPath, calls)
          }
        }
      }
      return
    }

    // ── TypeScript Types, Interfaces, Enums ──
    if (node.type === 'TSInterfaceDeclaration' && node.id?.name) {
      const extendsList = (node.extends || []).map(e => e.id?.name || e.expression?.name).filter(Boolean)
      implementations.push({
        name: node.id.name,
        extends: extendsList,
        implements: [],
        file: relPath
      })

      symbols.push(new SymbolRecord({
        name: node.id.name,
        kind: 'interface',
        file: relPath,
        startLine: node.loc?.start.line || 1,
        endLine: node.loc?.end.line || 1,
        exported: isExported,
        signature: `interface ${node.id.name}`
      }))
      if (isExported) exports.push({ file: relPath, name: node.id.name, isDefault: false })
    }

    if (node.type === 'TSTypeAliasDeclaration' && node.id?.name) {
      symbols.push(new SymbolRecord({
        name: node.id.name,
        kind: 'type',
        file: relPath,
        startLine: node.loc?.start.line || 1,
        endLine: node.loc?.end.line || 1,
        exported: isExported,
        signature: `type ${node.id.name}`
      }))
      if (isExported) exports.push({ file: relPath, name: node.id.name, isDefault: false })
    }

    if (node.type === 'TSEnumDeclaration' && node.id?.name) {
      symbols.push(new SymbolRecord({
        name: node.id.name,
        kind: 'enum',
        file: relPath,
        startLine: node.loc?.start.line || 1,
        endLine: node.loc?.end.line || 1,
        exported: isExported,
        signature: `enum ${node.id.name}`
      }))
      if (isExported) exports.push({ file: relPath, name: node.id.name, isDefault: false })
      return
    }

    // ── Top-level Expression Statements (e.g. test(...), describe(...), function calls) ──
    if (node.type === 'ExpressionStatement' && node.expression) {
      if (node.expression.type === 'CallExpression') {
        const callee = node.expression.callee?.name || node.expression.callee?.property?.name || '<module>'
        this.extractCallsFromBody(node.expression, callee, relPath, calls)
      }
    }
  }

  extractCallsFromBody(bodyNode, callerName, relPath, calls) {
    if (!bodyNode) return
    const walk = (n) => {
      if (!n || typeof n !== 'object') return
      if (n.type === 'CallExpression') {
        let callee = null
        if (n.callee?.type === 'Identifier') {
          callee = n.callee.name
        } else if (n.callee?.type === 'MemberExpression') {
          if (n.callee.property?.name) {
            callee = n.callee.property.name
          }
        }
        if (callee) {
          calls.push({
            caller: callerName,
            callee,
            file: relPath,
            line: n.loc?.start.line || 1
          })
        }
      }
      for (const key of Object.keys(n)) {
        if (key === 'loc' || key === 'comments' || key === 'tokens') continue
        const val = n[key]
        if (Array.isArray(val)) {
          for (const item of val) walk(item)
        } else if (val && typeof val === 'object') {
          walk(val)
        }
      }
    }
    walk(bodyNode)
  }

  extractSignature(node, source) {
    if (node.loc && source) {
      const lines = source.split('\n')
      const firstLine = lines[node.loc.start.line - 1] || ''
      return firstLine.trim().slice(0, 100)
    }
    return `function ${node.id?.name || ''}()`
  }
}

/**
 * Simple JSON parser
 */
class JsonParser {
  parse(source, relPath) {
    try {
      const data = JSON.parse(source)
      const symbols = []
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const key of Object.keys(data).slice(0, 50)) {
          symbols.push(new SymbolRecord({
            name: key,
            kind: 'constant',
            file: relPath,
            startLine: 1,
            endLine: 1,
            signature: `json key: ${key}`
          }))
        }
      }
      return { symbols, imports: [], exports: [] }
    } catch {
      return null
    }
  }
}

/**
 * Language Registry for pluggable AST parsers
 */
export class LanguageRegistry {
  constructor() {
    this.parsers = new Map()
    this.registerDefaultParsers()
  }

  registerParser(extension, parser) {
    this.parsers.set(extension.toLowerCase(), parser)
  }

  getParser(filename) {
    const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : ''
    return this.parsers.get(ext) || null
  }

  registerDefaultParsers() {
    const babelParser = new BabelAstParser()
    const jsonParser = new JsonParser()

    for (const ext of ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']) {
      this.registerParser(ext, babelParser)
    }
    this.registerParser('json', jsonParser)
  }
}

export const globalLanguageRegistry = new LanguageRegistry()
