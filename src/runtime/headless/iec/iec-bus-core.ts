// Spec 140 — VICE-compatible IEC bus core.
//
// Authoritative cached state mirroring VICE 3.7.1:
//   src/iecbus/iecbus.c
//   src/c64/c64iec.c
//   src/drive/iec/via1d1541.c
//
// All formulas bit-exact per Q5 + Spec 138 probe finding (drive
// $1800 read needs VICE encoding to match).
//
// Bits in cpu_bus (= post-DDR-latch c64 intent on bus):
//   bit 4 = ATN  (c64 asserts when bit set)
//   bit 6 = CLK
//   bit 7 = DATA
//
// Bits in drv_bus[unit] (= per-unit drive contribution):
//   bit 6 = CLK pulled by drive
//   bit 7 = DATA pulled by drive (post-ATN-AND-gate)
//
// Bits in cpu_port (= effective wire state seen by c64):
//   = cpu_bus AND-folded with all drv_bus[*]
//
// Bits in drv_port (= effective wire state seen by drive):
//   bit 0 = DATA line state (1 = released/high)
//   bit 2 = CLK line state  (1 = released/high)
//   bit 7 = c64 ATN intent  (1 = c64 not asserting)
//
// Drive $1800 read = ((PRB & 0x1A) | drv_port) ^ 0x85 | (devId << 5)
//   - PRB bits 1+3+4 unconditionally from OR latch (VICE doesn't
//     gate by DDR for these — opposite of typical 6522 read mode).
//   - drv_port bits 0+2+7 inverted by XOR so semantic becomes
//     "1 = line asserted/low".
//   - devId<<5 adds the jumper bits at position 5+6.

export class IecBusCore {
  // VICE state (16 unit slots; only 8/9 modelled, 4-7 + 10-15
  // prefilled 0xff = released).
  // Initial values match VICE iecbus_init: memset 0xff + manual
  // drv_port = 0x85 (idle bus = all lines HIGH/released encoding).
  cpu_bus = 0xff;
  cpu_port = 0xff;
  drv_bus: Uint8Array = new Uint8Array(16);
  drv_data: Uint8Array = new Uint8Array(16);
  drv_port = 0x85;

  constructor() {
    // Q5: prefill unused unit slots with 0xff = transparent in
    // wired-AND. Drive slots also start 0xff = drive idle (no pull).
    this.drv_bus.fill(0xff);
    this.drv_data.fill(0xff);
  }

  // VICE iec_update_cpu_bus: cpu_bus encodes c64-side intent.
  //   data = $DD00 PA latch bits (bit 3=ATN_OUT, 4=CLK_OUT, 5=DATA_OUT)
  //   cpu_bus bit 4 = ATN (data << 1) & 0x10  (= data bit 3)
  //   cpu_bus bit 6 = CLK (data << 2) & 0x40  (= data bit 4)
  //   cpu_bus bit 7 = DATA (data << 2) & 0x80 (= data bit 5)
  // VICE does NOT mask by DDR — raw PA latch only. KERNAL programs
  // DDR=output for IEC bits before writing PA, so the distinction
  // rarely matters in practice. Per Q user directive "1:1 wie VICE".
  iecUpdateCpuBus(paLatch: number, _ddrMask: number): void {
    const data = paLatch;
    this.cpu_bus = (((data << 2) & 0xC0) | ((data << 1) & 0x10)) & 0xff;
  }

  // VICE iec_update_ports: AND-fold drv_bus[*] into cpu_port,
  // recompose drv_port from cpu_port + cpu_bus.
  iecUpdatePorts(): void {
    let cp = this.cpu_bus;
    // VICE iterates unit 4..NUM_DISK_UNITS+8 = 4..16
    for (let u = 4; u < 16; u++) cp &= this.drv_bus[u]!;
    this.cpu_port = cp & 0xff;
    // VICE drv_port composition: bit0=DATA, bit2=CLK, bit7=ATN
    this.drv_port =
      (((this.cpu_port >> 4) & 0x04) |
        (this.cpu_port >> 7) |
        ((this.cpu_bus << 3) & 0x80)) & 0xff;
  }

  // VICE store_prb / iec_drive_write: drive 8 wrote $1800 PRB.
  //   drv_data[unit] = ~byte (drive's PB output, inverted)
  //   drv_bus[unit] = ATN-AND-gate composition:
  //     bit 6 = (drv_data << 3) & 0x40    (CLK)
  //     bit 7 = (drv_data << 6) & ((~drv_data ^ cpu_bus) << 3) & 0x80
  //             (DATA, gated by ATN AND-gate UE5)
  driveStorePb(byte: number, unit = 8): void {
    const dd = (~byte) & 0xff;
    this.drv_data[unit] = dd;
    const clk = (dd << 3) & 0x40;
    // Note: ATN-AND-gate XOR formula — bit-exact VICE iecbus.c:283
    const dataGated =
      (dd << 6) & (((~dd ^ this.cpu_bus) << 3) & 0xff) & 0x80;
    this.drv_bus[unit] = (clk | dataGated) & 0xff;
    this.iecUpdatePorts();
  }

  // VICE read_prb: drive reads $1800.
  //   byte = ((PRB & 0x1A) | drv_port) ^ 0x85 | (number << 5)
  //   PRB = OR latch; bits 1+3+4 = drive's own DATA_OUT/CLK_OUT/ATN_ACK
  driveReadPbByte(prb: number, deviceId: number): number {
    const orval = ((deviceId - 8) << 5) & 0xff; // VICE uses unit 0/1, ours uses dev 8/9 → 0/1<<5
    return (((prb & 0x1a) | this.drv_port) ^ 0x85 | orval) & 0xff;
  }

  reset(): void {
    this.cpu_bus = 0xff;
    this.cpu_port = 0xff;
    this.drv_bus.fill(0xff);
    this.drv_data.fill(0xff);
    this.drv_port = 0x85;
  }

  snapshot(): {
    cpu_bus: number; cpu_port: number; drv_port: number;
    drv_bus_8: number; drv_data_8: number;
    drv_bus_9: number; drv_data_9: number;
  } {
    return {
      cpu_bus: this.cpu_bus,
      cpu_port: this.cpu_port,
      drv_port: this.drv_port,
      drv_bus_8: this.drv_bus[8] ?? 0xff,
      drv_data_8: this.drv_data[8] ?? 0xff,
      drv_bus_9: this.drv_bus[9] ?? 0xff,
      drv_data_9: this.drv_data[9] ?? 0xff,
    };
  }
}
