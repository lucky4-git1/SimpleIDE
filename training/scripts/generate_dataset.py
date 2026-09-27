#!/usr/bin/env python3
"""
generate_dataset.py: Synthesizes thousands of realistic SimpleIDE agent training examples,
including diverse software engineering tasks, state transitions, tool selections,
and mandatory hard negative boundary cases.
"""

import json
import random
import os

SEED_FILE = os.path.join(os.path.dirname(__file__), "..", "seed", "seed_data.json")
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "..", "generated", "synthetic_data.json")

# Rich set of SimpleIDE files, symbols, commands, and scenarios
COMPONENTS = [
    "Login", "Sidebar", "Editor", "Terminal", "AIPanel", "FileTree",
    "SettingsModal", "DiffViewer", "StatusBar", "TabBar", "CommandPalette",
    "RunTimeline", "BudgetGauge", "ModelSelector", "ApprovalDialog", "Notification"
]

SERVICES = [
    "agentService", "aiService", "autocompleteService", "fileIndex",
    "DatabaseManager", "ToolRunner", "LLMRouter", "AgentRuntime",
    "MessageWindow", "RunLedger", "RollingSummarizer", "VerificationManager",
    "FailureClassifier", "ChangeManager", "CodeIntelligenceService", "WorkspaceScanner",
    "ConsistencyEngine", "CrashRecoveryService", "ProjectIndexer", "NativeToolAdapter"
]

PATHS = [
    "src/components/{comp}.jsx",
    "src/services/{serv}.js",
    "src/services/agentEngine/{serv}.js",
    "src/main/ipc/{ipc}.ipc.js",
    "electron/database/{serv}.js",
    "tests/{test}.test.js",
    "src/utils/{util}.js"
]

IPCS = ["fs", "git", "ai", "process", "db", "skills", "primeRouter"]
TESTS = ["primeRouter", "boundedBudgets", "agentRuntime", "m2_native_tools", "rollingSummarizer", "codeIntelligence"]
UTILS = ["formatters", "pathSanitizer", "debounce", "hash", "logger", "validators"]

COMMANDS = [
    "npm test", "npm run test", "npm run build", "npm run lint", "npm install",
    "npm run preview", "vite build", "git status", "git diff", "git log -n 10",
    "git branch -a", "git checkout -b feature", "git commit -m 'update'", "git pull --ff-only",
    "node --test tests/primeRouter.test.js", "npx eslint src/", "npm test tests/agentRuntime.test.js"
]

TOPICS = [
    "authentication", "caching", "state management", "IPC serialization",
    "SQLite queries", "token budgeting", "cancellation", "symbol resolution",
    "rolling summaries", "AST indexing", "stream parsing", "safeStorage encryption",
    "process lifecycle", "path traversal guards", "context compaction", "error classification"
]

PHRASINGS_INSPECT = [
    "open {file}", "read {file}", "view {file}", "cat {file}", "inspect {file}",
    "show me the code in {file}", "check the implementation of {file}",
    "examine lines in {file}", "display contents of {file}", "browse {file}"
]

PHRASINGS_SEARCH = [
    "search for {query} across the project", "find all occurrences of {query}",
    "locate where {query} is declared", "grep for '{query}' in src/",
    "where is {query} referenced?", "search workspace for {query}",
    "find usages of {query} in the codebase", "locate {query} function"
]

PHRASINGS_RUN = [
    "run {cmd}", "execute {cmd} in terminal", "start {cmd}",
    "trigger {cmd} via shell", "run the command {cmd}", "execute {cmd} now"
]

PHRASINGS_TEST = [
    "run tests for {module}", "execute unit tests in {file}",
    "run npm test to check changes", "test the {topic} module",
    "run the test suite", "check test results for {module}"
]

PHRASINGS_EXPLAIN = [
    "explain how {file} works", "what is the purpose of {topic}?",
    "help me understand how {file} handles {topic}",
    "walk me through the logic in {file}", "can you describe what {symbol} does?",
    "explain the architecture of {topic} in SimpleIDE"
]

PHRASINGS_DEBUG = [
    "find why {topic} is failing", "diagnose the error in {file}",
    "debug the issue where {topic} throws an exception",
    "investigate failure when running {cmd}", "why is {symbol} returning undefined?",
    "troubleshoot {topic} failure in {file}"
]

PHRASINGS_CREATE = [
    "create a new component {file}", "implement a helper for {topic} in {file}",
    "add a new function {symbol} to {file}", "scaffold a module for {topic} at {file}",
    "build a new UI view for {topic} in {file}"
]

PHRASINGS_EDIT = [
    "refactor {file} to use async/await", "fix the bug in {file} around line 40",
    "update {file} to support {topic}", "clean up unused variables in {file}",
    "optimize the performance of {symbol} in {file}", "modify {file} to handle errors cleanly"
]

PHRASINGS_RECOVER = [
    "undo the last agent change", "revert recent changes to {file}",
    "rollback the last edit transaction", "restore previous version of {file}",
    "undo the file modifications made in this turn"
]

HARD_NEGATIVE_TEMPLATES = [
    # Questions about commands -> explain (main_llm), NEVER terminal execution
    ("What does {cmd} do?", "IDLE", "explain", "main_llm", "none", True, False),
    ("Tell me what {cmd} does and when I should use it.", "IDLE", "explain", "main_llm", "none", True, False),
    ("Can you explain how {cmd} works behind the scenes?", "IDLE", "explain", "main_llm", "none", True, False),
    ("Why should I run {cmd} in this situation?", "IDLE", "explain", "main_llm", "none", True, False),
    ("What are the flags available for {cmd}?", "IDLE", "explain", "main_llm", "none", True, False),

    # Compound requests combining terminal execution with reasoning -> debug / main_llm
    ("Run {cmd} and explain why it fails.", "IDLE", "debug", "main_llm", "terminal", True, True),
    ("Execute {cmd} and tell me what the error output means.", "IDLE", "debug", "main_llm", "terminal", True, True),
    ("Run {cmd} and summarize the output for me.", "IDLE", "debug", "main_llm", "terminal", True, False),
    ("Run tests with {cmd} and fix any failing assertions.", "EXECUTING", "debug", "main_llm", "terminal", True, True),

    # Read-only boundary constraints -> inspect (local_tool), strictly no modification
    ("Inspect {file} but don't modify anything.", "IDLE", "inspect", "local_tool", "filesystem", False, False),
    ("Look at {file} without making any changes.", "IDLE", "inspect", "local_tool", "filesystem", False, False),
    ("Read {file} only; do not edit or create files.", "IDLE", "inspect", "local_tool", "filesystem", False, False),
    ("Check {file} for syntax issues without editing it.", "IDLE", "inspect", "local_tool", "filesystem", False, False),
    ("View {file} in read-only mode.", "IDLE", "inspect", "local_tool", "filesystem", False, False),

    # Questions about git -> explain, not git tool
    ("What is git rebase and how is it different from git merge?", "IDLE", "explain", "main_llm", "none", True, False),
    ("Explain the difference between git status and git diff.", "IDLE", "explain", "main_llm", "none", True, False),
    ("How does Git calculate blob hashes in SimpleIDE?", "IDLE", "explain", "main_llm", "none", True, False)
]

def make_file():
    p = random.choice(PATHS)
    return p.format(
        comp=random.choice(COMPONENTS),
        serv=random.choice(SERVICES),
        ipc=random.choice(IPCS),
        test=random.choice(TESTS),
        util=random.choice(UTILS)
    )

def generate():
    random.seed(1337)
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    samples = []
    sid = 1

    # Load seed data if present
    if os.path.exists(SEED_FILE):
        with open(SEED_FILE, "r", encoding="utf-8") as f:
            seeds = json.load(f)
            samples.extend(seeds)
            sid += len(seeds)

    # 1. Inspect
    for phrase in PHRASINGS_INSPECT:
        for _ in range(30):
            samples.append({
                "id": f"syn-{sid:05d}",
                "request": phrase.format(file=make_file()),
                "state": random.choice(["IDLE", "PLANNING", "EXECUTING"]),
                "availableTools": ["read_file", "list_files"],
                "intent": "inspect",
                "actionClass": "local_tool",
                "toolFamily": "filesystem",
                "needsLLM": False,
                "needsVerification": False,
                "isHardNegative": False,
                "source": "synthetic"
            })
            sid += 1

    # 2. Search
    for phrase in PHRASINGS_SEARCH:
        for _ in range(30):
            q = random.choice(TOPICS) if random.random() > 0.5 else random.choice(COMPONENTS) + "Handler"
            samples.append({
                "id": f"syn-{sid:05d}",
                "request": phrase.format(query=q),
                "state": random.choice(["IDLE", "PLANNING", "EXECUTING"]),
                "availableTools": ["search_workspace", "read_file"],
                "intent": "search",
                "actionClass": "local_tool",
                "toolFamily": "search",
                "needsLLM": False,
                "needsVerification": False,
                "isHardNegative": False,
                "source": "synthetic"
            })
            sid += 1

    # 3. Run Command
    for phrase in PHRASINGS_RUN:
        for _ in range(25):
            samples.append({
                "id": f"syn-{sid:05d}",
                "request": phrase.format(cmd=random.choice(COMMANDS)),
                "state": random.choice(["IDLE", "EXECUTING"]),
                "availableTools": ["run_command"],
                "intent": "run_command",
                "actionClass": "local_tool",
                "toolFamily": "terminal",
                "needsLLM": False,
                "needsVerification": False,
                "isHardNegative": False,
                "source": "synthetic"
            })
            sid += 1

    # 4. Test & Verify
    for phrase in PHRASINGS_TEST:
        for _ in range(30):
            samples.append({
                "id": f"syn-{sid:05d}",
                "request": phrase.format(module=random.choice(SERVICES), file=make_file(), topic=random.choice(TOPICS)),
                "state": random.choice(["IDLE", "EVALUATING", "VERIFYING"]),
                "availableTools": ["run_command", "verify"],
                "intent": "test",
                "actionClass": "local_tool",
                "toolFamily": "testing",
                "needsLLM": False,
                "needsVerification": True,
                "isHardNegative": False,
                "source": "synthetic"
            })
            sid += 1

    # 5. Git operations
    git_cmds = ["git status", "git diff", "git log -n 5", "git branch", "git add .", "git commit -m 'feat: update'", "git pull"]
    for gcmd in git_cmds:
        for _ in range(20):
            samples.append({
                "id": f"syn-{sid:05d}",
                "request": f"{gcmd} in the repo",
                "state": "IDLE",
                "availableTools": ["git_status", "git_diff", "git_commit"],
                "intent": "git",
                "actionClass": "local_tool",
                "toolFamily": "git",
                "needsLLM": False,
                "needsVerification": False,
                "isHardNegative": False,
                "source": "synthetic"
            })
            sid += 1

    # 6. Explain (Main LLM)
    for phrase in PHRASINGS_EXPLAIN:
        for _ in range(35):
            samples.append({
                "id": f"syn-{sid:05d}",
                "request": phrase.format(file=make_file(), topic=random.choice(TOPICS), symbol=random.choice(SERVICES) + "Init"),
                "state": "IDLE",
                "availableTools": ["read_file"],
                "intent": "explain",
                "actionClass": "main_llm",
                "toolFamily": "none",
                "needsLLM": True,
                "needsVerification": False,
                "isHardNegative": False,
                "source": "synthetic"
            })
            sid += 1

    # 7. Debug (Main LLM)
    for phrase in PHRASINGS_DEBUG:
        for _ in range(35):
            samples.append({
                "id": f"syn-{sid:05d}",
                "request": phrase.format(file=make_file(), topic=random.choice(TOPICS), cmd=random.choice(COMMANDS), symbol=random.choice(SERVICES)),
                "state": random.choice(["EXECUTING", "REPAIRING"]),
                "availableTools": ["search_workspace", "read_file", "run_command"],
                "intent": "debug",
                "actionClass": "main_llm",
                "toolFamily": "filesystem",
                "needsLLM": True,
                "needsVerification": True,
                "isHardNegative": False,
                "source": "synthetic"
            })
            sid += 1

    # 8. Create & Edit (Main LLM)
    for phrase in PHRASINGS_CREATE:
        for _ in range(35):
            samples.append({
                "id": f"syn-{sid:05d}",
                "request": phrase.format(file=make_file(), topic=random.choice(TOPICS), symbol="render" + random.choice(COMPONENTS)),
                "state": "PLANNING",
                "availableTools": ["create_file", "write_file", "read_file"],
                "intent": "create",
                "actionClass": "main_llm",
                "toolFamily": "editor",
                "needsLLM": True,
                "needsVerification": True,
                "isHardNegative": False,
                "source": "synthetic"
            })
            sid += 1

    for phrase in PHRASINGS_EDIT:
        for _ in range(35):
            samples.append({
                "id": f"syn-{sid:05d}",
                "request": phrase.format(file=make_file(), topic=random.choice(TOPICS), symbol="handle" + random.choice(COMPONENTS)),
                "state": random.choice(["EXECUTING", "PLANNING"]),
                "availableTools": ["edit_file", "read_file"],
                "intent": "edit",
                "actionClass": "main_llm",
                "toolFamily": "editor",
                "needsLLM": True,
                "needsVerification": True,
                "isHardNegative": False,
                "source": "synthetic"
            })
            sid += 1

    # 9. Recover
    for phrase in PHRASINGS_RECOVER:
        for _ in range(25):
            samples.append({
                "id": f"syn-{sid:05d}",
                "request": phrase.format(file=make_file()),
                "state": "EVALUATING",
                "availableTools": ["rollback", "git_diff"],
                "intent": "recover",
                "actionClass": "recovery",
                "toolFamily": "diagnostics",
                "needsLLM": False,
                "needsVerification": False,
                "isHardNegative": False,
                "source": "synthetic"
            })
            sid += 1

    # 10. Hard Negatives
    for tmpl, state, intent, action_class, tool_family, needs_llm, needs_verif in HARD_NEGATIVE_TEMPLATES:
        for _ in range(30):
            samples.append({
                "id": f"neg-{sid:05d}",
                "request": tmpl.format(cmd=random.choice(COMMANDS), file=make_file()),
                "state": state,
                "availableTools": ["run_command", "read_file", "git_status"],
                "intent": intent,
                "actionClass": action_class,
                "toolFamily": tool_family,
                "needsLLM": needs_llm,
                "needsVerification": needs_verif,
                "isHardNegative": True,
                "source": "hard_negative"
            })
            sid += 1

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(samples, f, indent=2)

    print(f"Generated {len(samples)} samples ({len([s for s in samples if s.get('isHardNegative')])} hard negatives).")

if __name__ == "__main__":
    generate()
