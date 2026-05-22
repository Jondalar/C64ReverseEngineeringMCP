# reSID — bundled source (provenance)

These files are an **unmodified** copy of the reSID SID-emulation engine as
shipped inside VICE. They are bundled here so the SID audio WASM module
(Spec 703) builds reproducibly without requiring an external VICE checkout.

## Source

- Engine: reSID, a MOS6581/8580 SID emulator by Dag Lem
- reSID subpackage version: **1.0-pre2**
- Vendored from: VICE **3.10** source tree, `src/resid/`
- VICE repo: `git@github.com:VICE-Team/svn-mirror.git`
- VICE commit: `e635822a93` ("Merge branch 'clean' into main")
- Imported: 2026-05-22

`siddefs.h` is the VICE-configured variant (config macros already resolved:
`RESID_INLINING 1`, `RESID_INLINE inline`, `NEW_8580_FILTER 1`,
`HAVE_BUILTIN_EXPECT 1`, `HAVE_LOG1P 1`). No `configure` step is needed for a
standalone emscripten build. The engine is self-contained — it includes only
standard C++ headers (`<cassert> <cmath> <cstdlib> <fstream> <iostream>`),
no VICE-external dependencies.

## License

reSID is **GPL-2.0-or-later** (`Copyright (C) 2010 Dag Lem <resid@nimrod.no>`).
The original GPL headers are preserved verbatim in every file. This project
(C64RE MCP) is **GPL-3.0-or-later**, which is compatible via reSID's
"version 2 ... or any later version" grant. See `/THIRD_PARTY_NOTICES.md`.

## Do not edit

Treat this directory as read-only vendored source. To update, re-copy from the
pinned VICE commit and update this file. Local fixes belong in the WASM wrapper
(`scripts/build-resid-wasm.*` / `src/runtime/headless/sid/resid-wasm-engine.ts`),
never in these files — keep them byte-identical to VICE for fidelity tracing.
