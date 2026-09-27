# PrimeRouter: Embedded Decision Model & Routing Layer

## 1. Specification & Objectives

**PrimeRouter** is a deterministic, low-latency (< 50ms) classification engine embedded directly inside SimpleIDE. It specializes in developer intent recognition, tool family gating, LLM escalation decisions, verification necessity, and recovery actions.

### Key Performance Characteristics
- **Inference Provider:** CPU Execution Provider via `onnxruntime-node`.
- **Target Latency:** < 50ms on standard x86_64 / arm64 desktop CPUs (actual benchmark: 1–5ms).
- **Thread Constraints:** 2 intra-op threads, 1 inter-op thread (avoids CPU starvation).
- **RAM Footprint:** < 15MB total memory overhead for runtime and model weights.
- **Packaging:** Embedded inside `assets/models/prime-router/` (ONNX format + SHA256 manifest).

---

## 2. Decision Taxonomy

Every routing decision conforms strictly to the schema defined in `src/services/agentEngine/primeRouterSchemas.js`:

```typescript
interface PrimeDecision {
  intent: 'edit' | 'explain' | 'test' | 'debug' | 'refactor' | 'create' | 'run_command' | 'git' | 'recover' | 'other';
  actionClass: 'local_tool' | 'main_llm' | 'small_model' | 'rule_fallback' | 'recovery';
  toolFamily: 'filesystem' | 'editor' | 'search' | 'git' | 'terminal' | 'testing' | 'browser' | 'diagnostics' | 'none';
  needsLLM: boolean;
  needsVerification: boolean;
  confidence: number; // 0.0 to 1.0
  reasoning: string;
  source: 'local_model' | 'rule_fallback' | 'cache' | 'default';
  metadata?: Record<string, unknown>;
}
```

---

## 3. Confidence Thresholds & Routing Policy

| Confidence Level | Score Range | System Action | Rationale |
| :--- | :--- | :--- | :--- |
| **High** | $\ge 0.85$ | Direct execution / local routing | High certainty allows bypass of remote LLM for deterministic commands (e.g. running tests, git status). |
| **Moderate** | $0.60 \le s < 0.85$ | Conservative LLM escalation | Code modification requests with moderate confidence escalate to LLM to prevent destructive mistakes. |
| **Low** | $< 0.60$ | Mandatory LLM escalation & fallback | Ambiguous or complex prompts are delegated to the frontier model with full reasoning. |

### Feature Flags & Modes
- `active`: Primary operating mode. Router performs local execution for high-confidence intents and filters tool schemas for LLM turns.
- `assist`: Router emits decisions and tool suggestions to the agent loop but forces `needsLLM = true` for external confirmation.
- `disabled`: Bypasses local model completely; all queries route to LLM with full tool definitions.

---

## 4. Bounded LRU Cache & Fallback Mechanics

### LRU Cache Specifications
- **Capacity:** 128 recent entries.
- **TTL (Time to Live):** 60 seconds.
- **Cache Key:** Composite string derived from `[normalized_request]__[agent_state]__[available_tool_count]`.
- **Purpose:** Avoids duplicate inference passes when multiple components or turns query the router on identical context.

### Safe Fallback Generator
If the Electron main process IPC bridge is unreachable, the ONNX model fails to load, or inference throws an unexpected error, the adapter catches the exception and immediately invokes `generateSafeFallback(request, state, availableTools)`.
- Fallback decisions guarantee strict adherence to the Zod schema.
- Sets `actionClass: 'main_llm'`, `needsLLM: true`, `confidence: 0.50`, and `source: 'rule_fallback'`.
- The IDE continues operating smoothly without user interruption.

---

## 5. Hard Negative Disambiguation

A key strength of the router's calibration is accurate handling of hard negatives:
- `"npm test"` $\rightarrow$ `intent: 'test'`, `actionClass: 'local_tool'`, `needsLLM: false`.
- `"Tell me what npm test does"` $\rightarrow$ `intent: 'explain'`, `actionClass: 'main_llm'`, `needsLLM: true`.
- `"Run test and explain why it fails"` $\rightarrow$ `intent: 'debug'`, `actionClass: 'main_llm'`, `needsLLM: true`.
- `"git commit -m 'wip'"` $\rightarrow$ `intent: 'git'`, `actionClass: 'local_tool'`, `needsLLM: false`.
- `"Should I commit these changes now?"` $\rightarrow$ `intent: 'explain'`, `actionClass: 'main_llm'`, `needsLLM: true`.
