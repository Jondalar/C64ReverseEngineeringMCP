# Spec 898 — The VIC-20 and the TED machines are platforms

**Status:** IN BUILD 2026-10-10 (owner: build it whole)
**Repo:** C64RE only. TRX64: no change.
**Number:** 898 (registry: `specs/README.md`).
**Origin:** issue #50 point 3 (split to #56, the off switch only) and issue #51 point 2
(split to #60, the data part only; the I/O-window part is here). Found in Mike's
VIC-20 → C64 ports (*Chariot Race*, *Mega Vault*, *Phantom Attack*, *Mickey The Bricky*)
and the C16 → C64 port (*The Magician's Curse*).

---

## §1 What is wrong

A port starts with a disassembly of the foreign original. C64RE already has a platform
model — Spec 048's tag, Spec 817's store, Spec 818's ids — but it knows two machines:

| Where | What it says |
|---|---|
| `pipeline/src/lib/platform-kb.ts:16` | `PlatformTag = "c64" \| "c1541"` |
| `src/platform-kb/schema.ts:14`, `:75-85` | same tag; the memory map is C64 (`$D000-$DFFF` io, `$A000-$BFFF` + `$E000-` rom) or the 1541 |
| `src/server-tools/analysis-workflow.ts:505-511`, `:1154`, `:1295` | `disasm` / `disasm_prg` accept `c64 \| c1541`; the artifact record is read for `c1541` only |
| `src/project-knowledge/mcp-tools.ts:394`, `types.ts:160` | the artifact marker (Spec 020) already accepts `vic20` and `plus4` — and nothing reads them |
| `pipeline/src/lib/c64-symbols.ts:24`, `prg-disasm.ts:588`, `:823`, `:1675` | the I/O window is `$D000-$DFFF`, hard-coded |
| `src/knowledge-graph/producers/memory-access.ts:207` | `USES_HARDWARE` is `$D000-$DFFF` for c64, `$1800-$1C0F` otherwise |
| `src/server-tools/inspect-range.ts:156-158` | `platformKb().node("c64", …)`, whatever the artifact is |
| `pipeline/src/analysis/{code-semantics,evidence-graph,irq-analysis,probable-code,relocations}.ts` | each its own `$D000-$D02E` / `$D000-$DFFF` / `$DD00` test |

So a VIC-20 or C16 listing is commented as if it ran on a C64:

- Zero page gets C64 names: `ldx $01 ; R6510`, `lda $7A ; TXTPTR` — 127 wrong comments in
  one 4 KB VIC-20 file (*Chariot Race*). The VIC-20's 6502 has no port at `$00/$01`;
  the TED's 7501/8501 has one, with other bits.
- KERNAL calls get C64 names where the VIC-20 and TED jump tables differ in what sits
  behind the same vector, and the ROMs themselves (VIC-20 KERNAL `$E000-$FFFF`, BASIC
  `$C000-$DFFF`; TED ROM `$8000-$FFFF` banked by `$FF3E/$FF3F`) are never named.
- The real I/O is invisible: VIC-I `$9000-$900F`, VIA1 `$9110-$911F`, VIA2
  `$9120-$912F`, colour RAM `$9400-$97FF`; TED `$FF00-$FF3F`, the keyboard latch `$FD30`,
  the 6529 at `$FD10`. Stores there are plain RAM to every analysis pass, so no
  `USES_HARDWARE` edge exists.
- Default load addresses are C64's. A VIC-20 tape file loads to `$1001` (unexpanded),
  `$0401` (+3K) or `$1201` (+8K and up); C16 / Plus/4 BASIC starts at `$1001`.

And the contract inherits it (`src/contract/promises.ts:150-177`): an `annotate` region
counts `routine` / `data_block` / `lookup_table` / `pointer_table` nodes whose address
lies inside the range. A region about hardware access — "VIC-20 hardware access sites,
`$9000-$912F`" (*Mickey The Bricky*) — holds no node by design; its meaning is in the
code that reads and writes it. It blocks as "holds no routine or table at all" and
could only be waived.

The projects got through with skills and waivers — the skills carry the tables, the
listings carry 127 wrong comments, the contracts carry the waivers.

## §2 Decision

**D1 — Two more platform tags.** `PlatformTag` becomes
`"c64" | "c1541" | "vic20" | "plus4"`, in the pipeline and the store alike. `plus4`
covers the TED family — C16, C116, Plus/4 — as Spec 020's marker already names it;
the machines share the TED, the KERNAL entry points and the 7501/8501's opcode set.
(The off switch from #56 is a separate value, decided there; this spec does not add it.)

**D2 — One memory map per tag.** `platformKindForAddress` (`schema.ts:75`) gains a
branch per tag; the address alone still derives the kind, so Spec 818 ids stay derived:

| Tag | io | rom | zp |
|---|---|---|---|
| `vic20` | `$9000-$93FF` (VIC-I, VIA1, VIA2), `$9400-$97FF` colour RAM, `$9800-$9FFF` (I/O2, I/O3 — expansion port) | `$8000-$8FFF` char, `$C000-$FFFF` | `$00-$FF`, no CPU port |
| `plus4` | `$FD00-$FF3F` (6529, keyboard latch, TED) | `$8000-$FCFF`, `$FF40-$FFFF` | `$00-$FF`, `$00/$01` = 7501 port |

On the VIC-20 everything else is `ram`, including the expansion blocks `$0400-$0FFF`,
`$2000-$7FFF` and block 5 `$A000-$BFFF`. Block 5 holds RAM or a cartridge depending on
the machine, and the address cannot tell which; a cartridge there is the program
being read, not platform ROM, so it gets no platform nodes. The expansion also moves
screen and colour RAM (colour at `$9600` instead of `$9400` with 8K and up). Both
positions lie inside the `io` range above; the platform nodes name the range, not
the configuration.

ROM banking on the TED machines (`$FF3E/$FF3F`) is an address range like the C64's
`$01`, not a second kind; the node is `rom` and the bank stays the reader's question.

**D3 — The names come from the store, seeded like c64 and c1541.** Zero page, I/O
registers, KERNAL jump table and ROM entry points per tag go into
`resources/platform-kb.sqlite` through `src/platform-kb/extensions.ts` (or a seed file
per platform beside it), each row with its source. No literal name map anywhere else —
`check:platform-kb` keeps guarding that. The rows are taken from published references
for each machine, not typed from memory; every seed row names its source file and
label. The sources are fixed (owner, 2026-10-10) — the zimmers.net CBM archive,
`pub/cbm/src/`:

| Tag | Authority (names) | Cross-check (addresses, comments) |
|---|---|---|
| `vic20` | `vic20/vic_src.tar.gz` and `vic20/firmware.zip` — Commodore's KERNAL + BASIC source | `vic20/vic20_rom_disassembly.txt` (Lee Davison) |
| `plus4` | `plus4/ted_kernal_basic_src.tar.gz` — the TED KERNAL + BASIC source | `plus4/plus4_rom_disassembly.txt` (Mike Dailly) |

The original source's own labels win; a disassembly only checks an address or fills a
comment. Only the seed rows (address, name, kind, source) enter the repo — the source
trees and disassemblies are Commodore material and are read when seeding, never checked
in (the same line as the ROMs).

**Second source (owner, 2026-10-10).** A register the ROM source never names (the VIC-I
is only `vicreg+N`, the TED only `ted+N`, the keyboard latch a bare `$FD30`) is not left
unnamed: the gap is filled from Commodore's own published reference material — the
*VIC-20 Programmer's Reference Guide*, the *MOS 6560/6561 VIC data sheet*, and the
*Commodore Plus/4 Hardware Manual* with its *7360 TED data sheet*. These rows are marked
secondary — `source` starts with `secondary: ` and cites document and page — and never
shadow a ROM-source label: a secondary row fills only an address that has no source row.
Symbols follow one rule: the reference's own mnemonic when it gives one (the data sheet's
`CR0`..`CRF` → `VIC_CR5`; the PLA output `KEYPORT` for `$FD3X`), otherwise chip prefix +
the register number as the reference numbers it (the 7360 sheet counts in decimal:
`$FF14` is `TED_R20`). The description is the reference's wording. A row no source of
either kind carries (the hardware vectors `$FFFA-$FFFF`, TED `$FF20-$FF3D`) is left
unnamed rather than invented. Rows: `src/platform-kb/seeds/secondary.ts`.

**D4 — One question asks the I/O window.** Every hard-coded `$D000-$DFFF` test listed
in §1 is replaced by `platformKindForAddress(tag, a) === "io"` (or a register lookup for
the narrower `$D000-$D02E` / `$DD00` tests). The c64 answers stay byte-identical.

**D5 — How a render knows the machine.** In order:
1. `platform` passed to `disasm` / `disasm_prg` (enum widened to the four tags);
2. the artifact record's `platform` (Spec 020), now read for every tag, not only `c1541`;
3. a project default `platform` in `knowledge/project.json`;
4. `c64`.

As today, an explicitly named platform is recorded on the artifact
(`analysis-workflow.ts:513-519`). `inspect_address_range` and `c64ref_lookup` take the
same resolution instead of assuming `c64`.

**D6 — Default load address per tag.** Where a tool guesses a load address for a
headerless block, `vic20` offers `$1001`, `$0401`, `$1201` (the three memory
configurations) and `plus4` offers `$1001`. A PRG header always wins. The same set is the
machine's BASIC start in the analysis: a `10 SYS` stub at one of them is a `basic` segment
with a SYS entry (`c64` `$0801` unchanged, `c1541` none). The RAM vector pairs at `$0314`,
`$0316` are CINV/CBINV on all three machines and `$0318` is NMINV on the C64 and VIC-20 —
on the TED machines it is IOPEN, so `plus4` drops that pair.

**D7 — An annotate region over an I/O window is satisfied by its sites.** When a
contract `annotate` boundary lies wholly inside the platform's `io` kind (D2), the
promise counts the routines that carry a `USES_HARDWARE` edge into the range
(`memory-access.ts:207`, now platform-aware by D4), not nodes inside it. It is met when
those routines exist and carry human names, the same test as today's `named`. No sites
→ the same blocker as now, worded "no code references `$9000-$912F`". A boundary that
straddles I/O and RAM keeps today's rule.

**D8 — The machine is asked for at the start, not guessed later** (owner, 2026-10-10: "I
drop a .d64 or a VIC-20 / C16 image and the pipeline runs the same way"). A load address
cannot tell the machines apart — `$1001` is the unexpanded VIC-20 and the C16 alike — so
nothing infers the platform from bytes. Instead: `project_init` takes `platform` (built
with D5), `agent_onboard` and `project_status` print the project's machine, and when a
project has no default but holds media whose load addresses are a foreign BASIC start
(`$1001`, `$0401`, `$1201`) or a cartridge signature (D9), they say so and name the one
call that settles it. The doctrine's onboarding step asks the human for the machine when
the brief does not name it. A `.d64` is read the same for all three machines (the 1540 /
1541 / 1551 share the format); the extracted files take the project default by D5.

**D9 — A raw cartridge image is placed by its own signature.** A headerless image whose
bytes carry the KERNAL's autostart signature gets the load address the KERNAL checks:
VIC-20 `A0CBM` at offset 4 → `$A000` (block 5; `kernal.src` tests `$A004-$A008`);
TED `CBM` at offset 7 → `$8000` (`banking.src` tests `$8007`). The signature is
evidence, so it is stated in the tool output, and an explicit `load_address` still wins.
No signature → the D6 refusal with the machine's offers, `$A000` added for `vic20`.

**Skills this builds on (by name):** `vic20-to-c64`, `c16-to-c64`, `c64-tape`,
`c64-pal-ntsc`.

## §3 Out (by decision)

- **No VIC-20 or TED runtime.** TRX64 stays a C64 + 1541 machine; the foreign original
  is read statically, the port is verified on the C64. `runtime_*` is not touched.
- **No tape tooling.** TAP / T64 decoding stays with the project (skill `c64-tape`);
  this spec starts at the extracted PRG.
- **No CPU variants.** The 6502, 6510, 7501 and 8501 share the NMOS opcode set the
  disassembler already decodes; the 7501/8501 port is a zero-page name, not a CPU.
- **No C128, PET or 1581 tags.** Same mechanism, added when a project needs one.
- **No foreign-machine depackers or loaders.** A VIC-20 cruncher is analysed like any
  other code.
- **The off switch** is #56's.

## §4 Acceptance

- A c64 project renders byte-identical listings before and after (`.tas` and `.asm`),
  with the same comments, nodes and edges. The existing e2e and `check:platform-kb` stay
  green.
- `disasm_prg` on a VIC-20 file with `platform: "vic20"` (the Mega Vault `megavault_f2`
  and the Chariot Race VIC-20 PRG): no C64 name in any comment (`R6510`, `TXTPTR`,
  `VIC`/`CIA`/`SID` register names, C64 KERNAL names); VIA names on `$9110-$912F`, VIC-I
  names on `$9000-$900F`; VIC-20 KERNAL names on `JSR $FFxx`. 64tass rebuild
  byte-identical.
- The same on a VIC-20 game from outside Mike's corpus that needs the 8K expansion:
  *JETPAC* (Ultimate, 1983), using the published hand disassembly by Phillip Eaton
  (GitHub `phillipeaton/JETPAC_VIC-20_disassembly`, no licence — read for the check,
  never checked in). Code at `$2000-$3FFF`, colour RAM at `$9600`: the VIC-I and VIA
  accesses carry VIC-20 names, no C64 name appears, and the 64tass rebuild is
  byte-identical to `bin_orig/jetpac.prg`.
- The same for a C16 file with `platform: "plus4"` (*The Magician's Curse*): TED names
  on `$FF00-$FF3F`, `$FD30` named, `$00/$01` named as the 7501 port. 64tass rebuild
  byte-identical.
- Setting the artifact marker to `vic20` (no `platform` argument) gives the same render
  as passing it; the project default gives it when the artifact has none.
- `graph_edges` shows `USES_HARDWARE` from the VIC-20 routines that store to
  `$9000-$912F`; Spec 818 ids read `vic20:io:9005` and resolve.
- A contract `annotate` boundary `$9000-$912F` on the *Mickey The Bricky* project is met
  once the referencing routines carry human names, and blocks with "no code references"
  on a file that never touches it.
- A project started with `project_init platform: vic20` renders an extracted `.d64` file
  with VIC-20 names without any further argument; a project with no machine and a `$1001`
  file says so in `agent_onboard` / `project_status` and names `project_init platform`.
- A raw VIC-20 cartridge image with `A0CBM` at offset 4 disassembles at `$A000`, a TED
  one with `CBM` at offset 7 at `$8000`, each naming the signature; without one the
  refusal offers the machine's addresses.
- `inspect_address_range` and `c64ref_lookup` on a `vic20` artifact return VIC-20
  names, and say so when the store has no row.
