# Spec 836 — A machine of your own

**Status:** PROPOSED 2026-09-09
**Origin:** A project session tried to start a headless runtime with its own
cartridge and got the human's live Wasteland session instead. Investigating that
turned up a defect worse than the missing feature.
**Anchor:** `DOCTRINE.md` rule 2 (one SHARED machine, plus ephemeral sandboxes
that end themselves on a budget) · Spec 812 (`runtime_scene_reel`, which already
does this correctly) · Spec 835 (a tool must say what it can do)
**Touches:** `src/server-tools/headless.ts` · `src/reel/sandbox-session.ts`
(reused, not changed) · a new tool · `docs/tools/headless.md` · two gates

## 1. Three findings, in the order they hurt

**D1 — `media_path` on an ATTACH mounts into the shared machine.**
`runtime_session_start` calls `createSession`, which attaches to the running
daemon's singleton, and then calls `media/open` unconditionally. So a second
session passing its own `.crt` does not get its own machine — it **swaps the
medium under the human who is using theirs**. BUG-041 made `media_path` work for
a cartridge, and Spec 835 documented it, and neither noticed that on the attach
path it is a write to somebody else's machine.

This is the one that costs work already done, so it goes first.

**D2 — no tool says which machine it touches.** `runtime_session_start`'s
description does not say that it is the shared, co-driven machine.
`runtime_scene_reel`'s does not say that its distinguishing feature is a private
throwaway machine. A caller who wants to test something without disturbing
anyone has no way to learn which door that is — which is exactly what happened.

**D3 — the private machine exists and has one caller.**
`src/reel/sandbox-session.ts` already does precisely what rule 2 describes: it
finds a free port, spawns the daemon as a CHILD, gives it a budget, ends it when
the budget runs out whether or not anyone is listening, and dies with the object.
Its only caller is `run-scenario.ts`, i.e. `runtime_scene_reel`. So the
capability is built and reachable only if you express your intent as a `.feature`
file. Anything interactive — stepping, a breakpoint, the monitor, `runtime_until`
— exists only against the shared daemon.

Note what is NOT missing: this needs no work in the runtime repo. Specs 787/788
describe scratch instances INSIDE one process and that is a different thing; a
second process on its own port is enough for "let me try something without
touching your machine", and it already runs.

## 2. Decisions

**D1 — an attach never changes the shared machine's medium.** When
`runtime_session_start` attached rather than created, a supplied `media_path` is
**refused, not applied**: the answer says the shared machine is already running
what it is running, that mounting into it is `runtime_media_mount`'s job (or the
monitor's `swapcrt`), and that a medium of your own is what the new tool below is
for. Refusing is right rather than harsh — there is a dedicated door for the
deliberate swap, so the accidental one has no reason to exist.

**D2 — every runtime tool says whose machine it is.** The shared ones say
"shared, co-driven, do not power-cycle it"; the private ones say "your own,
throwaway, ends on a budget". Stated in the tool description, where a caller
reads it, not only in the docs.

**D3 — `runtime_sandbox_run`: the private machine, without a `.feature` file.**
One tool, built on the existing `sandbox-session.ts`: give it a medium and a
budget, it starts a machine on its own port, runs, and reports. It ends itself
the way the reel's does. What it deliberately does NOT get is a `session_id` that
outlives the call — a sandbox that can be attached to later is a second shared
machine, and rule 2 has exactly one of those.

The scope question the build must answer: how much of the interactive surface
(steps, breakpoints, the monitor) can reach a machine that only exists for the
duration of one call. Whatever the answer, the honest version of this tool is the
one whose description says what it cannot do.

## 3. Gates

- `e2e:836-attach` — a `media_path` on an attach is refused and the shared
  machine's medium is unchanged; the refusal names `runtime_media_mount` and the
  sandbox tool; a create (no daemon running) still opens its medium.
- `e2e:836-sandbox` — the private machine runs on its own port, is not the
  shared one, ends on its budget, and leaves nothing behind; every runtime tool's
  description says which machine it touches.

## 3a. D3, as built — where the interactive line fell

`runtime_sandbox_run` (`src/server-tools/runtime-sandbox.ts`) over a new driver
(`src/reel/run-sandbox.ts`) on the EXISTING `sandbox-session.ts`, which is
unchanged: same spawner, same budget-and-die contract, second caller.

**The rule:** a call may express anything COMPLETE IN ITSELF; nothing whose value
depends on a later call.

- **In** — a medium (`media_path`, content-typed, so the cartridge case works),
  a schedule of steps in the capture-scenario notation (`parseStep`, shared with
  812/810 — waits, typing, held keys, held joystick, `insert`), a **run-until**
  (`I wait until the drive is idle / the CPU reaches $XXXX / the screen shows "…"
  / $XXXX is $YY / the screen is still for N frames within N frames`), the text
  screen, the registers, memory dumps with a bus lens, and one GIF frame.
- **Out** — a `session_id`, and with it every interactive verb: stepping,
  breakpoints, the monitor, rewind, a second read of the same machine. Not
  because the runtime cannot do them but because each is half a conversation, and
  the machine is gone when the answer is read. `I wait until the CPU reaches
  $0810` and `runtime_until` are the same runtime capability in two shapes; only
  the first is honest about being over when it returns.
- **Also out** — `I capture` (refused, pointing at the reel) and the two REGION
  predicates: a region is defined by a scenario or the project store, and a
  sandbox run has neither.

**§1's "needs no work in the runtime repo" holds for the cartridge and disk cases
and NOT for a bare `.prg`.** Measured on the real daemon: `media/open` on a PRG
sets `session.injected`, and `full_machine_gate` then advances a machine with no
cart and no disk on the isolated `cpu6510` core — no VIC, no CIAs, no SID, no
1541. The screen freezes, `advance_to_frame` fails, and a typed key is never
scanned. D3 does not fix that (it is a TRX64 gate, and the fix is the same
argument the gate's own `media_attached` comment already makes for disks); it
DETECTS it, by asking the runtime whether its VIC is sweeping, and says `NOT A
WHOLE MACHINE` above the report. **Open, for TRX64:** should poking a PRG into a
BOOTED machine re-classify it as an instruction exerciser at all?

Two smaller things the build had to learn, both now in the driver: a sandbox
daemon hands over a machine at its RESET vector, so the sandbox switches it on
and waits for the BASIC prompt before putting anything in (a PRG poked in earlier
is walked over by the cold start; a key typed earlier is typed into nothing); and
the daemon's autostart `RUN` sits in a buffer only its own running loop drains,
so a paused sandbox presses the key itself and says so.

## 4. Acceptance

Both gates green and in `gates.yml`; every existing gate green; the human's live
session cannot be disturbed by another session's `runtime_session_start`.
