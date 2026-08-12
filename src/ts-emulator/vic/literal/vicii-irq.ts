// ════════════════════════════════════════════════════════════════════════════
//  DEPRECATED — TypeScript runtime.  THE PRODUCT RUNTIME IS TRX64.
//
//  This file is part of the in-process TS emulator. It is reachable ONLY with
//  C64RE_RUNTIME_TS=1 and is never on the default path: every runtime_* tool,
//  the workspace UI and the MCP surface route to the TRX64 daemon (Spec 771).
//
//  Do not extend it, do not fix forward in it, and do not cite it as current
//  behaviour — "how the runtime works" means TRX64, in ../TRX64.
//  Its remaining job is to be a parity oracle for the port; when that is no
//  longer needed it goes. See DOCTRINE.md.
// ════════════════════════════════════════════════════════════════════════════
// Spec 298g — LITERAL port of viciisc/vicii-irq.c.
//
// Source: /Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-irq.c

import { vicii } from "./vicii-types.js";

/* Host adapter — VICE's maincpu_set_irq + maincpu_set_irq_clk +
 * maincpu_clk + interrupt_cpu_status_int_new. Provided by 298k
 * integration; default is no-op so smokes work standalone. */
export interface IrqHost {
    maincpu_set_irq: (int_num: number, value: number) => void;
    maincpu_set_irq_clk: (int_num: number, value: number, mclk: number) => void;
    maincpu_clk: () => number;
    interrupt_cpu_status_int_new: (name: string) => number;
}

let host: IrqHost = {
    maincpu_set_irq: () => {},
    maincpu_set_irq_clk: () => {},
    maincpu_clk: () => 0,
    interrupt_cpu_status_int_new: () => 0,
};

export function setIrqHost(h: IrqHost): void {
    host = h;
}

/* vicii-irq.c:36 */
export function vicii_irq_set_line(): void {
    if (vicii.irq_status & vicii.regs[0x1a]!) {
        vicii.irq_status |= 0x80;
        host.maincpu_set_irq(vicii.int_num, 1);
    } else {
        vicii.irq_status &= 0x7f;
        host.maincpu_set_irq(vicii.int_num, 0);
    }
}

/* vicii-irq.c:47 */
function vicii_irq_set_line_clk(mclk: number): void {
    if (vicii.irq_status & vicii.regs[0x1a]!) {
        vicii.irq_status |= 0x80;
        host.maincpu_set_irq_clk(vicii.int_num, 1, mclk);
    } else {
        vicii.irq_status &= 0x7f;
        host.maincpu_set_irq_clk(vicii.int_num, 0, mclk);
    }
}

/* vicii-irq.c:58 */
export function vicii_irq_raster_set(mclk: number): void {
    vicii.irq_status |= 0x1;
    vicii_irq_set_line_clk(mclk);
}

/* vicii-irq.c:64 */
export function vicii_irq_raster_clear(mclk: number): void {
    vicii.irq_status &= 0xfe;
    vicii_irq_set_line_clk(mclk);
}

/* vicii-irq.c:70 */
export function vicii_irq_sbcoll_set(): void {
    vicii.irq_status |= 0x2;
    vicii_irq_set_line();
}

/* vicii-irq.c:76 */
export function vicii_irq_sbcoll_clear(): void {
    vicii.irq_status &= 0xfd;
    vicii_irq_set_line();
}

/* vicii-irq.c:82 */
export function vicii_irq_sscoll_set(): void {
    vicii.irq_status |= 0x4;
    vicii_irq_set_line();
}

/* vicii-irq.c:88 */
export function vicii_irq_sscoll_clear(): void {
    vicii.irq_status &= 0xfb;
    vicii_irq_set_line();
}

/* vicii-irq.c:94 */
export function vicii_irq_lightpen_set(): void {
    vicii.irq_status |= 0x8;
    vicii_irq_set_line();
}

/* vicii-irq.c:100 */
export function vicii_irq_lightpen_clear(): void {
    vicii.irq_status &= 0xf7;
    vicii_irq_set_line();
}

/* vicii-irq.c:106 — empty in VICE */
export function vicii_irq_set_raster_line(_line: number): void {
}

/* vicii-irq.c:110 — empty in VICE */
export function vicii_irq_check_state(_value: number, _high: number): void {
}

/* vicii-irq.c:116 */
export function vicii_irq_raster_trigger(): void {
    if (!(vicii.irq_status & 0x1)) {
        vicii_irq_raster_set(host.maincpu_clk());
    }
}

/* vicii-irq.c:123 */
export function vicii_irq_init(): void {
    vicii.int_num = host.interrupt_cpu_status_int_new("VICII");
}
