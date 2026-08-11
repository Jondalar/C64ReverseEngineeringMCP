# Spec 805 — Sandbox batch: one process start for N runs

**Status:** DONE 2026-08-11 — A and B built and measured; C is this line.
Gate `npm run e2e:805-sandbox-batch` (7/7). Measured: 20 sandbox runs went
15.09 s → 0.83 s (**18.1×**) with byte-identical results, and through the C64RE
bridge 10 payloads cost 937 ms against 897 ms for a single one — N for the price
of one. The 101-chunk case extrapolates from ~75 s to ~4 s.
**Repos:** cross-repo — the batch mode is TRX64 (`../TRX64`), the bridge is C64RE.
**Number:** 805 (shared board `specs/README.md`). **Follow-up to** Spec 788.

---

## 1. The measurement

`src/sandbox/trx64cli.ts` runs `execFileSync` — **one process start per sandbox
call** (`:75`, `:101`). Measured on this machine's dev binaries, warm, repeated:

| | |
|---|---|
| `trx64cli` process start (any subcommand, incl. `--help`) | **740 ms** |
| a tiny binary from the same workspace, same toolchain, same ad-hoc signature | 86 ms |
| the actual sandbox work | milliseconds |

So ~650 ms per call is `trx64cli` starting itself, before argument parsing —
eager machine init, which is deliberate for an emulator and pointless for a
one-shot. Stripping the binary made it *worse* (923 ms), so it is not size.

**The cost is real work already being paid.** One proof project depacked **101 of
101** chunks through this bridge by driving the title's own depacker. That is
**101 × 740 ms ≈ 75 seconds of pure process startup**, for work measured in
milliseconds. The corpus campaign multiplies it by every title.

## 2. Why not the obvious fix

**Not "run the sandbox inside the daemon."** A scratch machine in the daemon
process means two machines in one process. Doctrine rule 2 forbids it, and it is
not merely a rule: the literal-port VIC and the whole vice1541 stack keep state in
module-level globals, so a second machine would corrupt the first. Spec 787 says
so in its own guardrail — a scratch instance is one *by definition of being its own
process*.

**Not "re-implement the run over daemon calls" either.** A sandbox run is not one
operation: seed or cart or disk attach, N blob loads, zero-page seeding, an `$01`
memory config, an 11-byte entry stub the CLI *builds*, an entry PC, a sentinel
besides the routine's own RTS-return, cycle and instruction caps, and M harvest
ranges. Driving that over individual RPC calls duplicates the orchestration on the
C64RE side and puts it out of step with the CLI the moment either changes.

## 3. The cut

**One process start, N runs.** The scratch instance stays exactly what 787 defined
— its own process, its own machine — and simply serves more than one run before it
is disposed. Between runs the machine returns to a known state through the existing
power lifecycle (Spec 786), which is what a fresh `trx64cli sandbox` does anyway.

That turns 101 × 740 ms into 740 ms + 101 × (the actual work).

## 4. Deliverables

**A — TRX64: `trx64cli sandbox --batch <spec.json>`.**
Reads N run specs — each the same parameter set the flags express today — and emits
one JSON array of results in the same shape as the single-run `--json`. Runs are
independent: each gets the machine back in the state a fresh process would give it,
and a run that faults does not abort the batch or contaminate its successor.
*AC:* a 2-run batch produces the same two results as two separate invocations,
byte for byte; a deliberately faulting first run leaves the second correct; a
50-run batch pays the process start once, shown by wall-clock against 50 singles.

**B — C64RE: the bridge batches.**
`src/sandbox/trx64cli.ts` gains a batch entry point, and the callers that have N
payloads to depack use it instead of a loop of single calls. The single-call path
stays for the genuinely single case.
*AC:* depacking N payloads spawns one process, not N; the per-payload results are
unchanged; a batch of one behaves exactly like a single call.

**C — Doctrine + spec sync (rule 9).** 788's archive entry records that the bridge
gained a batch path and why.

**BUILT.** A: `trx64cli sandbox --batch <spec.json>`, items carrying the same
string forms the single-run flags take, run through the same `run_sandbox_cli` so
batch and single semantics cannot drift. Each item on a fresh thread — not for
parallelism (they are sequential) but because the core carries one thread-local,
the IEC bus status arrays mirroring VICE's statics, that no machine constructor
resets. B: the C64RE bridge builds a batch SPEC rather than an argv, and the
single-payload entry point is now literally a batch of one — so the two paths are
the same code. A failing payload is reported in its own slot rather than sinking
the batch, including a layout error caught before the run.

## 5. Non-goals

- **No scratch machine in the daemon.** §2. If that ever becomes desirable it is a
  change to doctrine rule 2 and to the module-global state underneath it, not a
  transport tweak.
- **No fix to the 650 ms itself.** Eager machine init is intended for the emulator;
  making it lazy so a static one-shot skips it is a separate question, and it
  belongs with 774's machine-free static endpoint rather than here.
- No change to what a sandbox run *is* — same parameters, same semantics, same
  real-6502 execution on a throwaway instance.

## 6. Acceptance

- A 50-run batch and 50 single runs produce identical results, and the batch is
  faster by approximately 49 × the process start.
- One process observed per batch (not N).
- Doctrine rule 2 is untouched: one machine per process, still.
