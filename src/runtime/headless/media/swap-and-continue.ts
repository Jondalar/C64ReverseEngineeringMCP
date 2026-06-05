// Spec 744 §7.2 / BUG-027 Blocker 2 — high-level disk-swap-and-continue.
//
// A multi-disk game ("Insert side N. (RETURN)") waits in a loop until the 1541
// SENSES the disk being pulled and a new one inserted — which a real drive sees
// over many drive cycles (the write-protect-sense line pulses as the drive clock
// advances). The atomic `runtime_media_swap` (detach+attach with ZERO cycles
// between) gives the drive no time to sense it, so the wait-loop never releases.
//
// This drives it like hardware in ONE call: eject → run (drive senses removal) →
// insert → run (drive senses insertion) → confirm key (RETURN) → run on. Each
// `runFor` advances the C64 AND, via the IEC catch-up, the 1541 — so the sense
// window actually progresses while the game polls.

import { ingestMedia } from "./ingress.js";
import { buildIngressRequest } from "./ingress-request.js";
import type { RuntimeController } from "../debug/runtime-controller.js";

export interface SwapAndContinueArgs {
  /** Absolute path to the new disk image (.d64/.g64). */
  path: string;
  /** Key(s) to answer the prompt; default RETURN. Empty string = no key. */
  confirmInput?: string;
  /** Cycles to run after the eject AND after the insert so the drive senses the
   *  change. Default 1.5M each (~1.5 frames-worth of drive clock at 1 MHz). */
  settleCycles?: number;
  /** Cycles to run after the confirm key, so the prompt advances + the next side
   *  starts loading. Default 4M. */
  postCycles?: number;
}

export interface SwapAndContinueResult {
  ok: boolean;
  mounted: string;
  screenBefore: string;
  screenAfter: string;
  /** An "insert/side/disk/flip" prompt was on screen before and is gone after. */
  promptCleared: boolean;
  /** The screen changed at all (weaker signal than promptCleared). */
  advanced: boolean;
  detail: Record<string, unknown>;
}

// A side-change prompt, heuristically (English titles). Used only to report
// whether the prompt cleared — never to gate the mechanics.
const PROMPT_RE = /\b(INSERT|SIDE|DISK|FLIP|TURN OVER)\b/i;

function scToAscii(sc: number): string {
  const c = sc & 0x7f; // ignore reverse-video bit
  if (c === 0) return "@";
  if (c >= 1 && c <= 26) return String.fromCharCode(64 + c); // A-Z
  if (c === 32) return " ";
  if (c >= 33 && c <= 63) return String.fromCharCode(c); // punctuation + digits
  return " ";
}

/** Decode the live 40x25 text screen at the REAL screen pointer (VIC bank from
 *  CIA2 $DD00 + the $D018 matrix nibble), side-effect-free. */
function decodeScreen(bus: { peek(a: number, lens: "io" | "ram"): number }): string {
  const dd00 = bus.peek(0xdd00, "io") & 0x03;
  const base = (((3 - dd00) * 0x4000) + (((bus.peek(0xd018, "io") >> 4) & 0x0f) * 0x0400)) & 0xffff;
  const rows: string[] = [];
  for (let r = 0; r < 25; r++) {
    let line = "";
    for (let c = 0; c < 40; c++) line += scToAscii(bus.peek((base + r * 40 + c) & 0xffff, "ram"));
    rows.push(line.replace(/\s+$/, ""));
  }
  return rows.join("\n").replace(/\n+$/, "");
}

export async function swapDiskAndContinue(
  ctrl: RuntimeController,
  args: SwapAndContinueArgs,
): Promise<SwapAndContinueResult> {
  const session = ctrl.session;
  const bus = session.c64Bus as unknown as { peek(a: number, lens: "io" | "ram"): number };
  const confirm = args.confirmInput ?? "\r";
  const settle = Math.max(1, Math.floor(args.settleCycles ?? 1_500_000));
  const post = Math.max(1, Math.floor(args.postCycles ?? 4_000_000));
  // runFor(maxInstr, {cycleBudget}) — min 2 cyc/instr, so maxInstr = cycles/2 + slack.
  const runCycles = (n: number) => session.runFor(Math.ceil(n / 2) + 64, { cycleBudget: n });

  const screenBefore = decodeScreen(bus);

  // 1. eject the outgoing disk (persists if dirty) — opening the drive door.
  await ingestMedia(ctrl, { kind: "eject", role: "drive8" });
  // 2. run so the drive registers the removal.
  runCycles(settle);
  // 3. insert the new disk.
  const ins = await ingestMedia(ctrl, buildIngressRequest({ kind: "disk", path: args.path }));
  // 4. run so the drive registers the insertion.
  runCycles(settle);
  // 5. confirm (RETURN by default), 6. run on so the prompt advances.
  if (confirm) session.typeText(confirm, 33000, 33000);
  runCycles(post);

  const screenAfter = decodeScreen(bus);
  const hadPrompt = PROMPT_RE.test(screenBefore);
  const stillPrompt = PROMPT_RE.test(screenAfter);
  return {
    ok: true,
    mounted: String((ins.event as { name?: string } | undefined)?.name ?? args.path.split("/").pop() ?? args.path),
    screenBefore,
    screenAfter,
    promptCleared: hadPrompt && !stillPrompt,
    advanced: screenAfter !== screenBefore,
    detail: { insert: ins.detail, settleCycles: settle, postCycles: post, hadPrompt, stillPrompt },
  };
}
