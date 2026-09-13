---
description: The analyzer output is a proposal set. `probable_code` is not code, and a segment kind is not a finding.
paths: ["**/*_analysis.json"]
tools: ["analyze_prg"]
---

# The analyzer proposes; it does not know

`analyze_prg` runs nine heuristics over bytes. Every segment kind in this file is a
guess with a confidence, produced without reading a single instruction in context.
`probable_code` in particular means "these bytes disassemble without hitting an illegal
opcode", which is true of a great deal of data.

Nothing here fills a slot. A slot is filled by a claim someone made after reading.

**What refuses later.** S4 (data geometry) gates `register_payload` and
`extract_disk_custom_lut`, and is deliberately **not** derived from what
`register_payload` writes — a gate fed by its own door is not a gate. S4 is filled by an
explicit claim: where the payloads sit, how they are addressed, and how each one is
packed.

Useful readings of this file: which ranges the heuristics *disagree* about, and which
ranges nothing claims at all. Both point at where reading is still owed.
