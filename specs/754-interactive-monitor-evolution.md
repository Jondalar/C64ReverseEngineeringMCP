# Spec 754 — Interactive Monitor evolution: VICE-superset over a shared capability layer

**Status:** PROPOSED (2026-06-03)
**Owner:** runtime monitor (`src/runtime/headless/v2/monitor.ts`, `agent-api.ts`) +
ui-v3 monitor (`ui/src/v3/**`, `src/workspace-ui/v3-ws-server.ts`)
**Closes:** BUG-036 (no coherent pause/resume — `g` only sets PC, "Run" calls a
missing op), BUG-037 (two divergent monitor command processors).
**Reference:** VICE monitor — `vice/src/monitor/{monitor.c, mon_parse.y,
monitor_binary.c, mon_memmap.c, mon_memory.c, mon_profile.c}` (read 2026-06-03).
**Cross-links:** Spec 701 (autonomous runtime — the run-loop we pause/resume),
Spec 753 + 753b (trace_memory_map + `peek`/old_value — §3.4/§3.5 here),
Spec 724.2 (one UI shell — consolidate not delete), Spec 746 (trace),
[[project_runtime_shared_session_vision]] (human + LLM on one session).

## 0. Principle (user)
> "VICE-Syntax ist gut — als Referenz sehen, dann lösen. Wir haben so viel mehr
> Möglichkeiten." + "Über den Monitor im Grunde die Tools des MCP nutzen können?"

Two intents: (1) make the monitor a *real* interactive debugger (the lifecycle
works, the VICE command set is there), and (2) make the monitor a **front-end onto
our capabilities** — the same way VICE's binary remote protocol is a second
front-end over its `mon_*` core. Keep VICE syntax for muscle memory; extend with
the verbs VICE never had (trace-store, memory-map provenance, taint, extract→disasm,
checkpoints, xref-to-findings).

## 1. Problems
**Already built — do NOT re-build (live `monitor/exec` path):** interrupt-aware +
flow-focus stepping (Spec 623 §4.2/§4.3) is wired to the `FlowTracker` (`ctrl.flow`)
and live: `z`/`n`/`ret` (step into/over/out, VICE-correct through JSR + IRQ/NMI),
`focus [auto|main|irq|nmi|brk|clear]` (no arg = show mode + current flow + the
interrupt/trap frame stack), `sf`/`stepf` (stepFocus — stop only in the target flow),
`nf`/`nextf` (nextFocus). This is the "gold vs VICE" feature and it WORKS. Scope here
is the lifecycle gap + consolidation + the genuinely-missing commands.

1. **Lifecycle (BUG-036, corrected).** `bk` pauses (halt breakpoint). But `g` is a
   **bounded synchronous burst** — `ctrl.pause()` then `runFor(20_000)` (one frame)
   with no breakpoints, else a run-to-breakpoint loop (cap 20M) — and ends HALTED. It
   does NOT enter the continuous running state the Run button uses (`ctrl.run()` /
   `continue()`), and with no breakpoint it advances only one frame (not VICE-faithful;
   VICE `g` free-runs until a bp). The run-state machine (`run`/`continue`/`pause`/
   `runState`) ALREADY EXISTS — `g` bypasses it. There is no explicit `pause` verb.
2. **Two monitors (BUG-037).** A VICE-syntax `monitor/exec` parser
   (`v3-ws-server.ts`) AND a `monitor-cmd-parser.ts` → `runtime/call` parser, with
   disagreeing command sets. Building richer commands on two grammars doubles work.
3. **Missing commands.** No inline assemble (`a c000 lda #$01`); no `load`/`save`/
   `bload`/`bsave`. (`dump`/`undump` already exist — Spec 707.)
4. **No shared layer for rich ops.** `runtime_monitor_*` MCP tools and the UI monitor
   already both call `AgentQueryApi` (the right pattern) — but only **8 allowlisted
   methods** (`API_CALL_ALLOWLIST`), and the high-value tools (`analyze_prg`,
   `trace_memory_map`, `inspect_address_range`, `extract_*`) are not reachable as
   monitor commands.
5. **`sidefx` / no side-effect-free read.** We have no `peek` (read without I/O side
   effects). This forced Spec 753 to *exclude* `$00/$01`/`$D000-$DFFF` from the
   old_value pre-read instead of peeking. VICE solves this cleanly (§3.4).
6. **memory-map parity.** VICE's `memmap` tracks per-address R/W/X + uninitialized-
   read/exec; our `trace_memory_map` (Spec 753) is richer on analysis but lacks
   those two (§3.5).

## 2. What VICE actually does (grounded, the reference)
- **Resume = the `exit_mon` flag.** `g <addr>` → `mon_jump` (set PC +
  `exit_mon=exit_mon_change_flow`); `g` → `mon_go` (`exit_mon=exit_mon_continue`);
  `x` → leave + continue. The monitor loop breaks when `exit_mon != exit_mon_no`.
- **Step model.** `z` step-into (`skip_jsrs=false`), `n` step-over
  (`skip_jsrs=true` + `wait_for_return_level` JSR/RTS-depth), `return` run-to-RTS/RTI.
  Mechanism: `monitor_check_icount(pc)` runs after every instruction, decrements the
  count, tracks call nesting; re-enters the monitor at zero. `until <addr>` = temp
  breakpoint then resume.
- **`sidefx` (side-effects toggle).** Default OFF → monitor reads use
  `mem_bank_peek()` (NO side effects); ON → `mem_bank_read()`. VICE even forces
  `sidefx=0` while evaluating a breakpoint condition that reads I/O ("otherwise weird
  stuff will happen"). This is exactly the Spec 753 `$01`/`$D000` problem, solved by
  a peek primitive.
- **`memmap` flags** (`monitor.h`): RAM/ROM/IO × R/W/X (9 bits) +
  `UNINITIALIZED_READ` + `UNINITIALIZED_EXEC` (access before write — uninitialised-
  memory bug detector) + `REGULAR_READ` (not a dummy read). `monitor_memmap_store
  (addr,type)` on every access; show = per-addr r/w/x columns; save = 256×256 bitmap.
- **`monitor_binary.c` = one core, two adapters (the precedent).** VICE's binary
  remote protocol (MEM_GET/SET, REGISTERS_GET/SET, CHECKPOINT_*, DUMP/UNDUMP,
  ADVANCE_INSTRUCTIONS, KEYBOARD_FEED, EXECUTE_UNTIL_RETURN, DISPLAY_GET,
  CPUHISTORY_GET, …) is a thin STX-framed wrapper that delegates to the SAME `mon_*`
  functions the text parser uses. No parallel impl. **This is the architecture for
  "MCP through the monitor."** (It is also literally the binmon we already drive for
  VICE-oracle traces.)
- **Command vocab** = ~103 commands. The execution/memory/breakpoint/label/memmap/
  profile/file-IO families are the proven baseline to adopt for the overlap.

## 3. Design
### 3.1 Run-state model (closes BUG-036) — DECIDED
The `running | halted` state machine already exists (`RuntimeController.run`/
`continue`/`pause`/`runState`); the toolbar Run/Pause buttons already use it via
`debug/run` / `debug/pause`. The monitor `g` does NOT — it bypasses the state with a
`pause()` + bounded `runFor` burst (1 frame with no breakpoint). Fix the monitor
verbs to hit the same run-state (user decisions, 2026-06-03):
- `g` (no addr) → `ctrl.continue()` — resume continuous free-run at the current PC.
- `g <addr>` → set `c64Cpu.pc = addr`, then `ctrl.continue()` (goto + run).
- `x` → exit/resume (= `g`, VICE-faithful). No other resume aliases.
- **No `pause` command.** Halting is the toolbar Pause button (`debug/pause`); VICE
  has no pause command either.
- `z`/`n`/`ret`/`focus`/`sf`/`nf`/`until` → unchanged (already correct, FlowTracker).
Drop the bounded-burst / 1-frame-on-no-breakpoint behaviour entirely. (The headless/
LLM "synchronous run-to-bp that returns a landing" stays a separate tool —
`runtime_until` — so the human `g` is live-resume without losing the agent path.)

### 3.2 One canonical monitor (closes BUG-037)
Pick the `monitor/exec` VICE-parser as the single processor (it already has the
broadest set), retire the second parser, route every monitor surface through it.
One command table = the source of truth (Spec 724.2: integrate, keep all working
commands).

### 3.3 VICE-parity command set (adopt the overlap verbatim)
Execution: `g n z ret until`. Memory: `m d a > f t c h i ii` + `mem*`. CPU: `r
sidefx bank`. Breakpoints: `break watch trace condition command enable disable
delete ignore`. Labels: `add_label load_labels save_labels show_labels`. File:
`load save bload bsave dump undump` (dump/undump exist). New work: **`a` inline
assembler** (reuse `pipeline/src/lib/mos6502.ts` for one-line mnemonic→bytes→poke)
and **`load/save/bload/bsave`** (reuse `loadPrgIntoRam` + a memory-range dump).

### 3.3b Memory view (Block B) — DECIDED (2026-06-03)
Closes BUG-038 (`m`/`d` read raw `c64Bus.ram` → banking-blind: `m e000` shows RAM
under KERNAL, `m d000` shows RAM under I/O, not what the CPU sees).

- **Bank lens, inline, VICE vocab** (`c64mem.c:1239` `banknames[]`):
  `m [bank] <start> [end]`, `bank ∈ default|cpu|ram|rom|io|cart` (default = `cpu` =
  banked, what `$01` maps). `m cpu d000` = registers/peek; `m ram d000` = RAM under
  I/O; `m rom e000` = KERNAL bytes; `m io d000`; `m cart …`. Same lens token on
  `d`/`i`/`ii`/`mc`/`ms`. Keep a sticky `bank <name>` (VICE) for the default. (Later:
  `drive8` for the 1541.)
- **Format:** `$20` bytes/row (not `$10`) + a PETSCII char column; default dump
  length **`$800`** (not ~`$150`); explicit end overrides.
- **`screen`** — decode the text screen as 40×25. Edge over VICE: read the REAL
  screen pointer (VIC bank + `$D018`), not a hard-coded `$0400`, so it follows a
  relocated screen. (Lets you read `$0400`-region RAM as text.)
- **Bank-aware read needs `peek`** (§3.4): the `cpu`/`io` lens reads I/O via the
  side-effect-free `peek` by default (so `m d019` doesn't clear the IRQ latch),
  `sidefx on` switches to live reads.
- **RAM-as-bitmap render** → folds the Scrub tab into the monitor. `bitmap <addr>
  [w] [h] [mode]` renders a memory range as an image (hires/multicolor/charset/
  sprite) to scrub for graphics/charsets/sprites by eye. Build the command +
  data now; keep the Scrub tab until the view lands; visual placement = browser-
  annotate later ([[feedback_ui_browser_annotation]]).

### 3.4 `sidefx` + a `peek` primitive (couples to Spec 753b)
Add a side-effect-free `peek(addr)` to the memory bus (VICE `mem_bank_peek`) and a
`sidefx on|off` toggle (default off → monitor reads peek). Then **Spec 753's
old_value pre-read uses `peek` for ALL addresses** — drop the `$00/$01`/`$D000`
exclusion; the persistence surface becomes complete (the 753b follow-up).

### 3.5 memory-map parity → trace_memory_map upgrades (Spec 753)
Add to the trace memory map: `UNINITIALIZED_READ`/`UNINITIALIZED_EXEC` (read/exec of
never-written RAM — a real bug finder), explicit per-address R/W/X bits, and an
optional bitmap/PNG render (VICE `memmapsave`). Our map keeps its extras VICE lacks
(old_value/mutation, writer-PC provenance, free-holes + EF-legal, reconcile-static)
→ a true superset.

### 3.6 Capability-layer doctrine (the "MCP through monitor" answer)
Do NOT reverse the stdio channel to "call the MCP server from the monitor" (the
process boundary makes that circular). Instead, follow VICE `monitor_binary.c`: **one
capability core, multiple thin adapters.** `AgentQueryApi` / the runtime+trace+
project services are our `mon_*` core. The MCP tool is one adapter; the monitor
command is another; the UI button a third. Grow the core to cover the high-value RE
ops, then expose each via both adapters. Concretely: replace the 8-method
`API_CALL_ALLOWLIST` with a curated, documented capability registry that both the
monitor parser and the MCP tools resolve against.

### 3.7 "Break free" — the superpower verbs VICE never had
New first-class monitor commands over the capability core: `map` (trace_memory_map),
`taint`, `trace`/`tracedb` + trace-store SQL, `xref` (→ disasm/findings), `extract`
(→ analyze→disasm), `inspect`, `checkpoint`/`rewind` (Spec 705.B), `flow` (746.13).
Plus VICE's `memspace` prefixes (`c:` / `8:`) so commands address the C64 OR the
1541 drive uniformly (the model for the 753b drive memory map).

## 4. Phases
- **P1 — lifecycle + consolidate.** Run-state model + `g/x/pause/resume/z/n/ret/
  until` wired to one path; Run/Pause buttons fixed; retire the duplicate parser.
  Closes BUG-036 + BUG-037. (Highest user value — this is what bites today.)
- **P2 — VICE-parity commands.** `a` inline assembler; `load/save/bload/bsave`;
  `sidefx` + `peek` (and fold Spec 753b old_value-via-peek); `f/t/c/h` memory ops if
  missing; label load/save.
- **P3 — capability layer + superset verbs.** Capability registry (replaces the
  allowlist); curated RE ops as monitor commands AND MCP tools over one core; the
  `map/taint/xref/extract/checkpoint/flow` verbs; memspace prefixes.

## 5. Open questions (genuinely the user's call)
- **OQ1 — capability-layer breadth (the fork).**
  (A) Parity+polish only: P1+P2, no tool-bridge. Smallest, no architecture risk.
  (B) **Curated capability layer (P3 as written):** the RE-operational ops become
  monitor commands AND MCP tools over one core (the VICE binary-monitor model).
  (C) (B) + a generic `!<tool> <args>` escape over the whole ~296-tool surface.
  Recommendation: target **B**, ship **A** first (P1+P2), treat C as a later escape
  hatch. But the ceiling is the user's decision.
- **OQ2 — what belongs in the monitor.** LLM-workflow tools (`save_finding`,
  `agent_*`, `project_init`) are not sensible interactive commands — confirm the
  curated set is RE-operational only.
- **OQ3 — wire format.** Keep our WS-JSON (`runtime/call`/`monitor/exec`) or adopt a
  VICE-binary-style framed protocol for the capability adapter? (Probably WS-JSON;
  we already speak it.)

## 6. Non-goals
- NOT a 1:1 VICE re-implementation (no `warp`, `tapectrl`, `screenshot`-to-IFF, etc.
  unless they earn their place).
- NOT exposing LLM-only workflow tools as interactive monitor commands.
- NOT reverse-RPC from the daemon back into the MCP stdio process.

## 7. Acceptance (per phase, sketch)
- P1: `bk` halts; `g`/`x`/Run resumes (verified by run-state transition + PC advance);
  one parser handles the command set; gate `e2e:754-lifecycle`.
- P2: `a c000 lda #$01` pokes the right bytes; `bsave`/`bload` round-trips a RAM
  range; `peek($d011)` returns the value without advancing raster/side effects;
  Spec 753 old_value populated for an I/O write via peek.
- P3: a curated tool (e.g. `map`) runs identically as a monitor command and as the
  `trace_memory_map` MCP tool over one core path.
