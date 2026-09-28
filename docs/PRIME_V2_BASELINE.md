# SimpleIDE — Prime Agent V2 Baseline Report

- **Date:** 2026-09-27
- **Branch:** `feat/prime-agent-v2`
- **Target Repository:** `https://github.com/lucky4-git1/SimpleIDE.git`

---

## 1. Environment & Runtime Versions

| Component | Version | Notes |
|---|---|---|
| **Node.js** | `v24.14.1` | Host runtime |
| **npm** | `11.11.0` | Package manager |
| **Electron** | `^41.10.2` | Desktop shell |
| **React** | `^19.2.5` | Renderer UI framework |
| **Vite** | `^8.1.5` | Bundler & dev server |
| **Better-SQLite3** | `^13.0.3` | Durable SQLite storage |
| **Monaco Editor** | `^4.7.0` | Code editor surface |
| **Zod** | `^3.24.2` | Schema validation |
| **OS** | Windows 11 / x64 | Target platform |

---

## 2. Baseline Health & Verification

### 2.1 Test Suite (`npm test`)
- **Status:** **PASS**
- **Suites:** 65
- **Tests:** 295 passing, 0 failing, 0 skipped, 0 cancelled
- **Duration:** 24.4s
- **Coverage:** Native tool calling, state machine transitions, bounded budgets, bounded checkpoints, context engine, database manager, rolling summarizer, code intelligence, run diagnostics.

### 2.2 Lint Suite (`npm run lint`)
- **Status:** **PRE-EXISTING FAILURES**
- **Problems:** 115 total (111 errors, 4 warnings)
- **Root Cause:** Pre-existing unused variables (`no-unused-vars`), missing globals (`Buffer`, `process` without node env declarations in certain files), empty catch blocks.
- **Classification:** Strictly pre-existing baseline; will be preserved and not regressed.

### 2.3 Build Suite (`npm run build`)
- **Status:** **PASS**
- Client bundle: `dist/assets/index-CqNXs08h.js` (1087 kB), `dist/index.html`
- Electron main bundle: `dist-electron/main.js` (61.2 kB) + auxiliary chunks
- Preload bundle: `dist-electron/preload.js` (7.16 kB)

---

## 3. Current Agent Architecture

```
User (Electron renderer, React)
  ├─ AIPanel.jsx (Assistant chat / Agent mode)
  ├─ AISettingsModal.jsx (Provider config, encrypted keys via safeStorage)
  └─ preload.js (contextBridge: api.*)
          │
          ▼ IPC
     Electron Main Process (main.js)
       ├─ ai.ipc.js (LLM provider requests via fetch)
       ├─ fs.ipc.js (Workspace file I/O)
       ├─ git.ipc.js (Git CLI / simple-git operations)
       ├─ process.ipc.js (Terminal / command execution)
       ├─ db.ipc.js (SQLite persistence)
       └─ skills.ipc.js (Skill registry persistence)

Agent Run Cycle (`runAgentTask` in `src/services/agentService.js`):
  1. WorkspaceScanner indexes workspace technologies and project files.
  2. AgentRuntime formal state machine initialized (IDLE -> PLANNING -> EXECUTING -> EVALUATING -> VERIFYING -> COMPLETED).
  3. Turn loop:
     - ContextEngine builds context package (retrieval + memory + observations).
     - LLMRouter formats provider payload (OpenAI, Anthropic, Gemini, Nvidia profiles).
     - Provider call routed through `ai-request` IPC.
     - NativeToolAdapter parses tool calls or falls back to legacy JSON.
     - ToolRunner executes validated actions via IPC.
     - ConsistencyEngine records evidence; FailureClassifier classifies errors.
     - VerificationManager runs test/build verification commands on completion.
     - RunCheckpoint creates resume points.
```

---

## 4. Key Architectural Limitations & Gaps Identified

1. **Unbounded History Growth:**
   `nativeMessages[]` accumulates all previous assistant messages, full tool responses, and reflection turns across the entire run without eviction or compaction. In 50–100 turn tasks, this causes prompt bloat, high latencies, and token exhaustion.
2. **Missing Local Decision Layer:**
   Every single routing decision, tool selection, or simple inspection query requires an external LLM round trip (often taking 2–15s over network).
3. **Renderer-Side Security Boundaries:**
   Workspace directory boundaries, command blocklists, and approval checks are enforced in renderer-side services, leaving the main process IPC fail-open.
4. **Tool Schema Bloat:**
   The entire catalog of ~30 tools is re-sent in every LLM request regardless of the task intent or current lifecycle phase.
5. **Transient Provider Failures:**
   No exponential backoff or jitter on transient HTTP 503/504 errors; single failure can abort the task.
6. **Orphan Processes:**
   Terminal commands and persistent background processes lack unified cancellation lifecycle management tied to the agent run.

---

## 5. Transition Path to Prime Agent V2

The transition introduces **Prime Router** as an internal CPU-first decision component powered by a specialized Laya foundation running via ONNX Runtime in the Electron main process.

Together with bounded context management (`RunLedger`, `MessageWindow`, `RollingSummarizer`, `Checkpoint V2`), main-process security enforcement, and tool schema minimization, SimpleIDE achieves rapid, autonomous, and cost-efficient agentic execution without requiring any user-facing model setup.
