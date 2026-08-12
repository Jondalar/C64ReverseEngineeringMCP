// Pre-V2 1541-v2 — IEC byte-level transaction trace.
//
// True-drive mode bypasses the KERNAL trap suite, so the existing
// `kernalSerial` event log stays empty. To debug fastloader stage-1
// command sequences (M-W / M-E / U1 / B-R / etc.) we instrument the
// C64 KERNAL ROM at $EDDD (CIOUT byte send) + $EE13 (ACPTR byte
// receive) — those are the canonical byte-level entry points the
// real ROM uses regardless of who's calling.
//
// Each byte logged with: { cycle, dir: "send" | "recv", byte, atnLow,
// pcCaller }. Caller can dump the whole stage-1 command sequence
// post-LOAD to figure out what the game asked the drive to do.

export interface IecByteEvent {
  cycle: number;
  dir: "send" | "recv";
  byte: number;
  atnLow: boolean;        // ATN asserted at this cycle?
  pcCaller: number;       // PC at the trap entry (for stack inspection)
}

export class IecByteTraceLog {
  public readonly events: IecByteEvent[] = [];
  public capacity = 4096;
  private enabled = false;

  enable(capacity = 4096): void { this.enabled = true; this.capacity = capacity; this.events.length = 0; }
  disable(): void { this.enabled = false; }
  isEnabled(): boolean { return this.enabled; }
  clear(): void { this.events.length = 0; }

  log(ev: IecByteEvent): void {
    if (!this.enabled) return;
    this.events.push(ev);
    if (this.events.length > this.capacity) this.events.shift();
  }

  // Decode a sequence of "send" bytes that occurred while ATN was low
  // — these are the command-channel bytes ($28+dev = LISTEN, $48+dev =
  // TALK, $5F = UNTLK, $3F = UNLSN, $60+sa = SECOND, $E0+sa = TKSA).
  // After ATN released, "send" bytes are command-channel data (M-W
  // payload, U1 args, etc.).
  summarizeCommands(): string[] {
    const out: string[] = [];
    let inAtn = false;
    let atnFrame: number[] = [];
    const flushAtn = () => {
      if (atnFrame.length === 0) return;
      const cmds = atnFrame.map((b) => {
        const cmd = b & 0xe0;
        const arg = b & 0x1f;
        if (cmd === 0x20) return `LISTEN ${arg}`;
        if (cmd === 0x40) return `TALK ${arg}`;
        if (b === 0x3f)   return `UNLSN`;
        if (b === 0x5f)   return `UNTLK`;
        if (cmd === 0x60) return `SECOND $${(b & 0x1f).toString(16)}`;
        if (cmd === 0xe0) return `TKSA $${(b & 0x1f).toString(16)}`;
        return `?$${b.toString(16)}`;
      });
      out.push(`[ATN] ${cmds.join(" ")}`);
      atnFrame = [];
    };
    let dataBuf: number[] = [];
    let lastDir: "send" | "recv" | null = null;
    const flushData = () => {
      if (dataBuf.length === 0) return;
      const ascii = dataBuf.map((b) => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : ".").join("");
      const hex = dataBuf.map((b) => b.toString(16).padStart(2, "0")).join(" ");
      out.push(`[${lastDir}] ${dataBuf.length}b: ${hex}  "${ascii}"`);
      dataBuf = [];
    };
    for (const ev of this.events) {
      const wasAtn: boolean = inAtn;
      inAtn = ev.atnLow;
      if (wasAtn !== inAtn) { flushAtn(); flushData(); }
      if (ev.dir !== lastDir) { flushData(); lastDir = ev.dir; }
      if (inAtn) atnFrame.push(ev.byte);
      else dataBuf.push(ev.byte);
    }
    flushAtn(); flushData();
    return out;
  }
}
