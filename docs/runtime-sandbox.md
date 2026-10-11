# A machine of your own — how to test without touching the live session

**Problem this solves.** You want to try something on a C64 that would disturb the
human's live session (mount a different CRT, cold-boot, poke, run a scenario to the
end). The shared session is exactly one machine and it is never power-cycled for a
test, so isolation comes from a **second process** — never from a second in-process
session.

**The answer: `runtime_sandbox_run`.** It starts that second process for you. A
private daemon on its own port, born as a child of the call, born with a budget, and
ending itself when the budget runs out — whether or not anyone is still listening.
Nothing is mounted into the shared machine, nothing power-cycles it, nothing you do
reaches the human's UI, and nothing is left running behind you.

Give it the medium, a schedule of steps, and say what you want read back:

```jsonc
runtime_sandbox_run {
  "media_path": "artifacts/crt/spiel.crt",     // .crt/.d64/.g64/.d81/.prg/.c64re — by CONTENT, not extension
  "steps": [
    "I wait 170 frames",
    "I type \"LOAD{QUOTE}*{QUOTE},8,1{RETURN}\"",
    "I wait until the drive is idle within 8000 frames",
    "I wait until the CPU reaches $0810 within 4000 frames",
    "I hold joystick 2 fire for 3 frames"
  ],
  "read_memory": ["$0400:1000", "$d020:2@io", "$a000:16@ram"],
  "frame_path": "analysis/sandbox/after-load.gif",
  "model": "c64-ntsc",                          // omitted: the project's model, else PAL
  "budget_seconds": 120                         // max 600; the machine ends itself at it
}
```

Back comes the private port, which C64 it was, a line per step, every wait with the
cycle it fired on, the end cycle + PC + registers, the 40x25 text screen, and the
memory you asked for as a hex dump. The steps are the capture-scenario notation, one
per line; every step that lasts carries its own duration and the machine is stopped
between steps, so **the same list replays to the same bytes** — also from a fresh start. Every
sandbox is a new daemon, started headless: it stands at its reset vector at cycle 0 and moves
only when the run tells it to, so nothing depends on how long the caller took to speak. The
same arguments give the same warm-up (frames to READY), the same press and release cycles,
the same end cycle, registers and RAM, however many times and however busy the host is. (A
daemon left to run on its own until it was paused started every run at a different cycle:
one case pressed up to 15 frames apart.)

Drive 8 starts as a 1541. A medium that only fits a 1581 — a `.d81` — gets one: the
runtime names the board it needs, and the sandbox switches drive 8 to it before opening
the medium again (the same for `runtime_scene_reel`, and for a disk a step inserts).
`"drive_type": "1581"` fits it from the start, for an empty drive or a D81 that only a
later step inserts. A 1581 needs `dos1581-318045-02.bin` among the ROMs.

A `.prg` is loaded and started. One that loads at `$0801` behind a BASIC line gets
`RUN:` typed for it; machine code without one takes `"run": "$C000"` and starts at that
address. The log says what happened, not what was tried: a program that is still at
the `READY.` prompt afterwards is reported as not started, with the PC it sits at.

A `Then …` entry in `steps` is a **check**, decided where it stands and reported
PASS/FAIL with what the machine had:

```
Then $8EF2 is $01                  Then $40 is $26 $40 $26 $40 $26 $55
Then $B0 is not $00                Then $8EF2 is one of $01, $02
Then $8EF2@ram is $01              Then the CPU is at $0812
Then the screen shows "READY."
```

The same checks in a `.feature` file run with no agent at all:
`c64re scenario run scenarios/ [--json] [--jobs N]` gives one line per scenario — PASS,
FAIL (with the line, what it wanted and what was there), UNCHECKED (its `Then` lines are
prose so far), SKIP (starts from a mark, or asks for a capture), ERROR (the run failed) —
and exits 1 on a FAIL, an ERROR or a line that does not parse. Each scenario gets a fresh
machine, so a file gives the same bytes every time; media resolve beside the file, then
in the project.

## Where in the frame the input lands, and watching every frame

A scripted press used to reach the game at the same beam position on every run, because
every step lasted whole frames. A bug that depends on where the beam is when a key or fire
press arrives (a read-modify-write of `$D011` after arming a raster IRQ, a tick-versus-frame
race) therefore either always showed or never did. Four options move it, in
`runtime_sandbox_run`, `runtime_scene_reel` and `c64re scenario run` alike:

```jsonc
runtime_sandbox_run {
  "media_path": "port/test_d011.prg",
  "steps": [
    "I wait 20 frames",
    "I hold joystick 2 fire for 3 frames",
    "I wait 20 frames",
    "Then $C002 is $01"
  ],
  "sweep": 8                       // or "input_offset_cycles": 2457, or "jitter_seed": 7
}
```

- `input_offset_cycles: N` presses every input step (`I type`, `I hold …`, `I start holding …`,
  `I release …`) N cycles past the point it would have pressed at. A frame is 19656 cycles on
  PAL, 17095 on NTSC.
- `jitter_seed: S` gives each input step its own offset inside the frame, from the seed and the
  step's index: the same seed gives the same offsets.
- `sweep: K` (2 to 64) runs the same steps K times, each on a private machine of its own, with
  the offset spread evenly across one frame of the machine's model. It returns PASS/FAIL per
  offset and the first failing offset. It needs at least one `Then` to decide each run.
  `c64re scenario run … --sweep K` does the same for a `.feature` file (`--input-offset N` and
  `--jitter-seed S` are the single-run forms).
- Every offset a step used is in the result. To replay a failing run exactly, give the same
  `input_offset_cycles` (the sweep names the first failing one) or the same `jitter_seed`.

An offset is counted from the point the step would have pressed at, which is the same on every
run of the same steps but is not necessarily a frame boundary (measured: after a PRG start the
press can land mid-frame): read the press cycle from the result rather than assuming the beam
position. Without any of them nothing changes: the call carries no cycle, and a run replays to the same
bytes as before. A runtime that cannot place input at a cycle is refused by name; the press
is never quietly moved back to a frame boundary.

**A check that holds over a window.** `Then $D01C@io is $04 throughout the next 600 frames`
(also `… at every frame for 600 frames`) is decided by the runtime's frame probe, which samples
the address once per frame inside the daemon. It passes, or fails at the first frame and cycle
where the value was wrong, naming what it was. `is not` and `is one of` work too. The sample is
taken at one raster line per frame; `… at raster line 250` names it, and without it the line
after the visible area is used (288 on PAL), so the check sees the frame that was shown. The
window advances the machine, and the steps after it continue from where it ended. If a
breakpoint or watchpoint armed in the machine stops the probe, the result says so and the
check is neither passed nor failed.

**A sample series.** `read_series: ["$D01C:1@io", "$D029@io"]` (with `series_frames`,
`every_frames`, `series_line`) or, in a `.feature` file, the step
`I read the series "$D01C:1@io", "$D029@io" every frame for 600 frames` returns a table with
only the rows where a sampled value changed, each with its frame, cycle and raster line. A read
is `ADDRESS[:LENGTH][@lens]`; the length is decimal (`$` makes it hex), at most 256 bytes per
frame in all. `every 3 frames` samples every third frame.

All of this needs a runtime with cycle-exact input and the frame probe; `c64re runtime install`
fetches one.

<!-- deliberate-limitation: runtime_sandbox_run — it returns no session id BY DESIGN
     (Spec 836): a sandbox you could come back to would be a second shared machine,
     and there is exactly one of those. This limit is the tool's shape, not drift. -->

**What it cannot give you, deliberately: a machine that is still there afterwards.**
`runtime_sandbox_run` returns no session id. The machine is gone before you read the
answer, so nothing can attach to it, step it, breakpoint it, open the monitor on it,
trace it or read its memory a second time. Ask for everything you want in THAT call.

That leaves exactly one case for the raw recipe below: **an interactive loop on a
machine that is not the shared one** — stepping, breakpoints, the monitor REPL, a
trace you start and stop, memory you read, then poke, then read again, each decision
made after seeing the last answer. If your loop is interactive but the machine may be
the shared one, use `runtime_session_start` and the `runtime_*` tools instead; if your
work is a written scenario that should come back as a reel, use `runtime_scene_reel`,
which is the same private daemon with a `.feature` file in front of it.

---

## From an anchor to the build — several variants at once, the winner into the project

`runtime_sandbox_run` starts a whole medium on a machine of its own. The other job is
different: the shared machine is *already* at the interesting instant, and you want to try
several fixes from exactly there — each on a clone, none of them moving the machine the human
is watching — and then take the one that works into the project's source and build.

```
1  runtime_anchor_set      { name: "vor_level3", why: "just before level 3 loads" }
2  runtime_candidate_create{ anchor: "vor_level3", cycle_budget: 400000,
                             inputs: [{ atCycle: 40000, kind: "joystick2", payload: { fire: true } }] }
3  runtime_candidate_variant{ id: "cand-1", name: "lda01",  targets: [{ addr: 0xC10A, source_path: "fixes/lda01.asm" }] }
   runtime_candidate_variant{ id: "cand-1", name: "skip",   targets: [{ addr: 0xC10A, bytes: [0xEA, 0xEA] }] }
   runtime_candidate_variant{ id: "cand-1", name: "both",   targets: [{ addr: 0xC10A, source_path: "fixes/lda01.asm" },
                                                                     { addr: 0xC230, source_path: "fixes/guard.asm" }] }
4  runtime_candidate_run   { id: "cand-1" }
5  runtime_candidate_choose{ id: "cand-1", variant: "both" }
6  runtime_candidate_derive_delta{ id: "cand-1" }      // delta-cand-1/…  + the files registered as artifacts
   … wire the delta into the project's build …
7  runtime_candidate_verify_build{ id: "cand-1" }
```

**The anchor.** A name on a checkpoint of the shared machine (32 at most). Setting one captures a
fresh checkpoint and names it; it does not move, pause or change the machine, and neither do
`runtime_anchor_list` and `runtime_anchor_drop`. `runtime_anchor_goto` is the one that **moves the
shared machine** — it jumps to the anchor and pauses there, and the human at the UI sees it. In an
open project the anchor is also written into the graph (name, cycle, frame, why), so it is
remembered after the daemon is gone; going to one the ring no longer holds says so and names the
recorded cycle. While the machine stands in replay (after a goto) an anchor is not set: the runtime
would name the older checkpoint under the transport cursor and replace its name. `runtime_monitor
goto <last frame>` returns to the head. `runtime_mark` writes a label into a trace and names no instant of the
machine; it is not an anchor.

**The candidate.** One file per candidate under `knowledge/candidates/` — anchor, input list, cycle
budget, and per variant its targets with the **assembled bytes** and the source they came from, plus
the last verdict. A daemon restart loses nothing but the anchor in the ring; set it again at that
moment and the same candidate runs again to the same verdicts. A target is RAM (default) or a
cartridge window (`space: roml|romh`, `bank`, the window address); source is a file or inline text
assembled with the project's assembler and its own `* =` must equal the target address.

**The run.** One `runtime_candidate_run` is **one parallel batch**: run 0 without any patch, runs
1…N one per variant, all from the anchor with the same inputs and the same budget, each on a clone.
The shared machine is touched only to take a snapshot of the anchor. Each variant's end state is
then compared with the baseline's, whole machine, volatile lanes (cycles, raster, noise) masked. The
variant's own patched bytes are not counted as a difference — they differ by construction; the verdict
is about what the code *did*. The answer is a table: variant, cycles, final PC, `same as baseline` or
`DIFFERS — <component>: <what moved>`. Inputs are `[{ atCycle, kind, payload }]` with `atCycle`
counted from the anchor; one at or past the budget is not played and the answer says so. Which
change is right is your call (`runtime_candidate_choose`), the verdict only says what changed.

**Into the build.** `runtime_candidate_derive_delta` writes the chosen variant as one `.asm` per
target (each with its own org), `delta-manifest.json` and `DELTA.md` beside the project's source —
never into it — and registers the files as artifacts tagged `candidate:<id>`. Wiring them into the
build is the project's. `runtime_candidate_verify_build` then runs the project's own build command
(`profile.build`), reads the image it produced — a PRG with its load address, a cartridge image bank
by bank, or raw bytes from `raw_load_address` — and compares the bytes at every target: GREEN names
each target, RED names the first differing address (or says the target is not in the image).
`skip_build: true` checks an image that is already built.

Anchor names are accepted wherever a checkpoint id is: `runtime_checkpoint_pin`,
`runtime_checkpoint_restore`, `runtime_overlay_run`'s `anchor_id`, the candidate. `runtime_checkpoint_unpin`
takes the id only — an anchor holds its own pin; `runtime_anchor_drop` releases it.

For a single quick try that you *want* on the shared machine (and the human knows), `runtime_overlay_run`
restores an anchor into it, patches, runs and leaves it paused there.

---

## The raw recipe — an interactive private machine

Only for the case above. Everything else is one `runtime_sandbox_run` call.

### 1. Start a sandbox daemon on its own port

```bash
# the sibling TRX64 checkout — ../TRX64/target/release/trx64-daemon
/Users/alex/Development/C64/Tools/TRX64/target/release/trx64-daemon --port 4333 &
```

- **Never `--port 4312`** — that is the human's live session.
- Add **`--headless`** for a silent, deterministic machine: no A/V stream, no
  connect-time auto-run, advances only on explicit `session/run`. Use it for
  tool/logic tests where you want full control of the clock.
- **Without** `--headless` it behaves like the product: streams frames + audio and
  free-runs. Use it when you want to watch/screenshot a boot as the user would see it.
- Add **`--model c64-ntsc`** (or `--video ntsc`) for an NTSC C64 — chosen before the
  machine is switched on, so a release that detects the standard at boot sees NTSC.
  `session/models` lists every model and what an unrunnable one lacks. A frame is then
  17095 cycles, not 19656: read `cyclesPerFrame` from `session/state`, never assume it.

### 2. Drive it over raw WebSocket

```js
// node --input-type=module -e '...'
const ws = new WebSocket("ws://127.0.0.1:4333");
let id = 0; const p = new Map();
ws.addEventListener("message", (e) => {
  if (typeof e.data !== "string") return;          // ← binary A/V frames: skip, don't parse
  let m; try { m = JSON.parse(e.data) } catch { return }
  if (m.id != null && p.has(m.id)) { p.get(m.id).resolve(m); p.delete(m.id); }
});
const call = (method, params = {}) => new Promise((r) => {
  const i = ++id; p.set(i, { resolve: r });
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }));
});
await new Promise((r) => ws.addEventListener("open", r));

await call("session/create", {});                                 // { model: "c64-ntsc" } for an NTSC C64
await call("media/mount", { path: "/abs/pfad/zum/spiel.crt" });   // cart → power-cycle + boot
await call("debug/pause", {});                                    // ← BEFORE any joystick input
const frame = (await call("session/state", {})).result.cyclesPerFrame;  // 19656 PAL, 17095 NTSC
await call("session/joystick_set", { port: 2, left: true });
await call("session/run", { cycles: frame * 60 });                // 60 frames of this machine
await call("session/joystick_clear", { port: 2 });

const shot = (await call("session/screenshot", {})).result.dataUrl;   // base64 PNG data URL
const mem  = await call("monitor/exec", { command: "m 1000 1010" });  // VICE-superset monitor
ws.close();
```

Use a breakpoint (`monitor/exec "bk <addr>"`) to stop ON the instruction. Polling the
PC every N frames answers a different, worse question — where the PC happened to be
when you looked.

### 3. Clean up — always

End the machine you started: send `daemon/shutdown` on its own socket (it answers, closes
the connection and exits; a runtime from TRX64 0.12.10 on also writes back a mounted
cartridge or disk and finishes a recording trace), then wait for the process to go. Do not
look for it by command line and kill it: a sandbox started with `SandboxSession` is in the
process ledger, and `c64re status` lists it with its pid and port.

```js
await call("daemon/shutdown", {});   // → { ok: true, persisted: { cartridge, disks }, trace, exitCode: 0 }
```

`c64re down` (or `runtime_down`, which is the owner's to ask for) ends every sandbox in the
ledger together with the rest of C64RE. A sandbox is not blocked by the hold `down`
leaves — it has a budget and ends itself.

A forgotten sandbox daemon keeps running and pegs a core. That is the whole reason
`runtime_sandbox_run` carries a budget: it ends itself, so there is nothing to forget. The
budget is held next to the daemon, not in the process that asked for it: a keeper process
between the two ends the daemon when the budget runs out or when that process is gone —
killed, crashed or closed — and removes its scratch directory.

---

## Useful methods (raw WS)

| method | what |
|---|---|
| `session/create` | build/attach the machine in THIS process |
| `session/state` | `c64Cycles`, `runState`, `cpu.pc`, `controlOwner`, `streamPump` |
| `media/mount` `{path}` | mount `.crt`/`.d64`/`.g64` (a cart power-cycles + boots) |
| `session/run` `{cycles}` | bounded advance (needs `running == false`) |
| `debug/run` `{cycles?, pace?}` | free-run; with `cycles` a bounded run that still streams, auto-pausing at the cap |
| `debug/pause` | freeze |
| `session/joystick_set` `{port, up/down/left/right/fire, at_cycle?}` / `session/joystick_clear` `{at_cycle?}` | input; `at_cycle` (absolute `c64Cycles`, not in the past) takes effect at that cycle, also inside one `session/run` |
| `session/key_down` / `session/key_up` `{key, at_cycle?}` | the same for one key |
| `session/frame_probe` `{frames, line, cycle?, addresses:[{addr,len?,lens?}], mode, expect?}` | advances `frames` frames, samples once per frame at a raster line; `series` returns only the changing rows, `assert` stops at the first failing frame |
| `session/type` `{text}` | PETSCII keyboard |
| `session/screenshot` | one PNG (`dataUrl`) |
| `monitor/exec` `{command}` | monitor: `m`/`d`/`wr`/`bk`/`trace`/`undump`… |
| `trace/start_domains` `{output, domains}` | start a trace; `monitor/exec "trace off"` finalizes + reports `eventCount` |

Monitor gotchas: memory **write** is `wr <addr> <bytes>` (not `>`), and `m` output is
row-aligned — parse the `>C:ADDR` prefix rather than assuming your start address. Do
not regex the monitor's text dump back into bytes when all you wanted was memory:
`runtime_sandbox_run`'s `read_memory` hands you the bytes, with a lens.

---

## Gotchas that cost time

- **Binary frames.** Without `--headless` the daemon pushes BIN_VIC (`0x01`) / BIN_AUDIO
  (`0x02`) as binary WS messages. A JSON parser without the `typeof e.data !== "string"`
  guard throws on them.
- **Joystick needs a pause first.** `debug/pause` BEFORE `session/joystick_set`; on a
  free-running machine the input window races the advance and is lost.
- **`session/run` refuses while running.** It errors with "session is running under the
  autonomous loop" — `debug/pause` first, or drive with `debug/run {cycles}` instead.
- **Monitor writes bypass the cart mapper.** `wr` into `$8000-$9FFF` hits RAM, not the
  cart bank — do not use it to probe banking.
- **One machine per process.** Two sandboxes = two daemons on two ports.

---

## Alternatives

**One-shot, no daemon** — boot, render, dump, exit (no joystick):

```bash
trx64cli boot --disk spiel.crt --warmup 5000000 --cycles 2000000 \
  --render out.png --dump out.c64re
```

**Point the MCP tools at another daemon** — `C64RE_RUNTIME_ENDPOINT=ws://127.0.0.1:4333`.
Possible, but it is an MCP-**server** env: it redirects *all* `runtime_*` tools and needs
an `/mcp` reconnect, so you lose the live session for the rest of the session. Fine for a
dedicated sandbox-only session; wrong while co-driving, and unnecessary now that
`runtime_sandbox_run` brings its own machine per call.

---

## When to use which

| situation | do this |
|---|---|
| Read the human's live machine (memory, registers, render, scrub) | MCP `runtime_*` on `:4312` — reads don't disturb it |
| Human invited you to drive their session | MCP `runtime_*` on `:4312` (doctrine §1.2) |
| Try a different CRT / cold-boot / risky poke / run to the end | **`runtime_sandbox_run`** — one call, its own machine, ends itself |
| Deterministic tool/logic test, no watching | **`runtime_sandbox_run`** with explicit `I wait N frames` steps |
| A written scenario that should come back as a reel | `runtime_scene_reel` (same private daemon, `.feature` in front) |
| Try several fixes from one instant at once, then put the winner into the build | **`runtime_anchor_set`** → `runtime_candidate_*` (this doc, "From an anchor to the build") |
| Run a 6502 routine with no VIC/CIA/drive around it | `sandbox_6502_run`, or `sandbox_depack` for a game's own depacker |
| Step / breakpoint / monitor / trace, interactively, NOT on the shared machine | raw WS daemon on your own port (this doc) |
| Just boot something and look at one frame | `runtime_sandbox_run` with `frame_path`, or `trx64cli boot … --render` |

Never power-cycle the shared session to "make room" for a test — the human's state
(game progress, mounted media, checkpoint ring) is lost. Take a machine of your own.

Cross-links: CLAUDE.md "One Machine Per Process (Session Isolation)",
`docs/agent-doctrine.md` §1.2 (live-session control),
`docs/tools/sandbox.md` (the sandbox tools in full),
`docs/headless-runtime-singleton-audit.md` (why the core is single-machine — its
subject is deleted, its argument is not).
