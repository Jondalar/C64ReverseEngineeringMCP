# Bug: ten more defects from the run that produced BUG-055

- **ID:** BUG-056
- **Date:** 2026-09-20
- **Reporter:** llm
- **Area:** mcp-tool
- **Severity:** high
- **Status:** fixed

## Environment

- Branches: `fix-store`, `fix-inventory`, `fix-doors`, all off `cbbb567d`, merged the same day
- Surface: mcp default
- Project dir: an RE project on the Crazy News disks
- Tools: `extract_disk`, `project_inventory_sync`, `agent_record_step`, `disk_sector_allocation`, `sandbox_6502_run`, `suggest_depacker`, `try_depack`, `declare_lut_descriptor`, `resolve_lut_rows`, the contract's document check

## What happened

The same autonomous run that produced BUG-055 wrote down ten further defects
outside the disassembly doors. They were fixed in three parallel branches;
BUG-055 covers the other six.

**The store could not take two writers.** Both writers of
`knowledge/artifacts.json` staged through the same fixed `.tmp` name, so two
overlapping registrations destroyed each other's staging file — six `ENOENT` on
the rename in ~590 calls at 3-6-way parallelism, once `database is locked`. One
failure was silent: `rebuild verified byte-identical` followed by
`Knowledge registration skipped: …`, and the artifact was simply not there.
Behind the temp name sat the real defect: a registration is a
read-modify-write, so a unique staging name alone would have turned the crash
into a lost row. **Fixed** with a cross-process lock around the whole
read-modify-write (one helper, byte-identical in both trees because they cannot
import each other, compared by a gate), and a registration that fails now leads
the answer with a banner instead of trailing a success. Proved by a gate that
spawns eight real pipeline children and asserts `max(start) < min(end)` — they
were provably concurrent — reproducing 6 of 8 rows landing against the old code.
It also turned up a second bug: under a symlinked project root neither side of
the relative path was canonicalised while `process.cwd()` was, so every row read
`../../../tmp/…` and the dedup key never matched.

**A file that produced nothing was counted as done.** `extract_disk`'s chain
read only an exception as failure, and the analyser refuses a load address plus
length past `$FFFF` by *returning* a blocked phase. Three files produced no
listing and were counted among the 34 done. **Fixed:** a blocked phase is a
named failure with its reason, and an item with no listing on disk fails even
when every phase claims success.

**One call raised 220 open questions.** Not "the same file from two paths" as
reported: `subjectIdForArtifact` is basename-only, so `pl0_disasm.asm` under
three disk directories collapsed into one subject whose three listings tied.
**Fixed** by deciding what a tie is — same bytes, or two deterministic
renderings of one run, are settled by rule with the rule and the winner named;
only hand-authored against hand-authored is asked. Past five genuine ties a run
files one class question. And a version question could not be closed by
anything in the repo, not even by the call the question recommends; now it can.

**The leftovers rotated.** `saveArtifact`'s "file moved" matcher fired on the
content hash alone, so registering a byte-identical second file *moved* the
existing row onto the new path; the losing path was reported unregistered, was
re-registered, and evicted the other. A permanent ping-pong, and the reason the
run saw a different set of stragglers every time. **Fixed:** a hash match is the
same file only when the matched row's own file is gone from disk.

**Two tools contradicted each other about the same files** — 840 unregistered
against 831 declared intentional — because `readInventoryDeclaration` was
imported by `project_inventory_sync` and nowhere else, while the shared
registration scan behind `agent_record_step`, `agent_onboard` and the audit had
never heard of it. **Fixed** at the shared scan, which now returns the split
every door reports. The declaration file is also validated now, in its own
words: the entry index, the value, the near miss, the allowed vocabulary.

**`disk_sector_allocation` returned three numbers** and kept the per-sector map
it had already built inside the process, and let a zero-block DEL entry claim
the directory it is stored in — seven entries × seven directory sectors were the
49 phantom overlaps. **Fixed:** the answer prints a map, names a file holding
the full ownership, and a scratched entry claims nothing. The `orphan_data` role
the type promised is now assignable, because the image is actually read.

**`sandbox_6502_run` reported no writes below `$0200`** and labelled the ones it
could show as "residue … NOT this run's output" — the opposite of the truth for
zero page and the stack, where 6502 code keeps its state. The floor is in the
runtime, which was off-limits for that round, so C64RE accounts for the low page
itself by diffing a pre-run image. Coverage is a subset of the truth, never a
superset, and the output says so.

**Closed properly the same evening:** TRX64 0.8.3 removed the floor outright —
the observer arms at the entry point instead of filtering by address, so the
harness's own set-up writes stay out without excluding a region. C64RE's second
spawn, the image diff and the subset caveat are gone; the runs below `$0200` are
the runtime's own facts.

**`suggest_depacker` and `try_depack` had no `project_dir`** and passed the file
path as the resolution hint, so a relative path resolved to the MCP repo and the
sole-onboarded-project fallback never got a chance. **Fixed:** an explicit
`project_dir` takes precedence, and a path is a hint only when it can anchor.

**A lookup table that ended at row zero said nothing** — `PROBE — first 0
row(s)` and `(no rows resolved)` — while the cause was an offset two bytes early,
onto the CBM load-address word. And `at` carried no description at all, so what
it counts from was only a code comment. **Fixed:** the stop is reported with the
row, the byte and the address, with the two classic off-by-N named, and the
schema says what an offset means per medium.

**The contract could not check a document about a medium.** An `artifact:`
demand fell into the role branch, matched no boundary, and blocked on
`model_assert` before the artifact-matching line below could run. **Fixed** in
one crosswalk that knows range, role and artifact, comparing normal forms rather
than substrings.

## Fix

Gates: `e2e:store-concurrency` 22, `e2e:inventory-truth` 56, `e2e:832-disk` 60
(was 37), `e2e:750-lut` 99 (was 85), `e2e:833-sandbox` 52 (was 28),
`e2e:848-contract`, `e2e:752` 42 (was 36). Each was proved red against the
unfixed source before it was accepted.

Two gates holding real checks — `e2e:750-lut` and `e2e:848-contract` — were in
`package.json` but in no workflow, so nothing ran them. They are in CI now.

## Left open

- `subjectIdForArtifact` is basename-only. The tie rules make it harmless, but
  `get_current_artifact("pl0")` can still hand back another disk's listing.
  Changing it means migrating persisted version groups.
- `isVersionedSourceArtifact` matches `.asm/.tass/.sym` but not `.tas`, the
  suffix the renderer has written since 2026-09-06, so modern 64tass output
  never joins a version group.
- `basic_tokenize` is the only MCP door with no parent-side registration, so the
  pipeline child cannot stop writing the store until that is built.
- ~~`src/lib/prg-workflow.ts` carries BUG-055's positional slot shift~~ — fixed
  the same day: the L2 auto-chain passes the analysis by name (`--analysis`).
