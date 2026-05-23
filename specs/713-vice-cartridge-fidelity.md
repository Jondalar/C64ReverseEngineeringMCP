# Spec 713 - VICE Cartridge Fidelity: CRT Mapping, Banking and Writable Hardware

**Status:** IN PROGRESS (2026-05-24 CEST) — EasyFlash writable-state surface DONE (getData/loadData on the FLASH040 chip + getWritableImage/setWritableImage/persistsWritableState on the mapper), consumed by Spec 714.5 persistence (probe:714-5 8/8). KNOWN GAP: EasyFlash $DF00 256-byte cart RAM not modeled. GMOD2/GMOD3 (EEPROM/SPI) + MegaByter writable ports deferred (no test corpus). Banking/CRT-mapping fidelity for the existing mounted families is already exercised by the runtime proof gate.  
**Depends on:** Spec 705 native checkpoint/dump foundation; Spec 709 media ingress and UI mount/eject completion  
**Blocks:** Trustworthy CRT execution, CRT-based inspect evidence, cartridge rewind/replay and code-overlay work  
**Authority:** VICE C source is the behavioral ground truth.

## 1. Purpose

Implement and verify cartridge behavior as a VICE-shaped runtime subsystem, not as enough mapping to show the first bank.

This spec covers:

- EasyFlash
- GMOD2 and GMOD3
- Ocean
- Normal 8K and Normal 16K CRT cartridges
- Magic Desk and Magic Desk 16
- Protovision MegaByter

Ultimax behavior is included wherever it is part of a listed cartridge mode or the generic CRT memory contract.

Spec 709 owns ingress, UI mounting and reset policy. Spec 713 owns correctness after a cartridge is attached: memory mapping, IO1/IO2 registers, bank switching, cartridge lines, writable hardware and continuation state.

## 2. Trigger And Known Red State

Observed on an EasyFlash CRT:

- Bank 0 reaches visible startup content.
- Visible text/image data is already corrupt.
- Banking through `$DE00` does not work as the cartridge expects.

A first code-to-VICE reading already identifies concrete red candidates:

1. The current TypeScript mappers commonly react only to exact addresses such as `$DE00` or `$DE02`. VICE cartridge IO devices are installed across the IO1 page and decode register selection from address bits or ignore lower address bits as the hardware requires. EasyFlash and MegaByter decode with `addr & 2`; Ocean and Magic Desk accept mirrored IO1 writes.
2. EasyFlash uses a hand-written mode model and has no verified VICE-equivalent IO2 RAM behavior. VICE masks/control-decodes the register and exposes RAM at IO2.
3. Magic Desk does not visibly implement VICE's bit-7 disable and dynamic `GAME`/`EXROM` line switching, and its bank mask must be derived from the image configuration.
4. Ocean must derive its banking/mapping behavior from image size/profile; a fixed bank mask is insufficient.
5. GMOD2 and GMOD3 are explicitly described in the current TS source as simplified implementations. GMOD2 is missing full mode/EEPROM behavior; GMOD3 banking is not VICE-shaped if implemented as a `$DE02` high-bank register rather than IO1 address-bit selection.
6. Existing cartridge fidelity tests exercise stub cartridges rather than the active mapper implementations. A green current smoke is therefore not proof of CRT fidelity.

These are investigation starting points and mandatory gates. They are not permission for cartridge-specific symptom patches.

## 3. Non-Negotiable Doctrine

1. **VICE source first.** For every listed cartridge family, read the owning VICE modules and supporting shared machinery before editing runtime behavior.
2. **No partial hardware models.** If the VICE source models bank lines, mode registers, flash, EEPROM, SPI, IO RAM, reset or snapshots for a supported mapper, the TS implementation must model it as well.
3. **No one-ROM patches.** A fix that makes one EasyFlash image display correctly without establishing VICE-equivalent register/memory semantics is rejected.
4. **No legacy authority.** Legacy mapper behavior may be used to locate regressions, never as the behavioral target.
5. **Differential proof required.** Mapping and register behavior must be proved against VICE or a VICE-derived reference gate, not only against hand-written TS expectations.
6. **Protect existing emulator correctness.** VIC-II fidelity, KERNAL load/save, drive execution, SID and native checkpoint gates must remain green. This spec must not introduce unrelated drive or rendering changes.
7. **Unsupported is explicit.** If a declared cartridge type is not fully ported yet, attachment must reject it clearly rather than silently selecting a reduced mapper.

## 4. Required RFL Ownership Map

Before implementation, produce an internal source-to-port matrix covering the following VICE authorities and the current TS owning surfaces.

| Area | VICE source authority | Required verification |
| --- | --- | --- |
| CRT parsing and cartridge dispatch | `src/crt.c`, `src/c64/c64cart.c`, `src/c64/c64cartmem.c`, `src/c64/cart/c64carthooks.c`, `src/export.h` | CRT hardware type routing, CHIP banks/windows, attach/reset/detach and line propagation |
| Generic Normal 8K/16K and Ultimax baseline | `src/c64/cart/c64-generic.c`, `src/c64/cart/c64-generic.h` | ROML/ROMH mapping, `GAME`/`EXROM`, generic CRT profiles |
| EasyFlash | `src/c64/cart/easyflash.c` and its flash support | IO1 mirrored register decode, mode matrix, jumper state, IO2 RAM, flash semantics, reset/snapshot |
| GMOD2 | `src/c64/cart/gmod2.c` and its flash/EEPROM support | banks, cartridge modes, EEPROM lines, flash access, reset/snapshot |
| GMOD3 | `src/c64/cart/gmod3.c` and its SPI flash support | IO1-address bank selection, mode/control bits, SPI flash, reset/snapshot |
| Ocean | `src/c64/cart/ocean.c` | bank-mask/profile by cartridge size, ROML/ROMH behavior, mirrored IO1 writes |
| Magic Desk | `src/c64/cart/magicdesk.c` | bank mask, bit-7 disable, dynamic cartridge lines, IO1 writes |
| Magic Desk 16 | `src/c64/cart/magicdesk16.c` | 16K mapping, dynamic cartridge lines and disable behavior |
| Protovision MegaByter | `src/c64/cart/megabyter.c` and its flash support | IO1 mirrored bank/control registers, mode matrix, flash, reset/snapshot |

Supporting device files used by these modules, such as flash, EEPROM or SPI implementations, must be included in the matrix when referenced by the owning VICE cart module.

Current TypeScript surfaces to inventory first:

- `src/runtime/headless/cartridge.ts`
- the memory-bus / PLA route that dispatches `$8000-$BFFF`, `$DE00-$DFFF` and cartridge line changes
- checkpoint/media state used for attached or writable cartridge continuation
- `src/runtime/headless/c64/cart-fidelity-tests.ts`
- `scripts/smoke-cart-fidelity.mjs`

## 5. Target Architecture

The active runtime must have one authoritative cartridge path:

1. CRT parser creates a faithful cartridge image representation with hardware type, lines and CHIP windows.
2. Cartridge registry selects the correct VICE-shaped mapper. Hardware types for all declared supported families must map correctly, including GMOD2/GMOD3.
3. Each listed mapper owns its VICE-equivalent mutable state: registers, bank selectors, flash/EEPROM/SPI/RAM state, reset state and snapshot fields.
4. The memory bus routes ROML, ROMH, IO1 and IO2 accesses to the active cartridge with VICE-equivalent mirror/address decoding.
5. `GAME` and `EXROM` changes caused by cartridge register writes immediately refresh the active PLA/memory-map state.
6. Native checkpoint/dump captures the cartridge continuation state required to reproduce execution. Writable cartridge media policy must remain consistent with the active media/snapshot specification.

The current single-file mapper implementation may be split into per-mapper modules to reflect VICE ownership and keep the RFL mapping auditable. Shared parsing and dispatch glue should remain centralized.

## 6. Required Implementation Order

### 713.0 - RFL Matrix And Red Proofs

- Read and map every VICE authority listed in section 4.
- Identify current TS gaps without changing behavior.
- Add failing tests that prove the present EasyFlash banking/mirror failure and at least one missing-behavior failure for each mapper currently represented as simplified or incomplete.

### 713.1 - Shared CRT And Cartridge Bus Contract

- Correct CRT hardware-type routing and image representation.
- Establish IO1/IO2 page dispatch, mirrored-address semantics and immediate cartridge-line propagation.
- Establish test helpers that run the same operation vectors against VICE-derived expectations and the TS runtime.

### 713.2 - Generic Normal 8K/16K Baseline

- Port/verify generic ROML/ROMH and line behavior.
- Include Ultimax mapping only where required by generic profiles or listed cartridge modes.

### 713.3 - EasyFlash Full Fidelity

- Port VICE register decode, including mirrored IO1 selection and mode/control masks.
- Port mode/line matrix, jumper behavior where applicable, IO2 RAM and flash behavior required by VICE.
- Verify the reported real EasyFlash CRT beyond booting bank 0: program-driven bank changes and stable visual/data behavior.

### 713.4 - Ocean And Magic Desk Families

- Port Ocean profile/bank masking and mapped windows.
- Port Magic Desk and Magic Desk 16 bank, disable and `GAME`/`EXROM` behavior.

### 713.5 - Protovision MegaByter

- Port bank/control IO1 decode, mode selection and flash/state behavior.

### 713.6 - GMOD2 And GMOD3

- Replace simplified TS models with full VICE-shaped behavior.
- GMOD2: mode switching, flash and EEPROM signal/state.
- GMOD3: VICE IO1-address bank selection, modes and SPI flash behavior.

### 713.7 - Integration And Continuation

- Wire mapper snapshot/restore/dump state into native checkpoint policy.
- Verify detach/eject/reset/remount behavior through the active media ingress path.
- Close UI-visible CRT execution gates only after mapper differential tests pass.

## 7. Mandatory Gates

### 7.1 Differential Mapper Fixtures

Provide deterministic fixture cartridges for each supported family. Bank contents must use distinct byte patterns so incorrect windows, aliases or masks are unambiguous.

For each family, prove against VICE-derived expectations:

- reset/power-on mapped bytes at `$8000`, `$A000`, `$E000` as applicable;
- `GAME`/`EXROM` line state and resulting PLA-visible mapping;
- every bank/mode write sequence relevant to the hardware;
- IO1 mirror behavior across multiple addresses, not only `$DE00`;
- IO2 behavior where present;
- detach/reattach and reset behavior.

### 7.2 EasyFlash Incident Gate

Use the real EasyFlash sample already available in the repository as an incident fixture:

- mount through the active runtime;
- cold-boot through the same path used by the UI;
- verify program-driven banking occurs and produces VICE-equivalent mapped bytes/state;
- verify visible corruption is gone using deterministic frame/data evidence, not visual inspection alone.

Passing only the cartridge's initial bank-zero display is explicitly insufficient.

### 7.3 Writable Hardware Gates

Where VICE models writable cartridge storage or auxiliary state, prove:

- write/read behavior;
- reset/power-cycle behavior;
- native checkpoint restore behavior;
- dump/undump media policy for dirty cartridge state.

No flash, EEPROM or SPI behavior may remain silently absent on a mapper declared supported by this spec.

### 7.4 Regression Gates

At completion, the implementation must pass:

- `npm run build:mcp`
- existing PLA/memory fidelity gates
- a new real-mapper cartridge differential gate, not stub-only tests
- native checkpoint/dump gates affected by cartridge state
- existing KERNAL load/save, VICE1541 and SID gates
- a VIC/image evidence gate confirming the EasyFlash incident fixture remains visually/data correct

## 8. Completion Criteria

Spec 713 is complete only when:

1. All listed cartridge families use fully ported or fully verified VICE-shaped active implementations.
2. The real EasyFlash failure is resolved through source-faithful mapping/register behavior.
3. Tests exercise active mapper implementations and VICE-derived expectations, not substitute stubs.
4. Cartridge line changes, writable state and continuation restore are proved end to end.
5. No listed mapper remains an intentionally simplified implementation.

Until these conditions are met, CRT mounting may be exposed as experimental, but it must not be described as faithful cartridge support.
