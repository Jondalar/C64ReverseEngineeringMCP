# vice-refs — vendored VICE source for port provenance

Source-of-truth C files copied verbatim from VICE (or a VICE fork) so the
TypeScript runtime ports under `src/runtime/headless/` can cite and be diffed
against them. Only the specific modules we port are vendored — not the whole
VICE tree. All files are GPL-2-or-later (VICE); C64RE is GPL-3-or-later.

- `c64megacart/c64megacart.{c,h}` — C64MegaCart mapper. Not in mainline VICE;
  authoritative source is Martin Piper's fork
  https://github.com/martinpiper/Vice-3.1-with-C64MegaCart
  (vice-3.1/src/c64/cart/). Derived from VICE's GMod2 implementation
  (flash040core + EEPROM), so it shares those device cores in our port.
