// Spec 298f / 298k step 1 — LITERAL port of viciisc/vicii-mem.c.
//
// Source: /Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-mem.c
//
// PORT RULES (Spec 298): same function names, same control flow,
// same comments, same side effects + derived state updates.

import { vicii, VICII_NUM_SPRITES } from "./vicii-types.js";
import { vicii_irq_set_line } from "./vicii-irq.js";
import { vicii_monitor_colreg_store } from "./vicii-draw-cycle.js";
import { cycle_is_check_spr_crunch } from "./vicii-chip-model.js";

/* Unused bits in VIC-II registers: these are always 1 when read.  */
const unused_bits_in_registers: number[] = [
    0x00 /* $D000 */, 0x00 /* $D001 */, 0x00 /* $D002 */, 0x00 /* $D003 */,
    0x00 /* $D004 */, 0x00 /* $D005 */, 0x00 /* $D006 */, 0x00 /* $D007 */,
    0x00 /* $D008 */, 0x00 /* $D009 */, 0x00 /* $D00A */, 0x00 /* $D00B */,
    0x00 /* $D00C */, 0x00 /* $D00D */, 0x00 /* $D00E */, 0x00 /* $D00F */,
    0x00 /* $D010 */, 0x00 /* $D011 */, 0x00 /* $D012 */, 0x00 /* $D013 */,
    0x00 /* $D014 */, 0x00 /* $D015 */, 0xc0 /* $D016 */, 0x00 /* $D017 */,
    0x01 /* $D018 */, 0x70 /* $D019 */, 0xf0 /* $D01A */, 0x00 /* $D01B */,
    0x00 /* $D01C */, 0x00 /* $D01D */, 0x00 /* $D01E */, 0x00 /* $D01F */,
    0xf0 /* $D020 */, 0xf0 /* $D021 */, 0xf0 /* $D022 */, 0xf0 /* $D023 */,
    0xf0 /* $D024 */, 0xf0 /* $D025 */, 0xf0 /* $D026 */, 0xf0 /* $D027 */,
    0xf0 /* $D028 */, 0xf0 /* $D029 */, 0xf0 /* $D02A */, 0xf0 /* $D02B */,
    0xf0 /* $D02C */, 0xf0 /* $D02D */, 0xf0 /* $D02E */, 0xff /* $D02F */,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];

/* vicii-mem.c:92 */
function store_sprite_x_position_lsb(addr: number, value: number): void {
    if (value === vicii.regs[addr]) return;

    vicii.regs[addr] = value;
    const n = addr >> 1;

    vicii.sprite[n]!.x = (value | (vicii.regs[0x10]! & (1 << n) ? 0x100 : 0));
}

/* vicii-mem.c:108 */
function store_sprite_y_position(addr: number, value: number): void {
    vicii.regs[addr] = value;
}

/* vicii-mem.c:113 */
function store_sprite_x_position_msb(addr: number, value: number): void {
    let i: number, b: number;

    if (value === vicii.regs[addr]) return;

    vicii.regs[addr] = value;

    /* Recalculate the sprite X coordinates.  */
    for (i = 0, b = 0x01; i < 8; b <<= 1, i++) {
        vicii.sprite[i]!.x = (vicii.regs[2 * i]! | (value & b ? 0x100 : 0));
    }
}

/* vicii-mem.c:132 */
function update_raster_line(): void {
    let new_line: number;

    new_line = vicii.regs[0x12]!;
    new_line |= (vicii.regs[0x11]! & 0x80) << 1;

    vicii.raster_irq_line = new_line;
}

/* vicii-mem.c:145 */
function d011_store(value: number): void {
    vicii.ysmooth = value & 0x7;

    vicii.regs[0x11] = value;

    update_raster_line();
}

/* vicii-mem.c:158 */
function d012_store(value: number): void {
    if (value === vicii.regs[0x12]) return;

    vicii.regs[0x12] = value;

    update_raster_line();
}

/* vicii-mem.c:171 */
function d015_store(value: number): void {
    vicii.regs[0x15] = value;
}

/* vicii-mem.c:176 */
function d016_store(value: number): void {
    vicii.regs[0x16] = value;
}

/* vicii-mem.c:183 */
function d017_store(value: number): void {
    let i: number, b: number;

    if (value === vicii.regs[0x17]) return;

    for (i = 0, b = 0x01; i < VICII_NUM_SPRITES; b <<= 1, i++) {
        if (!(value & b) && !vicii.sprite[i]!.exp_flop) {
            /* sprite crunch */
            if (cycle_is_check_spr_crunch(vicii.cycle_flags)) {
                const mc = vicii.sprite[i]!.mc;
                const mcbase = vicii.sprite[i]!.mcbase;

                /* 0x2a = 0b101010
                   0x15 = 0b010101 */
                vicii.sprite[i]!.mc = (0x2a & (mcbase & mc)) | (0x15 & (mcbase | mc));

                /* mcbase is set from mc on the following vicii_cycle() call */
            }

            vicii.sprite[i]!.exp_flop = 1;
        }
    }

    vicii.regs[0x17] = value;
}

/* vicii-mem.c:216 */
function d018_store(value: number): void {
    if (vicii.regs[0x18] === value) return;

    vicii.regs[0x18] = value;
}

/* vicii-mem.c:227 */
function d019_store(value: number): void {
    vicii.irq_status &= ~((value & 0xf) | 0x80) & 0xff;
    vicii_irq_set_line();
}

/* vicii-mem.c:235 */
function d01a_store(value: number): void {
    vicii.regs[0x1a] = value & 0xf;

    vicii_irq_set_line();
}

/* vicii-mem.c:244 */
function d01b_store(value: number): void {
    vicii.regs[0x1b] = value;
}

/* vicii-mem.c:251 */
function d01c_store(value: number): void {
    vicii.regs[0x1c] = value;
}

/* vicii-mem.c:258 */
function d01d_store(value: number): void {
    vicii.regs[0x1d] = value;
}

/* vicii-mem.c:265 */
function collision_store(_addr: number, _value: number): void {
    /* (collision register, Read Only) */
}

/* vicii-mem.c:270 */
function color_reg_store(addr: number, value: number): void {
    vicii.regs[addr] = value;
    vicii.last_color_reg = addr & 0xff;
    vicii.last_color_value = value;
    /* Spec 298k addition: also propagate into draw-cycle.ts cregs[]
     * lookup table immediately. VICE does this via update_cregs() at
     * end of draw_colors8 (= per-cycle pull from vicii.last_color_reg).
     * Mirror eagerly so polling fallback in installLiteralPortRenderer
     * can be retired. */
    vicii_monitor_colreg_store(addr, value);
}

/* vicii-mem.c:277 */
function d020_store(value: number): void {
    value &= 0x0f;
    color_reg_store(0x20, value);
}

/* vicii-mem.c:286 */
function d021_store(value: number): void {
    value &= 0x0f;
    color_reg_store(0x21, value);
}

/* vicii-mem.c:295 */
function ext_background_store(addr: number, value: number): void {
    value &= 0x0f;
    color_reg_store(addr, value);
}

/* vicii-mem.c:305 */
function d025_store(value: number): void {
    value &= 0xf;
    color_reg_store(0x25, value);
}

/* vicii-mem.c:314 */
function d026_store(value: number): void {
    value &= 0xf;
    color_reg_store(0x26, value);
}

/* vicii-mem.c:323 */
function sprite_color_store(addr: number, value: number): void {
    value &= 0xf;
    color_reg_store(addr, value);
}

/* vicii-mem.c:334 — vicii_store */
export function vicii_store(addr: number, value: number): void {
    addr &= 0x3f;

    vicii.last_bus_phi2 = value;

    switch (addr) {
        case 0x0:
        case 0x2:
        case 0x4:
        case 0x6:
        case 0x8:
        case 0xa:
        case 0xc:
        case 0xe:
            store_sprite_x_position_lsb(addr, value);
            break;

        case 0x1:
        case 0x3:
        case 0x5:
        case 0x7:
        case 0x9:
        case 0xb:
        case 0xd:
        case 0xf:
            store_sprite_y_position(addr, value);
            break;

        case 0x10:
            store_sprite_x_position_msb(addr, value);
            break;

        case 0x11:
            d011_store(value);
            break;

        case 0x12:
            d012_store(value);
            break;

        case 0x13:
        case 0x14:
            break;

        case 0x15:
            d015_store(value);
            break;

        case 0x16:
            d016_store(value);
            break;

        case 0x17:
            d017_store(value);
            break;

        case 0x18:
            d018_store(value);
            break;

        case 0x19:
            d019_store(value);
            break;

        case 0x1a:
            d01a_store(value);
            break;

        case 0x1b:
            d01b_store(value);
            break;

        case 0x1c:
            d01c_store(value);
            break;

        case 0x1d:
            d01d_store(value);
            break;

        case 0x1e:
        case 0x1f:
            collision_store(addr, value);
            break;

        case 0x20:
            d020_store(value);
            break;

        case 0x21:
            d021_store(value);
            break;

        case 0x22:
        case 0x23:
        case 0x24:
            ext_background_store(addr, value);
            break;

        case 0x25:
            d025_store(value);
            break;

        case 0x26:
            d026_store(value);
            break;

        case 0x27:
        case 0x28:
        case 0x29:
        case 0x2a:
        case 0x2b:
        case 0x2c:
        case 0x2d:
        case 0x2e:
            sprite_color_store(addr, value);
            break;

        default:
            /* unused */
            break;
    }
}

/* vicii-mem.c:481 — vicii_poke */
export function vicii_poke(addr: number, value: number): void {
    addr &= 0x3f;
    if ((addr >= 0x20) && (addr <= 0x2e)) {
        vicii_monitor_colreg_store(addr, value);
        return;
    }
    vicii_store(addr, value);
}

/* vicii-mem.c:492 */
function read_raster_y(): number {
    return vicii.raster_line;
}

/* vicii-mem.c:501 */
function d01112_read(addr: number): number {
    const tmp = read_raster_y();
    if (addr === 0x11) {
        return (vicii.regs[addr]! & 0x7f) | ((tmp & 0x100) >> 1);
    } else {
        return tmp & 0xff;
    }
}

/* vicii-mem.c:515 */
function d019_read(): number {
    return (vicii.irq_status | 0x70) & 0xff;
}

/* vicii-mem.c:520 */
function d01e_read(): number {
    vicii.regs[0x1e] = vicii.sprite_sprite_collisions;
    vicii.clear_collisions = 0x1e;
    return vicii.regs[0x1e]!;
}

/* vicii-mem.c:537 */
function d01f_read(): number {
    vicii.regs[0x1f] = vicii.sprite_background_collisions;
    vicii.clear_collisions = 0x1f;
    return vicii.regs[0x1f]!;
}

/* vicii-mem.c:562 — vicii_read */
export function vicii_read(addr: number): number {
    let value: number;
    addr &= 0x3f;

    switch (addr) {
        case 0x0: case 0x2: case 0x4: case 0x6:
        case 0x8: case 0xa: case 0xc: case 0xe:
            value = vicii.regs[addr]!;
            break;

        case 0x1: case 0x3: case 0x5: case 0x7:
        case 0x9: case 0xb: case 0xd: case 0xf:
            value = vicii.regs[addr]!;
            break;

        case 0x10:
            value = vicii.regs[addr]!;
            break;

        case 0x11:
        case 0x12:
            value = d01112_read(addr);
            break;

        case 0x13:
            value = vicii.light_pen.x;
            break;

        case 0x14:
            value = vicii.light_pen.y;
            break;

        case 0x15:
            value = vicii.regs[addr]!;
            break;

        case 0x16:
            value = vicii.regs[addr]! | 0xc0;
            break;

        case 0x17:
            value = vicii.regs[addr]!;
            break;

        case 0x18:
            value = vicii.regs[addr]! | 0x1;
            break;

        case 0x19:
            value = d019_read();
            break;

        case 0x1a:
            value = vicii.regs[addr]! | 0xf0;
            break;

        case 0x1b:
            value = vicii.regs[addr]!;
            break;

        case 0x1c:
            value = vicii.regs[addr]!;
            break;

        case 0x1d:
            value = vicii.regs[addr]!;
            break;

        case 0x1e:
            value = d01e_read();
            break;

        case 0x1f:
            value = d01f_read();
            break;

        case 0x20:
            value = vicii.regs[addr]! | 0xf0;
            break;

        case 0x21:
        case 0x22:
        case 0x23:
        case 0x24:
            value = vicii.regs[addr]! | 0xf0;
            break;

        case 0x25:
        case 0x26:
            value = vicii.regs[addr]! | 0xf0;
            break;

        case 0x27: case 0x28: case 0x29: case 0x2a:
        case 0x2b: case 0x2c: case 0x2d: case 0x2e:
            value = vicii.regs[addr]! | 0xf0;
            break;

        default:
            value = 0xff;
            break;
    }

    vicii.last_bus_phi2 = value;
    return value & 0xff;
}

/* vicii-mem.c:742 */
function d019_peek(): number {
    return (vicii.irq_status | 0x70) & 0xff;
}

/* vicii-mem.c:747 — vicii_peek */
export function vicii_peek(addr: number): number {
    addr &= 0x3f;

    switch (addr) {
        case 0x11:
            return ((vicii.regs[addr]! & 0x7f) | ((read_raster_y() & 0x100) >> 1)) & 0xff;
        case 0x12:
            return read_raster_y() & 0xff;
        case 0x13:
            return vicii.light_pen.x;
        case 0x14:
            return vicii.light_pen.y;
        case 0x19:
            return d019_peek();
        case 0x1e:
            return vicii.sprite_sprite_collisions;
        case 0x1f:
            return vicii.sprite_background_collisions;
        default:
            return (vicii.regs[addr]! | unused_bits_in_registers[addr]!) & 0xff;
    }
}
