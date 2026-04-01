import { hex16 } from "./format";

export interface C64IoMetadata {
  comment: string;
}

const EXACT_COMMENTS = new Map<number, string>([
  [0xd000, "Position X sprite 0"],
  [0xd001, "Position Y sprite 0"],
  [0xd002, "Position X sprite 1"],
  [0xd003, "Position Y sprite 1"],
  [0xd004, "Position X sprite 2"],
  [0xd005, "Position Y sprite 2"],
  [0xd006, "Position X sprite 3"],
  [0xd007, "Position Y sprite 3"],
  [0xd008, "Position X sprite 4"],
  [0xd009, "Position Y sprite 4"],
  [0xd00a, "Position X sprite 5"],
  [0xd00b, "Position Y sprite 5"],
  [0xd00c, "Position X sprite 6"],
  [0xd00d, "Position Y sprite 6"],
  [0xd00e, "Position X sprite 7"],
  [0xd00f, "Position Y sprite 7"],
  [0xd010, "Position X MSB sprites 0..7"],
  [0xd011, "VIC control register"],
  [0xd012, "Reading/Writing IRQ balance value"],
  [0xd013, "Positin X of optic pencil \"latch\""],
  [0xd014, "Positin Y of optic pencil \"latch\""],
  [0xd015, "Sprites Abilitator"],
  [0xd016, "VIC control register"],
  [0xd017, "(2X) vertical expansion (Y) sprite 0..7"],
  [0xd018, "VIC memory control register"],
  [0xd019, "Interrupt indicator register"],
  [0xd01a, "IRQ mask register"],
  [0xd01b, "Sprite-background screen priority"],
  [0xd01c, "Set multicolor mode for sprite 0..7"],
  [0xd01d, "(2X) horizontal expansion (X) sprite 0..7"],
  [0xd01e, "Animations contact"],
  [0xd01f, "Animation/background contact"],
  [0xd020, "Border color"],
  [0xd021, "Background 0 color"],
  [0xd022, "Background 1 color"],
  [0xd023, "Background 2 color"],
  [0xd024, "Background 3 color"],
  [0xd025, "Multicolor animation 0 register"],
  [0xd026, "Multicolor animation 1 register"],
  [0xd027, "Color sprite 0"],
  [0xd028, "Color sprite 1"],
  [0xd029, "Color sprite 2"],
  [0xd02a, "Color sprite 3"],
  [0xd02b, "Color sprite 4"],
  [0xd02c, "Color sprite 5"],
  [0xd02d, "Color sprite 6"],
  [0xd02e, "Color sprite 7"],
  [0xd400, "Voice 1: Frequency control (lo byte)"],
  [0xd401, "Voice 1: Frequency control (hi byte)"],
  [0xd404, "Voice 1: Wave form pulsation amplitude (lo byte)"],
  [0xd405, "Voice 1: Wave form pulsation amplitude (hi byte)"],
  [0xd406, "Voice 1: Control register"],
  [0xd407, "Voice 1: Decay/Sustain cycle"],
  [0xd40b, "Voice 2: Control register"],
  [0xd40c, "Voice 2: Attack/Decay cycle"],
  [0xd40d, "Voice 2: Sustain/Release cycle"],
  [0xd412, "Voice 3: Control register"],
  [0xd413, "Voice 3: Attack/Decay cycle"],
  [0xd414, "Voice 3: Sustain/Release cycle"],
  [0xd418, "Volume and filter modes"],
  [0xdc00, "Data port A #1: keyboard, joystick, paddles"],
  [0xdc01, "Data port B #1: keyboard, joystick, paddles"],
  [0xdc0d, "Interrupt control register #1"],
  [0xdd00, "Data port A #2: serial bus, RS-232, VIC memory"],
  [0xdd01, "Data port B #2: serial bus, RS-232, user port"],
  [0xdd0d, "Interrupt control register #2"],
  [0xde00, "EasyFlash bank register"],
  [0xde02, "EasyFlash control register"],
]);

export function findC64IoMetadata(address: number): C64IoMetadata | undefined {
  const comment = EXACT_COMMENTS.get(address);
  if (!comment) {
    return undefined;
  }

  return { comment };
}

export function isC64IoAddress(address: number): boolean {
  return (
    (address >= 0xd000 && address <= 0xd02e) ||
    (address >= 0xd400 && address <= 0xd418) ||
    (address >= 0xdc00 && address <= 0xdc0d) ||
    (address >= 0xdd00 && address <= 0xdd0d) ||
    address === 0xde00 ||
    address === 0xde02
  );
}

export function formatC64IoAddress(address: number): string {
  return `$${hex16(address).toUpperCase()}`;
}
