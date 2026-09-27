import { 
  FolderOpen, File as FileIcon, Folder, ChevronRight, ChevronDown, FileText, FileJson, 
  FileCode, FileImage, TerminalSquare, FilePlus, FolderPlus, RefreshCw, Braces,
  Atom, Coffee, Database, FileType2, Globe2, Hash, Image as ImageIcon, Code2,
  Leaf, Package, Settings2, Terminal, Wind,
  Box, Play, Cpu, ChevronsDownUp, FolderX
} from 'lucide-react'
import { useState, useEffect, useCallback } from 'react'
import { getLanguageFromFile } from '../utils/language'
import { detectProjectType } from '../utils/projectDetector'

// Normalize path strings for reliable cross-platform Set matching
const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase()

const getFileIcon = (fileName) => {
  const extension = fileName.split('.').pop()?.toLowerCase()
  const props = { size: 15, className: 'shrink-0' }
  const map = {
    js: [Braces, 'text-yellow-300'], jsx: [Atom, 'text-cyan-300'],
    ts: [Braces, 'text-blue-400'], tsx: [Atom, 'text-blue-300'],
    html: [Code2, 'text-orange-400'], htm: [Code2, 'text-orange-400'],
    css: [Hash, 'text-blue-400'], scss: [Hash, 'text-pink-400'], sass: [Hash, 'text-pink-400'], less: [Hash, 'text-blue-300'],
    json: [Braces, 'text-yellow-400'], yaml: [Settings2, 'text-rose-300'], yml: [Settings2, 'text-rose-300'],
    md: [FileText, 'text-sky-300'], mdx: [FileText, 'text-sky-300'],
    py: [Code2, 'text-blue-300'], java: [Coffee, 'text-orange-400'],
    c: [FileCode, 'text-blue-400'], cpp: [FileCode, 'text-blue-400'], h: [FileCode, 'text-purple-300'], hpp: [FileCode, 'text-purple-300'],
    cs: [Hash, 'text-purple-400'], go: [Code2, 'text-cyan-300'], rs: [Code2, 'text-orange-300'],
    php: [FileType2, 'text-indigo-300'], rb: [FileCode, 'text-red-400'], swift: [Wind, 'text-orange-400'],
    sql: [Database, 'text-blue-300'], sh: [Terminal, 'text-green-300'], bash: [Terminal, 'text-green-300'], ps1: [Terminal, 'text-blue-300'],
    vue: [Leaf, 'text-emerald-400'], svelte: [FileCode, 'text-orange-400'],
    xml: [FileCode, 'text-orange-300'], svg: [ImageIcon, 'text-orange-400'],
    png: [ImageIcon, 'text-pink-400'], jpg: [ImageIcon, 'text-pink-400'], jpeg: [ImageIcon, 'text-pink-400'], gif: [ImageIcon, 'text-pink-400'], webp: [ImageIcon, 'text-pink-400'], ico: [ImageIcon, 'text-pink-400'],
    dockerfile: [Package, 'text-blue-400'], env: [Settings2, 'text-amber-300'], gitignore: [Settings2, 'text-orange-300']
  }
  const entry = map[fileName.toLowerCase()] || map[extension]
  if (!entry) return <FileIcon {...props} className="text-zinc-400 shrink-0" />
  const [Icon, color] = entry
  return <Icon {...props} className={`${color} shrink-0`} />
}

// Recursive File/Folder Node Component (VS Code style layout)
function FileNode({ 
  node, 
  level, 
  onFileClick, 
  activeFilePath, 
  onContextMenu, 
  onMoveFile, 
  isDark, 
  expandedPaths, 
  onToggleFolder,
  childrenCache
}) {
  const normalizedPath = norm(node.path)
  const isExpanded = expandedPaths.has(normalizedPath)
  const isSelected = norm(node.path) === norm(activeFilePath)
  const [isDragOver, setIsDragOver] = useState(false)
  const children = childrenCache[normalizedPath] || node.children || null

  const handleClick = (e) => {
    e.stopPropagation()
    if (node.isDirectory) {
      onToggleFolder(node.path)
    } else {
      onFileClick(node)
    }
  }

  const handleChevronClick = (e) => {
    e.stopPropagation()
    if (node.isDirectory) {
      onToggleFolder(node.path)
    }
  }

  const handleContextMenu = (e) => {
    e.preventDefault()
    e.stopPropagation()
    onContextMenu(e, node)
  }

  // Drag & Drop handlers
  const handleDragStart = (e) => {
    e.stopPropagation()
    e.dataTransfer.setData('text/plain', JSON.stringify({ path: node.path, name: node.name }))
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e) => {
    if (!node.isDirectory) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setIsDragOver(true)
  }

  const handleDragLeave = (e) => {
    e.stopPropagation()
    setIsDragOver(false)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    if (!node.isDirectory) return
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'))
      if (data.path !== node.path) {
        onMoveFile(data.path, data.name, node.path)
      }
    } catch (err) { /* ignore bad data */ }
  }

  return (
    <div>
      <div
        draggable={!node.isRoot}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`sidebar-item group flex items-center px-2 py-1 cursor-pointer select-none text-sm transition-colors ${
          isDragOver
            ? (isDark ? 'bg-blue-900/40 border-l-2 border-blue-400' : 'bg-blue-100 border-l-2 border-blue-500')
            : isSelected 
              ? (isDark ? 'active-file-highlight bg-[#37373d] text-white font-medium' : 'active-file-highlight bg-[#e4e6f1] text-black font-medium') 
              : (isDark ? 'text-[#cccccc] hover:bg-[#2a2d2e] border-l-2 border-transparent' : 'text-[#333333] hover:bg-[#e8e8e8] border-l-2 border-transparent')
        }`}
        style={{ paddingLeft: `${level * 12 + (isSelected ? 6 : 8)}px` }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        {/* Chevron on LEFT side of folder */}
        <span 
          onClick={handleChevronClick}
          className="w-4 h-4 mr-1 flex items-center justify-center text-zinc-400 hover:text-zinc-100 shrink-0"
        >
          {node.isDirectory ? (
            isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : null}
        </span>
        <span className="w-4 h-4 mr-1.5 flex items-center justify-center shrink-0">
          {node.isDirectory ? (
            isExpanded ? <FolderOpen size={14} className="text-blue-400" /> : <Folder size={14} className="text-blue-400" />
          ) : (
            getFileIcon(node.name)
          )}
        </span>
        <span className="truncate flex-1">{node.name}</span>
        {node.isDirectory && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity ml-auto shrink-0">
            <button 
              onClick={(e) => { e.stopPropagation(); onContextMenu(e, node, 'createFile'); }} 
              className={`p-0.5 rounded ${isDark ? 'hover:bg-[#3d3d40] text-zinc-400 hover:text-zinc-200' : 'hover:bg-[#d4d4d4] text-zinc-500 hover:text-zinc-800'}`} 
              title="New File..."
            >
              <FilePlus size={14} />
            </button>
            <button 
              onClick={(e) => { e.stopPropagation(); onContextMenu(e, node, 'createFolder'); }} 
              className={`p-0.5 rounded ${isDark ? 'hover:bg-[#3d3d40] text-zinc-400 hover:text-zinc-200' : 'hover:bg-[#d4d4d4] text-zinc-500 hover:text-zinc-800'}`} 
              title="New Folder..."
            >
              <FolderPlus size={14} />
            </button>
          </div>
        )}
      </div>
      {node.isDirectory && isExpanded && children && (
        <div>
          {children.map((child, index) => (
            <FileNode
              key={child.path || index}
              node={child}
              level={level + 1}
              onFileClick={onFileClick}
              activeFilePath={activeFilePath}
              onContextMenu={onContextMenu}
              onMoveFile={onMoveFile}
              isDark={isDark}
              expandedPaths={expandedPaths}
              onToggleFolder={onToggleFolder}
              childrenCache={childrenCache}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function Sidebar({ 
  currentFolder, fileTree, projectIndex = [], onOpenFolder, onFileClick, 
  activeFilePath, onContextMenu, onRootAction, onMoveFile, isDark, onRunCommand
}) {
  // Central set of normalized expanded folder paths (VS Code behavior)
  const [expandedPaths, setExpandedPaths] = useState(new Set())
  const [childrenCache, setChildrenCache] = useState({})
  const [isRootExpanded, setIsRootExpanded] = useState(true)
  const [showProjectInfo, setShowProjectInfo] = useState(true)

  const detectedProject = detectProjectType(fileTree, projectIndex)

  // Reset state when opening a new directory or refresh cache on tree update
  useEffect(() => {
    setExpandedPaths(new Set())
    setChildrenCache({})
    setIsRootExpanded(true)
  }, [currentFolder])

  useEffect(() => {
    setChildrenCache({})
  }, [fileTree])

  // VS Code Collapse Folders in Explorer action
  const handleCollapseAllFolders = useCallback((e) => {
    if (e) e.stopPropagation()
    setExpandedPaths(new Set())
  }, [])

  // Toggle folder expansion with normalized path matching
  const handleToggleFolder = useCallback(async (rawFolderPath) => {
    const targetPath = norm(rawFolderPath)
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(targetPath)) {
        // Collapse target folder and all nested child paths
        for (const p of next) {
          if (p === targetPath || p.startsWith(targetPath + '/')) {
            next.delete(p)
          }
        }
      } else {
        next.add(targetPath)
      }
      return next
    })

    // Lazy fetch directory children if unpopulated
    if (!childrenCache[targetPath]) {
      const result = await window.api.listFiles(rawFolderPath)
      if (result.success) {
        setChildrenCache((prev) => ({ ...prev, [targetPath]: result.children }))
      }
    }
  }, [childrenCache])

  const handleBgContextMenu = (e) => {
    e.preventDefault()
    if (currentFolder) {
      onContextMenu(e, { path: currentFolder, isDirectory: true, isRoot: true })
    }
  }

  const folderName = currentFolder ? currentFolder.split(/[/\\]/).pop() : ''

  return (
    <div 
      className={`flex flex-col h-full select-none ${isDark ? 'bg-[#252526]' : 'bg-[#f3f3f3]'}`}
      onContextMenu={handleBgContextMenu}
    >
      {/* Sidebar Top Title Bar */}
      <div className={`flex items-center justify-between px-3 py-2 border-b ${isDark ? 'border-[#333333]' : 'border-[#dddddd]'}`}>
        <span className={`text-xs font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>Explorer</span>
        {currentFolder && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => onRootAction('createFile')}
              className={`p-1 rounded transition-colors ${isDark ? 'text-zinc-400 hover:text-white hover:bg-[#3d3d40]' : 'text-zinc-600 hover:text-black hover:bg-[#d4d4d4]'}`}
              title="New File..."
            >
              <FilePlus size={14} />
            </button>
            <button
              onClick={() => onRootAction('createFolder')}
              className={`p-1 rounded transition-colors ${isDark ? 'text-zinc-400 hover:text-white hover:bg-[#3d3d40]' : 'text-zinc-600 hover:text-black hover:bg-[#d4d4d4]'}`}
              title="New Folder..."
            >
              <FolderPlus size={14} />
            </button>
            <button
              onClick={() => {
                setChildrenCache({})
                onRootAction('refresh')
              }}
              className={`p-1 rounded transition-colors ${isDark ? 'text-zinc-400 hover:text-white hover:bg-[#3d3d40]' : 'text-zinc-600 hover:text-black hover:bg-[#d4d4d4]'}`}
              title="Refresh Explorer"
            >
              <RefreshCw size={14} />
            </button>

            {/* VS Code "Collapse Folders in Explorer" Action */}
            <button
              onClick={handleCollapseAllFolders}
              className={`p-1 rounded transition-colors ${isDark ? 'text-zinc-400 hover:text-white hover:bg-[#3d3d40]' : 'text-zinc-600 hover:text-black hover:bg-[#d4d4d4]'}`}
              title="Collapse Folders in Explorer"
            >
              <ChevronsDownUp size={14} />
            </button>
            <button
              onClick={() => onRootAction('closeWorkspace')}
              className={`p-1 rounded transition-colors ${isDark ? 'text-zinc-400 hover:text-white hover:bg-[#3d3d40]' : 'text-zinc-600 hover:text-black hover:bg-[#d4d4d4]'}`}
              title="Close Workspace"
            >
              <FolderX size={14} />
            </button>
          </div>
        )}
      </div>

      {!currentFolder && (
        <div className="p-3">
          <button
            onClick={onOpenFolder}
            className="w-full flex items-center justify-center gap-2 bg-[#0e639c] hover:bg-[#1177bb] text-white px-3 py-1.5 rounded text-sm transition-colors shadow-sm"
          >
            <FolderOpen size={16} />
            Open Folder
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto overflow-x-hidden pb-4 custom-scrollbar">
        {currentFolder ? (
          <div className="mt-1">
            {/* Project Detection Info Badge */}
            <div className={`mx-2 mb-2 p-2 rounded border text-xs ${isDark ? 'bg-[#1e1e1e] border-[#333333] text-zinc-300' : 'bg-white border-zinc-200 text-zinc-800'}`}>
              <div 
                className="flex items-center justify-between cursor-pointer"
                onClick={() => setShowProjectInfo(!showProjectInfo)}
              >
                <div className="flex items-center gap-1.5 font-semibold text-blue-400">
                  <Box size={14} />
                  <span>{detectedProject.framework}</span>
                </div>
                <div className="flex items-center gap-1 text-[10px] opacity-75">
                  <Cpu size={12} />
                  <span>{detectedProject.language}</span>
                </div>
              </div>

              {showProjectInfo && (
                <div className="mt-2 pt-2 border-t border-white/5 space-y-1">
                  <div className="text-[11px] text-zinc-400 flex justify-between">
                    <span>Package Manager:</span>
                    <span className="font-mono text-zinc-200">{detectedProject.packageManager}</span>
                  </div>

                  {detectedProject.scripts.length > 0 && (
                    <div className="mt-1.5">
                      <div className="text-[10px] text-zinc-400 uppercase font-semibold mb-1">Detected Scripts:</div>
                      <div className="flex flex-wrap gap-1">
                        {detectedProject.scripts.slice(0, 4).map((script, idx) => (
                          <button
                            key={idx}
                            onClick={() => onRunCommand?.(`${detectedProject.packageManager === 'npm' ? 'npm run' : detectedProject.packageManager} ${script.name}`)}
                            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
                              isDark ? 'bg-[#2d2d30] hover:bg-[#007acc] text-zinc-300 hover:text-white' : 'bg-zinc-100 hover:bg-blue-500 text-zinc-700 hover:text-white'
                            }`}
                            title={script.cmd}
                          >
                            <Play size={10} />
                            {script.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Root Workspace Section Header with LEFT Chevron (VS Code style) */}
            <div 
              onClick={() => setIsRootExpanded(!isRootExpanded)}
              className={`group flex items-center justify-between px-2 py-1.5 text-xs font-bold uppercase tracking-wider cursor-pointer transition-colors ${
                isDark ? 'text-zinc-300 hover:bg-[#2a2d2e]' : 'text-zinc-700 hover:bg-[#e8e8e8]'
              }`}
            >
              <div className="flex items-center gap-1 min-w-0 truncate">
                {/* Chevron on LEFT side of workspace root folder */}
                <span className="w-4 h-4 flex items-center justify-center text-zinc-400 shrink-0">
                  {isRootExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
                <span className="truncate" title={currentFolder}>
                  {folderName}
                </span>
              </div>

              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                <button onClick={(e) => { e.stopPropagation(); onRootAction('createFile'); }} className={`p-0.5 rounded ${isDark ? 'hover:bg-[#3d3d40] text-zinc-300' : 'hover:bg-[#d4d4d4] text-zinc-600'}`} title="New File..."><FilePlus size={14} /></button>
                <button onClick={(e) => { e.stopPropagation(); onRootAction('createFolder'); }} className={`p-0.5 rounded ${isDark ? 'hover:bg-[#3d3d40] text-zinc-300' : 'hover:bg-[#d4d4d4] text-zinc-600'}`} title="New Folder..."><FolderPlus size={14} /></button>
                <button onClick={(e) => { e.stopPropagation(); setChildrenCache({}); onRootAction('refresh'); }} className={`p-0.5 rounded ${isDark ? 'hover:bg-[#3d3d40] text-zinc-300' : 'hover:bg-[#d4d4d4] text-zinc-600'}`} title="Refresh Explorer"><RefreshCw size={14} /></button>
                <button onClick={handleCollapseAllFolders} className={`p-0.5 rounded ${isDark ? 'hover:bg-[#3d3d40] text-zinc-300' : 'hover:bg-[#d4d4d4] text-zinc-600'}`} title="Collapse Folders in Explorer"><ChevronsDownUp size={14} /></button>
              </div>
            </div>

            {/* Tree Nodes List */}
            {isRootExpanded && fileTree.map((node, index) => (
              <FileNode
                key={node.path || index}
                node={node}
                level={0}
                onFileClick={onFileClick}
                activeFilePath={activeFilePath}
                onContextMenu={onContextMenu}
                onMoveFile={onMoveFile}
                isDark={isDark}
                expandedPaths={expandedPaths}
                onToggleFolder={handleToggleFolder}
                childrenCache={childrenCache}
              />
            ))}
          </div>
        ) : (
          <div className="px-4 py-8 text-center text-zinc-500 text-sm">
            No folder opened
          </div>
        )}
      </div>
    </div>
  )
}
