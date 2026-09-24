# Bug: the Binky run, seen from both sides

- **ID:** BUG-065
- **Date:** 2026-09-24
- **Reporter:** llm (the session under observation) + llm (the observing session)
- **Area:** mcp-tool
- **Severity:** high
- **Status:** open

The first run watched live from outside while it happened. A second session read the
project's transcripts — the parent's and all subagents' — as they were written, and
recorded what it saw; the run then filed its own field report at the end. This record is
the two put together, and the reason it exists is the part where they DISAGREE.

Nothing was sent into the run: the observation was read-only, and the run never knew it
was being watched. The one correction the human made ("only EasyFlash, no disk release")
was his own, not relayed from the observer.

## Environment

- Project: an RE project on `BINKY FIT.d64` (Snowball Effect 2026), stock D64, KERNAL
  loader, one resident image `$0801-$CFFF`
- Goal: crack + 7 trainers + an EasyFlash port carrying the TRX menu, the game and the
  README
- Shape: the parent plus five annotation subagents by address range, then research
  subagents for the cartridge toolchain
- Surface: mcp default, server built from master at `9fdb9b23`

## What the run achieved

74 minutes from "start work" to a 1 MiB EasyFlash CRT that runs on real hardware:
630 routines, 413 labels, 134 segments, both listings rebuilt byte-identical, coverage
98.1 %, all 15 slots, seven trainers verified in sandbox runs, highscores journalled into
flash banks 56-63. No protection to remove. The completion claim named what was tested
and what was not, which is the shape we want.

So this record is not about the quality of the work. It is about the path it took.

---

## A. Reported from inside — friction the run felt

Ours, and each one actionable:

1. **`runtime_sandbox_run` with a `.prg` claims "LOAD → RUN" and lands at READY.** The
   machine sits at `$E5CF`; neither `I type "RUN{RETURN}"` nor an extra wait reaches
   BASIC. Repro: `media_path` = any `$0801` BASIC-SYS PRG, steps `["I wait 100 frames",
   "I type \"RUN{RETURN}\""]`. The run worked around it by patching into a D64 copy.
2. **`I wait until the CPU reaches $X` does not fire on a polling-loop head.** The
   machine was demonstrably in that loop (PC inside the called subroutine at `$3E56`)
   while the wait on `$3F17` never triggered. Suspected PC sampling granularity.
3. **`read_memory` parses the length as HEX without saying so.** `$FC00:1018` is read as
   4120 bytes and refused. Document it, or accept a decimal form.
4. **A sandbox run past ~120 s moves to the background and cannot be re-run with a
   bigger budget, and nothing captures mid-run state.** There is no breakpoint step and
   no "dump `$xxxx:len` when the CPU reaches `$yyyy`". The run estimates that one such
   step would have saved five build-and-run iterations.
5. **The shared session belonged to another project** (Ultima VI, `projectMismatch`).
   Correctly reported — but it means monitor, breakpoints and `whowrote` were unavailable
   for this project without disturbing the human. **This is the cause of B-3 below, and
   it is why the observer's first reading of that finding was wrong.**
6. **The listing does not name addresses outside the image.** Labels for `$F2A3`,
   `$F276` and the rest are in the graph; the `.asm` still prints the bare address, with
   no equates for RAM outside the PRG. **This is the root cause of B-1.**
7. **`project_inventory_sync` does not walk a project subfolder the session created.**
   Patterns `ef/*.crt`, `ef/src/*.asm`, `ef/build/*.prg` all reported "matched no file".
   And there is no `save_artifact` on the tool surface to register the release CRT by
   hand, although the doctrine names it.
8. **The contract matches documents by boundary or artifact name only.** Documents
   registered through `doc_register` with a `covers:` range did not satisfy
   `documents: boot-chain-and-loader` until the contract items were renamed to boundary
   names. Either let a registered document's title satisfy it, or say so at
   `contract_set` time.
9. **`save_finding` with an existing id silently rewrote the finding into a refutation**,
   and the critic then reported `refutation-without-casualty`. A supersede/retire action
   would be the honest door.
10. **The heuristic analyser was wrong in several places** — a charset over GT2 patterns,
    a charset over packed level data, `code` inside music data, and code missed behind a
    self-modified JMP table. The refutation slot caught them. The run's own suggestion:
    the depacker at `$09A2` has five static call sites carrying src/dst/len, and feeding
    that into the analyser would fix the packed-data cases.
11. **Nothing said "standard GCR + KERNAL LOAD means payload registration is just the two
    DOS files".** The Spec-784 path was simply unnecessary here and S4 could have been
    filled from that fact.

## B. Seen only from outside — what the field report does not contain

Each of these was read from the transcripts as it happened. None appears in the run's own
report, and that absence is the finding.

1. **The rendered listing is used as the database: 103 shell reads against 5 `disasm`
   calls.** Counted across all six participants — 25, 19, 17, 16, 14, 12 — so it is the
   house style, not one agent's habit. Segment histograms by `grep '^// SEGMENT' | awk`,
   address ranges by `awk '/SEGMENT \$0810-/,/SEGMENT \$0A81-/'`, xrefs by regex over the
   mnemonic set — while the graph held 2815 WRITES, 2774 READS, 2319 USES_ZP and 645
   REFERENCES_DATA for this project, all seeded. The run names the cause (A-6) and never
   the scale. The parent's habit reached all five subagents within ten seconds of their
   spawn.
2. **A foreign disassembler, eight times, and a wrapper built around it.** `which da65
   dxa x64 c1541`, then `dd` a range out of the PRG and `da65 --start-addr` over it, then
   `E_da.sh START END` as a reusable script, then that script in a loop over 20
   addresses. A second agent repeated the probe ten seconds later. One of them also
   probed for `x64` — VICE, which an RE agent is not supposed to know exists;
   `check:runtime-invisible` scans 95 surfaces for the brand and cannot stop a guess at a
   binary name. **Absent from the report entirely.**
3. **The runtime is run, never entered: 21 runs, 0 `runtime_step_into`, 0
   `runtime_until`, 0 `runtime_monitor`, 0 observers.** To debug its own driver the run
   built a `step` macro writing markers to `$02F8`, grew it to preserve P/A/X and record
   the stack pointer per call, and then had to strip it back out because the
   instrumentation disturbed the EAPI flash write it was measuring. The report has this
   as "I had to build instrumented CRTs" under a missing-sandbox-step heading (A-4) — as
   friction, not as a rebuilt debugger. **Mitigating, and the observer got this wrong at
   first: A-5 means the interactive path was genuinely shut.**
4. **No door writes an annotation file, so five agents each invented one.** `genA.py`,
   `B_gen.py`, `C_gen.py`, `D_gen.py`, `E_gen.py` — five independent generators turning
   tuple lists into the JSON, not even agreeing on a filename or on address spelling,
   which the merge had to undo with `s["start"].upper().lstrip("$")`. The report lists
   the bulk import as a success, which it is, and never mentions that every writer was
   hand-rolled.
5. **The merge is a missing door, and it carried the decisions.** `merge.py`
   reimplemented the duplicate-start check the importer enforces, in order not to be
   refused by it. `merge_final.py` then held the judgements as Python literals:
   `order = ["C","D","B","E","A"]` (whose reading wins a tie), `segpref = {"82E6": "E"}`
   (two agents disagreed; E won), `rename = {("D","64BF"): "exit_door_probe", ...}`. Who
   was right at `$82E6` and why is exactly what the project exists to remember; it died
   with the scratchpad. **Absent from the report.**
6. **Editing assembly by `str.replace` cost a file.** In the run's own words: "Mein
   automatischer Umbau hat das falsche `cart_on` getroffen. Ich schreibe `drv.asm`
   vollständig neu." The Edit tool refuses a non-unique match by design; that is the
   guard the Python bypassed. Twelve minutes later the run was writing
   `assert s.count(old) == 1` into its own script — reimplementing the contract it had
   stepped around. **Absent from the report.**
7. **Silent scope creep.** A `patch_d64.py` that patches the game inside a copy of the
   D64, for a disk release that was never in the contract. The human cancelled it
   ("Habe ich einen Disketten release als Ziel ausgegeben? Also nein"). It is absent from
   the report, reasonably, because it was cancelled — but nothing in the run noticed
   before the human did. This also downgrades an observer finding: "no static door patches
   a file inside a disk image" was only missing for work that should not have happened.

**The pattern across B: friction is remembered, a detour is not.** Every item in A is a
place where a tool got in the way. Every item in B is a place where a tool was walked
past — and from the inside that feels like working, not like a problem.

## C. What the outside reading got wrong

- "It does not know it has a debugger" was too harsh. A-5 says the interactive path was
  closed for this project because the shared session belonged to another. The behaviour
  stands; the cause was a locked door, not ignorance.
- A `sed`/`grep` on documentation was twice read as a refusal, because
  `docs/annotations-reference.md` reproduces a refusal verbatim, first column included.
  Text cannot identify a refusal; the producing tool can.
- A BAM read was called a coming violation of S15 before the next step showed the run
  going to `disk_sector_allocation`'s own ownership file instead. Reading intent out of
  one code fragment is the thing this record accuses the analyser of.

## D. The two halves that explain each other

- **A-6 → B-1.** They grep the listing for `$F2A3` because the listing prints `$F2A3`.
  The names are in the graph and not in the text, so the text is searched by address. One
  missing equates pass produced 103 shell reads.
- **A-5 → B-3.** The interactive runtime was occupied by another project, so the run
  reached for in-program instrumentation and eventually disturbed what it measured.
- **A-4 → B-6.** With no mid-run capture, debugging became edit-assemble-run cycles over
  source, which is where the `str.replace` that wrecked `drv.asm` happened.

## Not ours — for the trx-crt owner

Reported by the run, listed here so the thread is not lost (details in
`binky/docs/easyflash-port-design.md`):

- `[[start]] jump=` is silently ignored; `exe=` works.
- A menu target given by path is munged (`build/x.prg` → `FBUILD/…`).
- Zero `[[file]]` rows fail to assemble — the run had to add a 3-byte dummy PRG and set
  `load = true` for a cartridge that loads nothing, and documented the reason in the TOML.
- The streamer copies len+1 bytes.

## What held, from the rounds before this one

- The version-rank tie was settled by rule with the rule and the winner named — "2 rank
  tie(s) settled by rule (identical bytes, or generated output only) — no decision
  needed" — where the same situation once raised 220 open questions.
- `project_inventory_sync` did not lead the run into registering a bulk: it reported the
  skipped files, and the run wrote a narrow `patterns` entry plus `intentional` globs.
  Caveat: this project has no 2732-file bulk, so only the safe path was exercised.
- `extract_disk` produced both PRGs byte-identical in one call and recognised the DEL
  directory-art entries.

## Left open

Everything in A and B. Nothing here is fixed yet; this record is the evidence.

The method is worth keeping: reading a run's transcripts live cost one watcher script and
caught seven things the run's own report does not contain. The watcher itself needed four
corrections to be trustworthy — a refusal must be identified by its producing tool, not
its text; offsets must live on disk or a restart skips to EOF; a file born during the
watch is the beginning and not history (the first version threw away 95 KB × 5, including
the task each subagent was given); and a tally must count the thing, not the verb.
