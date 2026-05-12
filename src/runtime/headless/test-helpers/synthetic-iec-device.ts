// Spec 111 (M3.3) — SyntheticIecDevice.
//
// Mock IEC peripheral that responds to bus events the way a real
// listener / talker would, without running a real drive ROM. Used by
// the M3.3 KERNAL serial byte matrix to exercise primitive-level
// behavior in a deterministic, fast harness.
//
// Protocol state machine is driven by external `step(busState, time)`
// calls. The harness orchestrates a host-side bit-bang script; this
// device observes the lines and pulses its own DATA / CLK in
// response per CBM IEC protocol.
//
// Scope (M3.3 v1):
//   - LISTEN frame ack (synth pulls DATA when its device id matches)
//   - TALK frame ack
//   - byte receive (synth releases DATA once it sees CLK released)
//   - byte transmit (synth provides bits with CLK toggles)
//   - EOI signal on last byte (>256us pause before final handshake)
//   - device-not-present: synth disabled → no DATA pull → host
//     observes timeout
//
// Out of scope: bit-level GCR, error channels, parallel cable.

export type IecRole = "idle" | "listener" | "talker";

export interface SyntheticIecDeviceOptions {
  deviceId: number;        // 8-31
  enabled?: boolean;       // default true; when false, synth never pulls
  ackBytes?: number[];     // bytes to deliver when commanded TALK
  signalEoiOnLast?: boolean; // synth pulls EOI signal on last byte tx
}

export interface BusObservation {
  atnLow: boolean;       // true = ATN asserted
  clkLow: boolean;       // true = CLK pulled low (host or device)
  dataLow: boolean;      // true = DATA pulled low (host or device)
  hostClkReleased: boolean;
  hostDataReleased: boolean;
}

export interface DeviceLineDrive {
  pullClk: boolean;    // synth wants CLK low
  pullData: boolean;   // synth wants DATA low
}

export interface DeviceState {
  role: IecRole;
  selectedDevice?: number;
  selectedSecondary?: number;
  bytesReceived: number[];
  bytesTransmitted: number[];
  framesAcked: number;
  eoiSignaledOnByteIndex?: number;
}

interface InternalState {
  // Last observed bus snapshot (for edge detection).
  prevAtnLow: boolean;
  prevClkLow: boolean;
  prevDataLow: boolean;
  // Frame-receive bit accumulator.
  rxBitsAcc: number;     // bits collected (LSB first per CBM protocol)
  rxBitIndex: number;    // 0..7
  rxAtnFrame: boolean;   // true if current frame is an ATN command (LISTEN/TALK/SECOND/UNLSN/UNTLK)
  // Tx state.
  txByteIdx: number;     // index into ackBytes for current TALK
  txBitIdx: number;      // 0..7 bit within current byte
  txWaitingHostReady: boolean;
}

export class SyntheticIecDevice {
  public readonly opts: Required<SyntheticIecDeviceOptions>;
  public state: DeviceState = {
    role: "idle",
    bytesReceived: [],
    bytesTransmitted: [],
    framesAcked: 0,
  };
  private internal: InternalState = {
    prevAtnLow: false,
    prevClkLow: false,
    prevDataLow: false,
    rxBitsAcc: 0,
    rxBitIndex: 0,
    rxAtnFrame: false,
    txByteIdx: 0,
    txBitIdx: 0,
    txWaitingHostReady: false,
  };
  // Synth's drive desire (queried by harness).
  private drive: DeviceLineDrive = { pullClk: false, pullData: false };

  constructor(opts: SyntheticIecDeviceOptions) {
    this.opts = {
      deviceId: opts.deviceId,
      enabled: opts.enabled ?? true,
      ackBytes: opts.ackBytes ?? [],
      signalEoiOnLast: opts.signalEoiOnLast ?? false,
    };
  }

  reset(): void {
    this.state = {
      role: "idle",
      bytesReceived: [],
      bytesTransmitted: [],
      framesAcked: 0,
    };
    this.internal = {
      prevAtnLow: false, prevClkLow: false, prevDataLow: false,
      rxBitsAcc: 0, rxBitIndex: 0, rxAtnFrame: false,
      txByteIdx: 0, txBitIdx: 0, txWaitingHostReady: false,
    };
    this.drive = { pullClk: false, pullData: false };
  }

  getDrive(): DeviceLineDrive { return { ...this.drive }; }

  // Called by harness with each new bus observation. Returns the
  // synth's desired drive output for the next bus settle.
  observe(o: BusObservation): DeviceLineDrive {
    if (!this.opts.enabled) {
      this.drive = { pullClk: false, pullData: false };
      return this.drive;
    }

    // ATN falling edge: ATN command frame begins. Per spec a listener
    // MUST pull DATA low within ~1ms of ATN-LOW to signal presence.
    if (o.atnLow && !this.internal.prevAtnLow) {
      this.drive.pullData = true;
      this.internal.rxAtnFrame = true;
      this.internal.rxBitsAcc = 0;
      this.internal.rxBitIndex = 0;
      this.state.role = "listener";
    }

    // ATN rising edge: end of command frame. If we were addressed as
    // talker (TALK $40 + dev), switch role; else remain listener or idle.
    if (!o.atnLow && this.internal.prevAtnLow) {
      // Role finalization based on most-recent command (set in
      // recordReceivedByte when ATN frame).
      // No bus drive change here.
    }

    // Frame byte clocking (during ATN-low or after TALK): host pulls
    // CLK to indicate "bit valid", listener samples DATA.
    if (o.atnLow || this.state.role === "listener") {
      const clkFell = o.clkLow && !this.internal.prevClkLow;
      if (clkFell && this.internal.rxBitIndex < 8) {
        const bit = o.hostDataReleased ? 0 : 1; // line low = bit 1 (CBM convention)
        this.internal.rxBitsAcc |= bit << this.internal.rxBitIndex;
        this.internal.rxBitIndex++;
        if (this.internal.rxBitIndex === 8) {
          this.recordReceivedByte(this.internal.rxBitsAcc, o.atnLow);
          this.internal.rxBitsAcc = 0;
          this.internal.rxBitIndex = 0;
        }
      }
    }

    this.internal.prevAtnLow = o.atnLow;
    this.internal.prevClkLow = o.clkLow;
    this.internal.prevDataLow = o.dataLow;
    return { ...this.drive };
  }

  private recordReceivedByte(byte: number, inAtnFrame: boolean): void {
    if (inAtnFrame) {
      // ATN command byte. $20+dev = LISTEN, $40+dev = TALK,
      // $3F = UNLISTEN, $5F = UNTALK, $60+sa = SECOND, $E0+sa = TKSA.
      const cmd = byte & 0xe0;
      const arg = byte & 0x1f;
      switch (cmd) {
        case 0x20: // LISTEN
          if (arg === this.opts.deviceId) {
            this.state.selectedDevice = arg;
            this.state.role = "listener";
            this.drive.pullData = true; // hold ack
          } else {
            this.state.selectedDevice = undefined;
            this.state.role = "idle";
            this.drive.pullData = false;
          }
          this.state.framesAcked++;
          break;
        case 0x40: // TALK
          if (arg === this.opts.deviceId) {
            this.state.selectedDevice = arg;
            this.state.role = "talker";
          } else {
            this.state.selectedDevice = undefined;
            this.state.role = "idle";
            this.drive.pullData = false;
          }
          this.state.framesAcked++;
          break;
        case 0x60: // SECOND or UNLSN/UNTLK
          if (byte === 0x3f) {
            // UNLISTEN — release everything.
            this.state.role = "idle";
            this.drive.pullData = false;
            this.state.selectedSecondary = undefined;
          } else if (byte === 0x5f) {
            // UNTALK
            this.state.role = "idle";
            this.drive.pullData = false;
            this.state.selectedSecondary = undefined;
          } else if (this.state.role !== "idle") {
            this.state.selectedSecondary = byte & 0x0f;
          }
          this.state.framesAcked++;
          break;
        case 0xe0: // TKSA (talker secondary)
          if (this.state.role === "talker") {
            this.state.selectedSecondary = byte & 0x0f;
          }
          this.state.framesAcked++;
          break;
      }
      return;
    }
    // Data byte (post-ATN frame, listener mode).
    if (this.state.role === "listener") {
      this.state.bytesReceived.push(byte);
    }
  }

  // Called by talker-mode harness to source one byte to host.
  popTalkerByte(): { byte: number; isLast: boolean; signalEoi: boolean } | null {
    if (this.state.role !== "talker") return null;
    if (this.internal.txByteIdx >= this.opts.ackBytes.length) return null;
    const byte = this.opts.ackBytes[this.internal.txByteIdx]!;
    const isLast = this.internal.txByteIdx === this.opts.ackBytes.length - 1;
    const signalEoi = isLast && this.opts.signalEoiOnLast;
    this.state.bytesTransmitted.push(byte);
    this.internal.txByteIdx++;
    return { byte, isLast, signalEoi };
  }
}
