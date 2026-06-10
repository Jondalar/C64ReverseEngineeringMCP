// Spec 713 — source-faithful port of VICE core/m93c86.c.
//
// ST M93C86: 16Kbit (2KB) 3-wire MicroWire serial EEPROM, 16-bit organised,
// used by the GMOD2 cartridge. The chip is driven by three lines — CS (chip
// select), CLK (clock) and DI (data in) — and returns DO (data out). Commands
// are shifted in MSB-first on the rising clock edge; reads shift out on the
// rising edge. Write/erase require a prior EWEN (write-enable). This is a 1:1
// port of VICE's state machine (same command codes, same bit counts, same
// 8/16-bit data layout `m93c86_data[(addr<<1)]` / `+1`).

const M93C86_SIZE = 2048;

// command codes (VICE #defines)
const CMD00 = 1, CMDWRITE = 2, CMDREAD = 3, CMDERASE = 4, CMDWEN = 5,
  CMDWDS = 6, CMDERAL = 7, CMDWRAL = 8, CMDREADDUMMY = 9, CMDREADDATA = 10,
  CMDISBUSY = 11, CMDISREADY = 12;
const STATUSREADY = 1, STATUSBUSY = 0;

export interface M93c86SnapState {
  data: number[];
  cs: number; clock: number; dataIn: number; dataOut: number;
  inputShiftreg: number; inputCount: number;
  outputShiftreg: number; outputCount: number;
  command: number; addr: number;
  writeEnable: number; readyBusy: number;
}

export class M93c86 {
  private readonly m93c86_data = new Uint8Array(M93C86_SIZE);
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
  private ready_busy_status = STATUSREADY;

  constructor(image?: Uint8Array) {
    this.m93c86_data.fill(0xff);
    if (image && image.length) this.m93c86_data.set(image.subarray(0, M93C86_SIZE));
  }

  getData(): Uint8Array { return this.m93c86_data; }
  loadData(bytes: Uint8Array): void { this.m93c86_data.set(bytes.subarray(0, M93C86_SIZE)); }
  isDirty(): boolean { return this.dirty; }
  private dirty = false;
  /** BUG-040 — monotonic mutation counter for the auto-persist debounce. */
  private generation = 0;
  writableGeneration(): number { return this.generation; }

  private reset_input_shiftreg(): void {
    this.input_shiftreg = 0;
    this.input_count = 0;
  }

  read_data(): number {
    if (this.eeprom_cs === 1) {
      switch (this.command) {
        case CMDISBUSY:
          // software sees one busy state for one read (VICE approximation).
          this.command = CMDISREADY;
          return STATUSBUSY;
        case CMDISREADY:
          this.ready_busy_status = STATUSREADY;
          this.command = 0;
          return STATUSREADY;
        default:
          return this.eeprom_data_out;
      }
    }
    return 0;
  }

  write_data(value: number): void {
    if (this.eeprom_cs === 1) this.eeprom_data_in = value & 1;
  }

  write_select(value: number): void {
    value = value & 1;
    if (this.eeprom_cs === 0 && value === 1 && this.eeprom_clock === 0) {
      this.reset_input_shiftreg();
    } else if (this.eeprom_cs === 1 && value === 0) {
      switch (this.command) {
        case CMDWRITE:
        case CMDWRAL:
        case CMDERAL:
          this.command = CMDISBUSY;
          break;
      }
    }
    this.eeprom_cs = value;
    if (this.eeprom_cs === 0) {
      if (this.command === CMDREAD || this.command === CMDREADDUMMY || this.command === CMDREADDATA) {
        this.command = 0;
      }
    }
  }

  write_clock(value: number): void {
    value = value & 1;
    if (this.eeprom_cs === 1 && value === 1 && this.eeprom_clock === 0) {
      if (this.command === CMDREADDUMMY) {
        this.output_shiftreg = this.m93c86_data[(this.addr << 1)]!;
        this.eeprom_data_out = 0;
        this.output_count = 0;
        this.eeprom_data_out = (this.output_shiftreg >> 7) & 1;
        this.output_shiftreg = this.output_shiftreg << 1;
        this.output_count++;
        this.command = CMDREADDATA;
      } else if (this.command === CMDREADDATA) {
        this.eeprom_data_out = (this.output_shiftreg >> 7) & 1;
        this.output_shiftreg = this.output_shiftreg << 1;
        this.output_count++;
        switch (this.output_count) {
          case 8:
            this.output_shiftreg = this.m93c86_data[(this.addr << 1) + 1]!;
            break;
          case 16:
            this.addr = (this.addr + 1) & ((M93C86_SIZE / 2) - 1);
            this.output_shiftreg = this.m93c86_data[(this.addr << 1)]!;
            this.output_count = 0;
            break;
        }
      } else {
        this.input_shiftreg = (this.input_shiftreg << 1) | this.eeprom_data_in;
        this.input_count++;
        switch (this.input_count) {
          case 1: // start bit
            if (this.eeprom_data_in === 0) this.reset_input_shiftreg();
            break;
          case 3: // 2 command bits received
            switch (this.input_shiftreg) {
              case 0x04: this.command = CMD00; break;   // 100
              case 0x05: this.command = CMDWRITE; break; // 101
              case 0x06: this.command = CMDREAD; break;  // 110
              case 0x07: this.command = CMDERASE; break; // 111
            }
            break;
          case 5: // 5 command bits received
            if (this.command === CMD00) {
              switch (this.input_shiftreg) {
                case 0x10: this.command = CMDWDS; break;  // 10000
                case 0x11: this.command = CMDWRAL; break; // 10001
                case 0x12: this.command = CMDERAL; break; // 10010
                case 0x13: this.command = CMDWEN; this.write_enable_status = 1; break; // 10011
              }
            }
            break;
          case 13:
            switch (this.command) {
              case CMDREAD:
                this.command = CMDREADDUMMY;
                this.addr = this.input_shiftreg & 0x3ff;
                this.reset_input_shiftreg();
                break;
              case CMDWDS:
                this.write_enable_status = 0;
                this.reset_input_shiftreg();
                this.command = 0;
                break;
              case CMDWEN:
                this.write_enable_status = 1;
                this.reset_input_shiftreg();
                this.command = 0;
                break;
              case CMDERASE:
                if (this.write_enable_status === 0) {
                  this.reset_input_shiftreg();
                  this.command = 0;
                } else {
                  this.addr = this.input_shiftreg & 0x3ff;
                  this.ready_busy_status = STATUSBUSY;
                  this.reset_input_shiftreg();
                  this.m93c86_data[(this.addr << 1)] = 0xff;
                  this.m93c86_data[(this.addr << 1) + 1] = 0xff;
                  this.dirty = true; this.generation++;
                }
                break;
              case CMDERAL:
                if (this.write_enable_status === 0) {
                  this.reset_input_shiftreg();
                  this.command = 0;
                } else {
                  this.ready_busy_status = STATUSBUSY;
                  this.reset_input_shiftreg();
                  this.m93c86_data.fill(0xff);
                  this.dirty = true; this.generation++;
                }
                break;
            }
            break;
          case 29:
            switch (this.command) {
              case CMDWRITE:
                if (this.write_enable_status === 0) {
                  this.reset_input_shiftreg();
                  this.command = 0;
                } else {
                  this.addr = (this.input_shiftreg >> 16) & 0x3ff;
                  const data0 = (this.input_shiftreg >> 8) & 0xff;
                  const data1 = this.input_shiftreg & 0xff;
                  this.ready_busy_status = STATUSBUSY;
                  this.reset_input_shiftreg();
                  this.m93c86_data[(this.addr << 1)] = data0;
                  this.m93c86_data[(this.addr << 1) + 1] = data1;
                  this.dirty = true; this.generation++;
                }
                break;
              case CMDWRAL:
                if (this.write_enable_status === 0) {
                  this.reset_input_shiftreg();
                  this.command = 0;
                } else {
                  const data0 = (this.input_shiftreg >> 8) & 0xff;
                  const data1 = this.input_shiftreg & 0xff;
                  this.ready_busy_status = STATUSBUSY;
                  this.reset_input_shiftreg();
                  for (let a = 0; a < (M93C86_SIZE / 2); a++) {
                    this.m93c86_data[(a << 1)] = data0;
                    this.m93c86_data[(a << 1) + 1] = data1;
                  }
                  this.dirty = true; this.generation++;
                }
                break;
            }
            break;
        }
      }
    }
    this.eeprom_clock = value;
  }

  snapshotState(): M93c86SnapState {
    return {
      data: Array.from(this.m93c86_data),
      cs: this.eeprom_cs, clock: this.eeprom_clock,
      dataIn: this.eeprom_data_in, dataOut: this.eeprom_data_out,
      inputShiftreg: this.input_shiftreg, inputCount: this.input_count,
      outputShiftreg: this.output_shiftreg, outputCount: this.output_count,
      command: this.command, addr: this.addr,
      writeEnable: this.write_enable_status, readyBusy: this.ready_busy_status,
    };
  }

  restoreState(s: M93c86SnapState): void {
    if (Array.isArray(s.data)) this.m93c86_data.set(s.data.slice(0, M93C86_SIZE));
    this.eeprom_cs = s.cs & 1; this.eeprom_clock = s.clock & 1;
    this.eeprom_data_in = s.dataIn & 1; this.eeprom_data_out = s.dataOut & 1;
    this.input_shiftreg = s.inputShiftreg >>> 0; this.input_count = s.inputCount >>> 0;
    this.output_shiftreg = s.outputShiftreg >>> 0; this.output_count = s.outputCount >>> 0;
    this.command = s.command | 0; this.addr = s.addr | 0;
    this.write_enable_status = s.writeEnable | 0; this.ready_busy_status = s.readyBusy | 0;
  }
}
