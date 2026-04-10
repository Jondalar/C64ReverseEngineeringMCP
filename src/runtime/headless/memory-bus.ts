export interface HeadlessIoHandler {
  read?(address: number): number | undefined;
  write?(address: number, value: number): void;
}

function clampByte(value: number): number {
  return value & 0xff;
}

function clampWord(value: number): number {
  return value & 0xffff;
}

export class HeadlessMemoryBus {
  public readonly ram = new Uint8Array(0x10000);
  public readonly basicRom = new Uint8Array(0x2000);
  public readonly kernalRom = new Uint8Array(0x2000);
  public readonly charRom = new Uint8Array(0x1000);
  public readonly io = new Uint8Array(0x1000);

  private readonly ioHandlers = new Map<number, HeadlessIoHandler>();
  private cpuPortDirection = 0x2f;
  private cpuPortValue = 0x37;

  reset(): void {
    this.cpuPortDirection = 0x2f;
    this.cpuPortValue = 0x37;
    this.ram[0x0000] = this.cpuPortDirection;
    this.ram[0x0001] = this.cpuPortValue;
  }

  getCpuPortDirection(): number {
    return this.cpuPortDirection;
  }

  getCpuPortValue(): number {
    return this.cpuPortValue;
  }

  registerIoHandler(address: number, handler: HeadlessIoHandler): void {
    this.ioHandlers.set(clampWord(address), handler);
  }

  loadBasicRom(data: Uint8Array): void {
    this.basicRom.set(data.slice(0, this.basicRom.length));
  }

  loadKernalRom(data: Uint8Array): void {
    this.kernalRom.set(data.slice(0, this.kernalRom.length));
  }

  loadCharRom(data: Uint8Array): void {
    this.charRom.set(data.slice(0, this.charRom.length));
  }

  loadBytes(address: number, data: Uint8Array): void {
    const start = clampWord(address);
    const available = Math.min(data.length, 0x10000 - start);
    this.ram.set(data.slice(0, available), start);
  }

  readRange(start: number, endInclusive: number): Uint8Array {
    const normalizedStart = clampWord(start);
    const normalizedEnd = clampWord(endInclusive);
    if (normalizedEnd < normalizedStart) {
      throw new Error(`Invalid range ${normalizedStart.toString(16)}-${normalizedEnd.toString(16)}`);
    }
    return this.ram.slice(normalizedStart, normalizedEnd + 1);
  }

  read(address: number): number {
    const normalized = clampWord(address);
    if (normalized === 0x0000) {
      return this.cpuPortDirection;
    }
    if (normalized === 0x0001) {
      return this.cpuPortValue;
    }
    if (normalized >= 0xa000 && normalized <= 0xbfff && this.basicVisible()) {
      return this.basicRom[normalized - 0xa000]!;
    }
    if (normalized >= 0xd000 && normalized <= 0xdfff) {
      if (this.ioVisible()) {
        const handler = this.ioHandlers.get(normalized);
        const value = handler?.read?.(normalized);
        if (value !== undefined) {
          this.io[normalized - 0xd000] = clampByte(value);
        }
        return this.io[normalized - 0xd000]!;
      }
      if (this.charVisible()) {
        return this.charRom[normalized - 0xd000]!;
      }
    }
    if (normalized >= 0xe000 && normalized <= 0xffff && this.kernalVisible()) {
      return this.kernalRom[normalized - 0xe000]!;
    }
    return this.ram[normalized]!;
  }

  write(address: number, value: number): void {
    const normalized = clampWord(address);
    const byte = clampByte(value);
    if (normalized === 0x0000) {
      this.cpuPortDirection = byte;
      this.ram[0x0000] = byte;
      return;
    }
    if (normalized === 0x0001) {
      this.cpuPortValue = byte;
      this.ram[0x0001] = byte;
      return;
    }
    if (normalized >= 0xd000 && normalized <= 0xdfff && this.ioVisible()) {
      this.io[normalized - 0xd000] = byte;
      this.ioHandlers.get(normalized)?.write?.(normalized, byte);
      return;
    }
    this.ram[normalized] = byte;
  }

  private basicVisible(): boolean {
    const port = this.cpuPortValue & 0x07;
    return (port & 0x03) === 0x03;
  }

  private kernalVisible(): boolean {
    return (this.cpuPortValue & 0x02) !== 0;
  }

  private ioVisible(): boolean {
    const port = this.cpuPortValue & 0x07;
    return (port & 0x04) !== 0 && (port & 0x03) !== 0;
  }

  private charVisible(): boolean {
    const port = this.cpuPortValue & 0x07;
    return (port & 0x04) === 0 && (port & 0x03) !== 0;
  }
}
