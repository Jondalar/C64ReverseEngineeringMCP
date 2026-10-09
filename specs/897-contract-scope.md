# Spec 897 — The contract says what it is about

**Status:** BUILT (2026-10-09) — `e2e:897-scope` 26/0; open: the replay on the reporter's project (§6)
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
