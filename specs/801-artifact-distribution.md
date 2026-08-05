# Spec 801 — Artifact distribution: ROM-less image, tag-driven publishing, registries

**Status:** PROPOSED
**Repos:** cross-repo — TRX64 primary (Dockerfile, release workflow, ROM helper); C64RE
follows later for its own artifact (§C.4, deferred).
**Number:** 801 (shared board `specs/README.md`).
**Builds on:** Spec 799 (the containerized sidecar + its consumer contract) and Spec 800 §E
(one product version for the workspace, surfaced at `--version` / start log / `ping` /
image tag). This spec is what turns that version number into something you can *fetch*.

---

## 1. Problem

Getting a build onto the machine that runs it is a manual chain, executed by hand:

```
Mac (arm64)  →  container build --arch amd64  →  OCI tarball
             →  skopeo copy (OCI → docker-archive, --override-os/--override-arch)
             →  scp 92 MB  →  docker load  →  docker stop/rm/run
```

Consequences, all observed:

1. **It is done by hand, twice in one day** (image 0.1.0 + the `/dumps` volume). Every step is
   a chance to deploy the wrong thing.
2. **No traceability.** Nothing links the running container to a commit. `wl-trx64:dev` sat on
   the NAS for 11 days; only the Spec 800 version bump made "which build is this?" answerable
   at all — and only for builds made after it.
3. **A second machine has to build from source.** The Windows box (Mike) needed the Rust
   toolchain *and* a C++ compiler for reSID, then hit the `.exe` resolver gap. A published
   binary would have replaced that entire session with a download.
4. **The cross-compile detour exists only because the build host is arm64.** A native amd64
   builder removes `skopeo` and the OCI→docker-archive conversion outright.

And one hard blocker sits in front of any registry: **the image bakes the Commodore ROMs**
(`COPY docker/roms`, a gitignored directory). Publishing that image publicly would distribute
third-party IP.

## 2. Goals

1. **A tagged build publishes itself**: push `v<version>` → the container image and the
   per-platform binaries are built and published, each traceable to that commit.
2. **The consumer pulls.** The NAS (and any future host) runs `docker pull`; the
   save/convert/scp chain is deleted, not automated.
3. **The image carries no third-party IP** — ROMs come from the operator, once.
4. **A fresh machine is a download**, not a toolchain install (Windows/Linux/macOS binaries).

### Non-goals

- **NOT reintroducing CI as the quality gate.** `scripts/gate.sh` remains the authority
  (Spec 783); the release workflow runs on a **tag**, not on every push, and does not
  duplicate or replace it. The "no cloud CI" decision was about gating and stands.
- **No crates.io.** Per Spec 800 §E the workspace crates are never consumed separately;
  publishing them would be bookkeeping with no consumer.
- **No auto-deploy.** The workflow publishes; a human (or a later, separate step) decides when
  a host pulls. Nothing on the NAS is touched by a push.

## 3. The decision that unlocks everything: public vs private image

Both solve the actual pain (pull instead of scp). They differ in what they cost:

| | public GHCR | private GHCR |
|---|---|---|
| ROMs in image | **impossible** (third-party IP) | allowed |
| Consumer setup | `docker pull`, no auth | `docker login` with a PAT |
| Storage | free / unlimited | counts against the account's package quota — at ~89 MB/version only a handful live at once, old ones must be pruned |

**Chosen: public, ROM-less.** It is the cheaper steady state (no quota gardening, no token on
the NAS), and the ROM split is desirable on its own terms — the artifact stops carrying
someone else's property, which also makes it shareable with Mike without a second thought.

## 4. Design

### 4.1 §A — ROM-less image + operator-supplied ROMs

- **Dockerfile**: drop `COPY docker/roms /opt/trx64/resources/roms`. Nothing else changes —
  `rom_dir()` already probes `C64RE_ROOT/resources/roms` first, so a mounted volume lands in
  the path the daemon already looks at. **No code change.**
- **Run shape** gains one mount:

  ```
  -v <host>/wl-roms:/opt/trx64/resources/roms:ro
  ```

- **Seeding is a ONE-TIME step, and normally not a download at all.** An operator who already
  owns a ROM set copies it in once (six files, ~68 KB):

  ```
  ssh <nas> 'mkdir -p /share/Container/wl-roms'
  scp resources/roms/*.bin <nas>:/share/Container/wl-roms/
  ```

  Offline, deterministic, and no third party is involved.
- **`scripts/fetch-roms.sh <dest>`** (new, opt-in) for the *other* case — a fresh machine with
  no ROM set (a new host, a runner smoke test). The source is a parameter/env with **no
  default**: the tool ships the mechanism, the operator chooses the source. Explicitly a
  one-shot command, **never the container entrypoint**: booting a C64 must not depend on an
  external host being reachable or a URL still existing.
- **Failure mode must be legible.** With no ROMs the daemon cannot boot; it must say so with
  the mount hint, not fail with `PC=$0000`.

### 4.2 §B — the release workflow (TRX64, tag-triggered)

`.github/workflows/release.yml`, triggered by `push: tags: v*` (plus `workflow_dispatch` for
a dry run). Public repo ⇒ GitHub-hosted runners are free.

| job | runner | produces |
|---|---|---|
| `image` | `ubuntu-latest` | `linux/amd64` image → GHCR. **Native** — no cross-compile, no skopeo, no OCI conversion |
| `binaries` | matrix: `ubuntu-latest`, `windows-latest`, `macos-latest` | `trx64-daemon` + `trx64cli` per platform → attached to the GitHub Release |

Mechanics worth pinning down:

- **Auth**: the automatic `GITHUB_TOKEN` with `permissions: packages: write` pushes to GHCR.
  No secrets to create, rotate, or forget — the usual reason this kind of automation rots.
- **Tags on the image**: `ghcr.io/<owner>/wl-trx64:<version>` **and** `:latest`. `<version>`
  comes from the git tag and must equal `[workspace.package] version` — the workflow
  **verifies** this and fails on a mismatch, so a tag can never publish a differently-numbered
  build (Spec 800 §E's whole point).
- **Provenance**: stamp the commit SHA into the image's OCI labels alongside the version.
- **Windows**: this job is what makes `trx64-daemon.exe` exist without a toolchain — the exact
  gap that cost a session. Pair it with the `.exe` resolver support already in C64RE.
- **The workflow does not gate.** It builds what a human already tagged; `gate.sh` decided
  whether that commit was fit to tag.

### 4.3 §C — registries, per artifact

| artifact | registry | verdict |
|---|---|---|
| container image | **GHCR** (`ghcr.io`) | the core of this spec |
| daemon + CLI binaries | **GitHub Releases** | the fresh-machine path |
| Rust crates | crates.io | **no** — no separate consumer (Spec 800 §E) |
| C64RE MCP server | npm | **deferred** (§C.4) |

**§C.4 — C64RE/npm is a separate, weaker case.** C64RE runs from a checkout via `tsx`; there
is no consumer asking for `npx c64re-mcp` today, and publishing would add a release surface
that solves nothing currently painful. Revisit only when someone needs to run C64RE without
cloning it. The two repos publish *different kinds of artifact*; that — not "Rust vs npm" — is
why TRX64 gets registries first.

### 4.4 §D — consumer side (the NAS sidecar)

The run command becomes, with the two existing volumes plus ROMs:

```
docker pull ghcr.io/<owner>/wl-trx64:<version>
docker run -d --name wl-trx64 --restart unless-stopped \
  --network <bridge> --ip <static-ip> \
  -v <host>/wl-play:/play:ro \
  -v <host>/wl-dumps:/dumps \
  -v <host>/wl-roms:/opt/trx64/resources/roms:ro \
  -e TRX64_BIND=0.0.0.0 \
  ghcr.io/<owner>/wl-trx64:<version>
```

Pin the **version**, not `:latest`, so a redeploy is a deliberate act and the running build is
identifiable — `ping` then reports the same number (Spec 800 §D/§E).

## 5. Acceptance

1. `git tag v<version> && git push --tags` → the image appears on GHCR and the binaries on the
   Release, both carrying that version + the commit SHA.
2. A tag whose number differs from `[workspace.package] version` **fails** the workflow.
3. The published image contains **no** ROM files; started without the ROM mount it refuses to
   boot with an actionable message naming the mount.
4. The NAS runs the published image, pulled — no `save`/`skopeo`/`scp`/`load` anywhere — and
   `ping` reports the tagged version.
5. A Windows machine runs `trx64-daemon.exe` from the Release with no Rust toolchain installed.
6. `scripts/gate.sh` is unchanged and remains the merge/tag gate.

## 6. Open questions

1. **Multi-arch image?** `linux/arm64` alongside `amd64` (the NAS is amd64; an Apple-Silicon
   host running the container natively would want arm64). Cheap to add later via a build
   matrix — decide when a consumer exists.
2. **Release notes**: generated from commits, or hand-written per tag?
3. **Pruning**: `:latest` plus the last N versions on GHCR, or keep everything (public storage
   is free, so "keep" is defensible)?
