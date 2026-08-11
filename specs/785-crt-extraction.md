# Spec 785 — CRT Extraction: LoaderModel + Trace Validation (cartridge pendant of 784)

**Status:** READY 2026-08-11 — unblocked by real samples (see §3.1). Nothing built yet.
**Repos:** cross-repo — Part A = TRX64 (`../TRX64`), Parts B/C = C64RE.
**Number:** 785 (shared board `specs/README.md`). **Pendant of** Spec 784.

---

## 1. Relationship to 784 (most of it is REUSE)

Spec 784 is the **abstract, medium-agnostic extraction tooling** (manifest →
register with full spans+derivedBy+coverage + loader-lens validate), built + proven
on **disk**. 785 is **not a second tooling** — it is the **cartridge proof surface**
of the *same* tooling: the `+$DE00` banking lane in the loader-scoped capture, cart
LoaderModel records, and the real-sample harness (Lykia + Mike's CRTs). Because
everything **above the block layer is uniform**, the bulk of 784 is reused unchanged:

| 784 deliverable | cart status |
|---|---|
| A2 loader-lens landing-map — source is a union `{track,sector} \| {bank,offset}` | **already emits `{bank,offset}`** → cart works on the TRX64 side |
| B1 manifest contract — spans are `sector{…} \| slot{bank,slot,offset,length}` | **already has slot spans** |
| B2 `register_payloads_from_manifest` | **already handles slot spans** |
| B3 LoaderModel record — `kind ∈ dos \| custom-fastloader \| cart-lut` | **already has `cart-lut`** |
| B4 `validate_extraction` — diffs manifest spans/dest vs landing-map | **medium-agnostic** |
| coverage (`medium-coverage.ts` cart branch) | **already uniform** |

So 785 = the **cart-specific delta + real-sample proof**, not a re-spec.

## 2. Cart specifics (blocks + physics)

- **Blocks = bank-slices:** ROML (`$8000–9FFF`), ROMH (`$A000–BFFF`, ultimax
  `$E000–FFFF`), per bank. Banks exist **physically incl. empty `$ff`-erased
  flash** — VICE drops empty banks from the `.crt` to save space; model as empty,
  not absent (already in `MediumLayout.empty[]` reason `flash-empty-ff`).
- **Physics (block-read) = chip/flash read** — already faithful in TRX64 (Spec
  713 cart families). No tolerant-CRC problem like GCR. The delta is bank/slot
  addressing + ultimax + the **banking register** (`$DE00` EF / GMOD3 / … writes).

## 3. Cart LoaderModels (the variable part — **INPUT NEEDED**)

The chaining/index for carts varies per title/loader:
- **Simplified cross-bank loader** (Mike's): byte-exact packed across banks.
- **LUT-in-a-bank:** a table maps logical file/asset → `bank + offset`.
- Others differ.

### 3.1 Samples arrived 2026-08-11 — and the scheme is readable, not secret

Two 1 MB raw images of the **same game** in **two different mappers**
(`gp_cars_ptv_c64megacart[ptv].bin`, `gp_cars_ptv_megab8r[ptv].bin`). That pairing is
worth more than either alone: 128 banks each, 21 occupied, 107 `$ff`-erased — and only
**335 bytes differ, in 2 banks**. The payload is identical; only the banking code moves.
So the container can be separated from the content by diff, without a vendor explaining
anything.

What the diff already answers, disassembled with our own `trx64cli disasm`:

```
$8873  78        SEI
$8874  a9 37     LDA #$37
$8876  85 01     STA $01
$8878  a9 00     LDA #$00
$887a  8d 00 df  STA $df00     ← C64MegaCart
       8d 02 de  STA $de02     ← MegaByter
$887d  a9 00     LDA #$00
$887f  8d 00 de  STA $de00     ← both
$8882  20 f9 85  JSR $85f9
```

`$de00` takes the **bank number** in both (`$8888: STX $de00`, X from the zero-page bank
variable `$f0`). The second register is where the mappers part: MegaByter `$de02`,
C64MegaCart `$df00`.

This also gives the open **MegaByter bank-width question** (7 vs 8 bits) something real to
measure against instead of a question to the vendor: 1 MB = 128 banks needs 7 bits, and
the bank travels as a whole byte from zero page into `$de00`.

**Handling:** the samples are Protovision's, treated like the ROMs — analysed locally,
never committed, never in an artifact.

**Note on format:** these are raw `.bin`, not `.crt`. TRX64 attaches them via the typed
`.bin` path (Spec 790), so the harness below should say `.bin | .crt`, not `.crt` alone.

**Still open from the original blocker:** the LUT-in-a-bank variant. These two samples are
the cross-bank packer shape; a LUT title has not been seen. **GMod3: no sample exists at
all** — that gap belongs to TRX64 803, not here.

## 4. Deliverables (delta over 784)

### Part A — TRX64 (capability)
**A1′ — Cart banking lane in the loader-scoped capture.** Ensure the loader-lens
capture (784 A1/A2) includes the **bank-select lane** (`$DE00`/`$DF00` writes +
ROML/ROMH reads) so the landing-map `source: {bank,offset}` is correct across
bank switches. Likely a small domain addition to the loader capture profile.
*AC:* on a multi-bank CRT, landing-map source bank tracks the active bank across
a `$DE00` bank-switch.

### Part B — C64RE (meaning)
**B1′ — Cart LoaderModel records** (`cross-bank-packer` / `cart-lut`) with the
banking scheme + backing disasm. Reuses 784 B3.
**B2′ — Real-sample harness.** A real Mike CRT through the loop end-to-end:
per-project Python extractor → manifest → `validate_extraction` against the
loader-lens → `register_payloads_from_manifest` with `derivedBy`.
*AC:* a real Mike CRT reaches coverage-complete with per-payload `derivedBy`.

### Part C — Doctrine
**C1′ — Cart boot-chain doctrine.** Extend the crawl for carts: a cart boots via
its **cold-start / reset vector at `$8000`** (or ultimax reset vector), so the
"stub" = the cart's own reset/init in ROML bank 0; the loader table/LUT lives in
a bank. Follow it the same way (disasm → author extractor → trace-validate →
register). Reuses 784 C1 shape.

## 5. Non-goals
Same as 784 — no generic resolver; emulation = validation-only.

## 6. Open input (user-provided, before build)
- Concrete cart loader schemes (Mike's cross-bank packer; LUT layout).
- Real `.crt` samples (GMOD3 / C64MegaCart from Mike) for the harness.
- Cart-family order (EF / GMOD3 / MegaCart first?).

*User said: "Ich helfe dir dann beim aufbau mit Input" — this skeleton is the
frame; the §3/§6 blanks are filled with that input before the build loop starts.*
