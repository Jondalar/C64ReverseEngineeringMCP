# Spec 828 — The reference covers RAM vectors and zero page, and a miss says why

**Status:** BUILT 2026-09-06 — gate `npm run e2e:828` 22/0, hermetic (no network, no
snapshot); `gates.yml` green
**Origin:** Issue #10 (mrr19121970): `c64ref_lookup` returns nothing for `$0291` and
`$0328`, so every caller falls back to reading sta.c64.org by hand. The proposal was to
have the tool fetch those pages itself.
**Anchor:** Spec 817's c64ref parsers (memory map + symbols), ported here verbatim ·
`DOCTRINE.md` rule 5 (read before you hypothesise)
**Touches:** `src/c64ref-rom-knowledge.ts` (the 817 parser widening) ·
`src/server-tools/reference.ts` (`c64ref_lookup`'s miss path) ·
`scripts/e2e-828-reference-coverage.mjs` (new)

## 1. What exists today, measured

The gap is real and the reported symptom is exact. The cause is not.

`c64ref_lookup` reads a local snapshot built by `c64ref_build_rom_knowledge`, which
fetches its sources from mist64/c64ref once and caches the result. On master that source
list was **ROM only** — the BASIC and KERNAL disassembly pages plus the KERNAL API. The
c64ref repository also carries eight memory-map pages (`src/c64mem/*.txt`: Mapping the
C64, the Programmer's Reference Guide, 64 intern, STA, 64'er, Butterfield, 64MAP, the ROM
source map) and a symbol table, and none of them were parsed.

`$0291` and `$0328` are not ROM. They are a flag and a vector in low RAM, documented in
exactly those memory-map pages. So the tool answered honestly for what it had, and what
it had was half the reference.

Verified rather than assumed: the maintainer's own snapshot — built on 2026-09-05 with
the widened parser that Spec 817 wrote for the platform store — holds 8 083 entries,
228 of them below `$0400`, including `$0291 MODE` and `$0328 ISTOP`. The data was
already reachable; only master's builder could not see it.

## 2. Decisions

**D1 — Port 817's parser widening to master, verbatim.** `C64REF_SOURCE_SPECS` gains the
eight `memory_map` specs and the symbol source; `parseMemoryMap` and `parseSymbols` come
across unchanged. The file is now **byte-identical to the branch's**, so when the
knowledge-graph branch lands there is nothing to reconcile.

**D2 — A miss explains itself.** An empty answer is what sent the caller to a browser.
`c64ref_lookup` now reads the snapshot's own `sourceFiles[].kind` and says which of two
situations it is in:

- *ROM-only snapshot* — names the coverage and the build date, says that RAM vectors and
  zero page are absent, and that one `c64ref_build_rom_knowledge` fixes it. When the
  address asked for is below `$0400` it says so explicitly, because that is the case
  where the user is otherwise certain the tool is broken.
- *Full snapshot* — says the address is genuinely not documented upstream, so the caller
  stops looking; and for low RAM points at `save_finding` / `list_findings`, because a
  game-specific meaning at `$0291` is project knowledge, not reference knowledge.

The same explanation is given for a query that finds nothing.

**D3 — No fetch at lookup time. The issue's proposal is declined, on purpose.** Building
the snapshot fetches once, explicitly, when a human asks for it; that is a build step and
it stays. A *lookup* that reaches for sta.c64.org would mean the answer to "what is at
`$0291`" depends on the network, a DNS entry and somebody else's uptime — an offline
session would get a different answer than an online one, and a reverse-engineering
workbench cannot have that property for a fact. The three pages named in the issue are in
the same upstream that `c64ref_build_rom_knowledge` already reads.

**D4 — PETSCII and colour tables are out of scope here.** The issue also asks for
`cbm64pet.html` and `cbm64col.html`. Those are not address lookups, and they are exactly
what a BASIC detokenizer needs to render control codes. They belong to that work, as a
bundled table, not to this spec.

## 3. Gate

`scripts/e2e-828-reference-coverage.mjs` (`npm run e2e:828`), hermetic — the fix exists
because a lookup must not depend on the network, so a gate that fetched would contradict
the spec it guards:

- the source list carries the `c64mem` memory-map specs, no duplicate ids;
- a ROM-only and a full snapshot are told apart by `sourceFiles[].kind`;
- the miss path names the rebuild for a ROM-only snapshot, says "genuinely not
  documented" for a full one, and points at `save_finding` for low RAM;
- every `fetch(` in the knowledge module sits inside `fetchSourceText`, the build path;
  the lookup tool has none — asserted against the **code**, with the comments stripped,
  since the comments necessarily mention sta.c64.org to record why it was declined;
- `$0291` → MODE and `$0328` → ISTOP resolve once the memory map is in the snapshot, and
  an address nobody documents still misses.

## 4. Acceptance

- A snapshot rebuilt on master answers `$0291` and `$0328`.
- A caller with an old snapshot is told to rebuild instead of being handed an empty line.
- No lookup path touches the network.
- `e2e:828` green; `gates.yml` green.

## 5. Non-goals

- The PETSCII / colour tables (D4).
- Any lookup-time fetching, from sta.c64.org or anywhere else (D3).
- Rebuilding anyone's snapshot automatically: `auto_build` already exists and stays
  opt-in, because the build reaches the network and that must remain a decision.
