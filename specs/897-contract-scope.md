# Spec 897 — The contract says what it is about

**Status:** BUILT (2026-10-09) — §2 + §7 D6–D9; `e2e:897-scope` green; open: the reporter's second replay
**Repo:** C64RE. From issue #39 (Mike, *The Magician's Curse*, C16 → C64).

## §1 What goes wrong

A project registers files that are references, not deliverables: the original packed PRG,
a 1988 crack kept "for reference, out of scope", a third-party port used for comparison.
They are loadable artifacts, so they sit in the denominator of both contract measures:

- S12 coverage — `src/slots/state.ts:236` counts every non-`internal` loadable artifact:
  40318 / 117597 bytes = 34.3 % over 5 artifacts.
- named ratio — every `routine`/`data_block`/`lookup_table`/`pointer_table` node, any owner:
  261 / 374 = 69.8 %, most of the unnamed ones in the third-party port.

The game the contract is about (`annotate: ["mc_orig_unpacked.prg (game image)"]`) is
99 % named and rebuilt byte-identical. The contract can still never be met.

There is no way to say which files the contract is about. `contract_set` has `slots`,
`annotate`, `documents`, the two ratios and `waive`; no tool sets `internal` on an
artifact (only the heuristic backfill in `project-knowledge/mcp-tools.ts:855`). The only
way out is `waive`, which drops the promise instead of measuring the right thing.

## §2 Decision

**D1 — `deliver.scope`.** The contract gets an optional list: which owners its measures
are about.

```json
"deliver": { "scope": ["mc_orig_unpacked.prg"], "coverageRatio": 0.9, "namedRatio": 0.9 }
```

An entry is an artifact name, path or id, or a payload name. Each resolves to the
**owner** (the file stem the graph already keys nodes on, `normStem`). This is the same
key coverage is computed per owner by (844 S12) and the named count already reads
(`nodes.owner`).

Omitted means every loadable owner, which is today's behaviour. Nothing changes for a
project without a scope.

**D2 — counted versus reported.** With a scope:
- coverage (S12), `coverageRatio`, `namedRatio` and the `orphanRatio` limit count only
  in-scope owners;
- the rest is **reported, not counted**: one line per out-of-scope owner with its own
  numbers, so nobody reading 99 % has to guess that 77 KB were set aside.

**D3 — refuse what does not resolve.** `contract_set` refuses a scope entry that
resolves to no owner and lists the candidates, the same way 848 refuses a document
demand. A scope that matches nothing would otherwise report 100 % over zero bytes.

**D4 — the reason lives in the contract.** A scope entry may carry a `why`, as
`documents` already does. The contract shows it, and so does `project_status`.

**D5 — a hint, not an implication.** When `annotate` is set and `scope` is not, the
contract report says so once: `annotate names <X>; no scope set — every loadable file is
counted`. `annotate` never widens or narrows what is counted.

## §3 Out (by decision)

- **An artifact-level `reference` flag (issue option 2).** It puts the reason on the file
  instead of in the promise. It also needs a second door, and every reader of
  `internal` must learn a third state. Owner, 2026-10-09: "nur contract".
- Scoping `slots`. A slot asks about the game, not about a file.
- An address range inside a file as a scope entry. Owner, 2026-10-09: "Nur Datei(en)".

## §4 Acceptance

- `npm run e2e:897-scope`, a fixture with two loadable owners (game + reference):
  - no scope gives today's numbers, unchanged;
  - scope = game gives the game's numbers, with the reference reported on its own line;
  - an unresolvable entry is refused with candidates;
  - `orphanRatio` and `namedRatio` follow the scope.
- `e2e:848-contract` and `e2e:844-slots` stay green.
- Replay of #39's numbers: the reporter's game image reaches its own ratio.

## §5 Refinement — settled with the owner

1. ~~Scope in the contract or a flag on the artifact?~~ **Contract only** (owner, 2026-10-09).
2. ~~Whole files or also address ranges?~~ **Files only** (owner, 2026-10-09). A range
   inside an owner would move coverage and the named count from per-owner to
   per-address, and #39 does not need it.
3. ~~Does `annotate` imply scope?~~ **No** (owner, 2026-10-09). `annotate` says what must
   be named, `scope` what is counted. Implying it would silently move the numbers of every
   existing contract on update. Instead the contract report says it (D5).
4. ~~Does a project with no contract stay unscoped?~~ **Yes** (owner, 2026-10-09). No
   contract, nobody said what it is about; the default 0.6 counts every loadable file.
5. ~~Withdraw explicitly, or retire on a scope change?~~ **Explicitly** (owner,
   2026-10-09) — D9. A withdrawal is a human decision like the waiver; a waiver must
   never vanish because something else changed.

## §6 As built (2026-10-09)

- `src/contract/scope.ts` — the one place an entry becomes an owner (`normStem`): artifact
  id, title, path or basename, payload node name, or the owner key; normal forms, never a
  substring. `formatScope` prints the scope and one line per set-aside owner.
- D2: `slotReport` (`src/slots/state.ts`) counts coverage and the named ratio over in-scope
  owners; duplicates are judged inside each class. The `coverageRatio`/`namedRatio`
  promises read the same numbers. Orphans: `modelReport(…, {owners})` and the critic's
  orphan check (both branches) are scoped; empty-boundary stays unscoped.
- Reported in `project_slots`, `contract_show`, `agent_onboard` (re-entry) — never counted.
- D3: `contract_set` resolves the scope before any write or waiver and refuses with the
  loadable files and payload names as candidates.
- D4/D5 in `formatContract`; a `deliver.scope` kickoff question.
- Gate step in `gates.yml` after 848's.

**Open:** the §4 replay of #39's numbers needs the reporter's project — asked on the issue.
**Known, not this spec:** S12's per-owner range lookup keys on the un-lowercased file stem,
so a `Game.prg` would miss its lowercase graph owner. Scope membership uses `normStem` and
is unaffected; fixing the lookup moves existing numbers and is its own change.

## §7 Amendment after the replay (2026-10-09, issue #39)

The reporter's replay found three gaps.

**D6 — an entry takes the owners its file's bytes live under (defect).** The game image is
`mc_orig_unpacked.prg` (owner `mc_orig_unpacked`, the file `disasm_prg` reads). Its
annotations carry `"binary": "mc_game.prg"`, so every name and range is imported under
owner `mc_game`, and `mc_game.prg` holds the same 14592 bytes. Scoping the file the owner
knows measured 0 %. Rule: a scope entry also takes every owner whose loadable artifact has
the same content identity (`identityOf`, the same rule S12 deduplicates by). No name
guessing.

**D7 — a payload stored inside a scoped file comes with it.** `mc_lowram` (the game's
low-RAM block, stored in the image at `$0900`, runs at `$0200`) was listed out of scope.
Owner, 2026-10-09: yes, but only through a **recorded** link, never inferred from
addresses. The recorded links are: a payload whose `sourceArtifactId` (or source PRG) is a
scoped artifact (or a content-identical one, D6); and a payload whose depacked artifact
is one. The payload's owner (`normStem` of its name, as on its nodes) joins the scope.
Without such a link the file has to be named in the scope explicitly. The scope report
says, per pulled-in owner, which link brought it in.

**D8 — `contract_show` lists lapsed waivers as if they stood (display defect).**
`formatWaivers` prints every waiver ever recorded. It now prints the active ones under
"Waived", and the superseded or lapsed ones separately, marked as such. 

**D9 — a waiver is withdrawn explicitly.** `contract_set` takes `unwaive: [<promise id>]`
with a reason. The withdrawal is appended to the record (who, when, why, via) like the
waiver itself, never by deleting it; `activeWaivers` treats a withdrawal newer than the
waiver as ending it, and `contract_show` lists it among the lapsed ones as "withdrawn". A
scope change retires nothing by itself. Unwaiving a promise that has no active waiver is
refused by name.


### §7 as built

- D6: `identityOf` moved to `scope.ts` (S12 imports it — one rule). It compares the recorded
  `contentHash`, else `lineageRoot`, else the path. Under a scope the kept copy of an
  identity class is measured against the ranges of every owner in the class.
  Without a scope too (owner, 2026-10-09): the same bytes give the same answer with or
  without a scope; an identical pair's existing numbers can only rise.
- D7: payload links read from the graph's payload nodes, `attrs.payload.source_artifact_id`
  / `depacked_artifact_id`; fixpoint over depacked artifacts; never addresses.
- D8: `sortWaivers` in `standing.ts`; `contract_show` prints "Waived" and "Lapsed".
- D9: `contract_set unwaive` (with `waive_reason`, `waived_by`); a `Withdrawal` record with
  `ends` = the waiver it ends; a timeline event `contract.unwaived`; survives `resetStanding`.
