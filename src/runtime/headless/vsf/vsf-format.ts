// VICE Snapshot Format (VSF) chunk parser + writer.
//
// Format (informed by VICE src/snapshot.c — no code lifted):
//
//   File header:
//     Magic           19 bytes  "VICE Snapshot File\032"
//     Version major   1 byte
//     Version minor   1 byte
//     Machine name    null-terminated ASCII (e.g. "C64\0")
//
//   Module chunk (repeated until EOF):
//     Module name     null-terminated ASCII (e.g. "MAINCPU\0")
//     Major version   1 byte
//     Minor version   1 byte
//     Length          4 bytes little-endian (data length, excluding
//                                            this header)
//     Data            <length> bytes
//
// Sprint 64 implements just enough to round-trip the modules we own
// (drive CPU + RAM, VIAs, IEC bus, GCR head, optionally C64 RAM /
// MainCPU once full headless C64 lands).

const VSF_MAGIC_TEXT = "VICE Snapshot File";
export const VSF_MAGIC_BYTES = new TextEncoder().encode(VSF_MAGIC_TEXT);
export const VSF_VERSION_MAJOR = 2;
export const VSF_VERSION_MINOR = 0;
export const VSF_MACHINE_C64 = "C64";

export interface VsfModuleChunk {
  name: string;
  versionMajor: number;
  versionMinor: number;
  data: Uint8Array;
}

export interface VsfFile {
  versionMajor: number;
  versionMinor: number;
  machineName: string;
  modules: VsfModuleChunk[];
}

export class VsfWriter {
  private parts: Uint8Array[] = [];

  constructor(machineName: string = VSF_MACHINE_C64) {
    this.parts.push(VSF_MAGIC_BYTES);
    this.parts.push(new Uint8Array([VSF_VERSION_MAJOR, VSF_VERSION_MINOR]));
    this.parts.push(asciiZ(machineName));
  }

  addModule(name: string, data: Uint8Array, versionMajor: number = 1, versionMinor: number = 0): void {
    this.parts.push(asciiZ(name));
    const lenBytes = new Uint8Array(4);
    lenBytes[0] = data.length & 0xff;
    lenBytes[1] = (data.length >> 8) & 0xff;
    lenBytes[2] = (data.length >> 16) & 0xff;
    lenBytes[3] = (data.length >> 24) & 0xff;
    this.parts.push(new Uint8Array([versionMajor, versionMinor]));
    this.parts.push(lenBytes);
    this.parts.push(data);
  }

  toBytes(): Uint8Array {
    const total = this.parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of this.parts) { out.set(p, off); off += p.length; }
    return out;
  }
}

export function readVsf(bytes: Uint8Array): VsfFile {
  let off = 0;
  // Magic check.
  if (bytes.length < VSF_MAGIC_BYTES.length) throw new Error("VSF too short for magic");
  for (let i = 0; i < VSF_MAGIC_BYTES.length; i++) {
    if (bytes[off + i] !== VSF_MAGIC_BYTES[i]) {
      throw new Error("VSF magic mismatch — not a VICE snapshot file");
    }
  }
  off += VSF_MAGIC_BYTES.length;
  if (off + 2 > bytes.length) throw new Error("VSF truncated at version bytes");
  const versionMajor = bytes[off++]!;
  const versionMinor = bytes[off++]!;
  const { value: machineName, next: nextAfterMachine } = readAsciiZ(bytes, off);
  off = nextAfterMachine;
  const modules: VsfModuleChunk[] = [];
  while (off < bytes.length) {
    const { value: name, next: nextAfterName } = readAsciiZ(bytes, off);
    off = nextAfterName;
    if (off + 6 > bytes.length) throw new Error(`VSF truncated in module ${name} header`);
    const modMajor = bytes[off++]!;
    const modMinor = bytes[off++]!;
    const len = bytes[off]! | (bytes[off + 1]! << 8) | (bytes[off + 2]! << 16) | (bytes[off + 3]! << 24);
    off += 4;
    if (off + len > bytes.length) throw new Error(`VSF truncated in module ${name} data (need ${len} bytes, have ${bytes.length - off})`);
    modules.push({
      name,
      versionMajor: modMajor,
      versionMinor: modMinor,
      data: bytes.slice(off, off + len),
    });
    off += len;
  }
  return { versionMajor, versionMinor, machineName, modules };
}

function asciiZ(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes, 0);
  out[bytes.length] = 0;
  return out;
}

function readAsciiZ(bytes: Uint8Array, off: number): { value: string; next: number } {
  const end = bytes.indexOf(0, off);
  if (end < 0) throw new Error("VSF truncated reading null-terminated string");
  return { value: new TextDecoder().decode(bytes.slice(off, end)), next: end + 1 };
}
