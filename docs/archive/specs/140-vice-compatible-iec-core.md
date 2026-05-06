# Spec 140 — VICE-Compatible IEC Core

**Sprint**: 112 (core sync refactor)
**Phase**: implementation (the first BIG behavior change)
**Status**: proposed
**Depends on**: Spec 139 (architecture), Spec 137 (arc42 catalog), Spec 138 probe result
**Sequenced after**: 139
**Sequenced before**: 141, 144

## Why

VICE's IEC behavior is observable through a small set of cached
ports (`cpu_bus`, `cpu_port`, `drv_bus[]`, `drv_data[]`, `drv_port`)
and an explicit drive-flush at every C64-side IEC access. Our
headless computes IEC line state live and only installs the C64
flush hook outside lockstep mode.

The arc42 ranks ADR-1 (push-flush) and ADR-2 (cache ports) as the
two highest-impact divergences. Spec 138 is the probe that tells us
whether push-flush alone closes motm or whether cache-and-flush
together are needed. Spec 140 is the **production** implementation.

## Scope

**In scope** (production behavior change in TrueDrive mode):

- Authoritative IEC state structure equivalent to VICE:
  ```ts
  interface IecBusCore {
    cpu_bus: number;          // = (((data << 2) & 0xC0) | ((data << 1) & 0x10))
    cpu_port: number;         // cpu_bus AND-folded with drv_bus[*]
    drv_bus: Uint8Array;      // [16] precomposed contribution per unit
                              //   slots 0-3 unused (always 0xff)
                              //   slots 4-7 IEC device / printer (always 0xff in V2)
                              //   slot 8   primary drive (modelled)
                              //   slot 9   secondary drive (shape preserved, runtime later)
                              //   slots 10-15 unused (always 0xff)
    drv_data: Uint8Array;     // [16] raw drive PB output (inverted)
    drv_port: number;         // composed view drive sees
  }
  ```
- Two recompute entry points (matching VICE):
  - `iec_update_cpu_bus(data)` — called on c64 PA write
  - `iec_update_ports()` — called whenever `cpu_bus` or any
    `drv_bus[]` changes
- C64 flush contract: every access to `$DD00` invokes
  `kernel.flushDriveTo(maincpuClk)` BEFORE the bus mutates or
  returns a value.
- Drive flush contract on the drive side: drive `$1800` reads return
  `((PRB & 0x1A) | drv_port) ^ 0x85`, where `drv_port` was set by
  the most recent `iec_update_ports`.
- ATN edge propagation:
  - Detected only on $DD00 store, not on read.
  - Routes through kernel-stamped event (Spec 141 territory; this
    spec uses a temporary direct call, replaced by 141).
- Trace output: every recompute (cpu_bus / cpu_port / drv_port)
  produces a `bus_access` event (Spec 142 channel).
- Mode flag: `IecMode = "vice-cache" | "live"`. Default in TrueDrive
  mode = `"vice-cache"`. Old `"live"` mode preserved for
  compatibility tests.

**Out of scope**:

- VIA interrupt-delay refactor (Spec 141)
- Removing $7C poke (Spec 144)
- Multi-drive beyond drive 8 + 9 shape preservation
- VICE source code modification or copying

## Implementation plan

### Step 1: Add `IecBusCore` cache fields

In `iec-bus.ts`, add private fields for the 5 cache values. Keep the
existing released-flag fields for `"live"` mode compatibility.

### Step 2: Implement VICE recompute formulas

```ts
private iecUpdateCpuBus(paLatch: number, ddrMask: number): void {
  // Effective output: bit AND mask (input bits float = 0)
  const data = paLatch & ddrMask;
  this.cpu_bus = (((data << 2) & 0xC0) | ((data << 1) & 0x10));
}

private iecUpdatePorts(): void {
  let cp = this.cpu_bus;
  for (let unit = 4; unit < 16; unit++) cp &= this.drv_bus[unit];
  this.cpu_port = cp & 0xff;
  this.drv_port = (((cp >> 4) & 0x4) | (cp >> 7) | ((this.cpu_bus << 3) & 0x80));
}
```

### Step 3: Wire kernel flush (HYBRID — per Q4 decision)

Default mode is **hybrid**: lockstep per-cycle tick STAYS, push-flush
at IEC access points is layered on top.

`MachineKernel.onC64BusWrite($DD00 PA)` and
`MachineKernel.onC64BusRead($DD00 PA)` call
`kernel.flushDriveTo(c64Clock)` first, then route to IecBus methods.

`flushDriveTo(c64Clock)` calls `drive.executeToClock(c64Clock)`. In
hybrid mode the call is a no-op when the drive is already current
(lockstep already ticked it this cycle); in push-flush-only mode
(diagnostic ablation) it does the real catch-up.

### Step 4: Update read/write flows

**C64 store $DD00**:
```
kernel.onC64BusWrite($DD00, value, ctx)
  → kernel.flushDriveTo(c64Clock)
  → cia2.writePA(value)
    → iecBus.iecUpdateCpuBus(value, ddr)
    → ATN edge detection → driveVia1.pulseCa1(...)
    → recompute drv_bus[8] (XOR ATN-AND-gate formula)
    → iecUpdatePorts()
    → emit bus_access trace event
```

**C64 read $DD00**:
```
kernel.onC64BusRead($DD00, ctx)
  → kernel.flushDriveTo(c64Clock)
  → cia2.readPA()
    → return iecBus.cpu_port (CACHED)
    → emit bus_access trace event
```

**Drive store $1800**:
```
driveVia1.write(VIA_ORB, byte)
  → iecBus.driveStorePb(byte, ddr, deviceId=8)
    → drv_data[8] = ~byte
    → recompute drv_bus[8]
    → iecUpdatePorts()
    → emit bus_access trace event
```

**Drive read $1800**:
```
driveVia1.read(VIA_ORB)
  → byte = ((PRB & 0x1A) | iecBus.drv_port) ^ 0x85 | (deviceId<<5)
  → emit bus_access trace event
```

### Step 5: ATN-AND-gate XOR formula

```ts
const atnGate = ((drv_data << 6) & ((~drv_data ^ cpu_bus) << 3) & 0x80);
const drv_bus_8 = ((drv_data << 3) & 0x40) | atnGate;
```

This is the bit-exact VICE formula from `iecbus.c:280-285`.

### Step 6: Mode selector + reporting

`MachineKernel.config({ iecMode: "vice-cache" | "live" })`.
Default for TrueDrive: `"vice-cache"`.

Session output JSON includes `iecMode` field.

### Step 7: Tests

- IEC matrix existing tests run twice: once in `"live"` mode (legacy),
  once in `"vice-cache"` mode (new). Both green.
- New test: VICE cpu_port formula correctness — feed the same byte
  sequence VICE binmon produces, assert byte-equal cpu_port at each
  step.
- MM-LOAD regression: green in both modes.
- motm receive: byte-equal first 3 cmd bytes vs VICE binmon trace
  (provided by Spec 143 capture).

## Acceptance

- [ ] `IecBusCore` cache fields present and updated only at the two
      recompute entry points.
- [ ] `MachineKernel.flushDriveTo` exists and is called at every
      $DD00 read/write.
- [ ] Mode `"vice-cache"` is default for TrueDrive sessions.
- [ ] Existing IEC tests green in both modes.
- [ ] Existing MM-LOAD regression green.
- [ ] motm Spec 143 diff report shows first 3 cmd bytes match VICE
      byte-exact.
- [ ] Session output reports `iecMode` and `kernelMode`.
- [ ] No regression in trap-mode tests.
- [ ] No code copied from VICE.

## Estimated effort

5-7 days (depending on probe 138 result):

- 1.0d: cache fields + recompute formulas
- 1.0d: MachineKernel flush wiring
- 1.0d: ATN-AND-gate XOR + drive store/read flows
- 1.0d: tests (existing + new)
- 1.0d: mode selector + session reporting
- 1.0-3.0d: motm validation, debugging, edge cases

## Risks

- **R1**: If probe 138 shows push-flush alone fixes motm, cache may
  be unnecessary. Decision point: still implement cache for
  maintainability + Spec 144 hygiene goal? Recommendation: yes,
  cache is the explicit VICE contract; live computation is harder
  to reason about.
- **R2**: ATN-AND-gate XOR formula has known sign-convention pitfalls
  (Sprint 75 Maniac Mansion experience). Mitigation: cross-check
  with VICE binmon dump at known states.
- **R3**: Multi-drive shape — `drv_bus[]` indexed 4-15 (VICE) but we
  only model drive 8/9. **Q5 decision**: full `drv_bus[16]` array,
  unused slots (4-7, 10-15) prefilled `0xff` (= released,
  transparent in wired-AND). Bit-exact VICE formula preserved; 16
  bytes memory irrelevant; future-ready for IEC printer (1525) /
  device slot if ever added.
- **R4**: `cpu_port` formula uses 4..NUM_DISK_UNITS+8 range from
  VICE; we may have different unit layout. Mitigation: document
  exactly what each slot means in our model.

## Files

To modify:
- `src/runtime/headless/iec/iec-bus.ts` (add cache mode)
- `src/runtime/headless/integrated-session.ts` (kernel wiring)
- `src/runtime/headless/scheduler/cycle-lockstep-scheduler.ts`
  (move flush logic into kernel)
- `src/runtime/headless/drive/via6522.ts` (drive store/read of $1800)
- `src/runtime/headless/peripherals/cia2*.ts` (route through kernel)

To create:
- `src/runtime/headless/scheduler/machine-kernel.ts` (or wherever
  Spec 139 lands the kernel impl)

To delete:
- Eventually: the live-mode code path. Kept until Spec 144.
