# AI Agent Architecture Audit — Simple IDE ("Prime AI")

- **Audit date:** 2026-09-09
- **Repository / project:** Simple IDE (`E:\lucky\Documents\simple ide`), Electron + React desktop IDE with embedded "Prime AI" coding agent
- **Commit / hash:** UNKNOWN — working tree is not a git repository (no `.git`); version control history unavailable
- **Audit scope:** Full AI/agent system — orchestration, LLM routing, providers, tools, context, memory, persistence, IPC/security boundaries, streaming, errors, UI, tests, build status
- **Read-only status:** READ-ONLY AUDIT. No source, configuration, database, or dependency files were modified. The only artifact created is this report. Test suite was executed in a prior session of this engagement (161/161 passing); no tests were re-run for this report and no test run writes inside the repo (DB tests use `os.tmpdir()`).

---

## 0. Reconstructed architecture

### 0.1 High-level diagram (as implemented)

```
User (Electron renderer, React)
  ├─ AIPanel.jsx ── assistant chat ──► runSmartChat ──► requestAIStream ──► SSE stream
  │                └─ agent mode ──► runAgentPlan (plan) ──► user review ──► runAgentTask (execute)
  ├─ AISettingsModal ── provider/model/key ──► prime-ai-config.json (safeStorage-encrypted key)
  └─ preload.js (contextBridge "api") ── IPC ──► Electron main process
                                                  ├─ ai.ipc.js ──► fetch(provider endpoint) [network]
                                                  ├─ fs/git/process/db/skills.ipc.js ──► fs, shell, SQLite
                                                  └─ main.js ── Express :3000 preview, hidden browser agent

Agent turn (runAgentTask, src/services/agentService.js):
  WorkspaceScanner ──► scannerState ──► requiresVerification?
  SkillRegistry ──► skillContext (advisory text only)
  AgentRuntime (FSM: IDLE→PLANNING→EXECUTING→EVALUATING→[VERIFYING]→COMPLETED/FAILED/CANCELLED)
  Per turn:
    ContextEngine.buildContextPackage ──► PromptContextFormatter ──► dynamicContextStr
    buildSystemPrompt + buildUserPrompt ──► LLMRouter.routeRequest ──► requestAIText ──► ai-request IPC
    NativeToolAdapter.extractNativeToolCalls ──► executeAction ──► ToolRunner.run ──► IPC tool ──► observation
    ConsistencyEngine records evidence; FailureClassifier classifies failures
    finish ──► [VerificationManager.verify] ──► ChangeManager.commit ──► RunResult (+checkpoint iff max-turns)
```

Important side paths: legacy JSON-protocol fallback when native tool calls miss twice (`useNativeTools=false`); parallel batch execution for all-read-only native calls; `runAgentPlan` (single-shot planner); `askAI`/`autocompleteService` (non-agent LLM uses); CrashRecoveryService (unwired — imported but no caller found); BackgroundServices (stubs only).

### 0.2 End-to-end trace (agent task, real implementation)

| # | Stage | File : function | In → Out | Key state / failure modes |
|---|---|---|---|---|
| 1 | Task creation + plan gate | `AIPanel.jsx:sendAgentTask` | prompt → `planningRun` card | `planController` AbortController; failure: plan LLM error → `failed` card |
| 2 | Plan | `agentService.js:runAgentPlan` | task+context → Markdown plan (temp 0.1, 1200 tok) | No tools; failure: model error aborts before any change (safe) |
| 3 | Human review | `AIPanel.jsx` review card | plan → approved/edited plan (or `autoProceedPlan` skips) | Failure: skipped review executes blind |
| 4 | Run setup | `runAgentTask` | task+context+tools → runtime, scanner, runner, verifier, skills | `ensureAgentContextServices` re-indexes workspace per run (cost); skill conflicts emitted as events |
| 5 | Context assembly | `ContextEngine.buildContextPackage` + `PromptContextFormatter` + `buildUserPrompt` | workspace + observations[-16:] + memory → `executionPrompt` | Budget pack/dedup; failure: oversized prompt on huge repos (see §3) |
| 6 | Model request | `LLMRouter.routeRequest` → `requestAIText` → `ai-request` IPC → provider | payload+key → raw JSON | 2s client rate-limit; no timeout; no retry; failure → run FAILED |
| 7 | Tool decision | `NativeToolAdapter.extractNativeToolCalls` (or JSON fallback) | raw response → `ToolCall[]` | 2 text-misses → fallback protocol; invalid JSON → `continue` (burns a turn) |
| 8 | Approval gate | `executeAction` → `tools.requestApproval` (UI dialog) | tool+args → granted/denied | Single global resolver; no timeout; deny → "do not retry" observation, task continues |
| 9 | Tool execution | `ToolRunner.run` (validate → permission → failure-history → execute via IPC) | args → `{success, data\|error}` | 3-identical-failure block; MISSING_RUNTIME theory switch |
| 10 | Observation loop | `observations[]` + `globalContextEngine.addObservation` + reflection prompt | result → next turn's prompt | Unbounded in-run growth (see §3) |
| 11 | Verification | `VerificationManager.verify` (pattern-detected command) | code → pass/fail → repair loop | Only runs if project detected AND files written AND not review-gated |
| 12 | Completion | `commitTransaction` + `saveAgentMemory` + `RunResult` | changes → summary + optional checkpoint | Checkpoint ONLY on max-turns path; cancel/fatal return none |

---

## SECTION 1 — Architecture score: 6.5/10

- **Separation of concerns (7):** Genuine layering — `LLMRouter` (transport shape), `NativeToolAdapter` (protocol translation), `ToolRunner` (execution), `AgentRuntime` (lifecycle FSM), `ContextEngine` family (retrieval/budget/format), `ChangeManager` (undo), `VerificationManager` (proof), `FailureClassifier` (diagnosis). Each has a single, named responsibility. Deduction: `agentService.js` (~1470 lines) is a god-module orchestrator mixing prompting, loop control, persistence, and skill wiring.
- **Modularity / coupling (6):** Engine modules are import-clean (pure ESM, no Electron in `agentEngine/` except via injected `api`). Coupling hotspots: `agentService.js` imports ~15 modules; `AIPanel.jsx` (~1610 lines) mixes UI, orchestration callbacks, persistence flushing, and approval plumbing; `ToolRunner` reaches into `memoryManager` directly.
- **Cohesion (7):** High within modules (e.g. `AgentRuntime` is a textbook FSM; `ContextBudgetManager` does exactly one thing).
- **Extensibility (6):** Adding a provider = 1 endpoint line + catalog entry; adding a tool = 1 `reg()` call with Zod schema; adding a skill = DB row + keyword triggers. Deductions: no plugin interface, model-specific behavior required a bespoke profile map (just added for Ultra), verification is pattern-list based.
- **Testability (7):** Pure modules test well (161 tests, all passing). Deduction: Electron-bound `ai.ipc.js` needed helper extraction (`aiResponse.js`) to become testable; zero React/UI tests; no IPC-level tests.
- **Maintainability (6):** Consistent naming, good comments, but dead code (`sendPlanTask`, `DiffPreview`, `BackgroundServices` stubs, `Memory.js` stub), duplicated constants (blocklists in two files, `clip()` in two files), and prompt text scattered across `agentService.js`.
- **Provider/model/tool abstraction (6):** Good OpenAI-compatible default path + Anthropic/Gemini adapters; single Ultra profile exists. Deductions: capabilities are a static hand table (context windows, no per-model output/reasoning/tool metadata beyond one entry); `supportsReasoning` heuristic is substring matching; no capability-driven request shaping besides the Ultra profile.
- **State management (5):** Split-brain: React state + refs + zustand stores + `memoryManager` (localStorage) + SQLite, synchronized by debounced effects and manual flushes. Works but fragile (see UI audit: mid-stream routing, approval single-resolver, optimistic cancel cards).
- **Error boundaries (6):** Structured `RunResult`, classified provider errors, `FailureClassifier`, transactional undo log. Deductions: no circuit breaker on repeated model errors, invalid-JSON `continue` burns turns, renderer fully trusts main (see §7).

---

## SECTION 2 — General agent capabilities

| Capability | Status | Evidence | Limitations |
|---|---|---|---|
| Planning | Good | `runAgentPlan` (dedicated low-temp call) + human review/edit gate, `update_plan` tool, `ApprovedPlanChecklist` | Plan is Markdown text, not a machine-checked DAG; no plan-step state machine linkage |
| Coding / editing | Good | `write/create/edit/replace/move/rename` + exact-match + CRLF-tolerant edit, HTML deliverable validator | Single-occurrence edit only; no diff preview UI (`DiffPreview` dead); no multi-file atomic apply |
| File search | Good | `list/search_text/search_files/search_filename/read_files` (12-file batch) + `search-workspace` IPC | `search-workspace` IPC lacks path guard (security §7) |
| Repository understanding | Good | `WorkspaceScanner` (framework/lang/pm/build detection), `CodeIntelligenceService` (symbols/imports/deps), `ProjectIndexer`, file index | Re-index per run; symbol caps (8–10); keyword-based relevance |
| Terminal commands | Adequate | `run_command` (timeout clamp 1s–15min, 4MB buffer, cancel), `verify`, persistent processes | Approval/cancel gaps (UI audit); persistent processes survive cancel; blocklist narrow |
| Testing / verification | Adequate | `VerificationManager` (7 ecosystems), auto-verify gate on finish, repair loop | Runs only last detected check (`slice(-1)`); skipped in review mode; pattern-matched, not executed-proofed |
| Debugging | Adequate | Failure classification + strategy strings, repair states, reflection prompts, `BROWSER_CONSOLE_ERRORS` | No breakpoint/debugger integration; `BackgroundServices` diagnostics are stubs |
| Multi-step tasks | Good | 50-turn (100 approved) loop, reflection injection, 3× identical-action block, read-batch parallelism | No sub-agents; no task DAG; linear turn loop only |
| Tool calling | Good | ~30 Zod-validated tools, 3 protocols (native OpenAI/Anthropic/Gemini + JSON fallback), parallel read batch | Full ~20-schema array sent every turn (prompt bloat); fallback JSON is token-hungry |
| Model switching | Adequate | Settings + composer selector, live discovery, per-model profile map | Switch allowed mid-run with no abort/warning; no per-chat model pin; no mid-task test |
| Streaming | Good | SSE parse, `delta/thinking/done/error/cancelled`, reasoning-first support | Chat-only; agent turns are non-streaming; no mid-stream tool calls |
| Reasoning | Adequate | `reasoning_content` surfaced collapsed; Ultra profile (temp 1/top_p 0.95/16k) | Single-model profile; reasoning effort knobs rejected by hosted endpoint; no budget control |
| Cancellation | Adequate | AbortController plumbed loop-wide, approval auto-deny on cancel, optimistic UI | Child/persistent processes not killed; spinner relies on `finally`; late `finalizeRun` can overwrite cancel card |
| Error recovery | Good | Classifier + strategies, verification repair loop, rollback, checkpoints, crash reconciler | Reconciler unwired; checkpoints max-turns-only; no retry/backoff on provider errors |
| Autonomous execution | Good | Plan→approve→execute→verify→complete with guard FSM | `autoProceedPlan` can skip review; agent cannot ask mid-run questions (only blocking approvals) |
| Human approval | Adequate | Review-mode shell gating + destructive-tool gating + plan review | Single global resolver (overwrite leak), no timeout, renderer-side only (bypassable), narrow blocklist |
| Long-running tasks | Partial | 100 turns, checkpoints, resume-from-checkpoint, background chat folding | No sub-agents, unbounded `nativeMessages` growth, no summarization, no progress persistence mid-run |
| Context preservation | Adequate | SQLite + localStorage dual-write, per-chat agent snapshots, execution memory (8 entries) | Snapshots truncated; `_syncFromDbSync` drops agent state on cold load; no chat summarization |
| Task resumption | Adequate | Checkpoint (plan/files/observations/verification/runtime history) + manual resume | Manual only; cancel/fatal produce no checkpoint; no auto-resume; recovery service unwired |

---

## SECTION 3 — Context management deep audit — score 6/10

### Sources included
System prompt (`buildSystemPrompt`, role- and task-conditioned, very large for UI tasks), skill context (≤6000 chars, ≤3 skills), dynamic context package (task/active file/selection/open tabs/diagnostics/symbols/dependencies/lexical files/memory/tool observations), conversation history (chat: last 48 msgs×1200ch≤36k; agent: last 20×2000), execution memory (8 entries), workspace events (8), approved plan (≤12k), checkpoint (≤10k), `nativeMessages` full tool-result history, reflection prompts. NOT included: git state/branch (state field exists, never populated — `gitBranch:'main'` hardcoded default), developer instructions as a distinct channel (folded into system prompt), token counts, cost.

### Lifecycle
Created per turn via `buildContextPackage` (retrieval → observation compress → budget pack → format). Grows monotonically within a run: `observations[]` unbounded, `nativeMessages[]` unbounded (assistant msg + tool results + reflection user msg per tool call — the dominant growth vector), `actionAttempts` map. Pruning exists at packaging time only: observation compressor (high-importance + last 5 detailed, older → 1-line), chunk dedup, budget pack discard, prompt-level `slice(-16)` / `slice(-24)`. No summarization anywhere; no old-tool-result eviction from `nativeMessages`; no duplicate detection beyond chunk keys.

### Turn projections
- **5 turns:** healthy on all models.
- **20 turns:** native path carries ~20 assistant+tool exchanges + reflections; fine on 128k+ windows, pressure on small models.
- **50 turns (default cap):** `nativeMessages` alone can exceed 100+ messages with full tool outputs; budget pack protects the *retrieved* context but NOT `nativeMessages`, which bypasses the budget entirely. Long-context models cope; smaller ones degrade.
- **100 turns (approved tasks):** high risk of context exhaustion / cost blowout; termination relies solely on turn counter.

### Failure modes present
Stale information (no invalidation of earlier observations except file-change notices), oversized prompts on large repos (40 indexed files listed, 80-file prompt caps), token exhaustion (no pre-flight estimation of total payload), lost decisions (only 8 execution memories, 700-char results), contradictory state possible (observations append-only; a corrected file leaves both old and new observations).

### Token counting
Heuristic only: `estimateTokens = ceil(chars/3.8)` (`ContextChunk.js:24-28`); UI gauge uses chars/4 over a subset of sources. No tokenizer, no API usage surfacing (response `usage` is dropped by `extractResponse`).

---

## SECTION 4 — Memory

- **Short-term (in-run):** `observations[]`, `nativeMessages[]`, `actionAttempts`, `writtenFiles`, FSM history (200 cap). Lost on run end except via checkpoint/summary.
- **Conversation:** per-chat bubbles in SQLite `messages` + localStorage mirror; 400ms debounced persist + ref-flush on switch. Survives restart; in-flight stream content at risk inside the flush window.
- **Task:** `agent_runs`, `tasks`, `plan_steps`, `tool_executions`, `agent_events` in SQLite; per-chat agent card snapshot in localStorage only (tools≤100, text≤12k). Cold DB-only reload drops agent card (`_syncFromDbSync` resets to null) — localStorage is the real holder.
- **Project:** `project_memory` records (category-gated, confidence-weighted overwrite) + `workspace_state`. Cross-task learning is 8 capped summaries; no embeddings, no skill extraction.
- **Checkpoints/resume:** produced ONLY on max-turns; manual resume only; cancel/fatal produce none; recovery service exists but has no caller.
- **Survives:** model switch (config-level, history intact), app restart (chats, snapshots, runs, memory, skills), agent restart (same). **Lost:** in-flight streams, AbortControllers, pending approvals, FSM state (only terminal `agent_runs.state` persists), ContextEngine caches, unsaved plan-draft edits inside the debounce window.

---

## SECTION 5 — Agent loop

Observe→Think→Act→Observe→Evaluate→(Verify)→Finish, governed by a formal 11-state FSM (`AgentRuntime.js`) with guarded transitions — a genuine strength. Max turns 50 (100 approved). Termination: `finish` tool/text, post-write heuristic completion, max-turns (→checkpoint), cancel, fatal. Stuck-loop defenses: 3× identical-action block at two layers + `MISSING_RUNTIME` theory switch + invalid-JSON continue. Gaps: invalid JSON has no consecutive-failure counter (up to 100 wasted calls); reflection prompts bloat context; `PLAN_ERROR`/`FATAL_ERROR` collapse to FAILED with no retry; EVALUATING→EXECUTING via `MORE_ACTIONS` is modeled but the loop is really turn-driven, not event-driven; no per-turn time/token budget; parallel read batch is the only concurrency.

---

## SECTION 6 — Tools — score 7/10

Consistent interface (name/description/Zod schema/permission/category/execute → `{success, data, error}`), ~30 tools across READ/WRITE/DELETE/EXECUTE/NETWORK/GIT/BROWSER/MEMORY. Validation via Zod at every call; unknown tools get a guidance error, not a crash. Timeouts: `run_command` clamp (default 120s), `verify` 180s, web fetch 5–6s; file/git tools have none (bounded by IPC). Cancellation wired for commands, not for persistent processes. Context cost is the weak point: full schema array every turn + 12k-clipped outputs with no per-tool budget. Security: workspace `resolvePath` jail in-runner, but main-side IPC is fail-open (see §7). Notable design: `edit_file` single-occurrence enforcement, HTML deliverable refusal gate, ENOENT→create guidance (anti-loop), `update_plan` as a first-class progress tool.

---

## SECTION 7 — Command approval / security — score 4/10 (functionality) / 2/10 (as a boundary)

- Approval triggers: review mode → every `run_command`/`verify`/`start_process`; any mode → `APPROVAL`-permission tools (`delete_file`) via `AWAITING_USER_APPROVAL`; denials become "do not retry" observations (task continues, not aborted). No approval timeout; single global resolver (second approval orphans the first); approvals don't survive reload.
- "Approve" (autoApproveCommands, default ON) means only destructive ops pause; review mode means every shell op pauses. Approval is per-call, non-persistent.
- Sandboxing: NONE. No cwd jail (renderer-supplied cwd trusted), no shell allowlist, no container, `sandbox:false` on windows. Workspace jail is lexical `resolve()` + `isPathInWorkspace`, fail-open when unwatched, no symlink/`realpath` handling, TOCTOU.
- Secrets: at-rest encryption via `safeStorage` is good; renderer receives masked key; but renderer controls AI `endpoint` while main attaches the credential (key-exfil SSRF), chat-pasted secrets persist raw in SQLite (`messages.content`/`user_prompt` unredacted), hidden-browser action bypasses CORS to arbitrary URLs.
- Bypass: every approval/blocklist lives renderer-side; direct `window.api` calls skip all of it. Destructive patterns are narrow regexes with trivial bypasses (`rd /s`, arg-order variants, `git clean -fdx`, `reg delete`).
- Verdict: adequate safety rails for a cooperative single-user IDE; not a security boundary. Any XSS or malicious workspace content (e.g. a poisoned file the agent reads → prompt injection → `run_command`) inherits full user privileges.

---

## SECTION 8 — Model / provider architecture — score 6/10

One OpenAI-compatible core + Anthropic/Gemini shapes; 11 providers one line each; catalog + live `/models` discovery; single Ultra profile (temp 1/top_p 0.95/16k) applied centrally in `formatPayload`, covering chat/agent/plan. Capabilities are a static table with one corrected entry (Ultra 262144) and a substring `supportsReasoning` heuristic nothing consumes. Identical-treatment risks remain: all models share rate-limit (2s), error handling (now classified), retry policy (none), and tool-schema volume; context window drives retrieval budget and the UI gauge from hand-coded numbers; response `usage`/latency discarded. What should become metadata eventually: per-model output budgets, reasoning controls, tool-call support flags, TTFT class, host-specific parameter allowlists (the hosted-400 lesson), and rate/concurrency limits.

---

## SECTION 9 — Context + token economics — score 5/10

Biggest consumers, in order: (1) `nativeMessages` full tool-result history (unbudgeted — the runaway vector); (2) system prompt (very large on UI tasks — design brief + engineering lifecycle + positioning rules); (3) tool schemas every turn; (4) observations slice + verification dumps (12k clips); (5) retrieved file/symbol chunks (the ONLY budgeted stream); (6) conversation history slices; (7) reasoning tokens (invisible pre-fix). Controls present: chunk dedup, priority pack, observation compression, ubiquitous `clip()`. Missing: real token counting, pre-flight payload estimation, per-turn/total budgets, summarization, `nativeMessages` pruning, cost/latency surfacing.

---

## SECTION 10 — Streaming / reasoning — score 7/10

SSE parsing is correct (`data:` framing, `[DONE]`, keep-alive tolerance), five event types incl. `thinking`, empty-stream detection, cancel propagation both directions. Reasoning-first ordering verified against live captures; UI shows collapsed trace + Reasoning indicator. Gaps: streaming is chat-only (agent turns block on full responses — a 100-turn agent run is 100 non-stream round trips); no mid-stream tool calls; no TTFT watchdog (warn-only indicator exists in UI); no reconnection/resume; stream errors lose partial content (deltas aren't persisted until done).

---

## SECTION 11 — Error handling / reliability — score 6/10

Covered: 503/504/ResourceExhausted/empty-stream classified; rate-limit backpressure (throw-or-wait); validation errors with guidance; ENOENT anti-loops; verification repair loop; transactional undo; checkpoints; crash reconciler (unwired). Recoverable: tool failures, verification failures, invalid JSON, denials. Retryable (but not retried): provider 503/504, empty streams. Needs user: approvals, key config, persistent overload. Loses state: mid-stream content, FSM, pending approvals. Silent-failure risks: generic tool errors render as green `complete` (UI audit), `edit`-stage failures excluded from failure marking, fabricated badges (static 45/3 lines, `tools×4s` duration). No timeouts on AI calls (by design), no backoff, no circuit breaker.

---

## SECTION 12 — Observability — score 4/10

Present: request IDs (streams), task IDs, run state machines + histories persisted as agent events, tool execution logs, stage badges, context gauge (heuristic), verification records. Invisible: model latency, TTFT, token counts, cost, per-tool durations (faked in UI), system-prompt size, discarded context, skill selection rationale, retry counts, queue depth. Valuable later: real usage/latency capture per call, turn-level token ledger, budget-vs-actual gauge, provider health signal, structured run timeline export.

---

## SECTION 13 — Testing — score 7/10 (unit) / 3/10 (system)

161/161 passing (23 Ultra-focused). Strengths: FSM exhaustively tested (35), budget/pack/dedup/observation compression tested, rollback/commit tested, real temp-DB tests with redaction asserts, crash-recovery with mocks, native-protocol matrix across 3 providers. Gaps: no UI tests, no IPC tests, no streaming-socket tests, no model-switch/cancel/full-run-cancel tests, no fs-traversal tests, no network tests (all mocked), provider-pinned values will bit-rot, one vacuous placeholder test (`assert.ok(true)` for blocked commands), perf assertions are thresholds-only.

---

## SECTION 14 — Build / development status

- **Tests:** CONFIRMED passing (161/161, observed in-session; DB tests use `os.tmpdir`, cleaned up).
- **Lint:** CONFIRMED dirty — `npm run lint` → 105 problems (101 errors, mostly unused imports/vars across src and tests). No evidence of an enforced gate.
- **Types:** No TypeScript, no `tsconfig`, no JSDoc checking — CONFIRMED absent.
- **CI:** No `.github` workflows — CONFIRMED absent.
- **Build:** Electron-builder configured; `dist/` bundles present. Not rebuilt during audit (would modify files) — build health UNKNOWN beyond existing artifacts.
- **Runtime issues (confirmed by code):** zero-filled `src/App.v2.css` found and restored from backup during this engagement (pre-existing, unrelated to agent logic); dead `sendPlanTask`/`DiffPreview`; stub watchers; `Memory.js` deprecated stub still imported.
- **Duplication (confirmed):** blocklists (`agentService` + `ToolRunner`), `clip()` (`agentService` + `NativeToolAdapter`), model lists (catalog vs live merge).
- **Stale cache risk (suspected):** 24h model-list cache + `responseCache` (unbounded `Map` keyed by full prompt — memory growth + stale answers across model switches since key includes model, actually safe on switch; unbounded growth remains).

---

## SECTION 15 — Technical debt

| ID | Sev | Location | Problem → consequence |
|---|---|---|---|
| D1 | CRITICAL | `nativeMessages` unbounded in `runAgentTask` | Bypasses all budgeting → context exhaustion/cost blowout on long runs; needs sliding window + summarization |
| D2 | HIGH | Renderer-trusted IPC (`fs/process/git/ai/db/skills.ipc.js`) | Fail-open jail, SSRF-with-key, no main-side approval → XSS/prompt-injection inherits user privileges |
| D3 | HIGH | `agentService.js` god-module (~1470 lines) | Prompt text + loop + persistence + skills intertwined; change-risk center |
| D4 | HIGH | No summarization/compaction anywhere | Long tasks degrade; checkpoints carry raw slices, not distillations |
| D5 | MEDIUM | `ChangeManager.commit` is state-clear, not atomic | "Transactions" mislead; partial application + crash = unrecorded state; rollback misses moves/external edits |
| D6 | MEDIUM | Static capability table + substring reasoning detect | Next model needs code changes; no capability-driven shaping |
| D7 | MEDIUM | Single global approval resolver, no timeout | Overwrite leak, cross-chat bleed, reload hang |
| D8 | MEDIUM | `responseCache` unbounded; 24h model cache | Memory growth; stale model lists |
| D9 | MEDIUM | Dead code (`sendPlanTask`, `DiffPreview`, stubs, `Memory.js`) | Confuses maintainers; stubs log noise (`LintWatcher started`) |
| D10 | LOW | Duplicated blocklists/clips/catalogs | Drift risk (already diverged in comments) |
| D11 | LOW | Fabricated UI stats (45/3 lines, tools×4s) | Erodes trust in observability |
| D12 | LOW | Heuristic token math (÷3.8, ÷4) + discarded `usage` | Budgets approximate; real counts available but dropped |

---

## SECTION 16 — Scalability

Larger repos: file index + 40-file prompt caps + per-run re-index bound it, but retrieval is keyword/structural only — semantic growth will swamp precision. Larger context: pack/dedup help retrieval, but `nativeMessages` bypass makes 1M windows a liability, not an asset. More tools: linear prompt growth per turn (no tool retrieval/filtering). More turns: turn-counter termination only; no cost ceiling. More models/providers: one-line endpoint + table edits scale, but per-model quirks (the Ultra lesson) need the profile mechanism extended deliberately. Concurrent tasks: not supported (single `agentAbortRef`, `isLoading` gates). Expensive reasoning models: profile + thinking UI exist for one model; no budget control, no effort tiers, no cost display.

---

## SECTION 17 — Architecture maturity

| Dimension | Score | Rationale |
|---|---|---|
| Foundation | 7 | Real layering, clean module boundaries, consistent tool interface, FSM discipline |
| Agent intelligence | 6 | Plan-review-execute-verify loop with reflection and repair; no sub-agents, no self-distillation, prompt-heavy |
| Context management | 6 | Retrieval + budget + compress pipeline is real; unbounded message history and no summarization cap it |
| Tool architecture | 7 | Zod-validated registry, permissions, failure memory, undo log; gaps in timeouts/process lifecycle |
| Model architecture | 6 | Clean OpenAI-core abstraction + first profile; static tables, identical treatment elsewhere |
| Reliability | 6 | Classified errors, verification gate, rollback, checkpoints; unwired recovery, no retry/backoff/circuit-breaker |
| Security | 3 | Cooperative-user rails only; fail-open jail, renderer-side approvals, key-attach SSRF, no sandbox |
| Observability | 4 | Events/logs/stages persisted; latency/tokens/cost/budget invisible, some stats fabricated |
| Testing | 6 | Strong unit/FSM/rollback coverage, zero UI/IPC/e2e |
| Maintainability | 6 | Readable and consistent, weighed down by god-module, dead code, duplication |
| Production readiness | 5 | Single-user desktop scope: shippable with caveats; multi-user/hosted use: not defensible (security, cost controls) |

---

## SECTION 18 — Top 20 problems

| Rank | Problem | Severity | Impact | Evidence | Future recommendation |
|---|---|---|---|---|---|
| 1 | Unbounded `nativeMessages` bypasses budgeting | Critical | Context exhaustion, cost blowout on 50–100 turn runs | `agentService.js:762-916` pushes per tool call, never pruned | Sliding window + per-turn ledger + summarization |
| 2 | Renderer fully trusted by main (fail-open FS, shell, key-attach SSRF) | Critical | XSS/prompt-injection → full user compromise | `fs.ipc.js:46` guards, `pathSanitizer.js:8`, `ai.ipc.js:93-108`, `process.ipc.js` | Main-side allowlists, cwd jail, endpoint allowlist, realpath checks |
| 3 | No summarization/compaction | High | Long-task degradation; checkpoints carry raw slices | Absence across `agentEngine/`; `compressObservations` only shortens, never summarizes | Rolling summary + checkpoint distillation |
| 4 | Approvals renderer-side only, single resolver, no timeout | High | Bypassable safety; orphaned promises; cross-chat bleed | `agentService.js:445-516`, `AIPanel.jsx:700` | Main-side enforcement, per-run resolvers, timeouts |
| 5 | No retry/backoff/circuit-breaker on provider errors | High | Transient 503/504 fail runs outright | `aiService.js`, `ai.ipc.js` — none exist | Classified retry with budgets (manual exists) |
| 6 | Invalid-JSON `continue` with no consecutive-failure cap | High | Up to 100 wasted model calls on a confused model | `agentService.js:1111-1115` | Counter → re-rail prompt → fail after N |
| 7 | CrashRecoveryService unwired | Medium | Restarts lose in-flight work despite reconciler existing | Imported `agentService.js:15`, no caller | Wire to startup/chat-restore |
| 8 | Checkpoints max-turns-only | Medium | Cancel/fatal loses resumability | `runAgentTask` return paths | Checkpoint on every turn boundary (cheap) |
| 9 | Persistent processes survive cancellation | Medium | Orphaned dev servers; resource leak | `ToolRunner:456-477` vs `cancelTaskProcesses` scope | Track + kill task processes on cancel |
| 10 | `commitTransaction` is not atomic | Medium | Partial-apply + crash = inconsistent undo | `ChangeManager.js:69-77` | Two-phase record + fsync journaling or honest rename |
| 11 | Static capability table; substring reasoning detect | Medium | Every new model needs code edits; misclassification risk | `LLMRouter.js:1-50` | Capability registry + validation tests |
| 12 | Token math heuristic; `usage` discarded | Medium | Budgets approximate; no cost control | `ContextChunk.js:24`, `extractResponse` | Capture usage per call; ledger + gauge |
| 13 | Tool schemas sent in full every turn | Medium | Prompt bloat; slower TTFT (measured +14s with tools on Ultra) | `formatToolsForProvider`, agent payload | Tool retrieval / minimal schemas per turn |
| 14 | `responseCache` unbounded; 24h model cache | Medium | Memory growth; stale lists | `aiService.js:15,127` | LRU + TTL + invalidation on switch |
| 15 | Silent-failure rendering (green complete on generic errors) | Medium | Users trust failed work | UI audit items 4, 11 | Failure detection on status, not message regex |
| 16 | Zero UI/IPC/e2e tests | Medium | Refactors blind; IPC regressions undetected | tests/ inventory | Harness for IPC handlers with mocked electron |
| 17 | God-module `agentService.js` + dead code | Low-Med | Change risk; onboarding cost | ~1470 lines; dead paths listed §14 | Extract prompting/loop/persistence |
| 18 | Fabricated stats in UI | Low-Med | Trust erosion | `FileChangesBadge:1448`, `WorkedBadge:1444` | Real durations/diffs or remove |
| 19 | Skills advisory-only, keyword-matched | Low | Low leverage of skills investment | `SkillSelector.js:5-25`, 6k/3-cap | Usage-feedback loop, injection tests |
| 20 | Dev-only fragility (zeroed CSS incident, no CI, dirty lint) | Low | Silent breakage ships | §14 | CI with tests+lint+build gates |

---

## SECTION 19 — Top 20 strengths

1. Formal agent lifecycle FSM with guarded transitions and persisted history.
2. Plan-then-review-then-execute with human-editable plans — correct autonomy boundary.
3. Zod-validated, permission-tagged, consistently-shaped tool registry (~30 tools).
4. Retrieval → compress → budget-pack → format context pipeline (dedup + priority + discard accounting).
5. Failure classification with actionable strategies fed back into the loop.
6. Verification gate with ecosystem-aware command detection and repair loop.
7. Transactional undo log with per-change before/after (incl. DB persistence).
8. Dual-write chat/agent persistence (SQLite + localStorage) with cross-chat stream routing.
9. Checkpoints with manual resume that actually re-injects state into the prompt.
10. Three LLM protocols (native OpenAI/Anthropic/Gemini + JSON fallback) with graceful degradation.
11. First model profile (Ultra) proving the per-model shaping mechanism works.
12. Reasoning-stream support with collapsed-trace UI and empty-stream detection.
13. Classified provider errors preserving original messages.
14. Identical-action loop guards at two independent layers.
15. ENOENT→create guidance and single-occurrence edit enforcement (anti-loop by construction).
16. Deliverable validation (standalone-HTML inspector) enforced before completion.
17. Skill system with validation, conflicts, workspace scoping, usage tracking.
18. Cancellation plumbed through loop, tools, LLM fetch, and approval dialogs.
19. 161 passing tests incl. FSM exhaustiveness, rollback proofs, redaction asserts.
20. Security-conscious at rest (safeStorage key encryption, DB secret redaction) even if boundaries are thin.

---

## SECTION 20 — What to build next (no implementation)

### P0 — Critical
- Bound `nativeMessages` (sliding window + summarization) with a per-run token ledger and cost ceiling.
- Main-side enforcement: FS jail that can't fail open, endpoint allowlist for key-attached fetches, cwd jail for shell IPC.
- Provider-error retry with classified budgets + circuit breaker (keep manual retry as fallback).

### P1 — High value
- Rolling summarization + checkpoint-on-turn-boundary + wire CrashRecoveryService to startup.
- Capability registry replacing the static table (windows, budgets, reasoning/tool/streaming flags, host param allowlists).
- Capture per-call `usage`/latency/TTFT; real budget gauge; run timeline export.
- IPC test harness (mocked electron) + UI smoke tests + fs-traversal tests.

### P2 — Important improvements
- Split `agentService.js` (prompts / loop / persistence); remove dead code; fix fabricated stats; per-run approval resolvers with timeouts.
- Tool-schema minimization per turn; kill task processes on cancel; atomic-ish commit semantics.
- Consecutive-invalid-JSON cap with re-rail prompt; model-switch mid-run guard (abort-or-confirm + per-chat pin).

### P3 — Nice to have
- Sub-agent delegation for parallel read-only work; semantic retrieval option; skill effectiveness feedback; background-run progress persistence; LRU caches; CI gates (tests+lint+build).

---

## SECTION 21 — Ideal target architecture

```
Current: UI-coupled orchestrator → turn loop → full-history prompts → static model table
   ↓ (keep: FSM, tool registry, verification, persistence stores, IPC channels, UI flows)
Target:
  UI (thinner: renders run timeline events, no orchestration state)
   ↓ event bus (typed run events; timeline is the source of truth for progress UI)
  AgentController (extracted from agentService: loop policy, budgets, circuit breaker)
   ↓
  Planner (plan DAG w/ verifiable steps) + ContextService (retrieve→rank→budget→SUMMARIZE→ledger)
   ↓
  CapabilityRegistry (per-model: windows, budgets, reasoning/tool/streaming flags, host param allowlists)
   ↓
  ProviderGateway (timeout/TTFT policy per class, classified retry, usage+latency capture)
   ↓ Models
  ToolRuntime (execution sandbox policy, per-tool budgets, process lifecycle ownership)
  PolicyEnforcer (MAIN side: FS jail, endpoint allowlist, approval ledger) ← renders renderer-trust explicit
  StateStore (SQLite as truth; localStorage as cache with schema versions; checkpoints per turn)
```

Keep: `AgentRuntime`, `ToolRunner` core, `VerificationManager`, `FailureClassifier`, `ContextEngine` retrieval/pack, DB schema, all UI flows. Introduce: controller/ledger/policy boundaries, summarizer, gateway, event bus.

---

## SECTION 22 — Audit confidence

- **HIGH:** agent loop mechanics, tool interface/validation, FSM behavior, context pipeline stages, persistence stores and caps, provider payload construction, streaming event flow, error classification, test inventory/results, lint status, dead code, IPC channel inventory, approval flow mechanics, Ultra/Lightning measured behavior (live diagnostics earlier in this engagement: 28–56s vs 0.6–2.3s TTFT, live 503, hosted-400 on thinking knobs).
- **MEDIUM:** security exploitability specifics (no PoC run — symlink escape, renderer compromise paths are code-evident but unexecuted), long-run degradation curves (projected from unbounded structures, not observed over 100 turns), cost/token magnitudes (heuristic math only).
- **LOW:** production build health (not rebuilt — would modify files), real-world provider behavior variance, multi-workspace concurrency effects.
- **Could not inspect:** git history (no repo), runtime profiling, actual user traffic, NVIDIA gateway internals/deadlines, packaged-app behavior vs dev.

---

## Final executive assessment

1. **Overall score: 6/10**
2. **Architecture maturity: 6/10**
3. **Agent capability: 6/10**
4. **Context management: 6/10**
5. **Reliability: 6/10**
6. **Security: 3/10**
7. **Production readiness: 5/10** (single-user desktop: yes with caveats; anything multi-user/hosted: no)

### Biggest strength
The plan-gated, FSM-governed agent loop with verification-before-complete — the autonomy boundary and lifecycle discipline are genuinely well designed, and the tool/context/persistence machinery around it is real, tested, and coherent.

### Biggest weakness
Context economics: the single unbudgeted structure (`nativeMessages`) undermines an otherwise sound budgeting pipeline, and there is no summarization, ledger, or cost ceiling anywhere.

### Biggest architectural risk
Renderer-trusted IPC with fail-open filesystem jail and no sandboxing — one XSS or prompt-injection-to-shell incident inherits full user privileges with no main-side backstop.

### Biggest context-management risk
Unbounded in-run message history combined with turn-counter-only termination: 100-turn approved runs on long-context models can silently accumulate massive, expensive, degradation-prone prompts.

### Biggest reliability risk
No retry/backoff/circuit-breaker on classified provider errors plus unwired crash recovery: transient provider failures fail runs outright and restarts abandon in-flight work the system already knows how to reconcile.

### Most valuable improvement
Bounded, ledgered, summarized context (P0 #1): one change that simultaneously cuts cost, raises long-task success, and makes every downstream budget meaningful.

### Most dangerous technical debt
D2 (renderer-trust) — a latent compromise path, not a visible bug; and D1 (unbounded history) — a certain cost/quality failure at scale.

### Recommended next architectural milestone
**"Bounded runs":** per-run token ledger + `nativeMessages` window/summary + turn-level checkpoints + classified retry budgets + usage/latency capture. It converts the two biggest risks (context, reliability) into measurable, enforceable properties without restructuring the agent.

---

AUDIT COMPLETE — NO PROJECT SOURCE/configuration FILES WERE MODIFIED.
