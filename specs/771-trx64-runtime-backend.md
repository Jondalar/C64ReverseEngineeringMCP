# Spec 771 — TRX64 als wählbarer Runtime-Core + VICE-Deprecation

**Status:** IN PROGRESS (Branch `spec-771-trx64-core`)
**Datum:** 2026-06-25
**Cross-link:** `../TRX64/HANDOVER.md`, `../TRX64/loop/decisions.md`
(ADR-066 Drop-in-Boundary = WS-Daemon-Prozess, ADR-053 Behavioral-Parity, ADR-087 feature-complete)

## Ziel

TRX64 (Rust-Headless-Runtime, feature-complete vs TS-Headless per ADR-087) als
**wählbaren Runtime-Backend** in c64re einbinden. Der TS-Core bleibt erhalten und
Default (golden Oracle). Die native VICE-x64sc-Runtime + alle `vice_*`-Tools wandern
hinter ein "extended"-Flag und werden als **deprecated** markiert.

## Non-Goals

- KEIN In-Process-Core-Swap. Drop-in-Grenze = der WS-Daemon-Prozess (ADR-066).
- KEINE Entfernung des TS-Cores. Bleibt Default + Oracle.
- KEINE FFI/N-API/WASM-Kopplung (spätere Option, eigene Spec; siehe Swift-UI unten).
- KEIN Entfernen der `vice_*`-Tools — nur verstecken (extended) + deprecaten.

## Architektur-Entscheidung — TRX64 bleibt eigenständig (Git: getrennte Repos + Pin)

TRX64 = eigenständiges C64-Runtime-Produkt, mehrere gleichberechtigte Frontends:

```
TRX64 (eigenes Repo Jondalar/TRX64, Rust)
  ├─ trx64-core    pure/sync/Clone, no I/O  → später Swift per FFI (cbindgen) = embedded Emu
  └─ trx64-daemon  WS JSON-RPC + binär       → c64re + Swift-App + Oracle reden alle hier
c64re (dies Repo) = EIN Consumer (C64RE_RUNTIME_BIN + WS)
```

- **Kopplung: getrennte Repos + Pin** (kein Submodule). c64re hält `C64RE_RUNTIME_BIN`
  (zur Laufzeit) + den validierten TRX64-Tag+SHA in `runtime/TRX64_VERSION` (Doku).
- **Pin = LETZTER Schritt.** Erst UI-Verprobung + Fixes; erst wenn der Stand fein ist
  → semver-style annotated Tag (`vX.Y.Z`) in TRX64 + SHA pinnen. Kein Tag auf
  wackelndem Stand. Semver-Name ja, volle Semver-Disziplin nein.
- `runtime/TRX64_VERSION`-Format: `tag: vX.Y.Z` + `sha: <40-hex>` (SHA = Anker, Tag =
  Label). Optionaler Check: `git -C $TRX64 rev-parse <tag>` == gepinnter SHA.

## TRX64-Daemon-CLI-Contract (verifiziert 2026-06-25)

`trx64-daemon` (clap):
- `--port <u16>` (default 4312)
- `--project <string>` (default "")
- `--stream` (A/V-Push an WS-Clients; auch via env `TRX64_STREAM=1`)
- **kein `--dev-samples`** → das externe Bin darf diesen Flag NICHT erhalten.

Universeller Spawn-Contract (gilt für TS- und externes Bin): `--project <dir> --port
<port>`. TS-only-Extra: `--dev-samples`. Externe-Bin-Extras: via env passthrough
(`TRX64_STREAM=1`) oder `C64RE_RUNTIME_BIN_ARGS` (space-split, angehängt).

UI/MCP attachen unverändert via `C64RE_RUNTIME_ENDPOINT` / `ws://127.0.0.1:4312`.
Port-Race (run.ts EADDRINUSE → exit 0) — TRX64 muss bei besetztem Port ebenfalls
sauber abbrechen (in Verprobung prüfen).

## 771.1 — Runtime-Backend-Selektor (`C64RE_RUNTIME_BIN`)  ← AKTIV

Ein gemeinsamer Resolver `resolveDaemonSpawn()` → `{ cmd, args, mode, warn? }` in
`src/runtime/headless/daemon/resolve-daemon-spawn.ts`. Präzedenz:
1. `C64RE_RUNTIME_BIN` gesetzt → `cmd=<bin>`, `args=["--project",dir,"--port",port]`
   (+ optional `C64RE_RUNTIME_BIN_ARGS`); **kein** `--dev-samples`. `mode="external-bin"`.
2. dist gebaut → `cmd=node`, `args=[dist/.../run.js, ...std, (--dev-samples)]`. `mode="dist"`.
3. tsx-Fallback (~12× langsamer, lauter Warn). `mode="tsx"`.

Drei Spawn-Stellen darauf umgestellt (kein Copy-Paste mehr):
1. `src/server-tools/runtime-daemon-client.ts` `spawnDaemonDetached` (MCP + lazy)
2. `scripts/workspace.mjs` (WS-Daemon-Child) — importiert den Resolver aus `dist/`
3. `ui/vite.config.ts` `ensureRuntimeDaemon` (Dev-Plugin) — importiert TS aus `src/`

**Akzeptanz 771.1:** ohne Flag = bit-identisch heutiges Verhalten; mit
`C64RE_RUNTIME_BIN=.../trx64-daemon` (+ `TRX64_STREAM=1`) → UI rendert, MCP
`runtime_*`-Tools laufen (Screenshot/Monitor/Checkpoint/Audio/Media-Mount).

## 771.2 — VICE hinter "extended" + deprecated

- Alle `vice_*`-Tools + x64sc-native-Runtime: nur sichtbar wenn extended-Flag an
  (Mechanismus = bestehende Tool-Surface-Gating, Spec 730 "default surface").
- Tool-Description prefix `[DEPRECATED]` + Hinweis "use runtime_* / TRX64".
- Default-Surface: `vice_*` raus.

**Akzeptanz 771.2:** Default-Surface zeigt keine `vice_*`; mit extended sichtbar +
deprecated-markiert; `probe-tool-surface.mjs` grün.

## Akzeptanz-Gates (gesamt)

- TS-Default-Pfad unverändert (kein Flag) → Runtime-Product-Proof grün.
- TRX64-Pfad: 7-Spiele-Gate-Äquivalent über WS grün (scramble GAME_LIVE etc.).
- `vice_*` aus Default-Surface verschwunden, unter extended deprecated sichtbar.
- Keine neue Source-Kopplung an TRX64-Repo (nur env + Doku + Version-Pin).

## Verprobungs-Reihenfolge (operativ)

1. ~~Branch + .gitignore~~ ✓  2. Resolver + 3 Stellen (771.1)  3. TRX64 release-build ✓
4. UI-Verprobung gegen TRX64 → fixen  5. 771.2 VICE-Deprecation
6. Stand fein → TRX64 semver-Tag + SHA in `runtime/TRX64_VERSION` pinnen.

## OFFENE FRAGEN

1. ~~Git-Pin~~ GELÖST: getrennte Repos, `runtime/TRX64_VERSION` (semver-Tag + SHA),
   Pin als LETZTER Schritt. Kein Submodule.
2. **Binary-Discovery:** `C64RE_RUNTIME_BIN` immer explizit (kein Auto-Suche
   `../TRX64/target/release/`). Lean = explizit.
3. **"extended"-Flag konkret:** existierender Surface-Schalter (Spec 730) vs neuer
   `C64RE_TOOLS_EXTENDED` → nach VICE-Tool-Inventur entscheiden.
4. **Default-Wechsel:** TS bleibt Default in dieser Spec; späterer Flip (TRX64 default,
   TS Oracle) = eigene Spec.
5. **Swift-UI (Zukunft):** WS-Client sofort möglich; FFI-Core (cbindgen über
   `trx64-core`) = eigene spätere Spec.
