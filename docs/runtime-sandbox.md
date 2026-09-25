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
between steps, so **the same list replays to the same bytes**.

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

```bash
pkill -f "trx64-daemon --port 4333"
```

A forgotten sandbox daemon keeps running and pegs a core. That is the whole reason
`runtime_sandbox_run` carries a budget: it ends itself, so there is nothing to forget.

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
| `session/joystick_set` `{port, up/down/left/right/fire}` / `session/joystick_clear` | input |
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
