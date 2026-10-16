# Spec 905 — From an anchor to the build: try variants in parallel, keep the one that works

**Status:** BUILT and merged (2026-10-11): C64RE half on master, TRX64 half released in TRX64 0.13.0, C64RE 0.9.0 pins it. Open for the owner's by-hand loop on a real project. **Replaced in part by 911** (branch spec/911, not merged): the runner — `runtime_candidate_create` / `_variant` / `_run` with an input list and a cycle budget — is gone; a feature file with variant lines runs the fixes. The anchor doors and `_choose` / `_derive_delta` / `_verify_build` stand.
**Repo:** both. TRX64: a sandbox run plays inputs; the candidate RPCs go. C64RE: anchors as
doors and in the workbench, the candidate as project memory, the parallel loop, the way into
the build.
**Number:** 905 (registry: `specs/README.md`).
**Origin:** owner, 2026-10-11, restating what sandboxes, scenarios and the ring were for:
*"Ich definiere einen Ankerpunkt im Ring/Stream. Ab hier kann ich verschiedene Pfade gehen —
in Kombination mit Code-Overlay schnell verschiedene Ansätze parallel in Sandboxes iterieren —
am Ende die Lösung in den Code überführen und damit in den Build."*
**Supersedes:** 884 (ring marks in C64RE) — its D1–D4 are D1/D2/D6 here and its three open
questions are decided in §3. 884 is closed with this spec.
**Depends on:** TRX64 809 (marks, isolated sandboxes, `asm/block`, `component_diff` on sandbox
ends — all built), 794–798 (overlay, candidates, delta), 901 (inputs at a cycle).

---

## §1 The problem

**Who:** the owner at the workbench and the LLM in a session, together on one shared machine.

**What they want to do**, one loop:

1. Stop at an interesting instant — just before the level loads, the frame before the sprite
   goes wrong — and **name it**, so they can come back.
2. From there, **try several fixes at once**: each a few lines of source as an overlay, each
   run with the same inputs for the same time, on machines of their own, while the shared
   machine stays where it is.
3. **Compare** what each variant did against the run without any patch.
4. Take the variant that works **into the project's source and build**, and know the build
   really contains it.

**What happens today** — read from the code on 2026-10-11:

- **Step 1** has no door. TRX64 has named marks (`mark/set|list|drop|goto`, 32 at most).
  C64RE calls none of them. `runtime_checkpoint_pin` pins by number only. `runtime_mark` is
  something else: it writes a phase label into a running trace and cannot be returned to.
  The Trace tab's bookmark panel calls `listBookmarks`, which no daemon has, and is always
  empty (`ui/src/workbench/tabs/Trace.tsx`).
- **Step 2 moves the shared machine.** `runtime_candidate_run` → TRX64 `run_candidate`
  (`crates/trx64-daemon/src/main.rs`) restores the anchor into **the live session**, applies
  the patches there, plays the scenario there and leaves the machine in the patched end
  state. The C64RE description says "Ephemeral … Not for a run on the shared session" — the
  opposite of what the code does. It is also one candidate at a time.
- **The parallel run exists and is unused.** TRX64 `sandbox/runMany` clones the machine per
  run, from a mark name or an anchor id, as many at once as the host has cores, and returns
  each end state as `sb-r-NNNN`, which `runtime/component_diff` accepts. C64RE never calls it
  (`runtime_sandbox_run` is a different thing: a private daemon process for a whole medium).
  But a sandbox run takes only `patches` and `cycles` — **no inputs**: the scenario player's
  target wraps the session (`MachineScenarioTarget { session }`), not a machine.
- **Step 3** is built for candidates (auto-diff against the no-patch baseline), only on the
  wrong machine.
- **Step 4** stops at files. `runtime_candidate_derive_delta` writes one `.asm` per target with
  its own `org`, `delta-manifest.json` and `DELTA.md` into `<project>/delta-<id>`. Nothing
  checks that the project's build then contains those bytes.
- **The candidate is forgotten.** Candidates live in the daemon's memory (`st.candidates`).
  A restart loses which patches were tried, from where, and what each did — the very record
  of the iteration. By the Leitregel that record is meaning and memory, so it belongs in C64RE.

**Why it matters:** this loop is what the ring, the sandboxes and the scenarios were built for.
Every piece exists; the loop as a whole does not, and the one part that does run disturbs the
machine the owner is watching.

## §2 Scenarios — what proves it is solved

```gherkin
Scenario: S1 name the instant
  Given a session running on the shared machine
  When  the LLM sets anchor "vor_level3"
  Then  it is listed with its cycle and frame, in MCP and in the workbench filmstrip
  And   the shared machine's cycle count and run state are unchanged

Scenario: S2 go back to it
  Given anchor "vor_level3" and a machine that has run on
  When  the owner goes to "vor_level3" (workbench or MCP)
  Then  the machine stands paused at that anchor's cycle
  And   the MCP door's description says it moves the shared machine

Scenario: S3 three fixes at once, shared machine untouched
  Given anchor "vor_level3", a candidate with an input script and 3 variants of source
  When  the candidate is run
  Then  4 runs come back — the baseline without a patch and the 3 variants — each with
        registers, cycles and a verdict against the baseline
  And   they ran on clones in parallel
  And   the shared machine's cycle count, registers and run state are byte-for-byte unchanged

Scenario: S4 the inputs are played in the sandbox
  Given a variant whose effect shows only after a joystick press at cycle N
  When  it is run from the anchor with that input script
  Then  its end state differs from the baseline exactly where the press acts
  And   the same script with the press removed gives the baseline's end state

Scenario: S5 the iteration is remembered
  Given a candidate with 3 variants and their verdicts
  When  the daemon is restarted and the project reopened
  Then  the candidate, its anchor name, its variants' source and their last verdicts are listed
  And   running it again (anchor still in the ring, or re-set) gives the same verdicts

Scenario: S6 the winner goes into the build
  Given variant 2 marked as the solution, and a project with a build command
  When  the delta is derived and the project is built
  Then  the built image holds variant 2's bytes at every target address
  And   a build that does not contain them is reported as not containing the solution,
        naming the first differing address

Scenario: S7 the old door no longer exists in a form that moves the machine
  Given TRX64 at the version this spec pins
  When  anything calls `runtime/candidate_run`
  Then  the call is refused by name, pointing at `sandbox/runMany`
  And   no MCP tool calls it

Scenario: S8 refusals are the daemon's, verbatim
  Given 32 anchors set
  When  a 33rd is set
  Then  the answer is the daemon's refusal text, not an empty success
```

| # | Test | Where it runs |
|---|---|---|
| S1–S5, S7, S8 | `scripts/e2e-905-anchor-loop.mjs` → `e2e:905`, against a real `trx64-daemon` (own port, synthetic PRG via `scripts/lib/asm6502-mini.mjs`) | `gate.sh` + `gates.yml` Linux; Windows job if it runs daemon e2e |
| S3/S4 runtime half | TRX64 daemon test: `sandbox/runMany` with `inputs`, live machine untouched | TRX64 pre-push gate |
| S6 | `e2e:905` with a tiny project whose build is a KickAssembler call (skips loudly without KickAssembler, like `e2e:866`) | `gate.sh` + `gates.yml` |
| S2/S1 workbench half | UI smoke the way other workbench smokes run (mark set over MCP appears without reload; set in the workbench, listed over MCP) | `gate.sh` |
| by hand | the owner's loop once on a real project: anchor, 3 variants, winner, build, run the built image | — |

## §3 Decision

**The three questions 884 left open, decided:**

- **Name.** The owner's word is *Anker*, so the doors are `runtime_anchor_set`, `_list`,
  `_drop`, `_goto`. `runtime_mark` keeps its meaning (a label in a trace) and its description
  says it is not an anchor. Nothing is renamed, no caller breaks.
- **Memory.** An anchor in the ring dies with the daemon; what it *meant* does not. Setting an
  anchor in a project records a graph node (name, cycle, frame, why) that outlives the ring.
  Going to an anchor that the ring no longer holds says so and names the recorded cycle.
- **Which instant.** `mark/set` marks the transport cursor's anchor (up to ~20 ms old).
  `runtime_anchor_set` captures a fresh checkpoint first and marks that, so the anchor is the
  instant the caller saw. (TRX64 `mark/set` already resolves the cursor; C64RE calls
  `checkpoint_capture` then `mark/set` — no TRX64 change for this.)

### TRX64

- **T1 — a sandbox run plays inputs.** Each `runs[i]` in `sandbox/run(Many)` takes `inputs`
  (the scenario input list as candidates use it, cycles relative to the anchor) next to
  `patches` and `cycles`. The scenario player gets a target over a bare `Machine`; the
  session-bound target delegates to it, so a scenario means the same thing live and in a
  sandbox. Disk swaps inside a sandbox act on the clone's media (the copy-on-write folder).
- **T2 — the candidate RPCs go.** `runtime/candidate_*` and `run_candidate` are removed; a call
  is refused by name pointing at `sandbox/runMany`. Removing RPCs is breaking → TRX64 minor
  release. C64RE pins it (`REQUIRED_TRX64_VERSION`).

### C64RE

- **D1 — anchor doors.** The four tools above over `mark/*`. Set, list and drop disturb
  nothing; goto moves the shared machine, and its description says so in the words the
  `runtime_session_*` family uses. A name is accepted wherever an anchor id is taken
  (`runtime_checkpoint_restore`, `_pin`, `_unpin`, `runtime_overlay_run`, the candidate
  doors), each door measured, not assumed.
- **D2 — the candidate lives in the project.** `knowledge/candidates/<id>.json`: anchor name
  and anchor id, input script, cycle budget, variants (each: name, source per target, the
  assembled bytes, last verdict, last end-state id), the chosen variant. Graph: the candidate
  is linked to its anchor node and, once chosen, to the delta artifact.
- **D3 — one run = baseline + all variants, in parallel.** `runtime_candidate_run` assembles
  each variant (the project's assembler, as `runtime_candidate_patch` does today), sends ONE
  `sandbox/runMany` — run 0 without patches, runs 1…N with them, all with the same inputs and
  budget — then diffs each end against run 0 with `runtime/component_diff` (equivalence preset)
  and stores the verdicts. Returns a table: variant, cycles, verdict, what changed.
- **D4 — tools.** `runtime_candidate_create` (anchor name, inputs, budget),
  `runtime_candidate_variant` (add/replace/remove a variant: name + source per target),
  `runtime_candidate_run`, `runtime_candidate_list`, `runtime_candidate_choose` (mark the
  winner), `runtime_candidate_derive_delta`, `runtime_candidate_delete`. `_patch`,
  `_remove_patch` and `_export` fold into `_variant` / `_list`; their names stay as aliases
  that answer with one line naming the successor (the 866 pattern).
- **D5 — into the build.** `runtime_candidate_derive_delta` writes the chosen variant as today
  and registers the files as artifacts linked to the candidate. A new check,
  `runtime_candidate_verify_build`: runs the project's build command (`profile.build`), reads
  the built image (PRG, CRT bank, raw), and compares the bytes at every delta target with the
  variant's bytes. Green names each target; red names the first differing address. The
  build command runs the way the project's build pipeline already runs it
  (`src/project-knowledge/service.ts`, the one place a user's own command line is allowed a
  shell).
- **D6 — the workbench.** The filmstrip shows anchors on their frames, sets one on the
  selected frame, and goes to one; the transport line shows `nearestMark`. The Trace tab's
  bookmark panel becomes the anchor list; the dead `listBookmarks` call goes.
- **D7 — docs.** `docs/runtime-sandbox.md` gets the loop end to end, with the anchor →
  variants → verdicts → delta → build example from S3/S6. The agent doctrine names the loop
  where it names overlays today. No spec numbers in user docs.

## §4 Out

- Choosing the winner automatically. The verdict says what changed; which change is right is
  the reader's call (810's scenario goals can later say it).
- Editing the project's own source files. The delta is written beside them and verified in
  the build; wiring it into the build script is the project's.
- Anchors on the C64 Ultimate bridge. The bridge routes `mark/*` already; whether the device
  side can clone for a sandbox is 889's question, not this one.

## §5 Decisions taken while building

Where the spec was silent, or where measuring the code showed the decision could not hold as written.

- **An anchor is only set at the head of the ring.** `mark/set` names the checkpoint under the transport
  cursor, and a second name on a checkpoint *replaces* the first (measured on the daemon: after a goto, a
  new `runtime_anchor_set` silently renamed the anchor just gone to). So `runtime_anchor_set` asks
  `transport/status` first and refuses while the machine stands in replay, naming the way out
  (`runtime_monitor goto <last frame>`, measured to return the transport to the head). The workbench's
  `setAnchor` follows the same rule, and names a clicked frame by putting the cursor on it first and
  refusing a frame that already carries a name.
- **D1, unpin.** The ring resolves a name for pin, restore, overlay_run, `sandbox/*` and `component_diff`
  (each measured in `e2e:905`), but `checkpoint/unpin` refuses a name by design — an anchor holds its own
  pin, released with `runtime_anchor_drop`. The unpin description says so; it is not made to accept names.
- **The graph record.** Subsystem-form ids (they carry no address): anchor `<slug>:sub:anchor.<name>`, candidate
  `<slug>:sub:candidate.<id>`, kinds `anchor` / `candidate`, a human-layer `STARTS_FROM` edge candidate →
  anchor. Names are fitted to the id grammar (hash suffix when changed). Both kinds are left out of the
  entity/routine listings (three queries in `records.ts`), because every entity counts as a knowledge record
  and an anchor was enough to engage the S11 slot gate on an otherwise empty project. A dropped anchor keeps
  its node, marked dropped (candidates link to it).
- **Delta ↔ candidate link.** An artifact id is not a graph id, so there is no edge to it: the candidate file
  and node carry the artifact ids, and the artifacts carry the tag `candidate:<id>` (+ `variant:<name>`).
  A target given as bytes (no source) is written to the delta as `* = $addr` + `.byte` lines.
- **Verdicts mask the variant's own bytes.** A patch always differs from the baseline in RAM where it was put;
  counting that makes "same as baseline" unreachable. `component_diff` is called with the variant's RAM
  targets as exclusion ranges (plus the equivalence preset), so the verdict is about what the code caused.
  Cartridge targets cannot be masked this way (the runtime's range spaces are RAM and drive memory).
- **A run with inputs on a runtime that does not play them is refused, not stored.** Detected by the absence
  of `inputsPlayed` in the baseline's answer. The table reports inputs played/skipped.
- **A variant** is its whole target set: setting a name again replaces it and clears its verdict (unless the
  targets are unchanged). A source's own `* =` must equal the target address or the call is refused — the
  delta and the build use the source's org. Inline source and assembled PRGs live in
  `knowledge/candidates/<id>.build/`.
- **`runtime_candidate_verify_build`.** Image: `image`, else the first of `profile.build.outputs` (tried
  relative to the build's cwd, then the project). Format from content (CRT header) or `.prg`, else raw with
  `raw_load_address`. `skip_build` checks an image already built. The command runs through a new
  `ProjectKnowledgeService.runProfileBuild()` — the one file allowed a shell. A failed build is reported as
  failed and the image is not checked.
- **Aliases** (`_patch`, `_remove_patch`, `_export`) answer one line and do nothing; they are not in the
  disasm alias ledger (`ALIAS_SUCCESSOR`), whose once-per-session notice is specific to that rename.
- **Default surface 195 → 202** (cap raised with the reason in `tier-tools.ts`); the three aliases leave
  after a release and it goes back to 199. `runtime_inject_range` is rewritten onto a variant target
  (`candidate_id`, `variant?`, default `inject`); the S11 slot gate moved from `runtime_candidate_patch` to
  `runtime_candidate_variant`.
- **Candidate tools take no `session_id`:** a run talks to the shared daemon, nothing else is session-bound.
  Ids default to `cand-N`.
- **Workbench.** Anchors on the filmstrip (badge on the frame, chips to go to / drop, set on the selected
  frame or on the present instant, the transport line with the nearest anchor), polled every 2 s, so an
  anchor set over MCP appears without a reload. The Trace tab's bookmark panel (and its component) is
  replaced by the anchor list; the dead `listBookmarks` call is gone.
- **Tests.** `e2e:905` runs S6, the descriptions and the aliases on any runner (a build script in node;
  the real KickAssembler case skips loudly) and S1–S5, S7, S8 against a daemon of its own (skips loudly
  without one; checks that need T1/T2 are labelled and fail against an older runtime). `smoke:905` is the
  workbench smoke. Both are in the Linux job of `gates.yml`; the Windows job is not given them — the build
  script and paths are not verified there.
- **Left as it was:** `src/runtime/c64u/routing.ts` still lists the `runtime/candidate_` prefix among the
  methods the C64U bridge refuses; with the RPCs gone it is a harmless leftover. `REQUIRED_TRX64_VERSION`
  stays 0.12.10 until the TRX64 release exists.
