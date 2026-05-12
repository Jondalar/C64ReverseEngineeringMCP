// Capture VICE PC stream for IM2 boot. Step through each second from
// LOAD/RUN, dumping CPU history (last 256 ops).
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const port = 6502;
const vicePath = "/Applications/vice-arm64-gtk3-3.10/bin/x64sc";
const diskPath = join(repoRoot, "samples/impossible_mission_ii[epyx_1987](!).g64");
const outDir = join(repoRoot, "samples/vice-trace-im2");
mkdirSync(outDir, { recursive: true });

try { execSync(`pkill -9 -f x64sc || true`, { stdio: "ignore" }); } catch {}
await new Promise(r => setTimeout(r, 500));

const args = [
  "-default", "-warp",
  "-binarymonitor", "-binarymonitoraddress", `ip4://127.0.0.1:${port}`,
  "-autostart", diskPath,
];
const child = spawn(vicePath, args, { stdio: ["ignore", "ignore", "ignore"] });
await new Promise(r => setTimeout(r, 3000));

const { ViceMonitorClient } = await import("../dist/runtime/vice/monitor-client.js");
const client = new ViceMonitorClient({ host: "127.0.0.1", port });

let conn = false;
for (let i = 0; i < 12; i++) {
  try { await client.connect(2000); conn = true; break; } catch {}
  await new Promise(r => setTimeout(r, 500));
}
if (!conn) { child.kill("SIGKILL"); process.exit(1); }

const MEMSPACE_C64 = 0x00;

const REG_PC = 3;
function regsToPc(regs) {
  const r = regs.find(r => r.id === REG_PC);
  return r ? Number(r.value) : 0;
}

const samples = [];
let prevSec = 0;
for (const sec of [1, 3, 5, 8, 12, 18, 25, 35, 50]) {
  await client.resume();  // resume VICE
  await new Promise(r => setTimeout(r, (sec - prevSec) * 1000));
  prevSec = sec;
  // Now stop VICE again by issuing ping (registers query auto-stops)
  try {
    const hist = await client.getCpuHistory(64, MEMSPACE_C64);
    const pcStream = hist.map(h => regsToPc(h.registers).toString(16).padStart(4, "0"));
    const clk = hist.length > 0 ? Number(hist[hist.length-1].clock) : 0;
    samples.push({ sec, clk, pcStream });
    console.log(`t=${sec}s clk=${clk} last_pc=$${pcStream[pcStream.length-1]}`);
    console.log(`  recent_pcs: ${pcStream.slice(-16).join(" ")}`);
  } catch (e) {
    samples.push({ sec, error: String(e) });
    console.log(`t=${sec}s ERROR: ${e}`);
  }
}

writeFileSync(join(outDir, "pc-stream.json"), JSON.stringify(samples, null, 2));
console.log(`\nSaved to ${outDir}/pc-stream.json`);

child.kill("SIGKILL");
process.exit(0);
