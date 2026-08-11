# Spec 424 — Drive + Cartridge LED behavior + Inspector UX consolidation

**Status:** DRAFT 2026-05-12
**Branch:** `vice-arch-port`
**Depends on:** 411 (VIA2 PB decode), 414 (lifecycle), 351 (live UX shell)
**Doctrine:** 1:1 VICE LED semantics + UI moves drive/cart strip into right inspector column.

## Goal

Two axes:

**A. LED behavior — runtime authority.**
- 1541 drive LED is **VIA2 PB3** (not VIA1 — current
  `v3-ws-server.ts:333` reads the wrong VIA, latent bug).
- Surface VIA2 PB3 + motor + R/W direction (CB2) + error-flash
  pattern through `session/drive_status`.
- Cartridge: surface CRT type + bank-switch + R/W activity through
  new `session/cart_status`.

**B. Inspector UX — consolidate.**
- Move Drive 8 + Drive 9 + CRT lines from "below screen" media
  strip into the right inspector column as compact rows.
- Drop the bottom `Drop .d64 / .g64 / .crt` hint bar entirely.
- LED becomes a colored circle (`##`) directly left of the device
  label, encoding state (color = function, blink = error).

## Doc anchor

- `vice-1541-arch.md §7.3` — VIA2 PB write decode (PB3 = LED)
- `vice-1541-arch.md §7.4` — LED-on conditions per 1541 ROM
  (DOS busy, error blink at $EBE7..$EC15)
- `vice-1541-arch.md §13 Phase E step 17` — LED bit decode (existing)
- `vice-c64-arch.md §10` — cartridge banks (Magic Desk / Ocean /
  EasyFlash control regs at $DE00..$DFFF)

## VICE source cite

- `src/drive/iec/via2d1541.c:via2_store_pra` — PB write decode incl.
  PB3 LED, written via `drive->led_status = (byte >> 3) & 1;`
- `src/drive/drive.c:drive_set_active_led_color` — host-side LED
  state for UI; tracks `led_active_ticks` + `led_last_change_clk`.
- `src/drive/drive.c:DRIVE_LED_DENSITY_MIN` (`= 200000`,
  ~200ms decay) — used by VICE GUI to derive LED brightness.
- `src/c64/cart/c64cart.c` + per-cart files (`magicdesk.c`,
  `ocean.c`, `easyflash.c`) — bank latch on $DE00 write.

## Audit — current TS state

Files:

- `src/runtime/headless/drive/via2-gcr-shifter-coupling.ts:122-124` —
  TODO: "LED (PB3) is observable-only at this layer; ignored.
  (Reserved for V3 disk-LED reporting hooks.)"
- `src/runtime/headless/drive/via2-gcr.ts:16` — comment:
  "PB3 LED (drive activity LED — read only — Sprint 62: ignored)"
- `src/workspace-ui/v3-ws-server.ts:325-342` — `session/drive_status`:
  - Reads VIA1 ORB & DDRB & 0x08 (= **wrong VIA**)
  - Drive 9 not surfaced (always implicit drive 8)
  - No R/W direction (CB2)
  - No error-blink detection
- `src/workspace-ui/v3-ws-server.ts` — no `session/cart_status` route.
- `ui/src/v3/components/MediaStrip.tsx` — bottom strip with eject
  buttons + drop hint. To be removed.
- `ui/src/v3/components/InspectorPanel.tsx` — Drive 8/9 sections
  with LED + motor + track. To gain compact layout + insert button +
  CRT section.
- `ui/src/v3/tabs/Live.tsx` — `<MediaStrip>` rendered below screen
  grid. To be removed; insert/eject moves into InspectorPanel.

## Producer changes (runtime + WS)

### A1. VIA2 LED bit exposure

`src/runtime/headless/drive/via2d1541.ts`:
- Track latest `pb3LedOn: boolean` from PB write decoder (per
  spec 411 step 17, currently dropped per via2-gcr-shifter-coupling
  line 122-124).
- Expose `getLedState(): boolean`.
- Track timestamp of last write to PB3 (cycle count) for
  blink-pattern detection.

### A2. Drive R/W direction

`src/runtime/headless/drive/via2d1541.ts`:
- Track CB2 = R/W. Expose `getReadWriteMode(): "read" | "write"`.

### A3. Error-flash detection

The 1541 DOS error pattern at ROM `$EBE7..$EC15` toggles PB3 with
~0.5s period. Detect by:
- Sample PB3 transitions in a sliding window (last ~2 seconds at
  1MHz drive clock = 2M cycles).
- Count edges; ≥3 transitions in window = blinking.
- Expose `getLedFlashing(): boolean`.

`src/runtime/headless/drive/led-monitor.ts` (new file):
- Class `DriveLedMonitor` consumed by `via2d1541` PB3 writes.
- Holds ring buffer of last N edge timestamps.
- `isFlashing(currentClock): boolean` — true if edges/window > 2.

### A4. WS endpoint fix + extend

`src/workspace-ui/v3-ws-server.ts`:

Replace `session/drive_status` body:
```ts
const via2 = drv.bus.via2;
const ledOn = via2.getLedState();        // PB3 latch
const motorOn = via2.getMotorState();    // PB2 latch (already in gcrShifter)
const rwMode = via2.getReadWriteMode();  // CB2
const ledFlashing = drv.ledMonitor.isFlashing(s.cycle);
return {
  device: 8,
  ledOn,
  ledFlashing,
  motorOn,
  rwMode,                  // "read" | "write"
  halfTrack,
  track: Math.floor(halfTrack / 2) + 1,
  sector: drv.gcrShifter.currentSector ?? 0,
  drivePc: drv.cpu.pc,
};
```

Add `session/drive9_status` with identical shape for the second
drive when present (return `null` when no second drive).

### A5. Cartridge status endpoint (new)

Add `session/cart_status`:
```ts
this.on("session/cart_status", ({ session_id }) => {
  const s = getIntegratedSession(session_id);
  const cart = s.cartridge;
  if (!cart) return null;
  return {
    type: cart.kind,        // "generic-8k" | "ocean" | "magic-desk" | "easyflash" | ...
    bank: cart.currentBank, // 0..N
    activity: cart.lastAccessKind,  // "read" | "write" | "idle"
    lastAccessCycle: cart.lastAccessCycle,
  };
});
```

Cart activity = green/red derives same way as drive LED:
- "read" if last $8000..$9FFF / $A000..$BFFF / $E000..$FFFF read
  within last ~200k cycles
- "write" if last $DE00..$DFFF write (= bank latch, EasyFlash
  command) within same window
- "idle" otherwise

Implementation: thin `CartActivityMonitor` similar to LED monitor,
fed from cartridge bank-switch path.

## UI changes

### B1. InspectorPanel layout

`ui/src/v3/components/InspectorPanel.tsx` — replace existing
Drive 8 / Drive 9 sections with compact rows + insert action:

```
DRIVE 8  ##  [insert ▾]
T/S 18.0/01      $EC18

DRIVE 9  ##  [insert ▾]      (only if drive9 enabled)
T/S 01.0/00      $EC18

CRT      ##  [insert ▾]      (only when cartridge slot exists)
generic-16k     bank: 00
```

Components:
- `##` = colored dot (CSS span, 12px). Color from `ledColor()`
  helper:

```ts
function ledColor(s: DriveStatus): string {
  if (s.ledFlashing) return "blink";  // CSS animation: red→yellow alternating
  if (!s.motorOn && !s.ledOn) return "#444";    // grey  off
  if (s.ledOn && s.rwMode === "write") return "#e04040";  // red    write
  if (s.ledOn && s.rwMode === "read")  return "#40d060";  // green  read
  if (s.motorOn) return "#e0c040";              // yellow motor on, no I/O
  return "#444";
}

function cartColor(c: CartStatus): string {
  if (c.activity === "write") return "#e04040";
  if (c.activity === "read")  return "#40d060";
  return "#444";
}
```

- `[insert ▾]` = button opening media picker dropdown
  (re-uses existing `media/recent` list; `.d64`/`.g64` for drive,
  `.crt` for cart). When media mounted: button text becomes
  filename + click = eject confirm.

- `T/S XX.X/YY` format:
  - `XX.X` = `track.halfTrackBit` (e.g. `18.0`, `35.5`)
  - `YY` = current sector zero-padded to 2 digits

- `$PC` = drive CPU PC, hex 4 digits, monospace.

- Cartridge `$TYPE bank: NN`:
  - `$TYPE` = cart kind enum (`generic-8k`, `ocean`, etc.)
  - `bank: NN` = current bank, 2 digits decimal.

CSS for blink:
```css
@keyframes wb-led-blink {
  0%, 49%   { background: #e04040; }
  50%, 100% { background: #e0c040; }
}
.wb-led.blink { animation: wb-led-blink 0.5s steps(1) infinite; }
```

### B2. Remove bottom MediaStrip

`ui/src/v3/tabs/Live.tsx`:
- Remove `<MediaStrip>` import + render below screen.
- Remove drag/drop hint container (`Drop .d64 / .g64 / .crt`).
- Drag-drop zone moves to per-row insert button (deferred follow-up
  if not trivial — out of scope; kept as TODO).

### B3. Polling

Live tab `useEffect`:
- `session/drive_status` 250ms (existing)
- `session/drive9_status` 250ms (new — only if drive9 enabled flag
  in session config)
- `session/cart_status` 250ms (new — only if cart slot)

Combine into single `session/inspector_status` if perf becomes
issue (out of scope this spec).

## Color matrix (canonical)

| Subject | State | Color |
|---|---|---|
| Drive | motor off + LED off | grey `#444` |
| Drive | motor on, no I/O (idle DOS) | yellow `#e0c040` |
| Drive | LED on + reading (CB2=1) | green `#40d060` |
| Drive | LED on + writing (CB2=0) | red `#e04040` |
| Drive | DOS error blink (PB3 toggle ≥3 edges/2s) | red↔yellow 0.5s |
| Cart | no access in last 200k cycles | grey `#444` |
| Cart | last access = read | green `#40d060` |
| Cart | last access = write (bank/EasyFlash cmd) | red `#e04040` |

Per user direction 2026-05-12.

## TS extras to DELETE

- `MediaStrip.tsx` (entire file) once InspectorPanel insert button
  is wired.
- `wb-drop-hint` CSS rule.
- v3-ws-server.ts:331-333 VIA1-based ledOn (= bug).

## NTSC stub

LED + cart activity are clock-independent at chip level. No stub.

## Acceptance

- Build clean.
- `smoke-cpu-fidelity` 31/31 + `smoke-cia-fidelity` 22/22 unchanged.
- New `scripts/smoke-424-drive-led.mjs`:
  1. Cold reset, no disk → drive LED off (grey), motor off after
     spin-down.
  2. Mount D64, `LOAD"$",8` → LED on green during dir read, off
     after.
  3. Mount blank D64, `OPEN 15,8,15,"N0:T,01"<Enter>` (format) →
     LED on red during write (skipped if write path not
     implemented; assert pending).
  4. Mount G64 with bad sector header → DOS error blink (≥3 PB3
     edges within 2M drive cycles).
- New `scripts/smoke-424-cart-status.mjs`:
  1. No cart → endpoint returns null.
  2. Mount generic-8k → activity = idle, bank 0.
  3. CPU read at $8000 → activity = read for ≥1 poll cycle.
  4. EasyFlash $DE00 write 1 → activity = write, bank changes.
- Manual UI verify: open Live tab, mount Scramble Infinity D64 →
  LED green during load, motor yellow when idle, eject button
  visible inline. Bottom strip absent.
- MM s1 + Scramble Infinity titles still render.

## Open Questions

- **OQ-424-1**: RESOLVED 2026-05-12 — user direction. 4-color
  simplified (grey/yellow/green/red + blink) per user spec, not
  1:1 VICE 6-color. Acceptable trade for clarity.

- **OQ-424-2**: RESOLVED 2026-05-12 — DEFERRED. IntegratedSession
  does not currently expose a cartridge instance (only older
  `session-manager.ts` has cart plumbing via memory-bus). Cart
  status endpoint returns `null` v1; UI hides the CRT row.
  Full cart wiring + activity monitor deferred to follow-up
  spec 425 (= V3 cartridge support).

- **OQ-424-3**: RESOLVED 2026-05-12 — DEFERRED. `IntegratedSession`
  has single `drive: DriveCpu` (audit
  `integrated-session.ts:248`). Multi-drive plumbing requires
  `drives[]` tuple expansion (= post-arch-port scope). Drive 9
  row hidden in UI until then. `session/drive9_status` not
  exposed.

- **OQ-424-4**: RESOLVED 2026-05-12 — synthetic test PRG approach.
  Smoke 424 writes a small PRG that does
  `LDA #$08 / STA $1C00 / LDA #$00 / STA $1C00` to flip PB3
  directly via VIA2 PRB writes. Bypasses GCR write path entirely.
  Format-test deferred to write-support spec.

## Files touched

- `src/runtime/headless/drive/via2d1541.ts` (LED + R/W exposers)
- `src/runtime/headless/drive/led-monitor.ts` (new)
- `src/runtime/headless/drive/via2-gcr-shifter-coupling.ts`
  (resolve TODO line 122-124)
- `src/runtime/headless/cartridges/cart-activity-monitor.ts` (new)
- `src/workspace-ui/v3-ws-server.ts` (`session/drive_status` fix +
  `session/drive9_status` + `session/cart_status`)
- `ui/src/v3/components/InspectorPanel.tsx` (compact rows + insert
  buttons + LED color helper + CSS blink)
- `ui/src/v3/tabs/Live.tsx` (remove MediaStrip + drop hint)
- `ui/src/v3/components/MediaStrip.tsx` (DELETE)
- `ui/src/v3/style.css` (`.wb-led` colors + blink keyframe)
- 2 new smokes
- `specs/424-drive-cart-led-and-inspector-ux.md` (this)

## Next spec

None mandatory. Post-arch-port follow-ups:
- Drag-drop into InspectorPanel insert buttons
- Multi-drive (drive 9, 10, 11) full plumbing
- LED brightness decay (VICE-style 200ms density)
