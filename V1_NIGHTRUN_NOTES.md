# V1 Nightrun Notes

Live notebook während V1-Marathon. User reviewed morgen.

## Status

- Sprint 105 ✓ DONE (M2.5 input + M2.6 SID)
- Sprint 106 = Visual runtime (Specs 117-121) — pending
- Sprint 107 = LLM debug (Specs 122-126) — pending
- Sprint 108 = Cart (Specs 127-129) — pending
- Sprint 109 = SID polish (Specs 130-132) — pending
- Sprint 110 = Performance + ops (Specs 133-136) — pending

V1-fertig wenn Sprint 110 closed.

## Open questions for user

(noch keine)

## Bugs found

### Bug 43 — MoTM (Murder on the Mississippi) hangs at $43CD with display off after loader

Symptom:
- LOAD"*",8,1 of file `murder` (1-block PRG) completes ($90=$40 EOI seen at cyc 6.2M)
- Warm-start vector $0302/$0303 = $02DC after load (loader hijacked it)
- After indirect jump, PC reaches $43CD then stays there indefinitely (200M+ cycles)
- `$D011 = $00` → DEN bit clear, display OFF
- `$D018 = $14` (default), `$D016 = $08` (default)
- `$D021 = $06` (blue bg)
- Screenshot: solid grey rectangle (display blanked)

Disk file list:
- `murder` (1 blk) — small loader
- `ab`, `dad`, `baby`, `chr1..4`, `romance`, `ingrid` (chapter loaders)

Likely root cause options:
1. Loader at $43CD spinning on something (IRQ, raster line, IEC bus state, input)
2. Custom Stage-2 loader that needs Spec 105 v2 RDY/badline tie-in to advance
3. Custom IRQ/NMI vectors not getting fired correctly
4. Drive-side CMD or M-W command unhandled

Reproduction:
```
node -e 'import("./dist/runtime/headless/integrated-session-manager.js").then(async (m) => {
  const { session } = m.startIntegratedSession({
    diskPath: "samples/motm.g64", mode: "true-drive"
  });
  session.resetCold("pal-default");
  session.runFor(800_000);
  session.typeText("LOAD\"*\",8,1\r", 80_000, 80_000);
  const ram = session.c64Bus.ram;
  for (let i = 0; i < 300_000_000; i++) {
    session.runFor(1);
    if ((ram[0x90] & 0x40) !== 0) { for (let j = 0; j < 30_000_000; j++) session.runFor(1); break; }
  }
  for (let i = 0; i < 100_000_000; i++) session.runFor(1);
  console.log("PC=$" + session.c64Cpu.pc.toString(16),
    "$D011=$" + session.vic.regs[0x11].toString(16));
});'
```

Next investigation step: instruction-step trace from $43CD to identify
what loop is spinning. Likely needs Spec 105 v2 (per-pixel-y dispatch +
RDY badline tie-in) before MoTM stage 2 can run.

Status: deferred for V2 planning. Not a V1 blocker (V1 acceptance ladder
is MM only; MoTM was always a stretch goal).

## Decisions made autonomously

(populate while running)

## Skipped / deferred items

(populate while running)
