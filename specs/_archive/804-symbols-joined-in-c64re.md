# Spec 804 — Symbols are joined in C64RE

**Status:** BUILT 2026-09-19 — both halves, on `spec-804-symbols-in-c64re` in C64RE and TRX64 (unmerged)
**Repos:** C64RE (the resolver, residency, the name layers, every surface that shows a
name) + TRX64 (delivers bytes and address positions, and loses its own label machinery).
**Number:** 804, moved from `../TRX64/docs/804-symbolized-runtime.md` (2026-09-19). The
old text is in TRX64's history; its §1 inventory is carried below, re-verified.

---

## 0. The decision (owner, 2026-09-19)

TRX64 is a runtime — bits and bytes — for `trx64cli`, C64RE and the UE2 emulator. C64RE
owns meaning. So **TRX64 holds no symbols at all.** Names are joined in C64RE.

The old 804 was built on the opposite premise ("TRX64 performs the join and owns the
`build` layer"). That premise is withdrawn: *"separation of concerns wieder erreicht, der
capability-Schnitt fühlt sich wieder clean an."*

And one binding rule on top, from the same day:

> **TRX64 defines the monitor command set. C64RE only USES it** and has no command parser
> of its own — no list of verbs, no per-verb branching, no mnemonic table.

Everything below follows from those two sentences.

## 1. What exists today (verified at TRX64 `326fd6b`, C64RE `8ceb7c07`)

**TRX64 carries a whole label layer.** In `crates/trx64-daemon/src/main.rs` the monitor
verbs `label`, `unlabel`, `note`, `save_labels`/`sl`, `load_labels`/`ll` (arm at `:6942`)
write into the C64RE project: `knowledge/labels.user.json`, `knowledge/entities.json`
(`label` adds a `memory-address` entity) and `knowledge/findings.json` (`note`), via
`project_knowledge.rs:156-391`. `sym`, `inspect`, `xref` (`:6907-6931`) read
`*_analysis.json` / `*_annotations.json` through a second bridge
(`project_knowledge.rs:790-1096`). The WS methods `resolvePc` / `resolvePcs`
(`main.rs:8732-8748`) read the same files plus `*_disasm.asm`
(`project_knowledge.rs:468-779`). `user_label_index` (`project_knowledge.rs:397`) feeds
`d`, `sd` and `df` (`main.rs:4096`, `:4195`, `:4255`) through `disasm_line_ts_labeled`
(`crates/trx64-static/src/disasm6502.rs:97`).

**That layer is already broken, and not by accident.** C64RE's Spec 822.2 cut-over
(`src/knowledge-graph/cutover.ts`) moves the legacy JSON stores — `labels.user.json`
among them — into `knowledge/_legacy-822/` and folds them into the graph. A label typed
into TRX64's monitor lands in a file the knowledge side no longer reads; on the next C64RE
open the cut-over moves it away, and it disappears from TRX64's own `d`. Two owners of one
store is the defect; there is nothing to fix in either writer.

**The defects the old 804 found are all still there:**
1. `sym` and `d` disagree: `d` reads the user-label store, `sym` only the analysis JSON.
2. C64 labels leak into 1541 disassembly: `d` loads the index before it looks at
   `device drive8`. VICE has the same leak (§9); TRX64 ported it.
3. `load_labels` makes a build's `.sym` indistinguishable from hand-typed work.
4. `parse_sym_line` (`project_knowledge.rs:419`) throws the VICE memspace prefix away
   (`ci <= 1` → skip), so `C:` and `8:` cannot be told apart.

**Structured forms that exist:**
- `monitorDisasm` (`main.rs:8331` → `disasm_one`, `main.rs:8256`) returns
  `{addr, bytes, mnemonic, operand, text}` — the target of a branch/JSR/JMP is only in the
  `operand` TEXT.
- `monitorMemory` returns a bare `[u64]`.
- `session/read_memory` reads `ranges[{addr,len,lens}]` through a bank lens, C64 only.
- Trace rows (`crates/trx64-traceindex/src/rows.rs:70-120`): a CPU row carries
  `pc, opcode, b1, b2` — the executed bytes — and a write row `addr, value, oldValue, pc`.
- The checkpoint carries RAM plus `cpuPortDirection` / `cpuPortValue`
  (`trx64-core/src/c64re_snapshot.rs:1448`); the cartridge's bank and EXROM/GAME lines are
  in `session/cart_status`.
- `monitor/exec` returns `{output}` or `{error}` (+ `prompt`) — text only. Every address in
  it sits in a formatted column.

**The build side (C64RE):** `assemble_source` runs KickAssembler and 64tass without a
symbol flag (`src/assemble-source.ts:90-106`). Measured again 2026-09-19:
`java -jar KickAss.jar t.asm -o t.prg -vicesymbols` writes `t.vs` (`al C:814
.print_string`) and `t.sym` (`.label print_string=$814`); `64tass -a -B -o u.prg
--vice-labels -l u.vs u.tas` writes `al 814 .print_string`. KickAssembler exports a
`.label screen=$0400` equate; 64tass does not export `screen = $0400`.

**The graph (C64RE)** keys relocated code on its RUNTIME address and keeps the stored one
as `attrs.stored_address` / `relocated_from` (Spec 842 D4). Nodes carry `space`
(`ram` | `crt` | `drv`), `bank`, `owner`, `address`, `end_address`, `layer`
(`generated` | `human`). Generated routine/label names are the disassembler's `W<HEX4>`
(Spec 819); human names come from annotation files (routines, labels, labelled segments)
and user labels (`addr` nodes, Spec 822). Every analysed payload's
`<owner>_analysis.json` carries `codeAnalysis.instructions[].bytes` — the code bytes, by
address, of the depacked payload.

## 2. The rule: TRX64 owns the command set

C64RE neither parses nor extends the monitor. It never looks at the first token, never
branches on a verb, never carries a mnemonic table, and never reads an address out of a
formatted text column. The UI monitor and `runtime_monitor` pass the command string
through to `monitor/exec`. Two generic operations are all C64RE does to it:

**Input — names in, addresses out.** Over the raw command string, a token is
- delimited by whitespace, `,`, `(`, `)` or `=`, and outside a `"…"` quoted run;
- **not the first token** of the line;
- **not a number in the monitor's own syntax**: `$hex`, `%bin`, `0xhex`, bare hex, decimal,
  each optionally after `#`. Numeric parse wins: `a 1000 lda abc` keeps `abc` = `$0abc`;
- **exactly** (case-sensitive) a name the resolver knows for a payload that is resident
  NOW, in the monitor's current space.

Such a token is replaced by `$XXXX`. An unknown name, or a name that resolves to two
different resident addresses, is left untouched — TRX64 answers with its own error. Never
a guessed address. `a 1000 jmp LABEL1` reaches TRX64 as `a 1000 jmp $1100`.

**Output — names added, text untouched.** TRX64 returns, next to its text, the positions
where IT printed addresses (§3.2). C64RE resolves each span and inserts the name at it —
one function, the same for every verb. The numeric address always stays visible.

## 3. The TRX64 half

### 3.1 Remove the label machinery

- Monitor verbs `label`, `unlabel`, `note`, `save_labels`/`sl`, `load_labels`/`ll`, `sym`,
  `inspect`, `xref` — gone; they now answer "unknown command" like any other word.
- Every write into a C64RE project (`labels.user.json`, `entities.json`, `findings.json`).
- `user_label_index` and its use in `d` / `sd` / `df`; `disasm_line_ts_labeled`.
- The READ bridge: WS `resolvePc` / `resolvePcs`, `inspect` / `xref` / `sym`, and every
  reader of `*_analysis.json` / `*_annotations.json` / `*_disasm.asm`.
- **Kept:** the project BINDING — `active_project_dir`, `bound_project`,
  `set_project_override` (Spec 858 needs them). The module shrinks to that.
- Help text, `MONITOR.md`, the TUI completion list, `docs/wl-trx64-play-api.md`, the
  daemon tests and the conformance scenarios that exercised the verbs.
- UE2 was checked (`/Users/alex/Development/u64-emulator`): it depends on `trx64-core`
  only and calls none of these.

### 3.2 Address spans on every `monitor/exec` reply

```jsonc
{ "output": "…",                        // or "error": "…"; "prompt" as before
  "spans": [ { "line": 0, "start": 0, "end": 5, "addr": 49152,
               "space": "c64", "role": "pc" },
             { "line": 3, "start": 3, "end": 7, "addr": 49152, "len": 32,
               "space": "c64", "role": "memory", "lens": "ram" } ],
  "machine": { "device": "c64", "cpuPortDirection": 47, "cpuPortValue": 55,
               "exrom": 1, "game": 1, "cartBank": null } }
```

- `line` indexes the reply text split on `\n`; `start`/`end` are UTF-16 code-unit offsets
  in that line (what a JS `slice` takes), end exclusive.
- `space` is `c64` or `drive8` — whatever CPU the address belongs to, not the text around it.
- `role`: `pc` (an instruction's own address, the CPU's PC, a writer PC, a backtrace
  frame), `target` (a branch/JSR/JMP destination, a vector's contents), `operand` (any
  other address an instruction references), `memory` (an address shown as data: a dump
  row, a written address, a stack slot).
- `lens` only when not `cpu` (a `m ram …` row). `len` only for a range (a dump row covers
  `len` bytes from `addr`).
- **TRX64 knows the positions because it formatted them.** Formatters mark an address when
  they print it; the reply is stripped of the marks and the positions are computed at the
  one exit of `monitor/exec`. `run_monitor` for every other caller (observers, the TUI,
  internal re-entry) returns the plain text, byte-identical to before.
- **Coverage is a property of the formatter, not the verb.** Every disassembly line (`d`,
  `sd`, `df`, `chis` from the live ring, the `z`/`n`/`ret`/`sf`/`nf` landings, the `a`
  echo), `m` rows (range spans), `r` (PC + vectors), `bt` (stack slot + return address +
  flow frames), `whowrote` (address, writer PC, caller chain), `rstep`, `bk`, the `focus`
  frames. A verb with no marked formatter answers `spans: []` — never a guess; nothing
  scans the text for things that look like addresses. Text that comes from the trace
  reader (`chis` over a finished trace, `swimlane`, `taint`) is not marked: those
  surfaces carry their addresses as structured rows. `triage` and `flow` print addresses
  unmarked today; marking them is a formatter change, not a contract change.
- `machine` is the banking state residency needs: the device, the CPU port (the
  checkpoint's own field names), EXROM/GAME and the cartridge bank. Not a new store —
  read from the machine the reply came from.

`monitor/state` answers the same `machine` block without running a command (C64RE needs
the device BEFORE it substitutes).

### 3.3 Structured forms

- `monitorDisasm` gains `mode`, `target` (branch/JSR/JMP destination) and `operandAddr`
  (any other address operand). Additive; `text` is unchanged.
- `session/read_memory` takes `space: "drive8"` on a range (peek the 1541's address
  space). C64 ranges are unchanged.
- Trace rows already carry `pc` / `addr` and the executed bytes; nothing to add.

### 3.4 TRX64 acceptance

1. `grep -rn "labels.user\|entities.json\|findings.json\|_analysis.json\|_annotations.json\|resolvePc\|user_label_index\|disasm_line_ts_labeled" crates/`
   finds nothing but the two comment lines recording the removal.
2. `label`, `unlabel`, `note`, `sl`, `ll`, `sym`, `inspect`, `xref` answer
   "unknown command"; the help lists none of them; the help-dispatch gate
   (`every_verb_the_help_advertises_actually_dispatches`) is green.
3. `monitor/exec` for `d`, `m`, `r`, `bt`, `whowrote`, `rstep`, `chis` returns spans whose
   `[start,end)` slices of the reply text are exactly the printed address, with the right
   `addr`, `space` and `role`; `d` under `device drive8` returns `space: "drive8"`.
4. `run_monitor`'s text is byte-identical to the pre-804 build for the same command (the
   existing monitor tests pass unchanged, `chis` columns included).
5. `monitorDisasm` returns `target` for JSR/JMP/branches and `operandAddr` for `LDA $1234`;
   `session/read_memory` answers `space: "drive8"`.
6. `scripts/gate.sh` green; `cargo clippy` clean for the touched files; the board check green.

## 4. The C64RE half

### 4.1 Name layers, one resolver

| origin | tag | from | lifetime |
|---|---|---|---|
| `user` | `[u]` | the graph's human layer: routine / label / labelled segment nodes from annotation files, user labels | durable |
| `build` | `[b]` | assembler symbol files registered by `assemble_source` (`.vs` / `.sym`) | regenerated by every build |
| `derived` | `[?]` | the generated layer: the disassembler's `W<HEX4>` routine and label names (and data blocks). Its segment and entry nodes carry descriptors — `code_1000_1008`, `entry_1000` — which say what a range IS, not what it is called, and are not names | recomputed |

**Precedence user > build > derived** for the one name shown; the JSON carries every
candidate with its origin. Within one layer a routine outranks a label, a label a build
symbol, a symbol a data block, a data block a labelled segment (the 826.0 RESOLVES_TO
order, extended): a routine and the segment it opens are two names for one address, not an
ambiguity. Ambiguous is two DIFFERENT names of the same kind. Origin is visible on every name — `[u]`/`[b]`/`[?]` in text,
`origin` in JSON. **A derived name never counts as "named"** for Spec 848 (it already does
not: `W<HEX4>` is the default name; nothing here changes 848).

A name belongs to a PAYLOAD (a node with an `owner`, or a build's output) or to an
ADDRESS (a user label on an `addr` node, a build equate outside the build's output): a
payload name is shown only while its payload is resident (§4.2); an address name names the
address whoever is there.

Space is part of the key: the runtime space `c64` reads graph spaces `ram` and `crt`,
`drive8` reads `drv`. A VICE memspace prefix `C:` is `c64`, `8:` is `drive8`. The
C64-labels-in-the-drive leak cannot come back, because no C64 node is ever looked at for a
`drive8` span.

### 4.2 Residency — which payload is in memory at an address, right now

Decided by **bytes**, against the graph:

- The candidates are the payload names whose node covers the address in that space: the
  exact address, or the smallest named range containing it — shown as `name+$off`. A
  LISTING (the monitor, a trace row, a disassembly field) takes containment from DATA
  ranges only (data blocks, data segments), so a disassembly does not carry its routine's
  name on every line; a question about one address (`runtime_resolve_pc`) takes code ranges
  too.
- A payload's **code bytes** come from its own analysis (`codeAnalysis.instructions[].bytes`),
  shifted to the runtime address where a node records `relocated_from` (842 D4). Bytes a
  write in the same analysis targets (self-modified operands) are excluded; data is never
  compared — C64RE knows which bytes are code.
- The comparison set is the payload's code bytes nearest the address (up to 24, within
  ±256 bytes), and there must be at least 4. They are compared with live memory read
  through the span's lens (`session/read_memory`, one read per batch; `space: "drive8"` for
  the drive).
- **All equal → resident. Any mismatch, or fewer than 4 code bytes → not resident.**
- Cartridge nodes (`crt`, bank N) are candidates only while `machine.cartBank` is N.
- **No match → no name, never a wrong name.** Two resident candidates with different names
  in the winning layer → no name; the JSON says `ambiguous`.

A build name's bytes are the build output's: its analysis if one exists, else the output
PRG's bytes around the address.

**Traces — residency per row, not only at freeze.** A payload change is a run of writes into
its code range, and the trace records writes. For a row at cycle `t`, the value of a code
byte `X` is: the value of the last write to `X` before `t`; else the `oldValue` of the next
write after `t`; else — `X` was never written in the trace — any executed instruction that
covered `X` (its `opcode/b1/b2`). Between writes nothing changes, so this is exact where
the trace captured memory writes. Conflicting evidence for one byte → unknown → no name.

### 4.3 Surfaces

- **`runtime_monitor`** — substitution (§2) before `monitor/exec`; decoration (§2) after.
  Text: two FIXED columns (owner, 2026-09-19, paging through `d`: the first cut inserted
  ` <name[o]>` after the address and the longest label on a page moved every column). A
  line's own address gets a **label column** of 20 right after it — blank without a label;
  a longer name continues underneath in the same column, broken after an `_`. Every other
  name — a branch target, an operand, the names inside a dump row — goes to the
  **annotation column** from 52 on as `; name[o]`. The structured result carries every
  resolved span.
- **`runtime_monitor_disasm`** — each line's `addr`, `target`, `operandAddr` resolved; names
  appended as `; $xxxx=name[o]` without touching TRX64's text.
- **`runtime_resolve_pc`** — answered from the graph, not the daemon: the name at / around
  the PC with origin, the owning payload, the covering routine and segment, the residency
  evidence. `artifact_id` becomes an optional filter.
- **`runtime_query_events`** — every row's `pc` / `addr` resolved per row (§4.2 traces).
- **The workbench monitor** (Live tab, freeze, the MON pop-out) goes through
  `POST /api/monitor/exec` on the C64RE server — the same substitute → exec → decorate
  path. The server lays the columns out once, for every reply; the workbench gets the
  laid-out text plus marks (where each name sits, and its origin) and only colours them —
  no tags there, the colour is the origin. Numeric addresses untouched. Only when that route does not exist at all (a bare runtime UI) does it ask the
  runtime directly, without names; any other failure is reported, never retried, because
  the command may already have run.
- **`assemble_source`** asks KickAssembler for `-vicesymbols` and 64tass for
  `--vice-labels -l`, and registers `<output stem>.vs` as a `build-symbols` artifact next to
  the output — which is what the build layer reads. (Measured: KickAssembler writes
  `<SOURCE stem>.vs` next to the OUTPUT and has no flag to name it; it is moved.)

### 4.4 C64RE acceptance

1. A fixture project built through the product's own doors (analyze → disasm with an
   annotation file → assemble with symbols): the resolver names a user routine `[u]`, a
   build symbol `[b]`, a `W<HEX4>` `[?]`, and nothing at an unnamed address.
2. Residency: the same address with two payloads in the graph resolves to the one whose
   code bytes are in memory; with the bytes of neither, to no name; a relocated payload
   resolves at its runtime address; a drive-space span never gets a C64 name.
3. Against a sandbox daemon: `a <addr> jmp <label>` sent through C64RE reaches TRX64 as
   `a <addr> jmp $XXXX` (the exact string, recorded at the wire), and memory holds
   `4C lo hi`; `a <addr> lda abc` reaches TRX64 unchanged.
4. Verb-agnostic: `d` and `m` and `bt` replies are decorated by the same exported function,
   and a static scan finds no verb literal or mnemonic table in the symbols / monitor path.
5. A trace fixture where a payload is overwritten mid-trace: rows before the overwrite name
   the first payload, rows after it the second.
6. `runtime_resolve_pc` makes no daemon `resolvePc` call; nothing in `src/` calls it.
7. Gates: `npm run build`, the new smokes, the tool-surface check (regenerated),
   `npm run check:docs-current`, and the touched existing smokes.

### 4.5 A name fits its column — new projects only

The owner, looking at the monitor: "bei store eines Labels verweigere in Zukunft alles > 20
Zeichen … dann kommt es auch gar nicht mehr vor", and on which projects: "nur für neue
Projekte". Measured first on Ultima VI: 1 793 human names, 56 % ≤ 16, 80 % ≤ 20, the
longest 36 — 359 over 20, and its annotation files are re-imported on every `disasm_prg`.

- `project_init` stamps `naming.maxLabelLength: 20` into `knowledge/project.json` of a
  project it **creates**; re-running it keeps what the project had, so an older project
  never gains the rule (`src/project-knowledge/naming.ts`).
- Every door that stores a name checks the stamp: `saveUserLabel`, the graph's `nameNode`,
  and `disasm_prg` — which checks the annotations file's labels, routine names and segment
  labels **before** it renders, so a refusal writes nothing and the listing and the graph
  never disagree. The refusal names every offender with its length.
- The monitor's label column is the same number, so in a project with the rule no name
  wraps; the wrap stays for older projects and for build symbols, which are not stored.

## 5. Deliberate changes to existing output

- TRX64 `d` no longer shows `name:` lines or `; → name`: names are C64RE's, and a monitor
  opened from `trx64cli` shows numbers. That is the decision, not a regression.
- `label`/`note`/`sl`/`ll`/`sym`/`inspect`/`xref` are unknown words in TRX64.
- `runtime_resolve_pc`'s answer comes from the graph and says which payload is resident.
- `monitor/exec` replies grow `spans` and `machine`. Clients that read only `output` see no
  change.

## 6. Wire compatibility

Removing `resolvePc` / `resolvePcs` breaks one tool of an OLDER C64RE against a newer
daemon (`runtime_resolve_pc` gets "method not found"), and its monitor verbs `sym` /
`label` / … are gone; this C64RE no longer calls either. `spans` / `machine` /
`monitor/state` / `read_memory space` are additive — a NEW C64RE against an OLD daemon
still works, it just gets no spans and so shows no names.

That is a removed method, so it is wire-breaking in the one direction: the epoch should move
`trx64-runtime/1` → `/2` in lockstep with C64RE's `EXPECTED_RUNTIME_PROTOCOL`, and the
product version 0.8.0 → 0.9.0 (0.x → minor for features/breaking). Neither is done on the
branch — both are release decisions.

## 7. Not in this spec

- **The gate "an executed JSR/JMP target without a name ⇒ the pipeline is not done"** — an
  idea for a later spec.
- **Spec 720** (heuristic role names). The `derived` layer can take them; 720 is not built.
- **Structure over symbols** — types, widths, records, `party[0].hp`.
- Snippet assembly and linking against a build (old 804 §7).
- Resolution inside text TRX64 renders from the trace reader (`swimlane`, `taint`, `chis`
  over a finished trace) — those rows are structured and named there.
- **A "name this address" door.** TRX64's `label` verb was the only one; it goes, and C64RE
  gets no monitor verb in its place (C64RE parses none). Naming happens where it always
  landed in the end — annotation files, imported by `disasm_prg` — and the graph's
  `saveUserLabel` door has no MCP tool or workbench affordance yet. A click-to-name on a
  span in the workbench monitor is the obvious follow-up.

## 8. What was built (2026-09-19)

Both halves, on `spec-804-symbols-in-c64re` in both repos (unmerged).

**TRX64.** `project_knowledge.rs` is the Spec 858 binding and nothing else (1264 → 74
lines); the eight knowledge verbs, `resolvePc`/`resolvePcs`, `user_label_index`,
`disasm_line_ts_labeled` and the three conformance scenarios that exercised them are gone.
`crates/trx64-daemon/src/addr_spans.rs` carries the marks, the one stripping exit and
`pad_right` for the one formatter that pads a marked line (`chis`). `disasm_line_ts_spans`
(trx64-static) is the formatter every listing uses; its text equals `disasm_line_ts` for
all 256 opcodes (a test). `monitor/state`, the `monitorDisasm` fields and
`read_memory space:"drive8"` as specified.

**C64RE.** `src/symbols/` — `layers` (the three layers), `payload-bytes` (code bytes by
runtime address), `resolver` (precedence, residency, ambiguity, one memory read per batch),
`monitor-names` (tokenize/substitute, `decorateText`, the whole path), `structured`
(names on numeric fields), `trace-bytes` + `trace-rows` (the per-row timeline, two
`safeQuery` calls through the runtime), `resolve-pc`, `live-bytes`, `sym-file`. The
workbench route is `src/workspace-ui/monitor-names-route.ts`; the MonitorPanel renders a
name at its span.

**Gates.**
- TRX64 `scripts/gate.sh`: clippy non-blocking backlog 402 warning-lines (none in a
  changed hunk — checked hunk by hunk; the new files have none), unit gates 13 suites /
  154 tests, daemon suite 396 tests, 7-game gate 7/7 PASS — GATE GREEN (59 s; the WS
  conformance step SKIPs as unreachable, as on main: its TS oracle is deleted). A fresh
  worktree needs the gitignored `traces/` dir or the 7-game gate cannot write its PNGs.
  Board check green. New tests:
  8 daemon (spans for d/m/r/bt/whowrote/rstep/chis/drive8, `monitor/state`, the structured
  fields, the knowledge verbs gone), 4 `addr_spans`, 3 `disasm6502`.
- C64RE: `smoke-804-resolver` 42/0 (fixture built through `project_init` → `analyze_prg` →
  annotations + `disasm_prg` → `assemble_source`; residency, relocation, build layer,
  ambiguity, substitution, decoration, the static no-verb scan, a synthetic overwrite
  trace), `smoke-804-monitor` 25/0 (a sandbox runtime behind a recording relay: `a 1100 jmp
  set_border` reached it as `a 1100 jmp $1010` and the machine held `4c 10 10`; `a 1103 lda
  abc` arrived unchanged; a REAL trace where a copy loop overwrites alpha with beta names
  the two `$1010` rows `set_border[u]` then `set_background[u]`; the workbench route),
  `smoke-859` 11/0, `smoke-860` 14/0, `e2e-843` 40/0 (against the TRX64 worktree source),
  `e2e-839-media` 43/0, `e2e-741` 13/0, `check:docs-current`, `check:runtime-invisible`
  (83 surfaces), `check:822-no-json-readers`, `check:esm-require`, the tool-surface
  inventory regenerated (288 tools, `--check` green), `check:ui-mcp-delta` green against the
  TRX64 worktree (one allowlist entry retired: C64RE now reaches `session/read_memory`).
  `probe-tool-surface` is red on two checks that were red before this branch and name none
  of the tools it touched.

**After the first look in the workbench (2026-09-19).** The monitor layout became the two
fixed columns of §4.3 (label 20, annotation from 52; a longer name wraps inside its
column), laid out once on the server with marks for the workbench to colour; and §4.5's
naming rule. `smoke-804-resolver` 45/0, `smoke-804-monitor` 25/0, `smoke-804-naming` 11/0
(new, in CI: a project created now refuses a 22-character name at `saveUserLabel`,
`nameNode` and `disasm_prg` — before any listing is written — and stores 20; a project
without the stamp stores 22 as before). `test:project-knowledge`, `e2e:844-slots`,
`e2e:844-teeth`, `e2e:845-model`, `e2e:846-critic`, `e2e:847-docs`, `e2e:848-contract`
green.

## 9. Background — how VICE does it (VICE 3.10 `src/monitor/`)

One flat table per CPU keyed `(memspace, 16-bit addr)`, with no notion of bank, `$01` or
content. A label file is a replayed monitor script (`al C:xxxx .name`; ACME `name = $x`);
there is no `.dbg` parser. Multiload is manual — `cl` then `ll` per overlay; otherwise stale
labels persist and the newest name wins. Labels survive reset, autostart and snapshot load,
and are not in snapshots. Operand lookup is hard-coded to the computer memspace, so drive
disassembly shows C64 labels — the leak TRX64 ported. The binary remote protocol exposes no
labels. Everything that makes a name trustworthy here — the payload it belongs to, whether
it is in memory, where it came from — has no place in that model.
