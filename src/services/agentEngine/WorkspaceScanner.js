export class WorkspaceScanner {
  constructor(workspaceRoot) {
    this.root = workspaceRoot;
    this.state = {
      language: 'unknown',
      framework: 'unknown',
      packageManager: 'unknown',
      buildTool: 'unknown',
      testRunner: 'unknown',
      entrypoint: 'unknown',
      dependencies: {},
      devDependencies: {},
      isGitRepo: false,
      configs: {
        tsconfig: false,
        eslint: false,
        prettier: false,
        vite: false,
        docker: false,
      },
      scripts: {},
      missingFolders: [],
      missingConfigs: [],
      errors: []
    };
  }

  async scan() {
    try {
      await this.detectGit();
      // Detect ecosystem: try each one in priority order. First match wins.
      const detected = await this.detectNodeEcosystem()
        || await this.detectPythonEcosystem()
        || await this.detectGoEcosystem()
        || await this.detectRustEcosystem()
        || await this.detectJavaEcosystem()
        || await this.detectDotnetEcosystem()
        || await this.detectCppEcosystem();
      
      if (!detected) {
        // Fallback: look for dominant file extensions
        await this.detectByFileExtensions();
      }

      await this.detectDocker();
      return this.state;
    } catch (err) {
      console.error('Workspace scan failed:', err);
      this.state.errors.push(`Scan failed: ${err.message}`);
      return this.state;
    }
  }

  async fileExists(filePath) {
    const fullPath = `${this.root}/${filePath}`.replace(/\\\\/g, '/');
    const result = await window.api.readFile(fullPath);
    return result.success;
  }

  async readFile(filePath) {
    const fullPath = `${this.root}/${filePath}`.replace(/\\\\/g, '/');
    const result = await window.api.readFile(fullPath);
    return result.success ? result.content : null;
  }

  async detectGit() {
    const fullPath = `${this.root}/.git`.replace(/\\\\/g, '/');
    const result = await window.api.listFiles(fullPath.substring(0, fullPath.lastIndexOf('/')));
    if (result.success) {
      this.state.isGitRepo = result.children.some(child => child.name === '.git');
    }
  }

  async detectDocker() {
    this.state.configs.docker = await this.fileExists('Dockerfile') || await this.fileExists('docker-compose.yml') || await this.fileExists('docker-compose.yaml');
  }

  // ─── Node.js / JavaScript / TypeScript ───
  async detectNodeEcosystem() {
    const raw = await this.readFile('package.json');
    if (!raw) return false;

    try {
      const pkg = JSON.parse(raw);
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      this.state.dependencies = pkg.dependencies || {};
      this.state.devDependencies = pkg.devDependencies || {};
      this.state.scripts = pkg.scripts || {};

      // Language
      this.state.language = deps['typescript'] ? 'typescript' : 'javascript';

      // Package manager
      if (await this.fileExists('pnpm-lock.yaml')) this.state.packageManager = 'pnpm';
      else if (await this.fileExists('yarn.lock')) this.state.packageManager = 'yarn';
      else if (await this.fileExists('bun.lockb')) this.state.packageManager = 'bun';
      else if (await this.fileExists('package-lock.json')) this.state.packageManager = 'npm';
      else this.state.packageManager = 'npm';

      // Framework detection
      if (deps['next']) this.state.framework = 'next';
      else if (deps['nuxt']) this.state.framework = 'nuxt';
      else if (deps['svelte'] || deps['@sveltejs/kit']) this.state.framework = 'svelte';
      else if (deps['@angular/core']) this.state.framework = 'angular';
      else if (deps['vue']) this.state.framework = 'vue';
      else if (deps['react']) this.state.framework = 'react';
      else if (deps['express']) this.state.framework = 'express';
      else if (deps['fastify']) this.state.framework = 'fastify';
      else if (deps['electron']) this.state.framework = 'electron';
      else if (deps['hono']) this.state.framework = 'hono';

      // Build tool
      if (deps['vite']) this.state.buildTool = 'vite';
      else if (deps['webpack']) this.state.buildTool = 'webpack';
      else if (deps['esbuild']) this.state.buildTool = 'esbuild';
      else if (deps['turbo'] || deps['turbopack']) this.state.buildTool = 'turbopack';
      else if (deps['rollup']) this.state.buildTool = 'rollup';

      // Test runner
      if (deps['vitest']) this.state.testRunner = 'vitest';
      else if (deps['jest']) this.state.testRunner = 'jest';
      else if (deps['@playwright/test']) this.state.testRunner = 'playwright';
      else if (deps['mocha']) this.state.testRunner = 'mocha';
      else if (deps['cypress']) this.state.testRunner = 'cypress';

      // Configs
      this.state.configs.tsconfig = await this.fileExists('tsconfig.json');
      this.state.configs.eslint = await this.fileExists('.eslintrc.js') || await this.fileExists('.eslintrc.json') || await this.fileExists('eslint.config.js');
      this.state.configs.prettier = await this.fileExists('.prettierrc') || await this.fileExists('prettier.config.js');
      this.state.configs.vite = await this.fileExists('vite.config.js') || await this.fileExists('vite.config.ts');

      return true;
    } catch {
      this.state.errors.push('Failed to parse package.json');
      return true; // Still a Node project, just broken config
    }
  }

  // ─── Python ───
  async detectPythonEcosystem() {
    const hasRequirements = await this.fileExists('requirements.txt');
    const hasPyproject = await this.fileExists('pyproject.toml');
    const hasSetupPy = await this.fileExists('setup.py');
    const hasPipfile = await this.fileExists('Pipfile');

    if (!hasRequirements && !hasPyproject && !hasSetupPy && !hasPipfile) return false;

    this.state.language = 'python';

    if (hasPipfile) this.state.packageManager = 'pipenv';
    else if (hasPyproject) this.state.packageManager = 'pip (pyproject)';
    else this.state.packageManager = 'pip';

    // Try to detect framework from requirements or pyproject
    const reqContent = await this.readFile('requirements.txt') || '';
    const pyContent = await this.readFile('pyproject.toml') || '';
    const combined = reqContent + pyContent;

    if (/django/i.test(combined)) this.state.framework = 'django';
    else if (/fastapi/i.test(combined)) this.state.framework = 'fastapi';
    else if (/flask/i.test(combined)) this.state.framework = 'flask';
    else if (/starlette/i.test(combined)) this.state.framework = 'starlette';
    else if (/streamlit/i.test(combined)) this.state.framework = 'streamlit';

    // Test runner
    if (/pytest/i.test(combined)) this.state.testRunner = 'pytest';
    else if (/unittest/i.test(combined)) this.state.testRunner = 'unittest';

    // Build tool
    if (/setuptools/i.test(combined)) this.state.buildTool = 'setuptools';
    else if (/poetry/i.test(combined) || /\[tool\.poetry\]/i.test(pyContent)) this.state.buildTool = 'poetry';
    else if (/hatch/i.test(combined)) this.state.buildTool = 'hatch';

    return true;
  }

  // ─── Go ───
  async detectGoEcosystem() {
    const goMod = await this.readFile('go.mod');
    if (!goMod) return false;

    this.state.language = 'go';
    this.state.packageManager = 'go modules';
    this.state.testRunner = 'go test';
    this.state.buildTool = 'go build';

    if (/gin-gonic/i.test(goMod)) this.state.framework = 'gin';
    else if (/echo/i.test(goMod)) this.state.framework = 'echo';
    else if (/fiber/i.test(goMod)) this.state.framework = 'fiber';

    return true;
  }

  // ─── Rust ───
  async detectRustEcosystem() {
    const cargoToml = await this.readFile('Cargo.toml');
    if (!cargoToml) return false;

    this.state.language = 'rust';
    this.state.packageManager = 'cargo';
    this.state.testRunner = 'cargo test';
    this.state.buildTool = 'cargo';

    if (/actix/i.test(cargoToml)) this.state.framework = 'actix';
    else if (/axum/i.test(cargoToml)) this.state.framework = 'axum';
    else if (/rocket/i.test(cargoToml)) this.state.framework = 'rocket';
    else if (/tauri/i.test(cargoToml)) this.state.framework = 'tauri';

    return true;
  }

  // ─── Java ───
  async detectJavaEcosystem() {
    const hasPom = await this.fileExists('pom.xml');
    const hasGradle = await this.fileExists('build.gradle') || await this.fileExists('build.gradle.kts');

    if (!hasPom && !hasGradle) return false;

    this.state.language = 'java';

    if (hasPom) {
      this.state.packageManager = 'maven';
      this.state.buildTool = 'maven';
      this.state.testRunner = 'maven (surefire)';
      const pomContent = await this.readFile('pom.xml') || '';
      if (/spring-boot/i.test(pomContent)) this.state.framework = 'spring-boot';
      else if (/quarkus/i.test(pomContent)) this.state.framework = 'quarkus';
    } else {
      this.state.packageManager = 'gradle';
      this.state.buildTool = 'gradle';
      this.state.testRunner = 'gradle test';
      const gradleContent = await this.readFile('build.gradle') || await this.readFile('build.gradle.kts') || '';
      if (/spring/i.test(gradleContent)) this.state.framework = 'spring-boot';
      else if (/micronaut/i.test(gradleContent)) this.state.framework = 'micronaut';
    }

    return true;
  }

  // ─── .NET / C# ───
  async detectDotnetEcosystem() {
    // Look for .csproj or .sln
    const rootListing = await window.api.listFiles(this.root.replace(/\\\\/g, '/'));
    if (!rootListing.success) return false;

    const hasCsproj = rootListing.children.some(c => c.name.endsWith('.csproj'));
    const hasSln = rootListing.children.some(c => c.name.endsWith('.sln'));

    if (!hasCsproj && !hasSln) return false;

    this.state.language = 'csharp';
    this.state.packageManager = 'nuget';
    this.state.buildTool = 'dotnet';
    this.state.testRunner = 'dotnet test';
    this.state.framework = '.net';

    return true;
  }

  // ─── C/C++ ───
  async detectCppEcosystem() {
    const hasCMake = await this.fileExists('CMakeLists.txt');
    const hasMakefile = await this.fileExists('Makefile');
    const hasMeson = await this.fileExists('meson.build');

    if (!hasCMake && !hasMakefile && !hasMeson) return false;

    this.state.language = 'c/c++';
    if (hasCMake) { this.state.buildTool = 'cmake'; this.state.packageManager = 'cmake'; }
    else if (hasMeson) { this.state.buildTool = 'meson'; this.state.packageManager = 'meson'; }
    else { this.state.buildTool = 'make'; this.state.packageManager = 'make'; }

    return true;
  }

  // ─── Fallback: detect by dominant file extension ───
  async detectByFileExtensions() {
    const rootListing = await window.api.listFiles(this.root.replace(/\\\\/g, '/'));
    if (!rootListing.success) return;

    const extensions = {};
    for (const child of rootListing.children) {
      if (child.isDirectory) continue;
      const ext = child.name.split('.').pop()?.toLowerCase();
      if (ext) extensions[ext] = (extensions[ext] || 0) + 1;
    }

    const langMap = {
      'py': 'python', 'js': 'javascript', 'ts': 'typescript',
      'go': 'go', 'rs': 'rust', 'java': 'java', 'cs': 'csharp',
      'cpp': 'c/c++', 'c': 'c/c++', 'rb': 'ruby', 'php': 'php',
      'kt': 'kotlin', 'swift': 'swift', 'sh': 'shell'
    };

    let maxCount = 0;
    for (const [ext, count] of Object.entries(extensions)) {
      if (langMap[ext] && count > maxCount) {
        this.state.language = langMap[ext];
        maxCount = count;
      }
    }
  }
}
