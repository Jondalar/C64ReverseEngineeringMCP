---
description: A disassembly listing is read work, not understood work — routines need names before anything downstream counts.
paths: ["**/*_disasm.asm", "**/*_disasm.tas", "**/*_disasm.tass"]
---

# A listing is not an understanding

Reading a listing produces nothing the project keeps. The names do. Until a routine
carries a human name it is `unknown_3E00` to every later reader, including you after a
compaction.

The path from listing to kept knowledge:

1. `propose_annotations` writes a draft `<name>_annotations.json`
2. edit it — the draft's names are guesses, and a guess you did not check is worse
   than an absent name
3. **`disasm_prg` again** — that is what imports the file into the graph's human layer.
   Writing the annotations file changes nothing by itself.

Step 3 is the one that gets skipped, and the skip is silent: the rendered listing shows
the names, the graph holds none. `project_slots` counts named-ness from the graph.

**What refuses later.** `render_docs` refuses while S7 (engine presence), S9 (modules) or
S10 (save model) is empty, and those slots are filled from named routines. A project
whose listing is annotated but never imported reads as a project that never annotated.

Generated names — `unknown_3E00`, `addr_0006`, `W9000` — are excluded from the count by
design. They are the absence of a name written down.
