import { ipcMain, dialog } from 'electron'
import fs from 'fs/promises'
import { watch as watchFs } from 'fs'
import { join, dirname } from 'path'
import { isPathInWorkspace } from './pathSanitizer.js'

let workspaceWatcher = null
let watchedWorkspacePath = null

export function getWatchedWorkspacePath() {
  return watchedWorkspacePath
}

export function registerFsIPC(getMainWindow, broadcastReload) {
  ipcMain.handle('open-folder', async () => {
    const mainWindow = getMainWindow()
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    })
    if (canceled) return null
    return filePaths[0]
  })

  ipcMain.handle('watch-workspace', async (_, folderPath) => {
    try {
      if (watchedWorkspacePath === folderPath && workspaceWatcher) return { success: true }
      workspaceWatcher?.close()
      watchedWorkspacePath = folderPath
      workspaceWatcher = watchFs(folderPath, { recursive: true }, (eventType, fileName) => {
        const normalized = String(fileName || '').replace(/\\/g, '/')
        if (/(^|\/)(node_modules|\.git|dist|dist-electron|coverage)(\/|$)/.test(normalized)) return
        getMainWindow()?.webContents.send('workspace-changed', { eventType, fileName: normalized })
      })
      workspaceWatcher.on('error', error => console.warn('[Workspace watcher]', error.message))
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('unwatch-workspace', async () => {
    workspaceWatcher?.close()
    workspaceWatcher = null
    watchedWorkspacePath = null
    return { success: true }
  })

  ipcMain.handle('read-file', async (_, filePath) => {
    try {
      if (watchedWorkspacePath && !isPathInWorkspace(filePath, watchedWorkspacePath)) {
        return { success: false, error: 'Access denied: Path is outside the open workspace.' }
      }
      const content = await fs.readFile(filePath, 'utf-8')
      return { success: true, content }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('write-file', async (_, filePath, content) => {
    try {
      if (watchedWorkspacePath && !isPathInWorkspace(filePath, watchedWorkspacePath)) {
        return { success: false, error: 'Access denied: Path is outside the open workspace.' }
      }
      let finalContent = content
      try {
        const prettier = await import('prettier')
        const ext = filePath.split('.').pop().toLowerCase()
        const parserMap = {
          'js': 'babel', 'jsx': 'babel',
          'ts': 'typescript', 'tsx': 'typescript',
          'json': 'json', 'css': 'css', 'html': 'html',
          'md': 'markdown'
        }
        if (parserMap[ext]) {
          finalContent = await prettier.format(content, { filepath: filePath })
        }
      } catch (err) {
        console.warn('[Prettier]', err.message)
      }

      await fs.mkdir(dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, finalContent, 'utf-8')
      broadcastReload()
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('format-code', async (_, filePath, content) => {
    try {
      if (watchedWorkspacePath && !isPathInWorkspace(filePath, watchedWorkspacePath)) {
        return { success: false, error: 'Access denied: Path is outside the open workspace.' }
      }
      const prettier = await import('prettier')
      const ext = filePath.split('.').pop().toLowerCase()
      const parserMap = {
        'js': 'babel', 'jsx': 'babel',
        'ts': 'typescript', 'tsx': 'typescript',
        'json': 'json', 'css': 'css', 'html': 'html',
        'md': 'markdown'
      }
      if (parserMap[ext]) {
        return { success: true, formatted: await prettier.format(content, { filepath: filePath }) }
      }
      return { success: true, formatted: content }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('list-files', async (_, dirPath) => {
    try {
      if (watchedWorkspacePath && !isPathInWorkspace(dirPath, watchedWorkspacePath)) {
        return { success: false, error: 'Access denied: Directory outside workspace.' }
      }
      const dirents = await fs.readdir(dirPath, { withFileTypes: true })
      const children = dirents
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        })
        .map(dirent => ({
          name: dirent.name,
          path: join(dirPath, dirent.name),
          isDirectory: dirent.isDirectory(),
        }))
      return { success: true, children }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('search-workspace', async (_, { root, query, path = '.', filenamesOnly = false }) => {
    const ignored = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'target', 'vendor', 'dist-electron'])
    const results = []
    const needle = String(query || '').toLowerCase()
    if (!needle) return { success: false, error: 'Search query is required.' }
    const rootPath = join(root, path)
    if (watchedWorkspacePath && !isPathInWorkspace(rootPath, watchedWorkspacePath)) {
      return { success: false, error: 'Access denied: Search path is outside the open workspace.' }
    }
    if (!isPathInWorkspace(rootPath, root)) {
      return { success: false, error: 'Access denied: Search path is outside the root directory.' }
    }
    try {
      const visit = async dir => {
        if (results.length >= 80) return
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (results.length >= 80 || ignored.has(entry.name)) continue
          const fullPath = join(dir, entry.name)
          if (entry.isDirectory()) { await visit(fullPath); continue }
          const relativePath = fullPath.slice(root.length).replace(/^[\\/]/, '').replace(/\\/g, '/')
          const filenameMatch = entry.name.toLowerCase().includes(needle)
          if (filenamesOnly) { if (filenameMatch) results.push({ path: relativePath, line: 1, preview: '' }); continue }
          if (filenameMatch) results.push({ path: relativePath, line: 1, preview: '[filename match]' })
          if (results.length >= 80) continue
          try {
            const content = await fs.readFile(fullPath, 'utf8')
            const lines = content.split(/\r?\n/)
            for (let index = 0; index < lines.length && results.length < 80; index++) {
              if (lines[index].toLowerCase().includes(needle)) results.push({ path: relativePath, line: index + 1, preview: lines[index].slice(0, 240) })
            }
          } catch { /* Skip binary or unreadable files. */ }
        }
      }
      await visit(rootPath)
      return { success: true, results }
    } catch (error) { return { success: false, error: error.message } }
  })

  ipcMain.handle('create-file', async (_, filePath, isDir) => {
    try {
      if (watchedWorkspacePath && !isPathInWorkspace(filePath, watchedWorkspacePath)) {
        return { success: false, error: 'Access denied: Path outside workspace.' }
      }
      if (isDir) {
        await fs.mkdir(filePath, { recursive: true })
      } else {
        await fs.mkdir(dirname(filePath), { recursive: true })
        await fs.writeFile(filePath, '', 'utf-8')
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rename-file', async (_, oldPath, newPath) => {
    try {
      if (watchedWorkspacePath && (!isPathInWorkspace(oldPath, watchedWorkspacePath) || !isPathInWorkspace(newPath, watchedWorkspacePath))) {
        return { success: false, error: 'Access denied: Path outside workspace.' }
      }
      await fs.rename(oldPath, newPath)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('delete-file', async (_, filePath) => {
    try {
      if (watchedWorkspacePath && !isPathInWorkspace(filePath, watchedWorkspacePath)) {
        return { success: false, error: 'Access denied: Path outside workspace.' }
      }
      await fs.rm(filePath, { recursive: true, force: true })
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('move-file', async (_, oldPath, newPath) => {
    try {
      if (watchedWorkspacePath && (!isPathInWorkspace(oldPath, watchedWorkspacePath) || !isPathInWorkspace(newPath, watchedWorkspacePath))) {
        return { success: false, error: 'Access denied: Path outside workspace.' }
      }
      await fs.rename(oldPath, newPath)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })
}

export function cleanupFsIPC() {
  workspaceWatcher?.close()
}
