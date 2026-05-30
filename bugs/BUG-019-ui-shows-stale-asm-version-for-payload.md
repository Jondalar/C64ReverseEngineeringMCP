# Bug: UI shows stale ASM version instead of latest/best artifact version

- **ID:** BUG-019
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** workspace-ui / knowledge
- **Severity:** high
- **Status:** fixed — Part A (best-first ordering) + Part B (artifact version store + unified best-version resolver, Spec 730 §7)

## Environment

- Branch / commit: 425e7a0
- Surface: workspace UI
- Project dir: `/Users/alex/Development/C64/Cracking/Wasteland_EF`
- Tool / endpoint / tab: Disk tab → file inspector → `.asm/.tass` action

## What happened

The Disk file inspector resolves a payload's assembler action to the stale/static
generated `.asm` version. A newer hand-created `.asm` file exists in the project,
but it is invisible from the UI. The user therefore sees or opens the wrong
version of the payload/artifact.

## Expected

The UI should resolve an artifact/payload/file reference to the current best
version by default. If multiple versions exist, the product UI must make the
version choice explicit and should prefer the latest/best/curated artifact over
stale generated output.

## Repro steps

1. Open the Wasteland EF project in the workspace UI.
2. Open the `Disk` tab.
3. Select disk file `02_2.0.prg`.
4. Use the inspector's `.asm/.tass` action.
5. Observe that the UI opens the old/static KickAssembler disassembly instead
   of the newer semantic 64tass artifact.

Minimal command / call:

```text
UI: Disk tab -> select 02_2.0.prg -> inspector .asm/.tass
```

## Evidence

- Error / output (verbatim):

```text
das ist die falsch Version .. hier zeigt er die Staische .asm an,
er hat per "hand" eine neue .asm gemacgt, die ist aber "unsichtbar" ...
das ist schlechtz gelöst. UI soll immer die aktuellste/Beste version
einer Datei/eines Payloads/Artfekts zeigen.
```

Wrong version shown:

```text
analysis/disk/wasteland_s1[ea_interplay_1988](!)/02_2.0_disasm.asm · kickass
```

Correct/best version that should be preferred:

```text
analysis/disk/wasteland_s1[ea_interplay_1988](!)/02_2.0_semantic.tass · 64tass
```

- Artifacts: browser screenshot/comment on `http://127.0.0.1:4310/`, Disk file
  inspector for `02_2.0.prg`.

## Scope guess (optional)

Artifact lineage/version resolution, payload-to-ASM link resolution, Disk
inspector action model, project artifact registry.

## Notes / follow-up

- This is not just a visual issue. The product model needs a clear
  "current/best version" rule for payloads, artifacts, generated files, and
  manually improved files.
- UI should still allow older generated artifacts to be inspected, but they
  should not be the default if a better current version exists.
- This likely belongs near the knowledge/artifact lineage model rather than only
  the Disk tab.

---

## Resolution — Part A (best-first ordering)

- **Root cause (Part A):** the inspector builds its `.asm/.tass` sources via
  `bestAsmSourcesForArtifacts` (App.tsx). It correctly deduped to one artifact
  per dialect, but then **ordered the returned list by `dialectOrder` (kickass
  first)** regardless of priority. Auto-registration gives `*_disasm.asm` the
  role `"disasm"` and `*_semantic.tass` the role `"64tass-source"`, yet the
  kickass-first ordering put the stale generated `_disasm.asm` ahead of the
  curated `_semantic.tass`, so the action defaulted to the stale version.
  `asmArtifactPriority` also didn't distinguish generated disasm from curated
  sources (both could land at the default tier).
- **Fix (Part A):**
  - `asmArtifactPriority` now ranks: `final-*-source` 400 > `*-source` 300 >
    unknown-role 200 > generated `disasm`/`disasm-tass` 100, with a `+50` nudge
    for `_semantic.*` paths. So generated dumps rank lowest and hand-made
    (no-role) files still beat them.
  - `bestAsmSourcesForArtifacts` orders the returned sources **best-first by
    priority** (dialect is only a tiebreaker), so the action defaults to the
    curated/latest source (e.g. `02_2.0_semantic.tass`) instead of the stale
    `02_2.0_disasm.asm`. Older sources remain available as the other entries.
- **Fix commit:** _this commit_.
- **Gate proving the fix:** `npm run smoke:bug019` 7/7 — ranking rules +
  best-first sort in source, and a behavioral replication asserting the exact
  repro (semantic `.tass` chosen over `_disasm.asm`; a no-role hand-made `.asm`
  beats the generated `_disasm.asm`). v1+v3 build green; ui typecheck 13
  pre-existing / 0 new.
- **Regression risk (Part A):** low — ordering/priority only; the set of offered
  sources is unchanged, only the default/first changes; payload action path
  (`bestAsmSourcesForArtifacts`) is shared by the Disk inspector + the Payloads
  inspector, so both benefit.

## Part B — deferred (after Spec 005)

Hand-made / curated source files (a `.asm`/`.tass` outside the `*_disasm.*`
auto-register globs) are not registered as artifacts at all → invisible in the
UI (this is the "13 files on disk are not registered" banner territory). Making
them visible + part of the canonical "best version" rule is a registration /
knowledge-model change (not just the Disk tab). Per the user, this is revisited
together with Spec 005 (MCP surface) work. Tracked here; status stays *partial*
until B lands.

## Resolution — Part B (artifact version store + unified resolver — Spec 730 §7)

- **Registration:** `project_inventory_sync` (via the broadened
  `DEFAULT_PATTERNS` in `registration.ts`) registers hand-made / curated source
  (`.asm`/`.tass`/`.sym`/`.md` under `analysis/**` not already claimed by the
  generated `*_disasm.*` patterns) with role `semantic-source`. So a better
  hand-made file becomes a tracked, visible artifact instead of staying invisible.
- **Version model:** a new `ArtifactVersionGroup` knowledge record
  (`src/project-knowledge/{types,storage,service}.ts` +
  `artifact-versions.ts`) clusters all source versions of one subject (base stem
  with `_disasm`/`_semantic`/… stripped) and tracks the current best version.
  Rank ladder: `final > curated > semantic > manual/unknown > generated > stale`;
  mtime is only a tie-break. `project_inventory_sync.reconcileArtifactVersionGroups()`
  creates/updates groups conservatively: auto-current only on an unambiguous
  rank, never overwrites a manual current, and on a rank tie sets `needsDecision`
  + opens an open question instead of guessing.
- **Targeted MCP tools (default surface):** `list_artifact_versions`,
  `get_current_artifact`, `set_current_artifact_version`,
  `mark_artifact_version_stale` — each takes a single subject id, none dumps
  every version of every artifact.
- **Unified UI resolver:** `bestAsmSourcesForArtifacts(artifacts, versionGroups)`
  in `ui/src/App.tsx` is the single resolver shared by Disk Inspector, Payloads,
  Annotated Listing (its source opens through the overlay), and the ASM overlay.
  It floats the version group's `currentArtifactId` (manual or auto) to the front
  and falls back to the existing rank logic, so the default action opens the
  current best version while older versions stay available.
- **Inspector "Source / Versions" section** (`ArtifactVersionsSection`): shows
  Current + Other versions with role/format/status and `open` / `make current`
  / `mark stale` actions. `make current` POSTs `/api/artifact-version/set-current`
  (persists `currentSource="manual"`, respected by a later sync); `mark stale`
  POSTs `/api/artifact-version/mark-stale`. Conflicts surface as a
  *needs decision* banner, not a silent guess.
- **Gate:** `scripts/e2e-mcp-artifact-best-version.mjs` (19/19) — semantic source
  auto-wins over the generated dump; an unregistered hand-made source becomes
  visible after sync; a manual current persists and survives a second sync;
  mark-stale falls back to the best remaining version. Also green:
  `probe-tool-surface` (version-op tools default, 99 surface), matrix/playbook
  probes, `e2e-mcp-project-inventory`. `npm run ui:build` exit 0; ui typecheck 13
  pre-existing / 0 new.
