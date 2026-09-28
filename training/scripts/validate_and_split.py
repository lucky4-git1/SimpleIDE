#!/usr/bin/env python3
"""
validate_and_split.py: Validates, deduplicates, and splits the SimpleIDE Prime Router dataset.
Ensures strict conformity to decision taxonomy and creates balanced train/val/test splits.
"""

import json
import os
import random

VALID_INTENTS = {
    "chat", "explain", "inspect", "search", "create", "edit", "refactor",
    "debug", "test", "run_command", "git", "web", "plan", "continue",
    "verify", "finish", "recover"
}

VALID_ACTION_CLASSES = {
    "local_tool", "main_llm", "verification", "recovery", "user_input", "complete"
}

VALID_TOOL_FAMILIES = {
    "filesystem", "editor", "terminal", "git", "search", "browser",
    "diagnostics", "testing", "none"
}

VALID_STATES = {
    "IDLE", "PLANNING", "EXECUTING", "EVALUATING", "VERIFYING",
    "REPAIRING", "REPLANNING", "COMPLETED", "FAILED"
}

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GENERATED_FILE = os.path.join(ROOT_DIR, "generated", "synthetic_data.json")
SEED_FILE = os.path.join(ROOT_DIR, "seed", "seed_data.json")
CLEAN_FILE = os.path.join(ROOT_DIR, "validated", "clean_dataset.json")
SPLITS_DIR = os.path.join(ROOT_DIR, "splits")

def validate_sample(s):
    if not isinstance(s, dict):
        return False, "Not a dictionary"
    req = s.get("request")
    if not req or not isinstance(req, str):
        return False, "Missing or non-string request"
    if s.get("intent") not in VALID_INTENTS:
        return False, f"Invalid intent: {s.get('intent')}"
    if s.get("actionClass") not in VALID_ACTION_CLASSES:
        return False, f"Invalid actionClass: {s.get('actionClass')}"
    if s.get("toolFamily") not in VALID_TOOL_FAMILIES:
        return False, f"Invalid toolFamily: {s.get('toolFamily')}"
    if not isinstance(s.get("needsLLM"), bool):
        return False, "needsLLM must be boolean"
    if not isinstance(s.get("needsVerification"), bool):
        return False, "needsVerification must be boolean"
    state = s.get("state", "IDLE")
    if state not in VALID_STATES:
        return False, f"Invalid state: {state}"
    return True, None

def normalize(text):
    return " ".join(text.strip().lower().split())

def main():
    raw_samples = []
    for fpath in [SEED_FILE, GENERATED_FILE]:
        if os.path.exists(fpath):
            with open(fpath, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    raw_samples.extend(data)

    print(f"Loaded {len(raw_samples)} raw samples.")

    # Validation & Deduplication
    seen_hashes = set()
    clean_samples = []
    errors = 0

    for s in raw_samples:
        valid, err = validate_sample(s)
        if not valid:
            errors += 1
            continue

        norm_key = (normalize(s["request"]), s.get("state", "IDLE"))
        if norm_key in seen_hashes:
            continue
        seen_hashes.add(norm_key)

        clean_samples.append({
            "id": s.get("id", f"sample-{len(clean_samples)+1}"),
            "request": s["request"].strip(),
            "state": s.get("state", "IDLE"),
            "availableTools": s.get("availableTools", []),
            "intent": s["intent"],
            "actionClass": s["actionClass"],
            "toolFamily": s["toolFamily"],
            "needsLLM": s["needsLLM"],
            "needsVerification": s["needsVerification"],
            "isHardNegative": bool(s.get("isHardNegative", False)),
            "source": s.get("source", "synthetic")
        })

    os.makedirs(os.path.dirname(CLEAN_FILE), exist_ok=True)
    with open(CLEAN_FILE, "w", encoding="utf-8") as f:
        json.dump(clean_samples, f, indent=2)

    print(f"Validated and deduplicated into {len(clean_samples)} unique clean samples ({errors} rejected).")

    # Split into Train (80%), Val (10%), Test (10%)
    random.seed(1337)
    shuffled = clean_samples.copy()
    random.shuffle(shuffled)

    n = len(shuffled)
    n_train = int(n * 0.8)
    n_val = int(n * 0.1)

    train_set = shuffled[:n_train]
    val_set = shuffled[n_train:n_train + n_val]
    test_set = shuffled[n_train + n_val:]

    os.makedirs(SPLITS_DIR, exist_ok=True)
    with open(os.path.join(SPLITS_DIR, "train.json"), "w", encoding="utf-8") as f:
        json.dump(train_set, f, indent=2)
    with open(os.path.join(SPLITS_DIR, "val.json"), "w", encoding="utf-8") as f:
        json.dump(val_set, f, indent=2)
    with open(os.path.join(SPLITS_DIR, "test.json"), "w", encoding="utf-8") as f:
        json.dump(test_set, f, indent=2)

    print(f"Splits created: Train={len(train_set)}, Val={len(val_set)}, Test={len(test_set)}")

if __name__ == "__main__":
    main()
