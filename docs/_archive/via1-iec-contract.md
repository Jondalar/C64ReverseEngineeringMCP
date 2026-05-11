# VIA1 IEC Contract (Spec 110 / M3.2)

## Pin assignment (1541 service manual)

| PB bit | Direction | Signal     | Polarity                         |
|--------|-----------|------------|----------------------------------|
| PB0    | input     | DATA_IN    | line LOW → bit reads 1 (inverter)|
| PB1    | output    | DATA_OUT   | bit=1 → line LOW (open-collector inverter) |
| PB2    | input     | CLK_IN     | line LOW → bit reads 1            |
| PB3    | output    | CLK_OUT    | bit=1 → line LOW                 |
| PB4    | output    | ATN_ACK    | bit=1 → ack ATN (auto-pull DATA disabled) |
| PB5    | input     | DEV_ID J1  | trace cut → bit=1, +1 to base 8  |
| PB6    | input     | DEV_ID J2  | trace cut → bit=1, +2 to base 8  |
| PB7    | input     | ATN_IN     | line LOW → bit reads 1            |

CA1 = ATN edge detector. Standard configuration: PCR bit 0 = 0
(negative-edge), so a high→low ATN transition asserts CA1 IFR. Sprint
66 deviation noted in `via6522.ts`: model fires CA1 IFR on either
edge so the drive ROM picks up ATN-LOW even when boot-order races
masked the original edge — pinned by the M3.2b test.

## Polarity (M3.2a)

`PB1=1, DDR=output` pulls DATA low (line=false). `PB1=0` releases
(line=true). Same for PB3/CLK. Wired-AND: line is asserted (LOW) if
*any* driver pulls; only released (HIGH) when *all* drivers release.

## ATN edge IRQ (M3.2b)

Sequence:
1. Drive configures `PCR=$00` (negative-edge CA1) and `IER=$82`
   (enable + CA1 source).
2. C64 writes CIA2 PA with ATN bit set + DDR=output → `IecBus.atnLine`
   transitions high→low.
3. `bus.notifyAtnChanged()` calls `via.pulseCa1(false)` → IFR_CA1
   set within the same model cycle.
4. Drive `via.irqAsserted()` returns `true` until IFR cleared by
   reading `$1801` (IRA-with-handshake) or writing `$8002` to IFR.

Either-edge fire: rising edge with negative-polarity also sets IFR
in the current model. Real hardware would not. Pinned in fixture so
that change to silicon-accurate behavior surfaces immediately.

## Device ID jumper (M3.2c)

`IecBus.buildDrivePbInputBits(deviceId)` packs PB5/PB6 from
`offset = deviceId - 8`:

| device | J1 cut (PB5) | J2 cut (PB6) | jumper bits |
|--------|--------------|--------------|-------------|
| 8      | no           | no           | 0           |
| 9      | yes          | no           | $20         |
| 10     | no           | yes          | $40         |
| 11     | yes          | yes          | $60         |

Note: this matches Sprint 96 / Bug 39's reversed-polarity fix. Default
`deviceId` is 8 in `DriveCpuOptions`.

## PB write propagation (M3.2d)

VIA1 PB writes propagate to the IEC bus synchronously: the
`onOutputChanged` callback installed by `makeBusVia1Pb` invokes
`bus.setDriveOutput(orValue, ddrMask)` immediately, so the bus's
`dataLine` / `clkLine` getters reflect the new state on the very next
read with no cycle delay.

DDR=input (regardless of OR latch) releases the line — the open-
collector transistor is undriven.

## Files

- `src/runtime/headless/drive/via1-iec.ts` — pin constants + bus-coupled
  backends.
- `src/runtime/headless/drive/via1-iec-tests.ts` — Spec 110 fixture suite.
- `src/runtime/headless/iec/iec-bus.ts` — bus state model + ATN→CA1 wiring.
- `src/runtime/headless/drive/via6522.ts` — `pulseCa1`,
  `reevaluateCa1Level`, IFR/IER mechanics.

## Smoke

`npm run smoke:via1-iec` — 24/24 pass post-Spec 110.
