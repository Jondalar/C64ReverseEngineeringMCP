// Spec 298d — LITERAL port of viciisc/vicii-draw-cycle.c.
//
// Source: /Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-draw-cycle.c
//
// PORT RULES (Spec 298): same function names, same control flow,
// same module-static state, same pixel emit. Snapshot routines
// omitted (= deferred to 298k integration; not load-bearing for
// gold-master diff).

import { vicii, VICII_DRAW_BUFFER_SIZE } from "./vicii-types.js";
import {
    cycle_is_visible, cycle_is_check_spr_disp, cycle_get_xpos,
    cycle_is_sprite_ptr_dma0, cycle_is_sprite_dma1_dma2,
    cycle_get_sprite_num,
} from "./vicii-chip-model.js";

/* colors */
const COL_NONE     = 0x10;
const COL_VBUF_L   = 0x11;
const COL_VBUF_H   = 0x12;
const COL_CBUF     = 0x13;
const COL_CBUF_MC  = 0x14;
const COL_D02X_EXT = 0x15;
const COL_D020     = 0x20;
const COL_D021     = 0x21;
const COL_D022     = 0x22;
const COL_D023     = 0x23;
const COL_D024     = 0x24;
const COL_D025     = 0x25;
const COL_D026     = 0x26;
const COL_D027     = 0x27;

/* foreground/background graphics — module-static state mirrors
 * vicii-draw-cycle.c:65 */
let gbuf_pipe0_reg = 0;
let cbuf_pipe0_reg = 0;
let vbuf_pipe0_reg = 0;
let gbuf_pipe1_reg = 0;
let cbuf_pipe1_reg = 0;
let vbuf_pipe1_reg = 0;

let xscroll_pipe = 0;
let vmode11_pipe = 0;
let vmode16_pipe = 0;
let vmode16_pipe2 = 0;

/* gbuf shift register */
let gbuf_reg = 0;
let gbuf_mc_flop = 0;
let gbuf_pixel_reg = 0;

/* cbuf and vbuf registers */
let cbuf_reg = 0;
let vbuf_reg = 0;

let dmli = 0;

/* sprites */
const sprite_x_pipe = [0, 0, 0, 0, 0, 0, 0, 0];
let sprite_pri_bits = 0;
let sprite_mc_bits = 0;
let sprite_expx_bits = 0;

let sprite_pending_bits = 0;
let sprite_active_bits = 0;
let sprite_halt_bits = 0;

/* sbuf shift registers */
const sbuf_reg = new Uint32Array(8);
const sbuf_pixel_reg = new Uint8Array(8);
let sbuf_expx_flops = 0;
let sbuf_mc_flops = 0;

/* border */
let border_state = 0;

/* pixel buffer */
const render_buffer = new Uint8Array(8);
const pri_buffer = new Uint8Array(8);

const pixel_buffer = new Uint8Array(8);

/* color resolution registers */
const cregs = new Uint8Array(0x2f);
let last_color_reg = 0;
let last_color_value = 0;

let cycle_flags_pipe = 0;

/* vicii-draw-cycle.c:120 */
export function vicii_monitor_colreg_store(reg: number, value: number): void {
    cregs[reg] = value;
    last_color_reg = reg;
    last_color_value = value;
}

/**************************************************************************
 *
 * SECTION  draw_graphics()
 *
 ******/

/* vicii-draw-cycle.c:133 */
const colors: number[] = [
    COL_D021, COL_D021, COL_CBUF, COL_CBUF,         /* ECM=0 BMM=0 MCM=0 */
    COL_D021, COL_D022, COL_D023, COL_CBUF_MC,      /* ECM=0 BMM=0 MCM=1 */
    COL_VBUF_L, COL_VBUF_L, COL_VBUF_H, COL_VBUF_H, /* ECM=0 BMM=1 MCM=0 */
    COL_D021, COL_VBUF_H, COL_VBUF_L, COL_CBUF,     /* ECM=0 BMM=1 MCM=1 */
    COL_D02X_EXT, COL_D02X_EXT, COL_CBUF, COL_CBUF, /* ECM=1 BMM=0 MCM=0 */
    COL_NONE, COL_NONE, COL_NONE, COL_NONE,         /* ECM=1 BMM=0 MCM=1 */
    COL_NONE, COL_NONE, COL_NONE, COL_NONE,         /* ECM=1 BMM=1 MCM=0 */
    COL_NONE, COL_NONE, COL_NONE, COL_NONE,         /* ECM=1 BMM=1 MCM=1 */
];

/* vicii-draw-cycle.c:144 */
function draw_graphics(i: number): void {
    let px: number;
    let cc: number;
    let pixel_pri: number;
    let vmode: number;

    /* Load new gbuf/vbuf/cbuf values at offset == xscroll */
    if (i === xscroll_pipe) {
        /* latch values at time xs */
        vbuf_reg = vbuf_pipe1_reg;
        cbuf_reg = cbuf_pipe1_reg;
        gbuf_reg = gbuf_pipe1_reg;
        gbuf_mc_flop = 1;
    }

    /*
     * read pixels depending on video mode
     * mc pixels if MCM=1 and BMM=1, or MCM=1 and cbuf bit 3 = 1
     */
    if (vmode16_pipe2) {
        if ((vmode11_pipe & 0x08) || (cbuf_reg & 0x08)) {
            /* mc pixels */
            if (gbuf_mc_flop) {
                gbuf_pixel_reg = gbuf_reg >> 6;
            }
        } else {
            /* hires pixels */
            gbuf_pixel_reg = (gbuf_reg & 0x80) ? 3 : 0;
        }
    } else {
        /*
         * some kludge magic to fix $d023 glitch at MCM=0 -> 1 during
         * MC and non-MC chars.
         * This is rather ugly. There must be a simpler solution.
         */
        if ((vmode11_pipe & 0x08) || (cbuf_reg & 0x08)) {
            /* hires pixels */
            gbuf_pixel_reg = (gbuf_reg & 0x80) ? 2 : 0;
        } else {
            /* hires pixels */
            gbuf_pixel_reg = (gbuf_reg & 0x80) ? 3 : 0;
        }
    }
    px = gbuf_pixel_reg;

    /* shift the graphics buffer */
    gbuf_reg = (gbuf_reg << 1) & 0xff;
    gbuf_mc_flop ^= 1;

    /* Determine pixel color and priority */
    vmode = vmode11_pipe | vmode16_pipe;
    pixel_pri = (px & 0x2);
    cc = colors[vmode | px]!;

    /* lookup colors and render pixel */
    switch (cc) {
        case COL_NONE:
            cc = 0;
            break;
        case COL_VBUF_L:
            cc = vbuf_reg & 0x0f;
            break;
        case COL_VBUF_H:
            cc = vbuf_reg >> 4;
            break;
        case COL_CBUF:
            cc = cbuf_reg;
            break;
        case COL_CBUF_MC:
            cc = cbuf_reg & 0x07;
            break;
        case COL_D02X_EXT:
            cc = COL_D021 + (vbuf_reg >> 6);
            break;
        default:
            break;
    }

    render_buffer[i] = cc;
    pri_buffer[i] = pixel_pri;
}

/* vicii-draw-cycle.c:227 */
function draw_graphics8(cycle_flags: number): void {
    const vis_en = cycle_is_visible(cycle_flags);

    /* render pixels */
    /* pixel 0 */
    draw_graphics(0);
    /* pixel 1 */
    draw_graphics(1);
    /* pixel 2 */
    draw_graphics(2);
    /* pixel 3 */
    draw_graphics(3);
    /* pixel 4 */
    vmode16_pipe = (vicii.regs[0x16]! & 0x10) >> 2;
    if (vicii.color_latency) {
        /* handle rising edge of internal signal */
        vmode11_pipe |= (vicii.regs[0x11]! & 0x60) >> 2;
    }
    draw_graphics(4);
    /* pixel 5 */
    draw_graphics(5);
    /* pixel 6 */
    if (vicii.color_latency) {
        /* handle falling edge of internal signal */
        vmode11_pipe &= (vicii.regs[0x11]! & 0x60) >> 2;
    }
    draw_graphics(6);
    /* pixel 7 */
    if (vmode16_pipe && !vmode16_pipe2) {
        gbuf_mc_flop = 0;
    }
    vmode16_pipe2 = vmode16_pipe;
    draw_graphics(7);

    if (!vicii.color_latency) {
        vmode11_pipe = (vicii.regs[0x11]! & 0x60) >> 2;
    }

    /* shift and put the next data into the pipe. */
    vbuf_pipe1_reg = vbuf_pipe0_reg;
    cbuf_pipe1_reg = cbuf_pipe0_reg;
    gbuf_pipe1_reg = gbuf_pipe0_reg;

    /* this makes sure gbuf is 0 outside the visible area
       It should probably be done somewhere around the fetch instead */
    if (vis_en && vicii.vborder === 0) {
        gbuf_pipe0_reg = vicii.gbuf;
        xscroll_pipe = vicii.regs[0x16]! & 0x07;
    } else {
        gbuf_pipe0_reg = 0;
    }

    /* Only update vbuf and cbuf registers in the display state. */
    if (vis_en && vicii.vborder === 0) {
        if (!vicii.idle_state) {
            vbuf_pipe0_reg = vicii.vbuf[dmli]!;
            cbuf_pipe0_reg = vicii.cbuf[dmli]!;
            dmli++;
        } else {
            vbuf_pipe0_reg = 0;
            cbuf_pipe0_reg = 0;
        }
    } else {
        dmli = 0;
    }
}

/**************************************************************************
 *
 * SECTION  draw_sprites()
 *
 ******/

/* vicii-draw-cycle.c:304 */
function get_trigger_candidates(xpos: number): number {
    let s: number;
    let candidate_bits = 0;

    /* check for partial xpos match */
    for (s = 0; s < 8; s++) {
        if ((xpos & 0x1f8) === (sprite_x_pipe[s]! & 0x1f8)) {
            candidate_bits |= 1 << s;
        }
    }
    return candidate_bits;
}

/* vicii-draw-cycle.c:318 */
function trigger_sprites(xpos: number, candidate_bits: number): void {
    let s: number;

    /* do nothing if no sprites are candidates or pending */
    if (!candidate_bits || !sprite_pending_bits) {
        return;
    }

    /* check for pending */
    for (s = 0; s < 8; s++) {
        const m = 1 << s;

        /* start rendering on position match */
        if ((candidate_bits & m) && (sprite_pending_bits & m) && !(sprite_active_bits & m) && !(sprite_halt_bits & m)) {
            if (xpos === sprite_x_pipe[s]) {
                sbuf_expx_flops |= m;
                sbuf_mc_flops |= m;
                sprite_active_bits |= m;
            }
        }
    }
}

/* vicii-draw-cycle.c:342 */
function draw_sprites(i: number): void {
    let s: number;
    let active_sprite: number;
    let collision_mask: number;

    /* do nothing if all sprites are inactive */
    if (!sprite_active_bits) {
        return;
    }

    /* check for active sprites */
    active_sprite = -1;
    collision_mask = 0;
    for (s = 7; s >= 0; --s) {
        const m = 1 << s;

        if (sprite_active_bits & m) {
            /* render pixels if shift register or pixel reg still contains data */
            if (sbuf_reg[s]! || sbuf_pixel_reg[s]!) {
                if (!(sprite_halt_bits & m)) {
                    if (sbuf_expx_flops & m) {
                        if (sprite_mc_bits & m) {
                            if (sbuf_mc_flops & m) {
                                /* fetch 2 bits */
                                sbuf_pixel_reg[s] = (sbuf_reg[s]! >>> 22) & 0x03;
                            }
                            sbuf_mc_flops ^= m;
                        } else {
                            /* fetch 1 bit and make it 0 or 2 */
                            sbuf_pixel_reg[s] = ((sbuf_reg[s]! >>> 23) & 0x01) << 1;
                        }
                    }

                    /* shift the sprite buffer and handle expansion flags */
                    if (sbuf_expx_flops & m) {
                        sbuf_reg[s] = (sbuf_reg[s]! << 1) >>> 0;
                    }
                    if (sprite_expx_bits & m) {
                        sbuf_expx_flops ^= m;
                    } else {
                        sbuf_expx_flops |= m;
                    }
                }

                /*
                 * set collision mask bits and determine the highest
                 * priority sprite number that has a pixel.
                 */
                if (sbuf_pixel_reg[s]!) {
                    active_sprite = s;
                    collision_mask |= m;
                }
            } else {
                sprite_active_bits &= ~m;
            }
        }
    }

    if (collision_mask) {
        const pixel_pri = pri_buffer[i]!;
        const as = active_sprite;
        const spri = sprite_pri_bits & (1 << as);
        if (!(pixel_pri && spri)) {
            switch (sbuf_pixel_reg[as]!) {
                case 1:
                    render_buffer[i] = COL_D025;
                    break;
                case 2:
                    render_buffer[i] = COL_D027 + as;
                    break;
                case 3:
                    render_buffer[i] = COL_D026;
                    break;
                default:
                    break;
            }
        }
        /* if there was a foreground pixel, trigger collision */
        if (pixel_pri) {
            vicii.sprite_background_collisions |= collision_mask;
        }
    }

    /* if 2 or more bits are set, trigger collisions */
    if (collision_mask & (collision_mask - 1)) {
        vicii.sprite_sprite_collisions |= collision_mask;
    }
}

/* vicii-draw-cycle.c:433 */
function update_sprite_mc_bits_6569(): void {
    const next_mc_bits = vicii.regs[0x1c]!;
    const toggled = next_mc_bits ^ sprite_mc_bits;

    sbuf_mc_flops &= ~toggled & 0xff;
    sprite_mc_bits = next_mc_bits;
}

/* vicii-draw-cycle.c:442 */
function update_sprite_mc_bits_8565(): void {
    const next_mc_bits = vicii.regs[0x1c]!;
    const toggled = next_mc_bits ^ sprite_mc_bits;

    sbuf_mc_flops ^= toggled & (~sbuf_expx_flops & 0xff);
    sprite_mc_bits = next_mc_bits;
}

/* vicii-draw-cycle.c:451 */
function update_sprite_data(cycle_flags: number): void {
    if (cycle_is_sprite_dma1_dma2(cycle_flags)) {
        const s = cycle_get_sprite_num(cycle_flags);
        sbuf_reg[s] = vicii.sprite[s]!.data;
    }
}

/* vicii-draw-cycle.c:459 */
function update_sprite_xpos(): void {
    let s: number;
    for (s = 0; s < 8; s++) {
        sprite_x_pipe[s] = vicii.sprite[s]!.x;
    }
}

/* vicii-draw-cycle.c:469 */
function draw_sprites8(cycle_flags: number): void {
    let candidate_bits: number;
    let dma_cycle_0 = 0;
    let dma_cycle_2 = 0;
    let xpos: number;
    let spr_en: number;

    xpos = cycle_get_xpos(cycle_flags);

    spr_en = cycle_is_check_spr_disp(cycle_flags);

    if (cycle_is_sprite_ptr_dma0(cycle_flags)) {
        dma_cycle_0 = 1 << cycle_get_sprite_num(cycle_flags);
    }
    if (cycle_is_sprite_dma1_dma2(cycle_flags)) {
        dma_cycle_2 = 1 << cycle_get_sprite_num(cycle_flags);
    }
    candidate_bits = get_trigger_candidates(xpos);

    /* process and render sprites */
    /* pixel 0 */
    trigger_sprites(xpos + 0, candidate_bits);
    draw_sprites(0);
    /* pixel 1 */
    trigger_sprites(xpos + 1, candidate_bits);
    draw_sprites(1);
    /* pixel 2 */
    sprite_active_bits &= ~dma_cycle_2 & 0xff;
    trigger_sprites(xpos + 2, candidate_bits);
    draw_sprites(2);
    /* pixel 3 */
    sprite_halt_bits |= dma_cycle_0;
    trigger_sprites(xpos + 3, candidate_bits);
    draw_sprites(3);
    /* pixel 4 */
    if (spr_en) {
        sprite_pending_bits = vicii.sprite_display_bits;
    }
    update_sprite_data(cycle_flags);
    trigger_sprites(xpos + 4, candidate_bits);
    draw_sprites(4);
    /* pixel 5 */
    trigger_sprites(xpos + 5, candidate_bits);
    draw_sprites(5);
    /* pixel 6 */
    if (!vicii.color_latency) {
        update_sprite_mc_bits_8565();
    }
    sprite_pri_bits = vicii.regs[0x1b]!;
    sprite_expx_bits = vicii.regs[0x1d]!;
    trigger_sprites(xpos + 6, candidate_bits);
    draw_sprites(6);
    /* pixel 7 */
    if (vicii.color_latency) {
        update_sprite_mc_bits_6569();
    }
    sprite_halt_bits &= ~dma_cycle_2 & 0xff;
    trigger_sprites(xpos + 7, candidate_bits);
    draw_sprites(7);

    /* pipe xpos */
    update_sprite_xpos();
}

/**************************************************************************
 *
 * SECTION  draw_border()
 *
 ******/

/* vicii-draw-cycle.c:541 */
function draw_border8(): void {
    const csel = vicii.regs[0x16]! & 0x8;

    /* early exit for the no border case */
    if (!(border_state || vicii.main_border)) {
        return;
    }
    /* early exit for the continuous border case */
    if (border_state && vicii.main_border) {
        render_buffer.fill(COL_D020);
        return;
    }

    /*
     * normal border handling in case there was a transition
     * (the code below can handle all border logic)
     */
    if (csel) {
        if (border_state) {
            render_buffer.fill(COL_D020);
        }
        border_state = vicii.main_border;
    } else {
        if (border_state) {
            // memset(render_buffer, COL_D020, 7) — first 7 only
            for (let k = 0; k < 7; k++) render_buffer[k] = COL_D020;
        }
        border_state = vicii.main_border;
        if (border_state) {
            render_buffer[7] = COL_D020;
        }
    }
}

/**************************************************************************
 *
 * SECTION  draw_colors()
 *
 ******/

/* vicii-draw-cycle.c:585 */
function update_cregs(): void {
    last_color_reg = vicii.last_color_reg;
    last_color_value = vicii.last_color_value;
    vicii.last_color_reg = 0xff;
}

/* vicii-draw-cycle.c:592 */
function draw_colors_6569(offs: number, i: number): void {
    let lookup_index: number;

    /* resolve any unresolved colors */
    lookup_index = (i + 1) & 0x07;
    pixel_buffer[lookup_index] = cregs[pixel_buffer[lookup_index]!]!;

    /* draw pixel to buffer */
    vicii.dbuf[offs + i] = pixel_buffer[i]!;

    pixel_buffer[i] = render_buffer[i]!;
}

/* vicii-draw-cycle.c:606 */
function draw_colors_8565(offs: number, i: number): void {
    let lookup_index: number;

    lookup_index = i;
    /* resolve any unresolved colors */

    /* special case for grey dot handling */
    if (i === 0 && pixel_buffer[lookup_index]! === last_color_reg) {
        pixel_buffer[lookup_index] = 0x0f;
    } else {
        pixel_buffer[lookup_index] = cregs[pixel_buffer[lookup_index]!]!;
    }

    /* draw pixel to buffer */
    vicii.dbuf[offs + i] = pixel_buffer[i]!;

    pixel_buffer[i] = render_buffer[i]!;
}

/* vicii-draw-cycle.c:626 */
function draw_colors8(): void {
    const offs = vicii.dbuf_offset;

    /* guard (could possibly be removed) */
    if (offs > VICII_DRAW_BUFFER_SIZE - 8) {
        return;
    }

    /* update color register (if written) */
    if (last_color_reg !== 0xff) {
        cregs[last_color_reg] = last_color_value;
    }

    /* render pixels */
    if (vicii.color_latency) {
        draw_colors_6569(offs, 0);
        draw_colors_6569(offs, 1);
        draw_colors_6569(offs, 2);
        draw_colors_6569(offs, 3);
        draw_colors_6569(offs, 4);
        draw_colors_6569(offs, 5);
        draw_colors_6569(offs, 6);
        draw_colors_6569(offs, 7);
    } else {
        draw_colors_8565(offs, 0);
        draw_colors_8565(offs, 1);
        draw_colors_8565(offs, 2);
        draw_colors_8565(offs, 3);
        draw_colors_8565(offs, 4);
        draw_colors_8565(offs, 5);
        draw_colors_8565(offs, 6);
        draw_colors_8565(offs, 7);
    }
    vicii.dbuf_offset += 8;

    update_cregs();
}

/**************************************************************************
 *
 * SECTION  vicii_draw_cycle()
 *
 ******/

/* vicii-draw-cycle.c:672 */
export function vicii_draw_cycle(): void {
    /* reset rendering on raster cycle 1 */
    if (vicii.raster_cycle === 1) {
        vicii.dbuf_offset = 0;
    }

    draw_graphics8(cycle_flags_pipe);

    draw_sprites8(cycle_flags_pipe);

    draw_border8();

    draw_colors8();

    cycle_flags_pipe = vicii.cycle_flags;
}

/* vicii-draw-cycle.c:691 */
export function vicii_draw_cycle_init(): void {
    let i: number;

    /* initialize the draw buffer */
    vicii.dbuf.fill(0);
    vicii.dbuf_offset = 0;

    /* initialize the pixel ring buffer. */
    pixel_buffer.fill(0);

    /* clear cregs and fill 0x00-0x0f with 1:1 mapping */
    cregs.fill(0);
    for (i = 0; i < 0x10; i++) {
        cregs[i] = i;
    }
    vicii.last_color_reg = 0xff;
    last_color_reg = 0xff;

    cycle_flags_pipe = 0;
}
