# Spec 889 — A second backend: the C64 Ultimate

**Status:** IN REBUILD (2026-10-08) — §11: the facade becomes its own daemon process; built in-process first (§8–§10), which broke co-drive.
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
  keeps the §5 list as its own table of what it routes. **Coming in the app** (owner,
  2026-10-06; being built on app branch `t21-rpc1-app`): `ping` carries a `capabilities`
  array (served methods and sent notifications) and real build ids (firmware and trxmon
  git sha) instead of the constant. With it the backend checks its routing table against
  `capabilities` at select and names any method it routes that the device does not serve;
  without it (an older app) it falls back to -32601 as above.
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
ignored (the app never sends A/V, so connecting with it is harmless); today at most **4
clients**, and **coming: exactly one** (owner, 2026-10-06) — a second connection is refused
with a reason naming the held port and the peer holding it. C64RE holds that one connection
for as long as the C64U is selected and reports the refusal verbatim ("held by <peer>");
the probe's `ping` therefore uses the same connection the backend keeps, never a second one;
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

## §4c Picture and sound in the UI

With the C64U selected, the workbench server receives the device's UDP streams and relays
them to the browser as the binary frames the UI already plays: `0x01` VIC frame, `0x02`
audio buffer (`ui/src/workbench/ws-client.ts`). The browser never talks to the device.

- **Start.** `PUT /v1/streams/video:start?ip=<this host>:<port>` and the same for `audio`,
  unicast to the server's address on the device's segment. One destination per stream: a
  second start REPLACES the target, so the backend owns the streams while selected and says
  so if they were pointed elsewhere. Unicast start ARPs for up to 25 × 100 ms and can block
  for seconds ("Cannot find MAC") — run it off the request path and report a timeout as
  such. The stream enable survives REST reset / `run_crt` / mount; only a system reset
  clears it, so the backend re-arms after one. `streams/debug` is not used: it answers OK
  on our core and sends nothing.
- **Video wire format** (identical to stock U64): 780-byte datagrams, 12-byte header
  `<HHHHBBH` — seq, frame, line (bit 15 = last packet of the frame), width 384, lines per
  packet 4, bpp 4, encoding 0 — then 768 bytes = 4 lines × 384 four-bit VIC colour indices,
  left pixel in the LOW nibble. PAL 272 lines (68 packets), 60 Hz modes 240 lines; a PAL/
  NTSC switch blanks ~14 ms and changes the height. Raw indices: the palette is the
  decoder's job — the backend uses the palette the emulator path uses, so both backends
  look alike. Packets are lost under load (the device drops a packet that finds the sender
  busy, and the RPC/REST MAC traffic has priority): assemble per frame, show a frame only
  when complete or when the next frame starts (then with the gaps), never stall.
- **Audio wire format:** 770-byte datagrams, seq u16le + 192 stereo s16le frames (L, R).
  **Rate 48,003.07 Hz on our core in every video mode** (not stock's 47,982.887 /
  47,940.34); one mixed stereo pair. The UI's player runs at 44,100 Hz today: the
  stream rate becomes a property of the backend and the player resamples from it, so the
  emulator path does not change. Reorder and duplicate by seq; conceal gaps with a SHORT
  fill cap for live playback.
- **Reference to port:** `1541ultimate/tests/e2e/lib/streams.py` — the header, nibble
  unpack, `FrameAssembler` (reassembly, loss, re-anchor, 272/240) and `AudioTimeline`
  (reorder, duplicates, concealment; its FILL_CAP 2500 is for writing files — live uses a
  short one; replace `rate_for()` with 48,003.07 Hz). `TRX64-Ultimate/tools/stream_shot.py`
  is a thin CLI over it (one frame → PNG). Port the logic, test it against recorded
  datagrams, not against a live device.
- **Paused, breakpoint, freeze, Timewarp scrub:** video STOPS mid-frame (it is driven by the
  VIC's counters, which stop with the C64 clock) and resumes with an incomplete frame / a
  re-anchor; "no video packets" means paused, not broken — the UI keeps the last frame and
  marks it paused. An app CPU-only stop keeps video running. Audio keeps sending at full
  rate with zero samples.
- **Bandwidth:** video ≈ 22 Mbit/s, audio ≈ 2 Mbit/s on the device's 100 Mbit link, shared
  with REST and RPC. Heavy RPC (large `read_memory` loops) costs video frames; the backend
  does not poll in tight loops while streams run.

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
  one frame from the VIC UDP stream (§4c) and answers in the daemon's shape. While the
  machine is paused no video arrives (§4c), so a screenshot of a paused machine is the last
  complete frame received, and the answer says so with its age.
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
   `tests/e2e/lib/streams.py` (1541ultimate). *Corrected 2026-10-06: `stream_shot.py` is in
   TRX64-Ultimate; audio runs at 48,003.07 Hz on our core; full detail in §4c.*

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
- **Concurrency.** Today up to 4 clients share one machine, coming: exactly one (§3).
  C64RE holds that one connection and treats a state change it did not cause as the
  person's action at the machine.

## §8 As built (foundation)

Branch `spec-889-core`. Everything in §2, §3, §3a, §4 (MCP / headless half), §4b, §5 and §7
is built and tested; §4c and the UI half followed (§9, §10).

**Where it lives**

- `src/runtime/runtime-methods.ts` — the contract: `RuntimeMethods` (`call`, `onNotification`,
  `describe`, `setProjectDir`, `kind`) with the typed wrappers every tool uses
  (`state`, `createSession`, `mediaIngress`, …), all written over `call`.
  `RuntimeDaemonClient` (`daemon-client.ts`) is the emulator implementation, behaviour unchanged
  (it only gained `describe` and a notification fan-out); its singleton is `emulatorDaemon`.
- `src/runtime/backend.ts` — the registry and the tools' door. `runtimeDaemon` is a facade over
  the active backend; every `src/server-tools/*` import of it points here. `selectBackend`,
  `probeHost`, `listDevices`, `startMonitorOn`, `runtimeHealth`, `C64RE_RUNTIME_BACKEND`.
- `src/runtime/c64u/` — `c64u-backend.ts` (REST + the one app connection, routing, §7),
  `routing.ts` (the table), `rest.ts`, `rpc-link.ts`, `rest-map.ts` (typing, joystick, media
  sniffing), `discovery.ts` (UDP ident, three outcomes), `frame-source.ts` (the §4c hook).
- `src/runtime/emulator-pass.ts` — the gate's store and check; `knowledge/emulator-passes.json`.
- `src/server-tools/runtime-backend.ts` — the `runtime_backend` tool (list, probe, select,
  start_monitor), in DEFAULT_TOOLS. `runtime_session_status` names backend and device.
- Gate recording: `c64re scenario run` (`src/scenario/cli.ts`) and `runtime_sandbox_run`
  (`src/server-tools/runtime-sandbox.ts`) call `recordPassForRun` after a PASS.
- Tests: `npm run smoke:889` (fake Ultimate, 198 checks, in `gates.yml`),
  `npm run e2e:889-pass` (real emulator runs record passes; local, skips without a runtime),
  `npm run e2e:889-ue2emu` (a whole Ultimate in software; local, skips without it).
  `scripts/lib/fake-ultimate.mjs` is the fake (REST routes, UDP ident, one-client WS JSON-RPC
  answering like `rpc.c`, all on 127.0.0.1).

**Decisions and deviations from the text above**

1. The emulator is `kind: "emulator"` in code and in everything the agent reads. Spec 800's
   gate (`check-runtime-invisible`) forbids the brand in agent-facing strings; the spec's
   `trx64` stays an accepted spelling of the env value (`C64RE_RUNTIME_BACKEND=trx64|emulator|
   c64u:<host>[:<rest port>]`). The `:<rest port>` suffix is mine, for a device behind a forward.
2. `ping.capabilities` is accepted in both shapes the app documents: an array of names, and
   `{methods:[…], notifications:[…]}` (T21 §8.1). The check runs at select; a gap is named, and a
   call to a gap method is refused by name without being sent. Without capabilities an unserved
   method surfaces the device's own -32601 sentence with a note.
3. After select, `debug/continue` is sent when the machine is paused and (we just started trxmon,
   or there is no stop, or the stop reason is `pause`). A stop at a breakpoint, a step or a jam is
   left alone ("a person at the machine wins", §7) and the select says so. `paused: true` never
   continues.
4. `api/call` is expressed for four verbs only (monitorRegisters, monitorMemory, stepInto,
   status); the rest is refused by name with `runtime_monitor` as the way out. The app has no
   `until`, `stepOver`, breakpoint-by-id etc. in the daemon's `api/call` shape.
5. Refused by name besides §5's list: `daemon/keep_alive`, `project/set`, `runtime/call`,
   `runtime/mark` (a trace mark), `runtime/swap_disk_and_continue`, `media/persist`, `media/swap`,
   `session/cart_status`, single key/pot events, cartridge eject (no REST route), `session/power
   op=on`. Each carries its way out (`routing.ts`).
6. REST mapping: typing is letters unshifted (what BASIC wants), shifted symbols with
   `left_shift`, ≤ 64 taps per request; `hold_cycles`/`gap_cycles` are not used. Mounts and CRT/PRG
   go up as raw `POST` bodies (a path on the host means nothing on the device), so a disk's writes
   land in the device's temporary copy, never in the host image — said in the answer. `run_prg`
   with an entry address is `load_prg` + `monitor/exec "g <entry>"`.
7. The gate covers `media/open`, `media/mount`, `media/ingress` (disk, crt, prg; path or
   `bytes_b64`), `session/load_prg`, `runtime/run_prg`. Project resolution: the project that
   contains the file, else `setProjectDir`, else `C64RE_PROJECT_DIR`; none = refused, never allowed.
   A pass is recorded per medium: the one a run started from and each one an `I insert` step
   names. The record carries `runtimeVersion` (the pinned daemon version), not "TRX64 version".
   A record file that does not parse passes nothing and is not overwritten.
8. `trxmon.u2a` defaults to `/Flash/apps/trxmon.u2a` (T21 §8.1 names it); the path is a
   parameter (`trxmon_path`). `start_monitor` uses `PUT /v1/apps:run_file` by default, the
   app route (`via: "app"`) on request; 423 is "already running", 403 on the app route explains
   the old manifest.
9. One connection: the select-time `ping`, the capability check, every call and the probe of the
   selected device ride the held `RpcLink`; selecting the same device again reuses it; a probe of
   another device opens a short connection and gives the slot back. A refusal (-32001 / close
   1013 / HTTP 503) is reported as the device said it.
10. `runtime_backend list` broadcasts to `255.255.255.255:64` by default (that is the discovery
    the spec asks for); `broadcast`, `ident_port`, `hosts` and `scan:false` change that, and every
    test names `127.0.0.1`.

**Seen against the UE2 emulator** (`e2e-889-ue2emu.mjs`, 38 checks, firmware `f2a26eae`)

Worked: the UDP ident and `/v1/info` through `--net user` forwards (`trx64 {core TRX2, board
C64U}`, no rpc), probe → `core-no-monitor`, start from `/Usb0/trxmon.u2a` (a `--usb-dir`
volume), 423 on a second start, ping `trx64-runtime/2` / `backend c64u`, PAUSED on start →
continue, state / read_memory / `monitor/exec` / break_add·del / pause / step / continue /
`checkpoint/list` / `runtime/reverse_step`, typing reaching BASIC (`PRINT 6*7` → 42 read from
screen RAM), the gate then `run_prg` writing `$C000`, `trxmon/quit` → "trxmon not running",
restart → reconnect. Notes: that firmware's ping has no `capabilities` and `version` is
`trxmon 0.1`; the ident's `rpc` is the GUEST port (4312), so behind a forward the host port is
passed as `rpc_port`; `monitor/exec` answers `{output, spans}`; `session/state` carries `model`,
`backend`, `controlOwner`, `streamPump:false`. Not exercised there: `run_crt`, disk mounts,
the video stream.

**Not built (named, not hidden)**

- (Built since, see §9 and §10:) §4c picture and sound, the top-bar selector with rescan, the
  "switching asks first" dialog, the REST-password prompt, and the workbench server relay.
- `media/ingress` etc. do not broadcast `media/changed` (still true; §10 "Not built").
- `CLAUDE.md` rule 1 still carries the old wording; DOCTRINE.md is amended, CLAUDE.md is the
  owner's file.
- `e2e:889-pass` is not in `gates.yml` (needs the runtime), nor is the UE2 run.

**Open questions**

1. `capabilities` shape: array (as §2 says) or `{methods, notifications}` (as T21 §8.1 says)?
   Both are accepted today; one should be dropped when the app ships.
2. Should a select ever continue a machine that is paused for any reason? Today only a plain
   `pause` stop or a fresh trxmon start is continued (decision 3).
3. A cartridge started over REST cannot be ejected and has no status route. Is `machine:reboot`
   + a following select the intended way back to BASIC, or should the backend keep the knowledge
   "a cart was started by C64RE" itself?
4. `runtime_backend list` broadcasts by default. Acceptable for a headless agent on a shared
   network, or should discovery be opt-in (`broadcast` required)?

## §9 As built (streams)

§4c is built as self-contained modules plus the player change; the backend switch, the
discovery and the WS relay that carries these messages to browsers are not part of it.

**Modules** — `src/runtime/c64u-streams/`: `wire.ts` (constants, header parse, nibble unpack),
`video.ts` (`FrameAssembler`), `audio.ts` (`AudioTimeline`), `relay.ts` (the binary messages),
`receiver.ts` (UDP sockets, paused signal), `control.ts` (REST start/stop, `httpRestCaller`),
`screenshot.ts`, `index.ts` (`C64UStreams`, the one object the backend holds).

**The interface the backend calls** (`C64UStreams`): `startStreams()` opens the two UDP sockets
and asks the device to send, returns a ticket at once (`settled` never rejects for device
trouble; a bind failure rejects); `rearm()` after a system reset; `stopStreams()` stops on the
device (audio, then video) and closes the sockets; `screenshot()` / `frameIndices()` answer in the
daemon's `session/screenshot` / `session/frame_indices` shapes plus `ageMs`, `paused`, `complete`,
`frame`; `audioFormat()` is `{sampleRate: 48003.07, channels: 2}` for the `audio/start` reply;
`status()`. Injected: `rest` (a `RestCaller`; `httpRestCaller(baseUrl, {password})` is the plain
one), `receiverHost` (this host as the device reaches it; `localAddressTowards(deviceHost)`),
`deviceHost` (source filter), `relay.{video,audio,paused}`, bind address and ports.

**Relay bytes** are the daemon's own: `[type:u8][seq:u32 LE][payload]`; `0x01` payload
`[w:u16][h:u16][fmt=1][0][cycle:u32=0][48 B colodore palette][w*h indices]`, `0x02` raw s16le
stereo. The palette is the emulator path's colodore table. The 240- and 272-line frames carry
their own height. The device sends no cycle counter, so `cycle` is 0 (the UI does not read it).

**Player.** `WebAudioPlayer(streamRate = 44100)`; the backend's `audio/start` reply may carry
`sampleRate` and `MachineControls` then calls `setStreamRate`, which rebuilds the context and the
worklet at that rate. The emulator's reply has no field, so its player is built with the same
numbers as before (the smoke asserts them). The AudioContext is asked for `round(rate)` and the
worklet's resample ratio carries the fraction.

**Decisions.**
- Live audio fill cap: 12 packets (48 ms at 48,003.07 Hz). The reference's 2500 (~10 s) is for
  files; live, a longer fade is worse than the jump of a re-anchor, which is what a gap beyond the
  cap does (no fill).
- Video: a frame is handed out complete, or when the next frame's first packet arrives (gaps show
  that frame's previous lines, colour 0 with none). A straggler of a frame already handed out is
  dropped and counted `packets_late`. This differs from the reference, which keeps two frames in
  progress and never hands out a partial one. A backward frame-counter jump beyond 8 frames is a
  device restart (re-anchor), not endless "reordering".
- Paused = no video datagram for 250 ms; the last frame is kept.
- A late audio packet is dropped, not re-inserted (the reference's semantics: its slot was already
  concealed).
- Starts run video then audio, sequentially, each under a 15 s deadline; a deadline is reported as
  a timeout, a device refusal verbatim (HTTP status and body), a transport failure as unreachable.

**Not done / not detectable.** The device has no "get stream target", so the backend cannot say
beforehand that the streams were pointed elsewhere; it replaces the target and can only say so
after. Marking the picture "paused" in the Live tab is the backend relaying `relay.paused` as a
notification and the tab reading it; the signal exists, no notification name is fixed here.
No test ran against a device or recorded device datagrams (none exist on disk); the datagrams are
synthetic, built from the header layout in `streams.py`.

**Gate.** `npm run smoke:889-streams` (hermetic, in `gates.yml`).

## §10 As built (UI + wiring)

Master, 2026-10-07. §2's last bullet, §4's UI half and §4c's wiring are built; with §8 and §9 that
is all of §2–§5 and §4c.

**Wiring** (`src/runtime/c64u/c64u-backend.ts`, `streams-frame-source.ts`, `routing.ts`, `backend.ts`)

- The `C64UBackend` owns one `C64UStreams` while it is selected. `connect()` binds the UDP sockets and
  asks the device to send (video, then audio); that returns without waiting for the device (a unicast
  start can take seconds) — the outcome is in `streamStatus()` / `describe().device.streams` and in the
  select's notes. A bind failure, a bad port in the environment or a refusing device does not fail the
  select: the picture is then unavailable and every message says why.
- Stop on deselect and on a switch (`closeAndWait`, audio first). A switch from device A to B selects B
  with `deferStreams`, and only after B is selected stops A and lets B bind: the fixed ports are free
  first, and a device that cannot be selected leaves the old choice and its streams running.
- Re-arm after `session/reset` (soft or cold). FrameSource = the receiver (`StreamsFrameSource`); a
  `NoFrameSource` remains only for `streams: false`. `session/screenshot` carries the device's frame
  counter, lost packets and age (`extra`).
- Routed now (they were refused): `audio/start` answers `{ok, sampleRate: 48003.07, channels: 2}`,
  `audio/stop` `{ok}`, `session/frame_indices` is served from the last frame. Every other `audio/*`,
  `vic/*`, … stays an emulator-only refusal.
- Paused: the backend emits the JSON-RPC notification `stream/paused {paused, ageMs}` (the receiver's
  250 ms rule); it travels with the app's own notifications.
- Environment: `C64RE_C64U_RECEIVER_HOST` (default: the local address towards the device),
  `C64RE_C64U_VIDEO_PORT` / `C64RE_C64U_AUDIO_PORT` (default 11000 / 11001, `0` = free),
  `C64RE_C64U_STREAM_SOURCE` (source filter; default the device's address, `any` = none — for a NAT that
  rewrites the sender; the UE2 e2e sets it). Discovery
  stays the broadcast to 255.255.255.255:64; an explicit host list is accepted too.

**The relay** (`src/workspace-ui/runtime-backend-routes.ts`, wired in `server.ts`)

- *Who holds the selection.* The workbench server and the MCP server are different processes and
  today share nothing: the selection is per process (`backend.ts`), from `C64RE_RUNTIME_BACKEND` or a
  `select`. Decided: the workbench server owns **its own** backend instance, selected through its own
  API, and relays for the page. Why: a device serves ONE app connection and ONE stream target per
  stream, so a second process holding the same device is refused by the device (and by the fixed UDP
  ports) whatever C64RE does; sharing through a file would share a name, not the connection. Whichever
  process selects a device first holds it; the other gets the device's refusal, verbatim. The page and
  the assistant therefore do not co-drive a C64U the way they co-drive the emulator's daemon (open
  question 1).
- `WS /runtime-relay` (same origin only: a handshake with another `Origin` is a 403): JSON-RPC calls
  go to the active backend and are answered with its result or error (`RpcError` code, a refusal as
  -32601); the backend's notifications are broadcast as JSON; video binary frames go to every page
  (latest-frame-wins past 4 MiB of backlog), audio only to a page that called `audio/start`, until its
  `audio/stop`. A page that connects while the machine is paused gets `stream/paused` and the last frame
  at once. Close 4400: no C64 Ultimate selected (the page goes direct); 4001: the selection changed.
- `/api/config` names the relay URL while a C64U is selected (plus `backend`, `emulatorWsUrl`); with the
  emulator selected `runtimeWsUrl` is what it always was and `/api/runtime-status` is unchanged.
  `/api/monitor/exec` goes over the backend when a C64U is selected.
- API (smoke-covered, the UI's only doors): `GET /api/runtime/backend`; `GET|POST /api/runtime/devices`
  (every answering device with its reason; a password for one device re-probes that device only);
  `POST /api/runtime/backend/select` — **asks first**: a switch to another backend is a 409
  `{needsConfirm, from, to}` until the body says `confirmed:true`; `POST /api/runtime/backend/start-monitor`.
  POSTs must be `application/json` (415 otherwise), hosts are validated, bodies capped at 64 KiB.
- The REST password lives in the server process's memory, keyed by `host:port`; it is sent only to
  that device, is in no reply, no log, no file (the smoke greps the whole sandbox), and the page keeps
  it in a ref, never in browser storage.

**The UI** (`ui/src/workbench/components/BackendSelector.tsx`, `ws-client.ts`, `Live.tsx`)

- Top bar chip "TRX64 (emulator)" / "C64 Ultimate <host>"; the popover lists the emulator and the
  scanned devices (ready: Select; trxmon not running: Start monitor; greyed with the reason; Password…),
  Rescan, and on every ours-row the note that the app's RPC port has no password. Switching opens a
  dialog in the shape of the project switch (safe answer focused). After a switch `WsClient.restart()`
  reconnects to whatever `/api/config` names and the tabs pick their session again.
- Live tab: on `stream/paused` the last frame stays and a PAUSED marker with the age of that frame
  (ticking) shows; cleared by `paused:false` or a closed connection. `MachineControls` already applied
  the stream rate from `audio/start` (§9).

**Tests.** `npm run smoke:889-ui` (105 checks, in `gates.yml`): the wiring against the fake Ultimate and
a UDP sender, the workbench server as a child process, the relay WebSocket, the page's own `WsClient`
(esbuild bundle, real WebSocket) over the emulator path (the same JSON-RPC bytes, the same URL), a
switch and the way back, the password sweep, the UI source and the built bundle. `smoke:889` (198) and
`smoke:889-streams` are unchanged in what they assert. `e2e:889-ue2emu` (local, 46 checks) gained
section 3b: against the UE2 emulator the streams start, **guest → host UDP through slirp works** (the
host is 10.0.2.2 for the guest), PAL 384x272 frames arrive as the UI's frames, the screenshot is the
BASIC screen (blue 59.7 % / light blue 40.3 %), audio arrives at 48,154 Hz over a 5 s window with no
loss. Not run against real hardware.

**Not built (named).**
- `media/*` through the relay do not broadcast `media/changed`; a page reads the result of its own call.
- The Live tab's cart-status poll and a few other emulator-only calls fail quietly on a C64U (refused
  by name, ignored by the tab).
- CLAUDE.md rule 1 still carries the old wording (the owner's file).
- The assistant (MCP process) cannot use the device the workbench holds (open question 1).

**Open questions.**
1. Should the MCP process, when a workbench holds the C64U, call through the workbench's relay instead of
   opening a second (refused) connection? That would give back the co-drive the emulator has.
2. Is "scan on first open of the selector" enough, or should the page scan once at load?
3. Hardware: the real device decides whether `stream/paused` fires on a CPU-only `debug/pause` (the spec
   says video keeps running then) — the owner's test shows which stops pause the picture.

## §11 The facade is a daemon of its own (owner, 2026-10-08)

The first build (§8–§10) put the C64U facade into each C64RE process as a library: the MCP
server and the workbench server each held their own connection to the device. With
trxmon's one-connection rule only one of them got through, so the person and the
assistant could not co-drive the C64U — against DOCTRINE rule 2. The owner: *"das war
auch von Anfang an mein Steer dazu"* — the facade is like a second TRX64 daemon that talks
to the C64U instead of an emulated machine.

- **One process per device: `c64re c64u-bridge --device <host>[:<restport>] [--port <p>]`.**
  It speaks the TRX64 daemon's wire protocol on its own WS port: the same JSON-RPC methods
  and notifications, the same binary frames (`0x01` VIC frame, `0x02` audio) for A/V
  subscribers, `?av=0` honoured. Its `ping` answers like the daemon's
  (`runtime_version: "trx64-runtime/2"`) with `backend: "c64u"` and the device identity
  (host, ident `trx64` object, trxmon build/capabilities when the app sends them).
- **It holds the one device connection and the UDP streams**, and serves any number of
  clients: MCP, the browser, a CLI. Notifications go to all. This is the shared machine.
- **Everything of §8/§9 that talks to the device moves into it unchanged:** routing table,
  REST mapping, refusals by name, break_* wrappers, re-read after REST, trxmon-gone,
  capabilities check, streams (C64UStreams, palette, 48,003.07 Hz audio, `stream/paused`).
- **The gate (§4b) is enforced in the bridge**, because the browser talks to it directly
  and must be bound too. The project comes from `project/set` (as with the daemon); the
  pass records stay in that project's `knowledge/emulator-passes.json`. No project set →
  media/PRG doors refused.
- **Clients treat it as an endpoint.** In C64RE, "the C64U is selected" means the runtime
  endpoint is the bridge's: `RuntimeDaemonClient` connects to it as to any daemon, and the
  browser connects to it directly as it does to the emulator daemon. The workbench relay
  (`/runtime-relay`) and the in-process C64UBackend go.
- **Lifecycle, as the emulator daemon's:** started detached by C64RE on select (or by hand),
  one per device — a second start finds the running one and attaches; idle exit as the
  daemon's (Spec 886 rules: requests and A/V subscribers hold it) — on exit it stops the
  streams and closes the device connection; a bridge started by hand runs until stopped.
- **One selection, shared by MCP and workbench.** Both processes see the same choice
  (emulator or a bridge endpoint) and follow a switch made by either; a switch is
  announced to connected clients. Discovery, probe, "Start monitor" and the password stay
  as in §3/§3a/§10; the REST password is handed to the bridge at start (in memory there,
  never on disk or in argv visible to other users — environment or stdin).
- **Sandboxes, reels and scenario runs stay on private emulator daemons**, unchanged.
