# Spec 713 - VICE Cartridge Fidelity: CRT Mapping, Banking and Writable Hardware

**Status:** IN PROGRESS (scope corrected 2026-05-24 CEST after audit). This is now one complete VICE cartridge-port batch, not an EasyFlash-only repair followed by deferred active mappers. The active runtime must port or remove every declared cartridge family below, together with its VICE device core and snapshot state. Reproduced EasyFlash REDs remain the first acceptance failures: IO1 mirror (`$DE04` must act like `$DE00` via `addr & 2`), IO2 RAM `$DF00-$DFFF` missing, flash program assignment instead of AM29F040 `old & byte`, and lost flash command-state continuation. `persistsWritableState()` must not be considered complete for any writable mapper until its full VICE state is integrated by Spec 714.5. The runtime proof gate does NOT prove cartridge banking/mapping fidelity.  
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

`C64MegaCart` is currently exposed by the TypeScript mapper registry. During this
spec it must either be mapped to its actual VICE source and fully ported/gated,
or be removed from the faithful supported set and explicitly reported as
unsupported/experimental. A Magic-Desk-like approximation may not remain active
under a VICE-fidelity claim.

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
| Exposed C64MegaCart mapper | Resolve owning VICE authority during 713.0 or remove faithful-support claim | No simplified Magic Desk proxy may remain declared supported |
| AM29F040 flash device | `src/core/flash040core.c`, `src/flash040.h` | Complete state machine, `old & byte` programming, erase alarms and snapshot; shared by EasyFlash/GMOD2 |
| MegaByter flash device | `src/core/flash800core.c`, `src/flash800.h` | Complete program/erase/state/snapshot port |
| GMOD2 EEPROM device | `src/core/m93c86.c`, `src/core/m93c86.h` | Serial protocol, image/write state and snapshot |
| GMOD3 SPI flash device | `src/core/spi-flash.c`, `src/core/spi-flash.h` | Serial protocol, writable image/state and snapshot |

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

### 713.3 - Shared Writable Device Cores

- Port the complete VICE `flash040core` state machine used by EasyFlash and
  GMOD2: magic/unlock sequence, autoselect, byte-program/error, erase sequence,
  erase suspend/resume, `old & byte` programming, status reads, dirty state,
  alarms and snapshot fields.
- Port `flash800core` for MegaByter rather than approximating it through the
  AM29F040 implementation.
- Port `m93c86` for GMOD2 EEPROM and `spi-flash` for GMOD3, including protocol
  progression and snapshot state.
- These core ports must be shared by the corresponding mapper ports; no
  mapper-local reduced copy of writable-device behavior is accepted.

### 713.4 - EasyFlash Full Fidelity

- Port VICE register decode, including mirrored IO1 selection and mode/control masks.
- Port mode/line matrix, jumper behavior where applicable, IO2 RAM and flash behavior required by VICE.
- Verify the reported real EasyFlash CRT beyond booting bank 0: program-driven bank changes and stable visual/data behavior.

### 713.5 - Ocean And Magic Desk Families

- Port Ocean profile/bank masking and mapped windows.
- Port Magic Desk and Magic Desk 16 bank, disable and `GAME`/`EXROM` behavior.

### 713.6 - Protovision MegaByter

- Port bank/control IO1 decode, mode selection and flash/state behavior.

### 713.7 - GMOD2 And GMOD3

- Replace simplified TS models with full VICE-shaped behavior.
- GMOD2: mode switching, flash and EEPROM signal/state.
- GMOD3: VICE IO1-address bank selection, modes and SPI flash behavior.

### 713.8 - Integration And Continuation

- Wire every mapper's complete snapshot/restore state into the Spec 714.5
  native-checkpoint policy in this same cartridge batch.
- Verify detach/eject/reset/remount behavior through the active media ingress path.
- Close UI-visible CRT execution gates only after mapper differential tests pass.

The numbered slices are ownership boundaries for review, not permission to
ship active partial mapper support. Do not finish with EasyFlash complete while
GMOD2/GMOD3/MegaByter or another exposed mapper remains a known simplification.

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
- write protocol behavior, including operations in progress at checkpoint time;
- flash physics (`old & byte` programming and erase completion) where applicable;
- reset/power-cycle behavior;
- native checkpoint restore behavior;
- `.c64re` fresh-session restore and ring restore across mutable versions;
- dirty status as status/writeback information, not a permanent snapshot reject
  after the device port is complete.

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
6. Every exposed writable mapper can be snapshotted while modified or while a
   protocol operation is in progress, with VICE-equivalent continuation after
   restore; interim reject behavior is not a completion result.

Until these conditions are met, CRT mounting may be exposed as experimental, but it must not be described as faithful cartridge support.

## 9. RFL Ownership Matrix (713.0) and Progress

VICE source root: `/Users/alex/Development/C64/Tools/vice/vice/src`. TS owner:
`src/runtime/headless/cartridge.ts` (single-file registry + mappers) routed by
`memory-bus.ts` (`$8000-$BFFF`, `$DE00-$DFFF`, EXROM/GAME via `getBankInfo()`).

| Family / device | VICE authority | TS status (2026-05-24) |
| --- | --- | --- |
| AM29F040 flash core | `core/flash040core.c`, `flash040.h` | **PORTED (faithful)** — `Flash040` class: full command state machine + `flash_base_state`, `old & byte` program, autoselect IDs, byte-program-error status, magic masking (TYPE_B 0x555/0x2aa mask 0x7ff), `program_byte`/`last_read`, snapshot state. Documented simplification: erase is ATOMIC (no erase_alarm timing / sector-erase-timeout window); data-faithful, no mid-erase state to snapshot. |
| EasyFlash | `c64/cart/easyflash.c` | **PORTED (faithful)** — IO1 `addr & 2` mirror decode, `register_02 & 0x87`, `easyflash_memconfig` mode/line matrix + jumper, IO2 RAM `$DF00-$DFFF` (256B), two `Flash040` chips, full continuation snapshot (bank/control/jumper/IO2 RAM + each flash command-state). Gates: `probe:714-5` 16/16. |
| Generic Normal 8K/16K, Ultimax | `c64/cart/c64-generic.c` | Present (BaseMapper / Normal8k / Normal16k / Ultimax). Read-only banked; believed correct, NOT yet differential-verified vs VICE (713.2 pending). |
| Ocean | `c64/cart/ocean.c` | SIMPLIFIED (fixed bank mask; not size/profile-derived). 713.5 pending. |
| Magic Desk / Magic Desk 16 | `c64/cart/magicdesk.c`, `magicdesk16.c` | SIMPLIFIED (no bit-7 disable / dynamic GAME-EXROM). 713.5 pending. |
| Protovision MegaByter | `c64/cart/megabyter.c` + `core/flash800core.c` | SIMPLIFIED (uses `AmdFlashChip` approximation, not `flash800core`). 713.3 (flash800core) + 713.6 pending. |
| GMOD2 | `c64/cart/gmod2.c` + `core/m93c86.c` (EEPROM) | SIMPLIFIED (no EEPROM). 713.3 (m93c86) + 713.7 pending. |
| GMOD3 | `c64/cart/gmod3.c` + `core/spi-flash.c` | SIMPLIFIED (no SPI flash, wrong bank-select). 713.3 (spi-flash) + 713.7 pending. |
| C64MegaCart | resolve owning VICE source or remove | UNRESOLVED — 713.0 follow-up: map to real VICE source or drop the faithful claim. |

## 10. Result — flash040core + EasyFlash (713.3 partial + 713.4)

EasyFlash — the reproduced incident family — is now VICE-faithful. The four
audit REDs are fixed and gated by `probe:714-5` (16/16):

- IO1 mirror: `$DE04` sets the bank like `$DE00`; `$DE06` sets control like `$DE02`.
- IO2 RAM `$DF00-$DFFF` reads/writes + survives same-session checkpoint,
  `.c64re` fresh-session and the ring.
- Flash program physics `old & byte`: `$ff→$14→$10→$ff` keeps `$10`.
- Mid-command continuation: a checkpoint mid-AMD-unlock is accepted (the command
  state is captured) and continues identically after restore (no drift).
- Active-runtime banking: the real EasyFlash CRT cold-boots + executes, and a
  program-driven `$DE00` bank switch reads the correct per-bank flash.

`flash040core` is ported and shared-ready for GMOD2's flash. `flash800core`
(MegaByter), `m93c86` (GMOD2 EEPROM) and `spi-flash` (GMOD3) are NOT yet ported.

**Spec 713 status: IN PROGRESS.** EasyFlash + flash040core done; Ocean,
Magic Desk/16, MegaByter (+flash800core), GMOD2 (+m93c86), GMOD3 (+spi-flash),
the C64MegaCart resolution, and the generic-baseline differential verification
remain. Per §3.7 the not-yet-faithful families are to be gated to explicit
reject-on-attach in a follow-up slice so no simplified mapper is silently active
under a fidelity claim. No partial-batch DONE.
