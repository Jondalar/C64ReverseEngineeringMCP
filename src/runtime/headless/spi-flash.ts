// Spec 713 — source-faithful port of VICE core/spi-flash.c.
//
// Serial (SPI) flash used by GMOD3. Driven by CS / CLK / DI; commands are
// shifted MSB-first on the rising clock edge. Implements the subset VICE does:
// READ_DATA, PAGE_PROGRAM (clears bits, `data &= in`), BLOCK_ERASE (64K),
// WRITE_ENABLE, READ_STATUS, REMS (read electronic manufacturer/device id).
// Operates on a shared flash-data array (set via setImage) — the same bytes the
// GMOD3 ROML read path indexes directly.

const FLASH_CMD_PAGE_PROGRAM = 0x02;
const FLASH_CMD_READ_DATA = 0x03;
const FLASH_CMD_READ_STATUS = 0x05;
const FLASH_CMD_WRITE_ENABLE = 0x06;
const FLASH_CMD_BLOCK_ERASE = 0xd8;
const FLASH_CMD_REMS = 0x9f;
const STATUSBUSY = 0;

const SPI_2MB = 2 * 1024 * 1024, SPI_4MB = 4 * 1024 * 1024, SPI_8MB = 8 * 1024 * 1024, SPI_16MB = 16 * 1024 * 1024;

export interface SpiFlashSnapState {
  cs: number; clock: number; dataIn: number; dataOut: number;
  inSR: number; inCount: number; outSR: number; outCount: number;
  command: number; addr: number; writeEnable: number; readyBusy: number;
}

export class SpiFlash {
  private data: Uint8Array = new Uint8Array(0);
  private size = 0;
  private eeprom_cs = 0;
  private eeprom_clock = 0;
  private eeprom_data_in = 0;
  private eeprom_data_out = 0;
  private input_shiftreg = 0;
  private input_count = 0;
  private output_shiftreg = 0;
  private output_count = 0;
  private command = 0;
  private addr = 0;
  private write_enable_status = 0;
  private ready_busy_status = 1;
  private dirty = false;

  setImage(img: Uint8Array, size: number): void { this.data = img; this.size = size; }
  isDirty(): boolean { return this.dirty; }
  /** BUG-040 — monotonic mutation counter for the auto-persist debounce. */
  private generation = 0;
  writableGeneration(): number { return this.generation; }

  private reset_input_shiftreg(): void { this.input_shiftreg = 0; this.input_count = 0; }
  private reset_output_shiftreg(): void { this.output_shiftreg = 0; this.output_count = 0; }
  private shift_input_shiftreg(): void {
    this.input_shiftreg = (((this.input_shiftreg << 1) >>> 0) | this.eeprom_data_in) >>> 0;
    this.input_count++;
  }
  private shift_output_shiftreg(): void {
    if (this.output_count) {
      this.eeprom_data_out = (this.output_shiftreg >>> 31) & 1;
      this.output_shiftreg = (this.output_shiftreg << 1) >>> 0;
      this.output_count--;
    } else {
      this.eeprom_data_out = 0;
    }
  }

  read_data(): number { return this.eeprom_cs === 0 ? this.eeprom_data_out : 0; }
  write_data(value: number): void { if (this.eeprom_cs === 0) this.eeprom_data_in = value & 1; }

  write_select(value: number): void {
    value = value & 1;
    if (this.eeprom_cs === 1 && value === 0) {
      this.reset_input_shiftreg();
      this.reset_output_shiftreg();
    } else if (this.eeprom_cs === 0 && value === 1) {
      switch (this.command) {
        case FLASH_CMD_REMS: break;
        case FLASH_CMD_READ_STATUS: break;
        case FLASH_CMD_BLOCK_ERASE:
          this.addr = (this.input_shiftreg & 0xff0000) & (this.size - 1);
          this.data.fill(0xff, this.addr, this.addr + 0x10000);
          this.dirty = true; this.generation++;
          this.command = STATUSBUSY;
          break;
        case FLASH_CMD_WRITE_ENABLE: this.write_enable_status = 1; break;
        case FLASH_CMD_PAGE_PROGRAM: this.command = STATUSBUSY; break;
        case FLASH_CMD_READ_DATA: this.command = STATUSBUSY; break;
        default: break;
      }
    }
    this.eeprom_cs = value;
  }

  write_clock(value: number): void {
    value = value & 1;
    if (this.eeprom_cs === 0 && value === 1 && this.eeprom_clock === 0) {
      this.shift_input_shiftreg();
      switch (this.input_count) {
        case 8:
          if (this.command === FLASH_CMD_PAGE_PROGRAM) {
            this.addr &= (this.size - 1);
            this.data[this.addr] = (this.data[this.addr]! & this.input_shiftreg) & 0xff;
            this.dirty = true; this.generation++;
            this.addr++;
            this.reset_input_shiftreg();
          } else if (this.command === FLASH_CMD_READ_DATA) {
            this.addr &= (this.size - 1);
            this.output_shiftreg = ((this.data[this.addr]! << 24) >>> 0);
            this.output_count = 8;
            this.addr++;
            this.reset_input_shiftreg();
          } else {
            switch (this.input_shiftreg & 0xff) {
              case FLASH_CMD_REMS: this.command = FLASH_CMD_REMS; break;
              case FLASH_CMD_READ_STATUS:
                this.command = FLASH_CMD_READ_STATUS;
                this.output_shiftreg = 0x01000000; this.output_count = 8;
                break;
              case FLASH_CMD_BLOCK_ERASE: this.command = FLASH_CMD_BLOCK_ERASE; break;
              case FLASH_CMD_WRITE_ENABLE: this.command = FLASH_CMD_WRITE_ENABLE; break;
              case FLASH_CMD_PAGE_PROGRAM: this.command = FLASH_CMD_PAGE_PROGRAM; break;
              case FLASH_CMD_READ_DATA: this.command = FLASH_CMD_READ_DATA; break;
              default: this.reset_input_shiftreg(); break;
            }
          }
          break;
        case 16: case 24: break;
        case 32:
          switch (this.command) {
            case FLASH_CMD_REMS:
              // 0: mfg ($1c) 1: device ($70) 2: capacity (size-dependent).
              this.output_shiftreg =
                this.size === SPI_2MB ? 0x1c700300 :
                this.size === SPI_4MB ? 0x1c700600 :
                this.size === SPI_8MB ? 0x1c700c00 :
                this.size === SPI_16MB ? 0x1c701800 : 0x1c701800;
              this.output_count = 24;
              this.command = STATUSBUSY;
              break;
            case FLASH_CMD_BLOCK_ERASE: break;
            case FLASH_CMD_PAGE_PROGRAM:
              this.addr = this.input_shiftreg & (this.size - 1);
              this.reset_input_shiftreg();
              break;
            case FLASH_CMD_READ_DATA:
              this.addr = this.input_shiftreg & (this.size - 1);
              this.output_shiftreg = ((this.data[this.addr]! << 24) >>> 0);
              this.output_count = 8;
              this.addr++;
              this.reset_input_shiftreg();
              break;
            default: this.reset_input_shiftreg(); break;
          }
          break;
      }
      this.shift_output_shiftreg();
    }
    this.eeprom_clock = value;
  }

  snapshotState(): SpiFlashSnapState {
    return {
      cs: this.eeprom_cs, clock: this.eeprom_clock, dataIn: this.eeprom_data_in, dataOut: this.eeprom_data_out,
      inSR: this.input_shiftreg, inCount: this.input_count, outSR: this.output_shiftreg, outCount: this.output_count,
      command: this.command, addr: this.addr, writeEnable: this.write_enable_status, readyBusy: this.ready_busy_status,
    };
  }
  restoreState(s: SpiFlashSnapState): void {
    this.eeprom_cs = s.cs & 1; this.eeprom_clock = s.clock & 1; this.eeprom_data_in = s.dataIn & 1; this.eeprom_data_out = s.dataOut & 1;
    this.input_shiftreg = s.inSR >>> 0; this.input_count = s.inCount >>> 0; this.output_shiftreg = s.outSR >>> 0; this.output_count = s.outCount >>> 0;
    this.command = s.command | 0; this.addr = s.addr | 0; this.write_enable_status = s.writeEnable | 0; this.ready_busy_status = s.readyBusy | 0;
  }
}
