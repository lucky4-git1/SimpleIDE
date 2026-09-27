import { ipcMain } from 'electron'
import { localModelRuntime } from '../primeRouter/LocalModelRuntime.js'

export function registerPrimeRouterIPC() {
  ipcMain.handle('prime-router:decide', async (_, params) => {
    try {
      const decision = await localModelRuntime.predict(params || {})
      return { success: true, decision }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('prime-router:batch', async (_, items) => {
    try {
      const decisions = await localModelRuntime.batchPredict(items || [])
      return { success: true, decisions }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('prime-router:status', async () => {
    try {
      return { success: true, status: localModelRuntime.getStatus() }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('prime-router:init', async () => {
    try {
      await localModelRuntime.initInBackground()
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })
}
