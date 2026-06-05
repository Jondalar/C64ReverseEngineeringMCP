# Spec 754 — Interactive Monitor evolution: VICE-superset over a shared capability layer

**Status:** P1+P2+P3 DONE (2026-06-05, gate `e2e:754` 125/125). Block I read-inspect
(`device c64|drive8`, §3.3i) + `bitmap` RAM-as-PNG (§3.3b) shipped this round.
**Explicitly out of "754 done" (own specs):** capability registry = Spec 760
(deferred; verbs stay direct-dispatch); snapshot rename `snap`/`unsnap`↔`dump`/`undump`
waits on the `.vsf` codec = Spec 755; 1541-CPU single-step on `drive8` = a Spec 612
fidelity slice; `bitmap` multicolor = v1.1. See §3.8 for the live-test refinement log.
**Owner:** runtime monitor (`src/runtime/headless/debug/monitor-shell.ts`) +
the workbench monitor (`ui/src/workbench/components/Monitor*.tsx`, `src/workspace-ui/ws-server.ts`)
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
Execution: `g n z ret until`. Memory: `m d a wr f t c h i ii` (word `wr`, not `>`).
CPU: `r sidefx bank`. Breakpoints → **replaced by the observer model (§3.3e)**: the
VICE `break/watch/trace/condition/command/ignore` verbs are subsumed by `obs`/`o`;
`bk` stays as a convenience facade. Labels: `add_label load_labels save_labels show_labels`. File:
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

### 3.3c Memory edit (Block C) — DECIDED (2026-06-03)
All new on the live `monitor/exec` path. **Word commands, not VICE symbols** (the
spec-wide principle the user set — cf. `m cpu` over `c:`): drop the bare `>`.
- `wr <addr> <bytes…>` — write exactly these bytes from `addr` (length = the list).
  This replaces VICE `>`. `wr c000 a9 01 8d 20 d0`.
- `f <start> <end> <data…>` — fill the range, repeating the data (VICE verbatim;
  the user's habitual byte-write `f c000 c004 a9 01 …` keeps working). `wr` = list-
  length, `f` = range + repeat — both kept, distinct.
- `a <addr> <instruction>` — inline assembler. Build a one-line 6502 assembler
  (mnemonic + operand → addressing mode → opcode bytes → poke) reusing the opcode
  table in `pipeline/src/lib/mos6502.ts` (256 ops incl. undocumented). All modes
  (`#$xx`, zp, zp,x/y, abs, abs,x/y, `($zp,x)`, `($zp),y`, ind, acc, impl, rel).
  **Modal assemble DONE (2026-06-04, VICE-faithful):** `a <addr>` enters assemble
  mode at addr; `a <addr> <instr>` assembles inline then stays in mode at the next
  addr. In mode the prompt becomes VICE's `.c002  ` (lowercase dot-addr,
  `monitor.c:3068` `make_prompt`) and every line is an instruction (no `a` prefix);
  each advances the cursor by the instruction length; an **empty line exits**
  (`mon_parse.y:944` `asm_mode=0`). Per-session `asmCursors` + a `MonitorResult.prompt`
  field; the dispatch intercepts in-mode lines BEFORE verb parsing; the client
  (`MonitorPanel`, shared by the in-page panel + the MON popout) shows `prompt` and
  sends raw/empty lines. **One deliberate deviation from VICE:** a bad instruction
  stays in mode + re-shows the prompt (VICE silently drops out) — friendlier for
  live editing. Gate `e2e:754` Part L (88/88). Label/symbol operands still
  numeric-only (couples to the Block F label store).
- `t <range> <dest>` move (overlap-safe), `c <range> <dest>` compare (show diffs),
  `h <range> <data…>` hunt/search (`xx` = wildcard byte) — VICE verbatim. (`wr`/`f`/
  `h` are the cracking core: hunt a pattern, patch it.)

**Spec-wide naming principle (user):** prefer a word command over a VICE symbol.
`wr` not `>`; bank lens words not `c:`/`8:` prefixes (§3.3b). Apply to later blocks.

### 3.3d CPU & registers (Block D) — DECIDED (2026-06-03)
- `r` — show. Keep the VICE register line (muscle memory) + add **flow inline** and
  a **vectors block** (variant B). Always show the vectors (crack-gold: where the
  IRQ/NMI RAM-vector actually points = what loaders/cracks hijack). Inside an
  interrupt, the flow field shows the FlowTracker frame (`IRQ ◀ from MAIN @ $E5CD
  (entered cyc+35)`) — VICE cannot do this. Shape:
  ```
  > r
    ADDR AC XR YR SP NV-BDIZC  flow
  .;E5CD 00 00 0A F3 nv-bdiZc  MAIN
    vectors  IRQ hw=$FF48  CINV $0314→$EA31     NMI hw=$FE43  NMIV $0318→$FE47
  ```
- `r <reg>=<val>` — SET (was show-only). Accept space- AND comma-separated lists
  (`r a=$42 x=$10` / `r a=$42, x=$10`).
- `bank [name]` — sticky default lens `cpu|ram|rom|io|cart` (couples §3.3b).
- `sidefx [on|off|toggle]` — side-effect read toggle (couples §3.4 `peek`).
- Drop VICE `cpu <type>` (CPU-type is moot — always 6502; the live `cpu`→`r` alias
  is removed).

### 3.3e Observers — unify breakpoint / watch / tracepoint / condition / command (Block E) — DONE v1 (2026-06-03)
**v1 shipped:** `obs/o when exec|load|store <addr[..end]> [if <cond>] do break|log`
(+ `obs` list, `obs <name> on|off|del`, `obs log`, `ignore <name> [n]`). In-loop
eval (exec at the instruction boundary in `runFor`; load/store via the CPU bus
hook). **Per-ADDRESS** watch gate (user decision) — idle cost 0 (`accessWatch`
null when no load/store observer), an active observer pays cond-eval only on its
exact address. Cond grammar: `a/x/y/pc/sp/fl/rl/val/addr` + `== != < > <= >= && ||`
+ parens. `monitor-observers.ts` + `aborted='observer'` (RuntimeController halts +
`debug/observer_hit`). Gate `e2e:754` Part F.

**v1.1 — UI feedback wired (2026-06-04).** The server always broadcast
`debug/observer_hit` (break) + accumulated `do log` lines, but NO UI listener
consumed them — a `break` observer halted silently (no monitor jump, no banner)
and `do log` was pull-only via `obs log` (diagnosed via a 4-agent
fire→broadcast→UI trace, all 5 root-cause claims adversarially confirmed). Fixed:
- **break → drops into the monitor like `bk`:** `MonitorPopout` + `Live` now listen
  for `debug/observer_hit`; `MonitorPanel` prints an observer banner
  `*obs <name> at $PC — <message>` (vs `#n BREAK`) + register dump + input focus;
  Live freezes run-state + grabs the frozen frame. `BpSignal` carries
  `observer`/`message`.
- **`do log` → live stream:** the registry buffers pending lines
  (`drainPendingLog()`); the controller drains + broadcasts `debug/observer_log`
  per run-chunk; `MonitorPanel` appends them to the console live (a visible
  tracepoint). `obs log` still pulls the full ring. Gate `e2e:754` Part F4c
  (drain). UI listeners are live-tested (gate can't assert React subscriptions).

**v1.1 TODO (remaining):** actions `mark`/`cmd`/`trace <scope>` (need
controller/monitor wired into the registry); `cy` (cycle-in-line) in conditions;
`g` skip-past an exec-observer addr (today it re-triggers); observer×manual-stepping
interaction. `bk` stays its own breakpoint (facade-into-obs unify deferred).


The biggest "break free from VICE" decision. VICE's `break`/`watch`/`trace`/
`condition`/`command`/`ignore` are replaced by ONE named abstraction — the
**observer** — because (user) "bk ist doch ein watch mit fassade" and VICE's inline-
`if` syntax is poor. Conditions are encapsulated IN the observer, not scattered.

**Model:** `observer = { name, trigger, condition?, action }`.
```
obs <name> when <trigger> [if <cond>] do <action>      # verb `obs`, shortcut `o`
```
- **trigger** = `exec|load|store <addr | start..end>` (`..` = range).
- **condition** (encapsulated, optional) = regs `a/x/y/pc/sp/fl` + `rl` (rasterline)
  + `cy` (cycle-in-line) + ops `== != < > <= >= && ||` + parens.
- **action** = `break` (default) · `log` (print + continue = VICE tracepoint) ·
  `trace <scope>` (event-driven scoped capture — VICE can't) · `cmd "<mon-cmd>"`
  (= VICE command) · `mark` (drop a trace bookmark / checkpoint mark).
- **`bk <addr>` stays** as a convenience that creates an exec-observer with
  `do break` behind the scenes (muscle memory).
- **management:** `obs` (list: name·trigger·cond·action·hits·on/off) ·
  `obs <name> on|off` · `obs <name> del` · `ignore <name> [n]` (skip n triggers).
```
o sflip when store $d018 if a!=$1b do break
o keyrd when load  $0314..0315       do log
o hot   when exec  $c000..cfff       do trace c64-cpu+memory
bk e5cf      # = o _bk1 when exec $e5cf do break
```
VICE `watch`/`trace`(point)/`condition`/`command`/`enable`/`disable` are SUBSUMED
(not separate commands). `trace` stays OUR capture verb (§ below), not a tracepoint
(`do log` is the tracepoint).

**Evaluation architecture — IN the execution path, NOT run-then-rewind:**
- **exec** trigger → the CPU-step PC check (`runFor({breakpoints})` + the autonomous
  loop) — exactly today's `bk` cost.
- **load/store** trigger → the **Spec 753 bus-access emit** (`store()`/`loadRead()`).
  The SAME hook that feeds `trace_memory_map` now also feeds observers (and a live
  trace). One hook, multiple consumers.
- The condition is evaluated at the trigger point (full regs/RL/CY available); you
  **stop AT the trigger** — the CPU state IS the trigger state, no rewind to reach it.
- NOT run-then-rewind: that would need an always-on firehose to detect after the
  fact, which is the expensive path.

**Performance strategy (load/store observers are the only real cost):**
- Gating, 3 tiers: no observers → 0 (`store()` unchanged, emit off — Spec 753 proven
  inert). exec → `Set.has(pc)`/instr (= current `bk`, negligible). load/store →
  a **per-page watch bitmap**: `if (watchedPages[addr>>8]) checkSlow(...)` — fast
  path is one array index + branch; the condition eval runs only on a watched page.
- Do NOT build the full `BusAccessEvent` per access for observers — the bitmap gate
  comes first; only a match builds context.
- **Decouple the old_value pre-read** (Spec 753): gate it on *trace active*, not
  *emit active* — observers need addr+value+cond, not old_value. So observing
  doesn't pay the pre-read.
- Reference: full firehose capture = ~5.7% / 2.05× PAL (Spec 726.B gate); observers
  with the bitmap gate are a small fraction of that; the paced 1 MHz loop has headroom.

**Trace + scope + rewind (the "more than VICE" part — user point 1):**
- `trace start <scope>` / `trace stop` / `trace status`. scope = domains
  (`c64-cpu/drive8-cpu/iec/vic/sid/memory`) + focus (`main|irq|nmi`, Block A) +
  addr-window (`win $c000..cfff`). Our `trace` = the trace-store capture, unchanged.
- `rewind` (last checkpoint) · `rewind <n>` (n back) · `rewind list` (the ring). The
  `checkpointRing` already auto-captures ~every 25 frames (~0.5 s); `restoreCheckpoint`
  / `rewindTo` exist but only in the Snapshots tab — expose them in the monitor.
- Combo: `o X when … do trace <scope>` = scoped, event-driven capture.

**Rewind = secondary, plus a retroactive follow-up:** the primary observer is
in-loop (stop at trigger). Rewind is the time-travel-after-stop tool. A future
**retroactive observer** ("break at the LAST write to $d018 before the crash") =
scan the trace + rewind to the nearest checkpoint + single-step to the exact cycle —
needs ring+trace+rewind combined; a follow-up mode, not the default.

### 3.3f Symbols & knowledge (Block F) — DECIDED (2026-06-03)
The monitor becomes a front-end onto the knowledge layer (the §3.6 capability-layer
idea). VICE's labels are a tiny subset of our findings/entities/symbols/xref.
```
label <addr> <name>     name an address (VICE add_label) — persists as an entity/symbol
label                   list
unlabel <addr|name>     remove
sym <name|addr>         resolve a symbol (our symbols/entities)
xref <addr>             cross-refs: who calls/jumps/reads/writes here (VICE has none)
note <addr> "<text>"    drop a finding/comment from the monitor (persists)
```
- Word commands (not VICE `add_label`/`delete_label`), persisting as
  entities/symbols. **Bidirectional:** a monitor `label` creates/links a knowledge
  entity; existing symbols/findings surface as monitor labels.
- **`xref <addr>`** — callers/callees/reads/writes from `crossReferences`. A real
  crack win VICE can't do ("who writes $d018?" → list).
- **`note`** — set a finding straight from the monitor (instead of the `save_finding`
  tool). The monitor as a knowledge front-end.
- `d` disassembly shows labels/comments/xref **inline** (annotated, couples §3.3b) —
  EXPERIMENTAL ("try it"): the annotated-listing data rendered live in the monitor.

### 3.3g File I/O + FS mini-shell (Block G) — DONE v1 (2026-06-04)
The VICE monitor is also a filesystem mini-shell — the user uses it constantly while
cracking (load a sample, save a patched PRG). Add it, rooted at the project dir.

**v1 shipped (gate e2e:754 Part K, 80/80):** the FS mini-shell
(`pwd`/`cd`/`ls`/`dir`/`mkdir`/`rmdir`, per-session cwd starting at the WS server's
`projectDir`) + file I/O (`load`/`save`/`bload`/`bsave`). Paths resolve relative to
the session cwd via `resolveFsPath`; absolute paths allowed. `load` uses
`session.loadPrgIntoRam` (CBM header → load addr, or override) and sets the disasm
cursor; `save` writes a 2-byte-load-addr PRG; `bload`/`bsave` are raw (no header)
over `c64Bus.ram[]`. monitor-shell stays runtime-pure (just node:fs); the WS server
passes `projectDir`. **Deferred:** `[dev]` arg on load/save (Block I device plumbing);
the disk verbs `attach`/`detach`/`@"<cmd>"` (need the media-mount path); the
`snap`/`unsnap` ↔ `dump`/`undump` rename (the `.vsf` codec is **Spec 755** — until
that lands, `dump`/`undump` keep their current `.c64re` meaning, no rename).

**FS mini-shell (rooted at `C64RE_PROJECT_DIR`):**
```
pwd                    current dir (starts at the project dir)
cd <dir>               change dir
ls | dir [path]        list the HOST filesystem (the mini-shell)
mkdir / rmdir <dir>    make/remove dir
```
Filenames in `load`/`save`/`bload`/`bsave` resolve relative to the shell cwd.
Project-rooted, but absolute paths allowed (load a `.crt` from `samples/` etc.).

**File I/O (relative to cwd, bank-aware = cpu lens):**
```
load  "<file>" [dev] [addr]      PRG load (CBM header → load addr, or override)
save  "<file>" [dev] <a1> <a2>   save a range as PRG (2-byte load addr)
bload "<file>" <addr>            binary load — raw bytes, no header
bsave "<file>" <a1> <a2>         binary save — raw range, no header (the Block-C range↔file)
```

**Snapshots — naming maps to format (user decision):**
```
snap   "<file.c64re>"            OUR snapshot format (Spec 707) — RENAME of the
unsnap "<file.c64re>"            existing dump/undump.
dump   "<file.vsf>"              VICE Snapshot Format (interop) — undump a VICE-saved
undump "<file.vsf>"              state (e.g. EF_Version_C/*.vsf) into our runtime;
                                 dump our state for an oracle cross-check in VICE.
```
`dump`/`undump` keep their VICE-faithful meaning (= `.vsf`); the existing `.c64re`
path moves to `snap`/`unsnap`. **The `.vsf` codec is its own spec — Spec 755**
(native VICE snapshot read/write; the command here just dispatches by extension).

**Disk (distinct from the host FS):**
```
attach "<file>" [dev]   mount disk/crt
detach [dev]
@ "<disk-cmd>"          disk command — @"$" = disk directory, @"s0:name" = scratch
```
`ls`/`dir` = host FS (mini-shell); the DISK directory is `@"$"` — two different
"dir"s, do not conflate.

### 3.3h Analysis superpowers + the checkpoint-substrate model (Block H) — DONE v1 (2026-06-04)
**v1 shipped (gate e2e:754 Parts H/I/J, 67/67):** `flow` + `bt` (daemon-local);
`map` + `taint` + `swimlane` (trace-store via the WS `ctx.traceRead` bridge on
`ctrl.traceRun.currentStorePath()`, read-only in-daemon → no BUG-029 lock);
`chis` (replay-from-checkpoint → swimlane, non-destructive); `inspect` + `xref`
(read-only project `_analysis.json` via the WS `ctx.projectRead` bridge —
`loadEffectiveSegments` overlay, BUG-034-safe; address→artifact by head-read
range-match + optional `[stem]`). monitor-shell stays runtime-pure; the WS server
owns the trace/project readers. **`bitmap` DONE (2026-06-05, §3.3b):** writes a PNG
artifact (the text monitor can't inline) — `monitor-bitmap.ts` decodes hires/charset/
sprite + a minimal node:zlib PNG encoder, runtime-pure (no bridge). **Deferred:** the
capability **registry** (Spec 760 — monitor verbs stay direct dispatch). **v1 caveats:**
map/taint/swimlane need a trace (`trace on`);
chis vs active observers; the address→artifact gap (multiple PRGs at one address →
use `[stem]`). The realization of §3.6 — capabilities as monitor commands over the
same services the MCP tools call. **OQ1 RESOLVED: curated verbs only, NO generic
`!tool` escape** (the LLM-workflow tools stay LLM-only).

**Curated capability verbs:**
```
map [static-ranges]        trace_memory_map (free RAM / persistence surface)
taint <addr>               data-flow taint (runtime_trace_taint)
inspect <addr>             inspect_address_range (segment/kind/effective)
analyze <addr> [end]       heuristic analysis on a memory range (analyze_prg core)
extract <disk|crt> …       extract → auto analyze+disasm (Spec 752 L2)
bitmap <addr> [w h mode]   RAM-as-image (§3.3b, folds Scrub)
flow                       flowState panel (§3.3a)
xref <addr>                cross-refs (§3.3f)
```

**VICE analysis verbs:**
```
sw | stopwatch [reset]     cycle counter delta (trivial; c64Cpu.cycles)
bt | backtrace             JSR call chain — stack scan for return-addr pairs +
                           our FlowTracker IRQ/NMI frames (more than VICE's stack-only guess)
```
`profile`/`prof` is **dropped** (user: overrated — LLM-driven trace analysis beats a
built-in profiler). `top-pcs`/hotspots stays an LLM `trace_store_*` tool, not a
monitor verb.

**The unification — one substrate, three views (the "wie passt das zusammen"):**
The **checkpoint ring** (Spec 705.B, auto-captures full state ~every 0.5 s) is the
TIME SUBSTRATE. History is NOT stored per-instruction; it is REGENERATED by
deterministic replay:
- **`chis [cycles]`** = rewind to the nearest checkpoint → **replay to now with
  capture on** → the exact recent stream (≤0.5 s for free; deeper by rewinding
  further). No always-on per-instruction ring; bounded, on-demand (you are paused).
  This is literally "what we do between two snapshots" — replay between, don't store.
- **`bt`** = read the stack now (instant best-guess) + refine via the chis replay
  (exact JSR chain) + the FlowTracker interrupt frames.
- **CHIS swimlane in the monitor** — render the replayed stream as lanes
  **c64-CPU · IRQ · NMI · IO · 1541** (+ VIC/SID as needed), reusing `swimlane.ts`
  (Spec 746) + flow-focus (746.13 — the main/irq/nmi flow IS the lane structure).
  The monitor's "what just happened across all subsystems" view.
```
> chis 5000
 cyc      c64-CPU        IRQ      NMI    IO          1541
 109153k  .;E5CD LDA     -        -      -           $EC2D
 109160k  →IRQ           EA31     -      $D019 r     ...
```
- `trace` (§3.3e) stays the explicit, persisted, unbounded capture for durable
  evidence; chis/bt/swimlane are the cheap on-demand replay views over the substrate.
- Perf: replaying ≤0.5 s of emulation on demand is fast (well over real-time in warp);
  no steady-state cost. Determinism: replay from a full-state checkpoint reproduces
  the exact stream (recorded inputs for the window where needed).

### 3.3i Memspace / device (Block I) — DONE v1 read-inspect (2026-06-05)
**v1 shipped (gate e2e:754 Part N, 119/119):** sticky `device c64|drive8` (alias
`dev`); on `drive8` the read verbs `r`/`m`/`d` target the 1541 CPU — `r` shows the
drive registers (`s.driveDebug()`), `m`/`d` read the drive address space via a
side-effect-free peek (`Drive1541DebugProbe.peek` → VICE `drivemem_bank_peek`, the
drivemem PEEK page table; RAM/ROM/VIA, no side effects). Default `c64`, unchanged.
**Read-inspect ONLY:** while `drive8` the edit/exec/capability/single-step verbs are
blocked with a clear message (`device c64` first) — the **1541-CPU single-step**
(`z`/`n` on the drive) is a separate Spec 612-fidelity-gated slice (no drive
single-step primitive exists yet; rushing it risks port divergence). Bank lens is
C64-only (ignored on drive8). The original decision below stands.


A sticky **device** selects which CPU the verbs (`r`/`m`/`d`/`step`/`chis`/…) target —
the C64 CPU or the 1541 drive CPU (`drivecpu.ts`, its own 6502). Word, not VICE's
`c:`/`8:` prefixes.
```
device c64        verbs target the C64 CPU (default)
device drive8     verbs target the 1541 CPU      (alias: dev)
```
Couples the Spec 753b drive memory map (stepping/dumping the drive). The status
sidebar already surfaces DRIVE 8 state.

### 3.3j Meta (Block J) — DECIDED (2026-06-03)
Only `help`. The rest of VICE's meta/utility (`~`, `print`, `radix`, `keybuf`,
`record`/`playback`, `log`) is dropped as not useful here (record/playback is the
Scenarios tab; keyboard feed is `runtime_type`).
```
help | ?   list commands CATEGORISED by the functional blocks (A-I), not a flat list
help <cmd> help for one command
```

### 3.3k Flow disassembly (Block K) — DONE v1 (2026-06-04, user idea)
Three disassemblers that show the code PATH, not just linear bytes — VICE's `d` is
strictly linear. The user's dynamic-vs-static insight, built as three commands
(`monitor-flow-disasm.ts`):
- **`sd [n]` — step+disassemble (DYNAMIC, ground truth).** Step n from PC, render
  the REAL executed path, **fold loops** (each touched address once + `xN`).
  Non-destructive — wrapped in a checkpoint save/restore (Spec 705.B) so it
  explores without advancing the machine; falls back to destructive + a notice if
  the media is dirty (can't snapshot). Truth, but only the path actually taken.
- **`df [-i] [addr] [n]` — follow-disassemble (STATIC).** Walk control flow without
  executing (addr-first, like `d`; default from PC). Follows `JMP`, descends into
  `JSR` (call stack) + returns on `RTS`, follows an indirect `JMP` via the current
  pointer, loop-guarded (visited-set → `| back to $… (loop)`). Covers unreached
  code. A conditional branch defaults to **fall-through + annotate the taken target**.
- **`df -i` — INTERACTIVE.** The static walk STOPS at each conditional branch and
  asks the path (taken / fall / both); the human resolves the ambiguity static
  analysis cannot. IDA-style guided exploration; per-session pending-walk state.
  (`b` follows taken now + notes the fall-through.) **Modal (2026-06-04):** while a
  walk is pending a bare `t`/`f`/`b` IS the choice (a `branch t/f/b>` prompt; type
  `t`, not `df t` — so it doesn't hit fill/move/break); explicit `df t|f|b` still
  works. See §3.8.

Gate `e2e:754` Part G (G1-G9): sd loop-fold + non-destructive, df JMP-follow +
JSR-descend/return + RTS-end, df -i branch-stop + resume + the bare-letter modal.
**v1.1 ideas:** `df b`
as a real tree; symbol/label annotation inline; sd loop-fold preserving exact
interleave; an "until focus then list" variant.

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

### 3.8 Live-test refinements (2026-06-04) — DONE, all on master, gate `e2e:754` 111/111
The blocks above were exercised on the live Wasteland_EF workbench; each finding
was fixed + gated the same session. The in-monitor `help` text reflects all of these.
- **Run-state sync (§3.1).** The RUN/Pause button (`liveRunState`, App-level) was
  only synced to the daemon inside the Live tab → `g` from the MON pop-out ran the
  machine but the button stayed "Run". Lifted the `debug/running|stopped|paused|
  breakpoint_hit|observer_hit` listeners to App level (`ui/src/App.tsx`) so `g`
  (or Pause) from any window/tab flips the button — no second click.
- **`d <start> <end>` is a RANGE (§3.3b).** Was a base-10 instruction count
  (`d ce00 ce08` → `parseInt("ce08",10)=NaN` → empty). Now a VICE range; an opcode
  straddling `end` is shown whole; `end<start` errors; huge ranges bounded + a
  continue hint.
- **Modal assemble (§3.3c).** `a <addr>` enters assemble mode; `.cXXX` prompt;
  empty line exits; bad line stays in mode. `MonitorResult.prompt` + `asmCursors`.
- **Observer wildcards + name guard (§3.3e).** `obs <glob> on|off|del` (`obs * del`
  = all); `*`/`?` rejected in a new observer name (reserved for the wildcard).
- **Observer break → monitor + live log (§3.3e v1.1).** `do break` now drops into
  the monitor with a `*obs <name> at $PC` banner + register dump + focus (UI
  listened for `debug/breakpoint_hit` but not `debug/observer_hit`); `do log` lines
  stream live to the console (`debug/observer_log`, drained per run-chunk) in
  addition to the pull-only `obs log`.
- **swimlane selects a TRACE (§3.3h).** Default window was the LIVE clock
  (`now-2000..now`) — empty after `trace off` (the clock runs on). Redesigned:
  `swimlane list` / `swimlane` (newest) / `swimlane <name>` / `<name> <s> <e>`;
  the default window is the last ~2000 cycles OF THE SELECTED TRACE, anchored to
  the store's own `MAX(cycle)`. Own bridge block enumerates `runtime/<session>/
  *.duckdb`.
- **taint cycle anchor (§3.3h).** `taint <addr>` with no cycle anchors to the
  trace's `MAX(cycle)` (same live-clock fix as swimlane), not the live clock.
- **TUI render + loop-fold (§3.3h).** swimlane/chis emitted a markdown table
  (pipe-noise in the console) with idle empty lanes. New `renderText` (alongside
  `renderMarkdown` for UI/MCP): space-aligned, no pipes, idle drive/IEC/IO/flow
  columns dropped, empty filler rows dropped, and consecutive loop iterations
  FOLDED (body once + `↺×N`). Fold is **flow-scoped** (key = flow + c64/drive
  PC-op shape) and **interrupt-fenced** (an IRQ/NMI block mid-loop breaks the fold
  → you see when it hit), and **keeps variation** (a polling loop's varying read
  becomes a range `$D012 r=9D..A2`).
- **df -i modal branch (§3.3k).** While an interactive walk is pending, a bare
  `t`/`f`/`b` is the branch choice (was hitting fill/move/break); `branch t/f/b>`
  prompt; explicit `df t|f|b` still works.
- **Empty-Enter repeats the last command (QoL).** Hold Enter to keep stepping
  (`n`); the modal prompts (assemble / df -i) keep their own meaning for empty.
- **What's gate- vs live-verified:** the in-process gate (`e2e:754`, 111 checks)
  covers the command logic + arg wiring + `renderText`/fold. The WS bridges
  (trace-store reads, project reads) and the UI listeners are live-tested on the
  daemon (the gate stubs the bridge). Still open: `chis`/`map`/`inspect`/`xref`/`sym`
  real output is live-only; cross-file xref = Spec 759; Block I device; bitmap;
  Spec 755 `.vsf`.

## 4. Phases
- **P1 — lifecycle + consolidate. DONE (2026-06-03).** Extracted the one canonical
  processor `src/runtime/headless/debug/monitor-shell.ts` (`runMonitorCommand`);
  `monitor/exec` is now a thin adapter; retired the dead second parser. `g`→continue,
  `g <addr>`→set-PC+continue, `x`→resume, `until <addr>`→synchronous run-to-landing;
  bounded-burst dropped. Block B (§3.3b/§3.4) landed alongside: side-effect-free
  `peek(addr,lens)` + bank-lens `m`/`d`. Closes BUG-036 + BUG-037 + BUG-038.
  Gate `e2e:754` 22/22 + `probe:single-path` 25/25.
- **P2 — VICE-parity commands. DONE (2026-06-04).** `a` inline
  assembler (`assembler6502.ts`); `sidefx` + `peek`; `wr/f/t/c/h` memory edit; `r`
  set + vectors/flow; `screen`; Block G file-IO (`load/save/bload/bsave` + fs
  mini-shell, §3.3g v1, Part K). Gate `e2e:754` Parts D+E+K (80/80). **Deferred from
  Block G:** disk `attach/detach/@` + `snap/unsnap`↔`dump/undump` rename (the `.vsf`
  codec = Spec 755).
- **P3 — capability layer + superset verbs.** Block E observers DONE (§3.3e, v1 —
  `e2e:754` Part F, 50/50). **Remaining:** the capability registry + curated verbs
  (`map/taint/inspect/xref/flow/chis/bt`/swimlane) over the unified daemon query
  core — **Q1 RESOLVED (2026-06-03): the daemon query-core reads the project
  artifacts read-only so `inspect`/`xref` are one source for UI+MCP+monitor;
  heavy producers `analyze`/`extract`/`note` stay LLM/UI** (Block F/H). Plus
  `device c64|drive8` (Block I).

## 5. Open questions (genuinely the user's call)
- **OQ1 — capability-layer breadth (the fork). RESOLVED (2026-06-03): curated only.**
  The RE-operational ops (`map/taint/inspect/analyze/extract/bitmap/flow/xref` — §3.3h)
  become monitor commands AND MCP tools over one core (the VICE binary-monitor model).
  **No** generic `!<tool>` escape over the whole tool surface — LLM-workflow tools
  (`save_finding`, `agent_*`, `project_init`) stay LLM-only.
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
