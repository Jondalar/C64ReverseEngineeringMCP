// An MCP stdio server of this repo (dist/cli.js), driven the way a host does: JSON lines on stdin/stdout.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function startMcp({ root, env = {}, cwd = tmpdir() }) {
  const base = { ...process.env, C64RE_FULL_TOOLS: "", ...env };
  if (!("C64RE_RUNTIME_BACKEND" in env)) delete base.C64RE_RUNTIME_BACKEND;
  if (!("C64RE_PROCESS_ROLE" in env)) delete base.C64RE_PROCESS_ROLE;
  // (a test never reaches port 4312: an MCP that is not told its emulator endpoint is pointed at a closed port)
  if (!("C64RE_RUNTIME_ENDPOINT" in env)) base.C64RE_RUNTIME_ENDPOINT = "ws://127.0.0.1:9";
  const proc = spawn(process.execPath, [join(root, "dist/cli.js")], { cwd, env: base, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", nid = 1;
  const pend = new Map();
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const ln = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!ln) continue;
      let m; try { m = JSON.parse(ln); } catch { continue; }
      if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    }
  });
  proc.stderr.on("data", () => {});
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = nid++;
    const t = setTimeout(() => { pend.delete(id); rej(new Error(`timeout ${method}`)); }, 90000);
    pend.set(id, (m) => { clearTimeout(t); res(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    if (r.error) return `# transport error\n${JSON.stringify(r.error)}`;
    const text = (r.result?.content || []).map((c) => c.text).join("\n");
    return r.result?.isError ? `# tool error\n${text}` : text;
  };
  return { proc, rpc, call, stop: () => { try { proc.kill("SIGKILL"); } catch { /* gone */ } } };
}
