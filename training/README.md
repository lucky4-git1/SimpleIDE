# Prime Router Training Pipeline — SimpleIDE

This directory contains the reproducible dataset generation, validation, training, calibration, and ONNX export pipeline for the SimpleIDE Prime Router local decision model.

---

## Directory Structure

```
training/
├── README.md               # Pipeline documentation & instructions
├── schemas/                # Canonical JSON schemas
│   ├── decision.schema.json
│   └── trace.schema.json
├── seed/                   # Hand-curated seed samples
│   └── seed_data.json
├── generated/              # Synthesized samples & hard negatives
├── validated/              # Validated & deduplicated dataset
├── splits/                 # Train / Validation / Test partitions (80/10/10)
├── scripts/                # Reproducible execution scripts
│   ├── generate_dataset.py
│   ├── validate_and_split.py
│   ├── train_router.py
│   └── export_onnx.py
├── experiments/            # Saved checkpoints & serialized models
└── evaluation/             # Metrics, confusion analysis, ECE calibration
```

---

## Pipeline Execution Steps

### 1. Generate Synthetic Data and Hard Negatives
```bash
python training/scripts/generate_dataset.py
```
Synthesizes thousands of domain-specific SimpleIDE agent turns, including file operations, git commands, terminal executions, state transitions, and critical hard negatives (e.g. questions about commands vs command execution).

### 2. Validate, Deduplicate, and Split Dataset
```bash
python training/scripts/validate_and_split.py
```
Validates against `decision.schema.json`, deduplicates samples based on normalized request and state, and partitions into:
- `splits/train.json` (80%)
- `splits/val.json` (10%)
- `splits/test.json` (10%)

### 3. Fine-Tune and Calibrate Model
```bash
python training/scripts/train_router.py
```
Trains the multi-head classifier, measures accuracy, F1, Expected Calibration Error (ECE), and Brier score, outputs `evaluation/metrics.json` and `evaluation/error_analysis.json`.

### 4. Export and Optimize ONNX Model
```bash
python training/scripts/export_onnx.py
```
Generates `assets/models/prime-router/prime-router.onnx` and `model-manifest.json` with SHA256 checksum and tensor shapes for consumption by the Electron main process.
