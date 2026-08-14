# Bug: Observer `do log` stamps cyc/PC/A per run-segment, not per event — and conditions evaluate against the same stale snapshot

- **ID:** BUG-042
- **Date:** 2026-08-14
- **Reporter:** llm (peer session WL1, live on `integrated-1`); root cause verified here
- **Area:** runtime
- **Severity:** high (defeats the purpose of `do log`, and silently mis-evaluates register conditions)
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Surface: `runtime_monitor` → `obs <n> when load|store <lo..hi> do log`
- Observed watching `$8C66..$8DFF` during a boot-time BB2 depack

## What happened

Every event in a run segment carries the **same** `cyc`, `pc` and `a`. Roughly 130
consecutive store/load hits all report `cyc=24578787, pc=$093C, a=$06`; the next block
shares `cyc=24598444`, and so on.

The reporter's arithmetic is the giveaway and it is correct: a 6502 `sta` costs at least
three cycles, so hundreds of accesses cannot share one cycle count. The address/value pairs
are right — only the stamps are batched.

## Root cause (verified in the code, not inferred from the symptom)

`crates/trx64-daemon/src/main.rs:3051`:

```rust
// Refresh the env from the current (segment-start) CPU + raster state so
// exec/access conditions eval against it.
reg.set_env(observers::CpuSnapshot::from_machine(&session.machine));
```

The observer env is refreshed **once per run segment**, at its start. Then
`on_access_policy` reads `let pc = self.env.pc;` for every access in that whole segment.
Hence one stamp per segment, changing only when the next segment begins — exactly the block
pattern reported.

It cannot currently be right, because the hook has no way to know:

```rust
fn on_access(&mut self, kind: BusKind, addr: u16, value: u8) -> bool
```

No PC, no clock, no registers. The hook that *does* carry them is a no-op in the registry:

```rust
fn on_bus(&mut self, _kind: BusKind, _addr: u16, _value: u8, _pc: u16, _clk: u64, _old: u8) {}
```

and the core already passes all of it (`crates/trx64-core/src/cpu.rs:292-294`).

## Second consequence, worse than the logging

The comment says the env exists **"so exec/access conditions eval against it"**. So a
condition like

```
obs bb2 when store $8C66..$8DFF if a==$06 do log
```

is evaluated against the **segment-start** accumulator, not the accumulator of the
instruction that actually performed the store. That means an observer can fire on the
wrong events and miss the right ones — and unlike the stamps, nothing about the output
looks suspicious. The reporter called this "not a blocker"; the stamping half is not, but
this half quietly returns wrong answers.

## Expected

Each event carries the cyc/PC/A of the **triggering instruction**, and conditions are
evaluated against that same state.

## Repro steps

1. Start a session and let a depack loop run over a known range.
2. `obs w when store $8C66..$8DFF do log`
3. Run a few hundred thousand cycles.
4. Read the log: consecutive entries share one `cyc`/`pc`/`a`, in blocks.

## Evidence

```text
~130 consecutive store/load hits, all: cyc=24578787  pc=$093C  a=$06
next block, all:                        cyc=24598444  ...
```

## Scope guess

- `crates/trx64-daemon/src/observers.rs` — `on_access` (no PC/clk in the signature),
  `on_bus` (no-op), `on_access_policy` (`let pc = self.env.pc`), `matches`, `fire`
- `crates/trx64-daemon/src/main.rs:3051` — the per-segment `set_env`
- `crates/trx64-core/src/cpu.rs:254-294` — already passes `pc` and `clk` to `on_bus`

Two shapes are available: widen `on_access` to carry pc/clk/registers, or make the registry
use `on_bus` (which has them) and keep `on_access` as the cheap gate. The second keeps the
watch-gate fast path intact — the core only calls `on_access` for watched addresses, which
is why it is narrow in the first place.

## Notes / follow-up

- **Whatever the fix, the gate must be a real depack loop, not a synthetic write.** A test
  that stores twice will pass with the stale env, because two events in one segment can
  legitimately share a cycle. The property to assert is that consecutive events have
  *distinct, monotonically increasing* cycles across a few hundred accesses.
- Same class as the trace-domain work: an event that does not carry its own provenance is
  worse than a missing event, because it looks like data.

---

## Resolution

- **Root cause:** `on_access(kind, addr, value)` carried no per-access facts, so the
  registry read `self.env` — refreshed once per run segment at `main.rs:3051`. Every
  event in a segment shared one stamp, and every register condition tested some earlier
  instruction's registers.
- **Fix:** a new `trx64_core::AccessCtx { pc, clk, a, x, y, sp, p }` is handed to
  `on_access` at the moment of the access. `FullScBus` gained `core_regs` — a raw pointer
  to the executing core, following the same documented disjoint-field pattern (and the
  same safety argument) as the existing `core_pc`/`core_clk`. `matches`, `fire_at` and
  `render_log_exprs_at` take `Option<AccessCtx>`: `Some` on a bus hit, `None` on the exec
  path, where the core halts before the opcode and the segment snapshot IS this
  instruction's state.
- **Gate proving the fix:** `crates/trx64-daemon/tests/observer_stamps.rs` —
  `every_access_carries_its_own_cycle_pc_and_accumulator`. Runs a real store loop
  (`sta $4000,x` / `adc` / `inx` / `bne`) over 200+ accesses and asserts consecutive
  cycles are **distinct and increasing**, plus that more than eight distinct accumulator
  values are seen. Both are single-valued under the old behaviour. A two-store test would
  have passed with the bug, because two events in one segment can legitimately share a
  cycle — that is why the gate needed a loop.
- **Regression risk:** low. The trait signature widened, so every `Observer` impl had to
  be updated (three in-tree) — a compile error, not a silent behaviour change. The exec
  path is explicitly unchanged.
