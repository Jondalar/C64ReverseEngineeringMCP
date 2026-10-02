// Spec 886 — the auto-started runtime ends itself when nobody uses it.
//
// The daemon keeps the clock (TRX64 Spec 887: `--idle-exit <s>`, `daemon/keep_alive`, and
// `idleExit` in `ping` and `session/state`). This side asks for the clock when it starts a
// daemon, words the deadline for a status answer, and says so when a call finds the old
// machine gone and starts a new one — machine state must not come back silently.

/** TRX64 887's status object, as `ping` and `session/state` carry it. */
export interface IdleExitStatus {
  /** 0 = no idle exit (a daemon started by hand). */
  readonly armedSeconds: number;
  /** When it ends itself, epoch ms; null when it will not (off, kept forever, or held). */
  readonly deadlineMs: number | null;
  readonly keptAliveUntilMs: number | null;
  readonly keptForever: boolean;
  /** What holds the clock at "now" — a stream subscriber, a recording trace — or null. */
  readonly holding: string | null;
}

/** Seconds of idle after which an auto-started daemon ends: C64RE_RUNTIME_IDLE_EXIT, 0 = never. */
export function idleExitSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.C64RE_RUNTIME_IDLE_EXIT;
  if (raw === undefined || raw.trim() === "") return 600;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 600;
}

const minutes = (ms: number): string => {
  const m = Math.max(0, Math.ceil(ms / 60_000));
  return m === 1 ? "1 min" : `${m} min`;
};
const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

/** One line for a status answer. */
export function describeIdleExit(s: IdleExitStatus | undefined, now = Date.now()): string {
  if (!s) return "Idle exit: not reported (a runtime older than TRX64 Spec 887)";
  if (!s.armedSeconds) return "Idle exit: none — this runtime was started by hand and runs until it is stopped";
  const window = minutes(s.armedSeconds * 1000);
  if (s.keptForever) return `Idle exit: kept alive — it does not end on its own (otherwise after ${window} idle)`;
  if (s.holding) {
    const what = s.holding === "trace" ? "a recording trace" : s.holding === "subscriber" ? "a viewer on the A/V stream" : `a ${s.holding}`;
    return `Idle exit: held by ${what}; the ${window} idle clock starts when that ends`;
  }
  if (s.deadlineMs === null) return `Idle exit: after ${window} idle`;
  const kept = s.keptAliveUntilMs && s.keptAliveUntilMs >= s.deadlineMs ? ` (kept alive until ${clock(s.keptAliveUntilMs)})` : "";
  return `Idle exit: ends itself in ${minutes(s.deadlineMs - now)} if nothing happens${kept} — the next tool call then starts a fresh machine`;
}

// ── the respawn notice ────────────────────────────────────────────────────────────
let pendingNotice: string | null = null;

export function noteFreshRuntime(text: string): void { pendingNotice = text; }

/** The notice, once: the first tool answer after a respawn carries it. */
export function takeFreshRuntimeNotice(): string | null {
  const n = pendingNotice;
  pendingNotice = null;
  return n;
}
