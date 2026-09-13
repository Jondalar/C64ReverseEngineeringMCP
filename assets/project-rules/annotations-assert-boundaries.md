---
description: An annotation names a thing; the model says where that thing begins and ends. Names without boundaries do not compose.
paths: ["**/*_annotations.json"]
tools: ["propose_annotations", "disasm_prg"]
---

# A name is half a claim

An annotation gives a routine a name. It does not say where the routine ends, and it
does not say which subsystem it belongs to. Both live in the model:

- `model_assert` — the boundary: a subsystem, its address window, its role
- `disasm_prg` — imports this file into the graph's human layer

Measured on Ultima VI, a project with nine hundred annotated routines: 1853 routines,
799 carrying an extent, 978 carrying a name, **zero carrying both**. The two layers were
each complete and could not be joined. Boundaries are asserted, membership is computed —
a dozen judgements index eleven thousand nodes, and are recomputed on read so they
cannot go stale.

**What refuses later.** S3 (boot chain) and S6 (runtime linkage) gate
`link_payload_to_asm`; both are filled by *relations between named things*, not by names
alone. S4 gates `register_payload`.

A name you are unsure of belongs in the file with the doubt written into its comment,
not left out. An absent name is indistinguishable from unread code.
