# Third-Party Notices and Acknowledgements

SimpleIDE ("Prime AI") incorporates and builds upon open-source software and model architectures. This document acknowledges the upstream projects, foundational models, and associated licenses.

---

## 1. Foundational Decision Model Architecture

### Laya Architecture & Foundational Checkpoint
- **Project:** Laya (Local Agent Routing and Classification Foundation)
- **Role in SimpleIDE:** Initial foundational checkpoint used for transfer learning, dataset schema alignment, and task routing fine-tuning.
- **License:** Apache License 2.0 / MIT
- **Notice:** Prime Router v1 utilizes a specialized checkpoint fine-tuned specifically for SimpleIDE's Electron, React, Node.js, and tool-execution taxonomy. The runtime, validation layers, context budgeting, and agent state machines are developed specifically for SimpleIDE. Future versions of Prime Router are designed to be replaced by independently trained proprietary checkpoints without altering IDE interfaces.

---

## 2. Core Open-Source Dependencies

### Monaco Editor
- **Publisher:** Microsoft Corporation
- **License:** MIT License
- **Notice:** Copyright (c) 2016 - present Microsoft Corporation.

### Better-SQLite3
- **Publisher:** Joshua Wise
- **License:** MIT License
- **Notice:** Copyright (c) 2017 Joshua Wise.

### Zod
- **Publisher:** Colin McDonnell
- **License:** MIT License
- **Notice:** Copyright (c) 2020 Colin McDonnell.

### Electron & Node.js
- **License:** MIT License (Electron) / Node.js License
- **Notice:** Copyright (c) Electron contributors.

---

## 3. Training & Evaluation Pipeline
The dataset generation, hard-negative synthesis, schema validators, calibration routines (ECE, Brier score), and ONNX export scripts in `training/` are proprietary to SimpleIDE and developed under the project's primary license.
