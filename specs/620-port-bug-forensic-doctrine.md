# Spec 620 — Port-Bug Forensic Doctrine

**Status:** ACTIVE (2026-05-18, renumbered from Spec 613 → 620 on 2026-05-19 — Spec 613 slot held by `c64-iec-load-regression`, predates this doctrine).
**Parent:** `specs/612-1541-port-fidelity-rules.md`
**Scope:** debugging any bug whose suspected root cause is in `src/runtime/headless/vice1541/**` (a VICE C→TS port). Applies to the 1541 rebuild and to any future 1:1 port (CIA, VIC, SID).
**Why this spec exists:** 2026-05-17/18 overnight debug session burned ~8 hours on a Legacy C64 core hypothesis. Root cause was a C→TS conversion bug in the port. Same pattern as Sprint 112 Spec 140 v2 (memory `feedback_read_vice_first.md`). The dominant bug class in any 1:1 port is conversion error, not algorithmic divergence — but debug effort keeps targeting the latter.

## 1. C→TS Conversion-Bug Taxonomy

Ten recurring conversion-bug families. Every port-debug session checks this list **first** before formulating any hypothesis about algorithmic divergence.

| # | Family | C symptom | TS port lands as | How it bites |
|---|---|---|---|---|
| 1 | Missing mask after arithmetic | `uint8_t x; x = x + y;` (auto-wraps) | `x = x + y` (number, no mask) | Overflows above 0xff, breaks address math |
| 2 | Signed/unsigned mixup | `int8_t d = (int8_t)byte; addr += d;` | `addr += byte` (unsigned) | Negative branches go forward |
| 3 | Sign-extension lost | `int16_t v = (int8_t)b;` | `v = b` (positive 0..255) | Branch targets / signed comparisons wrong |
| 4 | Pre/post-increment ordering | `*p++ = *q++;` | `p[i] = q[i]; i++;` (two statements) | Side-effect ordering observable in IO writes |
| 5 | Macro expansion lost | `#define STORE(a,b) ...complex...` | TS inlines simplified version | Hidden side-effects in macro disappear |
| 6 | File-scope `static` dropped | `static CLOCK last_clk;` | per-call variable or class field | State persistence across calls broken |
| 7 | Preprocessor branch wrong arm | `#ifdef DRIVE_CPU ... #else ... #endif` | TS picks wrong arm | Whole code path stubbed or duplicated |
| 8 | Operator precedence | `a & b | c << d` | `(a & b) | (c << d)` re-parens guessed wrong | Bit-level math diverges silently |
| 9 | Array-as-pointer decay | `func(arr)` then `*arr++` inside | TS passes `arr` + index, mutates wrong | Caller doesn't see mutation |
| 10 | Implicit type conversion | `uint32_t a = uint16_t * uint16_t;` | `a = u16a * u16b` (no widen) | Overflows at 0x10000 instead of 0x1_0000_0000 |

**Rule:** when a port file is suspected, agent **walks this table top-to-bottom** before tracing, before testing the C64 core, before hypothesising algorithmic divergence. Each family check is a single `grep` or a 30-second read.

## 2. Reading-First Law (RFL)

Before any trace, profile, or step-debug session targeting a `vice1541/` file:

**RFL-1.** Read the matching C function end-to-end. Not skim — read.
**RFL-2.** Diff it line-by-line against the TS port. Use `git diff --no-index` or side-by-side editor.
**RFL-3.** Expand every macro from `.h` files referenced in that function. Verify TS captured the expansion.

Only if all three steps complete AND the divergence is not explained → proceed to trace.

**Enforcement:** session note required before any `vice_trace_*` or `runtime_*_trace_*` tool call targeting a `vice1541/` divergence. Format:
```
[RFL-CHECK <file>:<function>]
  read: [x]  diff: [x]  macros: [x]
  conclusion: <one sentence what the read found>
  trace reason: <why reading was insufficient>
```
Skipping this is the trigger that drove the 2026-05-17/18 wasted session. Don't skip.

## 3. Differential Testing Harness (DTH)

Per ported function, a micro-test that compares the TS port byte-for-byte against the **actual VICE C function** (compiled, not transcribed).

### DTH-1. Build VICE as a WASM module

Add `tools/vice-wasm/` containing:
- `build.sh` — emcc-build of the VICE `vice1541` sources as a WASM library, exporting `viacore_store`, `viacore_read`, etc. with thin C shim.
- `bridge.ts` — TS wrapper that instantiates the WASM module and exposes the C functions as TS-callable.

Alternative if WASM-build too painful: `dlopen`-based native ffi (`bun:ffi` or `node-ffi-napi`) loading a `.so`/`.dylib` build of `libvice-1541.a`.

### DTH-2. Per-function harness

`tests/vice1541-diff/<function>.diff.test.ts`:

```typescript
import { viacore_store as ts_store } from "../../src/runtime/headless/vice1541/viacore.ts";
import { viacore_store as c_store } from "../../tools/vice-wasm/bridge.ts";
import { fuzz_via_context, fuzz_addr, fuzz_byte } from "./fuzz.ts";

test("viacore_store byte-exact vs VICE", () => {
  for (let seed = 0; seed < 5000; seed++) {
    const ts_ctx = fuzz_via_context(seed);
    const c_ctx  = structuredClone(ts_ctx);
    const addr   = fuzz_addr(seed);
    const byte   = fuzz_byte(seed);

    ts_store(ts_ctx, addr, byte);
    c_store(c_ctx, addr, byte);

    assert.deepStrictEqual(ts_ctx, c_ctx,
      `divergence at seed=${seed} addr=$${addr.toString(16)} byte=$${byte.toString(16)}`);
  }
});
```

### DTH-3. CI gate

`npm run test:diff` runs every diff test on every PR touching `vice1541/**`. Failure blocks merge.

### DTH-4. Coverage requirement

Each port file in §3 of Spec 612 ships with at least one `.diff.test.ts` covering its primary exports. Function presence check (T0.1 fidelity FC-2) extends with FC-7: every exported function must have either a matching diff test OR an `@no-diff-test reason: <reason>` annotation block.

## 4. Branded Number Types (BNT)

`src/runtime/headless/vice1541/types_int.ts` (new file outside §3 mapping — utility):

```typescript
declare const __u8: unique symbol;
declare const __u16: unique symbol;
declare const __u32: unique symbol;
declare const __i8: unique symbol;
declare const __i16: unique symbol;

export type U8  = number & { [__u8]: true };
export type U16 = number & { [__u16]: true };
export type U32 = number & { [__u32]: true };
export type I8  = number & { [__i8]: true };
export type I16 = number & { [__i16]: true };

export const u8  = (x: number): U8  => (x & 0xff) as U8;
export const u16 = (x: number): U16 => (x & 0xffff) as U16;
export const u32 = (x: number): U32 => (x >>> 0) as U32;
export const i8  = (x: number): I8  => (((x & 0xff) ^ 0x80) - 0x80) as I8;
export const i16 = (x: number): I16 => (((x & 0xffff) ^ 0x8000) - 0x8000) as I16;

export const u8_add  = (a: U8, b: U8 | number): U8  => ((a + b) & 0xff) as U8;
export const u16_add = (a: U16, b: U16 | number): U16 => ((a + b) & 0xffff) as U16;
export const u8_sub  = (a: U8, b: U8 | number): U8  => ((a - b) & 0xff) as U8;
// ... rotations, shifts, etc.
```

**Lint rule** (in T0.1 fidelity check, new rule FC-8): inside `vice1541/`, any expression `<id> [+\-*/<<>>&|] <id>` where either operand is typed `number` (not `U8`/`U16`/`U32`/`I8`/`I16`) → WARN. Forces the dev to either brand the types or assert no-mask-needed.

Migration: not mandatory for already-ported files (risk of touching 92 commits' worth of code), but **all new diff-test failures get an automatic suggestion to brand the types involved**.

## 5. First-Divergence Trace Tool

Existing `vice_trace_*` and `runtime_*` tools produce statistics (hotspots, top-PCs, bucket counts). Useful for profiling. **Useless for port-divergence hunt.**

New MCP tool: `vice1541_first_divergence(scenario_id, lanes, max_cycles)`.

### Contract

**Input:**
- `scenario_id`: registered scenario (e.g. `"motm-boot-to-e5c0"`) that produces a deterministic input stream for both VICE and TS-port runtime.
- `lanes`: array of lane names to compare per cycle. Default = full set:
  - CPU: `drive_pc`, `drive_a`, `drive_x`, `drive_y`, `drive_sp`, `drive_p` (status flags)
  - Memory: all writes (`{ addr, byte }` set per cycle)
  - VIA1: `$1800`..`$180F` register state diff per cycle
  - VIA2: `$1C00`..`$1C0F` register state diff per cycle
  - IRQ: edge events per cycle
  - GCR: `head_halftrack`, `byte_ready_edge`
- `max_cycles`: hard stop (e.g. 5_000_000).

**Output:**
- ONE record (not a histogram, not a top-N):
  ```json
  {
    "divergence_cycle": 123456,
    "lane": "drive_pc",
    "vice_value": "0xe5c0",
    "ts_value": "0xe5c2",
    "window": [
      { "cycle": 123451, "vice": { ... full state ... }, "ts": { ... full state ... } },
      { "cycle": 123452, ... },
      ...
      { "cycle": 123461, ... }
    ],
    "preceding_writes": [
      { "cycle": 123445, "side": "vice", "addr": "0x1c00", "byte": "0xe0" },
      { "cycle": 123445, "side": "ts",   "addr": "0x1c00", "byte": "0xc0" }
    ]
  }
  ```

**What it does NOT do:**
- No summaries.
- No bucket counts.
- No "top divergent PCs".
- No "we saw N divergences, here are the most common".
- No tolerance / fuzzy match.

**Acceptance:** halts at first ANY-lane mismatch. Reports window ±5 cycles. Done.

### Implementation outline

Lives in `src/runtime/diff-trace/vice1541_first_divergence.ts`. Drives both `headless_integrated_session` (TS) and `vice_session` (VICE) with synchronized scenario input. Reads both cycle streams from existing `trace_store_*` infra. Joins on cycle number. Exits at first non-equal field.

Filed as Spec 620.T1 — implementation task.

## 6. Statistics-Trace Quarantine

All existing `vice_trace_hotspots`, `trace_store_top_pcs`, `vice_trace_zoom_overview`, etc. are **profiling** tools. Tag them in MCP tool metadata as `category: "profiling"`. Agents detecting a port-divergence question (matches regex `divergenz|diverg|abweich|mismatch|wrong cycle|differs`) get a runtime warning when invoking a profiling-tagged tool:

> ⚠ Profiling tool. For port-divergence hunt use `vice1541_first_divergence`. See Spec 620 §6.

Not blocked — sometimes profiling IS what's wanted. But the agent is reminded.

## 7. Tasks

| ID | Task | Agent | Depends |
|---|---|---|---|
| 620.T1 | Implement `vice1541_first_divergence` MCP tool | Opus | scenarios already registered via `runtime_run_scenario` |
| 620.T2 | Build VICE WASM module + `bridge.ts` | Sonnet | emcc toolchain |
| 620.T3 | Author 5 seed diff-tests: `viacore_store`, `viacore_read`, `rotation_rotate_disk`, `gcr_convert_4bytes_to_GCR`, `driverom_initialize_traps` | Sonnet | 620.T2 |
| 620.T4 | Add `types_int.ts` + FC-8 lint rule | Sonnet | T0.1 in place |
| 620.T5 | Tag existing trace tools as `profiling`; add warning hook | Sonnet | — |
| 620.T6 | Add RFL-check session-note requirement to CLAUDE.md | Opus | — |

## 8. Acceptance

Spec is DONE when:

1. 620.T1 lands and produces a `divergence_cycle` for the known motm scenario.
2. 620.T2 + T3 land; `npm run test:diff` runs and is green for the 5 seed functions.
3. 620.T5 lands; profiling tool calls produce the warning when port-divergence intent is detected.
4. CLAUDE.md cites Spec 620 §2 RFL + §6 tool-warning rule.

## 9. Out of Scope

- WASM-building the full VICE binary (only the `vice1541` subset is needed for diff-testing).
- Live debugger UI for first-divergence output (JSON is enough for agents).
- Replacing existing trace store (DuckDB infra stays — diff-trace reads from it).

## 10. References

- `specs/612-1541-port-fidelity-rules.md` — parent fidelity spec.
- Memory `feedback_read_vice_first.md` — same lesson, narrower scope (Spec 140 v2 incident).
- Memory `feedback_trace_into_duckdb.md` — addresses HOW to trace (DuckDB not JSONL); orthogonal to WHEN.
- 2026-05-17/18 overnight debug session — incident report.
