// Spec 298b — LITERAL port of viciisc/vicii-chip-model.{h,c}.
//
// Source files:
//   /Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-chip-model.h
//   /Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-chip-model.c
//
// PORT RULES (Spec 298): same names, same flag-bit encoding, same
// cycle_tab_pal layout, same compression to vicii.cycle_table[65].

import { vicii } from "./vicii-types.js";

/* ============================================================
 * vicii-chip-model.h — flag bit defines
 * ============================================================ */

/* viciitypes constants — re-export needed for cycle_tab encode below. */

/* Border check */
export const CHECK_BRD_M       = 0xe0000000;
export const CHECK_BRD_L       = 0x80000000;
export const CHECK_BRD_R       = 0x40000000;
export const CHECK_BRD_CSEL    = 0x20000000;

/* Sprite checks */
export const CHECK_SPR_EXP_M   = 0x10000000;

export const CHECK_SPR_M       = 0x0e000000;
export const CHECK_SPR_DMA     = 0x02000000;
export const CHECK_SPR_DISP    = 0x04000000;
export const UPDATE_MCBASE     = 0x06000000;
export const CHECK_SPR_CRUNCH  = 0x08000000;

/* VC/RC */
export const UPDATE_VC_M       = 0x01000000;
export const UPDATE_RC_M       = 0x00800000;

/* Visible */
export const VISIBLE_M         = 0x00400000;

/* XPos / 8 */
export const XPOS_M            = 0x003f0000;
export const XPOS_B            = 16;

/* Phi2 may FetchC */
export const PHI2_FETCH_C_M    = 0x00008000;

/* Phi1 sprite num */
export const PHI1_SPR_NUM_M    = 0x00007000;
export const PHI1_SPR_NUM_B    = 12;

/* Phi1 fetch type */
export const PHI1_TYPE_M       = 0x00000e00;
export const PHI1_TYPE_B       = 9;
export const PHI1_IDLE         = 0x00000000;
export const PHI1_REFRESH      = 0x00000200;
export const PHI1_FETCH_G      = 0x00000400;
export const PHI1_SPR_PTR      = 0x00000600;
export const PHI1_SPR_DMA1     = 0x00000800;

/* BA */
export const FETCH_BA_M        = 0x00000100;
export const FETCH_BA_B        = 8;
export const SPRITE_BA_MASK_M  = 0x000000ff;
export const SPRITE_BA_MASK_B  = 0;

/* Inline helpers (literal port from chip-model.h:119+) */
export function cycle_get_sprite_ba_mask(flags: number): number {
    return (flags & SPRITE_BA_MASK_M) >>> SPRITE_BA_MASK_B;
}
export function cycle_is_fetch_ba(flags: number): number {
    return (flags & FETCH_BA_M) ? 1 : 0;
}
export function cycle_is_sprite_ptr_dma0(flags: number): number {
    return (flags & PHI1_TYPE_M) === PHI1_SPR_PTR ? 1 : 0;
}
export function cycle_is_sprite_dma1_dma2(flags: number): number {
    return (flags & PHI1_TYPE_M) === PHI1_SPR_DMA1 ? 1 : 0;
}
export function cycle_get_sprite_num(flags: number): number {
    return (flags & PHI1_SPR_NUM_M) >>> PHI1_SPR_NUM_B;
}
export function cycle_is_refresh(flags: number): number {
    return (flags & PHI1_TYPE_M) === PHI1_REFRESH ? 1 : 0;
}
export function cycle_is_fetch_g(flags: number): number {
    return (flags & PHI1_TYPE_M) === PHI1_FETCH_G ? 1 : 0;
}
export function cycle_may_fetch_c(flags: number): number {
    return (flags & PHI2_FETCH_C_M) ? 1 : 0;
}
export function cycle_is_visible(flags: number): number {
    return (flags & VISIBLE_M) ? 1 : 0;
}
export function cycle_get_xpos(flags: number): number {
    return ((flags & XPOS_M) >>> XPOS_B) << 3;
}
export function cycle_is_update_vc(flags: number): number {
    return (flags & UPDATE_VC_M) ? 1 : 0;
}
export function cycle_is_update_rc(flags: number): number {
    return (flags & UPDATE_RC_M) ? 1 : 0;
}
export function cycle_is_check_spr_crunch(flags: number): number {
    return (flags & CHECK_SPR_M) === CHECK_SPR_CRUNCH ? 1 : 0;
}
export function cycle_is_update_mcbase(flags: number): number {
    return (flags & CHECK_SPR_M) === UPDATE_MCBASE ? 1 : 0;
}
export function cycle_is_check_spr_exp(flags: number): number {
    return (flags & CHECK_SPR_EXP_M) ? 1 : 0;
}
export function cycle_is_check_spr_dma(flags: number): number {
    return (flags & CHECK_SPR_M) === CHECK_SPR_DMA ? 1 : 0;
}
export function cycle_is_check_spr_disp(flags: number): number {
    return (flags & CHECK_SPR_M) === CHECK_SPR_DISP ? 1 : 0;
}
export function cycle_is_check_border_l(flags: number, csel: number): number {
    if (flags & CHECK_BRD_L) {
        return (flags & CHECK_BRD_CSEL) ? csel : (csel ? 0 : 1);
    }
    return 0;
}
export function cycle_is_check_border_r(flags: number, csel: number): number {
    if (flags & CHECK_BRD_R) {
        return (flags & CHECK_BRD_CSEL) ? csel : (csel ? 0 : 1);
    }
    return 0;
}

/* ============================================================
 * vicii-chip-model.c — cycle_tab_pal[] + setter
 * ============================================================ */

/* CamelCase macros from chip-model.c:42+ used by cycle_tab_pal. */
const None         = 0;
const Phi1 = (x: number): number => (x);
const Phi2 = (x: number): number => ((x) | 0x80);
const Vis  = (x: number): number => ((x) | 0x80);
const IsVis  = (x: number): number => ((x) & 0x80);
const GetVis = (x: number): number => ((x) & 0x7f);

const FetchType_M   = 0xf00;
const FetchSprNum_M = 0x007;
const SprPtr  = (x: number): number => (0x100 | (x));
const SprDma0 = (x: number): number => (0x200 | (x));
const SprDma1 = (x: number): number => (0x300 | (x));
const SprDma2 = (x: number): number => (0x400 | (x));
const Refresh = 0x500;
const FetchG  = 0x600;
const FetchC  = 0x700;
const Idle    = 0x800;

const BaFetch    = 0x100;
const BaSpr1 = (x: number): number => (0x000 | (1 << (x)));
const BaSpr2 = (x: number, y: number): number => (0x000 | (1 << (x)) | (1 << (y)));
const BaSpr3 = (x: number, y: number, z: number): number => (0x000 | (1 << (x)) | (1 << (y)) | (1 << (z)));

/* Flags */
const UpdateMcBase = 0x001;
const ChkSprExp    = 0x002;
const ChkSprDma    = 0x004;
const ChkSprDisp   = 0x008;
const ChkSprCrunch = 0x010;
const ChkBrdL1     = 0x020;
const ChkBrdL0     = 0x040;
const ChkBrdR0     = 0x080;
const ChkBrdR1     = 0x100;
const UpdateVc     = 0x200;
const UpdateRc     = 0x400;

interface ViciiCycle {
    cycle: number;
    xpos: number;
    visible: number;
    fetch: number;
    ba: number;
    flags: number;
}

const C = (cycle: number, xpos: number, visible: number, fetch: number, ba: number, flags: number): ViciiCycle => ({ cycle, xpos, visible, fetch, ba, flags });

/* PAL — cycle_tab_pal[126] (chip-model.c:111-237) */
const cycle_tab_pal: ViciiCycle[] = [
    C(Phi1(1),  0x194, None,    SprPtr(3),  BaSpr2(3, 4),    None),
    C(Phi2(1),  0x198, None,    SprDma0(3), BaSpr2(3, 4),    None),
    C(Phi1(2),  0x19c, None,    SprDma1(3), BaSpr3(3, 4, 5), None),
    C(Phi2(2),  0x1a0, None,    SprDma2(3), BaSpr3(3, 4, 5), None),
    C(Phi1(3),  0x1a4, None,    SprPtr(4),  BaSpr2(4, 5),    None),
    C(Phi2(3),  0x1a8, None,    SprDma0(4), BaSpr2(4, 5),    None),
    C(Phi1(4),  0x1ac, None,    SprDma1(4), BaSpr3(4, 5, 6), None),
    C(Phi2(4),  0x1b0, None,    SprDma2(4), BaSpr3(4, 5, 6), None),
    C(Phi1(5),  0x1b4, None,    SprPtr(5),  BaSpr2(5, 6),    None),
    C(Phi2(5),  0x1b8, None,    SprDma0(5), BaSpr2(5, 6),    None),
    C(Phi1(6),  0x1bc, None,    SprDma1(5), BaSpr3(5, 6, 7), None),
    C(Phi2(6),  0x1c0, None,    SprDma2(5), BaSpr3(5, 6, 7), None),
    C(Phi1(7),  0x1c4, None,    SprPtr(6),  BaSpr2(6, 7),    None),
    C(Phi2(7),  0x1c8, None,    SprDma0(6), BaSpr2(6, 7),    None),
    C(Phi1(8),  0x1cc, None,    SprDma1(6), BaSpr2(6, 7),    None),
    C(Phi2(8),  0x1d0, None,    SprDma2(6), BaSpr2(6, 7),    None),
    C(Phi1(9),  0x1d4, None,    SprPtr(7),  BaSpr1(7),       None),
    C(Phi2(9),  0x1d8, None,    SprDma0(7), BaSpr1(7),       None),
    C(Phi1(10), 0x1dc, None,    SprDma1(7), BaSpr1(7),       None),
    C(Phi2(10), 0x1e0, None,    SprDma2(7), BaSpr1(7),       None),
    C(Phi1(11), 0x1e4, None,    Refresh,    None,            None),
    C(Phi2(11), 0x1e8, None,    None,       None,            None),
    C(Phi1(12), 0x1ec, None,    Refresh,    BaFetch,         None),
    C(Phi2(12), 0x1f0, None,    None,       BaFetch,         None),
    C(Phi1(13), 0x1f4, None,    Refresh,    BaFetch,         None),
    C(Phi2(13), 0x000, None,    None,       BaFetch,         None),
    C(Phi1(14), 0x004, None,    Refresh,    BaFetch,         None),
    C(Phi2(14), 0x008, None,    None,       BaFetch,         UpdateVc),
    C(Phi1(15), 0x00c, None,    Refresh,    BaFetch,         None),
    C(Phi2(15), 0x010, None,    FetchC,     BaFetch,         ChkSprCrunch),
    C(Phi1(16), 0x014, None,    FetchG,     BaFetch,         None),
    C(Phi2(16), 0x018, Vis(0),  FetchC,     BaFetch,         UpdateMcBase),
    C(Phi1(17), 0x01c, Vis(0),  FetchG,     BaFetch,         None),
    C(Phi2(17), 0x020, Vis(1),  FetchC,     BaFetch,         ChkBrdL1),
    C(Phi1(18), 0x024, Vis(1),  FetchG,     BaFetch,         None),
    C(Phi2(18), 0x028, Vis(2),  FetchC,     BaFetch,         ChkBrdL0),
    C(Phi1(19), 0x02c, Vis(2),  FetchG,     BaFetch,         None),
    C(Phi2(19), 0x030, Vis(3),  FetchC,     BaFetch,         None),
    C(Phi1(20), 0x034, Vis(3),  FetchG,     BaFetch,         None),
    C(Phi2(20), 0x038, Vis(4),  FetchC,     BaFetch,         None),
    C(Phi1(21), 0x03c, Vis(4),  FetchG,     BaFetch,         None),
    C(Phi2(21), 0x040, Vis(5),  FetchC,     BaFetch,         None),
    C(Phi1(22), 0x044, Vis(5),  FetchG,     BaFetch,         None),
    C(Phi2(22), 0x048, Vis(6),  FetchC,     BaFetch,         None),
    C(Phi1(23), 0x04c, Vis(6),  FetchG,     BaFetch,         None),
    C(Phi2(23), 0x050, Vis(7),  FetchC,     BaFetch,         None),
    C(Phi1(24), 0x054, Vis(7),  FetchG,     BaFetch,         None),
    C(Phi2(24), 0x058, Vis(8),  FetchC,     BaFetch,         None),
    C(Phi1(25), 0x05c, Vis(8),  FetchG,     BaFetch,         None),
    C(Phi2(25), 0x060, Vis(9),  FetchC,     BaFetch,         None),
    C(Phi1(26), 0x064, Vis(9),  FetchG,     BaFetch,         None),
    C(Phi2(26), 0x068, Vis(10), FetchC,     BaFetch,         None),
    C(Phi1(27), 0x06c, Vis(10), FetchG,     BaFetch,         None),
    C(Phi2(27), 0x070, Vis(11), FetchC,     BaFetch,         None),
    C(Phi1(28), 0x074, Vis(11), FetchG,     BaFetch,         None),
    C(Phi2(28), 0x078, Vis(12), FetchC,     BaFetch,         None),
    C(Phi1(29), 0x07c, Vis(12), FetchG,     BaFetch,         None),
    C(Phi2(29), 0x080, Vis(13), FetchC,     BaFetch,         None),
    C(Phi1(30), 0x084, Vis(13), FetchG,     BaFetch,         None),
    C(Phi2(30), 0x088, Vis(14), FetchC,     BaFetch,         None),
    C(Phi1(31), 0x08c, Vis(14), FetchG,     BaFetch,         None),
    C(Phi2(31), 0x090, Vis(15), FetchC,     BaFetch,         None),
    C(Phi1(32), 0x094, Vis(15), FetchG,     BaFetch,         None),
    C(Phi2(32), 0x098, Vis(16), FetchC,     BaFetch,         None),
    C(Phi1(33), 0x09c, Vis(16), FetchG,     BaFetch,         None),
    C(Phi2(33), 0x0a0, Vis(17), FetchC,     BaFetch,         None),
    C(Phi1(34), 0x0a4, Vis(17), FetchG,     BaFetch,         None),
    C(Phi2(34), 0x0a8, Vis(18), FetchC,     BaFetch,         None),
    C(Phi1(35), 0x0ac, Vis(18), FetchG,     BaFetch,         None),
    C(Phi2(35), 0x0b0, Vis(19), FetchC,     BaFetch,         None),
    C(Phi1(36), 0x0b4, Vis(19), FetchG,     BaFetch,         None),
    C(Phi2(36), 0x0b8, Vis(20), FetchC,     BaFetch,         None),
    C(Phi1(37), 0x0bc, Vis(20), FetchG,     BaFetch,         None),
    C(Phi2(37), 0x0c0, Vis(21), FetchC,     BaFetch,         None),
    C(Phi1(38), 0x0c4, Vis(21), FetchG,     BaFetch,         None),
    C(Phi2(38), 0x0c8, Vis(22), FetchC,     BaFetch,         None),
    C(Phi1(39), 0x0cc, Vis(22), FetchG,     BaFetch,         None),
    C(Phi2(39), 0x0d0, Vis(23), FetchC,     BaFetch,         None),
    C(Phi1(40), 0x0d4, Vis(23), FetchG,     BaFetch,         None),
    C(Phi2(40), 0x0d8, Vis(24), FetchC,     BaFetch,         None),
    C(Phi1(41), 0x0dc, Vis(24), FetchG,     BaFetch,         None),
    C(Phi2(41), 0x0e0, Vis(25), FetchC,     BaFetch,         None),
    C(Phi1(42), 0x0e4, Vis(25), FetchG,     BaFetch,         None),
    C(Phi2(42), 0x0e8, Vis(26), FetchC,     BaFetch,         None),
    C(Phi1(43), 0x0ec, Vis(26), FetchG,     BaFetch,         None),
    C(Phi2(43), 0x0f0, Vis(27), FetchC,     BaFetch,         None),
    C(Phi1(44), 0x0f4, Vis(27), FetchG,     BaFetch,         None),
    C(Phi2(44), 0x0f8, Vis(28), FetchC,     BaFetch,         None),
    C(Phi1(45), 0x0fc, Vis(28), FetchG,     BaFetch,         None),
    C(Phi2(45), 0x100, Vis(29), FetchC,     BaFetch,         None),
    C(Phi1(46), 0x104, Vis(29), FetchG,     BaFetch,         None),
    C(Phi2(46), 0x108, Vis(30), FetchC,     BaFetch,         None),
    C(Phi1(47), 0x10c, Vis(30), FetchG,     BaFetch,         None),
    C(Phi2(47), 0x110, Vis(31), FetchC,     BaFetch,         None),
    C(Phi1(48), 0x114, Vis(31), FetchG,     BaFetch,         None),
    C(Phi2(48), 0x118, Vis(32), FetchC,     BaFetch,         None),
    C(Phi1(49), 0x11c, Vis(32), FetchG,     BaFetch,         None),
    C(Phi2(49), 0x120, Vis(33), FetchC,     BaFetch,         None),
    C(Phi1(50), 0x124, Vis(33), FetchG,     BaFetch,         None),
    C(Phi2(50), 0x128, Vis(34), FetchC,     BaFetch,         None),
    C(Phi1(51), 0x12c, Vis(34), FetchG,     BaFetch,         None),
    C(Phi2(51), 0x130, Vis(35), FetchC,     BaFetch,         None),
    C(Phi1(52), 0x134, Vis(35), FetchG,     BaFetch,         None),
    C(Phi2(52), 0x138, Vis(36), FetchC,     BaFetch,         None),
    C(Phi1(53), 0x13c, Vis(36), FetchG,     BaFetch,         None),
    C(Phi2(53), 0x140, Vis(37), FetchC,     BaFetch,         None),
    C(Phi1(54), 0x144, Vis(37), FetchG,     BaFetch,         None),
    C(Phi2(54), 0x148, Vis(38), FetchC,     BaFetch,         None),
    C(Phi1(55), 0x14c, Vis(38), FetchG,     BaSpr1(0),       ChkSprDma),
    C(Phi2(55), 0x150, Vis(39), None,       BaSpr1(0),       None),
    C(Phi1(56), 0x154, Vis(39), Idle,       BaSpr1(0),       ChkSprDma),
    C(Phi2(56), 0x158, None,    None,       BaSpr1(0),       ChkBrdR0 | ChkSprExp),
    C(Phi1(57), 0x15c, None,    Idle,       BaSpr2(0, 1),    None),
    C(Phi2(57), 0x160, None,    None,       BaSpr2(0, 1),    ChkBrdR1),
    C(Phi1(58), 0x164, None,    SprPtr(0),  BaSpr2(0, 1),    ChkSprDisp),
    C(Phi2(58), 0x168, None,    SprDma0(0), BaSpr2(0, 1),    UpdateRc),
    C(Phi1(59), 0x16c, None,    SprDma1(0), BaSpr3(0, 1, 2), None),
    C(Phi2(59), 0x170, None,    SprDma2(0), BaSpr3(0, 1, 2), None),
    C(Phi1(60), 0x174, None,    SprPtr(1),  BaSpr2(1, 2),    None),
    C(Phi2(60), 0x178, None,    SprDma0(1), BaSpr2(1, 2),    None),
    C(Phi1(61), 0x17c, None,    SprDma1(1), BaSpr3(1, 2, 3), None),
    C(Phi2(61), 0x180, None,    SprDma2(1), BaSpr3(1, 2, 3), None),
    C(Phi1(62), 0x184, None,    SprPtr(2),  BaSpr2(2, 3),    None),
    C(Phi2(62), 0x188, None,    SprDma0(2), BaSpr2(2, 3),    None),
    C(Phi1(63), 0x18c, None,    SprDma1(2), BaSpr3(2, 3, 4), None),
    C(Phi2(63), 0x190, None,    SprDma2(2), BaSpr3(2, 3, 4), None),
];

interface ViciiChipModel {
    name: string;
    cycles_per_line: number;
    cycle_tab: ViciiCycle[];
    num_raster_lines: number;
    color_latency: number;
    lightpen_old_irq_mode: number;
    new_luminances: number;
}

const chip_model_mos6569r3: ViciiChipModel = {
    name: "MOS6569R3",
    cycles_per_line: 63,
    cycle_tab: cycle_tab_pal,
    num_raster_lines: 312,
    color_latency: 1,
    lightpen_old_irq_mode: 0,
    new_luminances: 1,
};

/**
 * Literal port of vicii_chip_model_set() from chip-model.c:578.
 * Compresses cycle_tab pairs (Phi1+Phi2) into vicii.cycle_table[65]
 * 32-bit entries.
 */
export function vicii_chip_model_set(cm: ViciiChipModel): void {
    let i: number;
    const xpos_phi: [number, number] = [0, 0];
    const fetch_phi: [number, number] = [0, 0];
    const ba_phi: [number, number] = [0, 0];
    const flags_phi: [number, number] = [0, 0];

    const ct = cm.cycle_tab;

    vicii.cycles_per_line = cm.cycles_per_line;
    vicii.screen_height = cm.num_raster_lines;
    vicii.color_latency = cm.color_latency;
    vicii.lightpen_old_irq_mode = cm.lightpen_old_irq_mode;
    /* vicii.new_luminances        = cm->new_luminances; */

    for (i = 0; i < (cm.cycles_per_line * 2); i++) {
        const phi = (ct[i]!.cycle & 0x80) ? 1 : 0;
        const cycle = ct[i]!.cycle & 0x7f;
        const xpos = ct[i]!.xpos;
        // visible computed but only used for log; preserved for parity
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _visible = IsVis(ct[i]!.visible) ? GetVis(ct[i]!.visible) : -1;
        const fetch = ct[i]!.fetch;
        const ba = ct[i]!.ba;
        const flags = ct[i]!.flags;

        xpos_phi[phi] = xpos;
        fetch_phi[phi] = fetch;
        ba_phi[phi] = ba;
        flags_phi[phi] = flags;

        /* Both Phi1 and Phi2 collected, generate table */
        if (phi === 1) {
            const f = flags_phi[0]! | flags_phi[1]!;

            let entry = 0;

            entry |= (ba_phi[0]! & 0xff /* BaSpr_M */) << SPRITE_BA_MASK_B;
            entry |= (ba_phi[0]! & BaFetch) ? FETCH_BA_M : 0;

            switch (fetch_phi[0]! & FetchType_M) {
                case SprPtr(0):
                    /* Sprite Ptr (Phi1) + DMA0 (Phi2) */
                    entry |= PHI1_SPR_PTR;
                    entry |= (fetch_phi[0]! & FetchSprNum_M) << PHI1_SPR_NUM_B;
                    break;
                case SprDma1(0):
                    /* Sprite DMA1 (Phi1) + DMA2 (Phi2) */
                    entry |= PHI1_SPR_DMA1;
                    entry |= (fetch_phi[0]! & FetchSprNum_M) << PHI1_SPR_NUM_B;
                    break;
                case Refresh:
                    entry |= PHI1_REFRESH;
                    break;
                case FetchG:
                    entry |= PHI1_FETCH_G;
                    break;
                default:
                    entry |= PHI1_IDLE;
                    break;
            }
            /* FetchC (Phi2) */
            if ((fetch_phi[1]! & FetchType_M) === FetchC) {
                entry |= PHI2_FETCH_C_M;
                entry |= VISIBLE_M;
            }
            /* extract xpos */
            entry |= ((xpos_phi[0]! >> 3) << XPOS_B) & XPOS_M;

            /* Update VC/RC (Phi2) */
            if (f & UpdateVc) entry |= UPDATE_VC_M;
            if (f & UpdateRc) entry |= UPDATE_RC_M;

            /* Sprites */
            if (f & ChkSprExp)    entry |= CHECK_SPR_EXP_M;
            if (f & ChkSprDisp)   entry |= CHECK_SPR_DISP;
            if (f & ChkSprDma)    entry |= CHECK_SPR_DMA;
            if (f & UpdateMcBase) entry |= UPDATE_MCBASE;
            if (f & ChkSprCrunch) entry |= CHECK_SPR_CRUNCH;

            /* Border */
            if (f & ChkBrdL0) entry |= CHECK_BRD_L;
            if (f & ChkBrdL1) entry |= CHECK_BRD_L | CHECK_BRD_CSEL;
            if (f & ChkBrdR0) entry |= CHECK_BRD_R;
            if (f & ChkBrdR1) entry |= CHECK_BRD_R | CHECK_BRD_CSEL;

            // Use unsigned right-shift trick to coerce to uint32
            vicii.cycle_table[cycle - 1] = entry >>> 0;
        }
    }
}

/**
 * Literal port of vicii_chip_model_init() from chip-model.c:813.
 * For our PAL-only literal port we hardwire 6569R3.
 */
export function vicii_chip_model_init(): void {
    vicii_chip_model_set(chip_model_mos6569r3);
}
