# SimpleIDE Laya Fine-Tuning Pipeline

This directory contains the domain fine-tuning and calibration pipeline for specializing the **Laya System-1 Decision Model** (`convaiinnovations/laya` / `receptron/laya-onnx`) into **SimpleIDE-Laya**.

---

## 1. Upstream Model Sources
- **Base Architecture**: `convaiinnovations/laya` (ModernBERT-large encoder + decision head)
- **Official ONNX Distribution**: `receptron/laya-onnx` (revision: `4e7492c6b3e9a11db9cfcbf14be791197ad679ba`)
- **Node.js Runtime**: `@receptron/laya` / `onnxruntime-node`
- **License**: Apache-2.0 (model weights) / MIT (ONNX runtime)

---

## 2. Dataset Synthesis
Generate the 10,000–30,000 structured coding agent decision examples:

```bash
node training/dataset_generator.js
```

This outputs:
- `training/data/train.jsonl` (80%): 8,000 examples
- `training/data/val.jsonl` (10%): 1,000 examples
- `training/data/test.jsonl` (10%): 1,000 examples (untouched test set)

### Dataset Features:
- **3 Quality Tiers**: Deterministic symbol rules (Tier 1), repository call graph ground truth (Tier 2), and curated agent scenarios (Tier 3).
- **Hard Negatives**: Style and wording edits where SymbolGraph is strictly unnecessary, preventing semantic navigation overuse.

---

## 3. Hardware Requirements & GPU Training
Per Section 16 of the specification:
- Local development machines (CPU) generate data, run validations, and execute ONNX runtime inference.
- Full GPU training should be executed on an NVIDIA CUDA environment:

```bash
pip install -r training/requirements.txt
python training/train_laya.py --config training/config.yaml
```

The fine-tuned model checkpoint is saved to:
`models/laya/simpleide/simpleide-laya.onnx`
