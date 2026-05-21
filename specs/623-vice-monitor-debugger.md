# Spec 623 — VICE-compat monitor / debugger for the headless runtime

Status: DRAFT (2026-05-21). P0 subset shipped (commit "UI monitor
debugger: real disasm + breakpoints + step over/into").

## 0. Goal

A faithful **VICE built-in monitor** for our headless runtime, driven from
the workspace UI `MonitorPanel` (and the MCP/WS `monitor/exec` route). It
must behave like VICE's text monitor so muscle-memory + docs transfer 1:1,
and so we can step the *real* UI session (the one the user sees) instead of
mismatched standalone repros. This is the in-process equivalent of VICE's
`src/monitor/` — NOT the binary-monitor protocol (that is the separate
`vice_*` MCP toolset; see `monitor_binary.c`).

Source of truth = VICE 3.x `src/monitor/`:
- `monitor.c` (97k) — monitor loop, dispatch, checkpoint registry, the
  `mon_*` API, `mon_instructions_step/next`, `mon_jump/go`.
- `montypes.h` — `REG_ID`, `MEMORY_OP {load=1,store=2,exec=4}`,
  `MON_ADDR` (`memspace<<16 | location`), `CONDITIONAL`, `RADIXTYPE`,
  `MEMSPACE`, `cond_node_t`, `exit_mon`.
- `mon_breakpoint.{c,h}` — `mon_checkpoint_t` + the checkpoint API.
- `mon_command.c` — the 103-entry command table (name + abbrev + help).
- `mon_disassemble.c`, `mon_memory.c`, `mon_register*.c`, `mon_file.c`.
- `mon_parse.c` / `mon_lex.c` — bison/flex grammar (we do NOT port the
  generated parser; we hand-roll a tokenizer for the subset we expose).

## 1. Data model (port to TS, names verbatim per Spec 612 spirit)

### 1.1 Address / memspace (`montypes.h:113-228`)
- `MEMORY_OP`: `e_load=0x01, e_store=0x02, e_exec=0x04` — a checkpoint's
  op-mask. exec-only = breakpoint; load/store = watchpoint.
- `MON_ADDR = (memspace << 16) | location`. Memspaces: main / drive8..11.
  Our headless has c64 + drive8; map memspace → which CPU/bus.
  Helpers: `addr_memspace`, `addr_location`, `new_addr`.
- `RADIXTYPE` (hex default), `default_radix`, `dot_addr[memspace]`
  (the "current" address `.` per memspace).

### 1.2 Checkpoint (`mon_breakpoint.h:38-53`) — the full model
```
mon_checkpoint_t {
  checknum;                 // stable id, monotonically assigned
  start_addr, end_addr;     // MON_ADDR range (end==start for single)
  hit_count, ignore_count;  // ignore N hits before stopping
  condition;                // cond_node_t* (e.g. "if A == $80")
  command;                  // monitor command string run on hit
  stop;                     // stop emulation vs just trace/print
  enabled;
  check_load, check_store, check_exec;  // op-mask
  temporary;                // auto-delete after first hit (until)
}
```
Our current `monitorBreakpoints: Map<sessionId, Set<number>>` is the
degenerate case: `{exec-only, stop, enabled, no range/cond/cmd}`. The port
replaces it with a per-session `mon_checkpoint_t[]` + a fast lookup index.

### 1.3 Check hook (`mon_breakpoint.c` `mon_breakpoint_check_checkpoint`)
VICE calls this from the CPU (exec) and memory (load/store) on every
relevant access: `(mem, addr, lastpc, op) -> bool stop`. It walks
checkpoints whose op-mask matches, range contains `addr`, `enabled`, passes
`condition`, and `ignore_count==0`; increments `hit_count`; runs `command`;
returns whether to halt. Our `session.runFor(n,{breakpoints})` currently
only does exec==Set.has(pc). The port needs:
- exec check at instruction fetch (have it).
- **load/store check** wired into `c64Bus`/drive bus accesses (watchpoints).
- condition eval + ignore/hit counts + on-hit command.

## 2. Command surface (`mon_command.c`, 103 cmds) — phased

Abbrev in (). **P0 = shipped.** Mark each as we land it.

### P0 — shipped (this session)
- `r`/`registers` — show regs. `m`/`mem <a> [b]` — memory dump.
- `d`/`disass [a] [n]` — real disasm (`disasm6502.ts`), `$addr  bb bb bb
  MNEMONIC ops`, PC-marked.
- `bk`/`break [a]` — exec breakpoint set/list; `bk -<a>` del; `bk clear`.
- `g`/`goto [a]` — run until breakpoint. `z`/`step` — step into.
  `n`/`next` — step over (JSR→return). `reset`.

### P1 — debugger core (next)
- Full `mon_checkpoint_t`: `break <a> [b]` ranges; `watch`/`w` (load/store
  watchpoints); `trace`/`tr` (non-stop logging); `until`/`un <a>` (temp bp);
  `delete`/`del`, `enable`/`en`, `disable`/`dis`, `ignore <n> [count]`,
  `condition`/`cond <n> if <expr>`, `command <n> "<cmd>"`.
- `r <reg>=<v>` register assignment; `return`/`ret` (run to RTS);
  `cpu` memspace/CPU switch; `bank <name>` (banked memory view — needed so
  `d`/`m` can see ROM/RAM under I/O, currently raw RAM only).

### P2 — memory editing + search
- `a <addr> <asm>` assemble (needs an assembler — out of scope unless
  reused from pipeline); `>`/fill `f`, `hunt`/`h`, `compare`/`c`,
  `move`/`t`, `memchar`/`mc`, `memsprite`/`ms`, `screen`/`sc`, `io`,
  `i`/`ii` (petscii/screencode mem).

### P3 — symbols / files / misc
- labels: `al`/`dl`/`ll`/`sl`/`shl`/`cl` (symbol table → annotate disasm).
- `load`/`save`/`bload`/`bsave`/`dump`/`undump`, `attach`/`detach`.
- `bt`/backtrace, `chis`/cpuhistory, `sw`/stopwatch, `print`/`p`,
  `radix`/`rad`, `sidefx`/`sfx`, `keybuf`, `warp`.

## 3. Architecture (where it lives)

- `src/runtime/headless/debug/disasm6502.ts` — DONE. Self-contained 6502
  disassembler (full 256-opcode table incl. undocumented). No pipeline dep.
- `src/runtime/headless/debug/monitor.ts` — NEW (P1): the `mon_*` core —
  checkpoint registry (`mon_checkpoint_t[]` per session), `addCheckpoint`,
  `checkCheckpoint(mem,addr,lastpc,op)`, condition eval (`cond_node_t`),
  step/next/return, a small tokenizer + command dispatch table mirroring
  `mon_command.c`. The WS `monitor/exec` becomes a thin adapter calling it.
- `src/workspace-ui/v3-ws-server.ts` `monitor/exec` — currently holds the
  command logic inline (P0). Migrate into `monitor.ts` so it is reusable
  (MCP tool + tests), and so watchpoints can hook the bus.
- Integration points already present:
  - `session.runFor(n, { breakpoints: Set<number> })` — exec stop.
  - `session.c64Cpu` (pc/a/x/y/sp/p/flags/cycles), `session.c64Bus.ram`,
    `session.c64Bus.read(addr)` (banked).
  - drive: `session.kernel.drive1541.diskunit` (drive8 memspace).
- Frontend `ui/src/v3/components/MonitorPanel.tsx` — already routes typed
  commands to `monitor/exec`; `.wb-monitor-out` is `white-space: pre`
  monospace so column padding renders.

## 4. Watchpoint wiring (the one real new hook)

Exec breakpoints work via the runFor loop. Load/store watchpoints need the
memory bus to call `checkCheckpoint(mem, addr, lastpc, e_load|e_store)` on
each access and signal a halt to the run loop. Options:
1. A bus read/write tap (like the existing `enableBusAccessTrace` /
   `busAccessProducer` path) gated to active watchpoint addresses, setting
   a `pendingBreak` flag the runFor loop checks each instruction.
2. Reuse the drive store-hook pattern proven in the LNR investigation
   (`cpud.store_func_ptr` wrap) for the drive side.
Keep it cheap: only install the tap when ≥1 watchpoint exists.

## 5. Acceptance

- P0: `d`/`m`/`r`/`bk`/`g`/`z`/`n` match VICE output shape; disasm
  byte-identical mnemonics vs `pipeline/lib/mos6502` on a fuzz sweep.
- P1: set an exec bp + a store watchpoint on `$d020`; `g`; verify it halts
  at the write with correct `lastpc`; `cond`/`ignore`/`until` behave per
  VICE; `r pc=$xxxx` + `return` work.
- Cross-check a real session: boot LNR in the UI, `bk 0899`, `g`, then
  `n`/`z` through the intro decision (the use case that motivated this).

## 6. Non-goals

- The bison/flex grammar (`mon_parse.c`) — we hand-roll the subset.
- Z80/6809/65816 CPUs, c64dtv extra regs — 6510 + 1541-6502 only.
- The binary-monitor protocol (`monitor_binary.c`) — separate `vice_*`
  toolset already covers external x64sc.
