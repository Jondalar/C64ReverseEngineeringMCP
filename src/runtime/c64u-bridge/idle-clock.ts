// Spec 889 §11 — the bridge's idle clock, the daemon's rules (TRX64 Spec 887, idle.rs) in TypeScript.
//
// The bridge ends itself once it has been idle for `armed` seconds: no request, and no A/V
// subscriber (an A/V subscriber HOLDS the clock at "now"), unless `daemon/keep_alive` pushed the
// deadline out or held it forever. Pure — every method takes `now` — so the rules are tested
// without sleeping. The status object has the daemon's shape (`IdleExitStatus`, idle-exit.ts).

import type { IdleExitStatus } from "../idle-exit.js";

export class IdleClock {
  private lastActivity: number;
  private keptUntil: number | null = null;
  private keptForever = false;
  private holding: string | null = null;

  /** `armedSeconds` 0 = idle exit off. */
  constructor(readonly armedSeconds: number, now: number = Date.now()) { this.lastActivity = now; }

  /** A request arrived: the window starts again. */
  touch(now: number = Date.now()): void { this.lastActivity = now; }

  /** Something that keeps the bridge in use (`"subscriber"`) is present, or not. */
  hold(what: string | null, now: number = Date.now()): void {
    this.holding = what;
    if (what) this.lastActivity = now;
  }

  /** `daemon/keep_alive`: hold at least `seconds` from now; `null` = never exit on idle. */
  keepAlive(seconds: number | null, now: number = Date.now()): void {
    this.lastActivity = now;
    if (seconds === null) { this.keptForever = true; this.keptUntil = null; }
    else { this.keptForever = false; this.keptUntil = now + seconds * 1000; }
  }

  /** When it ends if nothing else happens (epoch ms); null = it will not (off, kept forever, or held). */
  deadline(): number | null {
    if (this.armedSeconds === 0 || this.keptForever || this.holding) return null;
    const idle = this.lastActivity + this.armedSeconds * 1000;
    return this.keptUntil !== null && this.keptUntil > idle ? this.keptUntil : idle;
  }

  expired(now: number = Date.now()): boolean {
    const d = this.deadline();
    return d !== null && now >= d;
  }

  status(now: number = Date.now()): IdleExitStatus {
    return {
      armedSeconds: this.armedSeconds,
      deadlineMs: this.deadline(),
      keptAliveUntilMs: this.keptUntil !== null && this.keptUntil > now ? this.keptUntil : null,
      keptForever: this.keptForever,
      holding: this.holding,
    };
  }
}
