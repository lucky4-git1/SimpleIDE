export function detectProjectType(fileTree = [], projectIndex = []) {
  const fileNames = new Set(fileTree.map(f => f.name.toLowerCase()))
  const allIndexedNames = new Set((projectIndex || []).map(f => f.name.toLowerCase()))

  let framework = 'Generic Project'
  let language = 'Unknown'
  let packageManager = 'Unknown'
  let icon = 'folder'
  let scripts = []

  // Find package.json if present
  const pkgFile = (projectIndex || []).find(f => f.name.toLowerCase() === 'package.json')
  let pkgData = null
  if (pkgFile) {
    try {
      pkgData = JSON.parse(pkgFile.content)
      if (pkgData.scripts) {
        scripts = Object.entries(pkgData.scripts).map(([name, cmd]) => ({ name, cmd }))
      }
    } catch { /* ignore parse error */ }
  }

  // Check locks for package manager
  if (fileNames.has('pnpm-lock.yaml') || allIndexedNames.has('pnpm-lock.yaml')) packageManager = 'pnpm'
  else if (fileNames.has('yarn.lock') || allIndexedNames.has('yarn.lock')) packageManager = 'yarn'
  else if (fileNames.has('bun.lockb') || fileNames.has('bun.lock')) packageManager = 'bun'
  else if (fileNames.has('package-lock.json') || allIndexedNames.has('package-lock.json')) packageManager = 'npm'

  const deps = { ...pkgData?.dependencies, ...pkgData?.devDependencies }

  // Detect JS/TS frameworks
  if (deps?.['next']) {
    framework = 'Next.js'
    language = deps['typescript'] || fileNames.has('tsconfig.json') ? 'TypeScript' : 'JavaScript'
    icon = 'nextjs'
  } else if (deps?.['vite'] || fileNames.has('vite.config.js') || fileNames.has('vite.config.ts')) {
    if (deps?.['react']) framework = 'React + Vite'
    else if (deps?.['vue']) framework = 'Vue + Vite'
    else if (deps?.['svelte']) framework = 'Svelte + Vite'
    else framework = 'Vite Project'
    language = deps?.['typescript'] || fileNames.has('tsconfig.json') ? 'TypeScript' : 'JavaScript'
    icon = 'vite'
  } else if (deps?.['react']) {
    framework = 'React Project'
    language = deps['typescript'] || fileNames.has('tsconfig.json') ? 'TypeScript' : 'JavaScript'
    icon = 'react'
  } else if (deps?.['express'] || deps?.['fastify'] || deps?.['koa']) {
    framework = 'Node.js Backend'
    language = deps['typescript'] || fileNames.has('tsconfig.json') ? 'TypeScript' : 'JavaScript'
    icon = 'node'
  } else if (pkgData) {
    framework = 'Node.js Project'
    language = fileNames.has('tsconfig.json') ? 'TypeScript' : 'JavaScript'
    icon = 'node'
  }

  // Detect Python
  if (fileNames.has('requirements.txt') || fileNames.has('pyproject.toml') || fileNames.has('setup.py')) {
    if (framework === 'Generic Project') {
      framework = 'Python Project'
      language = 'Python'
      packageManager = fileNames.has('pyproject.toml') ? 'poetry/pip' : 'pip'
      icon = 'python'
    }
  }

  // Detect Java
  if (fileNames.has('pom.xml')) {
    framework = 'Java (Maven)'
    language = 'Java'
    packageManager = 'Maven'
    icon = 'java'
  } else if (fileNames.has('build.gradle') || fileNames.has('build.gradle.kts')) {
    framework = 'Java (Gradle)'
    language = 'Java'
    packageManager = 'Gradle'
    icon = 'java'
  }

  // Detect C/C++
  if (fileNames.has('cmakelists.txt') || fileNames.has('makefile')) {
    framework = fileNames.has('cmakelists.txt') ? 'CMake Project' : 'C/C++ Project'
    language = 'C / C++'
    icon = 'cpp'
  }

  // Detect Rust
  if (fileNames.has('cargo.toml')) {
    framework = 'Rust Project'
    language = 'Rust'
    packageManager = 'Cargo'
    icon = 'rust'
  }

  return {
    framework,
    language,
    packageManager,
    icon,
    scripts,
    hasPackageJson: Boolean(pkgData)
  }
}
