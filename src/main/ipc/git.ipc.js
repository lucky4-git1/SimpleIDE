import { ipcMain } from 'electron'
import simpleGit from 'simple-git'

export function registerGitIPC() {
  ipcMain.handle('git-status', async (_, folderPath) => {
    try {
      const git = simpleGit(folderPath)
      const status = await git.status()
      return { success: true, status: JSON.parse(JSON.stringify(status)) }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('git-stage', async (_, { folderPath, filePath }) => {
    try {
      const git = simpleGit(folderPath)
      await git.add(filePath)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('git-unstage', async (_, { folderPath, filePath }) => {
    try {
      const git = simpleGit(folderPath)
      await git.reset(['--', filePath])
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('git-commit', async (_, { folderPath, message }) => {
    try {
      const git = simpleGit(folderPath)
      await git.commit(message)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('git-push', async (_, folderPath) => {
    try {
      const git = simpleGit(folderPath)
      await git.push()
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('git-pull', async (_, folderPath) => {
    try {
      const git = simpleGit(folderPath)
      await git.pull()
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('git-diff', async (_, { folderPath, filePath }) => {
    try {
      const git = simpleGit(folderPath)
      const diff = await git.diff([filePath])
      return { success: true, diff }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })
}
