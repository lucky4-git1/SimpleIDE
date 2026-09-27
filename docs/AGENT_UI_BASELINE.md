# SimpleIDE — Agent UI Baseline Audit

## 1. Executive Summary
This document establishes the comprehensive technical and UX baseline of the existing SimpleIDE AI Agent interface prior to the Modern Agent UI redesign. SimpleIDE features a dual-mode AI interface (`assistant` and `autonomous agent`) integrated with the Prime AI backend (PrimeRouter, AgentRuntime, LLMRouter, MemoryManager, ToolRunner, and VerificationPipeline).

The objective is to redesign the agent interface into a modern developer command center and live execution workspace without modifying the underlying agent engine, LLM architecture, tool execution semantics, or FSM.

---

## 2. Component Inventory

### 2.1 Primary Containers & Controllers
| Component | Location | Role & Dependencies |
| :--- | :--- | :--- |
| **`AIPanel`** | `src/components/AIPanel.jsx` (1,677 LOC) | Monolithic component combining state management, chat persistence, agent run execution, streaming, tool approvals, diff previews, and rendering for both Assistant and Agent modes. |
| **`StreamingLog`** | `src/components/ui/StreamingLog.jsx` (80 LOC) | Scrollable container rendering live tool execution logs (`working`, `failed`, `complete`). |
| **`AISettingsModal`**| `src/components/AISettingsModal.jsx` (173 LOC)| Modal for provider selection (OpenAI, Anthropic, Gemini, Groq, Ollama, LM Studio), API key input, and model discovery. |
| **`SkillsModal`** | `src/components/SkillsModal.jsx` (290 LOC) | Modal for discovering, enabling/disabling, creating, and inspecting agent skills. |
| **`Layout`** | `src/components/Layout.jsx` | Houses the resizable right-hand panel wrapper (`.ai-panel-wrapper`), resizer handle, and working animation (`.ai-working`). |

### 2.2 Sub-Components Inside `AIPanel.jsx`
- **`MarkdownContent`**: Renders code blocks with copy/apply buttons and markdown text snippets.
- **`AgentStage`**: Renders stages (`inspect`, `edit`, `verify`) with icon, label, and status.
- **`WorkedBadge`**: Collapsible badge showing total duration and tool list.
- **`PlanProgressBadge`**: Pill showing plan title and message comment count.
- **`FileChangesBadge`**: Displays changed file count and `+add/-del` line counts with a Review button.
- **`StepDivider`**: Horizontal divider marking finished execution & verification phases.
- **`ApprovedPlanChecklist`**: Ordered checklist rendering step status (`complete`, `working`, `blocked`, `pending`).
- **`DiffPreview`**: Compact before/after line diff preview for applied code patches.

---

## 3. Current State Sources & Data Flow

### 3.1 Persistence & Memory
- **`memoryManager.conversations`**: SQLite-backed conversation store managing active chat ID, chat list, message history, and per-chat agent state snapshots (`agentRun`, `planDraft`, `lastChange`).
- **`memoryManager.projects`**: Workspace key-value memory store capturing facts across chats.
- **`aiService.getApiConfig()` / `saveApiConfig()`**: Reads and writes active AI provider, model, and encrypted/stored API keys.

### 3.2 Agent Runtime State & Events
When `runAgentTask` executes, it emits structured events through the `onEvent` callback:
- `state.transition`: FSM state transitions (`from`, `to`, `event`, `payload`).
- `state.error`: FSM runtime errors.
- `file.changed`: Dispatched when `write_file`, `replace_in_file`, etc., modify code.
- `status`: Diagnostic status messages (e.g. rolling summary compaction, retries).
- `thinking` / `thought`: High-level operational thoughts from the agent turn loop.
- `plan`: Plan updates emitted from the agent loop.
- `tool`: Invocation of tool with action name and arguments (`{ type, ...args }`).
- `observation`: Output or result returned by a completed tool execution.
- `verification.started`: Emitted before running project test/build verification checks.
- `prime_router.decided`: Emitted when the local Prime Router classifies intent and selects execution tier.
- `error`: Error messages from tools, invalid JSON, or provider failures.
- `SKILL_ACTIVATED` / `SKILL_CONFLICT`: Dynamic skill discovery and ranking notifications.

### 3.3 Synchronous Refs & Lifecycle Synchronization
`AIPanel.jsx` maintains mirrored refs (`activeChatIdRef`, `messagesRef`, `agentRunRef`, `planDraftRef`, `lastChangeRef`) to guarantee that asynchronous background agent tasks and debounced persistence writes route to the correct chat snapshot even if the user navigates between chats during execution.

---

## 4. UI Limitations of the Existing Interface

1. **Monolithic Complexity**: `AIPanel.jsx` has grown to 1,677 lines, coupling presentation, layout, and orchestration.
2. **Chat-Centric Visual Model**: The interface feels like a chatbot feed with disparate cards appended in sequence, rather than a cohesive developer command center.
3. **No Dedicated "Current Action" Focus**: The user cannot glance at the panel and instantly see the single dominant operation currently taking place (e.g., `CURRENTLY ⟳ Running test suite`).
4. **Unbounded / Giant Tool Dumps**: Long-running runs can accumulate dozens of tool logs in a long feed, creating visual clutter and layout jitter.
5. **Private Chain-of-Thought Leaks**: In assistant mode, `<details className="prime-chat-message__thinking">` renders raw reasoning traces. Modern coding agents must present concise operational summaries instead of raw reasoning dumps.
6. **Separated Information Hierarchy**: Plan progress, execution logs, file diffs, and verification results appear scattered across multiple independent badges and cards rather than an integrated timeline.
7. **Composer Ergonomics**: The composer lacks quick actions (Fix, Explain, Refactor, Test), multiline shortcuts, and clear execution state transitions.

---

## 5. Risky Areas & Critical Invariants

### 5.1 Functionality That MUST Remain Unchanged
1. **Agent Engine Semantics**: `runAgentTask`, `runAgentPlan`, `runSmartChat`, `ToolRunner`, `PrimeRouter`, and `VerificationManager` must remain untouched.
2. **Tool Execution & Safety Guards**: The interactive approval gate (`requestApproval`, `resolveApproval`) must continue to pause tool execution and resolve cleanly when approved or denied.
3. **Crash Recovery & Persistence**: The integration with `CrashRecoveryService` and SQLite `memoryManager` must continue to restore previous runs, drafts, and checkpoint states.
4. **Editor & Monaco Integrity**: The AI panel must never steal focus, block Monaco shortcut keybindings (`Ctrl+P`, `Ctrl+S`, `Ctrl+F`), or cause editor layout shifts or performance stutter.
5. **Terminal Independence**: The integrated terminal (`xterm.js`) must remain fully interactive and unaffected by agent activity.

---

## 6. Architecture of the Redesign (Phase Plan)

```
┌─────────────────────────────────────────────────────────────┐
│                    Existing Agent Engine                    │
│      (AgentRuntime, ToolRunner, PrimeRouter, Verification)  │
└──────────────────────────────┬──────────────────────────────┘
                               │ (events & callbacks)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     Agent UI Adapter                        │
│   (useAgentViewModel / normalized state: plan, activities,  │
│    currentAction, verification, changes, approvals, errors)  │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     Modern Agent UI                         │
│  - AgentWorkspace & AgentHeader (Task title, run status)    │
│  - AgentPlan (Interactive checklist backed by agent state)  │
│  - AgentCurrentAction (Dominant live action indicator)      │
│  - AgentTimeline & Activity Groups (Inspected, Changed)     │
│  - Expandable ToolCards & Verification Badges               │
│  - Modern Bottom Composer (States, Quick Actions, Tokens)   │
└─────────────────────────────────────────────────────────────┘
```
