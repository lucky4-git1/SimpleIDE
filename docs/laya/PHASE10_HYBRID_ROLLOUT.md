# Phase 10: Hybrid Rollout Architecture & Validation Report

**Date:** 2026-09-28  
**Model:** `convaiinnovations/laya` (SimpleIDE Fine-Tuned v1.0.0, ONNX Export Opset 18)  
**Component:** `PrimeRouter`, `LayaDecisionAdapter`, `LayaSafetyPolicy`, `ToolRunner`  
**Rollout Modes:** `legacy` | `shadow` | `hybrid` | `laya`  
**Authoritative Safety Gate:** `LayaSafetyPolicy` is non-overridable in all modes  

---

## 1. Rollout Architecture & Decision Matrix

SimpleIDE's local routing architecture supports four cleanly isolated rollout modes:

```
┌────────────────────────────────────────────────────────────────────────┐
│                              PrimeRouter                               │
│                                                                        │
│   Mode = 'legacy' ──────► Legacy Adapter Only (Heuristic rules)        │
│   Mode = 'shadow' ──────► Legacy Authoritative + Laya Shadow Telemetry │
│   Mode = 'hybrid' ──────► Laya for Low-Risk; LLM for High-Risk         │
│   Mode = 'laya'   ──────► Laya Model Direct Control                    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
                ┌───────────────────────────────────────┐
                │       LayaSafetyPolicy Gate           │
                │  * Blocks rm -rf, del /s /q, fork     │
                │  * Enforces workspace containment     │
                │  * Blocks SSRF / credential endpoints │
                │  * Enforces user approval on writes   │
                └───────────────────┬───────────────────┘
                                    │
                                    ▼
                          [Validated Decision]
```

### Decision Matrix by Operation Category in Hybrid Mode

| Operational Category | Risk Classification | Assigned Route in Hybrid Mode | Safety Gate & LLM Policy |
| :--- | :---: | :---: | :--- |
| **Code Navigation (definitions, callers)** | **Low** | **Laya Direct (`local_tool`)** | Read-only; zero LLM calls needed |
| **Search & Pattern Locating** | **Low** | **Laya Direct (`local_tool`)** | Read-only; lexical / ast search |
| **Workspace File Inspection** | **Low** | **Laya Direct (`local_tool`)** | Read-only; bounded by workspace path |
| **Local File Editing** | **Medium** | **Laya Assisted (`main_llm`)** | AST diff generation with undo stack |
| **Refactoring & Architecture Changes** | **Medium / High** | **Main LLM Turn** | Requires context plan + tests review |
| **Terminal & Shell Execution** | **High** | **User Approval Gate** | Command allowlist + interactive confirmation |
| **Catastrophic Shell Commands** | **Critical** | **Blocked Permanently** | Immediate fallback; execution halted |

---

## 2. Invariant Safety Controls

1. **Non-Overridable Safety Invariant**:
   Under no circumstances can Laya model confidence (even $1.00$) bypass `LayaSafetyPolicy`. All commands matching dangerous shell patterns (`rm -rf /`, `rmdir /s /q`, fork bombs, mkfs) are intercepted deterministically and forced to `user_input` / blocked fallback.
2. **Workspace Containment**:
   All file paths referenced in Laya decisions are validated against workspace roots, preventing directory traversal (`../../etc/passwd` or `..\..\Windows`).
3. **Approval Gating**:
   Destructive write tools (`write_file`, `delete_file`, `execute_command`) require explicit user confirmation via IDE interactive prompts.
4. **Independent Mode Isolation**:
   Unit tests in `tests/layaShadowAndRollout.test.js` verify that switching `layaMode` between `legacy`, `shadow`, `hybrid`, and `laya` works cleanly without state contamination or memory leaks.
