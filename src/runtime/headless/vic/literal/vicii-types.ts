// Spec 298a — LITERAL port of viciisc/viciitypes.h.
//
// Source file: /Users/alex/Development/C64/Tools/vice/vice/src/viciisc/viciitypes.h
//
// PORT RULES (Spec 298):
//   - same struct fields, same names (snake_case preserved)
//   - same constants, same names
//   - C types map: int → number, uint8_t* → Uint8Array,
//     uint8_t buf[N] → Uint8Array(N), uint16_t → number, CLOCK → number
//   - same comments carried over (verbatim)
//   - NO refactoring, NO renaming, NO inlined helpers, NO grouping
//     beyond what VICE has
//
// Refactoring AUTHORIZED only after Spec 298j gold-master verification.

/* viciitypes.h:36 — Screen constants. */
export const VICII_SCREEN_XPIX                  = 320;
export const VICII_SCREEN_YPIX                  = 200;
export const VICII_SCREEN_TEXTCOLS              = 40;
export const VICII_SCREEN_TEXTLINES             = 25;
export const VICII_SCREEN_CHARHEIGHT            = 8;

export const VICII_NUM_SPRITES      = 8;
export const VICII_NUM_COLORS       = 16;

/* This macro translated PAL cycles 1 to 63 into our internal
   representation, i.e 0-63. */
export function VICII_PAL_CYCLE(c: number): number { return c - 1; }

/* Common parameters for all video standards */
export const VICII_25ROW_START_LINE    = 0x33;
export const VICII_25ROW_STOP_LINE     = 0xfb;
export const VICII_24ROW_START_LINE    = 0x37;
export const VICII_24ROW_STOP_LINE     = 0xf7;

/* Bad line range.  */
export const VICII_FIRST_DMA_LINE      = 0x30;
export const VICII_LAST_DMA_LINE       = 0xf7;

/* drawing constants. */
export const VICII_DRAW_BUFFER_SIZE = (65 * 8);

/* just a dummy for the vicii-draw.c wrapper */
export const VICII_DUMMY_MODE = (0);


/* VIC-II structures.  This is meant to be used by VIC-II modules
   *exclusively*!  */

/* viciitypes.h:69 — vicii_light_pen_s */
export interface vicii_light_pen_t {
    state: number;
    triggered: number;
    x: number;
    y: number;
    x_extra_bits: number;
    trigger_cycle: number; // CLOCK
}

export function new_vicii_light_pen_t(): vicii_light_pen_t {
    return { state: 0, triggered: 0, x: 0, y: 0, x_extra_bits: 0, trigger_cycle: 0 };
}

/* viciitypes.h:77 — vicii_sprite_s */
export interface vicii_sprite_t {
    /* Sprite data to display */
    data: number;          // uint32_t
    /* 6 bit counters */
    mc: number;            // uint8_t
    mcbase: number;        // uint8_t
    /* 8 bit pointer */
    pointer: number;       // uint8_t
    /* Expansion flop */
    exp_flop: number;
    /* X coordinate */
    x: number;
}

export function new_vicii_sprite_t(): vicii_sprite_t {
    return { data: 0, mc: 0, mcbase: 0, pointer: 0, exp_flop: 0, x: 0 };
}

/* viciitypes.h:94 — struct vicii_s
 *
 * Forward decl `struct video_chip_cap_s` deferred — not needed for
 * the per-cycle render path. Declared as `unknown` here.
 */
export interface vicii_t {
    /* Flag: Are we initialized?  */
    initialized: number;            /* = 0; */

    /* VIC-II raster.  */
    // raster_t raster — deferred (large external struct, hooked when 298k
    // wires the literal port into the framebuffer).
    raster: unknown;

    /* VIC-II registers.  */
    regs: Uint8Array; // [0x40]

    /* Cycle # within the current line.  */
    raster_cycle: number;

    /* Cycle flags for the cycle table */
    cycle_flags: number;

    /* Current line.  */
    raster_line: number;

    /* Start of frame flag.  */
    start_of_frame: number;

    /* Interrupt register.  */
    irq_status: number;             /* = 0; */

    /* Line for raster compare IRQ.  */
    raster_irq_line: number;

    /* Flag for raster compare edge detect.  */
    raster_irq_triggered: number;

    /* Pointer to the base of RAM seen by the VIC-II.  */
    /* address is base of 64k bank. vbank adds 0/16k/32k/48k to get actual
       video address */
    ram_base_phi1: Uint8Array;                /* = VIC-II address during Phi1; */
    ram_base_phi2: Uint8Array;                /* = VIC-II address during Phi2; */

    /* valid VIC-II address bits for Phi1 and Phi2. After masking
       the address, it is or'd with the offset value to set always-1 bits */
    vaddr_mask_phi1: number;            /* mask of valid address bits */
    vaddr_mask_phi2: number;            /* mask of valid address bits */
    vaddr_offset_phi1: number;          /* mask of address bits always set */
    vaddr_offset_phi2: number;          /* mask of address bits always set */

    /* Those two values determine where in the address space the chargen
       ROM is mapped. Use mask=0x7000, value=0x1000 for the C64. */
    vaddr_chargen_mask_phi1: number;    /* address bits to comp. for chargen */
    vaddr_chargen_mask_phi2: number;    /* address bits to comp. for chargen */
    vaddr_chargen_value_phi1: number;   /* compare value for chargen */
    vaddr_chargen_value_phi2: number;   /* compare value for chargen */

    /* Screen memory buffers (chars and color).  */
    vbuf: Uint8Array; // [VICII_SCREEN_TEXTCOLS]
    cbuf: Uint8Array; // [VICII_SCREEN_TEXTCOLS]

    /* Graphics buffer (bitmap/LinearB) */
    gbuf: number;

    /* Current rendering position into the draw buffer */
    dbuf_offset: number;

    /* Draw buffer for a full line (one byte per pixel) */
    dbuf: Uint8Array; // [VICII_DRAW_BUFFER_SIZE]

    /* parsed vicii register fields */
    ysmooth: number;

    /* If this flag is set, bad lines (DMA's) can happen.  */
    allow_bad_lines: number;

    /* Sprite-sprite and sprite-background collision registers.  */
    sprite_sprite_collisions: number;
    sprite_background_collisions: number;

    /* flag to signal collision clearing */
    clear_collisions: number;

    /* Flag: are we in idle state? */
    idle_state: number;

    /* Internal memory pointer (VCBASE).  */
    vcbase: number;

    /* Internal memory counter (VC).  */
    vc: number;

    /* Internal row counter (RC).  */
    rc: number;

    /* Offset to the vbuf/cbuf buffer (VMLI) */
    vmli: number;

    /* Flag: is the current line a `bad' line? */
    bad_line: number;

    /* Light pen.  */
    light_pen: vicii_light_pen_t;

    /* Start of the memory bank seen by the VIC-II.  */
    vbank_phi1: number;                     /* = 0; */
    vbank_phi2: number;                     /* = 0; */

    /* All the VIC-II logging goes here.  */
    log: number;

    /* Delayed mode selection */
    reg11_delay: number;

    /* Fetch state */
    prefetch_cycles: number;

    /* Mask for sprites being displayed.  */
    sprite_display_bits: number;

    /* Flag: is sprite DMA active? */
    sprite_dma: number;

    /* State of sprites. */
    sprite: vicii_sprite_t[]; // [VICII_NUM_SPRITES]

    /* Geometry and timing parameters of the selected VIC-II emulation.  */
    screen_height: number;
    first_displayed_line: number;
    last_displayed_line: number;

    screen_leftborderwidth: number;
    screen_rightborderwidth: number;

    /* parameters (set by vicii-chip-model). */
    cycles_per_line: number;
    color_latency: number;
    lightpen_old_irq_mode: number;

    /* cycle table (set by vicii-chip-model). */
    cycle_table: Uint32Array; // [65]

    /* last color register update (set by vicii-mem.c,
       cleared by vicii-draw-cycle.c */
    last_color_reg: number;
    last_color_value: number;

    /* Last value read by VICII during phi1.  */
    last_read_phi1: number;

    /* Last value on the internal VICII bus during phi2.  */
    last_bus_phi2: number;

    /* Vertical border flag */
    vborder: number;

    /* latched set of Vertical border flag */
    set_vborder: number;

    /* Main border flag (this is what controls rendering) */
    main_border: number;

    /* Counter used for DRAM refresh accesses.  */
    refresh_counter: number;

    /* Video chip capabilities.  */
    video_chip_cap: unknown;

    int_num: number;
}

/**
 * Allocate a fresh vicii_t with default-zero fields. Mirrors the
 * implicit struct zero-init in vicii_init() (vicii.c).
 *
 * Field defaults match VICE source comments where annotated.
 */
export function new_vicii_t(): vicii_t {
    const sprite: vicii_sprite_t[] = [];
    for (let i = 0; i < VICII_NUM_SPRITES; i++) sprite.push(new_vicii_sprite_t());
    return {
        initialized: 0,
        raster: null,
        regs: new Uint8Array(0x40),
        raster_cycle: 0,
        cycle_flags: 0,
        raster_line: 0,
        start_of_frame: 0,
        irq_status: 0,
        raster_irq_line: 0,
        raster_irq_triggered: 0,
        ram_base_phi1: new Uint8Array(0),
        ram_base_phi2: new Uint8Array(0),
        vaddr_mask_phi1: 0,
        vaddr_mask_phi2: 0,
        vaddr_offset_phi1: 0,
        vaddr_offset_phi2: 0,
        vaddr_chargen_mask_phi1: 0,
        vaddr_chargen_mask_phi2: 0,
        vaddr_chargen_value_phi1: 0,
        vaddr_chargen_value_phi2: 0,
        vbuf: new Uint8Array(VICII_SCREEN_TEXTCOLS),
        cbuf: new Uint8Array(VICII_SCREEN_TEXTCOLS),
        gbuf: 0,
        dbuf_offset: 0,
        dbuf: new Uint8Array(VICII_DRAW_BUFFER_SIZE),
        ysmooth: 0,
        allow_bad_lines: 0,
        sprite_sprite_collisions: 0,
        sprite_background_collisions: 0,
        clear_collisions: 0,
        idle_state: 0,
        vcbase: 0,
        vc: 0,
        rc: 0,
        vmli: 0,
        bad_line: 0,
        light_pen: new_vicii_light_pen_t(),
        vbank_phi1: 0,
        vbank_phi2: 0,
        log: 0,
        reg11_delay: 0,
        prefetch_cycles: 0,
        sprite_display_bits: 0,
        sprite_dma: 0,
        sprite,
        screen_height: 0,
        first_displayed_line: 0,
        last_displayed_line: 0,
        screen_leftborderwidth: 0,
        screen_rightborderwidth: 0,
        cycles_per_line: 0,
        color_latency: 0,
        lightpen_old_irq_mode: 0,
        cycle_table: new Uint32Array(65),
        last_color_reg: 0,
        last_color_value: 0,
        last_read_phi1: 0,
        last_bus_phi2: 0,
        vborder: 0,
        set_vborder: 0,
        main_border: 0,
        refresh_counter: 0,
        video_chip_cap: null,
        int_num: 0,
    };
}

/* extern vicii_t vicii — single global instance, instantiated at
 * vicii_init() time. Mirrors VICE's `vicii_t vicii` global in
 * vicii.c. */
export const vicii: vicii_t = new_vicii_t();
