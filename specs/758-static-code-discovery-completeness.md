# Spec 758 — Static code-discovery completeness (indirect dispatch · self-mod operands · coherence code/data split)

**Status:** §3.1 + §3.2 DONE (2026-06-06, gate `e2e:758` 4/4). §3.3 largely
PRE-EXISTING; §4 = follow-up.
- **§3.1 + §3.2 DONE:** `code-discovery.ts` runs recursive descent to a FIXED POINT
  — after the flow queue drains, `recoverSeeds()` resolves single indirect
  `jmp ($abs)` pointers and self-modified `jmp`/`jsr` operands (`lda #lo/sta J+1/
  lda #hi/sta J+2`), queues those EXACT targets, and descends again. Rebuild-safe
  (exact jump targets, no speculative promotion). Gate: self-mod + indirect
  fixtures resolve with no trace seed. (NMOS has no `jmp ($tbl,x)` — the NMOS
  table dispatch is the `lda tbl,x/sta vec/jmp (vec)` shape, a §4 follow-up.)
- **§3.3 ASSESSMENT:** the code/data classifier (`probable-code.ts` `probeIsland`)
  is already a STRUCTURAL coherence scorer, not the naïve opd threshold the spec
  feared — it requires a structured ending (rts/rti/jmp), inbound refs, caps the
  illegal-opcode ratio, and needs hardware-touch or control-flow+store evidence.
  The Ranger 14 KB opd≈0.6 data is rejected by these already. So §3.3's core is in
  place; the open refinement is the §4 known-routine signal below.
- **§4 FOLLOW-UP (open):** feed the cross-artifact known-routine map (Spec 759's
  `resolveCrossArtifact`/`resolveAbi`) into the island scorer as a coherence
  POSITIVE (a region whose `jsr`/`jmp` resolve to engine `api_*` is code), and seed
  installed callback vectors. Best validated on the real Wasteland overlays; carries
  rebuild-safety risk (must not loosen acceptance), so deferred from this slice.

PROPOSED (2026-06-04)
**Scope:** `pipeline/src/analysis/code-discovery.ts` (recursive-descent traversal +
xref derivation) and the code/data segmentation it feeds. This is the **discovery
side** of the phase-1 disassembler — it decides *which bytes are code* and *where
the code/data boundary is*. It is the companion to **Spec 720** (render side:
labels/boxes/comments given a known split).
**Filed by:** Wasteland_EF crack (consuming project) — handoff, not a runtime edit.
**Reference (grounded, measured 2026-06-04):** the Wasteland_EF in-game/COMBAT
overlay + Char-Creation/RANGER overlay disassembly session, and the standalone
recursive-descent prototype `tools/wl_disasm.py` in that project (the evidence
behind every claim below). See §1.
**Cross-links:** Spec 720 (Disassembly Output Quality — the render side; its §11
deliberately scopes "new analysis passes" OUT, *this* spec is that out-of-scope
discovery work, filed separately), Spec 752 (extract-first grounding — *what a
block is* comes from the extracted bytes), Spec 751 (effective-segments overlay —
the structural code/data layer this produces), Spec 711 (code/data overlay +
intervention — consumes a correct split), Spec 721 (runtime-informed annotation —
the trace as a *helper* seed, never required), Spec 726.B / 708 (the trace store
that supplies optional seed PCs).

## 0. Principle (user, from Wasteland testing)
> "Du brauchst NICHT immer einen Trace — bei Accolade hatten wir auch so gut wie
> keine. Das Rangercamp-Overlay bekommst Du 100% auch so auseinander."

Disassemble modules **statically**. A trace is a **helper** (extra entry-point
seeds for computed targets static analysis can't resolve), **never a requirement**.
The combat/Ranger work proved a trace-seeded path papers over two real static gaps
(indirect dispatch, self-modified call sites) and that the third lever — code/data
separation — was being done with the **wrong classifier** (opcode-density). Fix the
analyzer; the trace becomes optional.

## 1. The evidence (Wasteland_EF, measured 2026-06-04)

| Module | How disassembled | Result | What it proves |
|---|---|---|---|
| in-game/COMBAT overlay ($7E00, T27-31) | recursive-descent + **trace-seeded** PCs (`wl_disasm.py`) | 58% code, 4960 instr, **0 undef** | recursive-descent is *accurate* (no false code) but only reaches FLOW-connected code; the seeds it needed were the indirect-dispatch + self-mod targets (§3.1/§3.2) |
| Char-Creation/RANGER overlay ($7E00, T23-27) | recursive-descent **static only**, no trace | **18% code = COMPLETE**; remaining 82% (14 KB) is data | the static path is sufficient when there is no computed dispatch; and the 82% "looks like code" trap (§3.3) is real |

The Ranger 14 KB region has **opcode-density ≈ 0.6** — by an opd threshold it reads
as code. Linear-disassembling it (samples at $B127, $BE86, $9502) produces
**incoherent garbage**: scattered `???` undef opcodes, nonsense operands
(`dec $F57E,x`, `and $BA5E`), BRK-heavy runs, no flow. It **is** data
(char-creation tables / strings / charset). The recursive-descent 18% **was** the
complete code. An opd classifier would have mis-promoted 14 KB of data to code; the
**coherence test** (§3.3) classifies it correctly.

Cost of the gap: the combat overlay needed a live trace only because the analyzer
could not follow its menu/command dispatch table and its self-modified loader call
sites statically. Close §3.1+§3.2 and that trace is no longer needed.

## 2. Current behaviour (recursive-descent)
Recursive-descent from entry point(s), following `jsr`/`jmp`/branch transitively.
**Accurate** (emits no false code) but covers only FLOW-reachable code. It misses:
- targets reached through an **indirect jump** (`jmp ($table,x)`, `jmp ($zp)`),
- targets reached through a **self-modified** `jsr`/`jmp` operand,
- and it has no principled way to classify the **unreached remainder** as code vs
  data — the naïve fallbacks (linear-sweep everything, or an opd threshold) both
  fail (§3.3).

## 3. Required improvements

### 3.1 Indirect-jump dispatch resolution
Detect dispatch sites — `jmp ($table,x)`, `jmp ($zp)`, `jsr`-through-vector — and
recover their target table:
- a **run of in-range 16-bit little-endian pointers** at the indexed base, or
- the bytes the vector ZP is loaded from (`lda #lo`/`lda #hi` → `sta zp`/`sta zp+1`).

Seed **every table entry** as a code entry point. Wasteland overlays use exactly
this: the Ranger "Create / Delete / Start" menu and the in-game command-bar both
dispatch through indexed pointer tables.

### 3.2 Self-modified jsr/jmp operand tracking
Find `lda #imm` / `lda src` followed by `sta <operand_addr>` where `<operand_addr>`
is the operand byte(s) of a `jmp`/`jsr` instruction; resolve the stored value → the
real target; seed it. Wasteland overlays self-modify both their dispatch and their
loader call sites (e.g. the `$28A4`-style overlay-load setup reads the descriptor
record at $5A03-$5A05 then patches the load address into a `jsr`). For values that
static analysis genuinely cannot resolve (computed at runtime), **fall back to
trace PCs as extra seeds** — helper only, and only when a trace exists.

### 3.3 Code/data separation by the COHERENCE test — NOT an opd threshold
**opd (fraction of bytes that decode to a valid opcode) is MISLEADING.** Data tables
full of `$00` (= `BRK`) plus incidental valid opcodes show opd ≈ 0.6–0.8 —
indistinguishable from real code by threshold alone (§1 Ranger: 14 KB of data at
opd ≈ 0.6). Replace the threshold with the **coherence test** on each candidate
region:

- **CODE** = sensible instruction flow; `jsr`/`jmp` to **known** routines
  (cross-referenced against the resident engine block + the module's own resolved
  labels); branches landing on instruction boundaries; few/no undef opcodes; no
  long BRK runs.
- **DATA** = scattered `???` undef opcodes; nonsense operands; BRK-heavy runs; no
  coherent flow; targets pointing into the middle of other instructions or
  out of range.

Iterate to a fixed point: coherence-classify the unreached remainder, linear-sweep
+ seed the regions judged CODE, label the regions judged DATA as
strings/charset/tables, repeat until stable.

## 4. Cross-module reference (the key insight that finds the missed entries)
For overlay-style modules, keep the **resident engine block** open as the reference.
Wasteland overlays "springen da dauernd hin": they constantly call the engine
through a fixed `api_XXXX` jmp-table ($0200-$04FF in Wasteland), and the engine
calls **back** into the overlay through **callback vectors** the overlay installs
(e.g. a menu/`$40`-`$41` handler vector). Two concrete levers this gives §3.1/§3.2:
- (a) resolve where the overlay **stores** those callback vectors → the stored
  addresses are overlay handler **entry points** the recursive-descent never
  reaches from the module entry → seed them;
- (b) a `jsr` whose target is in the engine's `api_` range is a **known** routine —
  it is strong positive evidence for the coherence test in §3.3 (a region full of
  `jsr api_*` to real engine entries is code; random `jsr` into instruction
  midpoints is data).

Generalised: the analyzer should accept an **external known-routine map** (the
engine/library symbol table, or a sibling already-disassembled block) and treat
calls into it as coherence-positive + use installed-vector stores as extra seeds.

## 5. Process per module (the contract this enables)
1. **Extract the resident image first** (Spec 752). Overlays load
   interleaved/self-mod, so the disk-sector image disassembles wrong — use the
   RAM-as-it-lands image (replay writes / trace-RAM reconstruction). Flat CBM PRGs
   use the file image directly.
2. **Recursive-descent** from entry + **(3.1)** dispatch tables + **(3.2)** self-mod
   targets + (helper, optional) trace PCs.
3. **Coherence-classify** the remainder (§3.3): code → linear-sweep + seed; data →
   label as strings/charset/tables. Iterate to fixed point.
4. Render (Spec 720) into the `.asm`; the curated copy is annotated by hand
   (Spec 756).

## 6. Acceptance
1. **Indirect dispatch resolved.** On a fixture with a `jmp ($tbl,x)` over an N-entry
   pointer table, all N targets are discovered as code without any trace seed.
2. **Self-mod resolved.** On a fixture that does `lda #lo / sta J+1 / lda #hi /
   sta J+2 / J: jmp $0000`, the patched target is discovered without a trace seed.
3. **Coherence beats opd.** On the Wasteland Ranger overlay image, the 14 KB
   opd≈0.6 region is classified **DATA** (not promoted to code); recursive-descent's
   18% remains the complete code set — matching the hand-verified result.
4. **Combat overlay, no trace.** The in-game/COMBAT overlay reaches its trace-seeded
   coverage (≈58% code, 0 undef) from the **static** path alone once §3.1+§3.2 land
   — the trace becomes a cross-check, not a requirement.
5. **No false code / byte-identical rebuild stays green.** Discovery changes which
   bytes are code, never the bytes — Spec 720 §10.1 `cmp -l` gate stays 0-diff for
   all existing test PRGs.
6. **External known-routine map honoured.** Given the engine symbol table, calls
   into it are coherence-positive and installed callback vectors are seeded (§4).

## 7. Out of scope
- Render quality (labels/boxes/comments) — that is **Spec 720**.
- Narrative prose / hand annotation — **Spec 756** (in the curated `.asm`).
- Full self-mod *emulation* — only the `lda/sta`→operand pattern needed to recover a
  static call target; arbitrary computed control flow falls back to trace seeds.
- A new assembler dialect; the annotation schema.

## 8. Grounded prototype (reference implementation, in the consuming project)
`Wasteland_EF/tools/wl_disasm.py` is a working recursive-descent 6502 disassembler
(§2 behaviour) with the `api_XXXX`/ZP/IO symbol resolution of §4 already wired. It
is the **evidence + reference shape** for §3.1/§3.2/§3.3 — NOT a request to port
Python into the pipeline. The pipeline's `code-discovery.ts` already owns recursive
traversal + xref; this spec adds the three levers above to it. (The Wasteland team
will keep `wl_disasm.py` as its local tool regardless; this spec is the request to
make the *product* analyzer reach the same completeness so consuming LLMs get it for
free.)

## 9. References
- `pipeline/src/analysis/code-discovery.ts` — recursive traversal + xref derivation
  (the analyzer this spec extends).
- `pipeline/src/lib/prg-disasm.ts` — renderer (Spec 720; consumes the split).
- Spec 720 §11 — "do NOT add analyzers" (render-only scope) → this spec is the
  analyzer work it deferred.
- Spec 752 — extract-first grounding (the resident-image prerequisite, §5.1).
- Spec 751 — effective-segments overlay (the code/data structural layer §3.3 feeds).
- Grounded evidence: `Wasteland_EF/tools/wl_disasm.py`,
  `Wasteland_EF/disasm/combat_overlay_7E00.asm` (trace-seeded, 58%, 0 undef),
  `Wasteland_EF/disasm/char_ranger_overlay_7E00.asm` (static, 18% = complete).
