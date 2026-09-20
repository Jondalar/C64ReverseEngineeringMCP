# Bug: the three BUG-056 left open, because each one moves data a project holds

- **ID:** BUG-057
- **Date:** 2026-09-20
- **Reporter:** llm
- **Area:** mcp-tool
- **Severity:** high
- **Status:** fixed

## Environment

- Branch: `fix-version-subjects`, off `545e0998`
- Surface: mcp default
- Project dir: an RE project on the Crazy News disks
- Tools: `get_current_artifact`, `list_artifact_versions`,
  `set_current_artifact_version`, `mark_artifact_version_stale`,
  `project_inventory_sync`, `register_payload`, `basic_tokenize`

## What happened

BUG-056 closed ten defects and listed three it would not touch, each for the
same reason: the fix changes how a project's persisted data is keyed or what it
contains, so shipping it means migrating what is already on disk. They are the
three here, and the migration is the fourth piece of work.

**A subject was the characters in a filename.** `subjectIdForArtifact` took the
basename, stripped the trailing `_disasm` / `_semantic` qualifier and returned
that, with the directory thrown away. On a three-sided disk project the three
`pl0_disasm.asm` under `analysis/disk/CRAZY1/`, `CRAZY2/` and `CRAZY3/` were
therefore ONE subject holding three tying versions — three unrelated listings
of three different payloads, competing for the title of "the current one". That
collapse is what filed 220 open questions in a single `project_inventory_sync`;
the tie rules added in BUG-056 made the questions stop without making the
subject right, so `get_current_artifact("pl0")` could still hand back another
disk's code, and `register_payload` stem-matched a payload to three disks'
listings the same way.

**Fixed** by deciding what the identity is. A subject is the lineage a file
belongs to: a file registered with `derivedFrom` takes its ancestor's subject
wherever on disk it now sits (`save_artifact` is the only door that sets the
field, so it is always somebody saying so), and every other file's subject is
the LOCATED stem — the directory it lives in plus the stem with its qualifier
stripped. Two sources in one directory are versions of one thing; two in
different directories are two things that share a name. A bare filename is no
longer an identity at all: the version doors answer one that names several
subjects with the list, and the caller picks. `register_payload` matches on the
subject, and falls back to a bare-name match only while that match is
unambiguous.

**`.tas` was not a listing.** `isVersionedSourceArtifact` matched
`.asm/.tass/.sym`. The renderer has written `.tas` since 2026-09-06 and `.tass`
is only what older projects hold, so every modern 64tass listing joined no
version group at all — invisible to `list_artifact_versions`, never a candidate
for current, never counted when a subject was checked for ties. **Fixed** by
widening the suffix list, and — because widening it alone would have moved
every project's current listing onto the converted copy the moment the two
generated renderings started tying — by naming the tie: the renderer writes
`_disasm.asm` and converts it to `_disasm.tas` beside it, so the KickAssembler
file is the one the conversion came from, and it wins, with the rule stated in
the answer. A HAND-AUTHORED `.tas` still outranks both, which is the case the
version model exists for.

**`basic_tokenize` had no parent-side registration.** It was the only MCP door
that produced a file and left the registering to the pipeline child, so the
PRG landed in `knowledge/artifacts.json` from the far side of a process
boundary and the parent had nothing to say when that failed. **Fixed:** the
door registers its own output through `tryRegisterKnowledgeArtifacts` like
every other one, names the knowledge run in its answer, and leads with the
NOT-REGISTERED banner instead of trailing it when the store refuses.

**And the migration.** The version groups are persisted in
`knowledge/artifact-versions.json`, keyed by subject id, so changing what a
subject id IS changes the key of every row an existing project holds. The store
now records the identity generation it was written under, and a store without
the marker is rewritten once, on the first read, before anything else sees it:
each group is re-keyed to the located subject; a group whose members now belong
to several subjects SPLITS, with the partition holding the group's current
keeping the group's id, its `createdAt` and its manual pin, and the others
becoming their own groups with their own best member as an auto current; every
member's `stale` / `missing` status survives; a member whose artifact row is
gone is kept rather than dropped; and the `.tas` listings the old suffix list
could not see are folded in as `available` members — never as the current, so
learning about a suffix cannot by itself move a project's listing. Nothing
consults the filesystem and nothing is deleted.

## What an existing project sees on first open

- Its groups are re-keyed from `pl0` to `analysis/disk/CRAZY1/pl0`, and a group
  that had collapsed three disks becomes three. Manual pins, stale marks, group
  ids and creation times come across; the timeline gets one note saying how
  many were re-keyed, split and folded in.
- Its `.tas` listings appear in the version groups for the first time, as
  available alternatives. The current listing does not move, because the
  KickAssembler rendering wins the dialect tie by rule.
- A project whose 64tass source is HAND-AUTHORED does see its current move onto
  that file — the hand-made source outranking the generated dump is BUG-019's
  rule working, not a regression.

## Fix

Gate: `npm run e2e:subject-identity` (49 checks, hermetic, in `gates.yml`) —
six fixtures: three disks' payloads are three subjects; a declared lineage
joins two directories; a `.tas` joins its group without taking the current; a
project written in the old shape is opened and asserted to come out with its
pins, stale marks, group ids and orphaned members intact and its second open a
no-op; the pure re-keying on shapes a service cannot produce; and
`basic_tokenize` over MCP stdio registering from the parent. Every block was
proved red against the unfixed source (31 failures over the six).

Existing gates carried the old behaviour and were corrected with it:
`e2e:inventory-truth` 57 (was 56) — the case that asserted eight subjects for
24 listings now asserts 24 and no tie at all; `e2e:artifact-best-version` 20
(was 17) — located subject ids, plus a check that a bare filename still
resolves while only one subject carries it.

Also green: `e2e:832-ids` 37, `e2e:tooling-defects` 87, `e2e:752` 42,
`e2e:829` 86, `e2e:bug033` 7, `e2e:disasm-family` 33, `e2e:833-render` 49,
`e2e:865` 55, `e2e:store-concurrency` 22, `smoke:740-graph` 52,
`check:mcp-product-surface`, `check:docs-current`, `test:project-knowledge`.

## Left open

Nothing.

- ~~`runCli` still lets the pipeline child register what it writes~~ — BUG-058:
  the survey was done, `propose_annotations`'s draft turned out to be the one
  output on the MCP path that only the child named (and three cartridge-menu
  doors registered nothing at either end), and the MCP spawn path now passes
  `--no-register`. A direct `dist/pipeline/cli.cjs` run keeps its writer,
  because it has no parent to register for it.
