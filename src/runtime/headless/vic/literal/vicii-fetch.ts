// Spec 298c — LITERAL port of viciisc/vicii-fetch.c.
//
// Source: /Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-fetch.c
//
// PORT RULES (Spec 298): same function names, same control flow,
// same fetch addressing rules. NO refactoring.
//
// External dependencies (= injected at integration in 298k):
//   export.ultimax_phi1 / phi2          — cartridge banking flag
//   ultimax_romh_phi1_read / phi2_read  — cartridge ROMH access
//   mem_chargen_rom_ptr                 — char ROM pointer (4KB)
//   mem_color_ram_vicii                 — color RAM (1KB, low nibble)
//   reg_pc                              — CPU PC (= prefetch_cycles fallback)
//
// For now these are exposed via a `host` adapter object so smokes can
// inject synthetic memory without dragging the full bus in. Adapter
// is the literal-equivalent of VICE's compile-time `extern uint8_t *`
// + global function symbols.

import { vicii, type vicii_t } from "./vicii-types.js";
import {
    cycle_get_sprite_ba_mask, cycle_get_sprite_num,
    cycle_is_sprite_ptr_dma0, cycle_is_sprite_dma1_dma2,
} from "./vicii-chip-model.js";

/* ============================================================
 * Host memory access adapter (= VICE's mem_chargen_rom_ptr +
 * export.ultimax_phi1 + reg_pc + mem_color_ram_vicii globals).
 * ============================================================ */

export interface FetchHost {
    /** mem_chargen_rom_ptr (= 4KB char ROM, indexed by addr & 0xfff). */
    mem_chargen_rom_ptr: Uint8Array;
    /** mem_color_ram_vicii (= 1KB, low nibble of each byte). */
    mem_color_ram_vicii: Uint8Array;
    /** export.ultimax_phi1 — cartridge replaces VIC bank Φ1 reads. */
    export_ultimax_phi1: number;
    /** export.ultimax_phi2. */
    export_ultimax_phi2: number;
    /**
     * ultimax_romh_phi1_read(addr) — returns BYTE if cart serves the
     * read, else null (= fall through to RAM/chargen).
     */
    ultimax_romh_phi1_read: (addr: number) => number | null;
    ultimax_romh_phi2_read: (addr: number) => number | null;
    /** reg_pc — CPU PC at this moment (= prefetch_cycles fallback). */
    reg_pc: number;
}

/* Default adapter — empty cart, zero PC, empty char/color RAM. Used
 * before integration; tests / VicIIVice wiring replace via setHost. */
let host: FetchHost = {
    mem_chargen_rom_ptr: new Uint8Array(0x1000),
    mem_color_ram_vicii: new Uint8Array(0x400),
    export_ultimax_phi1: 0,
    export_ultimax_phi2: 0,
    ultimax_romh_phi1_read: () => null,
    ultimax_romh_phi2_read: () => null,
    reg_pc: 0,
};

export function setFetchHost(h: FetchHost): void {
    host = h;
}

/*-----------------------------------------------------------------------*/

/* vicii-fetch.c:50 */
function fetch_phi1(addr: number): number {
    let p: Uint8Array;
    let off: number;

    addr = ((addr + vicii.vbank_phi1) & vicii.vaddr_mask_phi1) | vicii.vaddr_offset_phi1;

    if (host.export_ultimax_phi1) {
        const value = host.ultimax_romh_phi1_read((0x1000 + (addr & 0xfff)) & 0xffff);
        if (value !== null) {
            if ((addr & 0x3fff) >= 0x3000) {
                return value & 0xff;
            } else {
                p = vicii.ram_base_phi1;
                off = addr;
                return p[off]! & 0xff;
            }
        }
    }

    if ((addr & vicii.vaddr_chargen_mask_phi1) === vicii.vaddr_chargen_value_phi1) {
        p = host.mem_chargen_rom_ptr;
        off = addr & 0xfff;
    } else {
        p = vicii.ram_base_phi1;
        off = addr;
    }
    return p[off]! & 0xff;
}

/* vicii-fetch.c:76 */
function fetch_phi2(addr: number): number {
    let p: Uint8Array;
    let off: number;

    addr = ((addr + vicii.vbank_phi2) & vicii.vaddr_mask_phi2) | vicii.vaddr_offset_phi2;

    if (host.export_ultimax_phi2) {
        const value = host.ultimax_romh_phi2_read((0x1000 + (addr & 0xfff)) & 0xffff);
        if (value !== null) {
            if ((addr & 0x3fff) >= 0x3000) {
                return value & 0xff;
            } else {
                p = vicii.ram_base_phi2;
                off = addr;
                return p[off]! & 0xff;
            }
        }
    }

    if ((addr & vicii.vaddr_chargen_mask_phi2) === vicii.vaddr_chargen_value_phi2) {
        p = host.mem_chargen_rom_ptr;
        off = addr & 0xfff;
    } else {
        p = vicii.ram_base_phi2;
        off = addr;
    }
    return p[off]! & 0xff;
}

/*-----------------------------------------------------------------------*/

/* vicii-fetch.c:105 */
function check_sprite_dma(i: number): number {
    return vicii.sprite_dma & (1 << i);
}

/* vicii-fetch.c:110 */
function sprite_dma_cycle_0(i: number): void {
    let sprdata = vicii.last_bus_phi2;

    if (check_sprite_dma(i)) {
        if (!vicii.prefetch_cycles) {
            sprdata = fetch_phi2((vicii.sprite[i]!.pointer << 6) + vicii.sprite[i]!.mc);
        }

        vicii.sprite[i]!.mc++;
        vicii.sprite[i]!.mc &= 0x3f;
    }

    vicii.sprite[i]!.data &= 0x00ffff;
    vicii.sprite[i]!.data |= (sprdata << 16) >>> 0;
    vicii.sprite[i]!.data >>>= 0;
}

/* vicii-fetch.c:133 */
function sprite_dma_cycle_2(i: number): void {
    let sprdata = vicii.last_bus_phi2;

    if (check_sprite_dma(i)) {
        if (!vicii.prefetch_cycles) {
            sprdata = fetch_phi2((vicii.sprite[i]!.pointer << 6) + vicii.sprite[i]!.mc);
        }

        vicii.sprite[i]!.mc++;
        vicii.sprite[i]!.mc &= 0x3f;
    }

    vicii.sprite[i]!.data &= 0xffff00;
    vicii.sprite[i]!.data |= sprdata;
    vicii.sprite[i]!.data >>>= 0;
}

/*-----------------------------------------------------------------------*/

/* vicii-fetch.c:158 */
function v_fetch_addr(offset: number): number {
    return ((vicii.regs[0x18]! & 0xf0) << 6) + offset;
}

/* vicii-fetch.c:163 */
function g_fetch_addr(mode: number): number {
    let a: number;

    /* BMM */
    if (mode & 0x20) {
        a = (vicii.vc << 3) | vicii.rc;
        a |= (vicii.regs[0x18]! & 0x8) << 10;
    } else {
        a = (vicii.vbuf[vicii.vmli]! << 3) | vicii.rc;
        a |= (vicii.regs[0x18]! & 0xe) << 10;
    }

    /* ECM */
    if (mode & 0x40) {
        a &= 0x39ff;
    }

    return a & 0xffff;
}

/* vicii-fetch.c:184 */
function is_char_rom(addr: number): number {
    addr = ((addr + vicii.vbank_phi1) & vicii.vaddr_mask_phi1) | vicii.vaddr_offset_phi1;
    return (addr & vicii.vaddr_chargen_mask_phi1) === vicii.vaddr_chargen_value_phi1 ? 1 : 0;
}

/*-----------------------------------------------------------------------*/

/* vicii-fetch.c:192 */
export function vicii_fetch_matrix(): void {
    if (vicii.prefetch_cycles) {
        vicii.vbuf[vicii.vmli] = 0xff;
        vicii.cbuf[vicii.vmli] = vicii.ram_base_phi2[host.reg_pc]! & 0xf;
    } else {
        vicii.vbuf[vicii.vmli] = fetch_phi2(v_fetch_addr(vicii.vc));
        vicii.cbuf[vicii.vmli] = host.mem_color_ram_vicii[vicii.vc]! & 0xf;
    }
}

/* vicii-fetch.c:203 */
export function vicii_fetch_refresh(): number {
    return fetch_phi1(0x3f00 + (vicii.refresh_counter--));
}

/* vicii-fetch.c:208 */
export function vicii_fetch_idle(): number {
    return fetch_phi1(0x3fff);
}

/* vicii-fetch.c:213 */
export function vicii_fetch_idle_gfx(): number {
    let data: number;
    let reg11: number;

    if (vicii.color_latency) {
        reg11 = vicii.regs[0x11]!;
    } else {
        reg11 = vicii.reg11_delay;
    }

    if (reg11 & 0x40) {
        data = fetch_phi1(0x39ff);
    } else {
        data = fetch_phi1(0x3fff);
    }
    vicii.gbuf = data;

    return data;
}

/* vicii-fetch.c:234 */
export function vicii_fetch_graphics(): number {
    let data: number;
    let addr: number;

    if (vicii.color_latency) {
        addr = g_fetch_addr((vicii.regs[0x11]! | (vicii.reg11_delay & 0x20)) & 0xff);

        if ((vicii.regs[0x11]! ^ vicii.reg11_delay) & 0x20) {
            /* 6569 fetch magic! (FIXME: proper explanation)
               When changing from RAM to (char)ROM fetches, the LSB of the
               fetch address is (apparently) latched using the mode from
               the previous cycle, and the upper bits come from the current
               mode, due to ...

               TODO: test with $d018 splits and fix above test if needed.
            */
            const addr_from = g_fetch_addr(vicii.reg11_delay);
            const addr_to   = g_fetch_addr(vicii.regs[0x11]!);

            if (!is_char_rom(addr_from) && is_char_rom(addr_to)) {
                addr = (addr_from & 0xff) | (addr_to & 0x3f00);
            }
        }
    } else {
        addr = g_fetch_addr(vicii.reg11_delay);
    }

    data = fetch_phi1(addr);
    vicii.gbuf = data;

    vicii.vmli++;

    vicii.vc++;
    vicii.vc &= 0x3ff;

    return data;
}

/* vicii-fetch.c:275 */
export function vicii_fetch_sprite_pointer(i: number): number {
    vicii.sprite[i]!.pointer = fetch_phi1(v_fetch_addr(0x3f8 + i));
    return vicii.sprite[i]!.pointer;
}

/* vicii-fetch.c:282 */
export function vicii_fetch_sprite_dma_1(i: number): number {
    let sprdata: number;

    if (check_sprite_dma(i)) {
        sprdata = fetch_phi1((vicii.sprite[i]!.pointer << 6) + vicii.sprite[i]!.mc);

        vicii.sprite[i]!.mc++;
        vicii.sprite[i]!.mc &= 0x3f;
    } else {
        sprdata = vicii_fetch_idle();
    }

    vicii.sprite[i]!.data &= 0xff00ff;
    vicii.sprite[i]!.data |= (sprdata << 8) >>> 0;
    vicii.sprite[i]!.data >>>= 0;

    return sprdata;
}

/* vicii-fetch.c:301 */
export function vicii_check_sprite_ba(cycle_flags: number): number {
    if (vicii.sprite_dma & cycle_get_sprite_ba_mask(cycle_flags)) {
        return 1;
    }
    return 0;
}

/* vicii-fetch.c:309 */
export function vicii_fetch_sprites(cycle_flags: number): void {
    let s: number;

    if (cycle_is_sprite_ptr_dma0(cycle_flags)) {
        s = cycle_get_sprite_num(cycle_flags);
        sprite_dma_cycle_0(s);
    }

    if (cycle_is_sprite_dma1_dma2(cycle_flags)) {
        s = cycle_get_sprite_num(cycle_flags);
        sprite_dma_cycle_2(s);
    }
}

/* Internal: expose fetch_phi1 / fetch_phi2 so other literal-port
 * modules (vicii-cycle.ts) can call them. VICE has them as static
 * inline; we expose at module level since TS doesn't have inline. */
export { fetch_phi1, fetch_phi2 };
