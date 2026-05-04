# Spec 028: Custom Loader ABI / Application File API Model

## Problem

Many C64 titles bypass KERNAL `LOAD` and route content through a
private engine jump table plus a sector-loader ABI with 2-byte file
keys, parameter blocks, container sub-entries, sentinel calls, and
disk-side state. Accolade Comics' Kevin loader is the canonical
example: `$0800-$082F` jump table, `$081B / $1998` sector entry,
side-selector state, container `/0` and `/1`, key-driven dispatch.
C64RE has disk / CRT / payload abstractions but no first-class model
for the **game's own loader API**. REQUIREMENTS R19 (Critical).
Companion spec to Spec 023 (load contexts); both ship in Sprint 20.

## Goal

Express the game's private loader as structured entities and
relations so static analysis, runtime trace, and the UI all reason
about it consistently. Distinguish "KERNAL LOAD" (rare in real
games) from "engine loader call" (common, currently invisible).

## Approach

### New entity kinds

- `loader-jump-table` — fixed-address dispatch table (e.g. Accolade
  `$0800`). Carries entries with offset, name, observed callees.
- `loader-stage` — distinct phase of the loader (boot, sector,
  container-decode, dispatch).
- `loader-param-block` — RAM range used to pass file key + flags.
- `file-key-format` — 1/2/n-byte key structure (Accolade: ASCII
  pair like `WT`, `M!`).
- `loader-sentinel` — well-known constant returned/passed (e.g.
  end-of-list `$FF`).
- `disk-side-state` — runtime variable holding active side or
  container index.

### New relation kinds

- `loads-key(loader, file-key)` — loader entry consumes this key.
- `dispatches-to(jump-table-entry, target-routine)`.
- `registers-subentry(container, sub-payload)` — extends Spec 025
  containerOffset / sub-key model.
- `invalidates-cache(stage, payload)` — when a load wipes prior
  resident data.
- `mirrors-disk-state(ram-variable, drive-side-or-container)`.

### MCP tools

- `declare_loader_entrypoint(artifact_id, address, kind, name?)` —
  mark a routine as a loader entry of the given kind
  (`jump-table`, `sector-load`, `container-decode`, `dispatch`).
- `decode_loader_call(call_pc, observed_a, observed_x, observed_y,
  observed_param_block?)` — given a runtime observation (or static
  immediate-load chain), decode the file key and target.
- `list_loader_entries(artifact_id?)` — surface all known entry
  points and their observed call sites.
- `record_loader_event(scenario_id?, file_key, source_track?,
  source_sector?, runtime_destination?, caller_pc, sub_entry?)` —
  persist one observed loader call; consumed by Spec 030 scenario
  traces and Sprint 20 load contexts.

### Static / dynamic bridge

- Static analyzer pass walks the disasm for `JSR <jump-table>`
  followed by immediate-load setup, infers (key, dest) pairs,
  records as candidate loader events with `source: "static"`.
- VICE trace analyzer (Sprint 26 builds on this) attaches breakpoints
  to declared loader entries, normalises observed register state
  into loader events with `source: "trace"`.
- The two streams reconcile in the loader-abi view.

### UI view

New "Game File API" view as its **own** tab (consistent with
findings / entities / flows / relations tabs). UX consolidation
across tabs is deferred to a separate refactor sprint after the
feature set stabilises.

- Table: file key → container → runtime destination → caller chain.
- Subpayload nesting (Spec 025 R23 fold-in).
- Source markers: `static`, `trace`, or `both`.

## Acceptance Criteria

- Accolade `$0800-$082F` jump table can be declared, with at least
  6 entries dispatching to known routines.
- A static disasm pass finds at least one `JSR $1998` with
  `lda #'W' / lda #'T' / sta param` setup and emits a loader event
  with `key="WT"`.
- A VICE trace breakpoint on `$1998` produces matching loader
  events with `source: "trace"`.
- The Game File API view shows `WT → /1@offset → $???? → caller`.

## Tests

- Smoke: synthetic fixture with a 4-entry jump table; declare and
  list.
- Smoke: static decoder against a hand-crafted `JSR jt+0x06` with
  immediates, assert decoded key.
- VICE smoke deferred to manual until Sprint 8 lands.

## Out Of Scope

- Decompiling the loader to high-level pseudocode.
- Auto-discovering jump-table addresses without a hint.

## Dependencies

- Sprint 20 (Spec 023) — runs together. Load contexts give the
  destination side; Spec 028 gives the API semantics.
- Sprint 22 (Spec 025) — container subpayloads consumed by
  `registers-subentry`.
- Sprint 26 (Spec 030) — scenario traces consume loader events for
  diff.
