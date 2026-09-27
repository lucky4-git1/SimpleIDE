import { CodeIntelligenceService } from './CodeIntelligenceService.js'

export class ProjectIndexer {
  constructor(workspaceRoot, { api } = {}) {
    this.root = workspaceRoot;
    this.api = api || globalThis.window?.api;
    this.codeIntelligence = new CodeIntelligenceService(workspaceRoot, { api: this.api });
    this.index = {
      files: [],
      folders: [],
      exports: [],
      imports: [],
      components: [],
      dependencies: {},
    };
  }

  getApi() {
    return this.api || globalThis.window?.api;
  }

  async buildIndex() {
    try {
      await this.codeIntelligence.indexWorkspace();
      await this.scanDirectory(this.root);
      await this.indexDependencies();
      return this.index;
    } catch (err) {
      console.error('Failed to build project index:', err);
      return this.index;
    }
  }

  async scanDirectory(dir) {
    const api = this.getApi();
    if (!api) return;
    const result = await api.listFiles(dir);
    if (!result || !result.success) return;
    const entries = result.children || [];
    
    for (const entry of entries) {
      const fullPath = `${dir}/${entry.name}`.replace(/\\/g, '/');
      const rootNormalized = this.root.replace(/\\/g, '/');
      const relPath = fullPath.startsWith(rootNormalized) ? fullPath.slice(rootNormalized.length).replace(/^\//, '') : entry.name;

      if (entry.isDirectory && ['node_modules', '.git', 'dist', 'build', '.next'].includes(entry.name)) {
        continue;
      }

      if (entry.isDirectory) {
        if (!this.index.folders.includes(relPath)) this.index.folders.push(relPath);
        await this.scanDirectory(fullPath);
      } else {
        if (!this.index.files.includes(relPath)) this.index.files.push(relPath);
        if (this.isSourceFile(entry.name)) {
          await this.parseFileContent(fullPath, relPath);
        }
      }
    }
  }

  isSourceFile(filename) {
    return /\.(js|jsx|ts|tsx|vue|html|css|scss)$/.test(filename);
  }

  async parseFileContent(fullPath, relPath) {
    try {
      const api = this.getApi();
      if (!api) return;
      const result = await api.readFile(fullPath);
      if (!result || !result.success) return;
      const content = result.content;
      
      // Basic regex parsing for imports
      const importRegex = /import\s+(?:(?:\*\s+as\s+\w+)|(?:{[^}]+})|(?:\w+))\s+from\s+['"]([^'"]+)['"]/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        this.index.imports.push({ file: relPath, source: match[1] });
      }

      // Basic regex parsing for exports
      const exportRegex = /export\s+(?:const|function|class|default)\s+(\w+)/g;
      while ((match = exportRegex.exec(content)) !== null) {
        this.index.exports.push({ file: relPath, name: match[1] });
        
        // Naive React Component detection (capitalized export)
        if (/^[A-Z]/.test(match[1]) && /\.(jsx|tsx)$/.test(relPath)) {
          this.index.components.push({ file: relPath, name: match[1] });
        }
      }
    } catch {
      // Ignore read errors for individual files
    }
  }

  async indexDependencies() {
    try {
      const api = this.getApi();
      if (!api) return;
      const pkgPath = `${this.root}/package.json`.replace(/\\/g, '/');
      const result = await api.readFile(pkgPath);
      if (!result || !result.success) return;
      const pkg = JSON.parse(result.content);
      this.index.dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    } catch {
      // Ignore if package.json is missing
    }
  }

  lookupSymbol(symbolName) {
    const astSymbols = this.codeIntelligence.findSymbol(symbolName);
    if (astSymbols.length) {
      return astSymbols.map(s => ({ file: s.file, name: s.name, kind: s.kind, startLine: s.startLine }));
    }
    return this.index.exports.filter(e => e.name === symbolName);
  }

  getDependentFiles(sourcePath) {
    const astDependents = this.codeIntelligence.getDependents(sourcePath);
    if (astDependents.length) {
      return astDependents;
    }
    return this.index.imports.filter(i => i.source.includes(sourcePath)).map(i => i.file);
  }
}
