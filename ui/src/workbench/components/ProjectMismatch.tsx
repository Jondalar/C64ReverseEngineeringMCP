// Spec 858 D4 — the requester that appears when the runtime serves another project.
//
// The daemon is shared and is started for ONE project. A workspace that attached to a daemon
// started elsewhere used to get that other project's files in every media picker, with no
// sign of why — an empty cartridge list in the Ultima VI workspace is what found it. The
// comparison is made by the daemon (`project/set` with `dry_run`), because the daemon owns
// the filesystem and compares canonical paths; this component only asks, shows, and — when
// the human says so — moves the daemon.

import { useCallback, useEffect, useState } from "react";
import { getClient } from "../ws-client";

interface ProjectCheck {
  changed: boolean;
  same: boolean;
  current: string | null;
  requested: string;
  media?: { disk: string | null; cart: string | null; blocked: string | null };
}

const mono: React.CSSProperties = { fontFamily: "monospace", wordBreak: "break-all" };

export function ProjectMismatch({ projectDir, conn }: { projectDir?: string; conn: string }) {
  const [check, setCheck] = useState<ProjectCheck | null>(null);
  const [minimised, setMinimised] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const recheck = useCallback(() => {
    if (!projectDir || conn !== "open") return;
    getClient()
      .call<ProjectCheck>("project/set", { path: projectDir, dry_run: true })
      .then((r) => {
        if (r.same) {
          setCheck(null);
          setMinimised(false);
        } else {
          setCheck(r);
        }
      })
      // A daemon older than 858 has no `project/set`: nothing to compare with, and no reason
      // to block the workspace over it.
      .catch((e) => console.warn("[858] runtime project check unavailable:", e?.message ?? e));
  }, [projectDir, conn]);

  useEffect(() => { recheck(); }, [recheck]);
  // Another workspace can move the daemon away underneath this one — ask again when it does.
  useEffect(() => getClient().onNotification("project/changed", () => recheck()), [recheck]);

  if (!check || !projectDir) return null;

  const switchProject = async () => {
    setBusy(true);
    setErr(null);
    try {
      await getClient().call("project/set", { path: projectDir });
      setCheck(null);
      setMinimised(false);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const blocked = check.media?.blocked ?? null;
  const mounted = [
    check.media?.disk ? `disk  ${check.media.disk}` : null,
    check.media?.cart ? `cart  ${check.media.cart}` : null,
  ].filter(Boolean) as string[];

  if (minimised) {
    return (
      <div style={{
        position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 999,
        background: "#3a2a00", borderTop: "1px solid #d47f00", color: "#f0d9a8",
        padding: "6px 14px", display: "flex", alignItems: "center", gap: 12, fontSize: 12,
      }}>
        <span>
          The runtime serves another project (<span style={mono}>{check.current ?? "none"}</span>) —
          media pickers show its files, not this workspace's.
        </span>
        <button onClick={() => setMinimised(false)} style={{ marginLeft: "auto" }}>Switch…</button>
      </div>
    );
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="pm858-title" style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
    }}>
      <div style={{
        background: "#1a1a1a", border: "1px solid #d47f00", borderRadius: 6,
        width: 600, maxWidth: "calc(100vw - 32px)", padding: 20, color: "#ccc", fontSize: 13,
        display: "flex", flexDirection: "column", gap: 12,
      }}>
        <div id="pm858-title" style={{ fontSize: 15, color: "#f0d9a8", fontWeight: 600 }}>
          The runtime is serving another project
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 12 }}>
          <span style={{ color: "#888" }}>runtime</span>
          <span style={mono}>{check.current ?? "no project"}</span>
          <span style={{ color: "#888" }}>this workspace</span>
          <span style={mono}>{check.requested}</span>
          <span style={{ color: "#888" }}>mounted there</span>
          <span style={mono}>{mounted.length ? mounted.join("\n") : "nothing"}</span>
        </div>
        {blocked ? (
          <div style={{ color: "#ff8080", fontSize: 12 }}>
            Cannot switch: {blocked}. Eject or persist it in the runtime first.
          </div>
        ) : (
          <div style={{ fontSize: 12, lineHeight: 1.5 }}>
            Switching writes the mounted media back to their files and ejects them, ends the session
            running there — machine state, rewind history, recorder — and cold-starts the machine on
            this workspace's project.
          </div>
        )}
        {err && <div style={{ color: "#ff8080", fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button id="pm858-leave" onClick={() => setMinimised(true)} disabled={busy}>Leave it</button>
          <button id="pm858-switch" onClick={switchProject} disabled={busy || !!blocked} style={{ fontWeight: 600 }}>
            {busy ? "Switching…" : "Switch to this project"}
          </button>
        </div>
      </div>
    </div>
  );
}
