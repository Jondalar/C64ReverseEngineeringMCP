#!/usr/bin/env node
// scripts/runtime-proof-manifest.mjs
//
// Spec 715 — Runtime Product Proof manifest (SMALL real canary baseline).
//
// The product regression baseline is NOT a completeness / release-certification
// apparatus. This is a hobby project with an already thoroughly validated
// runtime. The baseline answers one question, fast, in minutes:
//
//     "Does the central runtime still work like yesterday?"
//
// THREE gate groups:
//
//   baseline   — the small fast real canary set. THIS is `npm run proof:product`
//                and the merge barrier. ~7 scenarios, each cut to its earliest
//                stable PASS milestone (no cosmetic screenshot sequences).
//   focused    — the big subsystem suites (616/617, 713/714.5, seven-game,
//                705/707, 706, 708, 709). NOT in the baseline. Run ONLY when the
//                owning subsystem code changes, via `proof:capability -- <cap>`.
//   historical — old bring-up/oracle smokes (Spec 097/415/611). Drifted harness/
//                golden contracts. Diagnostic only, NOT baseline-capable. Kept
//                for reference; never gate merges on them.
//
// Consumed by scripts/runtime-product-proof.mjs.
// NO emulator change lives here — Spec 715 is proof-authority only.
//
// Gate entry fields (Spec 715 §6.1):
//   id · capability · command (argv) · group · expect · fixtures · tier ·
//   triggers (changed-path globs) · note
// `barrier` is derived: barrier <=> group === "baseline".

export const MANIFEST_VERSION = "715-2.0.0 (2026-05-24, small-canary-baseline)";

export const CAPABILITIES = {
  "kernal-loadsave": "KERNAL directory + program LOAD over the serial path",
  "fastloader": "Real-software fastloaders reach the running game state",
  "cartridge": "Real CRT samples cold-boot into a drawn intro/menu state",
  "checkpoint": "Native checkpoint capture/restore/continue",
};

// Change-surface → which focused suite to run (Spec 715 §5 / work-order tiers).
export const FOCUSED_TRIGGERS = {
  "vice1541 / IEC / GCR / drive": "kernal-loadsave, fastloader focused suites + seven-game",
  "cartridge / memory-bus cart routing": "cartridge (713/714.5) focused suites",
  "checkpoint / ring / .c64re": "checkpoint (705/707/714) focused suites",
  "SID / audio": "audio (706) focused suite",
  "trace / TraceDB": "declarative-trace (708) focused suite",
  "media ingress": "media-ingress (709) focused suite",
  "UI-only / monitor view": "UI / monitor gates only — no runtime baseline",
};

export const GATES = [
  // ======================= BASELINE (proof:product) =======================
  // Small, fast, real. Each cut to earliest stable PASS.
  {
    id: "kernal-directory", capability: "kernal-loadsave", group: "baseline",
    command: ["node", "scripts/proof-directory-load.mjs"],
    expect: "exit0", tier: 2,
    fixtures: "samples/synthetic/blank.d64",
    triggers: ["src/runtime/headless/vice1541/**", "src/runtime/headless/iec*/**"],
    note: "boot -> mount -> LOAD\"$\",8 -> LIST; PASS = directory content (quoted header + BLOCKS FREE). No PC/golden/bridge harness.",
  },
  {
    id: "kernal-program-load", capability: "kernal-loadsave", group: "baseline",
    command: ["node", "scripts/proof-kernal-load.mjs"],
    expect: "exit0", tier: 2,
    fixtures: "samples/fixtures/load-fidelity/lf-001-1block.d64",
    triggers: ["src/runtime/headless/vice1541/**", "src/runtime/headless/iec*/**"],
    note: "LOAD\"*\",8,1 of a small deterministic PRG; PASS = clean completion + expected loaded byte-count.",
  },
  {
    id: "fastloader-scramble", capability: "fastloader", group: "baseline",
    command: ["node", "scripts/proof-canary-disk.mjs", "--game", "scramble"],
    expect: "exit0", tier: 2,
    fixtures: "samples/scramble_infinity.d64 (local scene corpus)",
    triggers: ["src/runtime/headless/vice1541/**", "src/runtime/headless/iec*/**"],
    note: "Scramble Infinity — KRILL fastloader reaches running game code (earliest stable PASS).",
  },
  {
    id: "fastloader-polarbear", capability: "fastloader", group: "baseline",
    command: ["node", "scripts/proof-canary-disk.mjs", "--game", "polarbear"],
    expect: "exit0", tier: 2,
    fixtures: "samples/POLARBEAR.d64 (local scene corpus)",
    triggers: ["src/runtime/headless/vice1541/**", "src/runtime/headless/iec*/**"],
    note: "Polar Bear — KERNAL autoload -> custom loader reaches running game code.",
  },
  {
    id: "crt-easyflash", capability: "cartridge", group: "baseline",
    command: ["node", "scripts/proof-canary-crt.mjs", "--cart", "ef"],
    expect: "exit0", tier: 2,
    fixtures: "samples/AccoladeComics_TRX+1D_EF.crt (local sample)",
    triggers: ["src/runtime/headless/cartridge.ts", "src/runtime/headless/memory-bus.ts"],
    note: "Real EasyFlash sample cold-boots into a drawn intro state (cart executed, not crash loop).",
  },
  {
    id: "crt-gmod2", capability: "cartridge", group: "baseline",
    command: ["node", "scripts/proof-canary-crt.mjs", "--cart", "gmod2"],
    expect: "exit0", tier: 2,
    fixtures: "samples/yeti_mountain_GMOD2.crt (local sample)",
    triggers: ["src/runtime/headless/cartridge.ts", "src/runtime/headless/memory-bus.ts"],
    note: "Real GMOD2 sample cold-boots into a drawn intro/menu state.",
  },
  {
    id: "checkpoint-canary", capability: "checkpoint", group: "baseline",
    command: ["node", "scripts/probe-705-checkpoint-capability.mjs"],
    expect: "exit0", tier: 2,
    fixtures: "headless runtime + VSF",
    triggers: ["src/runtime/**/checkpoint*/**", "src/runtime/**/ring*/**", "src/runtime/**/vsf/**"],
    note: "Short native checkpoint capture -> restore -> continue capability preflight.",
  },

  // ======================= FOCUSED (proof:capability) =====================
  // Big subsystem suites. NOT the product baseline. Run on subsystem change.
  {
    id: "seven-game", capability: "fastloader", group: "focused",
    command: ["node", "scripts/runtime-proof-gate.mjs"],
    expect: "exit0", tier: 3,
    fixtures: "Spec 601 GAMES truth table + oracle PNGs (local corpus)",
    triggers: ["src/runtime/headless/vice1541/**", "src/runtime/**/vic*/**", "src/runtime/**/cpu*/**"],
    note: "Full seven-game real-software gate. Focused canary for broad C64/1541/VIC/CPU changes.",
  },
  {
    id: "spec616-load-byte", capability: "kernal-loadsave", group: "focused",
    command: ["npx", "tsx", "tests/spec-616/kernal-load-byte-fidelity.test.ts"],
    expect: "exit0", tier: 3,
    fixtures: "9 synthetic + 7 real disk oracles",
    triggers: ["src/runtime/headless/vice1541/**", "src/runtime/headless/iec*/**"],
    note: "Full Spec 616 KERNAL LOAD byte-fidelity matrix.",
  },
  {
    id: "spec616-load-chain", capability: "kernal-loadsave", group: "focused",
    command: ["npx", "tsx", "tests/spec-616/kernal-load-chain-fidelity.test.ts"],
    expect: "exit0", tier: 3,
    fixtures: "chained-load oracles",
    triggers: ["src/runtime/headless/vice1541/**", "src/runtime/headless/iec*/**"],
    note: "Full Spec 616 chained-load fidelity matrix.",
  },
  {
    id: "spec617-save-byte", capability: "kernal-loadsave", group: "focused",
    command: ["npx", "tsx", "tests/spec-617/kernal-save-byte-fidelity.test.ts"],
    expect: "exit0", tier: 3,
    fixtures: "blank D64 + save oracles",
    triggers: ["src/runtime/headless/vice1541/**", "src/disk/**"],
    note: "Full Spec 617 KERNAL SAVE byte-fidelity matrix.",
  },
  {
    id: "cart-rombank-mappers", capability: "cartridge", group: "focused",
    command: ["node", "scripts/probe-713-rombank.mjs"],
    expect: "exit0", tier: 2, fixtures: "synthetic MagicDesk/16/Ocean/Normal/Ultimax",
    triggers: ["src/runtime/headless/cartridge.ts", "src/runtime/headless/memory-bus.ts"],
    note: "Spec 713 ROM-bank mapper matrix.",
  },
  {
    id: "cart-device-cores", capability: "cartridge", group: "focused",
    command: ["node", "scripts/probe-713-devcore.mjs"],
    expect: "exit0", tier: 2, fixtures: "synthetic GMOD2/3/MegaByter/C64MegaCart",
    triggers: ["src/runtime/headless/cartridge.ts", "src/runtime/headless/m93c86.ts", "src/runtime/headless/spi-flash.ts"],
    note: "Spec 713 flash/EEPROM/SPI device-core matrix.",
  },
  {
    id: "cart-erase-catchup", capability: "cartridge", group: "focused",
    command: ["node", "scripts/probe-713-erase-catchup.mjs"],
    expect: "exit0", tier: 2, fixtures: "synthetic flash CRT",
    triggers: ["src/runtime/headless/cartridge.ts"],
    note: "Spec 713 flash erase-alarm catch-up.",
  },
  {
    id: "cart-ingress", capability: "cartridge", group: "focused",
    command: ["node", "scripts/probe-713-ingress.mjs"],
    expect: "exit0", tier: 2, fixtures: "synthetic CRTs",
    triggers: ["src/runtime/headless/cartridge.ts", "src/runtime/**/media*/**"],
    note: "Spec 713 CRT ingress/inference.",
  },
  {
    id: "cart-fidelity-smoke", capability: "cartridge", group: "focused",
    command: ["node", "scripts/smoke-cart-fidelity.mjs"],
    expect: "exit0", tier: 2, fixtures: "synthetic CRTs",
    triggers: ["src/runtime/headless/cartridge.ts"],
    note: "Spec 713 PLA/bank/status fidelity.",
  },
  {
    id: "cart-easyflash-writable", capability: "cartridge", group: "focused",
    command: ["node", "scripts/probe-714-5.mjs"],
    expect: "exit0", tier: 2, fixtures: "synthetic EasyFlash",
    triggers: ["src/runtime/headless/cartridge.ts", "src/runtime/**/checkpoint*/**"],
    note: "Spec 714.5 EasyFlash writable persistence.",
  },
  {
    id: "mutable-cart-persistence", capability: "cartridge", group: "focused",
    command: ["node", "scripts/probe-714-5-persist.mjs"],
    expect: "exit0", tier: 2, fixtures: "synthetic GMOD2/3/MegaByter/C64MegaCart",
    triggers: ["src/runtime/headless/cartridge.ts", "src/runtime/**/checkpoint*/**", "src/runtime/**/ring*/**"],
    note: "Spec 714.5 writable-cartridge persistence matrix.",
  },
  {
    id: "mutable-disk-persistence", capability: "checkpoint", group: "focused",
    command: ["node", "scripts/probe-714.mjs"],
    expect: "exit0", tier: 2, fixtures: "G64 + D64",
    triggers: ["src/runtime/headless/vice1541/drive_snapshot.ts", "src/runtime/**/checkpoint*/**", "src/runtime/**/ring*/**"],
    note: "Spec 714 mutable-disk persistence + ring.",
  },
  {
    id: "checkpoint-roundtrips", capability: "checkpoint", group: "focused",
    command: ["node", "scripts/probe-705-core-roundtrip.mjs"],
    expect: "exit0", tier: 2, fixtures: "headless runtime",
    triggers: ["src/runtime/**/checkpoint*/**"],
    note: "Spec 705 core checkpoint roundtrip.",
  },
  {
    id: "checkpoint-ring", capability: "checkpoint", group: "focused",
    command: ["node", "scripts/probe-705b-ring.mjs"],
    expect: "exit0", tier: 2, fixtures: "headless runtime",
    triggers: ["src/runtime/**/ring*/**", "src/runtime/**/checkpoint*/**"],
    note: "Spec 705.B checkpoint ring.",
  },
  {
    id: "c64re-dump-undump", capability: "checkpoint", group: "focused",
    command: ["node", "scripts/probe-707-dump-undump.mjs"],
    expect: "exit0", tier: 2, fixtures: ".c64re format",
    triggers: ["src/runtime/**/snapshot-persistence*/**", "src/runtime/**/checkpoint*/**"],
    note: "Spec 707 .c64re dump/undump.",
  },

  // ======================= HISTORICAL (diagnostic only) ===================
  // Old bring-up / oracle smokes with drifted harness/golden contracts.
  // NOT baseline-capable. Superseded by the baseline canaries + focused suites.
  {
    id: "hist-smoke-load", capability: "kernal-loadsave", group: "historical",
    command: ["node", "scripts/smoke-load.mjs"],
    expect: "exit0", tier: 1, fixtures: "Spec 097 load-matrix synthetic",
    triggers: [],
    note: "Spec 097 (M0.4c) load-matrix harness — drifted oracle contract. Superseded by kernal-program-load (baseline) + spec616-load-byte (focused). Diagnostic only.",
  },
  {
    id: "hist-smoke-415-fastloaders", capability: "fastloader", group: "historical",
    command: ["node", "scripts/smoke-415-fastloaders.mjs"],
    expect: "exit0", tier: 1, fixtures: "Spec 415 curated corpus",
    triggers: [],
    note: "Spec 415 bring-up fastloader corpus — drifted. Superseded by fastloader-scramble/polarbear (baseline) + seven-game (focused). Diagnostic only.",
  },
  {
    id: "hist-smoke-611-load-directory", capability: "kernal-loadsave", group: "historical",
    command: ["node", "scripts/smoke-611-7f-vice-load-directory.mjs"],
    expect: "exit0", tier: 1, fixtures: "Spec 611 golden screen-SHA/PC/port",
    triggers: [],
    note: "Spec 611 bring-up — full-screen-RAM-SHA + PC + bus-port golden drifted (content markers still pass). Superseded by kernal-directory content proof (baseline). Diagnostic only.",
  },
  {
    id: "hist-smoke-write-support", capability: "kernal-loadsave", group: "historical",
    command: ["node", "scripts/smoke-write-support.mjs"],
    expect: "exit0", tier: 1, fixtures: "blank D64 write smoke",
    triggers: [],
    note: "Spec-era SAVE/write smoke. SAVE authority is now the focused spec617-save-byte matrix. Diagnostic only.",
  },
];

export function baselineGates() {
  return GATES.filter((g) => g.group === "baseline");
}
export function focusedGates() {
  return GATES.filter((g) => g.group === "focused");
}
export function historicalGates() {
  return GATES.filter((g) => g.group === "historical");
}
export function gatesForCapability(capability) {
  // Capability runs cover baseline + focused for that capability; never historical.
  return GATES.filter((g) => g.capability === capability && g.group !== "historical");
}
