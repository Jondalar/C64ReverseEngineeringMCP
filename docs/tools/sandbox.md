# 6502 Sandbox

Lightweight, self-contained 6502 sandbox for porting depackers, crypto
routines, and custom I/O code without standing up a full emulated C64.

The sandbox does not carry a CPU of its own. It runs the REAL 6502 core in a
scratch instance (`src/sandbox/sandbox-runner-realcore.ts`, reached through
`src/sandbox/index.ts`), which is why a depacker that leans on an undocumented
opcode behaves here exactly as it does anywhere else — there is no second
implementation to disagree with.

This paragraph used to describe a TypeScript CPU at `src/sandbox/cpu6502.ts`.
That file went with the in-repo emulator (Spec 806) and the doc kept pointing at
it for months, which is the failure mode a tools page has: nobody re-reads the
first paragraph.

## Tool

| Tool | Description |
|---|---|
| `sandbox_6502_run` | Load code/data into a flat 64K RAM, optionally hook PCs to feed bytes from an input stream (e.g. replace a serial-recv subroutine), execute until a stop PC / sentinel RTS / max steps / unimplemented opcode, and return the writes plus final CPU state. |

## Project resolution (Spec 833 D5, Spec 834)

Relative paths — `loads[].prg_path`, `loads[].raw_path`, `input_stream_path`,
`output_path` — resolve against the project root, and the root is found the same
way every other path-taking tool finds it: an explicit `project_dir`, else by
walking up from the **first path in `loads[]`** to `knowledge/phase-plan.json`.
The tool used to pass the resolver no hint at all, which left it depending on
`C64RE_PROJECT_DIR` or on the process cwd happening to sit inside a project.

`sandbox_depack` works the same way and was a sharper case of it: it DECLARED
`project_dir` and then resolved without it, so the parameter a caller passed was
read by nobody (Spec 834). It now resolves `project_dir ?? input_path`.

A `loads[]` made only of `hex_bytes` carries no path, and such a run needs no
project either: every byte is inline. The root is therefore resolved on first
use rather than up front, so a fully inline run never asks for one and no longer
fails outside a project for a filesystem it does not touch.

## Stream-byte hook

When the CPU enters a hooked PC it synthesises **"A = next stream byte;
C = 0; RTS"** instead of executing the real routine. This is exactly how
the Lykia disk depacker is ported in `tools/lykia_disk_depack.py`: the
real `$0251` / `$0289` serial-recv routines block on CIA2 + IEC, so the
sandbox replaces them with byte-for-byte stream feeds.

## Stop conditions

- `stop_pc` — caller-supplied PC reached
- `sentinel_rts` — RTS popped sentinel `$FFFE` (pre-staged at
  `$01FE = $FD`, `$01FF = $FF`)
- `max_steps` — instruction budget exhausted
- `brk` — BRK encountered
- `jam` — illegal JAM opcode
- `stream_exhausted` — stream hook fired with no bytes left
- `unimplemented_opcode` — unsupported opcode (returned to the caller
  with the offending PC + opcode)

## Returned data

- final CPU state (PC / A / X / Y / SP / flags / cycle counter)
- `writtenRuns` — every contiguous stretch the run STORED to, with its bytes
- writes filtered by an optional `returnWritesRange`
- a `writtenSpan` bounding those runs, holes marked `null`
- optional memory snapshots of explicitly requested ranges, un-written bytes
  marked `null` (`observed` carries the raw window beside them)

## Only what the run WROTE is payload (issue #17)

A harvest is a slice of a whole machine, and most of a machine is not this
routine's output. The sandbox used to hand back the slice and nothing else: the
bytes the routine never stored came back as whatever was lying there — the
power-on RAM pattern, KERNAL RAM-test leftovers, screen RAM, or the caller's own
loaded bytes — and nothing marked them. A multi-block depacker writes DISJOINT
runs, so the gaps between them were exactly where a reader picked up residue and
read it as payload. That cost a reporter significant time on a three-disk game
with a custom backward-LZ packer.

This is Spec 832 D4 with different bytes: tolerant is not the same as inventing.
An unreadable thing yields no bytes rather than plausible ones.

**A gap is `null`.** Not a zero, not a mask a caller can forget to read, not the
run list alone:

- `null` is not a byte. `$00`–`$ff` is the whole domain of one, so nothing
  downstream — a hex formatter, a comparison, a JSON consumer — can turn a hole
  into a plausible value by accident. In TypeScript the field's type is
  `(number | null)[]`, so the compiler makes every consumer in this repo say what
  it does with a hole.
- A parallel mask, or the run list on its own, leaves the byte array still
  *looking* like data. Anyone who does not read the second channel ships residue,
  which is the defect, not a fix for it.
- The raw window is not lost — it survives as `observed` on each snapshot, and
  the tool prints it only under `include_observed`. Reading residue stays
  possible; it just cannot happen by accident.

`writtenSpan` no longer gap-fills with zeroes (those zeroes were invented), and
`output_path` writes **one PRG per run** — a PRG has no way to express a hole, so
a gapped write set becomes several files rather than one file with fabricated
bytes in the middle. A single contiguous run still writes one file at the exact
path asked for. Past 64 runs it writes **nothing** and says so — a scattered
routine's output is neither 200 fragments nor one span full of bytes it never
stored, and `return_writes_start` / `return_writes_end` is how to ask for the
part that is wanted.

`sandbox_depack` returns one contiguous run as `unpacked` (it always did), and
now also reports `writtenRuns` — every run the depacker wrote — plus
`returnedRun`, so a multi-block depack says what it did not hand back instead of
letting the caller widen the window and harvest the gaps.

The runtime CLI's own harvest (`trx64cli sandbox --harvest`, sibling TRX64 repo)
already reports the runs beside the window: `writtenRuns` in `--json`, `runs=[…]`
in the text line. It is the C64RE side that was not passing that on.

Gate: `npm run e2e:838-harvest`.

## Smoke test

`scripts/sandbox-lykia-smoke.mjs` runs the sandbox against Lykia disk1
file 01 and verifies a byte-identical match (md5
`d95b221327f8a692b437fddbdb37cd7c`, `$4000-$407D`, 126 bytes) versus the
reference `tools/lykia_disk_depack.py`. The TS sandbox terminates cleanly
via `stream_exhausted` after ~48 k steps; the Python reference burns its
10 M-step budget because it does not treat stream exhaustion as a stop.
