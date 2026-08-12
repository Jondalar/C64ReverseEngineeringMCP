// Spec 232 — canonical event families for V2 LLM workbench.
//
// Closed enum of 24 event kinds. Each row carries fixed required
// fields plus family-specific payload. Persisted via existing
// Spec 217 DuckDB store; query API in `query-events.ts`.

export type EventFamily =
  | "cpu_step"
  | "cpu_jam"
  | "mem_read"
  | "mem_write"
  | "mem_indirect_resolve"
  | "irq_assert"
  | "irq_ack"
  | "nmi_assert"
  | "reset_assert"
  | "vic_badline"
  | "vic_raster_irq"
  | "vic_sprite_collision"
  | "vic_dma_steal"
  | "cia_timer_underflow"
  | "cia_register_read"
  | "cia_register_write"
  | "via_timer_underflow"
  | "via_register_read"
  | "via_register_write"
  | "sid_register_write"
  | "drive_atn_change"
  | "drive_data_change"
  | "drive_clk_change"
  | "gcr_byte"
  | "keyboard_press"
  | "keyboard_release"
  | "trap_fire"
  | "hook_audit"
  | "breakpoint_hit";

export const ALL_EVENT_FAMILIES: readonly EventFamily[] = [
  "cpu_step", "cpu_jam",
  "mem_read", "mem_write", "mem_indirect_resolve",
  "irq_assert", "irq_ack", "nmi_assert", "reset_assert",
  "vic_badline", "vic_raster_irq", "vic_sprite_collision", "vic_dma_steal",
  "cia_timer_underflow", "cia_register_read", "cia_register_write",
  "via_timer_underflow", "via_register_read", "via_register_write",
  "sid_register_write",
  "drive_atn_change", "drive_data_change", "drive_clk_change", "gcr_byte",
  "keyboard_press", "keyboard_release",
  "trap_fire", "hook_audit", "breakpoint_hit",
] as const;

// ---- Common fields on every event row ----
export interface EventRowCommon {
  runId: string;
  cycle: number;
  family: EventFamily;
}

// ---- Family-specific payloads ----
export interface CpuStepEvent extends EventRowCommon {
  family: "cpu_step";
  pc: number; opcode: number;
  a: number; x: number; y: number; sp: number; flags: number;
}

export interface MemReadEvent extends EventRowCommon {
  family: "mem_read";
  pc: number; addr: number; value: number; region: string;
}

export interface MemWriteEvent extends EventRowCommon {
  family: "mem_write";
  pc: number; addr: number; value: number; region: string;
}

export interface MemIndirectResolveEvent extends EventRowCommon {
  family: "mem_indirect_resolve";
  pc: number; opcode: number;
  mode: "ind" | "izx" | "izy" | "ind_jmp";
  operandAddr: number; resolvedAddr: number;
}

export interface IrqEvent extends EventRowCommon {
  family: "irq_assert" | "irq_ack" | "nmi_assert";
  source: "cia1" | "cia2" | "vic" | "via1" | "via2" | "manual";
}

export interface ResetEvent extends EventRowCommon {
  family: "reset_assert";
  kind: "cold" | "warm";
}

export interface VicBadlineEvent extends EventRowCommon {
  family: "vic_badline";
  rasterY: number;
}

export interface VicRasterIrqEvent extends EventRowCommon {
  family: "vic_raster_irq";
  rasterY: number;
}

export interface VicSpriteCollisionEvent extends EventRowCommon {
  family: "vic_sprite_collision";
  collisionKind: "sprite_bg" | "sprite_sprite";
  mask: number;
}

export interface VicDmaStealEvent extends EventRowCommon {
  family: "vic_dma_steal";
  rasterY: number;
  cyclesStolen: number;
}

export interface CiaTimerUnderflowEvent extends EventRowCommon {
  family: "cia_timer_underflow";
  chip: "cia1" | "cia2";
  timer: "ta" | "tb";
}

export interface CiaRegisterEvent extends EventRowCommon {
  family: "cia_register_read" | "cia_register_write";
  chip: "cia1" | "cia2";
  reg: number; value: number;
}

export interface ViaTimerUnderflowEvent extends EventRowCommon {
  family: "via_timer_underflow";
  chip: "via1" | "via2";
  timer: "ta" | "tb";
}

export interface ViaRegisterEvent extends EventRowCommon {
  family: "via_register_read" | "via_register_write";
  chip: "via1" | "via2";
  reg: number; value: number;
}

export interface SidRegisterWriteEvent extends EventRowCommon {
  family: "sid_register_write";
  reg: number; value: number;
}

export interface DriveLineChangeEvent extends EventRowCommon {
  family: "drive_atn_change" | "drive_data_change" | "drive_clk_change";
  dir?: "c64" | "drive";
  level: 0 | 1;
}

export interface GcrByteEvent extends EventRowCommon {
  family: "gcr_byte";
  byte: number; trackHalf: number;
}

export interface KeyboardEvent extends EventRowCommon {
  family: "keyboard_press" | "keyboard_release";
  scancode: string;
}

export interface TrapFireEvent extends EventRowCommon {
  family: "trap_fire";
  hookName: string;
}

export interface HookAuditEvent extends EventRowCommon {
  family: "hook_audit";
  hookName: string;
  mode: string;
}

export interface BreakpointHitEvent extends EventRowCommon {
  family: "breakpoint_hit";
  breakpointId: string;
  pc: number;
}

export interface CpuJamEvent extends EventRowCommon {
  family: "cpu_jam";
  pc: number; opcode: number;
}

export type EventRow =
  | CpuStepEvent
  | CpuJamEvent
  | MemReadEvent
  | MemWriteEvent
  | MemIndirectResolveEvent
  | IrqEvent
  | ResetEvent
  | VicBadlineEvent
  | VicRasterIrqEvent
  | VicSpriteCollisionEvent
  | VicDmaStealEvent
  | CiaTimerUnderflowEvent
  | CiaRegisterEvent
  | ViaTimerUnderflowEvent
  | ViaRegisterEvent
  | SidRegisterWriteEvent
  | DriveLineChangeEvent
  | GcrByteEvent
  | KeyboardEvent
  | TrapFireEvent
  | HookAuditEvent
  | BreakpointHitEvent;
