// Spec 877 D2 — the human overrules, and it is recorded.
//
// 877 D1 puts teeth on three doors. A gate with no override is a gate that will one day be
// switched off wholesale, so the override is part of the design rather than a concession:
// the human says "ship it short", says why, and the project remembers both.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// "A RUN MAY NOT WAIVE ITS OWN PROMISE" — and what this file can honestly do about it.
//
// It cannot be enforced from inside. `contract_set` is an MCP tool: every call arrives on
// the same channel, from the same client, whether the human typed it or the run decided
// it. MCP carries no caller identity, and the harness relays both identically — the
// permission prompt that might distinguish them happens outside this server and is never
// reported back into the call. Anything this file tested to tell the two apart — a name
// that "looks human", an environment variable, a confirmation file — is a string the run
// can also produce, in a session that has a shell. That would be a fig leaf, and a fig
// leaf here is worse than the honest gap: it would let the next reader believe a
// self-waiver had been ruled out.
//
// So the waiver is not made impossible. It is made EXPENSIVE TO HIDE, and three of the
// four things below are enforced, not hoped for:
//
//   1. It must be signed. `by` is mandatory and never defaulted — no name, no waiver. The
//      server records the string verbatim and claims nothing about it.
//   2. It records the CHANNEL it actually came through (`via: "contract_set"`), so no
//      later reader can infer a provenance the server never saw.
//   3. It does not launder the number. The measurement (`now`) is unchanged and
//      `contract_show` keeps printing it; the verdict, the 849 footer and the doors all
//      stop counting the promise as owed and list it apart as waived, with who and when.
//      And while any other promise is owed, the refusal itself names every
//      waiver already granted — a waiver cannot make itself invisible.
//   4. It lapses when the human moves the bar (`activeWaivers`, standing.ts). Waive at
//      90 % and then quietly ask for 95 %, and the door refuses again rather than
//      inheriting a release nobody granted.
//
// What is left uncovered is exactly this: a run that waives a promise, signs it with a
// human's name and an honest-looking reason, and ships. That shows up in the timeline, in
// the standing file and in `contract_show` — from outside, in one glance — which is where
// 849 says this kind of enforcement belongs in the first place.

import type { Waiver } from "./standing.js";

export interface WaiveRequest {
  /** Promise ids, as `contractPromises` computes them. */
  promises: string[];
  reason: string;
  /** Who is overruling. Never defaulted. */
  by: string;
}

export interface WaiveResult {
  ok: boolean;
  message: string;
  waivers: Waiver[];
}

/** A reason short enough to be a shrug is not a reason. */
const MIN_REASON = 10;

export async function waivePromises(projectDir: string, req: WaiveRequest): Promise<WaiveResult> {
  const by = (req.by ?? "").trim();
  const reason = (req.reason ?? "").trim();
  const wanted = (req.promises ?? []).map((p) => p.trim()).filter(Boolean);

  if (!by) {
    return {
      ok: false, waivers: [],
      message: [
        "# waive refused — a waiver has to say WHO.",
        "",
        "This is the human overruling a promise the human made. The server cannot tell a",
        "person's call from a run's call — they arrive on the same channel — so the one",
        "thing it can insist on is a name, recorded verbatim next to the reason.",
        "",
        "  contract_set(waive=[…], waive_reason=\"…\", waived_by=\"<who>\")",
      ].join("\n"),
    };
  }
  if (reason.length < MIN_REASON) {
    return {
      ok: false, waivers: [],
      message: [
        "# waive refused — a waiver has to say WHY.",
        "",
        `The reason is what a reader has six months from now instead of the decision. At`,
        `least ${MIN_REASON} characters, in the words the decision was actually made in.`,
      ].join("\n"),
    };
  }
  if (wanted.length === 0) {
    return { ok: false, waivers: [], message: "# waive refused — name at least one promise to waive." };
  }

  const { contractPromises } = await import("./promises.js");
  const owed = await contractPromises(projectDir);
  const known = new Map(owed.map((p) => [p.id, p]));
  const unknown = wanted.filter((p) => !known.has(p));
  if (unknown.length > 0) {
    return {
      ok: false, waivers: [],
      message: [
        `# waive refused — ${unknown.map((u) => `"${u}"`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not owed here.`,
        "",
        owed.length
          ? `Owed right now: ${owed.map((p) => p.id).join(", ")}`
          : "Nothing is owed in this project — there is nothing to waive.",
        "",
        "`contract_show` prints the contract. `project_critique` carries the measurement.",
      ].join("\n"),
    };
  }

  const { recordWaiver } = await import("./standing.js");
  const at = new Date().toISOString();
  const written: Waiver[] = [];
  for (const id of wanted) {
    const p = known.get(id)!;
    const w: Waiver = { promise: id, reason, by, at, via: "contract_set", askedValue: p.askedValue, wasAt: p.now };
    recordWaiver(projectDir, w);
    written.push(w);
  }

  // The project's own memory of the decision. Soft: a timeline that cannot be appended to
  // must not turn a recorded waiver into a failed call — the standing file already has it.
  try {
    const { ProjectKnowledgeService } = await import("../project-knowledge/service.js");
    const service = new ProjectKnowledgeService(projectDir);
    for (const w of written) {
      service.appendTimelineEvent({
        kind: "contract.waived",
        title: `Contract promise waived: ${w.promise}`,
        summary: `${w.by} waived "${w.promise}" (contract asked ${w.askedValue}, measured ${w.wasAt ?? "—"}): ${w.reason}`,
        payload: { promise: w.promise, by: w.by, reason: w.reason, via: w.via, askedValue: w.askedValue, wasAt: w.wasAt ?? "" },
      });
    }
  } catch { /* the standing file is the record; the timeline is the second copy */ }

  return {
    ok: true,
    waivers: written,
    message: [
      `Waived by ${by}: ${written.map((w) => w.promise).join(", ")}`,
      `Reason: ${reason}`,
      "",
      ...written.map((w) => `  ${w.promise} — contract asks ${w.askedValue}, shipped at ${w.wasAt ?? "(not measured)"}`),
      "",
      "The doors open and `project_critique` stops blocking on it. The measurement does not",
      "change: `contract_show` keeps the shortfall in view, and this waiver is in the timeline and in `knowledge/contract-standing.json`",
      "with your name on it. It lapses by itself if the contract's number changes.",
    ].join("\n"),
  };
}

export interface UnwaiveResult {
  ok: boolean;
  message: string;
  withdrawn: string[];
}

/**
 * Spec 897 D9 — take a waiver back. Appended to the standing record next to the waiver it
 * ends (who, when, why, via), never by deleting it. Only a promise with an ACTIVE waiver
 * can be unwaived; anything else is refused by name and nothing is written. Same signature
 * rule as the waiver itself: a name and a reason, recorded verbatim.
 */
export async function unwaivePromises(projectDir: string, req: WaiveRequest): Promise<UnwaiveResult> {
  const by = (req.by ?? "").trim();
  const reason = (req.reason ?? "").trim();
  const wanted = (req.promises ?? []).map((p) => p.trim()).filter(Boolean);
  const refuse = (message: string): UnwaiveResult => ({ ok: false, message, withdrawn: [] });

  if (!by) return refuse(["# unwaive refused — a withdrawal has to say WHO.", "", "  contract_set(unwaive=[…], waive_reason=\"…\", waived_by=\"<who>\")"].join("\n"));
  if (reason.length < MIN_REASON) return refuse(`# unwaive refused — a withdrawal has to say WHY (at least ${MIN_REASON} characters).`);
  if (wanted.length === 0) return refuse("# unwaive refused — name at least one promise to unwaive.");

  const { contractPromises } = await import("./promises.js");
  const { activeWaivers, recordWithdrawal } = await import("./standing.js");
  const active = activeWaivers(projectDir, await contractPromises(projectDir));
  const byPromise = new Map(active.map((w) => [w.promise, w]));
  const none = wanted.filter((p) => !byPromise.has(p));
  if (none.length > 0) {
    return refuse([
      `# unwaive refused — ${none.map((u) => `"${u}"`).join(", ")} ${none.length === 1 ? "has" : "have"} no active waiver. Nothing was written.`,
      "",
      active.length ? `Waived right now: ${active.map((w) => w.promise).join(", ")}` : "No promise is waived right now.",
      "",
      "`contract_show` lists the waivers that hold and the ones that lapsed.",
    ].join("\n"));
  }

  const at = new Date().toISOString();
  for (const id of wanted) {
    recordWithdrawal(projectDir, { promise: id, reason, by, at, via: "contract_set", ends: byPromise.get(id)!.at });
  }
  try {
    const { ProjectKnowledgeService } = await import("../project-knowledge/service.js");
    const service = new ProjectKnowledgeService(projectDir);
    for (const id of wanted) {
      service.appendTimelineEvent({
        kind: "contract.unwaived",
        title: `Contract waiver withdrawn: ${id}`,
        summary: `${by} withdrew the waiver of "${id}": ${reason}`,
        payload: { promise: id, by, reason, via: "contract_set" },
      });
    }
  } catch { /* the standing file is the record; the timeline is the second copy */ }

  return {
    ok: true,
    withdrawn: wanted,
    message: [
      `Waiver withdrawn by ${by}: ${wanted.join(", ")}`,
      `Reason: ${reason}`,
      "",
      "The promise is owed again and the doors close on it. The waiver stays in",
      "`knowledge/contract-standing.json`, marked withdrawn.",
    ].join("\n"),
  };
}
