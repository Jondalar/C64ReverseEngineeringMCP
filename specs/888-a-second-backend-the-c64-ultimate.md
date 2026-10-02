# Spec 888 — A second backend: the C64 Ultimate

**Status:** PROPOSED (2026-10-02) — open questions to the 1541U side in §6
**Repos:** C64RE. Inputs come from the 1541ultimate repo (`trxmon.u2a`, the TRX64 core
bitstream). TRX64 itself is unchanged.

## §1 What is asked

The owner, 2026-10-02: C64RE gets a **switch** of its own. Behind one interface, the
runtime is either

- **the TRX64 daemon**, the emulator, exactly as today; or
- **a C64 Ultimate / UE2** running the TRX64 core and the `trxmon.u2a` app. It is reached
  through two APIs: Gideon's U64 REST API (media, machine, input, memory) and the app's
  RPC (pause, step, watch units, the state bus, the delta ring, trace streams).

It is chosen in the UI. A C64U on the network is **found by itself** and offered only
when a **probe** confirms that it runs our core and the app.

This **replaces DOCTRINE rule 1's "one runtime"** with: one contract towards C64RE's tools,
several backends behind it, each **chosen explicitly**, and never a silent fallback from
one to the other. DOCTRINE.md is amended in the same change.

## §2 The switch

- **One interface.** `RuntimeBackend` has the shape the tools already call
  (`call(method, params)`, notifications, the identity from `ping`). `RuntimeDaemonClient`
  (`src/runtime/daemon-client.ts:200`) becomes the emulator implementation of it. A
  `C64UBackend` is the second. Tool code does not change: it keeps calling the method
  names it calls today.
- **The C64U backend translates.** Each TRX64 method it supports is mapped onto REST or the
  app's RPC. A method it cannot serve is refused **by name, with the reason and the way
  out**, e.g. "runtime/overlay_run: no overlay on C64 Ultimate hardware — use a machine of
  your own (runtime_sandbox_run), which is always the emulator". Sandboxes, reels and
  scenario runs stay on private emulator daemons whichever backend is active. They are
  point work on a machine of your own, and that machine is always TRX64.
- **Identity.** `ping` from the C64U backend reports what it is (product, core, app
  version) and a capability list. `runtime_session_status` names the backend.
- **The UI goes through the server.** Today the browser connects straight to the daemon's
  WS (`ui/src/workbench/ws-client.ts`). A C64U backend speaks no TRX64 WS, so with the
  C64U selected, the workbench server relays the same JSON-RPC and notifications for it.
  With the emulator selected, the direct path stays as it is.

## §3 Discovery and the probe

- **Find.** A UDP broadcast of `json<nonce>` to port 64, the Ultimate Ident Service
  (`1541ultimate/software/network/socket_dma.cc:524`). Every Ultimate on the segment
  answers with `product`, `firmware_version`, `fpga_version`, `core_version` and
  `hostname`. Also available as `GET /v1/info`, with `git_commit_hash`.
- **Probe**, per answering device. Is it a C64U or UE2 (`product`)? Is it running the TRX64
  core (the marker: §6 Q1)? Does `trxmon.u2a` answer on its port with a handshake that
  names its protocol version (§6 Q2)? Only a device that passes all three is offered.
  The others are listed greyed out with the reason ("Ultimate 64 Elite — stock core"), so
  nobody wonders where theirs went.
- A device with a REST password (`password_protected`) asks for it once in the UI. The
  password is kept for the session only, never written to the project.

## §4 Choosing

- **UI.** A backend selector in the top bar. It shows "TRX64 (emulator)" plus the probed
  devices, with a rescan action. Switching asks first, as the project switch does (858):
  the machine changes, so what is on screen is another machine's.
- **MCP / headless.** `C64RE_RUNTIME_BACKEND=trx64|c64u:<host>`, and `runtime_backend`
  (list, probe, select) as a tool, so an agent can see and choose without a UI.
- **No silent fallback.** A selected C64U that stops answering is an error naming the
  device, never a quiet switch to the emulator.
- **The emulator is the default**, always. A C64U found on the network is offered, never
  chosen by itself: it becomes active only by the owner's selection or
  `C64RE_RUNTIME_BACKEND`. (Owner, 2026-10-02.)
- **Sandboxes, reels and scenario runs stay on the emulator** whichever backend is active.
  They are machines of your own for point work, ending with their call; real hardware is
  one machine. (Owner, 2026-10-02.)

## §4b The gate: hardware only after the emulator said yes

A medium reaches the C64U only once it has passed in the emulator. (Owner, 2026-10-02:
"the U64/C64U is allowed only after the runtime check in the emulator, by a gate.")

- **What passes.** A run on the emulator whose `Then` checks all passed: a scenario
  (`c64re scenario run`), or `runtime_sandbox_run` with `Then` entries. There must be at
  least one check; prose-only runs and runs with no checks pass nothing.
- **Per medium, by content.** The pass is recorded against the SHA-256 of the medium's
  bytes, with the scenario or step list, the checks, the time and the TRX64 version. The
  record goes in the project's knowledge, so it outlives the session.
- **The gate.** With the C64U active, `media/open`, `media/mount`, `session/load_prg` and
  `runtime/run_prg` are refused for bytes without a recorded pass. The refusal names the
  file and what is missing, e.g. "game_v3.crt (sha256 3f1a…) has no green emulator run in
  this project — `c64re scenario run scenarios/game.feature` first".
- **A changed build is a new medium.** Another hash needs its own pass.
- The emulator backend has no gate.

## §5 First slice

Discovery and the probe; the switch with the C64U backend serving `ping`, `session/state`,
`session/read_memory`, `debug/pause`, `debug/continue`, `media/mount`, `media/unmount`,
`session/load_prg` / `runtime/run_prg`, `session/type`, the joystick, and
`session/screenshot`. Everything else is refused by name. Then step/watch, the ring
(`checkpoint/*`) and trace, as the app delivers them.

## §6 Answers from the 1541U side (2026-10-02)

1. **Core identity.** No existing field is reliable: `fpga_version` and `core_version` can
   collide with a stock build. The app branch (trx64/main) will ADD to the ident JSON
   (`socket_dma.cc` ~605) and to `GET /v1/info`:
   `"trx64": {"core":"TRX2", "caps":"0x…", "build":"<sha8>", "rpc":4312, "board":…}`.
   - `core` is the ID register of the TRX64 IO block at 0x101A0000, which reads "TRX2"
     today.
   - `rpc` is present only while `trxmon.u2a` runs.
   - **Probe rule:** `trx64` present and `core == "TRX2"` means our core. `rpc` present
     means the app is up. `trx64` absent means a stock device. Until that patch lands,
     every device reads as stock.
2. **App transport.** WebSocket on TCP 4312, JSON-RPC 2.0 text frames, TRX64's wire format
   and method names 1:1. Connect with `?av=0`: the app pushes no A/V.
   - **Handshake:** `ping` → `{runtime_version:"trx64-runtime/2", version:"trxmon <ver>",
     backend:"c64u"}`.
   - **First delivery:**
     - `ping`, `session/state`, `session/read_memory` (lenses ram|io|cpu|rom|cart);
     - `debug/pause|continue|run|step`, `session/run {cycles}`;
     - `monitor/exec` (TRX64 verbs), `debug/break_add|break_del|break_list`;
     - `checkpoint/*` (DDR2 ring, .c64re/.c64rering);
     - `trace/start_domains`, `trace/run/status|mark|stop`, `trace/read` (.c64retrace).
   - **Notifications:** `debug/breakpoint_hit`, `debug/paused|running`,
     `debug/observer_hit|observer_log`.
   - **Not on hardware:** -32601 with a reason sentence.
   - **Not in the app:** media, machine and input; those go over REST. The app spec is
     T21-monitor.md §7.4 in TRX64-Ultimate, and the app is not built yet.
3. **UE2.** The product string ("Ultimate 64-II", `system/product.cc:18`) does not
   separate a C64U from a UE2; the board revision does. A UE2 always runs a stock core.
   `board` goes into the `trx64` field.
4. **Video.** The existing U64 UDP VIC stream, started over REST and sent unicast. It
   works on our core; the decoders are in `tools/stream_shot.py` and
   `tests/e2e/lib/streams.py` (1541ultimate).

So the C64U backend is two connections: REST (media, machine, input, memory, the video
stream) and the app's WS (the TRX64 methods it implements). The switch routes per method.

**Consequence for "offered only with our core and the app":** until the `trx64` ident
field ships, no device passes the probe. The REST-only first slice (§5) can be built and
tested only against an explicitly named host (`c64u:<host>`), not through discovery.
