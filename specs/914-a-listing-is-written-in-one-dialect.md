# Spec 914 — A listing is written in one dialect, chosen per file, and sources of different dialects build together

**Status:** BUILT and merged (2026-10-18): S1–S7 green in `scripts/e2e-914-dialect.mjs`, the old corpus green; the `.tas` highlight checked in the UI (owner session, demo project). Open: S8, the reporter's retest on #138. Ships with the next C64RE release.
**Repo:** C64RE (renderer, readers, rebuild proof, assemble, UI, onboarding). TRX64 untouched.
**Number:** 914 (registry: `specs/README.md`).
**Origin:** issue #138 (a 64tass project deletes the `.asm` after every render; the "Run disasm"
task never closes and the inventory lists the deleted files). Owner, 2026-10-17: "Im Grunde
aber sollten wir doch das Tool abstrahieren. Also komplett. Und auch pro Datei unterschiedliche
erlauben." and "a) in einen Dialekt übersetzt beim Disassembler b) trotzdem noch code files
eines anderen dazu mischen kann .. z. Bsp ich arbeite in .asm aber Mikes Loader und [ein
Template] ist in .tas". On an own format: no file format, an internal structure only.
**Depends on:** nothing.

---

## §1 The problem

**Who:** the LLM and the human in an RE project, who work in one assembler, and who mix in
sources they did not render: a reporter's loader in 64tass, template code in 64tass, their
own work in KickAssembler.

**What they want:** a render in the dialect they work in, and only that file. Sources in
another dialect sit beside it, are built by their own assembler, and reference each other's
labels.

**What happens today** (read from the code, 2026-10-17):

- `disasm_prg` always writes both files. The renderer builds KickAssembler text and writes
  it to `<stem>_disasm.asm` unconditionally; the 64tass file is that text pattern-converted
  by `convertKickAsmToTass` (`pipeline/src/lib/prg-disasm.ts:4811-4818`). `disasm_menu`
  writes the `.asm` only (`pipeline/src/lib/kickasm.ts:257`). `run_prg_reverse_workflow`
  hard-codes both paths (`src/lib/prg-workflow.ts:122`).
- The project setting `preferredAssembler` exists (`project_init preferred_assembler`) and
  decides only which assembler the rebuild proof uses (`src/lib/rebuild-verify.ts:33`). It is
  never asked for: `agent_onboard` and the kickoff questions do not know it.
- Readers find the listing by replacing `.asm` in a path:
  - the "Run disasm" auto-close hint names `_disasm.asm` (`src/server-tools/analysis-workflow.ts:1167`);
  - `listingAnnotationStatus` reads the `.asm` and matches `//` only (`:124`);
  - the rebuild verdict is stamped into the `.asm` banner only (`rebuild-verify.ts:168`), and the
    project status looks for that text there (`src/project-knowledge/service.ts:1848`);
  - with 64tass preferred but only KickAssembler installed, the fallback reads a `.asm` that
    may not exist and throws (`rebuild-verify.ts:33/84`).
- Already wrong without any change: `list_artifacts` hides `.tas`/`.tass` (`src/server-tools/artifacts.ts:45`);
  the UI knows `.tass` but not `.tas` as 64tass (`ui/src/App.tsx:1065`, `:3166`); `output_asm`
  ending in `.tas` writes KickAssembler text into it (`prg-disasm.ts:4811`).
- Mixing: `assemble_source` picks the assembler per file by extension (`src/assemble-source.ts:85`),
  but a unit cannot use the labels of a unit in the other dialect. A KickAssembler file cannot
  import a 64tass file, nor the reverse.

**Why it matters:** a project that keeps one dialect loses its open-task closing, its annotation
status, its rebuild status and its phase status. Every reader that hard-codes `.asm` is a place
the next dialect breaks again. And a project that mixes dialects has to copy addresses by hand.

**Parts:**

- **P1 One dialect per render.** A render writes exactly one listing in the dialect resolved for
  those bytes.
- **P2 The dialect is decided in one place.** Per file (the artifact's record), then the project's
  preference. No default: the user must choose at onboarding.
- **P3 Every reader asks for the listing, never builds a path.** Auto-close, annotation status,
  phase status, inventory, `list_artifacts`, prompts and doctrine, UI.
- **P4 The rebuild proof belongs to the listing, not to a comment in one dialect.** The verdict is
  stored on the record; the assembler is the one that matches the file's dialect; a missing
  assembler is said by name.
- **P5 Sources of another dialect build together.** Files we did not render are registered with
  their dialect and never touched; units reference each other's labels through an exported
  symbol table turned into equates of the other dialect.
- **P6 Existing projects keep working.** Listings already on disk in either dialect are read;
  nothing is rewritten.

## §2 Scenarios — what proves it is solved

```gherkin
Scenario: a 64tass project gets only the .tas, and the task closes
  Given a project with preferredAssembler 64tass
  When  analyze_prg and disasm_prg run on a PRG
  Then  only <stem>_disasm.tas exists, and its rebuild is byte-identical with 64tass
  And   the "Run disasm" task is done after the next sync
  And   no <stem>_disasm.asm was written and the inventory lists nothing missing

Scenario: one file in another dialect than the project
  Given a KickAssembler project
  When  disasm_prg runs on a payload with assembler=64tass
  Then  that payload's listing is .tas, the record says 64tass
  And   a later render of the same bytes without the argument is .tas again

Scenario: a KickAssembler unit calls into a 64tass unit
  Given loader.tas (not rendered by us) exporting label load_file, and main.asm using it
  When  the two units are assembled together
  Then  loader.tas is built with 64tass, its symbols become KickAssembler equates, main.asm is built with KickAssembler
  And   loader.tas is byte-for-byte unchanged on disk
```

| # | Solves | Scenario | Test | Where it runs |
|---|---|---|---|---|
| S1 | P1 | 64tass project: one `.tas`, byte-identical rebuild with 64tass; KickAss project: one `.asm`; for `disasm_prg`, `disasm_raw`, `disasm` with `paths`, `disasm_menu`, `run_prg_reverse_workflow` | `scripts/e2e-914-dialect.mjs` → `e2e:914` | by hand (no gates) |
| S2 | P1 | Emitters: every listing of the existing e2e corpus, rendered through the new structure in both dialects, rebuilds byte-identical with its assembler (relocated `.pseudopc`/`.logical`, split tables, equates, platforms) | `e2e:914` + the existing smokes 741, 877, 898, 903 | by hand |
| S3 | P2 | `assembler=` on a render sets the record; the next render keeps it; per-file beats project; `project_init`/`agent_onboard` refuse to go on without a choice, an old project without one is asked; a render with no resolvable dialect is refused by name | `e2e:914` | by hand |
| S4 | P3 | Task closes in a 64tass project (#138 acceptance 1); KickAss project unchanged (#138 acceptance 2); annotation status and phase status read the `.tas`; `list_artifacts` lists `.tas`/`.tass`; UI highlights `.tas` as 64tass | `e2e:914` + UI by hand | by hand |
| S5 | P4 | Verdict on the record; status reads it in a `.tas`-only project; preferred 64tass with 64tass missing: "64tass is not installed" by name, no read of a missing file; stamp in the listing in the dialect's comment syntax | `e2e:914` | by hand |
| S6 | P5 | The KickAss→64tass and 64tass→KickAss cross-unit build; the foreign file untouched (hash before/after); a label missing from the export is refused by name | `e2e:914` | by hand |
| S7 | P6 | A project rendered before this (both files on disk, no preference) opens, status and search read as before; `smoke-896-static` updated to read the `.tas` its project prefers | `e2e:914`, `smoke-896-static` | by hand |
| S8 | P1–P4 | #138 on the reporter's project, by the reporter | retest on the issue | reporter |

## §3 Decision

- **D1 Listing structure (P1).** The renderer in `prg-disasm.ts` builds a line list instead of
  KickAssembler text: label, instruction with operand as an expression, data directive, comment,
  relocation block (`pseudopc`/`logical`), segment boundary, equate. A TypeScript type, never a
  file. One emitter per dialect writes text from it: KickAssembler and 64tass. The text-pattern
  converter `convertKickAsmToTass` goes; what it handled moves into the 64tass emitter. The same
  structure serves `disasm_menu` (`kickasm.ts`), which gains 64tass.
- **D2 One resolver (P2).** `resolveDialect(projectDir, artifact?, explicit?)`: explicit argument,
  then the artifact record's `assembler`, then `preferredAssembler`; nothing else (D6). All
  render doors take `assembler=` and write the result onto the record.
- **D3 One listing lookup (P3).** `listingFor(projectDir, subject)` returns path and dialect for
  the current listing of a subject, built on `versionFormatForArtifact` and `tieContext()`
  (`artifact-versions.ts`). It replaces every `.replace(/\.asm$/…)` reader named in §1, the
  private `walkAsm` in `project-search.ts`, and the auto-close hint, which names the subject
  instead of a file. Prompts, steering, phase contract text and `docs/agent-doctrine.md` say
  "the listing" instead of `_disasm.asm`. UI: `.tas` is 64tass everywhere, the dialect order
  follows the preference.
- **D4 Rebuild proof on the record (P4).** `rebuildVerification` takes the listing and its dialect,
  assembles with that dialect's assembler, writes the verdict onto the artifact record, and keeps
  an informational stamp in the listing in that dialect's comment syntax. `checkListingRebuildVerified`
  reads the record. The temp PRG name is derived from the stem, never by replacing an extension.
  The silent fallback to the other assembler is removed: the assembler is fixed by the file.
- **D5 Mixed builds (P5).** `assemble_source` takes several units and builds them in dependency
  order: each with its own assembler, each exporting its symbol table (64tass `--labels`,
  KickAssembler `-symbolfile`), parsed into one neutral table (address, name, scope) and written
  as an equates file in the consumer's dialect, which the consumer includes. Foreign sources are
  registered with their dialect and opened read-only.
- **D6 No default; old projects (P6).** Owner, 2026-10-17: "Beim Onboarding MUSS der user sich
  entscheiden!" There is no default dialect. `project_init` and `agent_onboard` require the
  choice; an existing project without one is asked at its next `agent_onboard`. A render whose
  dialect resolves to nothing is refused, naming how to set it. Listings already on disk in
  either dialect are read through `listingFor`; nothing is rewritten or deleted.

## §4 Out

- No third dialect (ACME, ca65) in this spec; D1 makes one an emitter, built when a project needs it.
- No source-to-source translation of files we did not render. A foreign file stays in its dialect.
- No user-facing intermediate format.

## §5 Decisions taken while building

- **The pipeline CLI takes `--dialect`; without it the output name decides** (`.asm` KickAssembler,
  `.tas`/`.tass` 64tass), and a name that says neither is refused. This is the low-level door the
  MCP wrapper and the shell loops share. It also ends the old defect that `output_asm` ending in
  `.tas` got KickAssembler text. At the MCP level an explicit output name is read as an explicit
  dialect (after `assembler=`); a name that contradicts `assembler=` is refused.
- **Only a dialect the call NAMES (`assembler=`) is remembered on the file** (`ArtifactRecord.assembler`,
  on the record of the bytes, as `platform` is). A dialect the project decided, or one an output name
  implied, stays the project's. A preview (`import_graph=false`) remembers nothing, like the machine.
- **`project_init` demands the choice only when none is stored.** Re-running it without the argument
  keeps what is there (it is also the way to change the model later). `agent_onboard` asks, first
  thing, when the project has none, and records the answer when given `preferred_assembler`.
  `service.initProject` stays callable without one (fixtures, programs); the refusal is at the doors a
  person or an LLM uses.
- **The rebuild verdict lives on the listing's record** (`rebuild`: verified, assembler, line, the
  listing's sha256 at the time, when). It counts for the listing as it was measured: an edit made after
  the proof reads as "not proven". A listing no proof ever recorded on (a project from before) is read
  by the stamp in its head, in either comment syntax. A missing assembler writes no verdict.
- **An explicit `C64RE_64TASS_BIN` / `C64RE_KICKASS_JAR` is a pin**: that file or none. Before, a wrong
  value fell back silently to another binary, which is the "silent fallback" D4 removes at the
  tool level too, and what lets a test make an assembler absent.
- **The auto-close hint is a new kind, `listing-exists {source}`**, naming the bytes. `file-exists`
  hints already stored keep working.
- **`listingFor` order: the dialect on the file, the project's, KickAssembler, 64tass.** A project
  rendered before this holds both files and no preference: KickAssembler is read, as before. The
  index walker (`walkListings`) and the version tie rule follow the same order; the tie rule now asks
  the file's dialect before the project's.
- **`listingFor` shares the tie rule's order but not its code.** It reads a listing's dialect from the
  file NAME, not from `versionFormatForArtifact` (which trusts a record's `format` field first, and the
  old renderer registered KickAssembler text under a `.tas` name as `asm`), and it also finds a listing
  no record knows (a project that never registered it), which the version model cannot rank. The version
  group's tie rule (`tieContext`) gained the same per-file step, so the two agree on which spelling wins.
  `disasm_menu` has no record of the bytes to write the dialect onto: it takes `assembler=` or the project's.
- **Mixed builds are wrapper sources**: for each unit the tool writes, in the output folder, an equates
  file in the unit's dialect and a one-line-per-file wrapper that includes the equates and then the
  unit's own file, and assembles the wrapper. The foreign file is read by the assembler and never
  written (sha256 before and after). `uses` is explicit (a unit that fails on an undefined label is
  refused naming the label, and naming the unit that exports it when that unit is simply not listed).
  Only global names travel: a name inside a namespace or scope cannot be spelled the same way in the
  other assembler. Units default to `analysis/build/`.
- **"Foreign" is a registration, not a lock.** The record says `foreign-source`, the dialect, tags
  `foreign`/`read-only`; the store has no read-only flag, so nothing but the tools' own discipline (and the
  hash check) keeps a person from editing the file.
- **Listing statistics changed shape**: instruction and data line counts now count every line of the
  structure (they used to match on text and skipped lines inside a relocation block and counted
  indented comments as instructions).
- **`disasm_menu` text rows**: an `.encoding "ascii"` / `.enc "none"` line is written before `.text`
  rows, because the two assemblers' default text encodings differ. The exporter's old behaviour of
  dropping `$00` bytes from text rows is unchanged.
- **A KickAssembler block comment escapes `*/`** inside its rows; a routine comment containing it used
  to end the comment early.
- **UI**: the dialect order is a module value set from the loaded snapshot; the "asm" button reads
  `.asm`, `.tas` or `.asm/.tas` from what the sources really are.
- **Tests**: every `project_init` in the existing scripts names a dialect (`kickass`); the scripts that
  read both dialects of one set of bytes render twice (the second a preview), by `pairDialects` in
  `scripts/lib/mcp-stdio.mjs` or by a second call. The differential proof for S2 compared the new
  pipeline with the old one on 342 invocations of that corpus: KickAssembler text identical, 64tass text
  identical once comments are set aside (the old converter had folded indentation inside block comments).
