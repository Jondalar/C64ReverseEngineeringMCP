// KERNAL serial bus state (formerly the Sprint 72 serial trap suite).
//
// Spec 704 §11 R3 — the legacy serial trap LOGIC (handleKernalSerialTrap +
// trapListen/Second/Ciout/Unlsn/Talk/Tksa/Acptr/Untlk + handleDriveCommand)
// was removed: it poked the legacy DriveCpu RAM/PC (M-W/M-E), which no
// longer exists (VICE1541 is the only drive), and it was forbidden in
// true-drive mode anyway (Spec 429 §8). Only the shared serial STATE
// remains — kernal-io.ts still queues channel data through it.

// Public JMP-table entries (kept for any address-label consumers).
export const KERNAL_LISTEN = 0xffb1;
export const KERNAL_SECOND = 0xff93;
export const KERNAL_CIOUT  = 0xffa8;
export const KERNAL_UNLSN  = 0xffae;
export const KERNAL_TALK   = 0xffb4;
export const KERNAL_TKSA   = 0xff96;
export const KERNAL_ACPTR  = 0xffa5;
export const KERNAL_UNTLK  = 0xffab;
export const KERNAL_LISTEN_INT = 0xed0c;
export const KERNAL_SECOND_INT = 0xedb9;
export const KERNAL_CIOUT_INT  = 0xeddd;
export const KERNAL_UNLSN_INT  = 0xedfe;
export const KERNAL_TALK_INT   = 0xed09;
export const KERNAL_TKSA_INT   = 0xedc7;
export const KERNAL_ACPTR_INT  = 0xee13;
export const KERNAL_UNTLK_INT  = 0xedef;

export interface KernalSerialState {
  // Listener side: which device + secondary the controller is talking to.
  listenerDevice?: number;
  listenerSecondary?: number;
  listenerBuffer: number[]; // CIOUT bytes accumulated until UNLSN
  // Talker side.
  talkerDevice?: number;
  talkerSecondary?: number;
  // Per-channel queued data for ACPTR to drain (for OPEN-then-TALK loads).
  channelQueue: Map<number, Uint8Array>;
  channelCursor: Map<number, number>;
  // Most recent trap label for diagnostics.
  lastTrap?: string;
  // Counters.
  loadEvents: Array<{ name: string; bytes: number }>;
  mwEvents: Array<{ addr: number; bytes: number }>;
  meEvents: Array<{ addr: number }>;
  // Sprint 75 instrumentation: full trace of every bus transaction.
  sequenceLog: Array<{ ts: number; event: string; detail?: string }>;
  sequenceLogEnabled: boolean;
  sequenceCounter: number;
}

export function makeKernalSerialState(): KernalSerialState {
  return {
    listenerBuffer: [],
    channelQueue: new Map(),
    channelCursor: new Map(),
    loadEvents: [],
    mwEvents: [],
    meEvents: [],
    sequenceLog: [],
    sequenceLogEnabled: false,
    sequenceCounter: 0,
  };
}
