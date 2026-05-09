// Spec 298i — minimal vicii_init / vicii_reset for the literal port.
//
// Source: /Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii.c
//
// Full vicii.c is 736 LOC (= raster init, palette, snapshot, resource
// callbacks). We port the minimum needed to drive vicii_cycle()
// against synthetic memory + read vicii.dbuf for pixel diffs.

import { vicii } from "./vicii-types.js";
import { vicii_chip_model_init } from "./vicii-chip-model.js";
import { vicii_draw_cycle_init } from "./vicii-draw-cycle.js";

/**
 * Bind a 64KB RAM array to the VIC chip. Mirrors vicii.c
 * mem_initialize_memory_bank wiring.
 *
 * For our literal port, ram_base_phi1 / ram_base_phi2 point to the
 * same Uint8Array (= shared C64 RAM). VIC-bank base is added at
 * fetch time via vicii.vbank_phi1 + vaddr_mask_phi1.
 */
export function vicii_bind_ram(ram: Uint8Array): void {
    vicii.ram_base_phi1 = ram;
    vicii.ram_base_phi2 = ram;
    /* C64 default: bank 0, full 16KB window, no offset, chargen overlay
     * at $1000-$1FFF. */
    vicii.vbank_phi1 = 0;
    vicii.vbank_phi2 = 0;
    vicii.vaddr_mask_phi1 = 0x3fff;
    vicii.vaddr_mask_phi2 = 0x3fff;
    vicii.vaddr_offset_phi1 = 0;
    vicii.vaddr_offset_phi2 = 0;
    vicii.vaddr_chargen_mask_phi1 = 0x7000;
    vicii.vaddr_chargen_value_phi1 = 0x1000;
    vicii.vaddr_chargen_mask_phi2 = 0x7000;
    vicii.vaddr_chargen_value_phi2 = 0x1000;
}

/**
 * vicii_init() literal subset — chip model + draw cycle init.
 */
export function vicii_init(): void {
    vicii_chip_model_init();
    vicii_draw_cycle_init();
    vicii.initialized = 1;
}

/**
 * vicii_reset() literal subset.
 */
export function vicii_reset(): void {
    vicii.regs.fill(0);
    vicii.raster_cycle = 0;
    vicii.cycle_flags = 0;
    vicii.raster_line = 0;
    vicii.start_of_frame = 0;
    vicii.irq_status = 0;
    vicii.raster_irq_line = 0;
    vicii.raster_irq_triggered = 0;
    vicii.vbuf.fill(0);
    vicii.cbuf.fill(0);
    vicii.gbuf = 0;
    vicii.dbuf_offset = 0;
    vicii.dbuf.fill(0);
    vicii.ysmooth = 0;
    vicii.allow_bad_lines = 0;
    vicii.sprite_sprite_collisions = 0;
    vicii.sprite_background_collisions = 0;
    vicii.clear_collisions = 0;
    vicii.idle_state = 0;
    vicii.vcbase = 0;
    vicii.vc = 0;
    vicii.rc = 0;
    vicii.vmli = 0;
    vicii.bad_line = 0;
    vicii.reg11_delay = 0;
    vicii.prefetch_cycles = 0;
    vicii.sprite_display_bits = 0;
    vicii.sprite_dma = 0;
    for (const s of vicii.sprite) {
        s.data = 0; s.mc = 0; s.mcbase = 0; s.pointer = 0; s.exp_flop = 0; s.x = 0;
    }
    vicii.last_color_reg = 0xff;
    vicii.last_color_value = 0;
    vicii.last_read_phi1 = 0;
    vicii.last_bus_phi2 = 0xff;
    vicii.vborder = 1;
    vicii.set_vborder = 1;
    vicii.main_border = 1;
    vicii.refresh_counter = 0xff;
    vicii_draw_cycle_init();
}
