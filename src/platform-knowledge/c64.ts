// Spec 020: C64 platform knowledge tables. The renderer falls back to
// these whenever an artifact does not carry a different `platform` tag.
// For now this module exposes minimal seed data that downstream renderer
// integration can grow against. The existing C64-specific constants in
// pipeline/src/lib/prg-disasm.ts remain authoritative until the renderer
// is rewired to consume PlatformKnowledge directly.

export interface PlatformKnowledge {
  zp: Record<number, string>;
  io: Record<number, { name: string; description?: string }>;
  rom: Record<number, string>;
  ramRangeAnnotations?: Array<{ start: number; end: number; name: string; description?: string }>;
}

export const c64PlatformKnowledge: PlatformKnowledge = {
  zp: {
    0x00: "CPU DDR (data direction register)",
    0x01: "CPU port (ROM/IO banking)",
  },
  io: {
    0xd000: { name: "VIC sprite 0 X" },
    0xd011: { name: "VIC control 1" },
    0xd016: { name: "VIC control 2" },
    0xd018: { name: "VIC memory pointer" },
    0xd400: { name: "SID voice 1 frequency lo" },
    0xdc00: { name: "CIA1 PRA (keyboard col)" },
    0xdc01: { name: "CIA1 PRB (keyboard row)" },
    0xdd00: { name: "CIA2 PRA (VIC bank / RS232)" },
  },
  rom: {
    0xffba: "SETLFS",
    0xffbd: "SETNAM",
    0xffd2: "CHROUT",
    0xffd5: "LOAD",
    0xffd8: "SAVE",
    0xffe1: "STOP",
    0xfff6: "Vector reserved",
  },
};
