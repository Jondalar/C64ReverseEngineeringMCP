# Spec 716 - Installation, Versioning, and Distribution

**Status:** DRAFT  
**Owner:** Runtime / product infrastructure  
**Scope:** Installation and distribution documentation only; no emulator-fidelity or feature work  
**Depends on:** Current GPL licensing and committed runtime assets (`README.md`, `LICENSE`, `package.json`, committed reSID WASM)  
**Deliverable:** A root-level `INSTALL.md` next to `README.md`, plus an explicit versioning and npm-publication decision

## 1. Problem

C64RE is now presented as an MCP server, runtime, and browser workbench, but
installation is still documented as a short source-checkout snippet in the
README. That is insufficient for an external user or a fresh LLM session:

- macOS, native Windows/PowerShell, Windows/WSL, Linux, and container use are
  materially different launch environments;
- MCP host configuration needs platform-correct command/path examples;
- the committed reSID WASM means normal users do **not** need Emscripten, while
  maintainers changing the SID source do;
- the project already declares `version: 0.1.0` but has no stated release
  policy;
- an npm registry installation is not yet a supported product surface because
  the package currently has no `bin`, no `engines`, no publish allowlist, and
  no proven package-install smoke.

The installation surface must become deliberate before runtime/monitor/rewind
work makes the product wider and harder to package later.

## 2. Decision Summary

### 2.1 Documentation

Create `INSTALL.md` at repository root. Use uppercase to match `README.md`,
`PLAN.md`, and `LICENSE`.

`README.md` remains product-facing and retains only:

- a short quick-start;
- a link to `INSTALL.md` for full setup, MCP-host configuration, container use,
  and troubleshooting.

### 2.2 Versioning

Introduce formal semantic versioning now.

- Keep the current line in the `0.x` range while APIs, checkpoint formats, and
  runtime/monitor features remain in active development.
- Treat minor versions (`0.2.0`, `0.3.0`) as potentially breaking until
  `1.0.0`, but document incompatibilities in release notes.
- Treat patch versions as fixes that do not intentionally change public MCP
  tool schemas, `.c64re` format compatibility, or command-line invocation.
- Add a single authoritative version surface: `package.json` plus release tag
  `v<package-version>`.
- The first documented install baseline may remain `0.1.0`; this spec does not
  require publishing a release.

### 2.3 npm Registry Strategy

Do **not** publish the current package as-is. Prepare for an npm package, then
make publication a gated follow-up decision.

Recommended target:

- a scoped public package, e.g. `@c64re/mcp`, if the namespace is available;
- an executable command such as `c64re-mcp` exposed through `package.json`
  `bin`;
- source-checkout installation remains supported for contributors and local
  runtime/UI development.

Rationale:

- `npx @c64re/mcp` is the cleanest cross-platform MCP-host configuration;
- package publication without `bin`, asset verification, license inventory, and
  installed-package tests would only move today’s installation ambiguity into
  the registry;
- the GPL-licensed reSID/VICE-derived content may be distributed, but the
  package must carry the license/provenance files and corresponding sources or
  source references required by the repository policy.

## 3. User-Facing Install Matrix

`INSTALL.md` must give copy/pasteable instructions for each supported route.
Instructions must be validated on the relevant shell or in CI before the
section is labelled supported.

| Platform | Required install path | MCP launch example | Validation |
|---|---|---|---|
| macOS | Node LTS + Git; `npm ci`; `npm run build:mcp` | Claude Code and Codex examples with absolute POSIX paths | fresh checkout smoke on macOS runner or recorded local proof |
| Windows PowerShell | Node LTS + Git; PowerShell-native paths/quoting; `npm ci`; `npm run build:mcp` | JSON/config example using `node.exe`/resolved command and Windows paths | Windows runner smoke; no WSL assumptions |
| Windows + WSL2 | Linux Node installation inside WSL; repository inside WSL filesystem recommended | command and project paths entirely inside WSL | Ubuntu-in-WSL-equivalent instructions and Linux CI smoke |
| Linux | Node LTS + Git; distro-neutral baseline, note native package requirements only where proven | POSIX MCP host examples | Ubuntu CI/container smoke |
| Container | OCI/Docker recipe for stdio MCP server and optionally the V3 backend; project directory mounted as volume | host invokes container with stdio preserved and `C64RE_PROJECT_DIR` mounted | container build plus MCP initialization/tool smoke |

The document must distinguish:

1. **Use the MCP server**: minimal install and stdio MCP configuration.
2. **Use the V3 runtime UI**: additional backend/UI commands and ports.
3. **Develop or rebuild bundled assets**: maintainers only, including
   Emscripten for `npm run build:resid-wasm`.

## 4. `INSTALL.md` Required Content

### 4.1 Prerequisites

Document and enforce:

- supported Node.js LTS major version(s);
- npm version expectations if relevant to lockfile reproducibility;
- Git requirement for source-checkout installation;
- no Emscripten requirement for normal install because
  `src/runtime/headless/sid/wasm/resid.mjs` and `resid.wasm` are committed;
- Emscripten is required only when rebuilding reSID WASM.

Implementation requirement: add `engines.node` to `package.json` once the
supported baseline is verified. Add `.nvmrc` or equivalent only if the project
chooses an exact contributor baseline rather than an LTS range.

### 4.2 Source Checkout Installation

Provide one canonical source path:

```text
git clone -> npm ci -> npm run build:mcp -> MCP host configuration -> smoke
```

Use `npm ci` in reproducible install instructions. `npm install` may be shown
only as a contributor workflow for deliberately changing dependencies.

Document:

- `C64RE_PROJECT_DIR` and how to create/select a project directory;
- optional VICE/tool override variables separately from the minimum MCP path;
- where generated output (`dist/`) appears;
- how to update an existing checkout without losing project data.

### 4.3 MCP Host Configuration

Provide tested, platform-specific examples for at least:

- Claude Code `.mcp.json`;
- Codex MCP configuration.

Examples must:

- run the built server where possible, not require the TypeScript development
  loader as the only supported production path;
- use correct path quoting for PowerShell and WSL;
- show `C64RE_PROJECT_DIR`;
- explain that stdio must remain reserved for MCP protocol traffic.

### 4.4 Runtime UI

Document the runtime UI as an optional second step:

- backend command;
- V3 UI development/production command;
- ports and browser URL;
- relation between MCP server and runtime backend, if they are separate
  processes in the current implementation.

Do not present development commands as a packaged production UI until a
packaged deployment path exists.

### 4.5 Container Operation

Provide a documented container route with an actual committed recipe:

- `Dockerfile` or equivalent OCI build input;
- Node LTS base pinned to a supported major;
- deterministic dependency install with `npm ci`;
- build of the MCP distribution;
- project/workspace mounted into the container rather than baked into the
  image;
- `C64RE_PROJECT_DIR` mapped to that volume;
- stdio invocation for MCP clients;
- optional port mapping only for the V3 backend/UI path.

Container scope in this spec is operational packaging, not an emulator
sandbox. Samples, private project data, and writable `.c64re`/trace output must
remain in mounted storage.

### 4.6 Troubleshooting

Include only reproducible issues and resolutions:

- Node not found or wrong Node major;
- spaces and quoting in Windows paths;
- MCP host cannot resolve `npx`/`node`;
- missing `C64RE_PROJECT_DIR`;
- VICE is optional versus required for oracle/differential workflows;
- reSID WASM rebuild is not required for normal install;
- writable mounted project directory in containers.

## 5. npm Publication Readiness Gate

Registry publication is permitted only after all gates below pass from a
packed tarball, not from the repository checkout.

### 5.1 Package Shape

- Define final package name and verify npm namespace availability.
- Add `bin` for a stable MCP command.
- Add `engines.node`.
- Add `files` allowlist, or prove the tarball intentionally contains every
  included asset and no local traces/samples/session output.
- Ensure `LICENSE`, required provenance/notices, runtime WASM assets, compiled
  server output, and any runtime-required resources are included.
- Decide whether UI assets are included in the MCP package or delivered as a
  later separate package/build artifact.

### 5.2 Package Execution Proof

From `npm pack` output installed into an empty temporary directory:

- run the MCP executable and complete an MCP initialization plus one harmless
  tool call;
- run a runtime smoke requiring the committed reSID WASM asset;
- validate macOS, Windows PowerShell, and Linux/WSL-compatible invocation
  forms;
- validate container execution from the packed artifact if registry
  installation is documented for containers.

### 5.3 Licensing and Provenance

- Confirm the published package license metadata remains
  `GPL-3.0-or-later`.
- Include root `LICENSE`.
- Include notices/provenance required for vendored or compiled GPL components,
  particularly reSID and any shipped VICE-derived runtime source/assets.
- Do not publish binary runtime assets without their corresponding documented
  source/provenance path.

### 5.4 Publish Decision

After the gate:

- **GO:** publish a pre-1.0 package and document `npx` installation as the
  preferred MCP-user path.
- **NO-GO:** keep source checkout and container as supported paths, record the
  specific blocking gate, and do not advertise npm installation.

## 6. Implementation Slices

### 716.1 - Truth and platform prerequisites

- Determine supported Node LTS baseline by build/smoke evidence.
- Identify minimum runtime assets and environment variables.
- Record which external tools are optional oracle/development dependencies.

**Exit:** no undocumented required prerequisite for MCP startup.

### 716.2 - Root install guide

- Add `INSTALL.md`.
- Reduce `README.md` setup content to quick-start plus the install-guide link.
- Cover macOS, Windows PowerShell, Windows + WSL2, Linux, and container
  sections.

**Exit:** commands are copy/pasteable and distinguish MCP, UI, and maintainer
asset rebuild paths.

### 716.3 - Reproducible source/container verification

- Add the chosen container recipe.
- Add minimal install/mcp-start smoke suitable for CI.
- Validate at least Linux/container automatically; record macOS/Windows
  validation route.

**Exit:** source checkout and container routes are supported, not aspirational.

### 716.4 - Versioning contract

- Add the pre-1.0 semver policy to `INSTALL.md` or a linked release section.
- Set/enforce supported Node version metadata.
- Define tag/release-note convention.

**Exit:** the existing `0.1.0` has an explicit meaning and future releases are
not ad hoc.

### 716.5 - npm packaging spike and decision

- Configure a candidate package/executable without publishing.
- Run `npm pack` install-from-tarball proofs.
- Audit package contents and GPL/provenance.
- Record GO/NO-GO; publish only on explicit user approval after GO.

**Exit:** registry publication is either proven and separately approved, or
explicitly deferred for a concrete reason.

## 7. Acceptance Gates

The spec is complete when:

1. `INSTALL.md` exists at repository root and `README.md` links to it.
2. Installation instructions exist for macOS, Windows PowerShell, Windows
   WSL2, Linux, and container operation.
3. Normal-user instructions do not incorrectly require Emscripten.
4. Container instructions are backed by a committed, tested recipe.
5. Versioning policy is documented and Node compatibility is declared.
6. Source-checkout install has an automated clean-install/MCP-start smoke.
7. npm publication has a documented GO/NO-GO based on `npm pack` proofs and
   GPL/provenance inspection.
8. No package is published without explicit user approval.

## 8. Non-Goals

- Runtime correctness changes.
- Cartridge, SID, 1541, rewind, monitor, disassembly, or UI feature work.
- Packaging a polished standalone desktop application.
- Treating npm publication as mandatory; a proven source/container
  distribution remains an acceptable outcome.

## 9. Recommended Scheduling

Spec 716 does not block the runtime roadmap. It can run later on a
docs/infrastructure-only branch, after the new product-proof baseline work in
Spec 715 or in parallel with feature work when desired. It must not modify
runtime code. The npm publication decision should happen only after currently
active runtime changes intended for the first public install baseline have
landed.
