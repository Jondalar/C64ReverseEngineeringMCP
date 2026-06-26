# Spec 772 — Checkpoint-Ring: Cadence + Retention (UI-scrub-sized)

**Status:** PROPOSED
**Datum:** 2026-06-26
**Cross-link:** Spec 705.B (checkpoint ring), Spec 766 (recorder = deep history),
Spec 769 (time-travel/scrub), Spec 769.5a (filmstrip thumbnails).

## Entscheidung (User, 2026-06-26)
Der Checkpoint-Ring ist für die **UI-Scrub-Filmstrip** dimensioniert, nicht für
Tiefen-Historie:
- **Cadence: alle 0,5s** = `CHECKPOINT_CAPTURE_EVERY_FRAMES = 25` (PAL 50fps).
- **Retention: 10s** = **20 Snapshots** (= 20 Thumbnails in der Scrub-Bar).
- **Parametrierbar** (env), nicht hartkodiert.

Tiefen-Historie (LLM-Rewind/Cheat-Finder/Debug) läuft NICHT über den Ring, sondern
über den **Recorder (Spec 766)** — der Ring bleibt der kurze Live-Scrub-Puffer.

## Warum
Heute: Cadence 1s (TS) / 0,5s (TRX64 — Divergenz!), Budget 32 MiB → ~512 Einträge →
**~8,5 min** gehalten. Für die UI massiv overkill; 10s reichen. 20 Snapshots ≈ ~1,3 MB
statt 32 MiB. Löst nebenbei die TS↔TRX64-Cadence-Divergenz (beide → 25).

## Parameter
- `C64RE_CHECKPOINT_CADENCE_FRAMES` — default **25** (0,5s @ 50fps). Steuert
  `CHECKPOINT_CAPTURE_EVERY_FRAMES`.
- `C64RE_CHECKPOINT_RING_SECONDS` — default **10**. Der Ring hält
  `ceil(seconds / (cadenceFrames/50))` Einträge = bei 10s/25 → **20**. Evict-oldest
  über dieser Anzahl (pin-exempt, wie bisher). Das Byte-Budget (32 MiB) bleibt als
  sekundäre Sicherung — Eviction bei „whichever-first".

## Wo implementieren
**TS (Autorität):**
- `src/runtime/headless/debug/runtime-controller.ts:77` — `CHECKPOINT_CAPTURE_EVERY_FRAMES`
  50 → 25, env-gesteuert (`C64RE_CHECKPOINT_CADENCE_FRAMES`).
- Ring-Impl (`runtime-checkpoint-ring.ts`, `DEFAULT_CHECKPOINT_RING_BUDGET_BYTES`) —
  einen **max-entries-Cap** (aus `C64RE_CHECKPOINT_RING_SECONDS` + Cadence abgeleitet)
  zusätzlich zum Byte-Budget; evict-oldest auf whichever-first.
- `runtime-controller.ts:182` `MAX_THUMBS = 1024` — auf die Ring-Größe ausrichten (kein
  Sinn 1024 Thumbs zu halten wenn der Ring 20 hält); Thumbs mit dem Ring-Eintrag
  evicten.

**TRX64 (matcht):**
- `crates/trx64-daemon/src/main.rs:9261` — `CHECKPOINT_CAPTURE_EVERY_FRAMES` (schon 25;
  env-gesteuert machen, gleicher Name).
- `crates/trx64-core/src/checkpoint_ring.rs:46` — `DEFAULT_CHECKPOINT_RING_BUDGET_BYTES`
  + den max-entries-Cap (gleiche Ableitung), evict-oldest auf whichever-first.
- Der Thumb-Store (B7c, `checkpoint_thumbs` + `MAX_THUMBS`) auf die Ring-Größe.

## Akzeptanz (differential gate)
- Conformance-Case: nach ~12s `--stream` free-run hält der Ring **~20** Einträge (nicht
  ~24+), `checkpoint/list`-count TS ≡ TRX64; `checkpoint/thumbnails`-count = list-count.
- Default-Verhalten ohne env = 0,5s / 10s / 20.
- env-Overrides greifen auf beiden Runtimes identisch.
- Recorder-Tiefenhistorie (766) unverändert.

## Out of scope
- Recorder-Retention (separat, Spec 766).
- Die Framebuffer-omit-Anchor-Größe (BUG-049, unverändert).
