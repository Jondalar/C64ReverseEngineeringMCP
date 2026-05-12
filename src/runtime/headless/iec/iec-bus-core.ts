// Spec 140 v3 / Spec 416 — VICE 1:1 IEC bus core port.
//
// Mirrors VICE 3.7.1 iecbus_t struct + functions:
//   src/iecbus/iecbus.c (state + iecbus_cpu_write_conf1 logic)
//   src/c64/c64iec.c    (iec_update_cpu_bus, iec_update_ports)
//   src/drive/iec/via1d1541.c (read_prb, store_prb)
//
// Doc anchors (spec 416 / vice-iec-arc42.md):
//   §5.1   iecbus_t structure
//   §5.2   iec_update_cpu_bus / iec_update_ports formulas
//   §15 A  Phase A clone-checklist (steps 1-3)
//   §16    cross-doc invariant index
//   §17.1  spec-OQ resolutions (drv_data[16] shape, cpu_bus formula)
//
// Type semantics: TS Number is 64-bit float; bitwise ops convert to
// 32-bit signed int. VICE C uses uint8_t / uint32_t with explicit
// casts. We mirror exactly using `& 0xff` for uint8_t equivalents,
// `>>> 0` for uint32_t casts where VICE's `(uint32_t)` matters.

const VICE_PCR_CA1_NEG = 0;  // negative-edge config
const VICE_PCR_CA1_POS = 1;  // positive-edge config
void VICE_PCR_CA1_NEG;
void VICE_PCR_CA1_POS;

export class IecBusCore {
  // Spec 416 §5.1 / §15 A step 1 — pin iecbus_t shape.
  // VICE struct: src/iecbus.h:56-83. Fields per spec 416 §15 A:
  //   cpu_bus, cpu_port, drv_port, drv_bus[16], drv_data[16].
  // IECBUS_NUM = 16 (src/iecbus.h:35). drv_data / drv_bus are
  // contiguous 16-element uint8 arrays indexed by device number
  // (units 8..11 are disk units; 4..7 + 12..15 reserved). See
  // §17.1 OQ-416-1 resolution.
  // Initial values match iecbus_init() in src/iecbus/iecbus.c:197-203
  // (memset 0xff over whole struct + drv_port = READ_DATA|READ_CLK|
  // READ_ATN = 0x01 | 0x04 | 0x80 = 0x85).
  public cpu_bus = 0xff;       // c64-side intent (post c64cia2.c:150 ~byte invert)
  public cpu_port = 0xff;      // effective bus state seen by c64 (cached)
  public readonly drv_bus = new Uint8Array(16);    // per-unit bus contribution
  public readonly drv_data = new Uint8Array(16);   // raw drive PB output (= ~ORB)
  public drv_port = 0x85;      // effective bus state seen by drive (= READ_DATA|READ_CLK|READ_ATN)

  // VICE iec_old_atn state for ATN edge detection (src/iecbus/iecbus.c:65).
  public iec_old_atn = 0x10;   // initial: ATN released (cpu_bus & 0x10 = 0x10)

  constructor() {
    // memset 0xff over the whole struct — src/iecbus/iecbus.c:199.
    this.drv_bus.fill(0xff);
    this.drv_data.fill(0xff);
  }

  reset(): void {
    this.cpu_bus = 0xff;
    this.cpu_port = 0xff;
    this.drv_bus.fill(0xff);
    this.drv_data.fill(0xff);
    this.drv_port = 0x85;
    this.iec_old_atn = 0x10;
  }

  // Spec 416 §5.2 / §15 A step 2 — iec_update_cpu_bus.
  // VICE: src/c64/c64iec.c:121-124. Formula verbatim:
  //   cpu_bus = ((data<<2)&0x80) | ((data<<2)&0x40) | ((data<<1)&0x10)
  // VICE convention: `data` is the INVERTED PA latch byte
  // (per src/c64/c64cia2.c:150 `tmp = (uint8_t)~byte`). Caller MUST
  // invert before calling. cpu_bus encodes "1 = c64 NOT asserting"
  // (= line HIGH). Bit map per §17.1 OQ-416-2:
  //   data bit 5 (DATA OUT) → cpu_bus bit 7 (DATA)
  //   data bit 4 (CLK  OUT) → cpu_bus bit 6 (CLK)
  //   data bit 3 (ATN  OUT) → cpu_bus bit 4 (ATN)
  iec_update_cpu_bus(data: number): void {
    const d = data & 0xff;
    this.cpu_bus = (((d << 2) & 0x80) | ((d << 2) & 0x40) | ((d << 1) & 0x10)) & 0xff;
  }

  // Spec 416 §5.2 / §15 A step 3 — iec_update_ports.
  // VICE: src/c64/c64iec.c:126-138. AND-fold cpu_bus with all
  // drv_bus[4..8+NUM_DISK_UNITS-1]; we widen to [4..15] (NUM_DISK_UNITS=4
  // → [4..11]; entries 12..15 stay 0xff per memset, AND is identity).
  // drv_port bit layout (wired to VIA1 PB; getting it wrong corrupts
  // every read — see §11 risks + §15 A step 3):
  //   drv_port bit 0 (DATA_IN) ← cpu_port bit 7 (DATA)
  //   drv_port bit 2 (CLK_IN)  ← cpu_port bit 6 (CLK)
  //   drv_port bit 7 (ATN)     ← cpu_bus  bit 4 (ATN intent — C64-only)
  // Note ATN bit comes from raw cpu_bus, NOT post-AND cpu_port (ATN
  // is C64-driven only; drives never assert ATN).
  iec_update_ports(): void {
    let cp = this.cpu_bus;
    for (let unit = 4; unit < 16; unit++) cp &= this.drv_bus[unit]!;
    this.cpu_port = cp & 0xff;
    this.drv_port = (
      ((this.cpu_port >> 4) & 0x04) |   // bit 6 → bit 2 (CLK_IN)
      (this.cpu_port >> 7) |            // bit 7 → bit 0 (DATA_IN)
      ((this.cpu_bus << 3) & 0x80)      // bit 4 → bit 7 (ATN)
    ) & 0xff;
  }

  // iecbus.c:281-285 drv_bus[unit] recomputation for type-1541 drives.
  // VICE casts `(uint32_t)(~drv_data ^ cpu_bus)` BEFORE shift.
  // We mirror with `>>> 0` to ensure unsigned 32-bit semantics in JS.
  recompute_drv_bus(unit: number): void {
    const dd = this.drv_data[unit]! & 0xff;
    // VICE: drv_bus = (((dd << 3) & 0x40) | ((dd << 6) & ((uint32_t)(~dd ^ cpu_bus) << 3) & 0x80))
    const term1 = (dd << 3) & 0x40;
    // (uint32_t) cast in C: convert to unsigned 32-bit. In TS:
    //   ~dd produces signed 32-bit (sign-extended).
    //   `(~dd & 0xff)` would mask to 8 bits — but VICE uses uint32_t,
    //   so high bits stay set. We use `(~dd >>> 0) & ...` carefully.
    // For this formula final bit isolation is via `& 0x80`, which
    // only looks at bit 7. Both approaches give the same bit 7.
    const xor = ((~dd) ^ this.cpu_bus) >>> 0;  // uint32_t cast
    const shifted = (xor << 3) >>> 0;          // uint32_t shift
    const term2 = (dd << 6) & shifted & 0x80;
    this.drv_bus[unit] = (term1 | term2) & 0xff;
  }

  // via1d1541.c:211-248 store_prb (drive writes $1800).
  // drive_data = ~byte. drv_bus[unit] recomputed. iec_update_ports.
  drive_store_pb(byte: number, unit: number = 8): void {
    this.drv_data[unit] = (~byte) & 0xff;
    this.recompute_drv_bus(unit);
    this.iec_update_ports();
  }

  // via1d1541.c:323-347 read_prb (drive reads $1800).
  // byte = ((PRB & 0x1A) | drv_port) ^ 0x85 | (number << 5)
  // For drive 8: number = 0 → orval = 0. Drive 9 → orval = 0x20.
  // Per Q5: device id (8/9) → unit-internal number (0/1) → orval.
  drive_read_pb(prb: number, deviceId: number): number {
    const orval = ((deviceId - 8) << 5) & 0xff;
    return (((prb & 0x1a) | this.drv_port) ^ 0x85 | orval) & 0xff;
  }

  // iecbus.c:237-287 iecbus_cpu_write_conf1 — c64 stores $DD00 PA.
  // Caller passes:
  //   data = INVERTED PA latch (= ~rawByte per c64cia2.c:150)
  //   onAtnEdge: callback for ATN edge propagation to drive VIA1 CA1.
  //              Receives `risingEdge` flag (true = atn went HIGH).
  c64_store_dd00(
    data: number,
    onAtnEdge?: (risingEdge: boolean) => void,
  ): void {
    this.iec_update_cpu_bus(data);
    // ATN edge detection (iecbus.c:247-268).
    const newAtn = this.cpu_bus & 0x10;
    if (this.iec_old_atn !== newAtn) {
      this.iec_old_atn = newAtn;
      // VICE: viacore_signal(via1d1541, VIA_SIG_CA1, iec_old_atn ? 0 : VIA_SIG_RISE)
      // - iec_old_atn = 0x10 (HIGH/released) → pass 0 (= falling-edge tag)
      // - iec_old_atn = 0    (LOW /asserted) → pass VIA_SIG_RISE (=1, rising-edge tag)
      // This is OPPOSITE of physical edge direction. The signal arg
      // is "polarity tag of just-observed edge". viacore_signal then
      // checks if PCR matches.
      if (onAtnEdge) {
        // Risk: misnamed param. Actually VICE passes EDGE-DIRECTION-OPPOSITE
        // tag, but viacore_signal interprets it together with PCR. For our
        // simpler pulseCa1, we pass the level (newLevel = atnLine boolean).
        // newAtn = 0x10 → ATN released (HIGH) → newLevel = true
        // newAtn = 0    → ATN asserted (LOW)  → newLevel = false
        onAtnEdge(newAtn !== 0);
      }
    }
    // Recompute drv_bus[8] (1541 type — default branch in
    // iecbus.c:281-285) because cpu_bus just changed and drv_bus
    // includes the ATN-AND-gate term that depends on cpu_bus.
    // VICE only recomputes for ACTIVE drives — drive 9 stays at
    // memset 0xff (transparent). We only model drive 8 in V2.
    this.recompute_drv_bus(8);
    this.iec_update_ports();
  }

  snapshot(): {
    cpu_bus: number; cpu_port: number; drv_port: number;
    drv_bus_8: number; drv_data_8: number;
    drv_bus_9: number; drv_data_9: number;
    iec_old_atn: number;
  } {
    return {
      cpu_bus: this.cpu_bus,
      cpu_port: this.cpu_port,
      drv_port: this.drv_port,
      drv_bus_8: this.drv_bus[8] ?? 0xff,
      drv_data_8: this.drv_data[8] ?? 0xff,
      drv_bus_9: this.drv_bus[9] ?? 0xff,
      drv_data_9: this.drv_data[9] ?? 0xff,
      iec_old_atn: this.iec_old_atn,
    };
  }
}
