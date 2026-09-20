# Spec 865 — Disassemble bytes at an address

**Status:** BUILT 2026-09-20 — every deliverable, every acceptance item, one hermetic
gate in CI. §8 records what became shared code (`disasm_prg` gained the seeding it had
been silently dropping), and the one acceptance item that describes a failure this
renderer does not have.
**Repo:** C64RE only. TRX64: no change.
**Number:** 865 (registry: `specs/README.md`).
**Depends on:** the pipeline's disassembler and its annotation renderer, the analysis
pipeline, the knowledge graph, Spec 741's relocated rendering, and the one address rule
BUG-054 introduced.
**Origin:** two autonomous runs, 2026-09-20, both blocked on the same missing door and both
working around it in the shell.

---

## §1 What is missing

Every door into a listing wants a **PRG**: two bytes of load address, a registered artifact,
and for a good result an analysis JSON beside it. What an RE session actually holds, most of
the time, is none of that — a depacked chunk, a relocated overlay, a block lifted out of a
raw track, a stretch of drive code, a ripped charset that turned out to be code. Bytes, and
an address they run at.

`inspect_address_range` answers *about* a range and returns no listing.
`runtime_monitor_disasm` reads the live machine, which the doctrine keeps for confirming
what was already read. So the gap is closed by hand, every time:

- one run wrote its own disassembler and called it **180 times**;
- the other wrote a script that bolts a 2-byte header onto `.bin` blocks — its own words,
  *"so the MCP disassembler can eat them"* — and produced **308** fake PRGs.

Both then had listings the project knows nothing about.

## §2 D1 — `disasm_raw`

**Input.** The bytes, one of:

- `path` — a file in the project (project-relative, resolved the way every other path is),
  optionally narrowed by `offset` and `length`;
- `artifact_id` — an artifact already registered, same narrowing.

Plus:

- `load_address` (required) — where the first byte lives when it runs. One address rule,
  the one BUG-054 settled: hex, `$` and `0x` optional, a JSON number taken as given.
- `entry_points` — optional; without one, the first byte is the only seed.
- `annotations_path` — optional, the same annotation shape `disasm_prg` consumes.
- `analysis_path` — optional; when given, the listing is segment-aware exactly as
  `disasm_prg`'s is.
- `space` / `bank` — optional, for bytes that belong to a bank or the drive's memory, so the
  graph keys them where they actually live.
- `cpu` — `c64` (default) or `drive`, because drive code is 6502 too but reads differently.

**What it does.** The same decoder, the same renderer, the same annotation handling and the
same output pair (`.asm` for KickAssembler, `.tas` for 64tass) as `disasm_prg`. No PRG is
invented: nothing is prepended to the bytes, and nothing on disk is rewritten.

**Output.** The listing written into the project's analysis tree, registered as an artifact
with its provenance — which file, which byte range, which address — and the text answer
names the path, the address span, the instruction count and what was seeded.

## §3 D2 — It must prove itself the same way

A listing whose bytes cannot be reassembled to the bytes it came from is a listing that lies.
`disasm_raw` reassembles and compares, like `disasm_prg` does, and reports
**byte-identical** or names the first divergence with its offset. The comparison is against
the input range, header-free on both sides.

A range that cannot round-trip — data misread as code, a truncated instruction at the end —
is reported as such rather than refused: the listing is still what the caller asked for, and
the verdict says what it is worth.

## §4 D3 — What the project keeps

The listing is an artifact, and the graph learns what was disassembled where: a `disasm_raw`
run records the source (file or artifact, byte range), the runtime address, the seeds, and
the rebuild verdict. Where the bytes belong to a payload, the listing links to it the way
`disasm_prg`'s does — through the payload predicate BUG-054 unified, so a disk-file payload
is not invisible to it.

Re-running on the same input with the same arguments produces the same listing and the same
artifact lineage, not a second copy.

## §5 Scope

- **Not** a second disassembler. If the renderer needs a change to work without a PRG header,
  the change is in the shared code and `disasm_prg` gets it too.
- **Not** an analysis pass. It renders; `analyze_prg` classifies. When an analysis is handed
  in, it is used; when it is not, the listing says it had none.
- **Not** the runtime. Reading the live machine is `runtime_monitor_disasm`, and this spec
  does not touch it.
- Relocated rendering (`.pseudopc`/`.logical`) stays what Spec 741 built: `load_address` is
  where the bytes run, and a caller who needs a second view passes it again.

## §6 Acceptance

Fixtures built through the product's own doors, so the gates run in CI.

1. **A headerless block disassembles.** 256 bytes of known 6502 at `$C000`: the listing is
   the expected instructions, the first instruction sits at `$C000`, and no load-address
   word appears anywhere in the output.
2. **It round-trips.** The same listing reassembles to the same 256 bytes, reported
   byte-identical; a deliberately data-filled range reports the divergence with its offset
   instead of claiming success.
3. **A window of a bigger file.** `offset`/`length` over a 16 KB file yields exactly the
   window's instructions, and the artifact's provenance names the range.
4. **Entry points seed it.** A block whose first byte is data and whose code starts at `+3`
   yields the code when the entry point says so, and does not when it does not.
5. **Annotations apply.** The same annotations file, handed to `disasm_prg` on a PRG of those
   bytes and to `disasm_raw` on the bytes, yields the same labels and comments.
6. **Drive code.** A block of 1541 code at `$0300` with `cpu: "drive"` renders and
   round-trips.
7. **Nothing is invented.** After a run, the input file's bytes are unchanged (hash before
   and after), and no `.prg` was written anywhere.
8. **The project knows.** The listing is registered, its provenance is readable back, and a
   second identical run does not produce a second artifact.

## §7 Surface

One MCP tool, `disasm_raw`, on the default surface, in the disassembly playbook beside
`disasm_prg`, with a description that says when to reach for which: a PRG with a load
address is `disasm_prg`'s, bytes at an address you already know are this one's.

## §8 As built (2026-09-20)

**D1 `disasm_raw`** — `src/server-tools/analysis-workflow.ts`, on the default surface
beside `disasm_prg`, in the static-pass playbook with it.

It is not a second disassembler, and the diff shows it: the renderer's entry point
gained one branch. `disassemblePrgToKickAsm` used to open with `readPrg`, whose only
job was to pull `{ loadAddress, data }` out of a 2-byte header; it now opens with
`options.raw ? readRawImage(...) : readPrg(...)`, and every line past that — the
decoder, the segment-aware path, the annotation index, the `.asm`/`.tas` pair — is
the same code running on the same pair. Nothing is prepended to the bytes and nothing
on disk is rewritten. A window outside the file is named by which end it fell off
rather than clamped.

**Two changes went into the shared code, and `disasm_prg` has both.**

* **The linear renderer honours its entry points.** It accepted the list and threw it
  away — `collectLabels` still names the parameter `_entryPoints` — so
  `disasm_prg(entry_points=[…])` on a file with no analysis JSON changed nothing at
  all. A seed strictly inside a decoded instruction now breaks it: the bytes up to the
  seed render as data and the walk resumes at the seed. Byte-exact either way, and it
  is the rule the analysis path already applies to an entry hidden in an operand
  (Spec 830's `entrySplits`). It is not code discovery and the listing does not claim
  to be one; an analysis JSON is still what finds code. That made the pipeline's
  `[0x0827]` default — a guess at a BASIC stub's SYS target — dangerous rather than
  merely inert, so `disasm-prg` now defaults to no seed. Today that changes nothing:
  the default only ever reached the two renderers that ignored it.
* **An annotations file can be named outright.** `loadAnnotations` has always taken an
  explicit path and nothing ever passed one. A raw block needs it, because its bytes
  usually live under a name no `<stem>_annotations.json` was going to be named after.

**D2 the proof** — `src/lib/rebuild-verify.ts`, the verifier a fix round had just
extracted, not a second one. It gained `compareRange` (a window is held against the
bytes it was rendered from, not against the whole file, or every window would report a
length divergence one byte past its end), `compareLabel`, the assembler's first
complaint appended to the verdict (an exit code is not a reason, and a refused listing
is the commonest real failure), and an opt-in discard of a *verified* rebuild check —
beside a PRG that stray `.prg` is unremarkable, beside a headerless listing it is
exactly the artefact this spec exists to stop. A divergence is always kept: then it is
evidence.

**D3 what the project keeps.** The artifact row carries the provenance in prose —
which file, which byte range, which address, what seeded it — the tool run records
every argument, and `saveArtifact`'s path dedup means a re-run with the same arguments
updates that row instead of minting a second. Where the bytes belong to a payload the
listing links to it through `listPayloadEntities`, the predicate BUG-054 unified, so a
payload `extract_disk` created is not invisible to it.

**One rule for every number.** `parseCountStrict` sits beside `parseAddressStrict` and
reads `offset`/`length` by the same rule an address uses — a string is hex, a JSON
number is taken as given — because counted-not-addressed is precisely the excuse that
produced two readings of one notation last time. It is not clamped to 16 bits, and
every answer prints the window in both notations so a caller who read the rule the
other way sees it at once. The MCP half hands the pipeline hex, for the same reason.

**Gates.** `e2e:865` is hermetic and in CI: 55/55 with KickAssembler, 47 pass and 4
loud skips without it, the way `e2e:830` behaves. No ROMs, no media, no daemon — it
builds its own project through `project_init` / `agent_onboard` and drives the tool
over MCP. Regression-checked against every gate that renders: `e2e:830`, `e2e:830-seed`,
`e2e:832-annotations`, `e2e:833-render`, `smoke:741`, `e2e:741`, `smoke:disasm-sync`,
`e2e:842-reloc-data`, `e2e:842-graph`, `e2e:861-impact`, `e2e:862-rules`,
`e2e:tooling-defects`, plus the whole `check:mcp-product-surface` suite — all green.

* §6.1 — 256 bytes at `$C000`: `.pc = $C000`, the body opens on the block's own first
  instruction, and nothing before the code emits a `.byte`/`.word`. 245 instructions,
  0 data lines.
* §6.2 — `rebuild verified byte-identical against block.bin bytes 0..255 (256 bytes)`,
  in the answer and in the listing's own head. The negative half is §8.1.
* §6.3 — `offset "1000"`, `length "14"` over 16 KB yields exactly the window's nine
  instructions; the provenance reads `Bytes 4096..4115 of overlay.bin (offset 4096
  ($1000), length 20 ($14))` and the default path is `overlay_1000-1013_8000_disasm.asm`.
* §6.4 — without a seed the block renders `lda $41A9` and the code at `+3` is gone;
  with `entry_points: ["C003"]` it renders `.byte $AD` then `lda #$41`, and still
  rebuilds byte-identical.
* §6.5 — the same annotations file through `disasm_prg` on a PRG of those bytes and
  through `disasm_raw` on the bytes: 247 lines, no first divergence.
* §6.6 — 13 bytes of 1541 code at `$0300` with `cpu: "drive"` renders `lda $1800` as
  `VIA1_PRB` and rebuilds byte-identical.
* §6.7 — the input's sha256 and its length are unchanged, and no `.prg` exists beside
  the bytes or beside the listing.
* §6.8 — the listing is registered, `get_artifact_lineage` shows one entry, a second
  identical run returns the same id with one entry still, the description reads back
  `Bytes 0..255 of block.bin … running at $C000-$C0FF`, and a payload registered over
  those bytes is linked.

### §8.1 §6.2's negative fixture is not the one the spec asked for

**The gate asked for:** "a deliberately data-filled range reports the divergence with
its offset instead of claiming success."

**Why it does not happen.** This renderer is byte-identical over arbitrary data by
construction: an opcode it does not know renders as `.byte $XX`, an undocumented one
renders as its bytes, an absolute instruction with a zero-page operand is forced wide
with `.abs`, and an instruction truncated at the end of the block renders as the bytes
that are left. 256 bytes of pseudo-random data disassembled and reassembled to the same
256 bytes; so did a branch into the middle of another instruction (`bne WC002+2`). Data
misread as code is exactly the failure a rebuild proof cannot see — which is the
argument for reporting the verdict rather than refusing the listing, not against it.

**What was done instead of a workaround.** The negative fixture is a range that
genuinely cannot round-trip, and it is a real one: a relative branch whose target
wrapped below `$0000` (`10 80` at `$0010` → `$FF92`). The decoder wraps at 16 bits, the
assembler refuses the distance, and the verdict now reads `WARNING: rebuild assembler
exited 1; this listing is not byte-identical with wrap.bin bytes 0..4 — Error: relative
address is illegal (jump distance is too far: 65408)`. The listing is still written and
still handed over, as §2 requires. The offset-divergence branch is kept and is what a
window comparison uses; it simply is not reachable from a data block.

### §8.2 Left out, and why

* **Relocated rendering** stays Spec 741's, as §5 says. `load_address` is where the
  bytes run; a caller who wants a second view runs the tool again.
* **`space` and `bank`** are recorded with the provenance and nothing more. Keying a
  graph node into a bank needs the graph importer, which is `disasm_prg`'s annotation
  door, and inventing a second one here would be the parallel implementation §5
  forbids.
* **No analysis is ever run.** `analyze_prg` classifies; handed its JSON this renders
  segment-aware, and without one the listing says in its own header that it read every
  byte as code.
* **TRX64: no change.**
