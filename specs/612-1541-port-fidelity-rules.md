# Spec 612 — 1541 Port Fidelity Rules

**Status:** ACTIVE (2026-05-17)
**Branch:** any branch touching `src/runtime/headless/vice1541/**`
**Replaces row 612 in:** `specs/610-1541-parity-rebuild-charter.md` ("(superseded by Spec 611 phases)" — that row is reclaimed by this spec).
**Scope:** the VICE1541 rebuild under `src/runtime/headless/vice1541/**` (and any future `vice1541-v5/` quarantine path). Does **not** apply to LEGACY1541 (`src/runtime/headless/drive/**`).

## 0. Why this spec exists

Four attempts at "port VICE's 1541 to TypeScript" have drifted. Diagnostic in the 2026-05-17 audit (recorded in this branch):

- `drive-image-{d64,g64}.ts` ports the wrong VICE file (`fsimage-*.c` instead of `driveimage.c`). Writeback is silently dropped.
- `driverom_initialize_traps` not ported → `DRIVE_IDLE_TRAP_IDLE` never fires.
- `drivecpu_jam` collapsed into a single `CLK++` path; CPU core swapped for shared `Cpu65xxVice` instead of `#include "6510core.c"` per drive.
- Two parallel VIA cores (`via/via6522-vice.ts` + `vice1541/via6522.ts`), two parallel IEC bus models (`iec/iec-bus-core.ts` + `vice1541/iec-bus.ts`).
- Snapshot replaced with `V1541SNP` flat blob — not VSF-compatible.
- C structs (`drive_t`, `diskunit_context_t`) wrapped into TS classes; field names lost; init order silently reversed.

Common root: **every time VICE uses a C indirection (function-pointer table, `#include`, struct back-pointer, alarm context, per-module snapshot chunks), the port introduces a "cleaner" TS pattern (class, closure, discriminated union, flat blob).** The new abstraction reads better but boundary behaviour diverges. Unit tests never catch it because they assert the new abstraction's contract, not VICE's.

This spec freezes the doctrine that prevents the 5th attempt from drifting.

## 1. The Naming Law (NL)

**NL-1.** One C file → one TS file. Same basename. Suffix `.c` → `.ts`.
- `vice/src/core/viacore.c` → `src/runtime/headless/vice1541/viacore.ts`.
- Headers fold into the matching `.ts` file. No separate `*-types.ts` companion.

**NL-2.** One C function → one TS function. **Same name verbatim, snake_case preserved.**
- `viacore_store(via_context_t *ctx, uint16_t addr, uint8_t byte)` → `export function viacore_store(ctx: via_context_t, addr: number, byte: number): void`.
- No `viacoreStore`, no `ViaContext.store(addr, byte)`.

**NL-3.** One C struct → one TS interface. **Field names verbatim, snake_case preserved.**
- `drive_t::GCR_track_start_ptr` → `interface drive_t { GCR_track_start_ptr: Uint8Array | null; ... }`.
- No `gcrTrackStartPtr`, no class wrapping with getters.

**NL-4.** One C macro → one TS const or function, same name.
- `#define VIA_PCR_CA1_CONTROL 0x01` → `export const VIA_PCR_CA1_CONTROL = 0x01;`.

**NL-5.** One C module-level global → one TS module-level `let`/`const`, same name.
- `static CLOCK last_alarm_clock = 0;` → `let last_alarm_clock = 0;` at module scope.

**Rationale:** grep parity. `grep viacore_store vice/src/ src/runtime/headless/vice1541/` must hit both sides. Diff tooling (humans and scripts) can verify line-by-line.

## 2. The Prohibition List (PL)

**PL-1.** No TS class wrapping a VICE struct.
- `drive_t`, `diskunit_context_t`, `via_context_t`, `gcr_t`, `disk_image_t` → all are `interface` only. Functions take the struct as first arg.
- Exception: pure TS adapters at the kernel/facade boundary (`Drive1541` interface, `Vice1541` class). Those live OUTSIDE `vice1541/`.

**PL-2.** No discriminated unions where VICE uses int/enum + branch.
- `disk_image_t.type ∈ {DISK_IMAGE_TYPE_D64, _G64, _P64, ...}` stays as numeric union, not `{ kind: "d64" | "g64" | "p64" }`.

**PL-3.** No "cleaner" abstractions invented inside `vice1541/`.
- No factory classes. No adapter wrappers. No facades. No `*Helper`, `*Manager`, `*Builder`.
- These belong at the kernel boundary, not inside the port.

**PL-4.** No shared CPU core between C64 and drive.
- Drive gets `drive_6510core.ts` — its own copy ported from `vice/src/6510core.c`. Compile-time `#define DRIVE_CPU` equivalent gates the drive-specific code paths.
- Reuse of `Cpu65xxVice` is the documented cause of the missing JAM dispatch + missing trap handler. Don't.

**PL-5.** No NOT-IN-VICE helper functions inside `vice1541/`.
- Bridge code, push-flush boundaries, debug probes, and legacy adapters live in the kernel or in `src/runtime/headless/drive1541/`. **Not** in `vice1541/`.
- If you need a helper, port the VICE function that does the equivalent or write the helper outside the port directory.

**PL-6.** No CPU/clock indirection shortcuts.
- `clk_ptr` is a `{ value: number }` reference per VICE pattern, not a closure capture. Same name.
- `write_offset` is configurable per VIA instance, not hardcoded.
- `rmw_flag` is a `{ value: 0 | 1 }` reference installed by the drive CPU, not a method call.

**PL-7.** No silent fallbacks where VICE returns an error.
- `driverom_load` returns `-1` on missing ROM and disables the drive. The TS port must do the same — not synthesise a zero-filled ROM.

**PL-8.** No init-order changes.
- Match `drive_init()` / `drive_setup_context()` ordering exactly. If VICE calls `rotation_init` after `drive_init` and before `drivecpu_init`, the TS port does the same.

**PL-9.** No snapshot format invention.
- Drive snapshot writes VICE-format module chunks (`DRIVECPU`, `DRIVEROM`, `DRIVE`, `ROTATION`, `GCR_IMAGE`, `IMAGE`, `P64IMAGE`) with VICE's per-module name + version. Flat blob (`V1541SNP`) is **forbidden**.

**PL-10.** No duplicate ports of the same C file.
- If `vice1541/viacore.ts` exists, `via/via6522-vice.ts` is deleted (or vice versa). Pre-merge gate enforces uniqueness.

**PL-11.** No legacy shadow reads in vice mode.
- (Added 2026-05-18 by Spec 614 Codex P0 follow-up.) When `drive1541="vice"` the legacy DriveCpu / legacy GcrShifter / legacy headPosition are quiet. Reading their `.cycles`, `.cpu.cycles`, `.led_status` etc. at runtime returns stale data. Kernel/bridge code must guard these reads with `if (this.drive1541Implementation === "vice") throw …` OR migrate to the vice-side state source (e.g. `kernel.drive1541.unit.clk_ptr.value`, `iecbus.iecbus.drv_data[unit]`). Init-time one-shot reads are exempt.

**PL-12.** No "lifecycle helper pending X" shadows. (Added 2026-05-18 by Spec 615.)
- During multi-phase port work it is tempting to write a local minimal version of a function whose full port "lands later" in another file. **Forbidden.** Pattern struck 10× in `vice1541/`-intra scope (Spec 615.1 sweep): each shadow silently overrode the real impl once that landed, causing subtle behavioural divergence.
- If the real impl is not yet available, the local function MUST be an explicit fail-fast `throw new Error("PORT-STUB: not implemented per Spec 612 / pending <real-location>")`. No partial-behaviour shims. No "minimum invariants" minimal versions. The caller fails loudly so the missing port is unambiguous.
- When the real impl lands, the shadow MUST be deleted (not commented out) and the caller switched to `import { X } from "./real.js"`. CI gate FC-10 (§6) catches placeholders during PR.

## 3. File Mapping Table (FM)

The authoritative TS↔C map for the 1541 rebuild. **A TS file in `vice1541/` MUST appear in this table.** A TS file not in the table is a violation (delete or move to the kernel boundary).

| TS file (under `src/runtime/headless/vice1541/`) | C file (under `vice/src/`) |
|---|---|
| `viacore.ts` | `core/viacore.c` (+ `core/viacore.h`) |
| `via1d1541.ts` | `drive/iec/via1d1541.c` |
| `via2d.ts` | `drive/iecieee/via2d.c` |
| `gcr.ts` | `diskimage/gcr.c` (+ `diskimage/gcr.h`) |
| `rotation.ts` | `drive/rotation.c` (+ `drive/rotation.h`) |
| `drivemem.ts` | `drive/drivemem.c` (+ `drive/drivemem.h`) |
| `drive_6510core.ts` | `6510core.c` (with `#define DRIVE_CPU` paths) |
| `drivecpu.ts` | `drive/drivecpu.c` (+ `drive/drivecpu.h`) |
| `drivesync.ts` | `drive/drivesync.c` (+ `drive/drivesync.h`) |
| `driveimage.ts` | `drive/driveimage.c` (+ `drive/driveimage.h`) |
| `fsimage_dxx.ts` | `diskimage/fsimage-dxx.c` |
| `fsimage_gcr.ts` | `diskimage/fsimage-gcr.c` |
| `driverom.ts` | `drive/driverom.c` (+ `drive/driverom.h`) |
| `drive.ts` | `drive/drive.c` (drive_init / drive_set_half_track / drive_gcr_data_writeback / drive_enable etc.) |
| `drive_snapshot.ts` | `drive/drive-snapshot.c` |
| `memiec.ts` | `drive/iec/memiec.c` (drive memory map installer for 1541) |
| `iec.ts` | `drive/iec/iec.c` (drive-side iec helpers) |
| `iecbus.ts` | `iecbus/iecbus.c` |
| `c64iec.ts` | `c64/c64iec.c` |
| `drivetypes.ts` | `drive/drivetypes.h` (struct definitions only — no functions) |

Files outside this table that currently live in `vice1541/` are violations to be resolved per the TODO list (`specs/612-1541-port-fidelity-todo.md`).

## 4. Layer Order (LO)

Build bottom-up. **Each layer is GREEN before the next layer is touched.** GREEN = (a) fidelity check passes (§6), (b) micro-test passes (§7).

1. `drivetypes.ts` (structs only)
2. `gcr.ts`
3. `viacore.ts`
4. `via1d1541.ts`, `via2d.ts` (backends)
5. `rotation.ts`
6. `drivemem.ts` + `memiec.ts` (function-pointer table, NOT class)
7. `drive_6510core.ts`
8. `drivecpu.ts` (with full JAM dispatch + trap handler)
9. `drivesync.ts`
10. `fsimage_dxx.ts` + `fsimage_gcr.ts`
11. `driveimage.ts` (with `drive_gcr_data_writeback`)
12. `driverom.ts` (with `driverom_initialize_traps`)
13. `drive.ts` (lifecycle: drive_init etc.)
14. `iecbus.ts` + `c64iec.ts` + `iec.ts`
15. `drive_snapshot.ts`

Only after 1–15 are GREEN: integrate behind the `Drive1541` facade ("vice" branch) and run the runtime proof gates (`specs/600-runtime-proof-gates.md`).

## 5. Per-Function Line-Map (FM-block)

Every exported function in `vice1541/*.ts` begins with a `PORT OF` block comment:

```typescript
// PORT OF: vice/src/core/viacore.c:1245-1289 (viacore_store)
// VICE rev: <git short SHA of vice/ submodule HEAD>
export function viacore_store(ctx: via_context_t, addr: number, byte: number): void {
  // ...
}
```

Reviewer can open the C file at the cited line range and verify line-by-line.

Block-comment for module-level state at top of file:

```typescript
// PORT OF: vice/src/core/viacore.c (full file)
// Header: vice/src/core/viacore.h
// VICE rev: <SHA>
```

## 6. Fidelity Check (FC, CI gate)

Script: `scripts/check-1541-port-fidelity.mjs`. Runs in CI on every PR touching `vice1541/**`. Fails the build on any violation.

**FC-1 — Mapping completeness.** Every `.ts` file under `vice1541/` is listed in §3. Every entry in §3 either exists or is explicitly marked `pending` in the TODO file.

**FC-2 — Function presence.** For each `(ts, c)` pair: extract non-static C function names (regex `^[a-z_][a-z0-9_]*\s+[a-z_][a-z0-9_]*\s*\(`), require each name to appear as `export function <name>` in the TS file. Missing names listed → FAIL.

**FC-3 — Forbidden patterns.** Grep `vice1541/**/*.ts` for:
- `^export class ` → FAIL (PL-1, PL-3)
- `^(import|from).*['"]\.\./drive/['"]` → FAIL (no cross-import into legacy)
- `^(import|from).*['"]\.\./via/['"]` → FAIL (PL-10 — `via/` is the legacy drive-side VIA, not the new port)
- `^(import|from).*['"]\.\./iec/['"]` → FAIL (PL-10)
- `kind:\s*['"]` inside discriminated-union types → WARN (PL-2)
- `camelCase` field names matching `[a-z][a-z0-9]*[A-Z]` in `interface` declarations → WARN (NL-3)

**FC-4 — Line-map block.** Every `export function` has a preceding `// PORT OF:` comment within 5 lines above. Missing → FAIL.

**FC-5 — Line-count ratio.** For each ported file, `wc -l ts / wc -l c` must be in `[0.7, 1.6]`. Outside → WARN.

**FC-6 — No duplicate port.** No two TS files map to the same C file. PL-10.

**FC-7 — Function-body audit.** (Added 2026-05-18 by Spec 614 FC-7 P0; pre-existing implementation in `scripts/audit-vice1541-stubs.mjs`.) Scan `vice1541/**/*.ts` for function bodies that are: `EMPTY {}`, `RETURN_VOID (return;)`, `RETURN_FALSY (return 0/false/null)`. Each hit must either match a verifiable VICE C source no-op (DEBUG-gated, 1581/Plus4-only branch, etc.) OR be flagged. Hidden stubs sitting under a "lifecycle helper pending …" comment are violations of PL-12.

**FC-8 — Shadow-stub detection.** (Added 2026-05-18 by Spec 615.1.) Same function name `^(export )?function NAME` appearing in ≥2 `vice1541/*.ts` files where ≥1 body is `EMPTY` / `return 0` / `return null` / `throw new Error(...PORT-STUB...)` and ≥1 other body is real (substantive port) → FAIL. The minimal/throw body is the shadow; remove it and `import` from the file owning the real impl. Inverse case (shadow in the "owning" file, real impl in a different file) → FAIL too.

**FC-9 — Cross-layer write-after-init audit.** Reserved for kernel + bridge code, not vice1541-intra. Kept in this list as a forward marker.

**FC-11 — Cross-module shadow scan.** (Added 2026-05-19 by Spec 615 §4 #6 — the "FC-7 amendment" requested in post-mortem L1.) FC-7 + FC-8 scope `vice1541/**/*.ts` only. Spec 615 §9 root cause (`src/runtime/headless/media/mount.ts` host-side CBM-DOS validation throw blocked `drive1541.attachDisk`) shows the shadow rule must extend cross-module. Scan:

- Path: `src/runtime/headless/**/*.ts` AND `src/disk/**/*.ts` AND `src/workspace-ui/**/*.ts` (every layer on the LOAD critical path).
- Pattern: aggregate `^export (function|const|class) <name>` across all files. For every name with count ≥ 2, classify each occurrence as `full-impl`, `stub` (empty/return-falsy/throw "PORT-STUB"), or `legitimate-facade` (interface-method on a class wrapping the real one).
- FAIL when ≥1 occurrence is `stub` AND ≥1 is `full-impl` (a cross-module shadow stub).
- FAIL when ≥2 are `full-impl` AND none is `legitimate-facade` (cross-module duplicate port).
- Additional rule (lesson L1 of Spec 615 §9): if a non-`vice1541/` module performs host-side validation that the drive ROM is supposed to perform (e.g. BAM walk, header checksum, disk-ID match), that validation must NOT run on the LOAD critical path in vice mode. Either gate by `drive1541Implementation === "vice"` and skip, or isolate the validation in its own try/catch and never re-throw upward.

The cross-module rule extends but does NOT replace FC-7 + FC-8 — those stay scoped to `vice1541/**/*.ts` for tight per-port discipline.

**FC-10 — Placeholder grep.** (Added 2026-05-18 by Spec 615.5b.) Grep `vice1541/**/*.ts` comments for any of:
- `/pending\s+(spec\s+612|drive\.ts|diskimage\.ts|log\.ts|drivesync\.ts)/i`
- `/placeholder\s+(until|pending|stub)/i`
- `/lifecycle helper pending/i`
List every hit on PR. Each must be one of:
  (a) accompanied by a PL-12-conformant fail-fast `throw new Error("PORT-STUB: ...")` body,
  (b) annotated with a tracked task ID (e.g. `Spec 612 T2.10`), AND
  (c) verified by `npm run check:1541-fidelity` against the FC-7/FC-8 sweep.

Uncategorised placeholders fail the gate. This catches future T2.X-handoff drift before the same shadow-stub bug class recurs.

Failures are listed as `FAIL <ts-file>: <rule> — <detail>` and exit 1.

## 7. Micro-Test Per Layer (MT)

Each layer ships one deterministic micro-test that compares the TS port byte-for-byte against a VICE binmon trace. NOT a game boot. NOT a full scenario. ONE focused write-trace.

Examples:

- **MT-viacore.** Reset VIA. Write `$DD` to `$T1CL`, `$DD` to `$T1CH`. Run 600 cycles. Snapshot `($IFR, $IER, $T1CL, $T1CH, $PB7)` every 10 cycles. Diff against `vice/testprogs/CIA/...` binmon capture.
- **MT-rotation.** Empty G64 track of 7928 bytes, motor on, speed zone 3. Run 100000 cycles. Capture `(GCR_head_offset, byte_ready_edge, last_read_data)` every 100 cycles. Diff against VICE trace.
- **MT-drivecpu.** Drive cold-reset. Run 200000 cycles with empty bus. Capture `(PC, A, X, Y, SP, CLK)` every 1000 cycles. Diff against VICE drive cpuhistory.

Micro-tests live under `tests/vice1541-fidelity/<layer>.test.ts`. Run nightly + on every `vice1541/**` PR.

Diff tooling: `scripts/trace-store-diff.mjs` against VICE captures already stored under `samples/traces/v2-baseline/`.

## 8. Quarantine Policy (QP)

**QP-1.** When this spec is adopted, the current `src/runtime/headless/vice1541/` is renamed to `src/runtime/headless/_quarantine_vice1541_v4/`. No new code lands there.

**QP-2.** The new path is `src/runtime/headless/vice1541/` (same final name). Built from scratch following §1–7. Files that the audit confirms are already 1:1 (`gcr.ts`, parts of `rotation.ts`, `via/via6522-vice.ts`) are **copied** in and **renamed** to satisfy NL (snake_case functions, snake_case fields).

**QP-3.** No file moves from quarantine without:
- a clean fidelity-check pass on the moved file,
- a micro-test for the file's layer,
- a `PORT OF` block comment on every exported function.

**QP-4.** Once layer 15 is GREEN end-to-end, `_quarantine_vice1541_v4/` is deleted. `drive1541-factory.ts` simplifies to `new Vice1541()` (legacy adapter goes too, per Spec 611.9).

## 9. Acceptance

This spec is DONE when:

1. `scripts/check-1541-port-fidelity.mjs` exists and runs in CI.
2. `src/runtime/headless/vice1541/` passes the script with zero FAIL.
3. Every TODO item in `specs/612-1541-port-fidelity-todo.md` is either DONE or explicitly deferred with a follow-up spec number.
4. Layer 1–15 micro-tests all pass.
5. Runtime proof gates (Spec 600) at least match the LEGACY1541 baseline (5/7 GREEN) when `drive1541Implementation="vice"`.

(5) does not gate this spec's adoption — adopting the doctrine is independent of the rebuild completion. (1)–(4) gate spec DONE.

## 10. Out of Scope

- LEGACY1541 (`src/runtime/headless/drive/**`) — untouched.
- 1571 / 1581 / CMDHD / 2000 / 4000 — separate specs after 1541 lands.
- JiffyDOS / burst-mode — `iec-fast.ts` stays explicit stub per Spec 422.
- Parallel cable — out of scope.
- NTSC — PAL first per existing memory `feedback_pal_first_ntsc_later.md`.

## 11. References

- `specs/610-1541-parity-rebuild-charter.md` — charter.
- `specs/611-new-vice1541-side-by-side.md` — side-by-side build.
- `specs/600-runtime-proof-gates.md` — proof gates.
- `docs/vice-1541-arch.md` — VICE 1541 arch.
- 2026-05-17 audit (this branch) — quantified drift evidence.
