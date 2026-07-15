# C64RE Workbench — Full UI Inventory

**Date:** 2026-06-29 · **Method:** live walk, screen by screen, on the master UI (`http://localhost:4310`, Wasteland project). Every screen, every feature, its data source, and a keep / drop / rebuild call + where its data should come from in a clean rebuild. This is the groundwork for any redesign (the step skipped last time).

Legend for **decision**: `keep` (works, valuable, carry over) · `rebuild` (valuable but bound to bloated/wrong data — re-do on clean data) · `drop` (firehose CRUD / dead / low value).

---

## Global shell

**Tab strip (visible):** Live · Dashboard · Questions · Docs · Memory Map · Scrub · Disk · Payloads · Flow Graph · Annotated Listing. (Graphics + Cartridge are gated — appear only when the project has that data.)

| Feature | What | Data source | Decision |
|---|---|---|---|
| Project title + status | "Wasteland EasyFlash Crack" · active · updated time | `snapshot.project` | keep |
| 4 metric tiles | Artifacts 526 · Active Findings 8441 · Open Tasks 77 · Open Questions 10 | `snapshot.views.projectDashboard.metrics` (firehose) | rebuild — numbers are firehose-inflated (8441) + inconsistent vs other surfaces |
| "Show all versions" toggle | exposes V0..V(n-1) per lineage (Spec 054) | client filter `showAllVersions` | keep (but should be moot once data deduped) |
| "Show internal files" toggle | exposes manifests/analysis-JSON/etc (Spec 058) | client filter `showInternal` | keep |
| Right-aside Inspector | shared inspector, empty until a selection | `EntityInspector` + specialized inspectors | keep (the multi-context inspector is valued) |

---

## 1. Dashboard

| Feature | What | Data source | Decision |
|---|---|---|---|
| Overall State — Project Shape | "Disk-based RE workspace, 2 staged payloads, 526 artifacts, 1 readable doc" | `projectDashboard` summary text | rebuild — the counts (526, "2 staged") are firehose/odd |
| Overall State — Work State | "8441 active findings, 77 tasks, 10 open questions (+3580 heuristic untriaged)" | `projectDashboard` | rebuild — same firehose counts; the "+3580 heuristic" is the bloat |
| Overall State — Current Focus | "Primary next action: …; Open question: which source is current for utils_overlay_7E00" | `projectDashboard` next-action | keep (concept) — the "which version is current" Q is a firehose-dedup symptom |
| Open Questions list | "3590 open · click to inspect"; version-decision questions | `snapshot.openQuestions` (sliced) | rebuild — 3590 = heuristic bloat; the version-decision Qs vanish once data deduped |
| (click Q → Inspector) | routes a question into the right aside | `QuestionInspector` | keep (concept) |

*Observation:* the whole Dashboard is a firehose summary. Concept (project-state-at-a-glance + next action) is good; the data behind it is the bloat. → **rebuild on clean data**, don't keep as-is.

---

## 2. Live (runtime view)

Data source for all of Live = the WS JSON-RPC client `getClient()` → `ws://127.0.0.1:4312` (the TRX64 daemon): `session/state`, `session/run`, `session/list`, binary VIC frames, etc. **Model-independent** (it's the live machine, not the knowledge store). This is the healthy half — **keep everything**.

| Feature | What | Data source | Decision |
|---|---|---|---|
| C64 screen | live VIC framebuffer @ ~50fps | WS binary VIC frame | keep |
| Toolbar: Power on/off | cold-boot / power | WS session control | keep |
| Toolbar: MON | opens monitor pop-out (`?monitor=1`) | WS monitor verbs | keep |
| Toolbar: Reset | reset the machine | WS | keep |
| Toolbar: Pause / Step | pause + single-step | WS session/run, step | keep |
| Toolbar: Dump | memory/state dump | WS | keep |
| Toolbar: Trace | toggle tracing | WS trace verbs | keep |
| Toolbar: Warp | warp-speed run | WS | keep |
| Toolbar: Audio | reSID audio on/off | WS audio + AudioWorklet | keep |
| Status line | fps · conn (OPEN) · session id · cycle | WS state | keep |
| CPU panel | MAIN/IRQ/NMI vectors, A/X/Y/SP/P, cyc | WS session/state | keep |
| VIC panel | raster, mode, bank, screen, chargen, border, bg | WS | keep |
| SID panel | V1-3 wave/note/gate, vol, filter, res | WS | keep |
| DRIVE 8 panel | T/S, xfer, $DD00 bus, power, insert-disk dropdown | WS + media mount | keep |
| CART panel | state, insert-cart dropdown | WS + media mount | keep |
| VIRTUAL JOY | OFF/1/2 mode, bits, keys | WS input | keep |
| (sub) Filmstrip / scrub | frame strip (if shown lower) | WS recorder ring | keep |
| (sub) Explore overlay | live explore | WS | keep |
| (sub) MON pop-out | full monitor (disasm/mem/regs/breakpoints) | WS monitor verbs | keep |

*Observation:* Live is fully WS-backed + healthy. Nothing here touches the knowledge model. Carry over unchanged.

---

## 3. Questions

Header: "3590 of 3647 | selected 0". Every row is a `Validate: RAM region XXXX behaves like flag` / `Segment XXXX classified as pointer_table` — kind=validation, all stamped 11.06 17:58 (one batch), 26-42% conf, never triaged.

| Feature | What | Data source | Decision |
|---|---|---|---|
| Question list (table) | TITLE / KIND / PRIO / CONF / STATUS / UPDATED | `snapshot.openQuestions` (capped "first 500 of 3590") | rebuild — 3590 = the heuristic firehose; real list is ~10 |
| Search (title/summary) | text filter | client | keep |
| Status filter (open/…) | dropdown | client | keep |
| Priority filter | dropdown | client | keep |
| Kind filter | dropdown | client | keep |
| Sort (updated↓ …) | dropdown | client | keep |
| Select visible (500) / Clear | bulk-select | client | keep |
| Bulk: Re-evaluate / Defer / Invalidate / Reopen / Set-priority | bulk-triage actions (500 at a time) | POST `/api/...` question status | keep — good tooling; mostly unneeded once data deduped |
| per-row checkbox | select for bulk | client | keep |
| → Inspector | route Q to aside | `QuestionInspector` | keep |

*Observation:* the **triage tooling is good** (and was never run — that's why 3590 sit). But the LIST is firehose: ~3590 auto-validation Qs that shouldn't exist. → keep the controls, kill the source bloat. Whole tab becomes minor once data is clean.

---

## 4. Docs

Markdown viewer. "73 markdown files". Data source = `/api/docs` (scans the project dir for `.md`), **not the firehose snapshot** — filesystem-backed.

| Feature | What | Data source | Decision |
|---|---|---|---|
| Doc list — OTHER NOTES | registered semantic-notes (1) | `/api/docs` | keep |
| Doc list — DISCOVERED (UNREGISTERED) | 72 unregistered .md found in the tree | `/api/docs` | keep — simplify the "unregistered" framing |
| Markdown render | renders the selected .md (AGENTS.md etc.) | file content | keep |
| (cross-link) open-document from other panels | jump to a doc | `setSelectedDocPath` | keep |

*Observation:* healthy + model-independent (filesystem markdown). Carry over, minor cleanup of the registered/unregistered framing.

---

## 5. Memory Map

"Address Space — 22498 mapped regions / 256 heatmap cells". 16×16 colour grid + a right-aside region Inspector. Data source = `snapshot.views.memoryMap` (the firehose region set — dominated by RAM-hypothesis bloat) + firehose findings for the Inspector.

| Feature | What | Data source | Decision |
|---|---|---|---|
| Heatmap grid (256 cells) | addr 0000-F000 × 000-F00, coloured free/code/data/system/other | `snapshot.views.memoryMap` (22498 regions) | rebuild — concept good, data = firehose bloat |
| Legend | free/code/data/system/other | static | keep |
| SHOW CART/DISK-RESIDENT toggle | filter resident regions | client | keep |
| PAYLOAD FOCUS picker | focus one payload's regions | snapshot payloads | **BUG: only lists "Prodos"** (1 of ~15) → rebuild |
| heatmap cell → Inspector | click a cell to inspect its region | — | **BUG: cells not clickable; selection locked to $0000** → fix |
| Inspector: region detail | flag_0000, %, addr range, description | firehose entity | rebuild on clean data |
| Inspector: Memory Map / +LLM Task / +Open Question | actions | POST `/api/...` | keep |
| Inspector: Details / View Links / Findings / Linked Elements | linked knowledge per region | firehose findings/relations | rebuild — findings are RAM-hypothesis bloat (active 58% etc.) |

*Observation:* this is the firehose's worst surface (22498 regions, the auto RAM-hypotheses). The address-space-overview + per-region-inspector CONCEPT is valuable, but: data is bloat, **cells aren't clickable**, the focus picker only shows Prodos. → rebuild on clean data; needs real memory-layout (load-addresses/regions) the model must grow to hold.

---

## 6. Scrub  ⚠ NOT in the earlier keep-list — but valuable

"Free-form memory browser — pick a file, scroll the address, render any slice." Despite the name it's NOT time-travel; it's a **byte→graphics slice explorer + annotator**. Renders a payload's bytes as charset/sprite/bitmap, scrub the offset, save a slice as a segment annotation. Data source = the payload/artifact file bytes + `/api/graphics`-style render; "Save segment" POSTs an annotation JSON.

| Feature | What | Data source | Decision |
|---|---|---|---|
| File picker | choose a payload/prg to render | snapshot artifacts/payloads | keep (point at model payloads) |
| Offset (hex) + nav (--row/-blk/-1/+1/+blk/+row) | scrub the address window | client | keep |
| Window (hex bytes) | slice size | client | keep |
| Kind (charset 8×8 / sprite / bitmap …) | how to render the bytes | client render | keep |
| Multicolor toggle | MC rendering | client | keep |
| Columns per row | layout | client | keep |
| **Live graphics render** | renders the actual charset/sprite/bitmap from bytes | file bytes | keep — genuinely useful visual tool |
| Load address display | e.g. $C600 | payload meta | keep |
| **Save as segment** (label, comment) | persist the slice as a kind=charset segment annotation | POST annotation JSON | keep — feeds analysis/disasm |
| (mon) button | open in monitor | WS | keep |

*Observation:* this is a **real, valuable tool** (visual byte exploration + segment annotation) that the earlier keep-list dropped — exactly the kind of loss the proper inventory catches. Recommendation: **keep**, repoint the file source to model payloads. (Right-aside still the firehose Inspector — rebuild.)

---

## 7. Disk  ★ the real bug lives here

Disk Layout (4 G64) + Disk Geometry donut + a right "Disk file" inspector. Data source = `snapshot.views.diskLayout` (firehose `buildDiskLayoutView`).

**KEY FINDING (corrects an earlier misread):** the donut is NOT empty — it shows full per-sector occupancy (coloured rings, from the BAM/raw-sector analysis). The problem is the **FILE/ENTITY list: "ORIGIN all 8" — only ~8 files are mapped** (the CBM directory files + a few payloads: 01_prodos, 02_2.0, block2_engine_0200, block3_game_7E00, font_charset_C600, scene_overlay_C800…). The **~186 area-assets (gfx/map/record/str) are NOT surfaced as disk entities at all** — even though each has a known track/sector (in `baseline/INVENTORY.json` + in the name) and a sector-chain logic. So most of the game's data is missing from the disk view. **This is "es fehlen so viele Daten."**

| Feature | What | Data source | Decision |
|---|---|---|---|
| Disk image tabs (4) | pick s1..s4 | diskLayout.disks | keep |
| ORIGIN filter (all/custom-loader/unknown) | filter by load type | diskLayout files.loadType | keep |
| File list | **only ~8 files** (dir files + few payloads) | diskLayout.disks[].files | **FIX — must include all ~186 area-assets mapped by their T/S (INVENTORY track/phys/len/step + chain logic)** |
| Disk Geometry donut | full per-sector occupancy, coloured | diskLayout.disks[].sectors (BAM/raw analysis) | keep — this part is good + rich |
| Track strip + raw sector hex read | click track/sector → 256B hex | `/api/disk/sector-bytes` | keep |
| Disk file inspector: header | name, blocks, load addr, origin, disk image | diskLayout file | keep |
| Disk file inspector: Sector chain | T18/S2, link, step | diskLayout file.sectorChain | keep (extend to all entities) |
| Disk file inspector: Source/Versions (make-current/mark-stale) | per-file disasm versions | firehose artifact versions | rebuild — version mgmt is firehose; "current/stale" = the dedup problem |
| Inspector actions: mon / .asm.tass / reverse-workflow / +task / +question | open/act | WS + POST | keep |

*Observation:* **the donut + sector analysis are good; the bug is the incomplete entity→sector mapping** (8 of ~186+). The fix is in the EXISTING data pipeline: map every catalogued entity (the 186 area-assets, which know their T/S) onto the disk layout. This is THE thing the user is pointing at.

---

## 8. Payloads

"19 payloads" (should be ~15 — archived dups shown even with Show-all-versions off). Rich per-payload cards. Data source = snapshot payload entities.

| Feature | What | Data source | Decision |
|---|---|---|---|
| Payload list | name, load addr, format (PRG), rich description | snapshot payloads | rebuild on clean data (model payloads) |
| Filter by name/format | text filter | client | keep |
| Payload description | semantic summary ("Boot-block 2 = resident GAME ENGINE…") | finding/entity | keep — valuable |
| actions: mon (raw) / asm / reverse workflow | open in monitor / asm / run workflow | WS + POST | keep |
| Source / Versions (N) | current + other versions, open / make-current / mark-stale | firehose artifact versions | rebuild — version mgmt = the dedup problem; "two sources tie on rank, pick current" |
| archived "Thin duplicate" entries | superseded dups STILL listed | snapshot (no dedup) | **BUG: should be hidden — dedup** |
| → Inspector | PayloadFileInspector | firehose | rebuild |

*Observation:* this is essentially what a clean **model Payloads view** should be (the user wants Payloads rebuilt "mit Verstand"). Keep the rich cards + descriptions + actions; rebuild on deduped model payloads (head = canonical, history collapsed). Kills the "19 vs 15" + "which version is current".

---

## 9. Flow Graph (+ Load Sequence)

Two sub-tabs. Data source = `snapshot.views.flowGraph` (firehose entity+relation graph) + `snapshot.views.loadSequence`.

| Feature | What | Data source | Decision |
|---|---|---|---|
| Flow Graph (Structure/Load modes) | "9695 nodes / 7402 edges" columnar graph | firehose entities+relations | rebuild — unreadable bloat; the meaningful flow (provenance Medium→Loader→Payload) is ~200 nodes |
| Rendered Graph columns | Entry Points / Code Routines / Data State / Other | firehose nodes | rebuild |
| Edges panel | "code_X precedes unknown_Y — 72% cross-ref" (repeated) | firehose relations | rebuild — repetitive |
| **Load Sequence** sub-tab | the boot/load ORDER (prodos→2.0→…) | `loadSequence` | **rebuild — concept valuable (the load chain), but data incomplete: "1 payload / 0 transitions"** (only Prodos) |
| Transition Logic | per-step transition detail | loadSequence | rebuild (when populated) |
| Inspector cross-nav | Memory Map / Disk / Load Sequence buttons jump views for an entity | client | keep — valuable cross-navigation |
| Inspector View Links | linked disk-file / payload / bootstrap | firehose relations | rebuild — **dup "disk file ×2"** (dedup) |

*Observation:* the Flow GRAPH is firehose bloat (rebuild on provenance). The **Load Sequence** (boot chain) is a valuable concept but barely populated (1 payload) — should show the full provenance load chain. The Inspector's cross-view-nav buttons (jump entity → Memory Map / Disk / Load Sequence) are valuable — keep.

---

## 10. Annotated Listing

The semantic disasm segment listing for the selected payload. Data source = `snapshot` listing/segments for the selected entity.

| Feature | What | Data source | Decision |
|---|---|---|---|
| Listing table | Range / Label / Kind (code/data) / Comment per segment | snapshot segments | keep concept (the annotated disasm) — rebuild data |
| Filter segments (address/label/kind/comment) | search | client | keep |
| Inspector: segment detail + listing refs | block2_engine_0200, 217 listing refs, View Links | firehose | rebuild |

*Observation:* valuable (the annotated disasm listing — labels + comments per segment). But currently bound to the **archived dup** block2_engine_0200 → every comment reads "SUPERSEDED… Thin duplicate" (the version-dedup leak). Rebuild on the model's HEAD representation + segments. Keep concept.

---

## ★ Reference: MotM (Murder on the Mississippi) — what GOOD disk data looks like

Project `/Users/alex/Development/C64/Cracking/Murder` (motm.g64). Viewed on a separate server (:4320). Also MUCH cleaner overall: 289 artifacts / 856 findings / 69 questions (vs Wasteland 526 / 8441 / 3590) — its open questions are REAL ("Where is the drive-side fastloader stored on disk?", "Which file populates $E000-$EEFF kernal-replacement?"), not RAM-hypothesis noise.

**MotM Disk view (the target):**
- ORIGIN "all 16" — **16 files, ALL mapped** to the disk, each with a load type (kernal/unknown), block count, load addr, and a colour dot.
- Each file has a **sector chain** (e.g. 01_murder T17/S0, step 1/1, "via disk entry / boot chain"), linked to the donut (selected file → its sectors highlight, the yellow arc).
- Disk Geometry donut: full coloured per-sector occupancy, and **the file↔sector mapping works** (click a file → its sectors light up).
- Disk-file inspector: ORIGIN, PAYLOAD IMAGE path, DISK IMAGE, sector chain, Source/Versions (tass/sym/asm).

**The Wasteland gap (the fix):** MotM registers **every** disk file as a disk-mapped entity with a sector chain → the disk view shows them all. Wasteland only has ~8 such entities; its **~186 area-assets live only in `baseline/INVENTORY.json` (track/phys/len/step) and were never registered as disk-file entities with sector chains** → the disk view can't show them. **Fix (existing system, data side): register the Wasteland area-assets as disk-mapped entities with their sector chains (from INVENTORY + the loader's chain logic), exactly like MotM's files.** Then Wasteland's disk looks like MotM's. No UI redesign needed — it's a data/ingest fix.

---

## 11. Graphics  (gated — visible on MotM)

Sprite/charset/bitmap viewer + human confirm/reject classifier. Renders the actual graphics from a segment's bytes. Data source = `/api/graphics` (buildGraphicsView — graphics segments from analysis); marks via `/api/graphics-marks` (POST).

| Feature | What | Data source | Decision |
|---|---|---|---|
| Segment list (SPRITES/CHARSETS/BITMAPS) | "1 segment · 0 confirmed · 1 rejected" | `/api/graphics` | keep |
| Graphics render | renders the sprite/charset/bitmap | segment bytes | keep — valuable visual |
| Confirm / Mark-wrong / Clear-mark | human validates the graphics classification | POST `/api/graphics-marks` | keep — good human-in-loop |
| Foreground/colour palette | render colours | client | keep |
| Hide-rejected toggle | filter | client | keep |

*Observation:* valuable visual + human-validation tool (renders real graphics, confirm/reject). Keep. Overlaps conceptually with Scrub (both render bytes→graphics); could unify later.

---

## 12. Cartridge  (gated — not shown on Wasteland/MotM disk projects)

Appears only for cart projects. From the earlier audit (`docs/audits/ui-ux-2026-06-29`): `CartridgePanel` = bank/chip grid (EF banks 0..63, chips 8000/A000) + a CartChunkInspector. Data source = firehose cartridge-layout entities (the ones that double-extracted into 384 entities). Decision: **keep the bank/chip grid (valuable for EF carts), rebuild on deduped cart entities.**

---

## Right-aside inspectors (shared across tabs)

| Inspector | Used by | Data source | Decision |
|---|---|---|---|
| EntityInspector (default) | Memory Map, Flow, generic | firehose entity + linked findings/relations/artifacts/regions | rebuild on clean data — the multi-context linked-knowledge view is VALUED; keep the concept |
| DiskFileInspector | Disk | firehose disk file + sector chain + versions | keep (extend to all entities), rebuild version-mgmt |
| PayloadFileInspector | Payloads | firehose payload | rebuild on model payloads |
| CartChunkInspector | Cartridge | firehose cart chunk | rebuild on deduped cart |
| QuestionInspector | Questions, Dashboard | firehose question | keep |

*The inspector's "show an entity's linked knowledge in different contexts + cross-nav buttons (jump to Memory Map / Disk / Load Sequence)" is one of the most valued things — keep the concept, feed clean data.*

---

## Summary — keep / rebuild / drop

**Keep (healthy, carry over):** Live (whole runtime view) · Docs · Scrub (byte→graphics explorer + annotate) · Graphics (sprite/charset viewer + confirm/reject) · the Disk **donut + sector analysis** · the inspector **cross-nav** + multi-context concept · the Questions **bulk-triage tooling** · Cartridge bank/chip grid.

**Rebuild on clean data (valuable, bound to firehose/bloat):** Dashboard metrics + summary · Memory Map (+ fix non-clickable cells + Prodos-only picker) · Payloads (dedup, head/history) · Flow Graph (→ provenance, ~200 not 9695) · Load Sequence (populate the full boot chain) · Annotated Listing (HEAD representation) · all inspectors' data · header metric tiles.

**The #1 data fix (existing system, not a redesign):** register Wasteland's ~186 area-assets as disk-mapped entities with sector chains (from `INVENTORY.json` + loader chain logic) so the Disk view shows them all — like MotM does. That's the "so viele Daten fehlen".

**Drop:** the firehose duplication itself (9652→~1437 findings, 22631→~4634 entities, 3590→~real questions) — at the source (content-keyed ids / GC), so every "rebuild on clean data" item above just works.
