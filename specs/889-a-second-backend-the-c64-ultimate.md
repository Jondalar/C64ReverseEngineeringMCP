# Spec 889 — A second backend: the C64 Ultimate

**Status:** PROPOSED (2026-10-02; revised 2026-10-06 after the TRX64-FW review) — spec
only; the owner builds later. First integration at RC level = what exists on the board today.
**Repos:** C64RE. Inputs: the C64U build of the TRX64 Ultimate firmware (superproject
`integ-m1`) and `trxmon.u2a` (app branch `integ-m1-app`, reviewed at `5b605bb0`). The first
slice is what exists there today (§5). TRX64 itself is unchanged.

## §1 What is asked

The owner, 2026-10-02: C64RE gets a **switch** of its own. Behind one interface, the
runtime is either

- **the TRX64 daemon**, the emulator, exactly as today; or
- **a C64 Ultimate / UE2** running the TRX64 core and the `trxmon.u2a` app. It is reached
  through two APIs: Gideon's U64 REST API (media, machine, input, memory, video stream)
  and the app's RPC (pause, step, breakpoints, the monitor, the checkpoint ring, marks,
  transport, reverse step). Trace over RPC is not in the app (§6 Q2).

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
- **Identity.** `runtime_session_status` names the backend and the device. The C64U
  backend builds its identity from the ident `trx64` object (`core`, `board`, `caps`) and
  the app's `ping` (`runtime_version`, `backend:"c64u"`, `version` — the constant
  "trxmon 0.1", not a build id). The app sends no capability list and no build id today:
  what a method is, C64RE learns from a -32601 with its reason sentence, and the backend
  keeps the §5 list as its own table of what it routes. (Asked of the app as a TODO: a
  `capabilities` array and the firmware build in `ping`; the backend uses them when they
  appear and does not wait for them.)
- **trxmon gone = device gone.** When the app's port closes (quit, menu restart, `x` with
  nothing armed), every RPC-routed call fails like an unreachable device, with the message
  "trxmon not running on <host> — start it (§3) or select the emulator". Never a fallback.
- **The UI goes through the server.** Today the browser connects straight to the daemon's
  WS (`ui/src/workbench/ws-client.ts`). A C64U backend speaks no TRX64 WS, so with the
  C64U selected, the workbench server relays the same JSON-RPC and notifications for it.
  With the emulator selected, the direct path stays as it is.

## §3 Discovery and the probe

- **Find.** A UDP broadcast of `json<nonce>` to port 64, the Ultimate Ident Service
  (`1541ultimate/software/network/socket_dma.cc:524`). Every Ultimate on the segment
  answers with `product`, `firmware_version`, `fpga_version`, `core_version` and
  `hostname`, and when set also `menu_header`, `your_string`, `password_protected` and
  `unique_id`. Our firmware adds `trx64: {core:"TRX2", caps:"0x…", board:"C64U"|"U64-II",
  rpc:<port>}` (`socket_dma.cc` ~634; only on a U64-class board with the TRX64 IO block
  present). Also available as `GET /v1/info` (`routes.cc` ~255), with `git_commit_hash`.
  `board` is a label, not a probe result; there is no `build` field.
- **Probe**, per answering device, three outcomes:
  - **no `trx64`** → stock device. Listed greyed out ("C64 Ultimate — stock core").
  - **`trx64` with `core == "TRX2"` but no `rpc`** → our core, trxmon not running. Listed
    with a **Start monitor** action (§3a), not selectable until it answers.
  - **`rpc` present** → open `ws://<addr>:<rpc>/` and send `ping`. `runtime_version:
    "trx64-runtime/2"` and `backend:"c64u"` → offered. Anything else → greyed out with
    what was answered.
  Nobody wonders where theirs went: every answering device is listed, with its reason.
- A device with a REST password (`password_protected`) asks for it once in the UI. The
  password is kept for the session only, never written to the project.

### The probe, as the owner put it (2026-10-02)

The deciding test is **asking the app itself**: `ping` on its WS. The `trx64` ident field
has landed (2026-10-06) and now separates "our core, app not started" from "stock core";
the ping still decides "offered". An epoch other than C64RE's is refused by name, as with
the daemon; there is no epoch negotiation on the app side, compatibility is C64RE's logic.

Transport facts (TRX64-FW review, 2026-10-06): port 4312 fixed; `?av=0` and the path are
ignored (the app never sends A/V, so connecting with it is harmless); at most **4 clients**
(a fifth TCP connection is closed at once) — C64RE uses **one** connection per server;
messages capped at 16 KB (close 1009); plain HTTP on the port gets 426; **no auth on the
RPC port** even when REST has a password. Notifications go to every client.

Seen on 2026-10-02 (read only), at 192.168.242.189: `/v1/info` gives product "C64
Ultimate", firmware 3.15, fpga 125, core 1.01; UDP 64 answers the same, no `trx64` field —
a stock device on that date. A ping on :4312 was not tried.

### §3a Starting the app

There is no autostart; the RPC exists only while trxmon runs. C64RE can start it over REST:
- `PUT /v1/apps:run_file?app=<full path of trxmon.u2a>&action=serve` — works on every
  build;
- `PUT /v1/apps/trxmon:run` — only with app `5b605bb0` or later **installed** (an older
  install keeps its manifest without `rest` and answers 403 until reinstalled).
A headless start detaches and serves on 4312. A second start while trxmon is resident gets
423 (treat as "already running", then probe). trxmon starts with the machine **PAUSED**:
the backend sends `debug/continue` after select unless the caller asked for paused.
trxmon ends on `trxmon/quit`, `/quit`, a menu restart, or `x` at the machine with nothing
armed (breakpoint, observer, run cap, drive bp) — then §2 "trxmon gone" applies.

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

## §5 First slice (RC: what exists on the board today)

Discovery, the probe, §3a start, the switch. The C64U backend routes:

- **App RPC (board-tested 2026-10-04/06):** `ping`; `session/create|list|close|state|run|
  read_memory` (lenses cpu|ram|rom|io|cart, ≤ 32768 bytes, `{addr,length,lens}` or
  `ranges:[…]`, `bytes` = array of numbers); `debug/state|pause|continue|run|step|
  break_add|break_del|break_list`; `monitor/exec|state` (`command` ≤ 512 chars; a command
  that runs the machine answers when it stops); `trxmon/quit`;
  `checkpoint/list|capture|restore|pin|unpin` (`capture` returns the anchor the machine is
  in, it does not make a new one); `mark/*`; `transport/*`;
  `runtime/reverse_step|who_wrote|crash_triage|set_reverse_depth`. Notifications:
  `debug/running|paused|stopped|breakpoint_hit|observer_hit`.
- **REST:** media and drives (`drives/{drive}:mount|remove|reset|on|off|set_mode`), PRG
  (`runners:load_prg|run_prg`, upload variants), CRT (`runners:run_crt` — it STARTS the
  cart; there is no mount-only), input (typing, joystick), machine
  (`reset|pause|resume|poweroff|menu_button|readmem|writemem`), streams.
- **Screenshot:** the app refuses `session/screenshot` and REST has none. The backend takes
  one frame from the VIC UDP stream (started over REST, unicast to this host; decoder
  reference `tools/stream_shot.py` in 1541ultimate) and answers in the daemon's shape.
- **Wrapped carefully:** `debug/break_add` without `pc` adds a breakpoint at $0000 — the
  backend refuses a missing `pc` itself. `debug/break_del` without `id` deletes ALL — the
  backend never sends it without one unless the caller asked for "all" explicitly.
- **Everything else is refused by name** with the reason and the way out: `trace/*` and
  `debug/memory_access_map` (trace only via `monitor/exec "trace on|off|status"`, `sd`,
  `chis`, `whowrote` — offered as that), `snapshot/*`, `ringbuffer/*`,
  `trace/build_from_ring` (removed in the app's M1; no .c64re/.c64rering/.c64retrace
  files), the sandbox group ("use a local TRX64 sandbox"), `debug/observer_log` (never
  sent), `runtime/overlay_run` and other emulator-only methods.
- Later, as the app delivers: trace RPC and snapshot/ring files (app T66, M2 — after a
  triage with TRX64 and C64RE), `capabilities` in `ping`. UE2 runs a stock core for now, so
  the first slice is C64U only.

## §6 Answers from the 1541U side (2026-10-02)

1. **Core identity.** No existing field is reliable: `fpga_version` and `core_version` can
   collide with a stock build. The app branch (trx64/main) will ADD to the ident JSON
   (`socket_dma.cc` ~605) and to `GET /v1/info`:
   `"trx64": {"core":"TRX2", "caps":"0x…", "build":"<sha8>", "rpc":4312, "board":…}`.
   - `core` is the ID register of the TRX64 IO block at 0x101A0000, which reads "TRX2"
     today.
   - `rpc` is present only while `trxmon.u2a` runs.
   - **Probe rule:** `trx64` present and `core == "TRX2"` means our core. `rpc` present
     means the app is up. `trx64` absent means a stock device. *(Landed; as shipped there is
     no `build` field and `board` is a label — corrected 2026-10-06, see §3.)*
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
     - *Corrected 2026-10-06 (TRX64-FW review): `trace/*` is NOT in the app (-32601);
       snapshot/ringbuffer and the .c64re*/.c64retrace files were removed in M1 (T66); the
       real first delivery is §5. `version` is the constant "trxmon 0.1"; `?av` is ignored;
       no auth; 4 clients; `debug/observer_log` is never sent.*
   - **Notifications:** `debug/breakpoint_hit`, `debug/paused|running`,
     `debug/observer_hit|observer_log`.
   - **Not on hardware:** -32601 with a reason sentence.
   - **Not in the app:** media, machine and input; those go over REST (the app refuses
     them by name, "Ultimate's REST API"). The app spec is T21-monitor.md §7.4 in
     TRX64-Ultimate; the app exists and is board-tested (2026-10-06).
3. **UE2.** The product string ("Ultimate 64-II", `system/product.cc:18`) does not
   separate a C64U from a UE2; the board revision does. A UE2 always runs a stock core.
   `board` goes into the `trx64` field.
4. **Video.** The existing U64 UDP VIC stream, started over REST and sent unicast. It
   works on our core; the decoders are in `tools/stream_shot.py` and
   `tests/e2e/lib/streams.py` (1541ultimate).

So the C64U backend is two connections: REST (media, machine, input, memory, the video
stream) and the app's WS (the TRX64 methods it implements). The switch routes per method.

**Consequence:** the deciding probe is the app's own `ping` on :4312 (§3, "The probe"),
so discovery does not wait for the `trx64` ident field.

## §7 Hardware behaviours the backend must handle

From the TRX64-FW review (2026-10-06):
- **Paused on start.** See §3a.
- **A person at the machine wins.** RUN/STOP, `x` in the monitor, the menu: the backend
  reports what happened, it never fights it. A `debug/running` may arrive unannounced after
  a firmware-side stop; the backend takes the notification as truth.
- **REST actions invalidate the RPC view.** A REST reset, mount, `run_prg` or `run_crt`
  while trxmon holds the machine pushes no state change. After any REST action the backend
  re-reads `debug/state` before it answers, and says that ring anchors and marks taken
  before it may be stale (the ring does not restore SID, drive A, flash or VIC internals).
- **Error forms.** -32700, -32600, -32602, -32601 (with a reason sentence — passed through
  verbatim), -32001 busy / not available, -32603. Pending runs carry deadlines; a deadline
  is reported as such, not as a hang.
- **No streaming in the app.** Video and audio only via REST `streams` (UDP).
- **Security.** The RPC port is open on the LAN even when REST has a password. The UI says
  so on the device row; C64RE never exposes it further (no relay to other hosts).
- **Concurrency.** Up to 4 clients share one machine; C64RE holds exactly one connection
  and treats notifications it did not cause as another client's or the person's action.
