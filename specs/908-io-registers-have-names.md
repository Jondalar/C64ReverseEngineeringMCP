# Spec 908 — I/O registers have names in every listing, also when the image covers $D000-$DFFF

**Status:** BUILT on branch `spec/908` (2026-10-14), not merged. `e2e:908` holds S1-S5 and D3 with real assertions (in `gates.yml`, run by `scripts/gate.sh`); full gate GREEN, 117/117 steps (1170 s, in a clean clone outside the repo, against TRX64 0.13.0). Decisions the spec left open: §5.
**Repo:** C64RE only (platform knowledge, listing renderer, annotations). No TRX64 part.
**Number:** 908 (registry: `specs/README.md`).
**Origin:** issue #74 (2026-10-14, the reporter's LLM on the GriffinSoft collection): four game
images load over the I/O window; every `sta $D011` / `sta $D020` / `sta $D418` stays raw hex (94 lines
in one game, 217 in another), a human label `D011 vic_ctrl1` does not help, and the house style
needs a named equate for every I/O address — today only reachable by a hand-edit layer that every
regenerate wipes. Related: #75 point 3 (the `$DE00` comment follows the cartridge type) is fixed
on its own branch; this spec reuses that rule for `$DE00-$DFFF`.
**Depends on:** nothing (the cartridge-type rule of #75 is on master).

---

## §1 The problem

**Who:** an LLM (or the owner) producing a readable, rebuildable listing of a game whose image
spans `$D000-$DFFF` (common: the game runs with `$01 = $35`, RAM under I/O holds sprites or code
that is copied there).

**What happens today** (read off the code, 2026-10-14):
- The platform knowledge has every C64 I/O register (`resources/c64ref-rom-knowledge.json`: 118
  entries in `$D000-$DFFF`, e.g. `$D011` "Vertical Fine Scrolling and Control Register", Mapping
  label `SCROY`), but what it holds is the book's label and heading, not a name a listing can use;
  a mirror (`$D051`) has no row at all, so `graph_find` answers it with no name.
- Every absolute operand in `$D000-$DFFF` is answered by `findOperandExpression`'s first branch with
  the bare address, before any label is consulted. That is why a human label at `$D011` is placed
  as a line label and never becomes the operand: the branch returns first. `annotatedOperandName`
  is no better inside the image: it refuses every address the listing holds, because "the renderer
  places those as labels" — and for the I/O window it then did not.
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

**The cause, confirmed.** The raw `$D011` was `findOperandExpression` returning the bare address for
every `$D000-$DFFF` target before any label or name was looked at; `annotatedOperandName` then never
ran for a held address. D3's precedence is implemented where that branch was: human label first
(exact address; a mirror of a labelled register reads `label+$40`), then the project's `memoryMap`,
then the register name, then the bare address. The issue's "name null" for `$D011` was not the case
with the committed store (`SCROY Vertical Fine Scrolling…`); it was true for mirrors and for the
register's absence of a *listing* name, which is what the graph now carries.

**The name table (D1).** 109 names in four chip windows, all lower-case, at most 20 characters, one
per register, none shared (`e2e:908` S1 holds it):

| Window | Names | Repeats every |
|---|---|---|
| VIC-II `$D000-$D02E` | `vic_spr0_x`..`vic_spr7_y`, `vic_spr_x_msb`, `vic_ctrl1`, `vic_raster`, `vic_lp_x/y`, `vic_spr_enable`, `vic_ctrl2`, `vic_spr_yexp`, `vic_mem`, `vic_irq`, `vic_irq_mask`, `vic_spr_prio`, `vic_spr_multi`, `vic_spr_xexp`, `vic_spr_coll`, `vic_spr_bgcoll`, `vic_border`, `vic_bg0..3`, `vic_spr_mc0/1`, `vic_spr0_col`..`vic_spr7_col` | 64 |
| SID `$D400-$D41C` | `sid_v1_freq_lo`..`sid_v3_sr` (7 per voice), `sid_filter_lo/hi/res`, `sid_volume`, `sid_pot_x/y`, `sid_osc3`, `sid_env3` | 32 |
| Colour RAM `$D800-$DBFF` | `color_ram` (a cell is `color_ram+$28`) | no mirror: offset |
| CIA 1 / CIA 2 | `cia1_pra`..`cia1_crb`, `cia2_pra`..`cia2_crb` (16 each: `pra prb ddra ddrb ta_lo ta_hi tb_lo tb_hi tod_10ths tod_sec tod_min tod_hr sdr icr cra crb`) | 16 |
| Cartridge `$DE00-$DFFF` | by type: EasyFlash `ef_bank` `$DE00`, `ef_ctrl` `$DE02`; GMod2 `gmod2_ctrl`, Magic Desk `magicdesk_bank`, Ocean `ocean_bank` (each the whole IO1 page, `+$offset`); MegaByter `megabyter_bank` / `megabyter_mode` (A1 clear / set, repeating every 4); anything else or no type `cart_io_deXX` | |

`$D02F-$D03F` (and its mirrors) are not registers and stay addresses. The Mapping label stays on the
node as `symbol` — an alias search finds the register by — and the book's heading is the
description; the name is the new `platform_node.io_name` column (store schema 3), the windows are
the new `platform_io_window` table. Both readers of the store (ESM, pipeline) fold a mirror by the
same rows, and `e2e:908` S1 runs all of `$D000-$DFFF` through both and fails on a disagreement.
The cartridge names are code in `cartridge-io.ts`, not store rows: which register `$DE00` is depends
on the cartridge, and a store row would claim EasyFlash for every board (the defect #75 removed).

**The door (D2).** `equatesForListing` takes `proposals` — the names the platform offers for
addresses — and holds them to what a graph name is held to (assembler identifier, mnemonic, the
project's name limit, a name the listing already uses). A name the graph or a symbol file holds for
the address wins and comes back instead; the generated `W<HEX4>` does not count as a name there. It
works without a project directory too (no limit, no graph). The operand is decided by the door's
answer, asked once per register while rendering, so a name is never printed that the listing does
not define; refused names are listed under the equate block and the address stays. The block
(`// I/O registers this listing names`) sits first among the equates in the analysed renderers and
under `.pc` in the linear and relocation renderers.

**Only an instruction's operand asks.** A `.word $D020` table entry or a split-table byte is a
number, not an access to the border register; those keep the bare address (`findOperandExpression`
without an instruction address behaves as before). `jmp ($DC0D)` and `lda $D800,x` are accesses.

**`memoryMap` (D3).** `{ start, end, as: io|ram|charrom, routines? }`, range inside `$D000-$DFFF`.
`charrom` is treated like `ram` for naming (the CPU sees ROM, not a register). A later entry wins
where two overlap, so an `io` entry re-enables the registers inside a bigger `ram` range. A routine
is its entry plus everything reachable by fall-through, branches and `jmp`; a `jsr` callee is its own
routine (`e2e:908` S4 holds it: the depacker's helper still stores to `vic_raster`). In a declared
range the operand falls through to the ordinary label logic (`WD011`, a data label) and the
register comment is dropped. The loader skips (and reports) an entry outside the window or with an
unknown `as`; `write_annotations` refuses them, by index. The same range twice is one claim, its
routines joined; as two different things it is a contradiction — refused by the writer, and by
`merge_annotations` as `memoryMap:<start>-<end>` (winner / value / delete, recorded as a finding).
It is not imported into the graph: it is a rendering declaration, and the annotation file stays its
one home.

**Existing tests that follow the names** (deliberately, each assertion now reads the register name):
`e2e-cartridge-bank-listing` C1, C2, C4, C4b, C5-C7, C9, C12 (the `$DE00` line is found by the register
name; the comment text is unchanged), `e2e-842-reloc-data` ("the instruction after THAT": `sta $D021`
reads `vic_bg0`), `e2e-865-disasm-raw` (`sta $D020` reads `vic_border`; the body helper skips the
register equate block), `e2e-bug060-code-tail` D1c (`sta $D020` reads `vic_border`).

**Not done, on purpose.** Naming the drive's VIA registers (§4). Inferring `$01` per instruction (§4).
The cartridge names of types other than EasyFlash, GMod2, Magic Desk, Ocean and MegaByter — the
neutral `cart_io_deXX` stays until a type's register is read off its mapper.
