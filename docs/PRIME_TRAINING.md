# PrimeRouter: Training Pipeline & Model Packaging

## 1. Overview & Laya Architectural Lineage

The **PrimeRouter** model is specialized for SimpleIDE developer tasks based on the architectural principles of **Laya** (a lightweight decision and routing model framework). Rather than using a heavy decoder-only LLM for routing, the system trains a highly compact, multi-output decision network optimized for CPU execution.

Full license acknowledgments and attribution are maintained in `THIRD_PARTY_NOTICES.md`.

---

## 2. Dataset Synthesis & Validation

The training pipeline resides in `training/` and consists of deterministic data generation, strict schema validation, stratified splitting, model training, evaluation, and ONNX export.

```text
training/
├── schemas/
│   ├── decision.schema.json      # JSON Schema for routing decisions
│   └── trace.schema.json         # JSON Schema for decision traces
├── data/
│   └── seed_data.json            # 40 core seeds across 10 taxonomy intents
├── scripts/
│   ├── generate_dataset.py       # Augmentation & hard negative generator
│   ├── validate_and_split.py     # Schema validation, dedup, stratified split
│   ├── train_router.py           # Multi-head classifier training & calibration
│   └── export_onnx.py            # ONNX packaging and checksum verification
├── validated/
│   └── clean_dataset.json        # 1,674 deduplicated validated samples
├── splits/
│   ├── train.json                # 1,339 training samples (80%)
│   ├── val.json                  # 167 validation samples (10%)
│   └── test.json                 # 168 evaluation samples (10%)
└── evaluation/
    └── metrics.json              # Full test metrics and confusion matrix
```

### Dataset Statistics
- **Total Synthesized Samples:** 2,465 samples.
- **Hard Negative Count:** 514 samples (disambiguating command questions from execution).
- **Deduplicated Clean Dataset:** 1,674 validated records.
- **Split Breakdown:** 80% Train (1,339), 10% Validation (167), 10% Test (168).

---

## 3. Training & Calibration Procedure

The model pipeline is trained via `training/scripts/train_router.py`:
1. **Feature Extraction:** Character & word n-gram TF-IDF vectorizer (1–3 grams, sublinear TF scaling).
2. **Intent & Action Heads:** Calibrated logistic regression / linear multi-output classifiers with Platt scaling / isotonic probability calibration.
3. **Threshold Tuning:** Calibrated to minimize Brier score on out-of-fold validation sets.

### Evaluation Metrics (`training/evaluation/metrics.json`)
- **Intent Accuracy:** 1.0000 (100% on held-out test split).
- **Action Class Accuracy:** 1.0000 (100%).
- **Hard Negative Accuracy:** 1.0000 (0 false-positive executions).
- **Brier Confidence Score:** 0.0392 (well-calibrated probabilities).

---

## 4. ONNX Export & Checksum Verification

The trained pipeline is exported using `training/scripts/export_onnx.py`:
- Target artifact: `assets/models/prime-router/prime-router.onnx`
- Metadata Manifest: `assets/models/prime-router/model-manifest.json`

### Manifest Verification
```json
{
  "name": "prime-router",
  "version": "0.1.0",
  "format": "onnx",
  "architecture": "laya-multitask-router",
  "sha256": "3019a5f0a3732eb1a34c80dfb138026613df9da9128aa2948dc146d409e94622",
  "targetExecutionProvider": "CPUExecutionProvider",
  "intents": ["edit", "explain", "test", "debug", "refactor", "create", "run_command", "git", "recover", "other"],
  "actionClasses": ["local_tool", "main_llm", "small_model", "rule_fallback", "recovery"]
}
```

This manifest is verified during application build and packaging to guarantee model integrity.
