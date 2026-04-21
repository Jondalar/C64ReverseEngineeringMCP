# 6502 Sandbox

Lightweight, self-contained 6502 sandbox for porting depackers, crypto
routines, and custom I/O code without standing up a full emulated C64.

The sandbox CPU lives in `src/sandbox/cpu6502.ts` and supports the
documented 6502 ISA plus the undocumented opcodes commonly seen in
depacker wrappers (RLA, SLO, RRA, ISC, LAX, SAX, DCP, ALR, ARR, AXS, ANC,
undoc NOPs, JAM). No I/O bus, no banking — just a flat 64K
`Uint8Array` plus a write log.

## Tool

| Tool | Description |
|---|---|
| `sandbox_6502_run` | Load code/data into a flat 64K RAM, optionally hook PCs to feed bytes from an input stream (e.g. replace a serial-recv subroutine), execute until a stop PC / sentinel RTS / max steps / unimplemented opcode, and return the writes plus final CPU state. |

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
- writes filtered by an optional `returnWritesRange`
- a `writtenSpan` that flattens those writes into a contiguous byte buffer
- optional memory snapshots of explicitly requested ranges

## Smoke test

`scripts/sandbox-lykia-smoke.mjs` runs the sandbox against Lykia disk1
file 01 and verifies a byte-identical match (md5
`d95b221327f8a692b437fddbdb37cd7c`, `$4000-$407D`, 126 bytes) versus the
reference `tools/lykia_disk_depack.py`. The TS sandbox terminates cleanly
via `stream_exhausted` after ~48 k steps; the Python reference burns its
10 M-step budget because it does not treat stream exhaustion as a stop.
