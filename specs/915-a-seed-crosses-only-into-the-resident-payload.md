# Spec 915 — A code seed crosses an owner boundary only from real code, into the payload that is in the window

**Status:** PROPOSED (2026-10-21). Open decisions D1–D3, to be refined with the owner one at a time.
**Repo:** C64RE (graph code seeds in the pipeline's graph reader). TRX64 untouched.
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
- Spec 867 §2 decided: inside my own window the code is mine, whoever else wrote a node there.
  That stops the subtraction, but it also lets every co-occupant of the window seed me
  (symptom 2: the resident loader's `jmp $3200`/`$3400` seed the menu overlay; engine code at
  `$7800` seeds the menu's bitmap; jump-table calls at `$1600` seed a loader and an intro).

## §2 The rule

A cross-owner seed (S2) from owner X into address A of owner Y is applied only when both hold:

1. **X's call site is real code.** The edge's provenance is `confirmed_code` (confidence
   `certain`). A heuristic render's call is recorded, never seeded.
2. **Y is the payload in A's window when X's call runs.** The answer comes from Spec 867 D3's
   residency (the bytes, then the reading), never guessed. One claimant of the window is the
   trivial yes. Several claimants with no decision: not seeded.

What is not seeded stays visible: it is listed in the listing header's seed report with the
reason (heuristic caller, or the window's resident is another payload / undecided), the way
867's `outOfScope` is. The edge itself stays in the graph.

S1 (human routine) and S3 (resolved alias) are unchanged.

## §3 Open decisions

- **D1** Condition 1: drop heuristic cross-owner callers entirely, or keep them when the caller
  owner has no confirmed code at all (a pure probable-code owner)?
- **D2** Condition 2 with several claimants and no residency decision: not seeded (proposed), or
  seeded with a marked "ambiguous" origin so the descent still reaches it?
- **D3** "When X's call runs": the residency answers "in the window now" per address. Is the
  reading's load call (who loads Y, and is X the code that follows it) enough, or does the
  question need a per-caller relation in the graph (X runs while Y is resident)?

## §4 Acceptance

- **S1** Synthetic fixture: a chip owner with probable-code `jsr $0814` and a stub with confirmed
  `jmp $0800`; the `$0800` analysis gets exactly one cross-owner seed, `cross_owner_jump`, and
  `$0813` decodes as `lda $DC01`; "Bytes stranded by a decode conflict" is 0.
- **S2** Synthetic fixture: two overlays sharing `$2700-$7F3F`, a resident loader with confirmed
  `jmp $3200` into the one that is not resident by the reading; no seed lands in the other, and
  the header names the reason.
- **S3** Spec 838 and 867 smokes stay green.
- **S4** The reporter's retest on the real cartridge (issue #140 acceptance 1–3).
