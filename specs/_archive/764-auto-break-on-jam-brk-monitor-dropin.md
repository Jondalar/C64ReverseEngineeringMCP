# Spec 764 — Auto-break on JAM/BRK + monitor drop-in (VICE-style)

**Status:** PROPOSED (2026-06-08)
**Owner:** the headless run-loop + controller
(`src/runtime/headless/cpu/cpu65xx-vice.ts` `jammed`,
`src/runtime/headless/integrated-session.ts` run path,
`src/runtime/headless/daemon/**` controller), the halt broadcast
(`src/workspace-ui/ws-server.ts`), the monitor
(`src/runtime/headless/debug/monitor-shell.ts`), the UI monitor popup
(`ui/src/workbench/components/MonitorPopout.tsx` / `tabs/Live.tsx`).
**Reference (grounded):** 2026-06-08 capability check — the pieces exist, only the
wiring is missing (see §1). User ask: "wenn wir auf ein JAM oder BRK laufen — kann
automatisch die Pause kommen und der Monitor aufpoppen, so wie VICE, mit R / BT /
Info?"
**Cross-links:** Spec 754 (interactive monitor — §3.3e is the existing
breakpoint/observer halt→drop-into-monitor path this reuses; `r`/`bt` verbs live
here), Spec 723 (single-path runtime — the literal `Cpu65xxVice` that raises
`jammed`), Spec 701 (runtime autonomy — backend owns run-state; pause is a
controller action). [[project_spec754_monitor]], [[project_spec723_single_path]].

## 0. Principle
A JAM (KIL illegal opcode) or — optionally — a BRK should behave like VICE: the
machine **auto-pauses**, the **monitor pops to the front**, and it lands showing
**registers + backtrace + a one-line status** (the "R / BT / Info" drop-in). Today
a JAM silently freezes the picture while the loop keeps cycling, and the user has
to notice and pause by hand.

## 1. Current state (measured 2026-06-08)
Everything needed exists; nothing connects JAM/BRK to the halt path.

| Piece | Status | Location |
|---|---|---|
| JAM detection | ✅ sets `jammed = true` + trace event; cycles clk VICE-faithfully, PC frozen | `cpu65xx-vice.ts:339,1396-1408` |
| Run-loop reaction to `jammed` | ❌ **none** — loop never inspects `jammed`; only `reset()` clears it | `integrated-session.ts:747-748` |
| BRK | runs the real BRK→IRQ vector (KERNAL); no monitor break | `cpu65xx-vice.ts:1155`, `microcode-table.ts:304` |
| Pause / run-state | ✅ `controller.pause()`, `runState` | `ws-server.ts:680,726` |
| Halt→popup broadcast | ✅ `debug/breakpoint_hit` / `observer_hit` / `stopped` / `paused` (+ PC) → UI drops into monitor | `ws-server.ts:446`, Spec 754 §3.3e |
| Monitor `r` (registers) | ✅ | `monitor-shell.ts:360` |
| Monitor `bt` (backtrace) | ✅ stack-scan + flow frames | `monitor-shell.ts:994` |
| stopped payload carries `reason` | ✅ | `monitor-shell.ts:931` |

The gap is exactly one edge-detector + one broadcast + one auto-dump.

## 2. Design — connect `jammed`/BRK to the existing halt path

### 2.1 Edge-detect in the run-loop → pause + broadcast (fire once per episode)
In the run-loop tick (the place that advances the C64 CPU each step), after the
instruction boundary, check for a fresh halt condition. A module-level edge flag
`brokeOnJam` guards re-entrancy: fire ONCE on the rising edge, then suppress until
the flag is cleared by `reset()`/`resume()` (a JAM keeps cycling clk every tick —
without the flag it would re-broadcast forever; a JAM while an IRQ/NMI is pending
must also fire exactly once). Decisions (OQ1/OQ5):
- **JAM:** `cpu.jammed === true` && `!brokeOnJam` → set `brokeOnJam`,
  `controller.pause()` + broadcast `debug/stopped` with
  `{ reason: "jam", pc, opcode, flow }`. **Always on** — a JAM is always a fault,
  the pop-up is unconditional.
- **BRK:** detect a BRK opcode at the boundary (CPU already has the IRQ/NMI/BRK
  hook — `cpu65xx-vice.ts:1329`) → same `debug/stopped` with
  `{ reason: "brk", pc, flow }`. Gated by a `breakOnBrk` **parameter, default
  OFF** (BRK is legitimate control flow; VICE only breaks when configured).

`flow` = the control-flow attribution of the halt (see §2.3): the current routine
+ call-chain frames, so the stop is anchored to *where in the path* it happened.

The pause must use the existing controller so run-state echo / frame-freeze
(Spec 701 §7 / 761) behave exactly as a breakpoint halt — the frozen frame is
captured and pushed, the yellow-border/run-state machinery is unchanged.

### 2.2 UI — reuse the breakpoint popup, add the reason label + focus the path
`MonitorPopout` / `Live.tsx` already drop into the monitor on `debug/stopped`
(Spec 754 §3.3e). Add the new reasons (`jam` / `brk`) to the label so the banner
reads e.g. `■ JAMMED @ $C5A2 (op $02)` instead of a generic breakpoint, bring the
monitor window to the front, and **focus it on the JAM's flow path** (OQ5): scroll
the disasm/flow view to the JAM PC and highlight the `flow` call-chain from the
payload, so the user lands looking at *where* execution died, not a bare prompt.

### 2.3 The "Info" drop-in = auto R + BT + status, anchored to the path
On entry for a jam/brk stop, the monitor lands already showing:
- `r` — registers (A/X/Y/SP/PC/flags),
- `bt` — backtrace (stack-scan + flow frames) — this **is** the `flow`
  attribution: the call-chain that led to the JAM (OQ5), the monitor's existing
  flow-frame source feeds both the `bt` output and the `flow` field in the payload,
- a one-line status: `reason`, PC, the opcode byte at PC, and the disassembled
  instruction (for JAM: the KIL byte; for BRK: the BRK + its vector target).

Implement by either (a) the backend including this block in the `debug/stopped`
payload, or (b) the monitor auto-executing `r; bt` + a status line when it opens
with a jam/brk reason. Lean (b) — reuses the verbs verbatim, no payload bloat.
The `flow` field in the payload (§2.1) is the same flow-frame data `bt` already
computes, lifted into the stop so the UI can focus on it without a round-trip.

### 2.4 Recovery
From the jam drop-in, the existing controls already recover (MachineControls notes
"recover even from a JAMmed game" — power/reset clears `jammed` via
`integrated-session.ts:747`). No new recovery path; the user resumes via the
normal run/reset/power buttons. (A monitor `reset`/`g` verb continuing past a JAM
is OQ3.)

## 3. Phases
- **P1 — JAM auto-break.** Edge-detect `jammed` in the run-loop → pause +
  `debug/stopped {reason:"jam"}`. UI label + focus. This alone delivers the core
  ask (JAM is the painful silent-freeze case).
- **P2 — Info drop-in.** Auto `r; bt` + status line on jam-stop entry.
- **P3 — BRK opt-in.** `breakOnBrk` flag (default OFF) + BRK edge-detect →
  `debug/stopped {reason:"brk"}`. Same drop-in.

### 2.5 MCP surface (OQ2 — both)
The auto-break raises on the **MCP side too**, for free: the daemon already
broadcasts `debug/stopped`, and the MCP `runtime_*` tools are clients of it. So an
agent stepping headless gets the **same structured jam/brk stop** (reason + pc +
opcode + flow). A `runtime_step_*` / `runtime_session_run` call that hits a JAM
returns the jam-stop as its **result** (does not silently keep cycling), so the
agent sees the halt exactly like a breakpoint.

## 4. Resolved decisions (2026-06-08, user)
- **OQ1 — JAM always, BRK opt-in.** JAM auto-break + pop-up is **unconditional**.
  BRK is gated by a `breakOnBrk` **parameter, default OFF**. (§2.1)
- **OQ2 — both surfaces.** Emit on UI **and** MCP via the one `debug/stopped`
  broadcast; the MCP step call returns the jam-stop as its result. (§2.5)
- **OQ3 — reset-only.** No continue-past-JAM verb in P1-P3; real silicon stays
  jammed until reset. Optional debug override deferred.
- **OQ4 — drive JAM later.** 1541 CPU `is_jammed` (`vice1541/drive.ts`) is out of
  scope; C64 CPU only. Follow-up spec.
- **OQ5 — once per episode + path focus.** `brokeOnJam` edge flag fires the break
  exactly once per JAM episode (cleared on reset/resume), incl. JAM-during-pending-
  IRQ. The stop is attributed to its control-flow path (`flow` = the `bt` frames)
  and the monitor focuses on it. (§2.1, §2.2, §2.3)

## 5. Non-goals
- NOT changing JAM/BRK *execution* semantics — the CPU stays VICE-faithful
  (jammed keeps cycling clk, BRK runs its real vector). This spec only *observes*
  the edge and pauses around it.
- NOT a new monitor or popup — reuses Spec 754 §3.3e end-to-end.
- NOT auto-recovery (no auto-reset on JAM) — the user decides.
- NOT drive-CPU JAM (OQ4).

## 6. Acceptance
- P1: running code that executes a KIL opcode ($02/$12/…/$F2) auto-pauses within
  one instruction, `runState` goes paused, and the UI monitor pops to the front
  labelled `JAMMED @ $PC (op $xx)` — verified on a synthetic PRG that jumps to a
  `.byte $02`.
- P2: the jam drop-in shows `r` + `bt` + the status line without the user typing
  anything.
- P3: with `breakOnBrk` ON, a `BRK` auto-pauses + drops in labelled `BRK @ $PC`;
  with it OFF (default), BRK runs the vector normally (no break).
- Gate `e2e:764` (synthetic JAM PRG + a BRK PRG, assert pause + stopped reason +
  auto-dump).
