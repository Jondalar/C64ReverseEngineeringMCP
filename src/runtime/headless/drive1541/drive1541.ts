export type Drive1541Implementation = "legacy" | "vice";

export interface Drive1541IecSample {
  drv_data_pull: boolean;
  drv_clk_pull: boolean;
  drv_atna_pull: boolean;
}

export interface Drive1541IecInput {
  bus_atn: boolean;
  bus_clk: boolean;
  bus_data: boolean;
}

export interface Drive1541Media {
  kind: "d64" | "g64" | "p64";
  bytes: Uint8Array;
  readOnly: boolean;
}

export interface Drive1541DebugProbe {
  drive_pc: number;
  head_halftrack: number;
  led: number;
}

export interface Drive1541 {
  iecLineSample(): Drive1541IecSample;
  iecLineDrive(c64Side: Drive1541IecInput): void;
  catchUpTo(c64Clock: number): number;
  flush(): void;
  attachDisk(media: Drive1541Media): void;
  detachDisk(): void;
  setWriteProtect(on: boolean): void;
  reset(kind: "cold" | "warm"): void;
  snapshot(): Uint8Array;
  restore(blob: Uint8Array): void;
  debugProbe?(): Drive1541DebugProbe;
}
