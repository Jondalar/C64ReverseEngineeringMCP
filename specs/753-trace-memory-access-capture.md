# Spec 753 — Trace memory-access capture + `trace_memory_map`

**Status:** DONE (2026-06-03) — P1+P2+P3 shipped, gate `e2e:753` 28/28; runtime
product proof 8/8 + single-path 25/25 (CPU-core change is inert when not
tracing). Adversarial review (5 lenses + verify) ran; 4 real findings fixed
(see §10). **Recon corrected the spec's central claim:** the CPU store was NOT
unwired — `cpu65xx-vice.ts` already had a full (but unused) bus-trace harness
(`busTraceEnabled`/`addBusListener`/`emit`); `store()`/`loadRead()` already
emit WRITE/READ. The wire is a **bridge listener** in integrated-session →
producer, NOT a new `Cpu65xxOptions` field (spec §4 rows 1/2/7 were wrong).
Original feature request preserved below.

**Status (orig):** PROPOSED (2026-06-03) — feature request. Infra already exists; this is a
wire-up + one downstream tool, not a new subsystem.
**Owner:** headless CPU core / trace producer / trace-store / runtime MCP facade
**Depends on:** Spec 708 (streaming trace), Spec 726 (trace-store schema / `bus_events`),
Spec 746 (live trace, backpressure/abort)
**Related:** Spec 752 (extract-first doctrine — see §6, this is *behaviour* capture, it
does NOT ground "what a block is"), Spec 750 (cartography visualization — a memory map is
the RAM-side analogue of disk cartography)
**Origin:** Wasteland EF/MegaCart64 porting (user). Two load-bearing questions could not
be answered from the existing trace: (1) *which RAM is free* for resident EAPI + a
relocated fastloader + a save-overlay cache (EF-legal RAM only: `<$8000` or `$C000-$CFFF`);
(2) *what actually mutates* (persistence surface). Both need an exact RAM write-map.

## 1. Problem

There is no exact, trace-derived RAM memory map. Today the only way to build one is to
**decode the `instructions` table** (pc, opcode, b1, b2, a, x, y) and compute store targets
downstream. That works for absolute / absolute-indexed / zero-page (and even self-modified
absolute, because b1/b2 carry the modified operand at execution time) — but it is
**blind to indirect addressing**: `STA ($zp),Y` ($91) / `STA ($zp,X)` ($81) targets cannot
be recovered from the instruction row alone (the pointer lives in zero-page and changes over
time). Reconstructing them requires a stateful ZP-shadow replay over the *entire* instruction
stream (127M+ rows for one Wasteland session) — expensive and fragile.

Concretely, on the Wasteland live trace `($12),Y` alone fired **115,000** writes whose
targets span `$00xx–$EExx`; a naive direct-store memory map shows those pages as "untouched"
and would wrongly offer them as free RAM (e.g. into the bitmap or a buffer). **Leftover-screw
risk: a memory map that silently omits indirect writes is worse than none.**

The emulator already computes the effective address (EA) when it performs the access. Capture
it at the source → exact, uniform across all addressing modes, no downstream decode or replay.

## 2. Key finding — the infra is already present, only the C64 CPU store is unwired

The drive/IEC side of `bus_access` is captured today; the **C64 CPU RAM/IO writes are not**.
Everything else needed already exists:

- `BusAccessTraceProducer.emitC64Access({op, addr, value})` — `src/runtime/headless/trace/bus-access.ts:~102`
- `bus_access` channel + `TraceRegistry.publish("bus_access", …)` — `bus-access.ts:155`
- `mem-row` capture-kind + `mem-access` trigger (addr-range + read/write/any) — `trace-definition.ts:24-29`, `trace-run.ts:96-99,503-542`
- `bus_events` rows carry `pc, kind, addr, value, old_value` with `kind ∈ {read, write, …}`
  already in the enum — `chunk-buffer.ts:75-79,263-310`, schema `schema726.ts:46-64`
- Producer → chunk path: `producer.ts:onBusAccess (146-224)` → `appendBusEvent`
- Backpressure/batching: ~65k-row chunks + 16MB bounded queue + worker thread + graceful
  abort (Spec 746 / BUG-030)

The single missing wire: `Cpu65xxVice.store()` (`cpu65xx-vice.ts:465`) does not call the
producer.

## 3. Design

Wire the C64 CPU memory access to the existing `bus_access` producer, **opt-in** per
trace-def (the `memory` domain + a `mem-row`/`mem-access` capture must be declared; absent
that, the channel stays disabled and nothing is emitted — zero overhead).

Emit shape (one `bus_events` row per captured access):
`{ pc, kind: "write"|"read", addr: EA, value, old_value }` — `old_value` read at `addr`
*before* the write, so mutation/diff (`old ≠ new`) is free.

Reuse `mem-row` (no new capture-kind needed); the channel is `bus_access` with `op`.

## 4. Integration points (recon, file:line)

| # | File | Line | Edit |
|---|------|------|------|
| 1 | `cpu65xx-vice.ts` | 129 (`Cpu65xxOptions`) | add `busAccessProducer?: BusAccessTraceProducer` |
| 2 | `cpu65xx-vice.ts` | 365 (ctor) | `this.busAccessProducer = opts.busAccessProducer` |
| 3 | `cpu65xx-vice.ts` | 465 (`store`) | capture `oldValue` then `busAccessProducer?.emitC64Access({op:"write", addr, value, oldValue})` |
| 4 | `cpu65xx-vice.ts` | 451 (`loadRead`) | optional read emit (Phase 2) |
| 5 | `bus-access.ts` | 36 / 102 / 149 | add `oldValue?: number` to `BusAccessEvent` + `emitC64Access` |
| 6 | `producer.ts` | 192 (`onBusAccess`) | map `ev.data.oldValue → oldValue` column |
| 7 | `integrated-session.ts` | ~525 | pass `busAccessProducer` into `Cpu65xxVice` options |

Gating already correct: `bus-access.ts:137` checks `channel.isEnabled("bus_access")`.

## 5. Downstream tool — `trace_memory_map`

New MCP tool (and a `trace_finalize` auto-artifact when `mem-row` was captured):

Input: `session | store`, optional `{mergeGap, regions, cpu}`.
Process: `GROUP BY addr` over `bus_events` (+ `instructions` for exec/code) →
- per-region role: **CODE** (fetched as opcode) · **DATA-W** (written) · **DATA-R**
  (read-only) · **untouched**
- **provenance**: which `pc`(s) wrote each region (binds data to code)
- **metrics**: write-count (hot/cold working set), first/last cycle, `old≠new` mutation
  count (the persistence surface)
- **reconcile with static**: overlay the module load-map / analysis-json segments;
  `"provably free" = untouched-in-trace AND not static-occupied`.
Output: region table (+ ASCII map) + free-hole list.

**Caveat baked into the output:** a trace is ONE path. "untouched in trace" ≠ "free" —
untested paths (battles, other areas, utils-save) may use it. The reconcile-with-static
column and an explicit "coverage = this run only" banner are mandatory so the map is not
mistaken for a proof.

A working prototype exists in the Wasteland project
(`tools/wl_memmap.py`) — it produces the exec + direct-write map and *demonstrates the
indirect blind spot this spec fixes*. It is the de-facto spec for the tool's output.

## 6. Boundary vs Spec 752 (extract-first)

This is **behaviour capture**, not grounding. A memory map answers *"what runs/writes where,
and what is free at runtime"* — it does NOT claim *"what a block IS"* (that remains the
extracted bytes + disasm, per Spec 752 L1). The memory map is a porting/footprint aid
(free-RAM, persistence surface), explicitly a runtime-behaviour artifact. The two must not be
confused — same rule as Spec 752 §0.

## 7. Volume / perf

Fires on most instructions (≈1 write/instr; RMW=2; stack push=1). Peak in tight loops
(fastloader) ~millions/sec. Mitigated by: opt-in gating, ~65k-row chunk batching off the
event loop, the existing 16MB bounded queue + graceful abort, and the `mem-access` trigger's
addr-range filter (capture only a window when you don't need the whole map).

## 8. Phases

- **P1** — writes + `oldValue`, reuse `mem-row`, wire `store()`. Acceptance: a known program
  with an indirect `STA ($zp),Y` produces `bus_events` rows with the correct EA + old/new.
- **P2** — read capture (`loadRead`) for const/table + code-read-as-data detection.
- **P3** — `trace_memory_map` MCP tool + `trace_finalize` auto-artifact + reconcile-with-static.

## 9. Acceptance gate (`e2e:753`)

1. Run a fixture program containing absolute, abs,X, zp, and `($zp),Y` stores.
2. Capture with `captures:[{kind:"mem-row"}]`, domain `memory`.
3. Assert `bus_events` contains each store with the exact EA (esp. the indirect one,
   which the instruction-decode path cannot resolve) + correct `value`/`old_value`.
4. `trace_memory_map` reconstructs the page map; the indirect target appears; an
   untouched page is reported free; reconcile-with-static flags a statically-owned page
   that was untouched in the run.
5. With no `mem-row` capture declared → zero `bus_events` memory rows (gating / no overhead).

## 10. Implementation (DONE 2026-06-03)

**Capture wire (P1+P2).** Bridge listener in `integrated-session.ts` (inside the
`enableBusAccessTrace` block): `c64Cpu.addBusListener(ev → producer.emitC64Access)`
forwarding only `WRITE`/`READ` (not `FETCH`/`DUMMY_*`, so `bus_events` reads are
genuine data reads) + `enableBusTrace(true)`. Gated three ways → zero-overhead off:
`busTraceEnabled` (CPU `emit`), `producer.enabled`, `registry.isEnabled('bus_access')`.

**`oldValue` (the persistence surface).** `store()` pre-reads the prior value for
`addr` in `$0002–$CFFF` (side-effect-free window — excludes `$00/$01` 6510 port +
`$D000-$DFFF` I/O) and carries it on the `BusEvent`. It had to be plumbed through
the **binary product path**, which dropped it everywhere: `encodeMemAccess`
(+1 byte, present-bit in the access byte) → `decodeEvent` → `appendMemAccess` →
the channel→binary sink → the indexer `data_json` → the `bus_events` **VIEW**
(was hard-coded `NULL::UTINYINT`). Plus the legacy chunk `onBusAccess` path.

**`trace_memory_map` tool + finalize sidecar (P3).** GROUP BY addr over
`bus_events` (+ `instructions` for CODE) → per-page role / region table / writer-PC
provenance / mutation count / **provably-free** holes (untouched AND not
static-occupied; EF-legal annotated) / reconcile via optional `static_ranges`.
Mandatory coverage banner. `runtime_trace_finalize` auto-writes a
`<store>.memorymap.md` sidecar (soft-fail both routes; daemon-safe via routed
`safeQuery`). **Deliberately a loose sidecar, NOT a registered knowledge
artifact** — per Spec 752 a trace is behaviour, not grounding, so it stays out of
the artifact store and can never satisfy the L1 backing predicate.

### Adversarial review — 4 real findings fixed
- **Binary format version (blocker).** SIZE 14→15 with no version bump → an old
  v1 `.c64retrace` would silently mis-frame. Bumped `C64RETRACE_FORMAT_VERSION`
  to 2; `decodeFileHeader` now rejects a mismatch loudly (traces are ephemeral).
- **`$0001` pre-read (verified false, fixed anyway).** Reading `$01` mutates 6510
  capacitor-decay state; the immediately-following `store` write clobbers it, so
  no divergence — but `$00/$01` are now excluded from the pre-read regardless
  (their old value is meaningless for the map; cheap insurance for CPU fidelity).
- **`emitDriveAccess` contract.** Interface declared `oldValue?` the impl never
  accepts/emits → removed from the interface (drive supplies no oldValue).
- **Soft-fail completeness.** The finalize sidecar call (incl. its dynamic import)
  is now wrapped in `try/catch` in both routes so it can never turn a good
  finalize into an error envelope.

### Known limitations / follow-ups (NOT blocking)
- **753b — drive memory capture.** The 1541 drive CPU is not wired for general
  RAM/ROM bus capture (only VIA1 `$1800` is instrumented). A `drive8` memory map
  would show only I/O. Wiring `drivecpu`/`drive_6510core` store/load → a drive
  bridge (with its own `oldValue`) is the follow-up.
- **I/O `old_value`.** C64 writes to `$00/$01` and `$D000-$DFFF` carry no
  `old_value` by design (side-effect-free-read rule). Acceptable: those are not
  the RAM persistence surface.
- **Knowledge-graph artifact.** The map is a sidecar file only. Registering it as
  an *internal behaviour* artifact (kind `other`, role `runtime-memory-map`,
  non-grounding) is a possible refinement — kept out for now to avoid any L1
  coupling.
- **`mergeGap`** (spec §5 input) is not implemented; regions are exact contiguous
  same-role/same-owner runs. Add a gap tolerance only if a real map is too noisy.
