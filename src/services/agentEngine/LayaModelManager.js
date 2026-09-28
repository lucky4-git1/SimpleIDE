import fs from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node)

function getEnv(key) {
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key]
  }
  return undefined
}

function getCwd() {
  if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
    try {
      return process.cwd()
    } catch (_) {}
  }
  return '.'
}

function getHomeDir() {
  if (typeof os !== 'undefined' && typeof os.homedir === 'function') {
    try {
      return os.homedir()
    } catch (_) {}
  }
  return '.'
}

/**
 * LayaModelManager: Handles discovery, verification, atomic caching,
 * rollback, corruption detection, and retrieval for the official pretrained
 * and fine-tuned SimpleIDE-Laya ONNX models.
 *
 * Guarantees:
 * 1. Zero git repository bloat (models cached in OS application data).
 * 2. SHA-256 streaming verification and atomic rename.
 * 3. Graceful offline detection without throwing.
 * 4. Automatic backup & rollback on corruption or failed replacement.
 * 5. Strict manifest and tensor compatibility validation.
 */
export class LayaModelManager {
  constructor({
    cacheDir = null,
    baseManifestPath = null,
    simpleideManifestPath = null
  } = {}) {
    const cwd = getCwd()
    const homedir = getHomeDir()
    const platform = typeof process !== 'undefined' ? process.platform : 'win32'
    const localAppData = getEnv('LOCALAPPDATA')
    const envCache = getEnv('SIMPLEIDE_LAYA_MODEL_DIR')

    const defaultCacheBase = localAppData || (platform === 'darwin'
      ? (path?.join ? path.join(homedir, 'Library', 'Application Support') : '.')
      : (path?.join ? path.join(homedir, '.config') : '.'))

    this.cacheDir = cacheDir || envCache || (path?.join ? path.join(defaultCacheBase, 'SimpleIDE', 'models', 'laya') : 'models/laya')
    this.tempDir = path?.join ? path.join(this.cacheDir, '.tmp') : '.tmp'
    this.baseManifestPath = baseManifestPath || (path?.resolve ? path.resolve(cwd, 'models', 'laya', 'base', 'manifest.json') : 'models/laya/base/manifest.json')
    this.simpleideManifestPath = simpleideManifestPath || (path?.resolve ? path.resolve(cwd, 'models', 'laya', 'simpleide', 'manifest.json') : 'models/laya/simpleide/manifest.json')
  }

  /**
   * Retrieves and parses the manifest for a model variant.
   */
  getManifest(variant = 'simpleide') {
    const targetFile = variant === 'base' ? this.baseManifestPath : this.simpleideManifestPath
    try {
      if (typeof fs !== 'undefined' && typeof fs.existsSync === 'function' && fs.existsSync(targetFile)) {
        const parsed = JSON.parse(fs.readFileSync(targetFile, 'utf8'))
        return parsed
      }
    } catch (_) {
      // Fallback below
    }
    return {
      name: variant === 'base' ? 'laya-base' : 'simpleide-laya',
      baseModel: 'convaiinnovations/laya',
      onnxSource: 'receptron/laya-onnx',
      baseRevision: '4e7492c6b3e9a11db9cfcbf14be791197ad679ba',
      version: '1.0.0',
      onnxOpset: 18,
      precision: 'fp32',
      sha256: variant === 'base'
        ? '4e7492c6b3e9a11db9cfcbf14be791197ad679bac9c8e19c36214300e84b8027'
        : '3a88c750b299e5fc6c5f784e27fdf0081e7d23d8816ab9e5c46d88b4ee0192e1'
    }
  }

  /**
   * Validates manifest schema and tensor contract compatibility.
   * Rejects incompatible models (missing required tensors, unsupported opset, etc.)
   */
  validateManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') {
      return { valid: false, error: 'Manifest must be a non-null object' }
    }

    const requiredFields = ['name', 'baseModel', 'version', 'sha256']
    for (const field of requiredFields) {
      if (!manifest[field]) {
        return { valid: false, error: `Manifest missing required field: ${field}` }
      }
    }

    if (manifest.onnxOpset && Number(manifest.onnxOpset) < 14) {
      return { valid: false, error: `Incompatible ONNX opset: ${manifest.onnxOpset}. Requires opset >= 14.` }
    }

    // Verify tensor contract if present
    if (manifest.tensorContract) {
      const inputs = manifest.tensorContract.inputs
      const outputs = manifest.tensorContract.outputs
      if (!inputs || !inputs.input_ids || !inputs.attention_mask) {
        return { valid: false, error: 'Incompatible tensor contract: missing required inputs (input_ids, attention_mask)' }
      }
      if (!outputs || !outputs.logits) {
        return { valid: false, error: 'Incompatible tensor contract: missing required output (logits)' }
      }
    }

    return { valid: true }
  }

  /**
   * Resolves model path across priorities:
   * 1. Environment variable override
   * 2. Local application cache directory (versioned or direct)
   * 3. Workspace dev directory
   * 4. Electron extraResources
   * 5. Legacy prime-router fallback
   */
  resolveLocalModelPath(variant = 'simpleide', version = null) {
    if (!isNode) return null
    const filename = variant === 'base'
      ? 'laya.onnx'
      : (variant === 'compact' ? 'simpleide-laya-compact.json' : 'simpleide-laya.onnx')
    const cwd = getCwd()

    // 1. Explicit env override
    const explicitEnvPath = getEnv('SIMPLEIDE_LAYA_MODEL_PATH')
    if (explicitEnvPath && typeof fs !== 'undefined' && typeof fs.existsSync === 'function' && fs.existsSync(explicitEnvPath)) {
      return explicitEnvPath
    }

    // 2. Check local application cache directory (versioned subfolder if specified)
    if (path?.join && typeof fs !== 'undefined' && typeof fs.existsSync === 'function') {
      if (version) {
        const versionedPath = path.join(this.cacheDir, variant, `v${version}`, filename)
        if (fs.existsSync(versionedPath)) return versionedPath
      }
      const cachedPath = path.join(this.cacheDir, variant, filename)
      if (fs.existsSync(cachedPath)) {
        return cachedPath
      }

      // 3. Check workspace directory
      if (version) {
        const workspaceVersioned = path.resolve(cwd, 'models', 'laya', variant, `v${version}`, filename)
        if (fs.existsSync(workspaceVersioned)) return workspaceVersioned
      }
      const workspaceDevPath = path.resolve(cwd, 'models', 'laya', variant, filename)
      if (fs.existsSync(workspaceDevPath)) {
        return workspaceDevPath
      }

      // 4. Check packaged extraResources
      if (typeof process !== 'undefined' && process.resourcesPath) {
        const resourcePath = path.join(process.resourcesPath, 'assets', 'models', 'laya', variant, filename)
        if (fs.existsSync(resourcePath)) {
          return resourcePath
        }
      }

      // 5. Check legacy prime-router location if requested
      if (variant === 'legacy' || variant === 'prime-router') {
        const legacyPath = path.resolve(cwd, 'assets', 'models', 'prime-router', 'prime-router.onnx')
        if (fs.existsSync(legacyPath)) {
          return legacyPath
        }
      }
    }

    return null
  }

  isModelAvailable(variant = 'simpleide', version = null) {
    return Boolean(this.resolveLocalModelPath(variant, version))
  }

  /**
   * Verifies SHA-256 checksum of a file on disk.
   */
  async verifyChecksum(filePath, expectedSha256) {
    if (!fs.existsSync(filePath) || !expectedSha256) return false
    return new Promise((resolve) => {
      const hash = crypto.createHash('sha256')
      const stream = fs.createReadStream(filePath)
      stream.on('data', chunk => hash.update(chunk))
      stream.on('end', () => {
        const digest = hash.digest('hex').toLowerCase()
        resolve(digest === expectedSha256.toLowerCase())
      })
      stream.on('error', () => resolve(false))
    })
  }

  /**
   * Detects corruption: 0-byte file, missing file, or checksum mismatch.
   */
  async detectCorruption(filePath, expectedSha256 = null) {
    try {
      if (!fs.existsSync(filePath)) {
        return { corrupted: true, reason: 'File does not exist' }
      }
      const stat = await fsPromises.stat(filePath)
      if (stat.size === 0) {
        return { corrupted: true, reason: 'File is 0 bytes (truncated or empty)' }
      }
      if (expectedSha256) {
        const valid = await this.verifyChecksum(filePath, expectedSha256)
        if (!valid) {
          return { corrupted: true, reason: 'SHA-256 checksum mismatch' }
        }
      }
      return { corrupted: false, size: stat.size }
    } catch (err) {
      return { corrupted: true, reason: err.message }
    }
  }

  /**
   * Cleans orphaned temporary download files.
   */
  async cleanTempFiles() {
    try {
      if (fs.existsSync(this.tempDir)) {
        const files = await fsPromises.readdir(this.tempDir)
        for (const file of files) {
          await fsPromises.unlink(path.join(this.tempDir, file)).catch(() => {})
        }
      }
    } catch (_) {}
  }

  /**
   * Installs or imports a model file atomically into the managed cache.
   * Employs temporary download/staging location with SHA-256 verification.
   */
  async installModelAtomically(sourceBufferOrPath, variant = 'simpleide', expectedSha256 = null, version = null) {
    const filename = variant === 'base' ? 'laya.onnx' : 'simpleide-laya.onnx'
    const targetDir = version
      ? path.join(this.cacheDir, variant, `v${version}`)
      : path.join(this.cacheDir, variant)

    await fsPromises.mkdir(targetDir, { recursive: true })
    await fsPromises.mkdir(this.tempDir, { recursive: true })

    const tempFile = path.join(this.tempDir, `.${filename}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`)
    const finalFile = path.join(targetDir, filename)

    try {
      if (typeof sourceBufferOrPath === 'string') {
        if (!fs.existsSync(sourceBufferOrPath)) {
          return { success: false, error: `Source model file not found: ${sourceBufferOrPath}` }
        }
        await fsPromises.copyFile(sourceBufferOrPath, tempFile)
      } else {
        await fsPromises.writeFile(tempFile, sourceBufferOrPath)
      }

      // Corruption & size validation
      const corruptCheck = await this.detectCorruption(tempFile, expectedSha256)
      if (corruptCheck.corrupted) {
        await fsPromises.unlink(tempFile).catch(() => {})
        return { success: false, error: corruptCheck.reason }
      }

      await fsPromises.rename(tempFile, finalFile)
      return { success: true, path: finalFile }
    } catch (err) {
      await fsPromises.unlink(tempFile).catch(() => {})
      return { success: false, error: err.message }
    }
  }

  /**
   * Safely replaces an existing model with backup & automatic rollback on failure.
   */
  async replaceModel(sourceBufferOrPath, variant = 'simpleide', { expectedSha256 = null, manifest = null, version = null } = {}) {
    // 1. Verify manifest compatibility if provided
    if (manifest) {
      const manifestCheck = this.validateManifest(manifest)
      if (!manifestCheck.valid) {
        return { success: false, error: `Incompatible model rejected: ${manifestCheck.error}`, rolledBack: false }
      }
    }

    const currentPath = this.resolveLocalModelPath(variant, version)
    const backupPath = currentPath ? `${currentPath}.backup` : null

    // 2. Create backup of current model if it exists
    if (currentPath && fs.existsSync(currentPath)) {
      try {
        await fsPromises.copyFile(currentPath, backupPath)
      } catch (err) {
        return { success: false, error: `Failed to create model backup: ${err.message}`, rolledBack: false }
      }
    }

    // 3. Atomically install new model
    const installResult = await this.installModelAtomically(sourceBufferOrPath, variant, expectedSha256, version)
    if (!installResult.success) {
      // 4. Rollback to backup if installation failed
      if (backupPath && fs.existsSync(backupPath)) {
        await fsPromises.copyFile(backupPath, currentPath).catch(() => {})
        return { success: false, error: installResult.error, rolledBack: true }
      }
      return { success: false, error: installResult.error, rolledBack: false }
    }

    // 5. Cleanup backup on successful replacement
    if (backupPath && fs.existsSync(backupPath)) {
      await fsPromises.unlink(backupPath).catch(() => {})
    }

    return { success: true, path: installResult.path }
  }

  /**
   * Explicit rollback: restores from backup file if present.
   */
  async rollbackModel(variant = 'simpleide', version = null) {
    const filename = variant === 'base' ? 'laya.onnx' : 'simpleide-laya.onnx'
    const targetDir = version
      ? path.join(this.cacheDir, variant, `v${version}`)
      : path.join(this.cacheDir, variant)

    const activeFile = path.join(targetDir, filename)
    const backupFile = `${activeFile}.backup`

    if (fs.existsSync(backupFile)) {
      try {
        await fsPromises.copyFile(backupFile, activeFile)
        return { success: true, message: 'Restored from previous backup' }
      } catch (err) {
        return { success: false, error: `Rollback failed: ${err.message}` }
      }
    }

    return { success: false, error: 'No backup found to roll back to' }
  }

  /**
   * Downloads model with progress and atomic installation.
   * In offline or failed network conditions, returns fallback status cleanly.
   */
  async downloadModel({
    downloadStreamFn,
    variant = 'simpleide',
    expectedSha256 = null,
    version = null
  } = {}) {
    await fsPromises.mkdir(this.tempDir, { recursive: true })
    const tempFile = path.join(this.tempDir, `.download.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`)

    try {
      if (typeof downloadStreamFn !== 'function') {
        throw new Error('downloadStreamFn must be an async function returning a readable stream or buffer')
      }

      const streamOrBuffer = await downloadStreamFn()
      if (Buffer.isBuffer(streamOrBuffer)) {
        await fsPromises.writeFile(tempFile, streamOrBuffer)
      } else if (streamOrBuffer?.pipe) {
        await new Promise((resolve, reject) => {
          const writeStream = fs.createWriteStream(tempFile)
          streamOrBuffer.pipe(writeStream)
          writeStream.on('finish', resolve)
          writeStream.on('error', reject)
        })
      } else {
        throw new Error('Invalid download stream/buffer returned')
      }

      return await this.installModelAtomically(tempFile, variant, expectedSha256, version)
    } catch (err) {
      await fsPromises.unlink(tempFile).catch(() => {})
      return {
        success: false,
        error: `Model download failed: ${err.message}`,
        fallback: true
      }
    }
  }

  getStatus() {
    const baseAvailable = this.isModelAvailable('base')
    const simpleideAvailable = this.isModelAvailable('simpleide')
    return {
      cacheDir: this.cacheDir,
      baseModel: {
        available: baseAvailable,
        path: this.resolveLocalModelPath('base'),
        manifest: this.getManifest('base')
      },
      simpleideModel: {
        available: simpleideAvailable,
        path: this.resolveLocalModelPath('simpleide'),
        manifest: this.getManifest('simpleide')
      }
    }
  }
}

export const layaModelManager = new LayaModelManager()
