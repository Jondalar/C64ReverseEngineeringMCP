# Isolated runtime sandbox — how to test without touching the live session

**Problem this solves.** You want to try something on a C64 that would disturb the
human's live session (mount a different CRT, cold-boot, poke, run a scenario to the
end). The MCP `runtime_*` tools cannot give you that: they are all pinned to the ONE
product daemon (`ws://127.0.0.1:4312`), and `runtime_session_start` deliberately
**attaches** to the existing machine instead of building a second one (Spec 744
shared-attach; see CLAUDE.md "One Machine Per Process"). So calling it again just puts
you back on `integrated-1`.

**The rule:** one daemon process = exactly ONE live machine. Isolation therefore comes
from a **second process**, never from a second in-process session.

**The answer:** start your own daemon on your own port and drive it over raw
WebSocket. Do NOT use the MCP `runtime_*` tools for this — they are for the shared
session. The human's session on `:4312` stays completely untouched.

---

## Recipe

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

await call("session/create", {});
await call("media/mount", { path: "/abs/pfad/zum/spiel.crt" });   // cart → power-cycle + boot
await call("debug/pause", {});                                    // ← BEFORE any joystick input
await call("session/joystick_set", { port: 2, left: true });
await call("session/run", { cycles: 19705 * 60 });                // ~60 PAL frames
await call("session/joystick_clear", { port: 2 });

const shot = (await call("session/screenshot", {})).result.dataUrl;   // base64 PNG data URL
const mem  = await call("monitor/exec", { command: "m 1000 1010" });  // VICE-superset monitor
ws.close();
```

### 3. Clean up — always

```bash
pkill -f "trx64-daemon --port 4333"
```

A forgotten sandbox daemon keeps running and pegs a core.

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
| `monitor/exec` `{command}` | monitor: `m`/`d`/`wr`/`trace`/`undump`… |
| `trace/start_domains` `{output, domains}` | start a trace; `monitor/exec "trace off"` finalizes + reports `eventCount` |

Monitor gotchas: memory **write** is `wr <addr> <bytes>` (not `>`), and `m` output is
row-aligned — parse the `>C:ADDR` prefix rather than assuming your start address.

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
an `/mcp` reconnect, so you lose access to the live session for the rest of the session.
Fine for a dedicated sandbox-only session; wrong while co-driving. Prefer raw WS.

---

## When to use which

| situation | do this |
|---|---|
| Read the human's live machine (memory, registers, render, scrub) | MCP `runtime_*` on `:4312` — reads don't disturb it |
| Human invited you to drive their session | MCP `runtime_*` on `:4312` (doctrine §1.2) |
| Try a different CRT / cold-boot / risky poke / run to the end | **sandbox daemon on your own port** (this doc) |
| Deterministic tool/logic test, no watching | sandbox daemon **`--headless`** |
| Just boot something and look at one frame | `trx64cli boot … --render` |

Never power-cycle the shared session to "make room" for a test — the human's state
(game progress, mounted media, checkpoint ring) is lost. Spin up your own process.

Cross-links: CLAUDE.md "One Machine Per Process (Session Isolation)",
`docs/agent-doctrine.md` §1.2 (live-session control),
`docs/headless-runtime-singleton-audit.md` (why the core is single-machine),
`scripts/probe-session-isolation.mjs` (the gate that enforces it).
