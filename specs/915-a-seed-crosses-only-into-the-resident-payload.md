# Spec 915 — A code seed crosses an owner boundary only from real code, into the payload that is in the window

**Status:** READY TO BUILD (2026-10-21). D1–D3 decided with the owner.
**Repo:** C64RE (the runtime trace import that writes the graph, and the code-seed reader in the pipeline). TRX64 untouched.
**Number:** 915 (registry: `specs/README.md`).
**Origin:** issue #140 (a reporter, an unreleased 1 MB EasyFlash cartridge that cannot be shared;
no PR for that reason, the reporter retests). Owner, 2026-10-21: keep it open, make it a spec.
**Depends on:** 838 (code seeds from the graph), 867 (the window a payload owns, its residency D3).

---

## §1 The problem

**Who:** the LLM and the human analysing a cartridge or a multi-overlay program, where many
owners share one RAM window over time.

**What they want:** a listing whose code starts only where something that really runs there
enters it. A call from code that is never in the window at the same time is not an entry.

**What happens today** (read from the code, 2026-10-21):

- `loadCodeSeeds` (`pipeline/src/analysis/graph-reader.ts`, S2) takes every `CALLS` / `JUMPS_TO`
  edge from any other owner onto an `addr` node inside this image's window and seeds it. It
  reads neither the edge's confidence nor whether that caller and this image are in memory
  together.
- The control-flow producer (`src/knowledge-graph/producers/control-flow.ts`) writes edges from
  `probableCodeAnalysis` too, with provenance `probable_code` and confidence `heuristic`. So a
  heuristic render of a graphics bank "calls" `$0814` and splits `lda $DC01` at `$0813` in the
  `$0800` stub copy (issue #140, symptom 1: 7 seeds, 3 stranded bytes, 1 is right).
- The target of every call or jump, static or from the runtime, is an `addr` node with no
  owner (`addrCtx`, `producers/control-flow.ts:239`; `producers/runtime.ts:649`). The trace
  import writes runtime `CALLS` for `jsr` only, no `jmp`, and never records which payload was
  in memory at the target. 867 D3's residency by bytes can answer that, but runs on demand
  for one address and is not written back to the edge.
- Spec 867 §2 decided: inside my own window the code is mine, whoever else wrote a node there.
  That stops the subtraction, but it also lets every co-occupant of the window seed me
  (symptom 2: the resident loader's `jmp $3200`/`$3400` seed the menu overlay; engine code at
  `$7800` seeds the menu's bitmap; jump-table calls at `$1600` seed a loader and an intro).

## §2 The rule

A cross-owner seed (S2) from owner X into address A of owner Y is applied only when both hold:

1. **X's call site is real code.** The edge's provenance is `confirmed_code` (confidence
   `certain`). A heuristic render's call is recorded, never seeded.
2. **Y is the payload in A's window when X's call runs.** The runtime decides it, never a
   guess (D2): a validated edge names its target payload(s), and the seed goes to exactly
   those. Only one claimant of A's window is the trivial yes. Several claimants and no
   validated edge: not seeded.

What is not seeded stays visible: it is listed in the listing header's seed report with the
reason (heuristic caller, or the window's resident is another payload / undecided), the way
867's `outOfScope` is. The edge itself stays in the graph.

S1 (human routine) and S3 (resolved alias) are unchanged.

## §3 Open decisions

- **D1 — decided (owner, 2026-10-21): never.** A caller whose provenance is `probable_code` never
  seeds across an owner boundary, without exception. Rejected: an exception for owners with no
  confirmed code (it keeps exactly the #140 graphics-bank seed, since such a bank has none), and
  a "seed unless it splits an instruction" filter (still a byte-shape guess, contrary to 838;
  data that decodes cleanly would still seed junk routines). The way in for real code reached
  only from an unexplained bank is the same as everywhere: confirm the caller (an entry point,
  a human routine), and it seeds.
- **D2 — decided (owner, 2026-10-21): the runtime validation names the payload.** At
  disassembly the payload in the jump window may be unclear; after a runtime run it is not —
  each execution of the call has exactly one payload at the target, and over all runs that is
  a set {1, 3, n}. The trace import records it:
  - every executed `jsr`, `jmp` and `jmp (ind)` whose target lies in another payload's window
    has the target bytes matched against that window's claimants (867 D3 by bytes,
    `PayloadBytes`, not reimplemented);
  - the edge is written once per matched payload, with the payload in the target's key
    (`ram/<owner>:addr:…`), evidence = the trace and the match count;
  - no claimant matches: the edge stays on the ownerless `addr` node and says so.
- **D3 — decided with D2:** the seed reader takes, per address, the validated target set when
  there is one and seeds exactly those owners. With static edges only: one claimant = seed;
  several = not seeded, and the listing header names it ("`$3200`: target not validated,
  claimants menu / prog_a / prog_b"). Reading the loader's key (LUT row / file number) to decide
  it statically is not needed and not built.
- Replaces 867 §2's "inside my window the code is mine" for cross-owner seeds; 867's window
  and holes logic is unchanged.

## §4 Acceptance

- **S1** Synthetic fixture: a chip owner with probable-code `jsr $0814` and a stub with confirmed
  `jmp $0800`; the `$0800` analysis gets exactly one cross-owner seed, `cross_owner_jump`, and
  `$0813` decodes as `lda $DC01`; "Bytes stranded by a decode conflict" is 0.
- **S2** Synthetic fixture: two overlays sharing `$2700-$7F3F`, a resident loader with confirmed
  `jmp $3200`. Static only: neither overlay is seeded, the header names the claimants. After a
  trace import of a run where prog_a is resident: `prog_a` is seeded at `$3200`, the menu is
  not; a second run with prog_b resident adds prog_b (the set), still not the menu.
- **S2b** The trace import writes a `jmp` and a `jmp (ind)` into another window as payload-keyed
  edges; a target no claimant matches stays ownerless and is reported.
- **S3** Spec 838 and 867 smokes stay green.
- **S4** The reporter's retest on the real cartridge (issue #140 acceptance 1–3).
