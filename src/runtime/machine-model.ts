// Spec 863 — which C64 the runtime is, as the runtime says.
//
// A C64 model is a row of the runtime's model table (PAL, NTSC, PAL-N, …). C64RE keeps no
// list of its own and no timing of its own: every frame count, every clock and every
// canvas size is read from what the machine reports — `session/state` (and the A/V
// hello) for the machine in hand, `session/models` for the rows. Before this spec the
// frame length lived here as `19656`, which is right on exactly one of those rows.
//
// Browser-safe on purpose (no node imports): the Live tab's model selector and the MCP
// tools use the same functions, so the confirmation the human reads and the refusal an
// agent gets cannot drift apart.

/** What the runtime reports about the machine in hand (the identity fields of
 *  `session/state`, `monitor/state`, `session/create` and `av/hello`). */
export interface MachineIdentity {
  readonly model: string;
  readonly videoStandard: string;
  readonly chip: string;
  readonly cyclesPerLine: number;
  readonly linesPerFrame: number;
  readonly cyclesPerFrame: number;
  readonly cpuHz: number;
  readonly frameRate: number;
  /** The picture the machine streams (the visible window), when reported. */
  readonly canvas?: { readonly width: number; readonly height: number };
}

/** One row of `session/models` — every model the runtime knows, runnable or not. */
export interface ModelRow {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly title?: string;
  readonly default?: boolean;
  /** False when the row names a building block this runtime does not have. */
  readonly runs?: boolean;
  /** The blocks it lacks, by name — shown, never hidden. */
  readonly missing?: readonly string[];
  readonly videoStandard?: string;
  readonly chip?: string;
  readonly cyclesPerLine?: number;
  readonly linesPerFrame?: number;
  readonly cyclesPerFrame?: number;
  readonly cpuHz?: number;
  readonly frameRate?: number;
}

const IDENTITY_FIELDS = ["model", "cyclesPerLine", "linesPerFrame", "cyclesPerFrame", "cpuHz", "frameRate"] as const;

/**
 * The machine's identity out of a state reply. Throws, naming the fields, when the
 * runtime does not report them — a runtime that old is PAL-only, but saying so here
 * would be exactly the assumption this module exists to remove.
 */
export function machineIdentity(state: unknown): MachineIdentity {
  const s = (state ?? {}) as Record<string, unknown>;
  const missing = IDENTITY_FIELDS.filter((k) =>
    k === "model" ? typeof s[k] !== "string" || !s[k] : typeof s[k] !== "number" || !((s[k] as number) > 0),
  );
  if (missing.length) {
    throw new Error(
      `the runtime did not report ${missing.join(", ")} for its machine — it predates C64 models ` +
        `(PAL / NTSC), so how long a frame is cannot be read from it. Update the runtime; nothing ` +
        `here assumes a PAL frame in its place.`,
    );
  }
  const canvas = s.canvas as { width?: unknown; height?: unknown } | undefined;
  return {
    model: s.model as string,
    videoStandard: typeof s.videoStandard === "string" ? s.videoStandard : "",
    chip: typeof s.chip === "string" ? s.chip : "",
    cyclesPerLine: s.cyclesPerLine as number,
    linesPerFrame: s.linesPerFrame as number,
    cyclesPerFrame: s.cyclesPerFrame as number,
    cpuHz: s.cpuHz as number,
    frameRate: s.frameRate as number,
    ...(canvas && typeof canvas.width === "number" && typeof canvas.height === "number"
      ? { canvas: { width: canvas.width, height: canvas.height } }
      : {}),
  };
}

/** `c64-ntsc (NTSC, VIC-II 6567R8): 65 × 263 = 17095 cycles/frame · 1022730 Hz · 59.83 fps`. */
export function describeMachine(m: MachineIdentity): string {
  const std = m.videoStandard ? m.videoStandard.toUpperCase() : "";
  const chip = m.chip ? `VIC-II ${m.chip}` : "";
  const what = [std, chip].filter(Boolean).join(", ");
  return (
    `${m.model}${what ? ` (${what})` : ""}: ${m.cyclesPerLine} × ${m.linesPerFrame} = ` +
    `${m.cyclesPerFrame} cycles/frame · ${m.cpuHz} Hz · ${m.frameRate.toFixed(2)} fps` +
    (m.canvas ? ` · canvas ${m.canvas.width}×${m.canvas.height}` : "")
  );
}

/** The row a name means — its own name or one of its aliases, case-insensitive. */
export function findModelRow(rows: readonly ModelRow[], name: string): ModelRow | undefined {
  const n = name.trim().toLowerCase();
  return rows.find((r) => r.name.toLowerCase() === n || (r.aliases ?? []).some((a) => a.toLowerCase() === n));
}

/** Do two names mean the same row? Unknown names are equal only when spelled the same. */
export function sameModel(rows: readonly ModelRow[], a: string, b: string): boolean {
  const ra = findModelRow(rows, a);
  const rb = findModelRow(rows, b);
  if (ra && rb) return ra.name === rb.name;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export interface ModelChoice {
  readonly name: string;
  readonly label: string;
  readonly disabled: boolean;
  /** Why it is disabled, or what it is. */
  readonly title: string;
}

/** The selector's options, straight from the rows: a row that cannot run is listed,
 *  disabled, with the block it lacks — never left out. */
export function modelChoices(rows: readonly ModelRow[]): ModelChoice[] {
  return rows.map((r) => {
    const title = r.title ?? r.name;
    const lacks = r.runs === false;
    const needs = (r.missing ?? []).join(", ");
    return {
      name: r.name,
      label: lacks ? `${title} — needs ${needs || "a block this runtime lacks"}` : title,
      disabled: lacks,
      title: lacks
        ? `${r.name}: cannot run here — the runtime lacks ${needs || "a building block"}`
        : `${r.name}${r.cyclesPerLine && r.linesPerFrame ? ` · ${r.cyclesPerLine} × ${r.linesPerFrame}` : ""}` +
          `${r.cpuHz ? ` · ${r.cpuHz} Hz` : ""}${r.frameRate ? ` · ${r.frameRate.toFixed(2)} fps` : ""}`,
    };
  });
}

/**
 * What the Live tab asks before it switches. It says what the switch KEEPS and what a
 * clean start would do instead, because the one thing a switch does not do is make the
 * running program an NTSC (or PAL) program: it detected its standard at boot.
 */
export function switchConfirmation(
  from: string | undefined,
  to: ModelRow,
  powered = true,
): { title: string; body: string[]; confirm: string } {
  const toName = to.title ?? to.name;
  if (!powered) {
    return {
      title: `Make this machine a ${toName}?`,
      body: [`The machine is off. It powers on as ${toName} (${to.name}).`],
      confirm: `Use ${to.name}`,
    };
  }
  return {
    title: `Switch${from ? ` from ${from}` : ""} to ${toName}?`,
    body: [
      `Switches at the next frame. The running program keeps its state — CPU, RAM, CIAs, SID, the drive — ` +
        `and the standard it detected at boot: its raster lines, timer values and $02A6 stay what they were.`,
      `This shows how THIS running program behaves on a ${toName}. For a clean ${to.videoStandard ? to.videoStandard.toUpperCase() : toName} ` +
        `start — the program boots and detects the standard itself — power-cycle (or reset) after the switch.`,
    ],
    confirm: `Switch at the next frame`,
  };
}

/** The route the Live tab switches through (`session/model`), for any client that has a
 *  JSON-RPC `call`. Returns the runtime's reply: from, model, switchedAt, kept. */
export async function switchMachineModel(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  sessionId: string,
  name: string,
): Promise<Record<string, unknown>> {
  return (await call("session/model", { session_id: sessionId, name })) as Record<string, unknown>;
}

/**
 * A recorded scenario on another machine: its inputs are timed in the other machine's
 * frames and cycles, so the replay is refused — naming both. `undefined` = same model
 * (or nothing recorded).
 */
export function scenarioModelRefusal(
  scenario: string,
  recorded: string | undefined,
  machine: string,
  rows: readonly ModelRow[],
): string | undefined {
  if (!recorded) return undefined;
  if (sameModel(rows, recorded, machine)) return undefined;
  const rec = findModelRow(rows, recorded)?.name ?? recorded;
  return (
    `scenario "${scenario}" was recorded on ${rec}, and this machine is ${machine} — its inputs are ` +
    `timed in the other machine's frames and cycles, so it is not replayed here. Run it on ${rec} ` +
    `(the default when nothing else is asked for), or record it again on ${machine}.`
  );
}
