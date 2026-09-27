# Bounded Runs Architecture Plan — Simple IDE ("Prime AI")

- **Date:** 2026-09-09
- **Scope:** Design-only. Bound per-run growth of context, tokens, cost, tool output, retries, and state without changing agent semantics.
- **Status:** ARCHITECTURE DESIGN ONLY — no source, configuration, or dependency files were modified or created (this report excepted). No implementation code in this document.
- **Must preserve:** Agent FSM (`AgentRuntime.js`), plan → review → execute → verify lifecycle, `ToolRunner`, `ContextEngine` retrieval/packing, `VerificationManager`, `FailureClassifier`, persistence/checkpoints, tool registry, existing UI flows.

---

## 1. Executive summary

An agent run today terminates on turn count (50/100) while its dominant context structure — `nativeMessages`, the full provider message history including every tool result — grows without bound and bypasses every budget in the system. The fix is a **bounded-run layer** added alongside the existing loop, not a rewrite: (a) a per-run token **ledger** that measures every model call; (b) a **bounded message window** (recent turns + rolling summary + immutable facts + current task state) replacing unbounded history; (c) **rolling summarization** reusing the existing observation compressor's slot; (d) **per-turn and per-run budgets** with staged degradation; (e) **tool-result lifecycle classes** so one huge output can't dominate 20 turns; (f) **checkpoint integration** so resume reconstructs bounded — not restored-unbounded — context; (g) ledger-backed observability in existing UI surfaces. Six phases, each independently shippable and rollback-safe, ordered so measurement precedes enforcement.

---

## 2. Current context architecture

Per turn, `runAgentTask` (`src/services/agentService.js:558`) builds two prompt channels:

1. **Retrieved channel (budgeted):** `ContextEngine.buildContextPackage` (`ContextEngine.js:107-157`) → pipeline retrieves chunks → `observationManager.compressObservations()` → `ContextBudgetManager.packChunks()` (dedup + priority rank + fill-to-`availableTokens`) → `PromptContextFormatter.formatPromptContext` → `dynamicContextStr`, embedded in `buildUserPrompt` alongside `observations.slice(-16)`, memory slices, approved plan (≤12k), checkpoint (≤10k).
2. **History channel (unbudgeted):** `nativeMessages[]` — initial system+user messages (`agentService.js:762-764`), then per tool call: assistant message (`801`, `899`), tool-result messages (`855`, `899`), and a reflection user message (`902-916`) — sent as `messages` in `requestAIText` (`LLMRouter.routeRequest`), which passes them straight into the payload.

Token math is heuristic everywhere (`estimateTokens = ceil(chars/3.8)`, `ContextChunk.js:24-28`; UI gauge chars/4). Provider `usage` fields are dropped by `extractResponse` (`LLMRouter.js:156-165`) — confirmed by grep: no `prompt_tokens`/`completion_tokens` handling exists in `src/`. No summarization exists anywhere (grep confirms only intent-keyword and skill-workflow mentions).

---

## 3. Current growth vectors

| Structure | Location | Owner | Lifecycle | Growth | Limit today | In budgeting? | Persisted? | Summarizable? | Discardable? |
|---|---|---|---|---|---|---|---|---|---|
| `nativeMessages[]` | `agentService.js` run scope | `runAgentTask` | per run, never pruned | +2–4 msgs per tool call (assistant, tool results, reflection) | NONE | NO — bypasses `ContextBudgetManager` entirely | Partially (checkpoint embeds no messages; runtime history only) | Yes — via rolling summary | Selectively (see §7) |
| `observations[]` | `runAgentTask` run scope | `runAgentTask` | per run, append-only | +1–3 per tool call/verification/error | NONE in-run | Partially (`slice(-16)` at prompt build; compressor at packaging) | Tail (−24×1800ch) in checkpoint | Yes | Old non-error entries, yes |
| `actionAttempts` Map | run scope | `runAgentTask` | per run | +1 per distinct action fingerprint | NONE | N/A (not sent) | No | No need | Yes at run end |
| `writtenFiles` Set | run scope | `runAgentTask` | per run | +1 per changed file | NONE | N/A | Yes (checkpoint + file_changes table) | No — factual | No |
| Runtime history | `AgentRuntime` | run scope | per run | +1–3 per turn | 200 (`MAX_HISTORY`) | N/A | Tail (−80) in checkpoint | Yes | Old transitions, yes |
| `responseCache` Map | `aiService.js:15` module scope | global | app lifetime | +1 per unique non-raw request | NONE (unbounded) | N/A | No | N/A | Yes (LRU needed) |
| Tool schemas | per payload | `LLMRouter.formatPayload` | per call | static size, sent every turn | NONE | NO | No | No — needed for function calling | Only via per-turn tool filtering (future) |
| Chat `messages[]` (UI) | `AIPanel.jsx` | renderer | per chat, unbounded | +2 per exchange | NONE | NO (slices at send: 1000ch/48 msgs chat; 2000/900ch agent) | Yes (SQLite + localStorage) | No mechanism exists | Oldest-first with summary (future) |

Primary termination boundary today: turn counter (50 default, 100 approved). No token, cost, time, or size boundary exists.

---

## 4. Root cause

Budgeting was built for the **retrieval** channel (`ContextBudgetManager.packChunks`), but the agent's dominant channel — provider message history — was added later with the native-tool path and never connected to any budget. Two channels, one governor. Contributing causes: provider `usage` discarded at the extraction layer; no summarizer component (only a shortener, `compressObservations`); checkpoints snapshot raw slices rather than distillations, so resume re-inflates; termination policy counts turns instead of measuring consumption.

---

## 5. Target bounded-run architecture

```
runAgentTask (unchanged signature & FSM wiring)
  ├─ NEW: RunLedger (per run; §6) — measures every LLM call (est. pre-call, actual post-call)
  ├─ ContextEngine (unchanged retrieval/pack) + budget inputs now ledger-aware (§9)
  ├─ NEW: MessageWindow (owns nativeMessages; §7) — window + summary + facts + task state
  ├─ NEW: RollingSummarizer (uses one extra model call per COMPACTION_INTERVAL turns; §8)
  ├─ ToolRunner (unchanged interface) + result lifecycle tags (§10)
  ├─ Budgets: per-turn + per-run with staged degradation (§9)
  ├─ Checkpoints v2: summary + ledger + facts, never raw history (§11)
  └─ UI: existing surfaces show ledger numbers (gauge upgrade, timeline) — no new screens
```

New code lives in two new modules (`RunLedger.js`, `MessageWindow.js` incl. summarizer) plus narrow hooks in `agentService.js` (measure, compact, enforce), `LLMRouter.js` (capture `usage`), and checkpoint schema (additive fields). `AgentRuntime`, tools, verification, classifier, persistence, and UI flows are untouched in behavior.

---

## 6. Context ledger design

**What it tracks per run:** estimated input tokens (pre-call, heuristic), actual input/output/reasoning tokens (post-call from provider `usage` when present: `prompt_tokens`, `completion_tokens`, `completion_tokens_details.reasoning_tokens`), tool-result token share, retrieval-channel share, system-prompt share, cumulative totals, estimated cost (per-model price table, static config, UNKNOWN until filled), model id, context window, remaining budget, compaction count, turn count.

**Where it lives:** new `src/services/agentEngine/RunLedger.js`, instantiated per `runAgentTask` (like `AgentRuntime`), owned by the run scope. Persisted per turn-boundary into the existing `agent_events` table as `LEDGER_SNAPSHOT` payloads (no schema change) and into checkpoints (additive fields). Survives resume by rehydration.

**Interactions:**
- `LLMRouter.routeRequest` returns `{ data, usage }` internally (extract `usage` alongside content; `returnRaw` path already preserves it) → `requestAIText` records pre-call estimate + post-call actuals into the run's ledger via a callback passed through `requestArgs` (additive optional field; existing callers unaffected).
- `ContextEngine.buildContextPackage` accepts an optional `tokenCeiling` from the ledger so retrieval shrinks as the run consumes (staged degradation input).
- `AgentController` (the existing `runAgentTask` loop, not a new abstraction) consults `ledger.shouldDegrade()` / `ledger.isExhausted()` at turn top — the enforcement points for §9.
- Estimated vs actual reconciliation: ledger stores both; when provider usage is absent, actuals fall back to estimates flagged `estimated:true` so downstream policy knows its confidence.

---

## 7. nativeMessages boundary design (core)

Target composition per model call: `[system] + [rolling summary (1 msg)] + [immutable facts (≤K msgs)] + [recent window (last N turns, tools included)] + [current user turn]`.

- **What stays verbatim:** system prompt; the current turn's user content; the most recent N turns of assistant/tool exchanges (default N=6 turns, tuned per window class in §9); all `finish`-adjacent messages once finish is requested (never compact the closing sequence).
- **What gets summarized:** tool exchanges older than the window, including their results, reasoning traces, and reflection prompts (reflections are regenerable scaffolding — always summarized, never retained verbatim).
- **What becomes immutable facts:** task objective, approved plan hash + milestones, file paths created/modified (from `writtenFiles`), verification commands + outcomes, user decisions/denials, blocked-theory findings (`MISSING_RUNTIME` etc.). Facts are append-only, small, and compaction-proof; sourced from structures that already exist.
- **What gets discarded:** duplicate observations, superseded file contents (only latest version referenced), keep-alive/empty deltas, redundant read batches of unchanged files.
- **When compaction occurs:** at turn boundaries when `ledger.historyShare > WINDOW_TRIGGER` (default 60% of per-model history allowance) or every `COMPACTION_INTERVAL` turns (default 10), whichever first; never mid-tool-batch, never after finish requested.
- **Tool results:** recent-window results stay verbatim; older results are replaced by their observation summaries (already produced by `compressObservations`); results flagged important (verification output, error evidence, user-visible artifacts) are pinned as facts or kept one extra window.
- **Reasoning:** reasoning text is never re-sent as history (providers that need it manage their own server-side context); its conclusions enter facts/summary only. (Superseded by the capability-driven `reasoningHistoryPolicy` in §21.B.)
- **Errors/decisions:** all failures stay as compressed observations (high importance already); denials and strategy pivots become facts.

This is principled — recency for actionability, summary for continuity, facts for correctness — not truncation.

---

## 8. Rolling summarization design

**Summary schema (fixed, versioned):** objective, requirements, decisions[], filesChanged[], filesInspected[], discoveries[], constraints[], failedApproaches[], workingApproaches[], planState (milestones + status), openIssues[], lastVerification, keyOutputs (small, quoted), turnRange covered, priorSummaryHash (chain for audit).

**Generation:** one focused model call (`temperature 0`, small max tokens, strict JSON schema mirroring the fixed structure) over: previous summary + window-older exchanges + facts. Frequency bounded by `COMPACTION_INTERVAL`/trigger above — at most ~10 calls per 100-turn run (≤10% overhead; see §14).

**Replace vs supplement:** summaries REPLACE compacted exchanges in `nativeMessages` (single summary message) while the raw exchanges remain in run-local `observations[]` until run end (debuggability without prompt cost). Facts supplement both.

**Validation:** schema-validate the summary (reject + retry once with repair prompt, else keep previous summary and widen window by one interval — fail-safe toward more context, never less); invariant checks: filesChanged ⊆ `writtenFiles`, no dropped openIssues (new summary must carry forward unresolved items — asserted in tests); summary token size cap (oversize → re-summarize the summary).

---

## 9. Token budget design

Two budgets, both derived from model window class (small ≤32k / standard ≤128k / large ≥256k, resolved via the capability interface in §13). (Superseded by the five-budget taxonomy in §21.A; window classes are retained for per-request sizing only and must never be treated as lifetime run allowances.):

- **Per-turn budget:** caps a single model call's input (retrieval ceiling + history window + system). Breach → shrink retrieval first, then narrow window (never below N=2), then fail the turn safely (not the run).
- **Per-run budget:** caps cumulative actuals (default: 70% of window for history+retrieval across the run, reserving headroom for the closing sequence). Staged behavior — calibrated, not the placeholder ladder: **≤60%** normal; **60–80%** compress (force observation compression + narrow retrieval); **80–90%** summarize-and-pin (compaction mandatory, facts pinned, new tool batches limited to reads); **90–100%** conservative mode (read-only tools + finish-oriented prompting; writes require explicit user confirmation via existing approval); **100%** stop-as-incomplete with checkpoint (reuse the max-turns incomplete path and resume affordance — no new terminal state needed).

Near-exhaustion UX reuses existing surfaces: gauge shows ledger actuals, agent card gets a budget stage line, no new screens.

---

## 10. Tool-result lifecycle

Classes: **ephemeral** (keep-alive, empty deltas — never stored), **recent** (in-window, verbatim), **important** (verification output, error evidence, user-requested artifacts — pinned one extra window or as facts), **summarized** (older results → observation summaries), **persistent** (file-change records → `ChangeManager`/DB, not prompts), **discardable** (superseded reads, duplicate searches).

Anti-domination rule: any single tool result exceeding `RESULT_PIN_CAP` (default 4k tokens, i.e. today's clip scale made explicit) is stored full in observations/DB but enters `nativeMessages` only as summary + pointer (`[truncated: N chars retained in run log]`); the full text remains one explicit `read`-equivalent away. Not every tool result stays in `nativeMessages` — only recent + important.

Tool schemas (the other consumer): out of this phase's scope beyond documenting the cost; per-turn tool filtering is a named follow-up, explicitly not in the migration plan.

---

## 11. Checkpoint integration

Checkpoints occur today only on max-turns; add turn-boundary snapshots (cheap: summary + ledger + facts already in memory — no extra model call) while keeping the existing max-turns payload shape backward compatible (additive `v2` fields: `ledger`, `summary`, `facts`, `windowState`).

Persisted: summary, ledger snapshot, facts, `writtenFiles`, verification state, plan/todos, runtime history tail. Explicitly NOT persisted: raw `nativeMessages`, full observations (tail only, as today).

Resume reconstructs: `[system] + [summary] + [facts] + [empty window]` and continues — bounded by construction, never restored-unbounded. After app restart, rehydrate from SQLite + localStorage exactly as today; ledger resumes from its last snapshot with estimates flagged until the next actual usage arrives; `runId` continuity preserved so event timelines stay coherent.

---

## 12. Model capability requirements (interface only — not implemented here)

Bounded runs need, per model: `contextWindowTokens` (exists, extend accuracy), `maxOutputTokens` (exists as static; needs per-model truth), `reasoningClass` (none/light/heavy + whether reasoning tokens bill against output), `toolSupport` (native/streaming/JSON-fallback), `streamingSupport`, `outputBudget` (recommended maxTokens ceiling), `hostConstraints` (parameter allow/blocklist per host — the Ultra-400 lesson), `pricePerMTok` (in/out, for cost), `ttftClass` (for progress policy). Interface: extend `getModelCapabilities` return shape (additive fields) + extend `MODEL_REQUEST_PROFILES` semantics to carry budget hints; no registry rewrite required in this plan.

---

## 13. Failure behavior

- **Context cannot fit:** shrink retrieval → narrow window → conservative mode → stop-as-incomplete with checkpoint. Never send a call expected to exceed the window (pre-flight estimate gate).
- **Summary fails:** keep previous summary, widen window one interval, retry once; proceed unbounded-for-one-interval with ledger flag (degraded, visible in timeline).
- **Budget exhausted:** incomplete-with-checkpoint via the existing max-turns path; user-facing copy states budget, not failure.
- **Provider returns usage:** reconcile ledger, prefer actuals.
- **Provider omits usage:** estimates flagged; policy thresholds gain margin (act one stage early).
- **Model switches mid-run:** ledger keeps per-model segments; window/summary are model-agnostic text and carry over; budgets recompute to the new window; in-flight run is unaffected (existing behavior preserved).
- **Task resumes:** reconstruct-from-summary (§11); ledger continues from snapshot.
- **Enormous tool output / reasoning:** pin-cap + summarize rule (§10); reasoning never re-sent.
- **Malformed model output:** existing `continue` retained but add consecutive-malformed counter (fail run after 3 — closes the 100-wasted-calls hole without changing valid-path behavior).

---

## 14. Performance considerations

- **Summarization:** ≤ ~10 extra calls/100-turn run; small prompts (summary + evicted window only), temp 0. Bounded and cheapest at exactly the runs that need it most.
- **Token estimation:** O(chars) heuristic already in hot path; ledger adds arithmetic only. Real counts come free inside existing responses once `usage` is captured.
- **Packing:** unchanged algorithm; runs on fewer chunks as retrieval ceiling shrinks — cost decreases under pressure.
- **Ledger updates:** constant time per call; persistence piggybacks existing event writes (no new tables required).
- Net effect: small fixed overhead per run, large savings on long runs (fewer, smaller prompts; fewer wasted invalid-JSON turns after the malformed cap).

---

## 15. Testing strategy

New suite `tests/boundedRuns.test.js` (pure, no network): 5/20/50/100-turn simulated runs asserting window/token invariants; huge-output single call (assert later turns unaffected); repeated identical calls (block preserved); reasoning-heavy fixtures (reasoning excluded from history, conclusions in facts); small-window model (aggressive stages trigger) vs large-window (normal path); compaction determinism; summary schema validation + open-issue carry-forward; checkpoint v2 round-trip incl. restart simulation; budget-exhaustion → incomplete-with-checkpoint; mid-run model switch (segments + recompute); malformed ×3 → run fails (not loops).

Hard invariants: `nativeMessages` token estimate ≤ per-model window cap, always; ledger cumulative monotonic non-decreasing; compaction never drops facts/openIssues/verification state; checkpoint v2 restores without raw history; budget stage transitions only upward within a run (except on model switch); summary size ≤ cap.

---

## 16. Phased implementation plan

**Phase 1 — Ledger (measure first).** Files: new `RunLedger.js`; `LLMRouter.js` (capture `usage`, thread optional ledger callback through `requestArgs`); `aiService.js` (record est./actual). Tests: ledger math, est→actual reconciliation, missing-usage flagging. Risks: usage field variance across providers (normalize defensively). Rollback: callback optional — delete call sites, behavior identical.

**Phase 2 — Bounded window.** Files: new `MessageWindow.js`; `agentService.js` (construct window + facts alongside `nativeMessages`; pre-summary behavior = window-only eviction with raw retention). Tests: window cap invariant, finish-sequence immunity, facts append-only. Risks: evicting needed state — mitigated by facts + raw retention this phase. Rollback: feature flag to legacy array.

**Phase 3 — Rolling summary.** Files: `MessageWindow.js` (summarizer prompt + schema + validation), prompt text in `agentService.js` or dedicated module. Tests: schema, carry-forward, oversize re-summarize, failure fallback. Risks: summary quality variance — mitigated by fixed schema + validation + raw retention. Rollback: disable summarizer, keep window.

**Phase 4 — Checkpoint integration.** Files: `agentService.js` (`createCheckpoint` v2 fields), persistence readers, resume path. Tests: round-trip, restart simulation, no-raw-history assert. Risks: old-checkpoint compat — keep v1 reader. Rollback: write v1 shape.

**Phase 5 — Hard budgets.** Files: `agentService.js` (stage enforcement at turn top), `ContextEngine.js` (ledger-aware ceiling input), UI gauge (actuals). Tests: stage transitions, pre-flight gate, exhaustion → incomplete. Risks: over-aggressive stopping — thresholds conservative, model-class-relative. Rollback: thresholds to infinity = today's behavior.

**Phase 6 — Observability.** Files: existing agent card/timeline surfaces only. Tests: event presence. Risks: none material. Rollback: revert display strings.

Ordering rationale: measure (1) before enforced shaping (2–5); window before summary (summary needs an eviction target); checkpoints after the compacted shape exists; budgets last because they depend on ledger + window + summary all working; observability throughout, formalized last.

---

## 17. Exact files likely to change

- NEW `src/services/agentEngine/RunLedger.js` (ledger) and `src/services/agentEngine/MessageWindow.js` (window + facts + summarizer).
- `src/services/agentService.js` — instantiate ledger/window per run; turn-top enforcement; checkpoint v2; malformed counter. Largest touch surface; behavior-preserving behind flags.
- `src/services/agentEngine/LLMRouter.js` — capture `usage`; additive capability fields; optional ledger callback in `requestArgs`.
- `src/services/aiService.js` — record estimates/actuals (stream path: accumulate or estimate; document choice).
- `src/services/agentEngine/ContextEngine.js` — accept optional retrieval ceiling (default = current behavior).
- `src/main/ipc/aiResponse.js` + `tests/` — extend classifier tests only if new categories added (none required).
- `src/components/AIPanel.jsx` — gauge actuals + budget stage line (display only).
- NEW `tests/boundedRuns.test.js`.
- Explicitly NOT touched: `AgentRuntime.js`, `ToolRunner.js`, `VerificationManager.js`, `FailureClassifier.js`, tool registry, DB schema (events carry new payloads; no migration), preload/IPC topology, model switching, chat history.

---

## 18. Risks

- Summary quality variance across models (mitigated: fixed schema, validation, raw retention, facts as backstop).
- Usage-field inconsistency across providers (mitigated: estimates + confidence flags + conservative margins).
- Over-stopping on small windows (mitigated: class-relative thresholds, read-only conservative mode before stop).
- Resume fidelity (mitigated: v1 reader retained, v2 additive, round-trip tests).
- Scope creep into tool filtering/embeddings/sub-agents (rejected in §19; named as follow-ups only).

---

## 19. Alternatives rejected

- **Naive truncation:** destroys task state; rejected in favor of window+summary+facts.
- **Vector DB / embeddings retrieval:** unproven need; keyword+structural retrieval works; rejected.
- **Sub-agents:** orchestration complexity without a demonstrated turn-count cause; rejected.
- **Server-side prompt caching reliance:** provider-specific, unmeasured; rejected as strategy (may be adopted opportunistically later).
- **Total rewrite / new orchestrator abstraction:** the FSM + services are sound; rejected — hooks suffice.
- **Hard per-model message counts instead of token budgets:** message counts ignore size variance (one huge output breaks them); rejected.

---

## 20. Approval checklist

- [ ] Window + summary + facts composition approved (no naive truncation)
- [ ] Ledger fields and estimate/actual policy approved
- [ ] Budget stages and stop-as-incomplete semantics approved
- [ ] Checkpoint v2 shape and resume reconstruction approved
- [ ] Model capability interface additions approved (no registry rewrite)
- [ ] Malformed-output cap (3) approved
- [ ] Phase order and per-phase rollback approved
- [ ] Test invariants approved
- [ ] Rejected alternatives acknowledged (no embeddings/sub-agents/rewrite)

---

## 21. Architecture Review Amendments

Supersedes specific statements in §§6–9 and §15 as noted. Phase order (§16) is unchanged: Ledger → Bounded window → Rolling summary → Checkpoints → Hard budgets → Observability.

### 21.A — Separate request context from run budget (supersedes §9)

The original "per-turn + per-run" framing conflated the model's context window with lifetime run consumption. These are five distinct resources with different owners and enforcement points:

- **A. Per-request context budget.** Must fit inside the model's context window on every call: `system + summary + facts + window + retrieval + requested output reserve ≤ context window − safety margin`. Enforced by pre-flight estimate gate in `runAgentTask` before every model call. Window classes (small/standard/large) size THIS budget only.
- **B. Per-run input token budget.** Cumulative input tokens across all model calls in the run (prompts, history, retrieval, tool schemas, summaries-as-input). Independent of window size: a 1M-window model still gets a finite run input allowance.
- **C. Per-run output/reasoning token budget.** Cumulative `completion_tokens` (including `reasoning_tokens` detail) across all calls. Tracked separately because reasoning-heavy models can exhaust output budgets while inputs look healthy.
- **D. Per-run cost budget.** Cumulative estimated/actual provider cost from the ledger price table. The only budget denominated in money; binds multi-model runs where token budgets alone mislead.
- **E. Per-run turn budget.** The existing turn limit (50/100) remains as an independent safety boundary, not as a proxy for any budget above.

Interaction rules: the per-request gate (A) runs before every call; B/C/D accumulate monotonically in the ledger and drive the §9 degradation stages (stages now keyed to the *tightest* exhausted dimension, not a single percentage); E terminates regardless of headroom elsewhere. **The context window is never the lifetime allowance** — a run may legally issue 50 calls each using 60% of the window while B/C/D stay green, or exhaust B on a huge window while A stays green.

### 21.B — Capability-driven reasoning history (supersedes §7 reasoning rule)

Replace the universal "reasoning is never re-sent" with a per-model/provider `reasoningHistoryPolicy`:

- `none` — never re-send reasoning (default for providers with server-side continuation or where reasoning re-send is untested).
- `summary_only` — conclusions enter facts/summary; raw reasoning excluded (default for heavy-reasoning hosted models).
- `preserve_recent` — keep last-N reasoning segments verbatim in-window (for providers whose quality demonstrably depends on visible chain-of-thought).
- `provider_required` — preserve exactly what the provider's API contract mandates (e.g. providers that require prior reasoning blocks for multi-turn coherence or encrypted-reasoning echoes).

The capability interface (§12) gains `reasoningHistoryPolicy` plus `reasoningBillsAgainstOutput`. No assumption that OpenAI-compatible or "reasoning" APIs behave alike; unknown models default to `summary_only` (safe middle: continuity without unbounded growth). Policy is recorded per ledger segment so mid-run model switches apply the new model's rule going forward without rewriting history.

### 21.C — Bounded in-memory observations

Raw exchanges are no longer retained in RAM for the run lifetime. Four tiers:

- **RAW MEMORY WINDOW** — full-fidelity recent observations (default: last 20 or ≤64k estimated tokens, whichever binds first). Backs the message window and debugging.
- **SUMMARY** — the rolling summary (§8) plus compressed older observations (existing `compressObservations` output). Always in memory, small.
- **IMPORTANT EVIDENCE** — pinned items (verification output, error evidence, user artifacts, denials): kept verbatim in memory with explicit pin reasons and per-pin size caps; pins expire into summary+facts when superseded.
- **PERSISTED AUDIT LOG** — every raw tool output already flows to `agent_events`/`tool_executions` (SQLite) via existing logging. Once an observation's content is durably persisted, its raw in-memory copy may be evicted; a pointer (`eventSequence`/`toolExecutionId`, both already emitted) remains so any evicted item is retrievable on demand for display or audit.

Result: prompt context bounded (§7) AND active RAM bounded (configurable cap, default ~128k estimated tokens for raw window + evidence); full history durable on disk; nothing observable is lost, only paged out.

### 21.D — Summarizer cost accounting

Every summarization call is a first-class ledger entry: input tokens, output tokens, reasoning tokens if reported, cost, and a `summarizerCalls` counter. Summarizer spend counts against a **separately bounded compaction budget** (default: ≤5% of the run input budget AND ≤12 calls per run, whichever binds first) — not against the same pool whose exhaustion triggers compaction. Anti-loop rules (hard requirements): compaction triggers evaluate *non-summarizer* spend only; a summarizer call can never directly trigger another compaction; when the compaction budget is exhausted, the system falls back to window-narrowing + facts-only mode (degraded but terminating). Maximum compaction frequency is additionally rate-limited (one per `COMPACTION_INTERVAL` turns) so pathological pressure cannot produce call storms.

### 21.E — Out-of-scope boundedness (scope fence)

Current phase bounds **agent execution context and run resource consumption**: `nativeMessages`, observations memory, ledgered token/cost/turn budgets, checkpoints, summarizer spend. Explicitly deferred to future phases (documented, not designed here): `responseCache` bounds (unbounded module-level `Map`), renderer/UI message history bounds, per-turn tool-schema filtering, broader application memory bounds. The phrase "bounded run" therefore guarantees bounded *runs*, not a memory-bounded application — no reviewer should infer the latter.

### 21.F — Revised invariants (supersedes §15 invariant block)

- **PER REQUEST:** estimated context tokens ≤ model context window − output reserve − safety margin (pre-flight gate, every call).
- **PER RUN:** cumulative input ≤ run input budget; cumulative output/reasoning ≤ run output budget; cumulative cost ≤ run cost budget; turns ≤ existing max-turn boundary. Each tracked independently; ledger monotonic non-decreasing per dimension.
- **IN MEMORY:** active raw observations + evidence ≤ configured memory bound; summarizer calls ≤ count cap AND compaction spend ≤ compaction budget.
- **COMPACTION:** facts, open issues, and verification state are never lost; evicted raws remain retrievable via persisted audit pointers.
- **RESUME:** never restores unbounded `nativeMessages`; reconstructs from summary + facts + empty window (§11).

---

ARCHITECTURE AMENDMENTS COMPLETE — WAITING FOR IMPLEMENTATION APPROVAL. NO SOURCE OR CONFIGURATION FILES WERE MODIFIED.
