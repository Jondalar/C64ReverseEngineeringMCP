# Spec 908 — I/O registers have names in every listing, also when the image covers $D000-$DFFF

**Status:** PROPOSED (2026-10-14).
**Repo:** C64RE only (platform knowledge, listing renderer, annotations). No TRX64 part.
**Number:** 908 (registry: `specs/README.md`).
**Origin:** issue #74 (2026-10-14, the reporter's LLM on the GriffinSoft collection): four game
images load over the I/O window; every `sta $D011` / `sta $D020` / `sta $D418` stays raw hex (94 lines
in one game, 217 in another), a human label `D011 vic_ctrl1` does not help, and the house style
needs a named equate for every I/O address — today only reachable by a hand-edit layer that every
regenerate wipes. Related: #75 point 3 (the `$DE00` comment follows the cartridge type) is fixed
on its own branch; this spec reuses that rule for `$DE00-$DFFF`.
**Depends on:** nothing.

---

## §1 The problem

**Who:** an LLM (or the owner) producing a readable, rebuildable listing of a game whose image
spans `$D000-$DFFF` (common: the game runs with `$01 = $35`, RAM under I/O holds sprites or code
that is copied there).

**What happens today** (to be confirmed against the code by the build, the issue's reading):
- The platform knowledge has every C64 I/O register (`resources/c64ref-rom-knowledge.json`: 118
  entries in `$D000-$DFFF`, e.g. `$D011` "Vertical Fine Scrolling and Control Register", Mapping
  label `SCROY`), but the graph's `io` node for `$D011` has no name (`graph_find $D011` → name null),
  so nothing names the operand.
- An address inside the loaded image is rendered as a code/data label or `W<addr>`; an I/O address
  inside the image therefore never becomes an equate, and a human label there is placed as a line
  label but not used as the operand name (`sta $D011` stays raw).
- Outside the image (zero page) a human label becomes an equate and is used (`lives = $11`).

**Why it matters:** I/O accesses are the most informative lines of a C64 program; raw hex hides
them. The reporter's workaround is a post-processing layer that is wiped by every regenerate.

### Parts (MECE)

- **P1 Names exist.** Every VIC-II, SID, CIA 1, CIA 2 register (and colour RAM, and the cartridge
  I/O pages by cartridge type) has one short, stable name in the platform knowledge and the graph.
- **P2 The listing uses them.** An absolute operand that is I/O at run time renders as that name,
  defined in an equate block, in KickAssembler and 64tass, whether or not the image covers the
  address; the rebuild stays byte-identical.
- **P3 The project decides.** A human label at an I/O address wins over the platform name, and the
  annotations can say where the window is RAM at run time instead (so a depacker writing under I/O
  is not named as register writes).

## §2 Scenarios — what proves it is solved

```gherkin
Scenario: S1 every I/O register has a name
  When  graph_find is asked for $D011, $D020, $D418, $DC0D, $DD00
  Then  each returns its register name (vic_ctrl1, vic_border, sid_volume, cia1_icr, cia2_pra) and description
  And   a mirror ($D051 = $D011 + 64) is named as its register with the mirror noted

Scenario: S2 an image over $D000-$DFFF names its I/O operands
  Given a synthetic PRG loaded at $0801-$EFFF whose code does lda $d011 / sta $d020 / sta $d418 / lda $dc0d
  When  disasm renders it (KickAssembler and 64tass)
  Then  those operands read vic_ctrl1, vic_border, sid_volume, cia1_icr
  And   an equate block defines exactly the names used
  And   the rebuild is byte-identical, and data labels on the sprite bytes under $D000 are still placed

Scenario: S3 a human label at an I/O address wins
  Given the annotations carry label D011 "scroll_ctl"
  Then  operands to $D011 read scroll_ctl, and vic_ctrl1 is not emitted

Scenario: S4 the project says the window is RAM here
  Given the annotations declare $D000-$DFFF as RAM for the range of a depacker routine
  Then  that routine's stores render as data/W labels, not register names; the rest of the code keeps register names

Scenario: S5 cartridge I/O follows the cartridge type
  Given a GMod2 artifact and an EasyFlash artifact, each storing to $DE00
  Then  the operand reads gmod2_ctrl / ef_bank respectively; an unknown type reads cart_io_de00
```

| # | Solves | Scenario | Test | Where it runs |
|---|---|---|---|---|
| S1 | P1 | names exist | `scripts/e2e-908-io-names.mjs` → `e2e:908` | `gates.yml` (hermetic) |
| S2 | P2 | operands named over the window | `e2e:908` (synthetic PRG via `asm6502-mini`; byte-identity half with the assembler when present, loud skip otherwise) | `gates.yml` + local gate |
| S3 | P3 | human label wins | `e2e:908` | `gates.yml` |
| S4 | P3 | declared RAM range | `e2e:908` | `gates.yml` |
| S5 | P1 | cart I/O by type | `e2e:908` | `gates.yml` |

## §3 Decision

- **D1 Names (P1).** One naming scheme, lower-case, chip-prefixed, short enough for the 20-char
  name rule: `vic_spr0_x … vic_ctrl1, vic_raster, vic_ctrl2, vic_mem, vic_irq, vic_irq_mask,
  vic_border, vic_bg0…`, `sid_v1_freq_lo … sid_volume`, `cia1_pra … cia1_icr, cia1_cra`,
  `cia2_pra …`, `color_ram` for `$D800-$DBFF` (as base + offset). The table lives in the platform
  seed as an extension (`src/platform-kb/extensions.ts`), keyed by address, with the Mapping label as
  an alias for search. Mirrors (VIC every 64 bytes, SID every 32, CIAs every 16) name their base
  register with a `+mirror` note; operands to a mirror render `vic_ctrl1+$40`. `$DE00-$DFFF` take
  the names of the artifact's cartridge type (shared with #75's rule), else `cart_io_deXX`.
- **D2 Rendering (P2).** An absolute or indexed operand in `$D000-$DFFF` renders as its I/O name
  through the listing's existing equate door (`graph-equates.ts`, `listingEquates`), independent of
  whether the image covers the address; line labels inside the image stay where they are. Bytes
  never change; the equate block lists only names used.
- **D3 Project decides (P3).** Precedence: human label > declared RAM range > platform I/O name.
  New annotations section `memoryMap: [{ start, end, as: "io" | "ram" | "charrom", routines?: [addr…] }]`
  (default for `$D000-$DFFF`: io). Documented in `docs/annotations-reference.md`; `write_annotations`
  and `merge_annotations` carry it.

## §4 Out

- Inferring the banking (`$01`) per instruction from the code — the project declares it (D3).
- Naming the drive's VIA registers in 1541 listings — the same mechanism, but the reporter's case is
  the C64 side; a follow-up if asked.

## §5 Decisions taken while building

(filled in at the end)
