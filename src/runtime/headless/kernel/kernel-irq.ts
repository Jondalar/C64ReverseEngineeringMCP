// Spec 203 — Kernel IRQ / NMI / SO / CA1 / CB1 event ring.
//
// ADR §4.3: IRQ/NMI/CA1/CB1/SO events are timestamped with edgeClock,
// visibleClock, servicedClock, sourceComponent, targetCpu. The kernel
// owns this ring; CIA / VIA / VIC backends emit events through the
// `emitIrqEvent` entry point.
//
// Spec 203-c1 lands the ring + emit API. Subsequent commits wire the
// chip backends to call emitIrqEvent on each line edge.
//
// CPU interrupt delay (Spec 203 acceptance §4.3) is computed from
// these timestamps, not incidental scheduler ordering.

export type KernelIrqLine = "irq" | "nmi" | "ca1" | "cb1" | "so";
export type KernelIrqSource =
  | "cia1"
  | "cia2"
  | "via1"
  | "via2"
  | "vic"
  | "drive-cpu"
  | "gcr-shifter"
  | "kernel";
export type KernelIrqTarget = "c64-cpu" | "drive-cpu" | "drive-via1" | "drive-via2";

export interface KernelIrqEvent {
  /** Line that changed. */
  line: KernelIrqLine;
  /** True when asserted (logical level), false when released. */
  asserted: boolean;
  /** Source chip / component that drove the edge. */
  source: KernelIrqSource;
  /** CPU or peripheral consuming the line. */
  target: KernelIrqTarget;
  /**
   * Clock domain of the source, expressed in source-side cycles.
   * For CIA / VIC / CIA2 this is the C64 clock. For VIA1/VIA2 and
   * drive-cpu this is the 1541 clock.
   */
  edgeClock: number;
  /**
   * Clock at which the receiving CPU first observes the edge.
   * Equals edgeClock today; refined when proper sample-on-cycle
   * latching lands in Spec 203-c3+.
   */
  visibleClock: number;
  /**
   * Clock at which the CPU services the IRQ (vector fetch). Filled
   * in by Spec 203-c3+ once interrupt-service tracing lands; stays
   * undefined until then.
   */
  servicedClock?: number;
  /** Monotonic kernel sequence number. */
  seq: number;
}

export class KernelIrqRing {
  private readonly capacity: number;
  private readonly buf: KernelIrqEvent[];
  private head = 0;
  private size = 0;
  private nextSeq = 0;

  constructor(capacity = 4096) {
    this.capacity = capacity;
    this.buf = new Array(capacity);
  }

  emit(event: Omit<KernelIrqEvent, "seq">): KernelIrqEvent {
    const stamped: KernelIrqEvent = { ...event, seq: this.nextSeq++ };
    this.buf[this.head] = stamped;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
    return stamped;
  }

  read(): readonly KernelIrqEvent[] {
    const out: KernelIrqEvent[] = [];
    if (this.size === 0) return out;
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i++) {
      out.push(this.buf[(start + i) % this.capacity]!);
    }
    return out;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }

  get count(): number {
    return this.size;
  }
}
