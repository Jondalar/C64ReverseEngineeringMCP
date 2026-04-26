// Pre-baked KERNAL routine ABI table.
// Used by the pre-JSR immediate-rewrite pass to emit `#<label / #>label`
// instead of raw byte immediates when (X,Y) (or other register pairs)
// form a 16-bit pointer to a labelled address.

export type RegisterName = "a" | "x" | "y";

export type RegisterRole =
  | "length"
  | "device"
  | "logical"
  | "secondary"
  | "verify-flag"
  | "msg-flag"
  | "timeout-flag"
  | "byte"
  | "zp-pointer"
  | "row"
  | "column"
  | "carry-direction";

export interface PointerPair {
  low: RegisterName;
  high: RegisterName;
}

export interface KernalAbi {
  address: number;
  name: string;
  description: string;
  registers?: Partial<Record<RegisterName, RegisterRole>>;
  pointerPairs?: PointerPair[];
}

const KERNAL_ABI_TABLE: KernalAbi[] = [
  { address: 0xff81, name: "CINT", description: "Initialize screen editor and VIC chip" },
  { address: 0xff84, name: "IOINIT", description: "Initialize I/O" },
  { address: 0xff87, name: "RAMTAS", description: "Initialize RAM and screen" },
  { address: 0xff8a, name: "RESTOR", description: "Restore default I/O vectors" },
  {
    address: 0xff8d,
    name: "VECTOR",
    description: "Read or set the I/O vector table; (X,Y) = pointer to user table, C set = read",
    pointerPairs: [{ low: "x", high: "y" }],
    registers: { a: "carry-direction" },
  },
  { address: 0xff90, name: "SETMSG", description: "Set system error/message flags", registers: { a: "msg-flag" } },
  { address: 0xff93, name: "SECOND", description: "Send secondary address after LISTEN", registers: { a: "secondary" } },
  { address: 0xff96, name: "TKSA", description: "Send secondary address after TALK", registers: { a: "secondary" } },
  {
    address: 0xff99,
    name: "MEMTOP",
    description: "Read/set top of RAM; (X,Y) = pointer, C set = read",
    pointerPairs: [{ low: "x", high: "y" }],
    registers: { a: "carry-direction" },
  },
  {
    address: 0xff9c,
    name: "MEMBOT",
    description: "Read/set bottom of RAM; (X,Y) = pointer, C set = read",
    pointerPairs: [{ low: "x", high: "y" }],
    registers: { a: "carry-direction" },
  },
  { address: 0xff9f, name: "SCNKEY", description: "Scan keyboard" },
  { address: 0xffa2, name: "SETTMO", description: "Set IEEE timeout flag", registers: { a: "timeout-flag" } },
  { address: 0xffa5, name: "ACPTR", description: "Input byte from serial bus" },
  { address: 0xffa8, name: "CIOUT", description: "Output byte to serial bus", registers: { a: "byte" } },
  { address: 0xffab, name: "UNTLK", description: "Send UNTALK to serial bus" },
  { address: 0xffae, name: "UNLSN", description: "Send UNLISTEN to serial bus" },
  { address: 0xffb1, name: "LISTEN", description: "Command device to LISTEN", registers: { a: "device" } },
  { address: 0xffb4, name: "TALK", description: "Command device to TALK", registers: { a: "device" } },
  { address: 0xffb7, name: "READST", description: "Read I/O status word into A" },
  {
    address: 0xffba,
    name: "SETLFS",
    description: "Set logical, device, secondary address",
    registers: { a: "logical", x: "device", y: "secondary" },
  },
  {
    address: 0xffbd,
    name: "SETNAM",
    description: "Set filename: A=length, (X,Y)=pointer to name buffer",
    registers: { a: "length" },
    pointerPairs: [{ low: "x", high: "y" }],
  },
  { address: 0xffc0, name: "OPEN", description: "Open a logical file (uses SETLFS/SETNAM)" },
  { address: 0xffc3, name: "CLOSE", description: "Close a logical file", registers: { a: "logical" } },
  { address: 0xffc6, name: "CHKIN", description: "Open channel for input", registers: { x: "logical" } },
  { address: 0xffc9, name: "CHKOUT", description: "Open channel for output", registers: { x: "logical" } },
  { address: 0xffcc, name: "CLRCHN", description: "Clear all channels and restore defaults" },
  { address: 0xffcf, name: "CHRIN", description: "Read byte from current input channel into A" },
  { address: 0xffd2, name: "CHROUT", description: "Write byte from A to current output channel", registers: { a: "byte" } },
  {
    address: 0xffd5,
    name: "LOAD",
    description: "Load a file: A=verify flag, (X,Y)=load address override (when SA=0)",
    registers: { a: "verify-flag" },
    pointerPairs: [{ low: "x", high: "y" }],
  },
  {
    address: 0xffd8,
    name: "SAVE",
    description: "Save memory: A=ZP pointer to start, (X,Y)=end address",
    registers: { a: "zp-pointer" },
    pointerPairs: [{ low: "x", high: "y" }],
  },
  { address: 0xffdb, name: "SETTIM", description: "Set jiffy clock from A,X,Y" },
  { address: 0xffde, name: "RDTIM", description: "Read jiffy clock into A,X,Y" },
  { address: 0xffe1, name: "STOP", description: "Check STOP key (Z flag set if pressed)" },
  { address: 0xffe4, name: "GETIN", description: "Get one byte from input channel into A" },
  { address: 0xffe7, name: "CLALL", description: "Close all channels and files" },
  { address: 0xffea, name: "UDTIM", description: "Update jiffy clock and STOP-key state" },
  { address: 0xffed, name: "SCREEN", description: "Return current screen size: X=cols, Y=rows" },
  {
    address: 0xfff0,
    name: "PLOT",
    description: "Read or set cursor position: X=row, Y=col, C set = read",
    registers: { x: "row", y: "column", a: "carry-direction" },
  },
  { address: 0xfff3, name: "IOBASE", description: "Return base address of I/O block in X,Y" },
];

const KERNAL_ABI_BY_ADDRESS: Map<number, KernalAbi> = new Map(
  KERNAL_ABI_TABLE.map((entry) => [entry.address, entry]),
);

export function lookupKernalAbi(address: number): KernalAbi | undefined {
  return KERNAL_ABI_BY_ADDRESS.get(address);
}

export function listKernalAbiEntries(): readonly KernalAbi[] {
  return KERNAL_ABI_TABLE;
}
