# Spec 865 — Disassemble bytes at an address

**Status:** READY (2026-09-20)
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
