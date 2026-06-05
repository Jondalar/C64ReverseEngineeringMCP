# Bug: Cannot reach in-game state from a boot — trace still broken, no workable disk-swap, headless free-runs

- **ID:** BUG-027
- **Date:** 2026-05-31
- **Reporter:** llm
- **Area:** runtime
- **Severity:** high
- **Status:** fixed (Blockers 1+3 done; Blocker 2 = `runtime_swap_disk_and_continue` shipped, orchestration gated — live-verify the actual game-advance on a multi-disk title) <!-- open | investigating | fixed | wontfix | duplicate -->
- **Tracking spec:** `specs/744-runtime-session-authority-drive-to-state.md`

## Environment

- Branch / commit: master (post BUG-023 host-file-persist fix)
- Surface: mcp full (runtime session) — driven via the `runtime_*` MCP tools
- Project dir: `/Users/alex/Development/C64/Cracking/Wasteland_EF`
- Tool / endpoint: `runtime_session_start` + `runtime_session_run` + `runtime_media_swap`
- Game: Wasteland (EA/Interplay 1988), bootable master side 1 `.g64`

## Summary

With the tools I have, I **cannot get from a cold boot to the in-game / playable state**
for a multi-disk, disk-swap-prompting game like Wasteland. Three concrete blockers:
(1) tracing is still broken (module not found), (2) there is no workable way to answer the
game's "Insert side N" disk-swap prompts headlessly, and (3) the headless session
free-runs at ~100% CPU after start, which makes long boots punishing. A human in the UI
reaches in-game in ~5 minutes; I have no tool path that gets there at all.

## Blocker 1 — tracing still not possible (module not found)

Starting a session with a trace destination fails immediately:

```text
runtime_session_start({
  disk_path: ".../input/disk/wasteland_s1[ea_interplay_1988](!).g64",
  write_protected: true,
  trace_out: "analysis/runs/boot_to_ingame.duckdb",
  trace_domains: ["c64-cpu"]
})
->
Error: Cannot find module
'/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/src/runtime/headless/trace/binary-log-worker.js'
imported from '/Users/alex/Development/C64/Cracking/Wasteland_EF/'
[ERR_MODULE_NOT_FOUND] at finalizeResolution (node:internal/modules/esm/resolve:274:11)
```

The trace worker is imported from a `src/.../*.js` path that does not exist (only the
`.ts` source is there; the built `.js` is presumably under `dist/`, or the worker is not
emitted at all). `npm run build:mcp` (tsc + copy-wasm) was run immediately before — clean,
no errors — and the failure persists. So **CPU/PC tracing of a real boot is unavailable**,
which is exactly the capability needed to follow a boot→in-game path.

## Blocker 2 — no way to do the in-game disk swap

Wasteland's normal play **requires disk-side swaps**: new-game init and map changes prompt
"Insert side N. (RETURN)" and the engine waits for the side to be present before
continuing (manual confirms: "shifting to another map requires the computer to save the
current map and you to swap disks"). I see **no tool path that satisfies this prompt**:

- `runtime_media_swap` exists, but I have **not** found a way to drive it through the
  game's own "Insert side N" wait-loop (an earlier attempt moved the PC briefly then the
  game looped back to the prompt — the swap was not recognised as "new disk inserted").
- There is no documented "the drive now has a different disk, signal media-change to the
  running program" semantics (a real 1541 sees the write-protect-line pulse / a fresh disk
  via the light-sensor; unclear what the headless swap emulates and whether the game's
  detection fires).

Net: even if I run long enough to hit the first "Insert side N", I cannot get past it.

## Blocker 3 — headless session free-runs at ~100% CPU

After `runtime_session_start` the session process pegged a core at **99.7%** even with no
`runtime_session_run` in flight (the start call's run was rejected by the user, 0
instructions requested, yet the MCP/session process stayed at 99.7% until I killed it).
Combined with the UI WS server (~53%), the machine's fan spun up hard. A boot-to-in-game
sequence is millions of instructions / minutes of wall-clock; at this cost it is not a
practical way to reach the playable state.

## How I wanted to call it (the intended flow that does not work)

```text
1. runtime_session_start({ disk_path: <master s1 .g64>, write_protected: true,
                           trace_out: <duckdb>, trace_domains: ["c64-cpu"] })   # FAILS (Blocker 1)
2. runtime_session_run({ until: { kind: "stable_screen", frames_stable: 3 } })  # boot to BASIC ready
3. runtime_type("LOAD\"*\",8,1\rRUN\r")                                          # boot the loader chain
4. runtime_session_run(...) to the "Start Utils" menu; select Start / new game
5. at "Insert side N": runtime_media_swap(<side N image>) and continue           # NO WORKING PATH (Blocker 2)
6. repeat run/swap until the desert map + party roster are on screen = "in game"
```

Steps 2–6 are where the game data + scene loads happen — the part I need to observe to map
`LOAD"*",8,1 → in-game`. I cannot complete step 1 (trace), step 5 (swap), and steps 2/4/6
are impractical at 100% CPU.

## Where my information comes from (so the path is reproducible from code instead)

I do **not** need the runtime if these are available statically — the boot chain up to the
menu is already fully derived from code, documented in
`/Users/alex/Development/C64/Cracking/Wasteland_EF/docs/LOADER.md`:

- `prodos` (T18/S2, KERNAL `LOAD"*",8,1`) → `2.0` (T18/S3, `$C000`) → fastloader + 3 boot
  blocks (charset `$C600`, engine `$0200`, menu-shell `$7E00`) → `JMP $7E00`.
- Title menu + dispatch: LOADER.md §4a (block3 `$818E` → `$1B36`; Start=`$81FA`,
  Utils=`$81DB`).
- Byte-exact disassemblies in `analysis/disk/wasteland_s1[...]/`
  (`block2_engine_0200_disasm.asm`, `block3_game_7E00_disasm.asm`, `utils_overlay_7E00_disasm.asm`).

The **gap** is Start(`$81FA`) → first map/scene load → in-game (incl. the disk-side loads).
That gap is what I wanted to observe via trace; without trace it must be read out of the
engine disasm by hand.

## Expected

1. `runtime_session_start` with `trace_out`/`trace_domains` works (worker module resolves),
   producing a queryable CPU/PC trace of a real boot.
2. A documented, working way to satisfy a game's in-disk "insert side N" swap from the MCP
   (`runtime_media_swap` that the running program actually detects), so multi-disk titles
   can be driven to in-game headlessly.
3. A headless session that does not free-run a core when idle (no `runtime_session_run` in
   flight) — or a documented `pause`/`stop`/`close` for a session so it stops consuming CPU.

## Repro steps

1. `runtime_session_start` a bootable `.g64` with `trace_out` + `trace_domains:["c64-cpu"]`
   → module-not-found (Blocker 1).
2. Start without trace; observe the session process at ~100% CPU when idle (Blocker 3).
3. Boot the loader, reach a state that prompts "Insert side N"; try `runtime_media_swap`;
   the game does not advance past the prompt (Blocker 2).

## Scope guess (optional)

- Blocker 1: trace worker not emitted to / not resolved from `dist/` (build packaging or an
  import path that points at `src/...*.js`).
- Blocker 2: media-swap does not raise the drive media-change signal the game polls
  (write-protect-line pulse / disk-removed→inserted transition on the 1541), so the
  engine's "wait for new side" loop never releases.
- Blocker 3: session run-loop free-runs instead of idling when no `run` budget is active;
  also no session stop/close tool surfaced (had to `kill -9` the MCP server process).

Architecture decision recorded in Spec 744: this is not one more isolated trace
bug. The product needs one RuntimeSessionService authority shared by MCP + Live
UI, robust 726.B worker packaging, explicit lifecycle/close semantics, and a
high-level disk-swap-prompt flow instead of raw `run/type/swap` guessing.

## Notes / follow-up

- Workaround for now: derive `Start → in-game` from the engine disassembly statically (no
  runtime), as the boot chain up to the menu already was.
- Related: BUG-023 (write persistence, fixed). This bug is about *observing/driving* a boot
  to the playable state, not about writes.

---

## Resolution (partial — Blockers 1 + 3 fixed; Blocker 2 diagnosed)

### Blocker 1 — trace worker module-not-found — FIXED (Spec 744.2)

- **Root cause:** the MCP server runs from SOURCE via `npx tsx src/cli.ts` (every
  project `.mcp.json`), so `binary-log-writer`'s `import.meta.url` is the `.ts`
  under `src/`; `workerScriptPath()` only tried the sibling `.js` (never exists in
  `src/`). The built worker lives in `dist/` but was never tried.
- **Fix:** `workerScriptPath()` resolves sibling `.js` (dist run) → else the `dist/`
  twin (tsx-from-src; the dist worker is plain JS, no tsx loader needed inside the
  thread) → else a clear "run build:mcp" error.
- **Gate:** `npm run e2e:744-2` (5/5) — imports the writer from `src/` under tsx
  (the exact failing condition), constructs the writer (spawns the worker), writes +
  finalizes a `.c64retrace`.

### Blocker 3 — idle ~100% CPU / no close — FIXED (Spec 744.3)

- **Root cause:** a running RuntimeController keeps scheduling its tick; `stopIntegratedSession()`
  only did `sessions.delete()` and never disposed the controller, so the loop ticked
  an orphaned session forever. No close/stop tool was on the default surface.
- **Fix:** new default tool `runtime_session_close` — finalizes an active trace,
  `disposeRuntimeController` (cancels the loop), drops the session. Idempotent.
- **Gate:** `npm run probe:744-3` (9/9).

### Blocker 2 — disk-swap not detected — FIXED 2026-06-05 (Spec 744 §7.2)

- **Reframe (user):** the UI swap WORKS — so the runtime CAN sense a swap; the
  problem was never broken 1541 timing. The atomic `runtime_media_swap`
  (detach+attach, ZERO drive cycles between) is the wrong tool for a *waiting*
  game: it gives the drive no cycles to sense the change. The UI works because the
  human does the hardware sequence (eject → machine keeps running → insert → run →
  RETURN), so real drive cycles pass and the write-protect-sense window progresses.
- **Fix:** new default tool `runtime_swap_disk_and_continue` (the §7.2 capability)
  does that sequence in ONE call: eject → `runFor` (drive senses removal) → insert →
  `runFor` (senses insertion) → type RETURN (default) → `runFor` (prompt advances).
  Each `runFor` advances the C64 AND the 1541 via IEC catch-up, so the sense window
  actually moves while the game polls. Shared `swapDiskAndContinue(ctrl, args)`
  (`media/swap-and-continue.ts`), daemon op `runtime/swap_disk_and_continue`
  (ws-server, pauses the loop → runs the sequence → resumes), MCP tool + daemon
  client. Returns a diagnostic { mounted, screenBefore, screenAfter, promptCleared,
  advanced }.
- **Why the speculated `diskunit_clk` trace (old 744.5) is moot:** running the C64
  between eject and insert IS what advances the drive clock — exactly what the UI
  (which works) does. No fidelity patch needed; the gap was a missing high-level
  call, not broken timing.
- **Gate:** `e2e:bug027-swap` 8/8 (mount A → swap-and-continue to B → new disk
  mounted, round-trip, diagnostic returned, missing image throws). `probe:single-path`
  25/25. The actual "game advances past Insert side N" on a real multi-disk title is
  live-verified (drive it on Wasteland: read the prompt with `runtime_render_screen`,
  call `runtime_swap_disk_and_continue` with the next side).

### Blocker 2 — original diagnosis (superseded by the §7.2 fix above)

- **Finding:** the facade IS VICE-faithful — `swapDisk` → `detachDisk`/`attachDisk`
  call `drive_image_detach`/`drive_image_attach`, which DO set `detach_clk` and (on
  attach-after-detach) `attach_detach_clk` (`vice1541/driveimage.ts:395-397,505`). So
  the write-protect-sense state machine (`drive.ts:1661` `drive_writeprotect_sense`,
  VIA2 PB4 / 0x10) IS armed. The earlier "zero elapsed cycles → no pulse" hypothesis
  is wrong: the WPS pulse (0x0 → 0x10 → 0x0) fires as the **drive clock advances**
  through `DRIVE_DETACH_DELAY` (600k) → `DRIVE_ATTACH_DETACH_DELAY` (1.2M) →
  `DRIVE_ATTACH_DELAY` (1.8M) cycles after the swap.
- **Open question (needs a runtime swap trace, NOT static reading):** does the drive
  clock (`diskunit_clk`) advance enough after the swap for the pulse window, and does
  the 1541 DOS poll WPS within it? Suspect either (a) the drive idles (no IEC traffic
  → `diskunit_clk` not advancing) while the game waits, so the window never expires,
  or (b) the ~1.8M-cycle delays are mismatched for an instant headless swap. Capture
  a trace of `drive_pc`, `$1c00` reads (VIA2 PB), `byte_ready`, and `diskunit_clk`
  across a `runtime_media_swap` and find the first divergence before patching
  (Spec 620 doctrine). Deferred — fidelity-critical 1541 timing, own slice.
