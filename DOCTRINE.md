# Doctrine

The rules that govern work in this repo, and **why** they exist.

`CLAUDE.md` carries the rules themselves, one line each, because it is loaded into
every session automatically — that is its value and its cost. This file carries the
reasoning, the history, and the rules that have since been retired. Read it when a rule
is not obvious, when you want to change one, or before arguing with one.

Retired doctrine is kept here rather than deleted. A rule that was binding for two
months explains code that still exists; deleting it makes that code look arbitrary.

---

## Still binding

### One Machine Per Process (session isolation)

This is about *how many* machines exist.

The runtime core is **single-machine-per-process** — a deliberate design property it
shares with VICE, whose emulator state also lives in file-scope globals.

**One daemon process = exactly ONE live machine, shared.** Human and LLM co-drive the
same session. Every start path attaches to the machine that daemon already has rather
than constructing a second. Callers must not cold-reset an attached session; only a
freshly started daemon cold-boots. A disk requested on attach is not auto-mounted.

- Need an **isolated** machine? Use a **separate backend process** — spawn
  `trx64-daemon --port <own>` and drive it over raw WebSocket
  (`docs/runtime-sandbox.md`). Never power-cycle the shared one to make room for a
  test. The MCP `runtime_*` tools cannot give you isolation: they are pinned to one
  port and attach by design.

*Scope note (2026-08-12, Spec 806): the C64RE-side half of this rule is now enforced by
construction rather than by a gate. C64RE has no machine to build — the in-process
TypeScript emulator, its session manager and `startIntegratedSession` are deleted, so
"do not construct a second session in the MCP process" describes something that is no
longer expressible. `scripts/probe-session-isolation.mjs` went with them; it drove two
in-process sessions and diffed their rendering. The rule stays because it still governs
TRX64, where the property is real and the hazard is the same one.*

### Traces belong in a store, never in a one-off script

**Trace broadly, abundantly, into the trace store.** Capture every relevant event family
for the whole window of interest and let the query filter — do not downsample at capture
time, because the event you did not capture is the one you need.

A `console.log` or a quick `node -e` PC dump is a **debug primitive**, not a trace. Once
a hunch is confirmed, switch to a real capture before continuing. Diff two runs with a
query, not by reading JSONL side by side.

### Read before you hypothesise

Kept as *technique* after the doctrine it came from was retired, because it was the part
that actually worked:

- Read the reference implementation end-to-end **before** tracing, profiling or
  step-debugging. State that you did.
- For a divergence, report the **first** one and the window around it. Not statistics,
  not hotspots, not top-PC buckets — those answer "where is time spent", not "where does
  this differ".
- Suspect the conversion before the algorithm. The recurring families: missing mask
  after arithmetic, signed/unsigned mixup, lost sign-extension, pre/post-increment
  order, unexpanded macro, dropped file-scope `static`, wrong `#ifdef` arm, guessed
  operator precedence, array-to-pointer decay, implicit widening.

The 2026-05-17/18 session that burned eight hours on a core hypothesis while the bug sat
in the port is why this is written down.

### API first

Every feature lands first as an MCP tool, library call or endpoint, with smoke
coverage. UI follows once the API is stable. Do not block API work on UI design; do not
ship UI without the API underneath.

### Spec-driven flow

`PLAN.md` → a spec under `specs/` → implementation. The spec board
(`specs/README.md`) is the registry, and its numbers are **shared across C64RE and
TRX64** — a new spec in either repo takes the next free number there.

### After a build, the spec and the docs are brought in line

Always, and in the same commit as the change or the one after it. The spec's own
`**Status:**` line, its row in `specs/README.md`, and any doc that asserted the old
state. What is finished moves to `specs/_archive/` carrying the decision that closed it.

**Why this is a rule and not a nicety.** On 2026-08-11 nine specs were closed in one
evening and not one of them needed building: seven were already finished — sometimes
weeks earlier, sometimes by work in the other repo — and two described code that no
longer existed. The cost was not the cleanup. It was that for months the board answered
"what should I work on?" with a list that was substantially wrong, and nobody could tell
which entries were real without reading the source.

The specific failures, kept because they are the shape to watch for:

- **726** recorded at line 25 of its own body that its remaining slice shipped on
  2026-05-30. The board carried that same slice as open for ten weeks.
- **794–798** carried `**Status:** PROPOSED` in their files while the board listed them
  DONE. Two records of one fact, neither checked against the other.
- **784** still says "PROPOSED (ready for build)" while `register_payloads_from_manifest`,
  `validate_extraction`, `runtime_loader_lens` and `medium-coverage.ts` all exist.
- **622** and **424** described a runtime mode and a UI column that later work had
  deleted — the spec outlived its subject.

Deleting is part of it. Marking something ÜBERHOLT and leaving it in place produces a
document where everything is still there and nothing is findable: five retired doctrine
blocks were being loaded into every context window before this rule existed.

### Project work: the agent rules

Inside a real RE project (a `C64RE_PROJECT_DIR` workspace, not this repo):

1. Load `docs/agent-doctrine.md` (or the `c64re_agent_doctrine` prompt) and adopt it.
2. `agent_onboard` at session start, or after context loss.
3. Persist with `agent_record_step` and the `save_finding` / `save_entity` /
   `save_open_question` family — never leave knowledge only in chat.
4. Update the wiki layer by hand while 740.2 is pending: the closest `docs/*.md`,
   `docs/index.md` for new topics, `knowledge/activity-log.md` for the decision, then
   `project_reindex_search`.
5. `project_search` / `project_find_related` before re-deriving what is already known.
6. `agent_set_role` — analyst, cartographer, implementer, archivist, cracker, unset.
   Only analyst and cracker change phase-gating; the rest bias ranking.

Seven-phase workflow (Specs 034 + 035): extraction → loader → heuristic disasm →
segment analysis → semantic V1 → meta connections → semantic V2. See `docs/re-phases.md`.

These apply to project work, not to ordinary edits in this repo.

---

## Retired 2026-08-12 — Single-Path Runtime (Spec 723)

**What changed:** the TypeScript emulator was deleted (Spec 806). Spec 723 governed
*that* runtime — which CPU, which scheduler, which VIC, which drive, and the absence of
a flag to pick another. With the subject gone there is nothing left to be single-path
about on this side: C64RE has no execution path at all, it has a client. The rule that
replaces it is simpler and is already in `CLAUDE.md`: **one runtime, and it is a
separate process.**

**What went with it:** `scripts/probe-single-path.mjs`, the gate that enforced all
25 assertions below. Its last run before deletion was GREEN — 25 pass, 0 fail — so
nothing was carried out under a red gate. The `npm run probe:single-path` entry and
its slot in `check:surface` are gone; `npm run check:1541-fidelity` went the same
way, because `vice1541/**` no longer exists to check.

**What survives, in TRX64:** the *principle*. A second execution path is still a second
execution path, and TRX64 carries its own gates (Spec 783). If a mode/toggle/flag ever
appears there that picks an alternate CPU, scheduler, VIC or drive, this is the argument
against it.

The text below is the retired rule, kept because it explains why the code looked the way
it did and what must not be reintroduced.

### The rule as it stood

**The runtime has exactly ONE execution path. There is no mode or toggle picking an
alternate one.** `startIntegratedSession({})` gives the product path with no flags:

- **C64 CPU = `Cpu65xxVice`** (microcoded). The legacy `cpu6510.ts` interpreter is gone;
  there is no `useMicrocodedCpu` toggle.
- **Scheduler = event-catchup**, not cycle-lockstep. `CycleLockstepScheduler`,
  `LockstepStrategy`, the `*Cycled` wrappers and `bus-owner-table` are deleted; there is
  no `useCycleLockstep` flag. The drive advances via pushFlush →
  `drive1541.tickToClock` at IEC events.
- **VIC = literal port** (`vic/literal/**`), driven per cycle from the CPU's `tick()`.
  The batched `VicIIVice.tick()` path, `computeLineSteal()` and `stealCpuCycles` are
  gone. `VicIIVice` still owns register R/W, IRQ and scanline capture for the
  rasterized renderer; the literal port is the authority.
- **1541 drive = VICE1541** (`drive1541/vice1541-facade.ts`). No implementation
  selector, no `fast-trap` / `real-kernal` modes, no KERNAL trap layer — the real
  KERNAL runs end to end.
- **No standalone `HeadlessSessionManager`** start path.

**Protected, do not merge into the C64 core:** the 1541 drive CPU is its own 6502
(`vice1541/drivecpu.ts` + `drive_6510core.ts`), distinct from `Cpu65xxVice`.

**Debug-only, never product:** `debug-vice-compare` (true-drive plus trace channels).

`scripts/probe-single-path.mjs` enforces all of it. **Do not reintroduce a removed
flag to make a test pass — retire the test.** Fidelity tests must not keep a dead
runtime path alive.

*Scope note (2026-08-11): this governs the TypeScript runtime, which is now the
fallback and parity oracle rather than the product path. It stays binding because the
code is still there and a second path would still be a second path.*

---

## Retired 2026-07-15 — VICE and the TS runtime as authority

**What changed:** TRX64 became standalone and authoritative. The TypeScript runtime was
demoted to a fallback and parity oracle; VICE became an occasional *Vorlage* — a
reference to consult — and no longer a mandate. "It must match VICE exactly" stopped
being binding.

**Completed 2026-08-12 (Spec 806).** Both halves are now gone rather than demoted: the
TypeScript emulator is deleted, and so are the 49 `vice_*` MCP tools and the
binary-monitor bridge under `src/runtime/vice/`. VICE survives as a *source tree to
read* (`docs/vice-c64-arch.md`, `docs/vice-1541-arch.md`, `docs/vice-iec-arc42.md`
and the checkout they describe) — never as something C64RE launches, talks to, or
compares against.

**What replaced it:** TRX64's own gates (Spec 783, local quality-gate enforcement).
Regression protection comes from there, not from an oracle comparison.

**What survived:** the techniques, above. Reading first, first-divergence over
statistics, faithful naming when porting. Those were never really about VICE.

The four blocks below are the retired text. They no longer explain code in this tree —
that code is deleted — but they explain the equivalent code in TRX64 and the shape of
the mistakes that produced it.

### Runtime Proof Gates (Spec 715) — retired as the authority

The "is this green" authority was the Runtime Product Proof Baseline
(`specs/_archive/715-runtime-product-proof-baseline.md`, runner
`scripts/runtime-product-proof.mjs`, tag `runtime-product-green-2026-05-24`), with a
7-game gate set — motm, MM s1, IM2, LNR s1, Scramble, Pawn s1, Polarbear — plus
SAVE/FORMAT gates, as the acceptance bar for anything touching the renderer, the IEC
bus, the 1541 or the disk image layer. "Unit green != runtime green" was the slogan.

Superseded by 783 for the *oracle* role. The oracle PNGs under
`samples/screenshots/proof/` still describe what correct output looks like.

Specs 440–452 were declared research notes only; that still holds.

### VICE traces — secondary, on demand only

VICE-binmon traces were never the primary merge gate; they explained *why* a proof gate
failed. Capture was allowed only on a failing gate, timing-sensitive 1541 work,
first-divergence evidence, or a spec claiming cycle parity. Compare boundary lanes
first (`c64_pc`, `drive_pc`, `$dd00`, IEC ports, VIA1 `$1800`, VIA2 `$1c00`/`$1c01`,
`byte_ready_edge`, `GCR_read`, `head_halftrack`), report the first divergence and about
twenty events around it, and land no patch before it is identified.

### 1541 Port Fidelity (Spec 612)

Four port attempts drifted because every C indirection was "cleaned up" into a class, a
closure or a discriminated union: the new abstraction read better and the boundary
behaviour diverged, while unit tests asserted the abstraction rather than the reference.

The answer was a naming law — one C file to one TS file, one function to one function
with the name verbatim in snake_case, struct fields verbatim, macros as consts — and a
prohibition list: no class wrapping a struct, no discriminated union where C branches on
an int, no Factory/Manager/Builder inside the port, no shared CPU core between C64 and
drive, no helper that does not exist in the reference, no clock indirection shortcut, no
silent fallback where the reference errors, no init-order change, no invented snapshot
format, no duplicate port of one file. Commits touching the port cited the rule numbers.

Rules: `specs/_archive/612-1541-port-fidelity-rules.md`. Task list: `specs/612-…-todo.md`.
The gate `npm run check:1541-fidelity` walked `src/ts-emulator/vice1541/**` and went
with it (Spec 806). The naming law is what to reach for if a port is ever attempted
again — in TRX64, against the same C.

### Port-Bug Forensics (Spec 620)

Bugs suspected in the port were held to be 99% conversion errors rather than algorithmic
divergence, with a reading-first law stated in chat before any trace, differential tests
against the compiled C for every ported function, and first-divergence traces rather
than statistics. `specs/_archive/620-port-bug-forensic-doctrine.md`.

### Headless over VICE

"Default to headless for every workflow, tool, skill and agent action; VICE is fallback
and oracle only." Now moot in that form: **there is no VICE in the loop**, and "headless"
means the TRX64 daemon. VICE is invisible on the RE surface by design — do not propose a
VICE-side capture as an investigative step.

---

## Stale references, noted rather than silently carried

Named here so nobody spends time looking for them:

- **Deleted with the emulator (Spec 806, 2026-08-12).** Archived specs 612 / 620 / 722 /
  723 / 726 cite audits that are gone with their subject:
  `docs/single-path-callers.md`, `docs/debug-mode-prune-audit.md`,
  `docs/vic-legacy-toggle-audit.md`, `docs/drive-legacy-residue-audit.md`,
  `docs/headless-trace-sink-audit.md`, `docs/headless-runtime-namespace-audit.md`,
  `docs/tools/vice.md`. So are the gates `probe-single-path`,
  `probe-session-isolation`, `check:1541-fidelity` and the whole `proof:*` family.
  Everything under `src/ts-emulator/`, `src/runtime/vice/` and `tests/unit/**` is
  reachable in git history only.
- **`vice-arch-port`, `codex/1541-runtime-gates`** — branches gone. The arch-port
  doctrine that required a §-anchor in `docs/vice-c64-arch.md` /
  `docs/vice-1541-arch.md` / `docs/vice-iec-arc42.md` went with them.
- **`quarantine/1541-literal-vice`** — still exists, still quarantined. Do not advance,
  do not merge; cherry-pick `-n` only.
- **`specs/4XX-*.md`** — the old numbering the working process pointed at. Specs are in
  the 700–800 range now and the board is the registry.
