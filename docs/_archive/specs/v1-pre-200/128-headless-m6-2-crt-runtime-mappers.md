# Spec 128 — Headless M6.2: CRT Runtime Mappers

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 6, story M6.2
Depth: light
Predecessors: Spec 127 (M6.1)

## Motivation

Cartridges need active bank-switching support. Priority cart types:
8K/16K, Ocean, Magic Desk, EasyFlash, GMOD, Megabyter, C64MegaCart.

## Acceptance

- One mapper module per cart type under
  `src/runtime/headless/cart/mappers/`.
- Bank-switch writes via I/O1/I/O2 (Spec 106 hook) update the mapper
  state.
- Each mapper has a synthetic CRT fixture that boots to a known first
  frame.
- Initial scope: 8K/16K + Ocean.
- EasyFlash, GMOD, Megabyter, C64MegaCart marked as follow-up if
  scope blows; spec lists them as planned.

## Deliverables

- NEW `src/runtime/headless/cart/mappers/{8k.ts,16k.ts,ocean.ts}`
- Synthetic CRT fixtures
- `docs/cart-mappers.md`

## Dependencies

- Spec 127.

## Risks

- Each mapper has unique quirks. Mitigation: incremental ship; 8K/16K
  + Ocean first; remaining mappers as separate follow-up specs.

## Out of scope

- Real commercial cart images (license).
- Cartridge save state across power cycles.
