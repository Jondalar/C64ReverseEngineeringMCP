# Spec 788 — Real-Core Execution Sandbox (retire the TS 6502)

**Status:** PROPOSED
**Repos:** cross-repo — the execution primitive is TRX64 (`../TRX64`); the harvest
verdict + payload registration + tool/CLI wiring are C64RE.
**Number:** 788 (shared board `specs/README.md`).
**Depends on:** **Spec 787 (Scoped TRX64 Instances)** — this spec is 787's first
consumer; it runs on a v1 separate-process scratch instance.
**Doctrine anchors:** Leitregel (Capability → TRX64), `docs/agent-doctrine.md
§0.5` (static-first: run only to CONFIRM a read-derived hypothesis), Spec 723
(single-path — untouched), Spec 612/620 (port-fidelity: a divergent second
implementation is a hazard), Spec 771 (TRX64 backend), Spec 780 (TRX64cli).
**Reused substrate:** 705.A/B (RuntimeCheckpoint + ring), 707 (`.c64re`), 761 §1
(atomic full-system restore incl. drive).

---

## 0. What this spec IS (and is NOT)

**IS:** move depack/oracle off the standalone TypeScript 6502 and onto the
**authoritative core**, run in a scratch instance (Spec 787) seeded to a known
state, and package the recurring shape (seed → call an in-image routine → run to a
sentinel → harvest a RAM slice) as `run_routine_to_sentinel`.

**IS NOT:** the scoped-instance lifecycle itself (that is Spec 787), a change to
the `sandbox_6502_run` / `sandbox_depack` **tool contracts** (engine-only), or a
raw open machine surface (§7).

## 1. Problem — the sandbox runs on a non-authoritative shadow CPU

`sandbox_6502_run` (`src/server-tools/sandbox.ts` → `src/sandbox/index.ts`
`runSandbox`) and `sandbox_depack` (`sandbox-depack.ts` → `genericSandboxDepack`)
execute on **`src/sandbox/cpu6502.ts`** — a standalone, hand-written TypeScript
6502 (`class Cpu6502`, ~38 KB), second-class by its own header:

- *"No IO bus, no banking — just a flat 64K Uint8Array"* (`cpu6502.ts:5`).
- *"approximate; we don't track per-opcode cycle counts here"* (`cpu6502.ts:172`).
- *"Differences vs `runtime/headless/cpu6510.ts`: that one is the 'full machine'
  CPU…"* (`cpu6502.ts:8`) — **and that file no longer exists.** Single-path (723)
  removed `cpu6510.ts`; the runtime CPU is `cpu/cpu65xx-vice.ts`. The sandbox CPU
  documents itself against a deleted reference.

So the extraction path trusts a **third, orphaned 6502** to be byte-correct with
no diff-gate against the authority (four exist: TRX64 Rust core; TS
`cpu65xx-vice`; this `Cpu6502`; TS drive `drive_6510core`). Two failure modes:

- **Silent mis-mint.** An undoc-opcode or decimal-mode corner the shadow gets
  subtly wrong → `sandbox_depack` emits *wrong* decrunched bytes, uncaught. The
  divergent-second-implementation hazard of Spec 612/620, unguarded, in the
  extraction path.
- **Can't-run-at-all.** Flat 64K, no IO/banking/drive → any depacker touching
  banking, `$DE00`, cart flash, or the 1541 cannot execute at all — the
  EF-resident case.

## 2. Approach

Run the title's **own** loader/depacker on the authoritative core, in a scratch
instance (Spec 787) seeded to a known full-system state (reuse the atomic restore
of 761 §1 — RAM + both CPUs + CIA/SID/VIC + drive + disk image, one boundary),
then harvest the result. Don't reimplement the depacker and don't maintain a
shadow 6502 — execute on the authority, seeded to the right state. (This shape was
demonstrated externally by a harness that seeded a machine, `jsr`'d the game's own
entry, ran to a sentinel, and sliced the depacked bytes out of RAM.)

## 3. The execution primitive

```
run_routine_to_sentinel(seed_ref, entry_pc, sentinel_pc, harvest_range) -> bytes
```

1. inject stub bytes / set entry PC, 2. run to the sentinel breakpoint, 3. slice
the harvest range out of RAM. `seed_ref` = a checkpoint / `.c64re` / cold+load
recipe.

**Self-gating / static-first.** Every parameter is read-derived — you must
already know the entry, the sentinel, and where output lands, all from having READ
the loader. The primitive **executes** a structure you derived and returns bytes
to CONFIRM it (0-diff vs your reimplementation, or as ground truth to reconcile a
reimplementation against). It cannot *discover* structure; the signature is the
gate. No extra hypothesis-gate needs bolting on — this is the good "sandbox
oracle" of the doctrine, not the "boot and watch" it forbids.

## 4. Placement + retire the shadow

- **Capability → TRX64.** `run_routine_to_sentinel` is a core/daemon primitive,
  exposed via the CLI (780) for the scratch path and via the existing `sandbox_*`
  MCP tools (contracts unchanged, engine swapped).
- **Verdict → C64RE.** The byte-diff / accept-reject / registration stay in the
  workbench (`validate_extraction`, `register_payload`, `link_payload_to_asm`).
- **Retire `Cpu6502`.** Once `sandbox_depack` / `sandbox_6502_run` route through a
  scratch real-core instance, `src/sandbox/cpu6502.ts` (+ `opcode-table.ts` if
  unused) is deleted — not kept "just in case" (Fork B: a dead CPU path must not
  survive to satisfy a test). Decided: *the TS sandbox goes.*

## 5. Acceptance / proof gate (`e2e:788`)

(Instance isolation + one-live invariant are proven by 787's gate; 788 asserts the
sandbox behaviour.)

1. **Fidelity parity.** A depack the current TS `sandbox_depack` mints → re-mint
   via the real-core scratch path → **byte-identical** output. No regression on
   the easy case.
2. **Capability the shadow cannot do.** An EF-resident / banking-touching depacker
   (or a drive-read loader) runs to sentinel on the real core and harvests correct
   bytes — a case `Cpu6502` provably cannot execute (assert the old path
   throws / isolated-fails on the same input).
3. **Self-gating clean-fail.** `run_routine_to_sentinel` with correct params →
   expected slice; with a wrong `sentinel_pc` → clean cap-out error, **no silent
   partial harvest**.
4. **Retirement complete.** `src/sandbox/cpu6502.ts` removed; `sandbox_6502_run` /
   `sandbox_depack` tool I/O contracts unchanged, now backed by the real core.
5. **CLI.** `trx64cli sandbox --seed <ref> --entry <pc> --sentinel <pc> --harvest
   <addr>:<len> --json` returns bytes + metadata in a self-disposing scratch
   process.
6. Runtime product proof baseline stays green (touches the core path).

## 6. Build order

Foundation first: **Spec 787** (scoped-instance lifecycle + CLI) must land before
this. Then:

1. **Real-core sandbox engine.** Route `sandbox_depack` / `sandbox_6502_run`
   through a 787 scratch instance on the real core; keep tool contracts. Prove
   fidelity parity (test 1).
2. **`run_routine_to_sentinel` primitive** (core/daemon) + CLI surface. Prove
   tests 2, 3, 5.
3. **Retire `Cpu6502`** once 1–2 are green (test 4).
4. **Baseline gate** (test 6).

## 7. Non-goals

- Not the scoped-instance lifecycle (Spec 787).
- Not a raw "LLM reaches everything in a live machine" surface — `run_routine_to_
  sentinel` is narrow and self-gating (§3). Do not conflate.
- Not a change to the `sandbox_*` tool contracts — engine-only.
- Not a second execution path or a new emulator. Fewer 6502s, not more.
- Not the scrub timeline (761) or ring/storage (766).

## 8. Decided

- **OQ1 → cold+load is the DEFAULT + the gate; `.c64re` mid-run seed is the
  ESCALATION** (2026-07-15). The `seed_ref` stays **polymorphic** (cold+load
  recipe | `.c64re` | checkpoint) — this is a "which default + what to gate on"
  call, not exclusive. Rationale:
  - **Cold+load (A)** covers the majority (self-contained depackers: packed bytes
    in → unpacked out, own ZP scratch) and is static-first-faithful (packed
    location + entry + sentinel are read-derived). It is deterministic /
    N-times-mintable / byte-comparable.
  - **`.c64re` (B)** is only for depackers that depend on state set by an *earlier*
    loader stage (ZP/IO/banking/tables). Drop-in via the same `seed_ref` (707
    undump already exists); used only when a real target proves A insufficient
    (crash / wrong bytes). Costs nothing to keep available; not a 788 gate blocker.
  - **First gate target = a cart/EF-resident depacker via cold + attach-cart +
    run-its-own-entry** — one A-case that proves BOTH parity (self-contained) AND
    the capability the flat-64K TS shadow cannot do (banking / `$DE00` / cart
    flash). A is thus both the common path and the capability proof.
