// Spec 296a-1 — VIC Φ1 fetch primitive (1:1 viciisc/vicii-fetch.c).
//
// Implements `fetch_phi1(addr)` mirror with bank base + char ROM
// overlay + ECM mask + ultimax-friendly call seam.
//
// VICE source:
//   src/viciisc/vicii-fetch.c:50-74  — fetch_phi1()
//   src/viciisc/vicii-fetch.c:178    — g_fetch_addr() ECM masks (& 0x39ff)
//   src/viciisc/vicii-fetch.c:265    — vicii_fetch_graphics() loads gbuf
//
// Three call shapes from the original:
//   fetchPhi1(state, addr) — generic Φ1 read, applies bank+chargen+ultimax
//   fetchIdle(state)       — Φ1 idle = fetchPhi1(state, 0x3fff)
//   fetchIdleGfx(state)    — Φ1 idle gfx; ECM-masked = fetchPhi1(state, 0x39ff),
//                            else fetchPhi1(state, 0x3fff). Caller stores in gbuf.
//
// The "idle bus = $FF" assumption made elsewhere is INCORRECT per VICE.
// Idle Φ1 reads RAM (or chargen / cart ROM) at $3FFF (or $39FF for ECM).
// $FF appears only in vicii_fetch_matrix() prefetch_cycles path
// (vbuf[vmli] = 0xff), which is a separate spec (296b).
//
// Ultimax handling shape kept thin: cartridge override hook is a
// callback so cartridge.ts wiring remains a separate concern.

type BYTE = number;
type WORD = number;

/**
 * Caller-provided VIC fetch context. Mirrors the subset of vicii_t
 * fields fetch_phi1 reads. All fields live on VicIIVice already; this
 * interface lets the function be called against any bag of state for
 * unit testing without dragging the full chip core in.
 */
export interface FetchPhi1Context {
  /** vicii.vbank_phi1 — Φ1 bank base ($0000/$4000/$8000/$C000). */
  vbank_phi1: number;

  /**
   * vicii.vaddr_mask_phi1 — wraps the addr inside the bank.
   * For C64 default = 0x3fff (= 16KB bank). C128 / Ultimax differ.
   */
  vaddr_mask_phi1?: number;

  /**
   * vicii.vaddr_offset_phi1 — added after masking.
   * For C64 default = 0. C128 uses non-zero for some banks.
   */
  vaddr_offset_phi1?: number;

  /** vicii.vaddr_chargen_mask_phi1 — overlay match mask. */
  vaddr_chargen_mask_phi1: number;

  /** vicii.vaddr_chargen_value_phi1 — overlay match value. */
  vaddr_chargen_value_phi1: number;

  /**
   * D011[6] sampled at start-of-cycle (= ECM bit). When set,
   * graphics fetch addresses are ANDed with $39ff in g_fetch_addr().
   * Idle gfx fetch uses the same mask.
   */
  ecmActive: boolean;

  /** Φ1 RAM read at the bank-mapped addr. Required. */
  readRamPhi1: (addr: WORD) => BYTE;

  /** Char ROM read at addr-low ($0000-$0FFF index into 4KB chargen). */
  readChargenRom: (addrLow12: WORD) => BYTE;

  /**
   * Optional ultimax / cart ROMH override. Returns BYTE if cartridge
   * overrides this Φ1 read. Mirrors VICE export.ultimax_phi1 + the
   * `addr & 0x3fff >= 0x3000` rule in fetch_phi1.
   * If undefined or returns null, falls through to normal mapping.
   */
  readUltimaxRomhPhi1?: (addr: WORD) => BYTE | null;
}

/**
 * Map an addr through Φ1 bank + offset rules.
 * Mirrors first 2 lines of fetch_phi1 (vicii-fetch.c:51-52).
 */
function mapPhi1Addr(ctx: FetchPhi1Context, addr: number): number {
  const mask = ctx.vaddr_mask_phi1 ?? 0x3fff;
  const offset = ctx.vaddr_offset_phi1 ?? 0;
  return (((addr + ctx.vbank_phi1) & mask) | offset) & 0xffff;
}

/**
 * VICE: fetch_phi1(addr).
 * Returns the Φ1 byte at addr after bank + chargen + ultimax mapping.
 */
export function fetchPhi1(ctx: FetchPhi1Context, addr: WORD): BYTE {
  const mapped = mapPhi1Addr(ctx, addr);

  // Ultimax override window: cart maps $1000-$1FFF when addr & 0x3fff
  // >= 0x3000. Mirrors vicii-fetch.c:60-67.
  if (ctx.readUltimaxRomhPhi1) {
    if ((mapped & 0x3fff) >= 0x3000) {
      const v = ctx.readUltimaxRomhPhi1(0x1000 + (mapped & 0x0fff));
      if (v !== null) return v & 0xff;
    }
  }

  // Char ROM overlay window: vbank 0 / vbank 2 (= $0000 / $8000 base)
  // map $1000-$1FFF to char ROM. The mask/value compare here mirrors
  // VICE's vaddr_chargen_mask_phi1 / vaddr_chargen_value_phi1 check
  // (vicii-fetch.c:69-71).
  if ((mapped & ctx.vaddr_chargen_mask_phi1) === ctx.vaddr_chargen_value_phi1) {
    return ctx.readChargenRom(mapped & 0x0fff) & 0xff;
  }

  // Default: read VIC's mapped Φ1 RAM byte.
  return ctx.readRamPhi1(mapped) & 0xff;
}

/**
 * VICE: vicii_fetch_idle().
 * Φ1 idle fetch = fetch_phi1($3fff). Caller does NOT store in gbuf.
 */
export function fetchIdle(ctx: FetchPhi1Context): BYTE {
  return fetchPhi1(ctx, 0x3fff);
}

/**
 * VICE: vicii_fetch_idle_gfx().
 * Φ1 idle graphics fetch = fetch_phi1($3fff), or $39ff with ECM.
 * Caller stores result in gbuf.
 */
export function fetchIdleGfx(ctx: FetchPhi1Context): BYTE {
  const addr = ctx.ecmActive ? 0x39ff : 0x3fff;
  return fetchPhi1(ctx, addr);
}
