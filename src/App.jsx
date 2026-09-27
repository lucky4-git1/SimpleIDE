import { useState, useEffect, useRef, useCallback } from 'react'
import Layout from './components/Layout'
import Sidebar from './components/Sidebar'
import Tabs from './components/Tabs'
import Editor from './components/Editor'
import Terminal from './components/Terminal'
import StatusBar from './components/StatusBar'
import SearchModal from './components/SearchModal'
import PromptModal from './components/PromptModal'
import CommandPalette from './components/CommandPalette'
import AIPanel from './components/AIPanel'
import AISettingsModal from './components/AISettingsModal'
import ActivityBar from './components/ActivityBar'
import GitPanel from './components/GitPanel'
import WorkspaceSearch from './components/WorkspaceSearch'
import QuickOpenModal from './components/QuickOpenModal'
import WelcomeScreen from './components/WelcomeScreen'
import './App.v2.css'
import { getLanguageFromFile } from './utils/language'
import { buildFileIndex, getProjectSummary } from './services/fileIndex'
import { ProjectIndexer } from './services/agentEngine/ProjectIndexer'
import { globalContextEngine } from './services/agentEngine/ContextEngine'
import { useWorkspaceStore } from './store/workspaceStore'
import { useEditorStore } from './store/editorStore'
import { useUIStore } from './store/uiStore'

function joinWorkspacePath(rootPath, relativePath) {
  const root = String(rootPath || '').replace(/[\\/]+$/, '')
  const relative = String(relativePath || '').replace(/^[/\\]+/, '').replace(/\//g, '\\')
  return relative ? `${root}\\${relative}` : root
}

export default function App() {
  // Store Hooks
  const {
    currentFolder, fileTree, projectIndex, projectSummary, isIndexing,
    setCurrentFolder, setFileTree, setProjectIndex, setProjectSummary, setIsIndexing, updateSingleIndexedFile
  } = useWorkspaceStore()

  const {
    openFiles, activeFilePath, cursorPosition, selectedCode, markers, pendingReveal,
    setOpenFiles, setActiveFilePath, setCursorPosition, setSelectedCode, setMarkers, setPendingReveal,
    openFile, closeFile, updateFileContent, markFileSaved
  } = useEditorStore()

  const {
    isDark, activePanel, isSidebarOpen, isTerminalOpen, isAIPanelOpen, isFocusMode,
    sidebarWidth, aiPanelWidth, terminalHeight, isCommandPaletteOpen, isQuickOpenOpen,
    isSearchOpen, isAISettingsOpen, terminalOutput,
    setIsDark, setActivePanel, setIsSidebarOpen, setIsTerminalOpen, setIsAIPanelOpen,
    setIsFocusMode, setSidebarWidth, setAIPanelWidth, setTerminalHeight,
    setIsCommandPaletteOpen, setIsQuickOpenOpen, setIsSearchOpen, setIsAISettingsOpen,
    setTerminalOutput, appendTerminalOutput, clearTerminalOutput
  } = useUIStore()

  // Local UI-only state
  const [contextMenu, setContextMenu] = useState(null)
  const [promptConfig, setPromptConfig] = useState(null)
  const [isAIWorking, setIsAIWorking] = useState(false)
  const [aiEditHistory, setAIEditHistory] = useState([])
  // Bumped every time AI settings close so the AI panel reloads provider/key/model.
  const [aiSettingsVersion, setAISettingsVersion] = useState(0)

  const layoutBeforeFocusRef = useRef(null)
  const workspaceRefreshTimerRef = useRef(null)
  const currentFolderRef = useRef(null)
  const indexedWorkspaceRef = useRef(null)
  const workspaceServerRef = useRef(null)
  const terminalSessionRef = useRef(null)
  const indexBuildRef = useRef(0)
  const projectIndexerRef = useRef(null)

  // State ref for stable event callbacks
  const stateRef = useRef({ openFiles, activeFilePath, isSearchOpen, isCommandPaletteOpen, isQuickOpenOpen, selectedCode, projectSummary, markers })
  useEffect(() => {
    stateRef.current = { openFiles, activeFilePath, isSearchOpen, isCommandPaletteOpen, isQuickOpenOpen, selectedCode, projectSummary, markers }
  }, [openFiles, activeFilePath, isSearchOpen, isCommandPaletteOpen, isQuickOpenOpen, selectedCode, projectSummary, markers])

  // The integrated terminal is a persistent shell, so commands such as `cd`
  // keep their working directory just like they do in a desktop IDE.
  useEffect(() => {
    const unsubscribe = window.api.onTerminalData?.((data) => {
      if (data?.id === 'integrated') appendTerminalOutput(data.text || '')
    })
    return () => unsubscribe?.()
  }, [appendTerminalOutput])

  useEffect(() => {
    if (!currentFolder) return undefined
    clearTerminalOutput()
    terminalSessionRef.current = currentFolder
    window.api.startTerminal?.({ id: 'integrated', cwd: currentFolder }).then(result => {
      if (!result?.success) appendTerminalOutput(`Unable to start terminal: ${result?.error || 'Unknown error'}\n`)
    })
    return () => {
      window.api.stopTerminal?.({ id: 'integrated' })
      terminalSessionRef.current = null
    }
  }, [currentFolder, appendTerminalOutput, clearTerminalOutput])

  const refreshWorkspaceTree = useCallback(async (path) => {
    const result = await window.api.listFiles(path)
    if (result.success) {
      setFileTree(result.children)
      return true
    }
    appendTerminalOutput(`\nError loading folder: ${result.error}`)
    return false
  }, [setFileTree, appendTerminalOutput])

  const rebuildProjectIndex = useCallback(async (path) => {
    const buildId = ++indexBuildRef.current
    setIsIndexing(true)
    try {
      const index = await buildFileIndex(path)
      
      const indexer = new ProjectIndexer(path, { api: window.api })
      await indexer.buildIndex()

      if (buildId === indexBuildRef.current) {
        // An older asynchronous index must never replace the active
        // workspace's code intelligence after the user switches folders.
        projectIndexerRef.current = indexer
        globalContextEngine.resetWorkspace(path)
        globalContextEngine.setCodeIntelligence(indexer.codeIntelligence)
        indexedWorkspaceRef.current = path
        setProjectIndex(index)
        globalContextEngine.setFileIndex(index)
      }
    } finally {
      if (buildId === indexBuildRef.current) setIsIndexing(false)
    }
  }, [setIsIndexing, setProjectIndex])

  const updateIndexedFile = useCallback(async (folderPath, change) => {
    const relativePath = String(change?.fileName || '').replace(/\\/g, '/')
    if (!relativePath || /(^|\/)(node_modules|\.git|dist|dist-electron|coverage)(\/|$)/.test(relativePath)) return

    const filePath = joinWorkspacePath(folderPath, relativePath)
    const readResult = await window.api.readFile(filePath)
    if (readResult.success) {
      updateSingleIndexedFile(filePath, readResult.content)
      projectIndexerRef.current?.codeIntelligence?.updateFile(relativePath, readResult.content)
    } else {
      projectIndexerRef.current?.codeIntelligence?.removeFile(relativePath)
    }
  }, [updateSingleIndexedFile])

  const loadFolder = useCallback(async (path, { rebuildIndex = false } = {}) => {
    if (!path) return
    const isNewWorkspace = currentFolderRef.current !== path
    currentFolderRef.current = path
    if (isNewWorkspace) {
      // Do not leave another workspace's tabs, selection, or index visible to
      // the agent during the short period before this folder finishes loading.
      setOpenFiles([])
      setActiveFilePath(null)
      setSelectedCode('')
      setProjectIndex([])
      setProjectSummary('')
      indexedWorkspaceRef.current = null
      projectIndexerRef.current = null
      globalContextEngine.resetWorkspace(path)
      globalContextEngine.setFileIndex([])
    }
    setCurrentFolder(path)
    window.api.watchWorkspace?.(path)

    const treeLoaded = await refreshWorkspaceTree(path)
    if (!treeLoaded) return

    if (workspaceServerRef.current !== path) {
      workspaceServerRef.current = path
      window.api.startServer(path).then((res) => {
        if (!res.success) {
          appendTerminalOutput(`\nWarning: Could not start local server: ${res.error}`)
        } else {
          appendTerminalOutput(`\nLocal server started on port 3000`)
        }
      })
    }

    if (isNewWorkspace || rebuildIndex || indexedWorkspaceRef.current !== path) {
      rebuildProjectIndex(path)
    }

    if (window.api?.db?.initWorkspace) {
      window.api.db.initWorkspace({ rootPath: path, name: path.split(/[/\\]/).pop() })
    }
  }, [rebuildProjectIndex, refreshWorkspaceTree, setCurrentFolder, appendTerminalOutput, setOpenFiles, setActiveFilePath, setSelectedCode, setProjectIndex, setProjectSummary])

  // Restore saved state
  useEffect(() => {
    const init = async () => {
      const savedTheme = localStorage.getItem('ide_theme')
      if (savedTheme === 'light') setIsDark(false)

      const savedFolder = localStorage.getItem('ide_folder')
      const savedTabsStr = localStorage.getItem('ide_tabs')
      const savedActiveTab = localStorage.getItem('ide_activeTab')

      if (savedFolder) {
        if (window.api?.db?.initWorkspace) {
          window.api.db.initWorkspace({ rootPath: savedFolder, name: savedFolder.split(/[/\\]/).pop() })
        }
        await loadFolder(savedFolder)
        useWorkspaceStore.getState().restoreState(savedFolder)
        useEditorStore.getState().restoreState(savedFolder)
      }

      if (savedTabsStr) {
        try {
          const tabPaths = JSON.parse(savedTabsStr)
          const loadedFiles = []
          for (const p of tabPaths) {
            const result = await window.api.readFile(p)
            if (result.success) {
              const name = p.split(/[/\\]/).pop()
              loadedFiles.push({ path: p, name, content: result.content, isDirty: false })
            }
          }
          setOpenFiles(loadedFiles)
          
          if (savedActiveTab && loadedFiles.find(f => f.path === savedActiveTab)) {
            setActiveFilePath(savedActiveTab)
          } else if (loadedFiles.length > 0) {
            setActiveFilePath(loadedFiles[loadedFiles.length - 1].path)
          }
        } catch(e) {
          console.error("Failed to restore tabs", e)
        }
      }
    }
    init()
  }, [loadFolder, setOpenFiles, setActiveFilePath, setIsDark])

  // Persist workspace and editor state to SQLite
  useEffect(() => {
    if (currentFolder) {
      useWorkspaceStore.getState().persistState()
      useEditorStore.getState().persistState(currentFolder)
    }
  }, [currentFolder, openFiles, activeFilePath])

  useEffect(() => {
    setProjectSummary(getProjectSummary(projectIndex))
  }, [projectIndex, setProjectSummary])

  useEffect(() => {
    if (!currentFolder || !window.api.onWorkspaceChanged) return undefined
    return window.api.onWorkspaceChanged((change) => {
      clearTimeout(workspaceRefreshTimerRef.current)
      workspaceRefreshTimerRef.current = setTimeout(() => {
        refreshWorkspaceTree(currentFolder)
        updateIndexedFile(currentFolder, change)
      }, 120)
    })
  }, [currentFolder, refreshWorkspaceTree, updateIndexedFile])

  // Persist state to localStorage
  useEffect(() => {
    if (currentFolder) localStorage.setItem('ide_folder', currentFolder)
    localStorage.setItem('ide_tabs', JSON.stringify(openFiles.map(f => f.path)))
    if (activeFilePath) localStorage.setItem('ide_activeTab', activeFilePath)
    localStorage.setItem('ide_theme', isDark ? 'dark' : 'light')
    localStorage.setItem('ide_sidebar_width', String(sidebarWidth))
    localStorage.setItem('ide_ai_panel_width', String(aiPanelWidth))
  }, [currentFolder, openFiles, activeFilePath, isDark, sidebarWidth, aiPanelWidth])

  // Context Menu Handlers
  const handleContextMenu = (e, node, action) => {
    if (action === 'createFile') return handleCreateFile(node, false)
    if (action === 'createFolder') return handleCreateFile(node, true)
    setContextMenu({ x: e.pageX, y: e.pageY, node })
  }
  const closeContextMenu = () => setContextMenu(null)

  const handleCreateFile = (node, isDir) => {
    closeContextMenu()
    setPromptConfig({
      title: `Enter ${isDir ? 'folder' : 'file'} name:`,
      defaultValue: '',
      onSubmit: async (rawName) => {
        setPromptConfig(null)
        const name = String(rawName || '').trim()
        if (!name) return
        const targetNode = node || { path: currentFolder, isDirectory: true }
        const parentPath = targetNode.isDirectory ? targetNode.path : targetNode.path.replace(/[/\\][^/\\]*$/, '')
        const normalizedParent = parentPath.replace(/[/\\]+$/, '')
        const newPath = `${normalizedParent}/${name}`
        const result = await window.api.createFile(newPath, isDir)
        if (result.success) {
          await loadFolder(currentFolder, { rebuildIndex: true })
          if (!isDir) {
            handleOpenFilePath(newPath)
          }
        } else {
          appendTerminalOutput(`\nError creating ${isDir ? 'folder' : 'file'}: ${result.error}`)
        }
      }
    })
  }

  const handleRenameFile = (node) => {
    closeContextMenu()
    if (node.isRoot) return
    setPromptConfig({
      title: 'Enter new name:',
      defaultValue: node.name,
      onSubmit: async (newName) => {
        setPromptConfig(null)
        if (newName === node.name) return
        const parentPath = node.path.replace(/[/\\][^/\\]*$/, '')
        const newPath = `${parentPath}/${newName}`
        const result = await window.api.renameFile(node.path, newPath)
        if (result.success) {
          loadFolder(currentFolder, { rebuildIndex: true })
        } else {
          appendTerminalOutput(`\nError renaming file: ${result.error}`)
        }
      }
    })
  }

  const handleDeleteFile = async (node) => {
    closeContextMenu()
    if (node.isRoot) return
    if (!confirm(`Are you sure you want to delete ${node.name}?`)) return
    const result = await window.api.deleteFile(node.path)
    if (result.success) {
      loadFolder(currentFolder, { rebuildIndex: true })
      closeFile(node.path)
    } else {
      appendTerminalOutput(`\nError deleting file: ${result.error}`)
    }
  }

  const handleMoveFile = async (oldPath, fileName, targetFolderPath) => {
    const newPath = `${targetFolderPath}/${fileName}`
    if (oldPath === newPath) return
    const result = await window.api.moveFile(oldPath, newPath)
    if (result.success) {
      setOpenFiles(openFiles.map(f => {
        if (f.path === oldPath) return { ...f, path: newPath }
        if (f.path.startsWith(oldPath + '/') || f.path.startsWith(oldPath + '\\')) {
          return { ...f, path: f.path.replace(oldPath, newPath) }
        }
        return f
      }))
      
      if (activeFilePath === oldPath) {
        setActiveFilePath(newPath)
      } else if (activeFilePath?.startsWith(oldPath + '/') || activeFilePath?.startsWith(oldPath + '\\')) {
        setActiveFilePath(activeFilePath.replace(oldPath, newPath))
      }
      
      loadFolder(currentFolder, { rebuildIndex: true })
    } else {
      appendTerminalOutput(`\nError moving file: ${result.error}`)
    }
  }

  const handleApplyAICode = (code) => {
    if (!activeFilePath) return
    updateFileContent(activeFilePath, code)
  }

  const handleAgentFileWrite = (filePath, content, previousContent = '', metadata = {}) => {
    setAIEditHistory(prev => [...prev, { filePath, previousContent, content, taskId: metadata.taskId, operation: metadata.operation || 'write', timestamp: Date.now() }].slice(-60))
    updateSingleIndexedFile(filePath, content)
    setOpenFiles(openFiles.map(f => {
      const normalizedF = f.path.replace(/\\/g, '/').toLowerCase()
      const normalizedTarget = filePath.replace(/\\/g, '/').toLowerCase()
      return normalizedF === normalizedTarget ? { ...f, content, isDirty: false } : f
    }))
  }

  const handleUndoAIEdit = async () => {
    const latest = aiEditHistory[aiEditHistory.length - 1]
    if (!latest) return
    const result = await window.api.writeFile(latest.filePath, latest.previousContent)
    if (!result.success) {
      appendTerminalOutput(`\nCould not undo AI edit: ${result.error}`)
      return
    }
    setOpenFiles(openFiles.map(file => {
      const normalizedF = file.path.replace(/\\/g, '/').toLowerCase()
      const normalizedTarget = latest.filePath.replace(/\\/g, '/').toLowerCase()
      return normalizedF === normalizedTarget ? { ...file, content: latest.previousContent, isDirty: false } : file
    }))
    updateSingleIndexedFile(latest.filePath, latest.previousContent)
    setAIEditHistory(prev => prev.slice(0, -1))
    handleAgentWorkspaceChange()
  }

  const handleUndoAgentTask = async () => {
    const latest = aiEditHistory[aiEditHistory.length - 1]
    if (!latest) return
    const taskId = latest.taskId
    const edits = taskId ? aiEditHistory.filter(edit => edit.taskId === taskId) : [latest]
    for (const edit of [...edits].reverse()) {
      const current = await window.api.readFile(edit.filePath)
      if (!current.success || current.content !== edit.content) {
        appendTerminalOutput(`\nSkipped undo for ${edit.filePath}: it changed after the agent task.`)
        continue
      }
      const result = await window.api.writeFile(edit.filePath, edit.previousContent)
      if (!result.success) appendTerminalOutput(`\nCould not undo ${edit.filePath}: ${result.error}`)
    }
    setAIEditHistory(prev => prev.filter(edit => !taskId || edit.taskId !== taskId))
    handleAgentWorkspaceChange()
  }

  const handleAgentWorkspaceChange = () => {
    if (currentFolder) refreshWorkspaceTree(currentFolder)
  }

  const handleOpenFolderClick = async () => {
    const path = await window.api.openFolder()
    if (path) {
      loadFolder(path)
    }
  }

  const handleCloseWorkspace = async () => {
    if (!currentFolder) return
    const dirtyFiles = stateRef.current.openFiles.filter(file => file.isDirty)
    if (dirtyFiles.length && !window.confirm(`Save ${dirtyFiles.length} unsaved file${dirtyFiles.length === 1 ? '' : 's'} before closing this workspace?`)) return

    if (dirtyFiles.length) {
      const saveResults = await Promise.all(dirtyFiles.map(file => window.api.writeFile(file.path, file.content)))
      if (saveResults.some(result => !result.success)) {
        appendTerminalOutput('\nUnable to save every open file. Workspace remains open.')
        return
      }
    }

    await window.api.unwatchWorkspace?.()
    currentFolderRef.current = null
    indexedWorkspaceRef.current = null
    workspaceServerRef.current = null
    projectIndexerRef.current = null
    clearTimeout(workspaceRefreshTimerRef.current)
    setCurrentFolder(null)
    setFileTree([])
    setProjectIndex([])
    setProjectSummary('')
    setIsIndexing(false)
    setOpenFiles([])
    setActiveFilePath(null)
    setSelectedCode('')
    setMarkers([])
    setPendingReveal(null)
    localStorage.removeItem('ide_folder')
    localStorage.removeItem('ide_tabs')
    localStorage.removeItem('ide_activeTab')
    appendTerminalOutput('\nWorkspace closed. Files were left unchanged on disk.')
  }

  const handleActivityBarClick = (panelId) => {
    if (isFocusMode) setIsFocusMode(false)
    if (panelId === activePanel) {
      setIsSidebarOpen(!isSidebarOpen)
    } else {
      setActivePanel(panelId)
      setIsSidebarOpen(true)
    }
  }

  const handleOpenInBrowser = async () => {
    if (!activeFilePath || !currentFolder) return
    const normalizedActivePath = activeFilePath.replace(/\\/g, '/');
    const normalizedFolder = currentFolder.replace(/\\/g, '/');
    
    let relativePath = normalizedActivePath;
    if (normalizedActivePath.toLowerCase().startsWith(normalizedFolder.toLowerCase())) {
      relativePath = normalizedActivePath.substring(normalizedFolder.length).replace(/^\//, '');
    }
    
    const result = await window.api.openInBrowser(relativePath)
    if (!result.success) {
      appendTerminalOutput(`\nError opening browser: ${result.error}`)
    }
  }

  const handleFileClick = async (file) => {
    if (file.isDirectory) return
    await handleOpenFilePath(file.path)
  }

  const handleOpenFilePath = async (filePath, lineNumber = null) => {
    const existingFile = openFiles.find(f => f.path === filePath)
    if (existingFile) {
      setActiveFilePath(filePath)
      setPendingReveal(lineNumber ? { path: filePath, lineNumber, key: Date.now() } : null)
      return
    }

    const result = await window.api.readFile(filePath)
    if (result.success) {
      const name = filePath.split(/[/\\]/).pop()
      openFile({
        path: filePath,
        name,
        content: result.content,
        isDirty: false
      })
      setPendingReveal(lineNumber ? { path: filePath, lineNumber, key: Date.now() } : null)
    } else {
      appendTerminalOutput(`\nError reading file: ${result.error}`)
    }
  }

  const handleSave = async (filePathToSave = activeFilePath) => {
    if (!filePathToSave) return
    const file = openFiles.find(f => f.path === filePathToSave)
    if (!file) return

    const result = await window.api.writeFile(file.path, file.content)
    if (result.success) {
      markFileSaved(file.path)
    } else {
      appendTerminalOutput(`\nError saving file: ${result.error}`)
    }
  }

  // Debounced auto-save
  useEffect(() => {
    const dirtyFiles = openFiles.filter(f => f.isDirty)
    if (dirtyFiles.length === 0) return

    const timer = setTimeout(() => {
      dirtyFiles.forEach(f => handleSave(f.path))
    }, 1500)

    return () => clearTimeout(timer)
  }, [openFiles])

  const handleRunCommand = async (command) => {
    if (!command.trim()) return
    appendTerminalOutput(`\n$ ${command}\n`)
    const result = await window.api.runCode(command)
    if (result.success) {
      appendTerminalOutput(result.stdout + (result.stderr ? `\nError: ${result.stderr}` : ''))
    } else {
      appendTerminalOutput(`\nError:\n${result.stderr || result.stdout}`)
    }
  }

  const handleTerminalInput = async (input) => {
    if (!input.trim()) return
    const result = await window.api.writeTerminal?.({ id: 'integrated', input })
    if (!result?.success) appendTerminalOutput(`\nTerminal error: ${result?.error || 'Terminal is not running.'}\n`)
  }

  const handleRun = async () => {
    if (!activeFilePath) return
    await handleSave(activeFilePath)

    const lang = getLanguageFromFile(activeFilePath)
    let command
    if (lang === 'javascript') {
      command = `node "${activeFilePath}"`
    } else if (lang === 'python') {
      command = `python "${activeFilePath}"`
    } else {
      appendTerminalOutput(`\nCannot auto-run language: ${lang}`)
      return
    }
    
    handleRunCommand(command)
  }

  const openWorkspaceSearch = () => {
    setActivePanel('search')
    setIsSidebarOpen(true)
  }

  const openExplorerPanel = () => {
    setActivePanel('explorer')
    setIsSidebarOpen(true)
  }

  const openGitPanel = () => {
    setActivePanel('git')
    setIsSidebarOpen(true)
  }

  const handleCreateRootFile = (isDir) => {
    if (!currentFolder) {
      appendTerminalOutput(`\nOpen a folder before creating a ${isDir ? 'folder' : 'file'}.`)
      return
    }
    handleCreateFile({ path: currentFolder, isDirectory: true, isRoot: true }, isDir)
  }

  const handleSaveAll = () => {
    const dirtyFiles = stateRef.current.openFiles.filter(file => file.isDirty)
    if (!dirtyFiles.length) {
      appendTerminalOutput(`\nAll files are already saved.`)
      return
    }
    dirtyFiles.forEach(file => handleSave(file.path))
  }

  const toggleFocusMode = () => {
    if (isFocusMode) {
      const previous = layoutBeforeFocusRef.current
      setIsSidebarOpen(previous?.isSidebarOpen ?? true)
      setIsTerminalOpen(previous?.isTerminalOpen ?? true)
      setIsAIPanelOpen(previous?.isAIPanelOpen ?? false)
      setIsFocusMode(false)
      return
    }

    layoutBeforeFocusRef.current = { isSidebarOpen, isTerminalOpen, isAIPanelOpen }
    setIsSidebarOpen(false)
    setIsTerminalOpen(false)
    setIsAIPanelOpen(false)
    setIsFocusMode(true)
  }

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        if (e.shiftKey) handleSaveAll()
        else handleSave(stateRef.current.activeFilePath)
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
        e.preventDefault()
        handleOpenFolderClick()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault()
        if (stateRef.current.activeFilePath) {
          closeFile(stateRef.current.activeFilePath)
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'b' && !e.shiftKey) {
        e.preventDefault()
        setIsSidebarOpen(!isSidebarOpen)
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setIsQuickOpenOpen(!stateRef.current.isQuickOpenOpen)
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        openWorkspaceSearch()
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setIsCommandPaletteOpen(!stateRef.current.isCommandPaletteOpen)
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
        e.preventDefault()
        const files = stateRef.current.openFiles
        const currentActive = stateRef.current.activeFilePath
        if (files.length > 1) {
          const currentIndex = files.findIndex(f => f.path === currentActive)
          const nextIndex = e.shiftKey
            ? (currentIndex - 1 + files.length) % files.length
            : (currentIndex + 1) % files.length
          setActiveFilePath(files[nextIndex].path)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeFile, handleSaveAll, isSidebarOpen, setActiveFilePath, setIsCommandPaletteOpen, setIsQuickOpenOpen, setIsSidebarOpen])

  const activeFile = openFiles.find(f => f.path === activeFilePath)

  const commands = [
    { name: "File: Open Folder", shortcut: "Ctrl+O", action: handleOpenFolderClick },
    { name: "File: Close Workspace", description: "Close the current folder without deleting its files", action: handleCloseWorkspace },
    { name: "File: Quick Open", description: "Search indexed project files", shortcut: "Ctrl+P", action: () => setIsQuickOpenOpen(true) },
    { name: "File: New File", description: "Create a file in the workspace root", action: () => handleCreateRootFile(false) },
    { name: "File: New Folder", description: "Create a folder in the workspace root", action: () => handleCreateRootFile(true) },
    { name: "File: Save", description: "Save the active file", shortcut: "Ctrl+S", action: () => handleSave(stateRef.current.activeFilePath) },
    { name: "File: Save All", description: "Save every dirty open file", shortcut: "Ctrl+Shift+S", action: handleSaveAll },
    { name: "File: Run Current File", action: handleRun },
    { name: "Search: Workspace Search", description: "Show project-wide search", shortcut: "Ctrl+Shift+F", action: openWorkspaceSearch },
    { name: "View: Toggle Terminal", action: () => setIsTerminalOpen(!isTerminalOpen) },
    { name: "View: Toggle Sidebar", description: "Show or hide the file explorer", shortcut: "Ctrl+B", action: () => setIsSidebarOpen(!isSidebarOpen) },
    { name: "View: Toggle Focus Mode", description: "Hide panels for a cleaner coding view", action: toggleFocusMode },
    { name: "View: Show Explorer", description: "Open the file explorer", action: openExplorerPanel },
    { name: "View: Show Source Control", description: "Open Git tools", action: openGitPanel },
    { name: "View: Toggle AI Panel", description: "Open or close the AI assistant", action: () => setIsAIPanelOpen(!isAIPanelOpen) },
    { name: "AI: Open Settings", description: "Configure your AI API key", action: () => setIsAISettingsOpen(true) },
    { name: "AI: Explain Code", description: "Explain the selected code", action: () => setIsAIPanelOpen(true) },
    { name: "AI: Fix Errors", description: "Fix syntax/runtime errors in current file", action: () => {
      if (stateRef.current.markers.length > 0) {
        setIsAIPanelOpen(true)
        appendTerminalOutput(`\nAI Assistant: Analyzing ${stateRef.current.markers.length} markers...`)
      }
    }},
    { name: "AI: Explain Project", description: "Explain the entire project architecture", action: () => setIsAIPanelOpen(true) },
    { name: "AI: Generate README", description: "Generate a README.md for the project", action: () => setIsAIPanelOpen(true) },
    { name: "Git: Status", description: "Show git status in terminal", action: () => handleRunCommand('git status') },
    { name: "Git: Init", description: "Initialize git repository", action: () => handleRunCommand('git init') },
    { name: "View: Close Active Tab", action: () => stateRef.current.activeFilePath && closeFile(stateRef.current.activeFilePath) }
  ]

  return (
    <div className="ui-v2 h-screen w-screen flex flex-col overflow-hidden bg-[#030305]" onClick={closeContextMenu}>
      <AISettingsModal
        isOpen={isAISettingsOpen}
        onClose={() => {
          setIsAISettingsOpen(false)
          setAISettingsVersion(version => version + 1)
        }}
        isDark={isDark}
      />
      <PromptModal
        isOpen={!!promptConfig}
        title={promptConfig?.title}
        defaultValue={promptConfig?.defaultValue}
        onSubmit={promptConfig?.onSubmit}
        onCancel={() => setPromptConfig(null)}
        isDark={isDark}
      />
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        commands={commands}
        isDark={isDark}
      />
      <QuickOpenModal
        isOpen={isQuickOpenOpen}
        onClose={() => setIsQuickOpenOpen(false)}
        currentFolder={currentFolder}
        projectIndex={projectIndex}
        openFiles={openFiles}
        isIndexing={isIndexing}
        onOpenFile={handleOpenFilePath}
        isDark={isDark}
      />
      <SearchModal 
        isOpen={isSearchOpen} 
        onClose={() => setIsSearchOpen(false)} 
        openFiles={openFiles}
        onSelectFile={setActiveFilePath}
        isDark={isDark}
      />
      
      {contextMenu && (
        <div 
          className={`absolute z-50 py-1 rounded shadow-xl border min-w-[150px] text-sm ${
            isDark ? 'bg-[#252526] border-[#333] text-zinc-300' : 'bg-white border-zinc-200 text-zinc-800'
          }`}
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <div className={`px-4 py-1.5 cursor-pointer ${isDark ? 'hover:bg-[#094771]' : 'hover:bg-blue-100'}`} onClick={() => handleCreateFile(contextMenu.node, false)}>New File</div>
          <div className={`px-4 py-1.5 cursor-pointer ${isDark ? 'hover:bg-[#094771]' : 'hover:bg-blue-100'}`} onClick={() => handleCreateFile(contextMenu.node, true)}>New Folder</div>
          {!contextMenu.node.isRoot && (
            <>
              <div className={`my-1 border-b ${isDark ? 'border-[#333]' : 'border-zinc-200'}`}></div>
              <div className={`px-4 py-1.5 cursor-pointer ${isDark ? 'hover:bg-[#094771]' : 'hover:bg-blue-100'}`} onClick={() => handleRenameFile(contextMenu.node)}>Rename</div>
              <div className={`px-4 py-1.5 cursor-pointer text-red-500 ${isDark ? 'hover:bg-[#094771]' : 'hover:bg-red-50'}`} onClick={() => handleDeleteFile(contextMenu.node)}>Delete</div>
            </>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        <Layout
          isDark={isDark}
          isSidebarOpen={isSidebarOpen}
          terminalHeight={terminalHeight}
          isTerminalOpen={isTerminalOpen}
          onTerminalResize={setTerminalHeight}
          sidebarWidth={sidebarWidth}
          onSidebarResize={setSidebarWidth}
          aiPanelWidth={aiPanelWidth}
          onAIPanelResize={setAIPanelWidth}
          isAIWorking={isAIWorking}
          isAIPanelOpen={isAIPanelOpen}
          aiPanel={
            <AIPanel
              isDark={isDark}
              selectedCode={selectedCode}
              activeFile={activeFile}
              currentFolder={currentFolder}
              projectIndex={projectIndex}
              openFiles={openFiles}
              onOpenSettings={() => setIsAISettingsOpen(true)}
              onApplyCode={handleApplyAICode}
              onAgentFileWrite={handleAgentFileWrite}
              onAgentWorkspaceChange={handleAgentWorkspaceChange}
              onUndoAgentEdit={handleUndoAIEdit}
              onUndoAgentTask={handleUndoAgentTask}
              canUndoAgentEdit={aiEditHistory.length > 0}
              onWorkingChange={setIsAIWorking}
              projectSummary={projectSummary}
              settingsVersion={aiSettingsVersion}
            />
          }
          activityBar={
            <ActivityBar
              activePanel={activePanel}
              onPanelClick={handleActivityBarClick}
              isDark={isDark}
            />
          }
          sidebar={
            activePanel === 'search' ? (
              <WorkspaceSearch
                currentFolder={currentFolder}
                projectIndex={projectIndex}
                isIndexing={isIndexing}
                onOpenResult={handleOpenFilePath}
                isDark={isDark}
              />
            ) : activePanel === 'git' ? (
              <GitPanel
                currentFolder={currentFolder}
                isDark={isDark}
                setTerminalOutput={appendTerminalOutput}
              />
            ) : (
              <Sidebar
                currentFolder={currentFolder}
                fileTree={fileTree}
                projectIndex={projectIndex}
                onOpenFolder={handleOpenFolderClick}
                onFileClick={handleFileClick}
                activeFilePath={activeFilePath}
                onContextMenu={handleContextMenu}
                onRootAction={(action) => {
                  if (!currentFolder) return
                  const rootNode = { path: currentFolder, isDirectory: true, isRoot: true }
                  if (action === 'createFile') handleCreateFile(rootNode, false)
                  if (action === 'createFolder') handleCreateFile(rootNode, true)
                if (action === 'refresh') loadFolder(currentFolder, { rebuildIndex: true })
                if (action === 'closeWorkspace') handleCloseWorkspace()
                }}
                onMoveFile={handleMoveFile}
                onRunCommand={handleRunCommand}
                isDark={isDark}
              />
            )
          }
          tabs={
            <Tabs
              files={openFiles}
              activeFilePath={activeFilePath}
              onTabClick={setActiveFilePath}
              onTabClose={closeFile}
              onRun={handleRun}
              isDark={isDark}
            />
          }
          editor={
            activeFile ? (
              <Editor
                file={activeFile}
                revealLine={pendingReveal?.path === activeFile.path ? pendingReveal.lineNumber : null}
                revealKey={pendingReveal?.path === activeFile.path ? pendingReveal.key : null}
              />
            ) : (
              <WelcomeScreen
                currentFolder={currentFolder}
                projectIndex={projectIndex}
                isIndexing={isIndexing}
                onOpenFolder={handleOpenFolderClick}
                onQuickOpen={() => setIsQuickOpenOpen(true)}
                onWorkspaceSearch={openWorkspaceSearch}
                onCommandPalette={() => setIsCommandPaletteOpen(true)}
                onAIPanel={() => setIsAIPanelOpen(true)}
                isDark={isDark}
              />
            )
          }
          terminal={
            <Terminal
              output={terminalOutput}
              onClear={clearTerminalOutput}
              onRunCommand={handleTerminalInput}
              isDark={isDark}
              isOpen={isTerminalOpen}
              onToggle={() => setIsTerminalOpen(!isTerminalOpen)}
            />
          }
        />
      </div>

      <StatusBar 
        activeFile={activeFile}
        cursorPosition={cursorPosition}
        language={activeFile ? getLanguageFromFile(activeFile.name) : ''}
        markersCount={markers.length}
        indexedFileCount={projectIndex.length}
        isIndexing={isIndexing}
        isFocusMode={isFocusMode}
        isDark={isDark}
        toggleTheme={() => setIsDark(!isDark)}
        isAIPanelOpen={isAIPanelOpen}
        toggleAIPanel={() => setIsAIPanelOpen(!isAIPanelOpen)}
        isSidebarOpen={isSidebarOpen}
        toggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
        toggleFocusMode={toggleFocusMode}
        onOpenInBrowser={handleOpenInBrowser}
      />
    </div>
  )
}
