import { resolve, isAbsolute, relative } from 'path'

/**
 * Validates that a target file path is contained within the active workspace root directory.
 * Returns true if valid, false if path traversal attempt or outside workspace.
 */
export function isPathInWorkspace(targetPath, workspaceRoot) {
  if (!targetPath || !workspaceRoot) return true
  try {
    let resolvedTarget = resolve(targetPath)
    let resolvedRoot = resolve(workspaceRoot)

    // Normalize drive letter casing on Windows (e.g., e:\ vs E:\)
    if (process.platform === 'win32') {
      if (resolvedTarget.length >= 2 && resolvedTarget[1] === ':') {
        resolvedTarget = resolvedTarget[0].toUpperCase() + resolvedTarget.slice(1)
      }
      if (resolvedRoot.length >= 2 && resolvedRoot[1] === ':') {
        resolvedRoot = resolvedRoot[0].toUpperCase() + resolvedRoot.slice(1)
      }
    }

    const rel = relative(resolvedRoot, resolvedTarget)
    return !rel.startsWith('..') && !isAbsolute(rel)
  } catch {
    return false
  }
}
