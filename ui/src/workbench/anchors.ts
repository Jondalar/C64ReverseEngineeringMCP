// Anchors in the workbench — the same named instants runtime_anchor_* give the assistant.
//
// The ring (the daemon) owns them: `mark/set|list|drop|goto`. Nothing here keeps a copy, so a
// anchor the assistant sets shows up on the next list and one set here is listed over MCP.
// Pure functions over anything with a `call`, so the smoke can run them against a real daemon.

export interface AnchorClient {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface Anchor {
  name: string;
  anchorId: string;
  cycle: number;
  frame: number | null;
  secondsBack?: number;
}

export interface AnchorList {
  anchors: Anchor[];
  used: number;
  cap: number;
}

export async function listAnchors(c: AnchorClient): Promise<AnchorList> {
  const r = await c.call<{ marks?: Anchor[]; used?: number; cap?: number }>("mark/list", {});
  return { anchors: r.marks ?? [], used: r.used ?? (r.marks ?? []).length, cap: r.cap ?? 32 };
}

/**
 * Name an instant. The runtime names the checkpoint under the TRANSPORT CURSOR, and a second name on a
 * checkpoint REPLACES its first — so this never lets the runtime pick:
 *  - with a frame (`frameId`, the one the user clicked in the filmstrip) the cursor is put on that frame
 *    first, and the name is refused if that frame already carries another;
 *  - without one, the machine's present instant is captured and named, and only at the head of the ring
 *    (scrubbed back, the cursor is on an older checkpoint that may be named).
 * The runtime's own refusals (a taken name, the 33rd) are thrown as they came.
 */
export async function setAnchor(c: AnchorClient, sessionId: string, name: string, opts: { frameId?: string }): Promise<Anchor> {
  const clean = name.trim();
  if (!clean) throw new Error("an anchor needs a name");
  if (opts.frameId) {
    const ring = (await c.call<{ checkpoints?: Array<{ id: string }> }>("checkpoint/list", { session_id: sessionId })).checkpoints ?? [];
    const at = ring.findIndex((x) => x.id === opts.frameId);
    if (at < 0) throw new Error(`frame ${opts.frameId} is not in the ring any more`);
    const carried = (await listAnchors(c)).anchors.find((a) => a.anchorId === opts.frameId);
    if (carried) throw new Error(`that frame is already the anchor "${carried.name}" — a second name would replace it`);
    await c.call("transport/goto", { frame: at + 1 });
    const t = await c.call<{ anchorId?: string }>("transport/status", {});
    if (t.anchorId !== opts.frameId) throw new Error("could not put the transport on that frame — nothing was named");
  } else {
    const t = await c.call<{ atHead?: boolean; frameTotal?: number }>("transport/status", {});
    if (t.atHead === false) throw new Error(`the machine stands in replay, not at the head of the ring: go to frame ${t.frameTotal ?? "last"} first, or click the frame you mean`);
    await c.call("checkpoint/capture", { session_id: sessionId, source: "ui" });
  }
  const r = await c.call<{ mark: Anchor }>("mark/set", { name: clean });
  return r.mark;
}

/** Moves the shared machine to the anchor and pauses it there. */
export async function gotoAnchor(c: AnchorClient, name: string): Promise<{ line?: string; cycles?: number }> {
  return c.call("mark/goto", { name });
}

export async function dropAnchor(c: AnchorClient, name: string): Promise<void> {
  await c.call("mark/drop", { name });
}

/** The transport line, with the nearest anchor and how far away it is ("vor_level3 +12" = 12 frames past it). */
export async function transportLine(c: AnchorClient): Promise<string> {
  const t = await c.call<{ line?: string; nearestMark?: { name: string; framesAway: number } | null }>("transport/status", {});
  const near = t.nearestMark ? `nearest anchor: ${t.nearestMark.name} ${t.nearestMark.framesAway >= 0 ? "+" : ""}${t.nearestMark.framesAway}` : "no anchor set";
  return `${(t.line ?? "").split("\n")[0]}  ·  ${near}`;
}
