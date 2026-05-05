# Spec 144 — TrueDrive Mode Hygiene

**Sprint**: 112 (core sync refactor)
**Phase**: implementation
**Status**: proposed
**Depends on**: Spec 139, Spec 140, Spec 141
**Sequenced after**: 141
**Sequenced last in Sprint 112**

## Why

TrueDrive acceptance must not be satisfied by hidden shortcuts. The
runtime contains useful debug/fallback mechanisms — KERNAL traps,
synthetic IEC line releases, drive RAM `$7C` poke — that
historically rescued failing tests but mask real silicon
divergences. Sprint 111 evidence shows several "passing" runs were
in fact propped up by rescue paths; the motm bug surfaced because
no rescue applied.

Spec 144 makes every shortcut visible, mode-guarded, and reportable.
TrueDrive runs cannot accidentally rely on rescue paths; debug runs
remain available with explicit opt-in.

## Scope

**In scope**:

- Mode enum:
  ```ts
  type CompatibilityMode =
    | "truedrive-pure"     // no rescue paths, default for V2
    | "truedrive-rescue"   // rescue paths allowed (debug only)
    | "trap-fast";         // KERNAL trap mode (V1 baseline)
  ```
- Inventory of every rescue path / shortcut. As of Sprint 111:
  1. `IecBus.notifyAtnChanged` $7C poke (Spec 141 already gated).
  2. `Via6522.reevaluateCa1Level` (Spec 141 already gated).
  3. KERNAL `LOAD`/`SAVE` trap (`src/runtime/headless/traps/kernal.ts`).
  4. Drive M-W trap (synthetic memory write via trap).
  5. Drive M-E trap (synthetic memory exec via trap).
  6. `IecBus.releaseDriveClk` / `releaseDriveData` (synthetic line
     release used by Spec 072 trap-mode CLK ACK).
  7. Drive idle skip (`DriveCpu.sleeping` mode).
  8. C64 IRQ short-circuit on RTI to BASIC.
  9. VIC raster shortcut (where applicable).
  10. CIA TOD synthetic value path.
- Each shortcut gets:
  - A constant `string` identifier (e.g. `"iec.atn-poke"`,
    `"trap.kernal-load"`, `"drive.idle-skip"`).
  - A guard: enabled iff `mode` matches its allowed-list.
  - A counter on first invocation.
- Session output JSON adds:
  ```ts
  {
    mode: "truedrive-pure" | ...,
    activeHooks: ["string", ...],     // names allowed in this mode
    invokedHooks: { name: invocations },  // tally per run
    pureRun: boolean                  // true iff invokedHooks empty
  }
  ```
- Acceptance gate: TrueDrive scenarios assert
  `result.invokedHooks` is empty (or only contains explicit
  whitelist).
- Scenario library: `samples/test-manifest.json`. Pure-mode runs
  iterate `entries[].family !== "kernel-trap"` and assert
  `pureRun === true` for status=`works`. Status=`untested`
  entries report mode/hooks but don't gate.

**Out of scope**:

- Deleting useful debug tools (kept under their gated flag).
- Changing RE convenience modes (analyze_prg etc. unaffected).
- Full UI redesign.

## Implementation plan

### Step 1: `CompatibilityMode` type + registry

```ts
// src/runtime/headless/scheduler/compatibility.ts
export type CompatibilityMode = "truedrive-pure" | "truedrive-rescue" | "trap-fast";

export interface CompatibilityHook {
  id: string;
  description: string;
  allowedIn: CompatibilityMode[];
}

export const HOOKS: Readonly<Record<string, CompatibilityHook>> = {
  "iec.atn-poke-7c":         { id: "iec.atn-poke-7c", description: "Drive RAM $7C ATN-pending direct poke", allowedIn: ["truedrive-rescue", "trap-fast"] },
  "via.reevaluate-ca1":      { id: "via.reevaluate-ca1", description: "CA1 retroactive trigger on IER enable", allowedIn: ["truedrive-rescue", "trap-fast"] },
  "trap.kernal-load":        { id: "trap.kernal-load", description: "KERNAL $F50A LOAD trap", allowedIn: ["trap-fast"] },
  "trap.kernal-save":        { id: "trap.kernal-save", description: "KERNAL $F5DD SAVE trap", allowedIn: ["trap-fast"] },
  "trap.drive-mw":           { id: "trap.drive-mw", description: "M-W command trap", allowedIn: ["trap-fast"] },
  "trap.drive-me":           { id: "trap.drive-me", description: "M-E command trap", allowedIn: ["trap-fast"] },
  "iec.release-drive-clk":   { id: "iec.release-drive-clk", description: "Synthetic drive CLK release", allowedIn: ["trap-fast"] },
  "iec.release-drive-data":  { id: "iec.release-drive-data", description: "Synthetic drive DATA release", allowedIn: ["trap-fast"] },
  "drive.idle-skip":         { id: "drive.idle-skip", description: "Drive sleep mode skip-ahead", allowedIn: ["truedrive-rescue", "trap-fast"] },
};

export class CompatibilityRegistry {
  constructor(private mode: CompatibilityMode) {}
  invoked = new Map<string, number>();
  isAllowed(id: string): boolean {
    const hook = HOOKS[id]; if (!hook) return false;
    return hook.allowedIn.includes(this.mode);
  }
  invoke(id: string): boolean {
    if (!this.isAllowed(id)) return false;
    this.invoked.set(id, (this.invoked.get(id) ?? 0) + 1);
    return true;
  }
  pureRun(): boolean { return this.invoked.size === 0; }
  setMode(m: CompatibilityMode): void { this.mode = m; this.invoked.clear(); }
}
```

### Step 2: Wire the registry into kernel

Kernel exposes `compat()` accessor. All shortcut sites take the
registry and call `registry.invoke(id)`. If returns `false`, the
shortcut path is skipped (= silicon-faithful behavior).

Example call site change:
```ts
// iec-bus.ts notifyAtnChanged
const atnLow = !this.atnLine;
if (atnLow && !this.prevAtnLow && this.driveRamForAtnPoke
    && this.kernel.compat().invoke("iec.atn-poke-7c")) {
  this.driveRamForAtnPoke[0x7c] = 0x80;
}
```

### Step 3: Mode default

`IntegratedSession.start({ mode })`:
- If `mode === undefined`, default = `"truedrive-pure"` for any
  session that loaded a real ROM + real disk image.
- Trap-fast scenarios (legacy MM-LOAD harness) explicitly request
  `"trap-fast"`.

### Step 4: Session reporting

`IntegratedSession.summary()` includes:
```json
{
  "compatibility": {
    "mode": "truedrive-pure",
    "pureRun": true,
    "invokedHooks": {}
  }
}
```

If `pureRun === false` in TrueDrive scenarios, smoke test fails.

### Step 5: Documentation

`docs/headless-modes.md` — short reference enumerating each mode,
allowed hooks, expected behavior.

### Step 6: Tests

- `scripts/test-mode-hygiene.mjs` (npm task `test:mode-hygiene`):
  - TrueDrive-pure motm run → `pureRun === true`.
  - TrueDrive-rescue MM-LOAD → may invoke $7C poke + idle-skip;
    `pureRun === false` is acceptable.
  - Trap-fast MM-LOAD → invokes KERNAL trap; `pureRun === false`.
- Existing scenarios re-tagged with their expected mode.

## Acceptance

- [ ] `CompatibilityRegistry` + `HOOKS` table exist and are
      consulted at every documented shortcut site.
- [ ] Default mode = `"truedrive-pure"` for V2 sessions.
- [ ] All 9+ shortcuts inventoried in HOOKS.
- [ ] Session output reports `mode`, `invokedHooks`, `pureRun`.
- [ ] `truedrive-pure` motm scenario passes with `pureRun === true`.
- [ ] `trap-fast` MM-LOAD scenario passes (legacy V1 behavior intact).
- [ ] Existing IEC + LOAD tests green.
- [ ] `docs/headless-modes.md` exists.

## Estimated effort

2-3 days:
- 0.5d: registry + HOOKS table
- 0.5d: wire into 9+ call sites
- 0.5d: session reporting
- 0.5d: tests + docs
- 0.5-1.0d: regression cleanup

## Risks

- **R1**: A shortcut is missed in inventory. Mitigation: grep for
  `"hack"`, `"workaround"`, `"Sprint 66"`, `"trap"`, `"rescue"` in
  src tree; cross-check with FINDINGS docs.
- **R2**: Default mode flip breaks long-running scenarios. Mitigation:
  re-tag legacy scenarios with explicit mode; commit one mode per
  test file at minimum.
- **R3**: Hook registry adds tiny per-call overhead. Mitigation:
  early-bail when registry is empty / mode allows everything.

## Files

To create:
- `src/runtime/headless/scheduler/compatibility.ts`
- `scripts/test-mode-hygiene.mjs`
- `docs/headless-modes.md`

To modify:
- `src/runtime/headless/integrated-session.ts` (mode wiring + summary)
- `src/runtime/headless/iec/iec-bus.ts` (gate $7C poke)
- `src/runtime/headless/drive/via6522.ts` (gate reevaluateCa1Level)
- `src/runtime/headless/traps/kernal.ts` (gate KERNAL traps)
- `src/runtime/headless/drive/drive-cpu.ts` (gate idle-skip)
- (others as discovered during inventory)
