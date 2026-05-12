// Spec 298h — LITERAL port of viciisc/vicii-cycle.c.
//
// Source: /Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-cycle.c
//
// PORT RULES (Spec 298): same function names, same control flow.

import { vicii, VICII_NUM_SPRITES, VICII_PAL_CYCLE,
         VICII_FIRST_DMA_LINE, VICII_LAST_DMA_LINE,
         VICII_25ROW_START_LINE, VICII_24ROW_START_LINE,
         VICII_25ROW_STOP_LINE, VICII_24ROW_STOP_LINE } from "./vicii-types.js";
import {
    cycle_is_fetch_g, cycle_is_sprite_ptr_dma0, cycle_is_sprite_dma1_dma2,
    cycle_get_sprite_num, cycle_is_refresh,
    cycle_is_check_border_l, cycle_is_check_border_r,
    cycle_is_update_mcbase, cycle_is_check_spr_dma, cycle_is_check_spr_exp,
    cycle_is_check_spr_disp, cycle_is_update_vc, cycle_is_update_rc,
    cycle_is_fetch_ba, cycle_may_fetch_c,
} from "./vicii-chip-model.js";
import {
    vicii_fetch_sprites, vicii_fetch_graphics, vicii_fetch_idle_gfx,
    vicii_fetch_sprite_pointer, vicii_fetch_sprite_dma_1,
    vicii_fetch_refresh, vicii_fetch_idle, vicii_fetch_matrix,
    vicii_check_sprite_ba,
} from "./vicii-fetch.js";
import {
    vicii_irq_raster_trigger, vicii_irq_sscoll_set, vicii_irq_sbcoll_set,
} from "./vicii-irq.js";
import { vicii_draw_cycle } from "./vicii-draw-cycle.js";

/* Light pen — minimal stub. VICE has separate vicii-lightpen.c. */
function vicii_trigger_light_pen_internal(_arg: number): void {
    /* VICE: vicii-lightpen.c — full impl deferred to a follow-up port. */
}
function vicii_raster_draw_handler(): void {
    /* VICE: vicii.c — frame buffer flush. Hooked at 298k integration. */
}
let maincpu_clk = 0;
export function setMaincpuClk(c: number): void { maincpu_clk = c; }

/* vicii-cycle.c:51 */
function check_badline(): void {
    /* Check badline condition (line range and "allow bad lines" handled outside */
    if ((vicii.raster_line & 7) === vicii.ysmooth) {
        vicii.bad_line = 1;
        vicii.idle_state = 0;
    } else {
        vicii.bad_line = 0;
    }
}

/* vicii-cycle.c:62 */
function check_sprite_display(): void {
    let i: number, b: number;
    const enable = vicii.regs[0x15]!;

    for (i = 0, b = 1; i < VICII_NUM_SPRITES; i++, b <<= 1) {
        const y = vicii.regs[i * 2 + 1]!;
        vicii.sprite[i]!.mc = vicii.sprite[i]!.mcbase;

        if (vicii.sprite_dma & b) {
            if ((enable & b) && (y === (vicii.raster_line & 0xff))) {
                vicii.sprite_display_bits |= b;
            }
        } else {
            vicii.sprite_display_bits &= ~b & 0xff;
        }
    }
}

/* vicii-cycle.c:81 */
function sprite_mcbase_update(): void {
    let i: number;

    for (i = 0; i < VICII_NUM_SPRITES; i++) {
        if (vicii.sprite[i]!.exp_flop) {
            vicii.sprite[i]!.mcbase = vicii.sprite[i]!.mc;
            if (vicii.sprite[i]!.mcbase === 63) {
                vicii.sprite_dma &= ~(1 << i) & 0xff;
            }
        }
    }
}

/* vicii-cycle.c:95 */
function check_exp(): void {
    let i: number, b: number;
    const y_exp = vicii.regs[0x17]!;

    for (i = 0, b = 1; i < VICII_NUM_SPRITES; i++, b <<= 1) {
        if ((vicii.sprite_dma & b) && (y_exp & b)) {
            vicii.sprite[i]!.exp_flop ^= 1;
        }
    }
}

/* vicii-cycle.c:108 */
function turn_sprite_dma_on(i: number, _y_exp: number): void {
    vicii.sprite_dma |= 1 << i;
    vicii.sprite[i]!.mcbase = 0;
    vicii.sprite[i]!.exp_flop = 1;
}

/* vicii-cycle.c:115 */
function check_sprite_dma(): void {
    let i: number, b: number;
    const enable = vicii.regs[0x15]!;
    const y_exp = vicii.regs[0x17]!;

    for (i = 0, b = 1; i < VICII_NUM_SPRITES; i++, b <<= 1) {
        const y = vicii.regs[i * 2 + 1]!;

        if ((enable & b) && (y === (vicii.raster_line & 0xff)) && !(vicii.sprite_dma & b)) {
            turn_sprite_dma_on(i, y_exp & b);
        }
    }
}

/* vicii-cycle.c:130 */
function cycle_phi1_fetch(cycle_flags: number): number {
    let data: number;
    let s: number;

    if (cycle_is_fetch_g(cycle_flags)) {
        if (!vicii.idle_state) {
            data = vicii_fetch_graphics();
        } else {
            data = vicii_fetch_idle_gfx();
        }
        return data;
    }

    if (cycle_is_sprite_ptr_dma0(cycle_flags)) {
        s = cycle_get_sprite_num(cycle_flags);
        data = vicii_fetch_sprite_pointer(s);
        return data;
    }
    if (cycle_is_sprite_dma1_dma2(cycle_flags)) {
        s = cycle_get_sprite_num(cycle_flags);
        data = vicii_fetch_sprite_dma_1(s);
        return data;
    }

    if (cycle_is_refresh(cycle_flags)) {
        data = vicii_fetch_refresh();
        return data;
    }

    data = vicii_fetch_idle();

    return data;
}

/* vicii-cycle.c:165 */
function check_vborder_top(line: number): void {
    const rsel = vicii.regs[0x11]! & 0x08;

    if ((line === (rsel ? VICII_25ROW_START_LINE : VICII_24ROW_START_LINE)) && (vicii.regs[0x11]! & 0x10)) {
        vicii.vborder = 0;
        vicii.set_vborder = 0;
    }
}

/* vicii-cycle.c:175 */
function check_vborder_bottom(line: number): void {
    const rsel = vicii.regs[0x11]! & 0x08;

    if (line === (rsel ? VICII_25ROW_STOP_LINE : VICII_24ROW_STOP_LINE)) {
        vicii.set_vborder = 1;
    }
}

/* vicii-cycle.c:184 */
function check_hborder(cycle_flags: number): void {
    const csel = vicii.regs[0x16]! & 0x08;

    /* Left border ends at cycles 17 (csel=1) or 18 (csel=0) on PAL. */
    if (cycle_is_check_border_l(cycle_flags, csel)) {
        check_vborder_bottom(vicii.raster_line);
        vicii.vborder = vicii.set_vborder;
        if (vicii.vborder === 0) {
            vicii.main_border = 0;
        }
    }
    /* Right border starts at cycles 56 (csel=0) or 57 (csel=1) on PAL. */
    if (cycle_is_check_border_r(cycle_flags, csel)) {
        vicii.main_border = 1;
    }
}

/* vicii-cycle.c:202 */
function vicii_cycle_start_of_frame(): void {
    vicii.start_of_frame = 0;
    vicii.raster_line = 0;
    vicii.refresh_counter = 0xff;
    vicii.allow_bad_lines = 0;
    vicii.vcbase = 0;
    vicii.vc = 0;
    vicii.light_pen.triggered = 0;

    /* Retrigger light pen if line is still held low */
    if (vicii.light_pen.state) {
        /* add offset depending on chip model (FIXME use proper variable) */
        vicii.light_pen.x_extra_bits = (vicii.color_latency ? 2 : 1);
        vicii_trigger_light_pen_internal(1);
    }
}

/* vicii-cycle.c:220 */
function vicii_cycle_end_of_line(): void {
    vicii_raster_draw_handler();
    if (vicii.raster_line === vicii.screen_height - 1) {
        vicii.start_of_frame = 1;
    }
}

/* vicii-cycle.c:228 */
function vicii_cycle_start_of_line(): void {
    /* Check DEN bit on first cycle of the line following the first DMA line  */
    if ((vicii.raster_line === VICII_FIRST_DMA_LINE) && !vicii.allow_bad_lines && (vicii.regs[0x11]! & 0x10)) {
        vicii.allow_bad_lines = 1;
    }

    /* Disallow bad lines after the last possible one has passed */
    if (vicii.raster_line === VICII_LAST_DMA_LINE) {
        vicii.allow_bad_lines = 0;
    }

    vicii.bad_line = 0;
}

/* vicii-cycle.c:244 */
function next_vicii_cycle(): void {
    /* Next cycle */
    vicii.raster_cycle++;

    /* Handle wrapping */
    if (vicii.raster_cycle === vicii.cycles_per_line) {
        vicii.raster_cycle = 0;
    }
}

/* VSP bug emulation — VICE has full impl + RNG; deferred. Stub fits
 * literal port shape (called by vicii_cycle but does nothing in our
 * port — vsp_bug_enabled is always off without resources). */
let vsp_ysmoothold = 0;
function vicii_handle_vsp_bug(): void {
    /* VICE: vicii-cycle.c:312 — full implementation requires
     * lib_unsigned_rand + vicii_resources. Deferred for literal port.
     * Effect when vsp_bug_enabled=0 (= our default): only logging,
     * no RAM mutation. We omit the logging too. */
}

/* vicii-cycle.c:374 */
export function vicii_cycle(): number {
    let ba_low = 0;
    let can_sprite_sprite: number, can_sprite_background: number;
    let vsp_may_crash: number;

    /* perform phi2 fetch after the cpu has executed */
    vicii_fetch_sprites(vicii.cycle_flags);

    /*
     *
     * End of Phi2
     *
     ******/

    /* Next cycle */
    next_vicii_cycle();
    vicii.cycle_flags = vicii.cycle_table[vicii.raster_cycle]!;

    /******
     *
     * Start of Phi1
     *
     */

    /* Phi1 fetch */
    vicii.last_read_phi1 = cycle_phi1_fetch(vicii.cycle_flags);

    /* Check horizontal border flag */
    check_hborder(vicii.cycle_flags);

    can_sprite_sprite = (vicii.sprite_sprite_collisions === 0) ? 1 : 0;
    can_sprite_background = (vicii.sprite_background_collisions === 0) ? 1 : 0;

    /* Draw one cycle of pixels */
    vicii_draw_cycle();

    /* clear any collision registers as initiated by $d01e or $d01f reads */
    switch (vicii.clear_collisions) {
        case 0x1e:
            vicii.sprite_sprite_collisions = 0;
            vicii.clear_collisions = 0;
            break;
        case 0x1f:
            vicii.sprite_background_collisions = 0;
            vicii.clear_collisions = 0;
            break;
        default:
            break;
    }

    /* Trigger collision IRQs */
    if (can_sprite_sprite && vicii.sprite_sprite_collisions) {
        vicii_irq_sscoll_set();
    }
    if (can_sprite_background && vicii.sprite_background_collisions) {
        vicii_irq_sbcoll_set();
    }

    /*
     *
     * End of Phi1
     *
     ******/

    /******
     *
     * Start of Phi2
     *
     */

    /* Handle end of line/start of new line */
    if (vicii.raster_cycle === VICII_PAL_CYCLE(1)) {
        vicii_cycle_end_of_line();
        vicii_cycle_start_of_line();
    }

    if (vicii.start_of_frame) {
        if (vicii.raster_cycle === VICII_PAL_CYCLE(2)) {
            vicii_cycle_start_of_frame();
        }
    } else {
        if (vicii.raster_cycle === VICII_PAL_CYCLE(1)) {
            vicii.raster_line++;
        }
    }

    /*
     * Trigger a raster IRQ if the raster comparison goes from
     * non-match to match.
     */
    if (vicii.raster_line === vicii.raster_irq_line) {
        if (!vicii.raster_irq_triggered) {
            vicii_irq_raster_trigger();
            vicii.raster_irq_triggered = 1;
        }
    } else {
        vicii.raster_irq_triggered = 0;
    }

    /* Check vertical border flag */
    check_vborder_top(vicii.raster_line);
    /* Check vertical border flag */
    check_vborder_bottom(vicii.raster_line);
    if (vicii.raster_cycle === VICII_PAL_CYCLE(1)) {
        vicii.vborder = vicii.set_vborder;
    }

    /******
     *
     * Sprite logic
     *
     */

    /* Update sprite mcbase (Cycle 16 on PAL) */
    if (cycle_is_update_mcbase(vicii.cycle_flags)) {
        sprite_mcbase_update();
    }

    /* Check sprite DMA (Cycles 55 & 56 on PAL) */
    if (cycle_is_check_spr_dma(vicii.cycle_flags)) {
        check_sprite_dma();
    }

    /* Check sprite expansion flags (Cycle 56 on PAL) */
    if (cycle_is_check_spr_exp(vicii.cycle_flags)) {
        check_exp();
    }

    /* Check sprite display (Cycle 58 on PAL) */
    if (cycle_is_check_spr_disp(vicii.cycle_flags)) {
        check_sprite_display();
    }

    /******
     *
     * Graphics logic
     *
     */

    vsp_may_crash = (!vicii.bad_line && vicii.idle_state) ? 1 : 0;

    /* Check DEN bit on first DMA line */
    if ((vicii.raster_line === VICII_FIRST_DMA_LINE) && !vicii.allow_bad_lines) {
        vicii.allow_bad_lines = (vicii.regs[0x11]! & 0x10) ? 1 : 0;
    }

    /* Check badline condition, trigger fetches */
    if (vicii.allow_bad_lines) {
        check_badline();
    }

    /* VSP-bug condition */
    if (vicii.bad_line && vsp_may_crash &&
        (vicii.raster_cycle >= VICII_PAL_CYCLE(16)) &&
        (vicii.raster_cycle < VICII_PAL_CYCLE(55))) {
            vicii_handle_vsp_bug();
    }
    vsp_ysmoothold = vicii.ysmooth;
    void vsp_ysmoothold;

    /* Update VC (Cycle 14 on PAL) */
    if (cycle_is_update_vc(vicii.cycle_flags)) {
        vicii.vc = vicii.vcbase;
        vicii.vmli = 0;
        if (vicii.bad_line) {
            vicii.rc = 0;
        }
    }

    /* Update RC (Cycle 58 on PAL) */
    if (cycle_is_update_rc(vicii.cycle_flags)) {
        /* `rc' makes the chip go to idle state when it reaches the
           maximum value.  */
        if (vicii.rc === 7) {
            vicii.idle_state = 1;
            vicii.vcbase = vicii.vc;
        }
        if (!vicii.idle_state || vicii.bad_line) {
            vicii.rc = (vicii.rc + 1) & 0x7;
            vicii.idle_state = 0;
        }
    }

    /******
     *
     * BA logic
     *
     */

    /* Check BA for matrix fetch */
    if (vicii.bad_line && cycle_is_fetch_ba(vicii.cycle_flags)) {
        ba_low = 1;
    }

    /* Check BA for Sprite Phi2 fetch */
    ba_low |= vicii_check_sprite_ba(vicii.cycle_flags);

    /* if ba_low transitioning from non-active to active, always count
       3 cycles before allowing any Phi2 accesses. */
    if (ba_low) {
        /* count down prefetch cycles */
        if (vicii.prefetch_cycles) {
            vicii.prefetch_cycles--;
        }
    } else {
        /* this needs to be +1 because it gets decremented already in the
           first ba cycle */
        vicii.prefetch_cycles = 3 + 1;
    }

    /* Matrix fetch */
    if (vicii.bad_line && cycle_may_fetch_c(vicii.cycle_flags)) {
        vicii_fetch_matrix();
    }

    /* clear internal bus (may get set by a VIC-II read or write) */
    vicii.last_bus_phi2 = 0xff;

    /* delay video mode for fetches by one cycle */
    vicii.reg11_delay = vicii.regs[0x11]!;

    /* trigger light pen if scheduled */
    if (vicii.light_pen.trigger_cycle === maincpu_clk) {
        vicii_trigger_light_pen_internal(0);
    }

    return ba_low;
}
