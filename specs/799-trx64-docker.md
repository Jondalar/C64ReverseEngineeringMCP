# Spec 799 — TRX64 Docker Image (containerized emulator sidecar)

**Status:** SPIKED — §7 de-risk done on the real QNAP (native amd64): the Wasteland
EF cart boots and streams **50 fps video + 50 fps audio at ~40 % of one core / 149 MiB**,
idle 0 %. The one real unknown (NAS performance) is a non-issue. Image A1 built + loaded
on the NAS. Corrections folded in (see §7 results): the entrypoint runs the DEFAULT
streaming daemon (NOT `--headless`), and the daemon needed a `--bind 0.0.0.0` option.
Next: editor-side Play integration (§6 B/C/D).
**Repos:** cross-repo — the image + Dockerfile live in TRX64 (`../TRX64`); C64RE is
untouched (its Live tab / `ws-server.ts` framing docs serve as the reference client
spec only). The first consumer (Wasteland editor) lives outside both repos.
**Number:** 799 (shared board `specs/README.md`).
**Doctrine anchors:** Spec 771 (TRX64 = the runtime backend), Spec 787 (scoped
instances, one live machine per process), Spec 723 (single-path — untouched),
CLAUDE.md "One Machine Per Process". Consumes the daemon WS contract as-is
(Spec 310 key passthrough, Spec 701 §7 BIN_VIC framing, Spec 703 audio) —
**this spec adds packaging + a consumer contract, zero emulator/protocol work.**

---

## 1. Problem

The edit → build → test loop for cartridge projects (first case: the Wasteland
EF crack + its web editor on the NAS) is slow: edit in the browser editor,
pull/promote/build on a Mac, move the `.crt` to hardware or a local runtime.
Everything needed for an in-browser test loop already exists in TRX64:

- `trx64-daemon` streams one BIN_VIC frame per PAL frame (palette-indexed
  384×272, ~50 fps) + audio chunks over a single WebSocket, and accepts
  `session/key_down` / `key_up` / `session/joystick_set` live input plus the
  full JSON-RPC monitor (`swapcrt`, mounts, undump, …).
- The C64RE workbench Live tab proves the browser-client side of that
  protocol (canvas blit + key mapping) in ~200 lines of client logic.

What is missing is **deployment packaging**: a way to run the emulator next to
a web app on a small always-on box (QNAP NAS, any Docker host) without
hand-building Rust on that box. Hence: an official TRX64 Docker image.

## 2. Goals

1. **`wl-trx64` OCI image** built from the TRX64 repo: multi-stage Dockerfile
   (Rust builder → slim runtime), `linux/amd64` first (QNAP Container Station),
   ROMs + everything the daemon needs baked in, one exposed WS port.
2. **Sidecar architecture**: the emulator container pairs with any web-app
   container over a shared bridge network + a shared read-only media volume
   (`/play`). The consumer writes `.crt`/`.d64` files into the share and drives
   the daemon over WS. No Docker-socket access, no process spawning across
   containers.
3. **Consumer contract** (§5): a small, stable surface — mount, session
   lifecycle, input, frames — that any front-end can code against.
4. **First consumer shipped**: the Wasteland editor gets a Build button and a
   Play tab (§6) as the proving ground.

### Non-goals

- No protocol changes in `trx64-daemon` (framing, RPC names stay as-is).
- No multi-session-per-container orchestration — one container = one process
  = one live machine (Spec 787 doctrine). Scale-out = more containers.
- No public/WAN exposure; the image is LAN/compose-internal. Auth stays the
  consumer's job (the daemon WS has none — see §5.4).
- Audio playback in the browser is optional/v2 for the first consumer; the
  stream itself is already there.

## 3. Architecture

```
┌─ consumer container (e.g. wl-editor) ────┐   ┌─ wl-trx64 container ─────────┐
│ web app · auth · build pipeline          │   │ trx64-daemon --bind 0.0.0.0  │
│   writes artifacts → /play (rw) ─────────┼───┼─→ /play (ro)   (STREAMS by    │
│   /ws/play  = WS reverse-proxy ──────────┼───┼─→ :4340         default, A/V) │
└───────────────────────────────────────────┘   └──────────────────────────────┘
        same user-defined bridge network · static IPs (QNAP DHCP re-lease trap)
        /play = one host directory bind-mounted into both
```

- **One machine per container.** The daemon process owns exactly one live
  machine (CLAUDE.md rule). A consumer needing scratch instances uses Spec 787
  scratch processes *inside* that container later — out of scope here.
- **Lifecycle = session-level, not container-level.** The container runs
  permanently; an idle daemon with no running session is ~0 % CPU. The
  consumer creates a session on "play" and closes it on idle timeout — the
  known 100 %-CPU failure mode is a free-running session, not the daemon.
- **Resource caps** (`--cpus`, memory limit) go on the emulator container so a
  busy session can never starve the web app or the NAS.

## 4. Image spec (TRX64 repo deliverable)

1. `docker/Dockerfile` (multi-stage):
   - **builder**: `rust:1.x-slim`, `cargo build --release -p trx64-daemon`.
     First build is minutes; layer-cached afterwards.
   - **runtime**: `debian:stable-slim` (or distroless if the daemon is
     static-friendly), copy the binary + ROM set, non-root user.
2. **Entrypoint** (pinned by the §7 spike): `trx64-daemon --port ${TRX64_PORT:-4340}
   --bind ${TRX64_BIND:-127.0.0.1}` with `TRX64_BIND=0.0.0.0` set in the image.
   - **NOT `--headless`** — that opts OUT of the A/V push (no BIN_VIC frames), which is
     exactly the emulator VIEW the browser needs. Streaming is the default since Spec 767
     (was `--stream` opt-in in the pre-767 era this spec was drafted in). `--headless` is
     the LLM/debug/oracle mode, never the play container.
   - **`--bind 0.0.0.0`** (new daemon flag, TRX64 `main.rs`): the daemon bound `127.0.0.1`
     only → unreachable from the sibling container / host. Default stays localhost; the
     image sets `0.0.0.0`. No auth on the WS ⇒ bind wide only where the net is trusted /
     a proxy provides auth (§5.4).
   - **ROMs**: `C64RE_ROOT=/opt/trx64` → the daemon's `rom_dir()` resolves
     `/opt/trx64/resources/roms`. No `--project` needed (it defaults to "").
   - **Session bootstrap is WS-driven**, not flag-driven: the consumer sends
     `session/create` then `media/mount "/play/<name>.crt"` on Play.
3. **Ports**: one WS port (default 4340). **Volumes**: `/play` (media, ro),
   optional `/state` (checkpoints/undumps, rw).
4. **Healthcheck**: WS ping (the daemon already has ping liveness).
5. **Tags**: `wl-trx64:<git-short-hash>` + `:latest`; the consumer pins a hash.
6. **Arch**: `linux/amd64` now; `arm64` is a later flag flip (buildx).

## 5. Consumer contract

1. **Media**: write the image file into the shared volume, then
   `swapcrt "/play/<name>.crt"` (or mount RPC) over WS — the path is the
   *container-side* path, identical in both containers by convention.
2. **Session lifecycle**: create/boot session on user intent ("Play"), close
   it on idle (recommended: 10 min without a connected viewer). Reset =
   power-lifecycle primitives (Spec 786).
3. **Input/output**: BIN_VIC frames (Spec 701 §7: `[10 B header][48 B palette
   RGB][w*h indices]`) onto a canvas; `session/key_down`/`key_up` (Spec 310)
   for keys; `session/joystick_set` for WASD-style joystick. Reference client:
   C64RE `ui/src/workbench/tabs/Live.tsx` + `ws-client.ts` (read-only
   reference — consumers re-implement, they do not import).
4. **Auth**: the daemon trusts its network. Consumers MUST either keep the
   port compose-internal or reverse-proxy it behind their own auth (the
   Wasteland editor proxies `/ws/play` through FastAPI Basic-Auth).

## 6. First consumer: Wasteland editor (build + play)

Work packages (references the editor repo, listed here for the full picture):

| # | Package | Content | Est. |
|---|---------|---------|------|
| A1 | TRX64 image | §4 Dockerfile + build/push script | ½–1 d |
| A2 | Editor image | add `default-jre-headless` (KickAss) only | trivial |
| B | Build button | `POST /api/build`: copy build inputs to a **scratch tree** (`/tmp/wlbuild`), promote `editor/work` → `baseline` *there*, run `ef_build_menu.sh`, stream the log to the UI, drop the `.crt` into `/play` + offer download. **Never build inside `/data`** — the editor's autocommit worker (`git add -A`) would commit build artifacts to the data branch. | ½–1 d |
| C | Play plumbing | fixed `TRX64_WS` env, session lifecycle + idle-kill, `/ws/play` FastAPI WS proxy | 1 d |
| D | Live canvas | vanilla-JS client (~250 lines): frame decode → canvas, key map subset (letters, digits, RETURN, SPACE, cursors, F-keys, RUN/STOP), optional WASD joystick | 1–1½ d |

Total ≈ 3½–5 days. A1+B alone are already useful (build + download without a
Mac); C+D complete the in-browser loop.

## 7. De-risk spike (do first, ~1 h)

1. Build the image for amd64, run it on the QNAP, boot the current Wasteland
   `.crt`, measure fps + container CPU. **NAS performance is the one real
   unknown.** Fallback keeps the architecture: `TRX64_WS` points at a daemon
   on a Mac instead of the sidecar.
2. Pin down the daemon's minimal boot config (§4.2) and whether session
   creation is WS-driven or flag-driven.
3. Confirm container-to-container reachability on the QNAP bridge (expect
   static IPs, same as the editor's existing `qnet-static` setup).

### 7 Results (2026-07-25 — DONE on the real QNAP, native amd64)

| metric | value |
|---|---|
| video / audio | **50 fps / 50 fps** (full PAL) — vs the ≥25 fps bar |
| CPU while streaming | **~40 %** of one core (bounded, never pegs) |
| RAM | 149 MiB / 39 GiB (0.37 %) |
| idle (no client) | **0 %** CPU |
| boot | Wasteland EF boots; intro "A CLAWED PRODUCTION" renders |
| image | 88.9 MB loaded |

NAS performance — the one real unknown — is a non-issue.

**Deploy path** (Apple `container` on the Mac only emits OCI; QNAP Docker 27.1.2 uses the
classic store and `docker load` rejects OCI): `container image save --platform linux/amd64`
→ `skopeo copy --override-os linux --override-arch amd64 oci-archive:… docker-archive:…`
→ `scp` → `docker load`. Run: `docker run -d -p 4340:4340 -v <host>/play:/play:ro
wl-trx64:dev`. (For a real CI later: build natively on an amd64 box or push to a registry —
skip the conversion.)

**Boot config** confirmed as folded into §4.2 above. Container-to-container reachability:
the published port (`-p 4340:4340`) is LAN-reachable; a bridge-network + static IP works
the same for the editor sidecar.

Deliverables landed: TRX64 `docker/Dockerfile`, `docker/.dockerignore`, `--bind` flag
(commit `30fb6c3`), image `wl-trx64:dev` loaded on the NAS.

## 8. Acceptance

1. `docker run wl-trx64` on the NAS; a WS client on the LAN gets frames and
   can type — sustained ≥ 25 fps effective (50 fps target) at bounded CPU.
2. Wasteland editor: edit a tile → **Build** → **Play** → the new `.crt` boots
   in the browser canvas with working keyboard, without touching a Mac.
3. `git log` of the data branch shows **zero build artifacts** after a build.
4. Closing the play view (or idle timeout) drops the emulator container back
   to ~0 % CPU.

## 9. Open questions

1. ROM licensing/placement in a published image (private registry vs. mount) —
   irrelevant while the image stays on the LAN, decide before any publishing.
2. `arm64` build (Apple-Silicon local dev convenience) — later.
3. Browser audio (WebAudio ring on the existing BIN audio stream) — v2.
4. Does the Play tab need Spec 787 scratch instances (e.g. "test while Till
   plays")? v1: one live machine, second player waits.
