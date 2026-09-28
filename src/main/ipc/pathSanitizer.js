import fs from 'fs'
import { resolve, isAbsolute, relative, dirname, basename } from 'path'

/**
 * Safely resolves the canonical real path of a target, even if the target does not exist yet
 * (by resolving the closest existing ancestor directory to resolve any symlinks along the path).
 */
function resolveCanonical(p) {
  try {
    if (fs.existsSync(p)) {
      return fs.realpathSync(p)
    }
    // For non-existent files (e.g. creating or writing a new file), resolve parent realpath
    let current = resolve(p)
    const segments = []
    while (current && !fs.existsSync(current)) {
      const parent = dirname(current)
      if (parent === current) break
      segments.unshift(basename(current))
      current = parent
    }
    if (current && fs.existsSync(current)) {
      const realParent = fs.realpathSync(current)
      return resolve(realParent, ...segments)
    }
  } catch {
    // If filesystem inspection fails (e.g. mock paths in unit tests), use resolve
  }
  return resolve(p)
}

function normalizeDriveLetter(p) {
  if (process.platform === 'win32' && p.length >= 2 && p[1] === ':') {
    return p[0].toUpperCase() + p.slice(1)
  }
  return p
}

/**
 * Validates that a target file path is contained within the active workspace root directory.
 * Returns true if valid, false if path traversal attempt, symlink escape, or outside workspace.
 * Fail-closed: returns false if either argument is missing or invalid.
 */
export function isPathInWorkspace(targetPath, workspaceRoot) {
  if (!targetPath || !workspaceRoot || typeof targetPath !== 'string' || typeof workspaceRoot !== 'string') {
    return false
  }

  try {
    let resolvedTarget = normalizeDriveLetter(resolveCanonical(targetPath))
    let resolvedRoot = normalizeDriveLetter(resolveCanonical(workspaceRoot))

    const rel = relative(resolvedRoot, resolvedTarget)
    return !rel.startsWith('..') && !isAbsolute(rel)
  } catch {
    return false
  }
}

