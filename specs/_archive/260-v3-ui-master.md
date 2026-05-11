# Spec 260 — V3 Human UI master spec

**Sprint:** 134 (V3 epic kickoff)
**Status:** REFINED 2026-05-09 — all 27 cluster A-G questions resolved.

## Goal

Browser-based human UI consuming the headless emulator + V2
agent API. Single-user, localhost. Pixel-perfect VIC + 1:1 resid
audio. No second emu loop — UI is kernel client.

## Architecture (locked decisions)

**A — Runtime + transport:**
- A1: Browser (React/Vite, served by MCP)
- A2: Single-user (alex alone)
- A3: WebSocket transport (127.0.0.1 only)
- A4: Native node-side audio (resid) → WebSocket → browser WebAudio
- A5: Frame stream as indexed-palette (1 byte/pixel × 384×272 ≈ 100KB/frame, ~5MB/s)

**B — VIC pixel-perfect (Spec 262):**
- B1: Strict 1:1 VICE pixel-equal
- B2: All 312 PAL lines snapshot every frame
- B3: FLI + NUFLI included (per-cycle reg-write log)
- B4: Unlimited sprite multiplexing
- B5: Open border + FLD via 1:1 VIC

**C — Audio (Spec 263):**
- C1: resid primary + fastsid for trace-only mode
- C2: Live playback + export both
- C3: 50ms target latency
- C4: WAV primary, FLAC follow-up

**D — Input + media (Specs 264, 265):**
- D1: Both QWERTY-translate + positional, default QWERTY
- D2: Keyboard-fallback + Gamepad API. Config bootstrapped from
  `~/.config/vice/vicerc` (KeySet2 + JoyDevice2). Saved to
  `~/.config/c64re/joystick.json`.
- D3: Server-side fs browse + recent files
- D4: Multi-disk swap + cartridge YES. Tape defer V3.1.

**E — Debug panels (Specs 266, 267, 268):**
- E1: Monitor combined VICE command-line + GUI buttons
- E2: Trace viewer = separate top-level tab
- E3: Snapshot manager = full branch-tree visualization
- E4: Full scenario editor + auto-branch on monitor RAM/reg edits

**F — Export + distribution (Specs 269, 271):**
- F1: Video export = frames + ffmpeg server-side
- F2: Distributed scenarios = single-node worker_threads

**G — Protocol (Spec 272):**
- G1: VICE stays second-class. **No drop spec.** (Spec 270 removed)
- G2: Baseline traces stay readable (default)
- G3: Hybrid WebSocket protocol — JSON-RPC text + binary media frames
- G4: No auth. 127.0.0.1 bind hardcoded.

## V3 sub-specs

| Spec | Title |
|------|-------|
| 260  | V3 master (this spec) |
| 261  | UI shell (React/Vite + WebSocket client) |
| 262  | VIC pixel-perfect renderer (1:1 VICE) |
| 263  | SID audio playback (resid + fastsid trace) |
| 264  | Keyboard + joystick input + vicerc bootstrap |
| 265  | Media selector + multi-disk + cartridge |
| 266  | Monitor + debugger panel |
| 267  | Trace viewer (swimlane + bookmarks) |
| 268  | Snapshot tree + scenario editor |
| 269  | Screenshot / video / audio export |
| 271  | Distributed scenarios (worker_threads) |
| 272  | WebSocket protocol (JSON-RPC + binary frames) |

Spec 270 (VICE drop) **NOT included** — user decision 2026-05-09:
VICE stays as second-class oracle. Headless-over-VICE framing in
CLAUDE.md remains binding for tool selection.

## Sequencing

| Sprint | Specs | Mode |
|--------|-------|------|
| 134    | 260, 272 | sequential (foundation: protocol + master) |
| 135    | 261 | sequential (UI shell) |
| 136    | 262 | sequential (VIC pixel-perfect, big spec) |
| 137    | 263 | sequential (resid audio) |
| 138    | 264, 265 | parallel (input + media) |
| 139    | 266, 267 | parallel (debug panels) |
| 140    | 268 | sequential (snapshot tree + scenarios) |
| 141    | 269, 271 | parallel (export + distributed) |

## Acceptance gate

- Browser UI loads at `localhost:4311`
- Live VIC frame stream renders at 50fps PAL with no perceptible
  lag (= <100ms input→display)
- SID audio plays in sync with frame display, ≤50ms latency
- Monitor command-line accepts VICE-syntax + GUI buttons work
- Snapshot tree renders ≥10 branches without lag
- Render motm/MM/IM2/LNR/Edge-of-Disgrace title screens 1:1 VICE
  pixel-equal (= screenshot hash match)
- All V2 agent flows work unchanged (= V2 tools still callable)

## Out of scope

- Multi-user / cloud deployment
- Tape support (V3.1)
- VICE drop (kept second-class)
- Mobile touch UI (= V4+)
