# Spec 806 — Retire the TS emulator and VICE from the product

**Status:** READY 2026-08-12 — decided, phase 1 in progress.
**Repo:** C64RE. **Supersedes** the binding half of Spec 723 when it lands.

---

## 1. The decision

**`ts-emulator` and `runtime/vice` disappear from the released C64RE.** How is
open — deletion, or a branch that keeps them referenced somewhere for VICE
testing. What is not open: they are gone from the product.

## 2. Why now

The runtime backend has been TRX64 since Spec 771. The TS emulator was kept as a
"fallback and parity oracle", and the cost of keeping it is no longer theoretical:

- **It misleads by existing.** Twice in two days a question about "the runtime"
  needed a detour to establish whether a file was the product or the oracle, and
  once it was answered from the wrong one. 189 files now carry a `DEPRECATED`
  banner for exactly this reason — a banner is a symptom, not a fix.
- **The oracle has nothing left to check.** The monitor port audit (2026-08-11)
  compared 87 TS verbs against 97 Rust ones and found the Rust side ahead; the
  drive is proven by `drive_sector_read` and seven booting titles; TRX64 carries
  its own gates (Spec 783). Parity was the reason to keep it, and parity is done.
- **VICE is already off the RE surface by doctrine** (retired 2026-07-15), yet
  `src/runtime/vice/` is still imported by `server-tools/vice.ts` and five
  scripts, including a 27 KB binary-monitor client.

## 3. Order (each step green on its own)

**Phase 1 — the structural cut (prerequisite).** Non-emulator code moves OUT of
`src/runtime/headless/`, so that what remains is entirely the thing being retired.
Today the split runs *through* the directories, not between them: `trace/` holds
both the TRX64 capture reader (Spec 784/785 work) and TS-emulator bus tracing;
`media/`, `inspect/`, `vsf/` and `export/` are likewise mixed. Target:

```
src/runtime/      the TRX64 capsule and nothing else
src/trace/        capture read + store, backend-neutral
src/media/        neutral format/path helpers
src/ts-emulator/  what is being retired — the name says it, the banner becomes redundant
```

**Phase 2 — cut the reachability.** The `!isDaemonMode()` branches
(`runtime_monitor` and friends), `workspace-ui/ws-server.ts`'s top-level import of
`monitor-shell`, and `C64RE_RUNTIME_TS`. A tool that cannot reach it is most of
the way to not having it.

**Phase 3 — remove.** `ts-emulator/` and `runtime/vice/` leave the product tree.
Whatever is kept for VICE testing is kept somewhere that is not shipped.

**Phase 4 — doctrine.** Spec 723 (single-path) governs the TS runtime: it retires
with its subject. `DOCTRINE.md` §"Still binding" loses its first section, and
`scripts/probe-single-path.mjs` goes with it. The one-machine-per-process rule
stays — that is about TRX64 and is unaffected.

## 4. Open

- **What VICE testing still needs.** `server-tools/vice.ts` + 5 scripts use
  `runtime/vice/`. Establish whether any of it is still exercised before deciding
  between a branch and deletion.
- **What else asserts TS-runtime invariants.** `probe-single-path.mjs` is known;
  the e2e scripts need a sweep.

## 5. Non-goals

- No change to TRX64. This is C64RE shedding a second implementation.
- No behaviour change in phase 1 — moves and imports only.
