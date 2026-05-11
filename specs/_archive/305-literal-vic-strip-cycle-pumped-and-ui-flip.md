# Spec 305 — Strip Cycle-Pumped Wiring + UI Default Flip

Status: open
Date: 2026-05-10
Predecessor: Spec 304 (literal defaults on)
Plan: `docs/vic-ii-literal-port-migration-analysis-plan-2026-05-10.md`
Phase: 6b1 (= dead-code strip + UI consumer flip; precursor to
file-deletion sub-spec).

## Goal

1. Strip the dead `cycle-pumped` renderer code path
   (`installCyclePumpedRenderer` is exported but never called by any
   in-tree consumer; the `renderToPng` branch for it is unreachable).
2. Flip the v3 workspace UI's WebSocket default renderer from
   `vice-rasterized` to `literal-port` so the live browser screen
   reflects the literal-port output user is testing against.

After this spec, the user-visible UI screen comes from literal port
by default — same as harness output. Reverse env flag
`C64RE_LEGACY_VIC=1` opts out (= snapshot path via
`vice-rasterized`).

## Scope (in)

1. integrated-session.ts:
   - Remove `"cycle-pumped"` from the `renderToPng` opts.renderer
     union.
   - Remove the dead `if (opts?.renderer !== "cycle-pumped")` branch
     (= simplify to direct call).
   - Update inline comments referencing
     `installCyclePumpedRenderer`.
2. v3-ws-server.ts (`session/screenshot` handler):
   - Default `renderer = "literal-port"` (was `vice-rasterized`).
   - Reverse env flag `C64RE_LEGACY_VIC=1` → `vice-rasterized`
     (= explicit opt-out for legacy snapshot path).
   - Drop `C64RE_CYCLE_PUMPED` env handling.
   - Update comment block.

## Scope (out — follow-up specs)

- File deletion: `cycle-pumped-renderer.ts` +
  `cycle-pixel-composite.ts` + `raster-changes-builder.ts` (Spec 306).
- Snapshot renderer file deletion: `vic-renderer-pixel.ts` +
  `vic-renderer-rasterized.ts` (Spec 306).
- VicIIVice cleanup / facade replacement (Spec 307).
- Phase 7 perf pass.

## Acceptance gates

1. Build green.
2. All Spec 300/301/302 harnesses still PASS (= they explicitly use
   the legacy renderer values where needed; opts.renderer union
   shrink does not affect them).
3. Spec 303 fb-diff harness still PASS (uses `vice-rasterized`
   explicitly — still in union).
4. 298k integrated smoke still PASS.
5. UI server can start, `session/screenshot` returns base64 PNG.
6. With `C64RE_LEGACY_VIC=1`: UI returns vice-rasterized output.
7. Without env flag: UI returns literal-port output.

## Implementation

### integrated-session.ts

```ts
// Drop "cycle-pumped" from union:
opts?: { frameAligned?: boolean; renderer?: "per-char-row" | "per-pixel" | "vice-rasterized" | "literal-port" }

// Drop dead branch — direct call only:
if (opts?.renderer === undefined ||
    opts.renderer === "per-char-row" ||
    opts.renderer === "per-pixel" ||
    opts.renderer === "vice-rasterized") {
  this.renderFrame({ renderer: opts?.renderer });
}
```

### v3-ws-server.ts

```ts
let renderer: "literal-port" | "vice-rasterized" = "literal-port";
if (process.env.C64RE_LEGACY_VIC === "1") renderer = "vice-rasterized";
s.renderToPng(path, { renderer });
```

## Deliverables

- `specs/305-literal-vic-strip-cycle-pumped-and-ui-flip.md` (this)
- Patches to `src/runtime/headless/integrated-session.ts` +
  `src/workspace-ui/v3-ws-server.ts`

## Next slice

Spec 306 — delete physical renderer files (cycle-pumped-renderer,
cycle-pixel-composite, raster-changes-builder, vic-renderer-pixel,
vic-renderer-rasterized) once nothing wires them.
