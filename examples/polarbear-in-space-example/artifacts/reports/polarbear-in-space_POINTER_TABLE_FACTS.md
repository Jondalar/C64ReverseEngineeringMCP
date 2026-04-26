# Pointer Table Facts: /Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/examples/polarbear-in-space-example/input/prg/polarbear-in-space.prg

## Pipeline

1. Discover confirmed and probable code.
2. Collect zero-page pointer constructions from decoded instructions.
3. Detect split pointer tables when code loads low and high bytes from separate indexed tables into adjacent zero-page cells.
4. Sample reconstructed targets from those tables.
5. Classify the table conservatively from target shape and usage context.
6. Keep interpretation as a hypothesis until the surrounding routine is read manually.

## Split Pointer Tables

### $0007 + $000C -> ZP $0002-$0003
- code: $2186-$218F
- provenance: `probable_code`
- index: `Y`
- confidence: 0.62
- sample targets: -
- reasons:
  - Code builds zero-page pointer $0002-$0003 from indexed tables $0007 and $000C.
  - Both loads use Y as the shared index register.
  - No target samples could be reconstructed from the mapped range.
  - Pattern comes from a probable code island and should be validated manually.
- hypothesis: `generic_split_pointer_table`

## Notes

- This report only covers split low/high-byte tables, not contiguous `.word` tables.
- Adjacent source-byte pairs such as `$118F/$1190` are filtered out because they more likely represent interleaved byte streams than true `<label` / `>label` tables.
- Use this report together with RAM-state facts and routine comments before renaming labels.