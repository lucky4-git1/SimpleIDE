import { app, BrowserWindow, ipcMain, shell } from 'electron'
import express from 'express'
import { WebSocketServer } from 'ws'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'
import { registerFsIPC, cleanupFsIPC } from './src/main/ipc/fs.ipc.js'
import { registerGitIPC } from './src/main/ipc/git.ipc.js'
import { registerAiIPC } from './src/main/ipc/ai.ipc.js'
import { registerProcessIPC } from './src/main/ipc/process.ipc.js'
import { registerDbIPC } from './src/main/ipc/db.ipc.js'
import { registerSkillsIPC } from './src/main/ipc/skills.ipc.js'
import { registerPrimeRouterIPC } from './src/main/ipc/primeRouter.ipc.js'
import { localModelRuntime } from './src/main/primeRouter/LocalModelRuntime.js'
import { databaseManager } from './electron/database/DatabaseManager.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let mainWindow
let currentServer = null
let wsServer = null
const wsClients = new Set()
let reloadTimeout = null

let browserAgentWindow = null
let browserConsoleLogs = []

function broadcastReload() {
  if (reloadTimeout) clearTimeout(reloadTimeout)
  reloadTimeout = setTimeout(() => {
    wsClients.forEach(client => {
      if (client.readyState === 1) client.send('reload')
    })
  }, 300)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: join(__dirname, '../assets/icon.ico'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  // Register modular IPC handlers
  registerFsIPC(() => mainWindow, broadcastReload)
  registerGitIPC()
  registerAiIPC()
  registerProcessIPC()
  registerDbIPC()
  registerSkillsIPC()
  registerPrimeRouterIPC()

  // Initialize Prime Router local decision runtime in background
  localModelRuntime.initInBackground()

  // Server & Browser IPCs
  ipcMain.handle('start-server', async (_, folderPath) => {
    try {
      if (currentServer) {
        await new Promise(resolve => currentServer.close(resolve))
      }
      
      if (!wsServer) {
        wsServer = new WebSocketServer({ port: 3001 })
        wsServer.on('connection', (ws) => {
          wsClients.add(ws)
          ws.on('close', () => wsClients.delete(ws))
        })
        wsServer.on('error', (err) => {
          if (err.code !== 'EADDRINUSE') console.error('WS Error:', err)
        })
      }

      const expressApp = express()
      
      expressApp.use(async (req, res, next) => {
        if (req.path.endsWith('.html') || req.path === '/') {
          const targetFile = req.path === '/' ? '/index.html' : req.path
          const fullPath = join(folderPath, targetFile)
          try {
            let content = await fs.readFile(fullPath, 'utf-8')
            const injectScript = `
              <script>
                (function() {
                  const ws = new WebSocket('ws://localhost:3001');
                  ws.onmessage = function(msg) {
                    if (msg.data === 'reload') window.location.reload();
                  };
                })();
              </script>
            `
            if (content.includes('</body>')) {
              content = content.replace('</body>', `${injectScript}</body>`)
            } else {
              content += injectScript
            }
            res.send(content)
            return
          } catch {
            // Pass to static middleware if file read fails
          }
        }
        next()
      })

      expressApp.use(express.static(folderPath))
      
      await new Promise((resolve, reject) => {
        currentServer = expressApp.listen(3000, () => {
          resolve()
        }).on('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            resolve() // Assume it's already running
          } else {
            reject(err)
          }
        })
      })
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('open-in-browser', async (_, relativePath) => {
    try {
      const url = `http://localhost:3000/${relativePath.replace(/\\/g, '/')}`
      // Basic security validation: allow only valid HTTP URLs
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error('Invalid URL protocol')
      }
      await shell.openExternal(url)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('browser-action', async (_, { action, url, selector, text, width, height }) => {
    try {
      if (!browserAgentWindow) {
        browserAgentWindow = new BrowserWindow({
          show: false,
          width: 1280,
          height: 800,
          webPreferences: { contextIsolation: true, nodeIntegration: false }
        })
        browserAgentWindow.webContents.on('console-message', (e, level, msg) => {
          if (level >= 2) browserConsoleLogs.push(msg)
        })
        browserAgentWindow.on('closed', () => { browserAgentWindow = null })
      }

      const wc = browserAgentWindow.webContents

      switch (action) {
        case 'navigate':
          browserConsoleLogs = []
          await browserAgentWindow.loadURL(url)
          return { success: true }
        
        case 'reload':
          browserConsoleLogs = []
          wc.reload()
          return new Promise(resolve => wc.once('did-finish-load', () => resolve({ success: true })))
        
        case 'screenshot':
          const image = await wc.capturePage()
          return { success: true, dataUrl: image.toDataURL() }

        case 'set_viewport':
          browserAgentWindow.setSize(Number(width), Number(height))
          return { success: true, result: { width: Number(width), height: Number(height) } }
        
        case 'inspect_dom':
          const dom = await wc.executeJavaScript(`document.documentElement.outerHTML`)
          return { success: true, result: dom }
        
        case 'get_page_text':
          const pageText = await wc.executeJavaScript(`document.body.innerText`)
          return { success: true, result: pageText }

        case 'audit':
          const audit = await wc.executeJavaScript(`(() => {
            const visible = element => {
              const style = getComputedStyle(element)
              const rect = element.getBoundingClientRect()
              return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
            }
            const missingAlt = [...document.images]
              .filter(image => !image.hasAttribute('alt'))
              .map(image => image.src || '(inline image)')
              .slice(0, 10)
            const unnamedControls = [...document.querySelectorAll('button, a, input, select, textarea')]
              .filter(element => visible(element) && !element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby') && !String(element.innerText || element.value || element.placeholder || '').trim())
              .map(element => element.outerHTML.slice(0, 160))
              .slice(0, 10)
            const overflow = document.documentElement.scrollWidth > window.innerWidth + 1
            return {
              title: document.title,
              viewport: { width: window.innerWidth, height: window.innerHeight },
              overflow,
              documentWidth: document.documentElement.scrollWidth,
              imageCount: document.images.length,
              missingAlt,
              unnamedControls,
              links: document.links.length,
              forms: document.forms.length
            }
          })()`)
          return { success: true, result: audit }
        
        case 'get_console_errors':
          const logs = [...browserConsoleLogs]
          browserConsoleLogs = []
          return { success: true, result: logs }
        
        case 'click':
          await wc.executeJavaScript(`
            (function() {
              const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
              if(el) { el.click(); return true; }
              return false;
            })()
          `)
          return { success: true }
        
        case 'type':
          await wc.executeJavaScript(`
            (function() {
              const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
              if(el) { el.value = '${text.replace(/'/g, "\\'")}'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; }
              return false;
            })()
          `)
          return { success: true }

        case 'scroll':
          await wc.executeJavaScript(`window.scrollBy(0, window.innerHeight)`)
          return { success: true }
        
        default:
          throw new Error(`Unknown browser action: ${action}`)
      }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  cleanupFsIPC()
  databaseManager.close()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
