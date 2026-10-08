// Spec 889 §11 — `c64re c64u-bridge --device <host>[:<restport>] [--port <p>]`.
//
// Runs the C64U bridge in the foreground: the facade of a C64 Ultimate as a daemon of its own,
// speaking the TRX64 daemon wire protocol on a WebSocket port. Started by hand it runs until it is
// stopped (no idle exit unless `--idle-exit <s>` is given); C64RE starts it detached on select
// (launch.ts) and gives it the idle window.

import { createServer } from "node:net";
import { BridgeServer } from "./server.js";
import { findBridge } from "./launch.js";
import { bridgeRegistryFile, readBridgeEntry, removeFile, writeJsonAtomic, type BridgeRegistryEntry } from "./state.js";

const HELP = [
  "c64re c64u-bridge --device <host>[:<restport>] [options]",
  "",
  "  The C64 Ultimate facade as a daemon of its own: a WebSocket server speaking the TRX64 daemon",
  "  wire protocol (JSON-RPC 2.0, the same notifications, binary video/audio frames), answered from",
  "  the device. It holds the device's ONE app connection and its UDP streams and serves any number",
  "  of clients (the MCP server, the workbench, a CLI). One bridge per device: a second start finds",
  "  the running one and says where it is.",
  "",
  "  --device <host>[:<restport>]  the Ultimate (REST port default 80)            (required)",
  "  --port <p>                    TCP port to listen on (127.0.0.1); default the first free one from 4313",
  "  --idle-exit <seconds>         end after this long with no request and no picture/sound viewer",
  "                                (default: never — a bridge started by hand runs until stopped)",
  "  --project <dir>               the project the emulator-pass gate looks in (project/set moves it;",
  "                                default C64RE_PROJECT_DIR; none = media and PRG are refused by name)",
  "  --start-monitor               start trxmon over REST first when the device has our core without it",
  "  --paused                      leave the machine paused after connecting",
  "  --rpc-port <p>                the app's port when the ident does not name it (a device behind a forward)",
  "  --trxmon-path <path>          device path of trxmon.u2a (default /Flash/apps/trxmon.u2a)",
  "  --defer-streams               do not start picture and sound until a client calls bridge/begin_streams",
  "  --no-streams                  never start picture and sound",
  "  --password-stdin              read the device's REST password from the first line of stdin",
  "                                (or set C64RE_C64U_PASSWORD); never put it in an argument",
  "",
  "  UDP ports for picture and sound: C64RE_C64U_VIDEO_PORT / C64RE_C64U_AUDIO_PORT (default 11000 / 11001),",
  "  C64RE_C64U_RECEIVER_HOST, C64RE_C64U_STREAM_SOURCE.",
].join("\n");

function takeValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

function readFirstLine(stream: NodeJS.ReadableStream, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const done = () => { stream.removeAllListeners("data"); stream.removeAllListeners("end"); resolve(buf.split("\n")[0].replace(/\r$/, "")); };
    const timer = setTimeout(done, timeoutMs);
    stream.on("data", (d) => { buf += String(d); if (buf.includes("\n")) { clearTimeout(timer); done(); } });
    stream.on("end", () => { clearTimeout(timer); done(); });
  });
}

async function firstFreePort(from: number): Promise<number> {
  for (let p = from; p < from + 90; p++) {
    const free = await new Promise<boolean>((res) => {
      const s = createServer();
      s.once("error", () => res(false));
      s.listen(p, "127.0.0.1", () => s.close(() => res(true)));
    });
    if (free) return p;
  }
  throw new Error(`no free TCP port in ${from}-${from + 89} for the C64U bridge — pass --port`);
}

export async function runC64uBridgeCli(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return; }
  const dev = takeValue(argv, "--device");
  if (!dev) throw new Error("--device <host>[:<restport>] is required (c64re c64u-bridge --help)");
  const m = /^([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)(?::(\d{1,5}))?$/.exec(dev);
  if (!m) throw new Error(`--device ${JSON.stringify(dev)} is not a host[:restport]`);
  const host = m[1];
  const restPort = m[3] ? Number(m[3]) : 80;
  const num = (flag: string): number | undefined => {
    const v = takeValue(argv, flag);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${flag} ${JSON.stringify(v)} is not a number in 0..65535`);
    return n;
  };
  const port = num("--port");
  if (port === 4312) throw new Error("--port 4312 is the emulator daemon's port; the bridge never takes it");
  const idleRaw = takeValue(argv, "--idle-exit");
  const idleExitSeconds = idleRaw === undefined ? 0 : Number(idleRaw);
  if (!Number.isFinite(idleExitSeconds) || idleExitSeconds < 0) throw new Error(`--idle-exit ${JSON.stringify(idleRaw)} is not a number of seconds`);

  // One bridge per device: a running one is found, not replaced.
  const running = await findBridge(host, restPort);
  if (running) {
    console.log(JSON.stringify({ c64u_bridge: "already-running", endpoint: running.entry.endpoint, pid: running.entry.pid, device: `${host}:${restPort}` }));
    return;
  }

  let password: string | undefined = process.env.C64RE_C64U_PASSWORD || undefined;
  if (argv.includes("--password-stdin")) password = (await readFirstLine(process.stdin)) || password;
  delete process.env.C64RE_C64U_PASSWORD; // held in memory only; not for a child of ours to inherit

  const listenPort = port ?? (await firstFreePort(4313));
  const regFile = bridgeRegistryFile(host, restPort);
  const bridge: BridgeServer = new BridgeServer({
    host, restPort,
    rpcPort: num("--rpc-port"),
    password,
    trxmonPath: takeValue(argv, "--trxmon-path"),
    startMonitor: argv.includes("--start-monitor"),
    paused: argv.includes("--paused"),
    deferStreams: argv.includes("--defer-streams"),
    streams: argv.includes("--no-streams") ? false : undefined,
    projectDir: takeValue(argv, "--project"),
    port: listenPort,
    idleExitSeconds,
    onListening: (b) => {
      const entry: BridgeRegistryEntry = {
        host, restPort, port: b.port, endpoint: b.endpoint, pid: process.pid, startedAt: new Date().toISOString(),
      };
      writeJsonAtomic(regFile, entry);
    },
    onStopping: () => {
      const e = readBridgeEntry(host, restPort);
      if (e && e.pid === process.pid) removeFile(regFile);
    },
    onExit: (reason, code) => {
      console.error(`[c64u-bridge] ended: ${reason}`);
      process.exit(code);
    },
  });
  await bridge.start();
  console.log(JSON.stringify({ c64u_bridge: "listening", endpoint: bridge.endpoint, pid: process.pid, device: `${host}:${restPort}`, idleExitSeconds }));
  console.error(`[c64u-bridge] ${bridge.endpoint} -> ${host}:${restPort} (pid ${process.pid})`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { void bridge.shutdown(`signal ${sig}`, 0); });
}
