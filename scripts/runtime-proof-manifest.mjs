#!/usr/bin/env node
// scripts/runtime-proof-manifest.mjs
//
// Spec 715 — Runtime Product Proof manifest.
//
// Single declarative source for "what proves the runtime product is green".
// Replaces the Spec 600/601 framing where the seven-game gate WAS the whole
// proof. The seven-game gate is now ONE capability among several; it is the
// real-software execution canary, not proof for cartridges / checkpoint /
// audio / media / trace.
//
// Consumed by scripts/runtime-product-proof.mjs.
//
// Each gate entry records (Spec 715 §6.1):
//   id        stable gate id (never reused / renamed once frozen)
//   command   argv array spawned with `node` (relative to repo root)
//   expect    pass condition (always "exit0" today)
//   fixtures  oracles/fixtures consumed; note when gitignored/local-corpus
//   tier      gate tier per Spec 715 §4 (1 local, 2 integrated, 3 global)
//   triggers  changed-path globs that should re-run this gate (715.5 guidance)
//   barrier   true => counted in the product merge barrier (proof:product)
//   note      optional human note
//
// Capabilities (Spec 715 §6.2 initial product set):
//   c64-1541-execution · kernal-loadsave · cartridge · mutable-media ·
//   checkpoint · audio · media-ingress · declarative-trace

export const MANIFEST_VERSION = "715-1.0.0 (2026-05-24)";

export const CAPABILITIES = {
  "c64-1541-execution": "VICE-shaped C64 + 1541 real-software execution (seven-game canary)",
  "kernal-loadsave": "KERNAL LOAD/SAVE, directory, SAVE/FORMAT and fastloader paths",
  "cartridge": "CRT mapper families + flash/EEPROM/SPI device cores (Spec 713)",
  "mutable-media": "Writable disk + cartridge snapshot/restore persistence (Spec 714)",
  "checkpoint": "Native checkpoint, .c64re dump/undump, checkpoint ring (Specs 705/707)",
  "audio": "reSID synthesis restore + transport re-sync/latency (Specs 703/706)",
  "media-ingress": "Reproducible insert/eject/reset/restore + UI/WS control (Spec 709)",
  "declarative-trace": "Declarative trace definitions + TraceDB evidence (Spec 708)",
};

export const GATES = [
  // ---- c64-1541-execution -------------------------------------------------
  {
    id: "seven-game",
    capability: "c64-1541-execution",
    command: ["scripts/runtime-proof-gate.mjs"],
    expect: "exit0",
    fixtures: "Spec 601 GAMES truth table + samples/screenshots/proof/ oracle PNGs (local scene corpus, gitignored)",
    tier: 3,
    triggers: ["src/runtime/**", "src/runtime/headless/vice1541/**"],
    barrier: true,
    note: "Real-software execution canary: motm, MM s1, IM2, LNR s1, Scramble, Pawn s1, Polarbear. NOT proof for cartridge/checkpoint/audio.",
  },

  // ---- kernal-loadsave ----------------------------------------------------
  {
    id: "kernal-load",
    capability: "kernal-loadsave",
    command: ["scripts/smoke-load.mjs"],
    expect: "exit0",
    fixtures: "synthetic + corpus disks",
    tier: 2,
    triggers: ["src/runtime/headless/vice1541/**", "src/runtime/headless/kernal*/**"],
    barrier: true,
  },
  {
    id: "kernal-load-directory",
    capability: "kernal-loadsave",
    command: ["scripts/smoke-611-7f-vice-load-directory.mjs"],
    expect: "exit0",
    fixtures: "corpus disk; vice1541 path",
    tier: 2,
    triggers: ["src/runtime/headless/vice1541/**", "src/runtime/headless/drive1541/**"],
    barrier: true,
  },
  {
    id: "kernal-save-format",
    capability: "kernal-loadsave",
    command: ["scripts/smoke-write-support.mjs"],
    expect: "exit0",
    fixtures: "blank D64 fixtures",
    tier: 2,
    triggers: ["src/runtime/headless/vice1541/**", "src/disk/**"],
    barrier: true,
  },
  {
    id: "fastloaders",
    capability: "kernal-loadsave",
    command: ["scripts/smoke-415-fastloaders.mjs"],
    expect: "exit0",
    fixtures: "fastloader corpus",
    tier: 2,
    triggers: ["src/runtime/headless/vice1541/**", "src/runtime/headless/iec*/**"],
    barrier: true,
  },

  // ---- cartridge ----------------------------------------------------------
  {
    id: "cart-easyflash-writable",
    capability: "cartridge",
    command: ["scripts/probe-714-5.mjs"],
    expect: "exit0",
    fixtures: "synthetic EasyFlash CRT",
    tier: 2,
    triggers: ["src/runtime/headless/cartridge.ts", "src/runtime/headless/memory-bus.ts"],
    barrier: true,
  },
  {
    id: "cart-rombank-mappers",
    capability: "cartridge",
    command: ["scripts/probe-713-rombank.mjs"],
    expect: "exit0",
    fixtures: "synthetic MagicDesk/MagicDesk16/Ocean/Normal/Ultimax CRTs",
    tier: 2,
    triggers: ["src/runtime/headless/cartridge.ts", "src/runtime/headless/memory-bus.ts"],
    barrier: true,
  },
  {
    id: "cart-device-cores",
    capability: "cartridge",
    command: ["scripts/probe-713-devcore.mjs"],
    expect: "exit0",
    fixtures: "synthetic GMOD2/GMOD3/MegaByter/C64MegaCart CRTs",
    tier: 2,
    triggers: ["src/runtime/headless/cartridge.ts", "src/runtime/headless/m93c86.ts", "src/runtime/headless/spi-flash.ts"],
    barrier: true,
  },
  {
    id: "cart-flash-erase-catchup",
    capability: "cartridge",
    command: ["scripts/probe-713-erase-catchup.mjs"],
    expect: "exit0",
    fixtures: "synthetic flash040/flash800 CRT",
    tier: 2,
    triggers: ["src/runtime/headless/cartridge.ts"],
    barrier: true,
  },
  {
    id: "cart-ingress",
    capability: "cartridge",
    command: ["scripts/probe-713-ingress.mjs"],
    expect: "exit0",
    fixtures: "synthetic CRTs",
    tier: 2,
    triggers: ["src/runtime/headless/cartridge.ts", "src/runtime/**/media*/**"],
    barrier: true,
  },
  {
    id: "cart-fidelity-smoke",
    capability: "cartridge",
    command: ["scripts/smoke-cart-fidelity.mjs"],
    expect: "exit0",
    fixtures: "synthetic CRTs",
    tier: 2,
    triggers: ["src/runtime/headless/cartridge.ts"],
    barrier: true,
  },
  {
    id: "cart-real-samples",
    capability: "cartridge",
    command: ["scripts/smoke-cart-real.mjs"],
    expect: "exit0",
    fixtures: "real .crt samples under samples/ (gitignored, local-only)",
    tier: 2,
    triggers: ["src/runtime/headless/cartridge.ts"],
    barrier: false,
    note: "Fixture-dependent: real CRT samples are gitignored. Counted at local freeze; self-skips where samples absent.",
  },

  // ---- mutable-media ------------------------------------------------------
  {
    id: "mutable-disk-persistence",
    capability: "mutable-media",
    command: ["scripts/probe-714.mjs"],
    expect: "exit0",
    fixtures: "G64 + D64 fixtures",
    tier: 2,
    triggers: ["src/runtime/headless/vice1541/drive_snapshot.ts", "src/runtime/**/checkpoint*/**", "src/runtime/**/ring*/**"],
    barrier: true,
  },
  {
    id: "mutable-cart-persistence",
    capability: "mutable-media",
    command: ["scripts/probe-714-5-persist.mjs"],
    expect: "exit0",
    fixtures: "synthetic GMOD2/GMOD3/MegaByter/C64MegaCart CRTs",
    tier: 2,
    triggers: ["src/runtime/headless/cartridge.ts", "src/runtime/**/checkpoint*/**", "src/runtime/**/ring*/**"],
    barrier: true,
  },

  // ---- checkpoint ---------------------------------------------------------
  {
    id: "checkpoint-capability",
    capability: "checkpoint",
    command: ["scripts/probe-705-checkpoint-capability.mjs"],
    expect: "exit0",
    fixtures: "headless runtime",
    tier: 2,
    triggers: ["src/runtime/**/checkpoint*/**"],
    barrier: true,
  },
  {
    id: "checkpoint-core-roundtrip",
    capability: "checkpoint",
    command: ["scripts/probe-705-core-roundtrip.mjs"],
    expect: "exit0",
    fixtures: "headless runtime",
    tier: 2,
    triggers: ["src/runtime/**/checkpoint*/**"],
    barrier: true,
  },
  {
    id: "checkpoint-drive-roundtrip",
    capability: "checkpoint",
    command: ["scripts/probe-705-drive-roundtrip.mjs"],
    expect: "exit0",
    fixtures: "headless runtime + vice1541",
    tier: 2,
    triggers: ["src/runtime/headless/vice1541/drive_snapshot.ts", "src/runtime/**/checkpoint*/**"],
    barrier: true,
  },
  {
    id: "checkpoint-resid-roundtrip",
    capability: "checkpoint",
    command: ["scripts/probe-705-resid-roundtrip.mjs"],
    expect: "exit0",
    fixtures: "headless runtime + reSID",
    tier: 2,
    triggers: ["src/runtime/**/sid*/**", "src/runtime/**/checkpoint*/**"],
    barrier: true,
  },
  {
    id: "checkpoint-ring",
    capability: "checkpoint",
    command: ["scripts/probe-705b-ring.mjs"],
    expect: "exit0",
    fixtures: "headless runtime",
    tier: 2,
    triggers: ["src/runtime/**/ring*/**", "src/runtime/**/checkpoint*/**"],
    barrier: true,
  },
  {
    id: "c64re-dump-undump",
    capability: "checkpoint",
    command: ["scripts/probe-707-dump-undump.mjs"],
    expect: "exit0",
    fixtures: ".c64re snapshot format",
    tier: 2,
    triggers: ["src/runtime/**/snapshot-persistence*/**", "src/runtime/**/checkpoint*/**"],
    barrier: true,
  },

  // ---- audio --------------------------------------------------------------
  {
    id: "audio-latency",
    capability: "audio",
    command: ["scripts/probe-706-latency.mjs"],
    expect: "exit0",
    fixtures: "reSID render path",
    tier: 2,
    triggers: ["src/runtime/**/sid*/**", "src/runtime/**/audio*/**"],
    barrier: true,
  },
  {
    id: "audio-restore-resync",
    capability: "audio",
    command: ["scripts/probe-706-restore-resync.mjs"],
    expect: "exit0",
    fixtures: "reSID render path + checkpoint",
    tier: 2,
    triggers: ["src/runtime/**/sid*/**", "src/runtime/**/audio*/**"],
    barrier: true,
  },
  {
    id: "sid-resid",
    capability: "audio",
    command: ["scripts/smoke-sid-resid.mjs"],
    expect: "exit0",
    fixtures: "reSID synthesis",
    tier: 2,
    triggers: ["src/runtime/**/sid*/**"],
    barrier: true,
  },

  // ---- media-ingress ------------------------------------------------------
  {
    id: "media-ingress",
    capability: "media-ingress",
    command: ["scripts/probe-709-media.mjs"],
    expect: "exit0",
    fixtures: "disk + CRT media",
    tier: 2,
    triggers: ["src/runtime/**/media*/**"],
    barrier: true,
  },
  {
    id: "media-ws-routes",
    capability: "media-ingress",
    command: ["scripts/probe-709-ws-routes.mjs"],
    expect: "exit0",
    fixtures: "WS control routes",
    tier: 2,
    triggers: ["src/runtime/**/media*/**", "src/workspace-ui/**"],
    barrier: true,
  },
  {
    id: "media-dirty-guard",
    capability: "media-ingress",
    command: ["scripts/probe-709-12.mjs"],
    expect: "exit0",
    fixtures: "dirty-media guard scenarios",
    tier: 2,
    triggers: ["src/runtime/**/media*/**", "src/runtime/**/checkpoint*/**"],
    barrier: true,
  },

  // ---- declarative-trace --------------------------------------------------
  {
    id: "trace-defs",
    capability: "declarative-trace",
    command: ["scripts/probe-708-trace.mjs"],
    expect: "exit0",
    fixtures: "TraceDB (DuckDB)",
    tier: 1,
    triggers: ["src/runtime/**/trace*/**"],
    barrier: true,
  },
];

export function gatesForCapability(capability) {
  return GATES.filter((g) => g.capability === capability);
}

export function barrierGates() {
  return GATES.filter((g) => g.barrier);
}
