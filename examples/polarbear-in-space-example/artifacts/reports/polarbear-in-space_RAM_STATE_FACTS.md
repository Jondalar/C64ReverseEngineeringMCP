# RAM State Facts for /Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/examples/polarbear-in-space-example/input/prg/polarbear-in-space.prg

Generated from deterministic analysis facts.

## Address Candidates

### $0002
- domain: `zero_page`
- access: `readwrite`
- direct reads: 2 ($2195, $2241)
- direct writes: 5 ($2189, $21AB, $220F, $2243, $75F6)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 1 ($222D)
- indirect writes: 0 (-)
- read/modify/write: 6 ($21A5, $75F9, $75FF, $7605, $760B, $7611)
- immediate write values: $07
- confidence: 0.80
- reason: Static RAM address $0002 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=3, writes=11.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0003
- domain: `zero_page`
- access: `readwrite`
- direct reads: 2 ($2190, $69BD)
- direct writes: 3 ($218E, $2211, $6548)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 2 ($21AD, $2247)
- immediate write values: -
- confidence: 0.70
- reason: Static RAM address $0003 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=5.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0004
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 1 ($654A)
- indexed reads: 0 (-)
- indexed writes: 1 ($2125)
- indirect reads: 1 ($4E4D)
- indirect writes: 2 ($4D4C, $4D51)
- read/modify/write: 1 ($8D8E)
- immediate write values: -
- confidence: 0.68
- reason: Static RAM address $0004 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=5.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0005
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 4 ($2355, $265C, $508B, $50BA)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 1 ($50C0)
- indirect writes: 1 ($508F)
- read/modify/write: 0 (-)
- immediate write values: $00, $07
- confidence: 0.68
- reason: Static RAM address $0005 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=5.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0006
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($5087, $50B1)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 3 ($5094, $50C7, $8D8C)
- immediate write values: -
- confidence: 0.66
- reason: Static RAM address $0006 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=5.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0007
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 1 ($50BC)
- indexed reads: 1 ($2186)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 1 ($50C2)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.62
- reason: Static RAM address $0007 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0008
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($4D53)
- direct writes: 1 ($50B6)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($50C9)
- immediate write values: -
- confidence: 0.62
- reason: Static RAM address $0008 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0009
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4BA5)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $38
- confidence: 0.58
- reason: Static RAM address $0009 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $000A
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4BA1)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.58
- reason: Static RAM address $000A is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $000B
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($4BFC)
- direct writes: 2 ($4B65, $4C00)
- indexed reads: 1 ($4B6B)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.64
- reason: Static RAM address $000B is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $000C
- domain: `zero_page`
- access: `readwrite`
- direct reads: 3 ($4C02, $4C27, $4C2F)
- direct writes: 1 ($4C06)
- indexed reads: 1 ($218B)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.66
- reason: Static RAM address $000C is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=4, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $000D
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($4C21)
- direct writes: 1 ($4B47)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 2 ($4C0E, $4C12)
- immediate write values: -
- confidence: 0.64
- reason: Static RAM address $000D is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $000E
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($4C15)
- direct writes: 2 ($4B67, $4C19)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.62
- reason: Static RAM address $000E is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $000F
- domain: `zero_page`
- access: `readwrite`
- direct reads: 2 ($4C1B, $4C35)
- direct writes: 2 ($4B5D, $4C1F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.64
- reason: Static RAM address $000F is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0010
- domain: `zero_page`
- access: `read`
- direct reads: 1 ($4BFE)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $0010 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0011
- domain: `zero_page`
- access: `read`
- direct reads: 2 ($4C04, $4C08)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $0011 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0012
- domain: `zero_page`
- access: `readwrite`
- direct reads: 2 ($4BF1, $4C17)
- direct writes: 3 ($211F, $4BF5, $74FC)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $17
- confidence: 0.66
- reason: Static RAM address $0012 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0013
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($4C1D)
- direct writes: 1 ($2697)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($4BF9)
- immediate write values: $9C
- confidence: 0.62
- reason: Static RAM address $0013 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0014
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($4B49)
- direct writes: 1 ($212C)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $02
- confidence: 0.60
- reason: Static RAM address $0014 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0015
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 1 ($4B99)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 1 ($4BA9)
- indirect writes: 1 ($4C3F)
- read/modify/write: 0 (-)
- immediate write values: $47
- confidence: 0.62
- reason: Static RAM address $0015 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0016
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4B9D)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $FD
- confidence: 0.58
- reason: Static RAM address $0016 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0017
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($5213)
- direct writes: 3 ($14D6, $14E6, $51E5)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 5 ($14DA, $14EA, $14EE, $51EB, $51EE)
- immediate write values: $00
- confidence: 0.74
- reason: Static RAM address $0017 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=8.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0018
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($521E)
- direct writes: 2 ($5187, $51E7)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 3 ($51D9, $5200, $5203)
- immediate write values: $02
- confidence: 0.68
- reason: Static RAM address $0018 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=5.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0019
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($5215)
- direct writes: 1 ($51DF)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $0019 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $001A
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($5217)
- direct writes: 1 ($51E1)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $001A is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $001B
- domain: `zero_page`
- access: `readwrite`
- direct reads: 3 ($3A2E, $3A45, $3A5A)
- direct writes: 2 ($3A1B, $3A83)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 2 ($3A3A, $3A55)
- immediate write values: $02
- confidence: 0.70
- reason: Static RAM address $001B is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=3, writes=4.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $001C
- domain: `zero_page`
- access: `readwrite`
- direct reads: 27 ($1C78, $1ED8, $21FA, $224B, $3137, $3387, ...)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($9027)
- immediate write values: -
- confidence: 0.80
- reason: Static RAM address $001C is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=27, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $001D
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($45D0, $4612)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 3 ($45DC, $45DF, $4619)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.66
- reason: Static RAM address $001D is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=5.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $001E
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($45D6, $460D)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $001E is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $001F
- domain: `zero_page`
- access: `readwrite`
- direct reads: 3 ($45D4, $5DA2, $6C66)
- direct writes: 1 ($5047)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.64
- reason: Static RAM address $001F is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=3, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0020
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($504D)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $0020 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0021
- domain: `zero_page`
- access: `readwrite`
- direct reads: 11 ($1CAF, $41C9, $4673, $486E, $69B1, $6DC1, ...)
- direct writes: 5 ($6DEB, $6DFC, $6E32, $6E3C, $8797)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $01, $02, $10
- confidence: 0.80
- reason: Static RAM address $0021 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=11, writes=5.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0022
- domain: `zero_page`
- access: `readwrite`
- direct reads: 9 ($1C26, $65FE, $66AC, $6B2F, $6D93, $6D9B, ...)
- direct writes: 4 ($6558, $6602, $6D97, $6D9F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $10
- confidence: 0.80
- reason: Static RAM address $0022 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=9, writes=4.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0024
- domain: `zero_page`
- access: `readwrite`
- direct reads: 2 ($22AC, $65F4)
- direct writes: 8 ($2359, $2680, $65A5, $65FC, $6780, $67DC, ...)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $C2, $F5
- confidence: 0.76
- reason: Static RAM address $0024 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=8.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0025
- domain: `zero_page`
- access: `readwrite`
- direct reads: 2 ($7B68, $7B79)
- direct writes: 1 ($6693)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.62
- reason: Static RAM address $0025 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0026
- domain: `zero_page`
- access: `readwrite`
- direct reads: 2 ($7B6E, $7B7F)
- direct writes: 1 ($6699)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.62
- reason: Static RAM address $0026 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0027
- domain: `zero_page`
- access: `readwrite`
- direct reads: 2 ($4F1F, $6B92)
- direct writes: 2 ($310C, $652B)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 2 ($6B9A, $6B9E)
- immediate write values: $AC
- confidence: 0.68
- reason: Static RAM address $0027 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=4.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0028
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($4F2A)
- direct writes: 2 ($310E, $652F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.62
- reason: Static RAM address $0028 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0029
- domain: `zero_page`
- access: `readwrite`
- direct reads: 8 ($6682, $669C, $6962, $6B88, $6BA4, $6C4E, ...)
- direct writes: 6 ($3107, $6536, $668C, $6B90, $6CC1, $6DDC)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $46
- confidence: 0.80
- reason: Static RAM address $0029 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=8, writes=6.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $002A
- domain: `zero_page`
- access: `readwrite`
- direct reads: 3 ($669E, $6964, $6BA6)
- direct writes: 7 ($656B, $65CE, $688A, $68E3, $6DA3, $6DE4, ...)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.76
- reason: Static RAM address $002A is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=3, writes=7.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $002B
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($66AA)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $002B is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $002C
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($66A5)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $002C is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $002D
- domain: `zero_page`
- access: `readwrite`
- direct reads: 3 ($69C1, $6DC7, $6E03)
- direct writes: 1 ($6E17)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $FE
- confidence: 0.64
- reason: Static RAM address $002D is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=3, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $002E
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($6DC9)
- direct writes: 1 ($6DE0)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.60
- reason: Static RAM address $002E is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $002F
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($6684)
- direct writes: 4 ($67A9, $69C7, $6DE2, $6DF5)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $FD
- confidence: 0.66
- reason: Static RAM address $002F is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=4.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0031
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($3091)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $0031 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0032
- domain: `zero_page`
- access: `readwrite`
- direct reads: 5 ($4B57, $6C73, $8405, $8446, $8459)
- direct writes: 6 ($4B4E, $6C61, $6C75, $8417, $8448, $84AE)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 2 ($840D, $8431)
- immediate write values: -
- confidence: 0.80
- reason: Static RAM address $0032 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=5, writes=8.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0033
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($8409)
- direct writes: 4 ($4B52, $6C68, $8419, $84B2)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 3 ($6C79, $840F, $8433)
- immediate write values: $00
- confidence: 0.72
- reason: Static RAM address $0033 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=7.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0034
- domain: `zero_page`
- access: `readwrite`
- direct reads: 2 ($841C, $843A)
- direct writes: 4 ($8427, $843C, $8450, $8465)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 2 ($8411, $842D)
- immediate write values: $00, $29
- confidence: 0.72
- reason: Static RAM address $0034 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=6.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0035
- domain: `zero_page`
- access: `readwrite`
- direct reads: 4 ($8420, $8440, $845D, $84B0)
- direct writes: 3 ($8429, $8442, $8454)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 2 ($842F, $84AC)
- immediate write values: $00
- confidence: 0.74
- reason: Static RAM address $0035 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=4, writes=5.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0036
- domain: `zero_page`
- access: `readwrite`
- direct reads: 2 ($8438, $84A2)
- direct writes: 2 ($841E, $8461)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.64
- reason: Static RAM address $0036 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0037
- domain: `zero_page`
- access: `readwrite`
- direct reads: 3 ($1C89, $1EBE, $63BF)
- direct writes: 2 ($63C1, $63D2)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $90
- confidence: 0.66
- reason: Static RAM address $0037 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=3, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0038
- domain: `zero_page`
- access: `readwrite`
- direct reads: 3 ($1C8B, $1EC3, $63C4)
- direct writes: 2 ($63C6, $63D6)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $99
- confidence: 0.66
- reason: Static RAM address $0038 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=3, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0039
- domain: `zero_page`
- access: `readwrite`
- direct reads: 3 ($1C8D, $1EC8, $63C9)
- direct writes: 2 ($63CC, $63D8)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.66
- reason: Static RAM address $0039 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=3, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $003A
- domain: `zero_page`
- access: `readwrite`
- direct reads: 4 ($6B47, $900B, $93F8, $940C)
- direct writes: 1 ($9130)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.66
- reason: Static RAM address $003A is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=4, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $003B
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4EDE)
- indexed reads: 0 (-)
- indexed writes: 1 ($2E99)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $003B is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $003C
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($4E67)
- direct writes: 1 ($4EDC)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.60
- reason: Static RAM address $003C is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $003D
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4ED0)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $01
- confidence: 0.58
- reason: Static RAM address $003D is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $003E
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($32A4)
- direct writes: 1 ($4ED4)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $04
- confidence: 0.60
- reason: Static RAM address $003E is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $003F
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4EE0)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $003F is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0040
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4EE2)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $0040 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0041
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($4EE6)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $0041 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0045
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($4D92)
- direct writes: 2 ($4D9D, $4ED8)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $07
- confidence: 0.62
- reason: Static RAM address $0045 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0046
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4D72)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $1E
- confidence: 0.58
- reason: Static RAM address $0046 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $004A
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($5A41)
- direct writes: 3 ($5A38, $5D41, $5D49)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 2 ($5D4E, $5D53)
- immediate write values: -
- confidence: 0.68
- reason: Static RAM address $004A is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=5.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $004B
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($5A45)
- direct writes: 4 ($5A2B, $5D51, $72DE, $73D6)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 4 ($5A30, $5A33, $5A36, $73BC)
- immediate write values: -
- confidence: 0.74
- reason: Static RAM address $004B is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=8.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $004C
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($528D)
- direct writes: 1 ($9037)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($9031)
- immediate write values: $02
- confidence: 0.62
- reason: Static RAM address $004C is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $004D
- domain: `zero_page`
- access: `readwrite`
- direct reads: 4 ($4850, $5A2D, $5DB1, $5F3A)
- direct writes: 1 ($5D7C)
- indexed reads: 0 (-)
- indexed writes: 1 ($5F1E)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.68
- reason: Static RAM address $004D is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=4, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $004E
- domain: `zero_page`
- access: `readwrite`
- direct reads: 4 ($4859, $5A29, $5DB6, $5F3C)
- direct writes: 1 ($5D86)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.66
- reason: Static RAM address $004E is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=4, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $004F
- domain: `zero_page`
- access: `readwrite`
- direct reads: 3 ($5A03, $7B4C, $7B54)
- direct writes: 1 ($5D81)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.64
- reason: Static RAM address $004F is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=3, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0050
- domain: `zero_page`
- access: `readwrite`
- direct reads: 3 ($5A09, $5D4B, $7B44)
- direct writes: 2 ($5A00, $5D8B)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.66
- reason: Static RAM address $0050 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=3, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0051
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($668F)
- direct writes: 1 ($5A43)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $0051 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0052
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($6695)
- direct writes: 1 ($5A49)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $0052 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0053
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($5A13)
- direct writes: 2 ($5A07, $5A19)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.62
- reason: Static RAM address $0053 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0054
- domain: `zero_page`
- access: `readwrite`
- direct reads: 2 ($5A1B, $5D43)
- direct writes: 2 ($5A0D, $5A1F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.64
- reason: Static RAM address $0054 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0055
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($858D)
- direct writes: 1 ($8615)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $04
- confidence: 0.60
- reason: Static RAM address $0055 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0056
- domain: `zero_page`
- access: `readwrite`
- direct reads: 2 ($8589, $85C4)
- direct writes: 2 ($57EC, $8611)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($859C)
- immediate write values: $13
- confidence: 0.66
- reason: Static RAM address $0056 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0057
- domain: `zero_page`
- access: `readwrite`
- direct reads: 2 ($85A8, $85B4)
- direct writes: 1 ($85A0)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($85B2)
- immediate write values: $04
- confidence: 0.64
- reason: Static RAM address $0057 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0058
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($57EE, $85A4)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $80
- confidence: 0.60
- reason: Static RAM address $0058 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $005A
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($57F0)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $005A is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $005B
- domain: `zero_page`
- access: `read`
- direct reads: 1 ($5883)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $005B is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $005C
- domain: `zero_page`
- access: `read`
- direct reads: 2 ($5857, $585C)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $005C is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $005D
- domain: `zero_page`
- access: `read`
- direct reads: 1 ($575D)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $005D is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $005E
- domain: `zero_page`
- access: `read`
- direct reads: 1 ($5761)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $005E is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $005F
- domain: `zero_page`
- access: `read`
- direct reads: 2 ($574A, $575B)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $005F is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0060
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($5753)
- direct writes: 1 ($8B06)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 1 ($8B0C)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.62
- reason: Static RAM address $0060 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0061
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($3CD8)
- direct writes: 3 ($3BB8, $3CC8, $8B08)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.64
- reason: Static RAM address $0061 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0062
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($3BB3)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $0062 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0063
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($3BF0)
- direct writes: 1 ($3BBA)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $0063 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0065
- domain: `zero_page`
- access: `readwrite`
- direct reads: 2 ($3A50, $3A6B)
- direct writes: 2 ($3A42, $3A65)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.64
- reason: Static RAM address $0065 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0066
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($3CD1)
- direct writes: 1 ($3CD3)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $0066 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0069
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 2 ($47EE, $4854)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 1 ($47FE)
- indirect writes: 1 ($4807)
- read/modify/write: 2 ($485E, $4862)
- immediate write values: $F8
- confidence: 0.68
- reason: Static RAM address $0069 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=5.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $006A
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($47F2, $4865)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($480C)
- immediate write values: $60
- confidence: 0.62
- reason: Static RAM address $006A is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $006B
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($3299, $4857)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 2 ($22AA, $32BD)
- immediate write values: $05
- confidence: 0.64
- reason: Static RAM address $006B is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=4.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $006C
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($32AE)
- direct writes: 4 ($2E7F, $328D, $32B2, $5473)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 6 ($2E89, $329D, $7FDA, $7FDF, $7FE4, $8069)
- indirect writes: 2 ($32A2, $57A2)
- read/modify/write: 0 (-)
- immediate write values: $40
- confidence: 0.80
- reason: Static RAM address $006C is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=7, writes=6.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $006D
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($2E83)
- direct writes: 3 ($2E69, $2E85, $3291)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 3 ($2E78, $2E7B, $32B8)
- immediate write values: $00
- confidence: 0.70
- reason: Static RAM address $006D is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=6.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $006E
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 3 ($328F, $32B4, $5477)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 2 ($32A6, $57AC)
- read/modify/write: 0 (-)
- immediate write values: $08
- confidence: 0.66
- reason: Static RAM address $006E is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=5.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $006F
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($3295)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($32BA)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $006F is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0070
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 3 ($331B, $339C, $547B)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 4 ($3760, $3768, $376E, $57B1)
- indirect writes: 5 ($33A9, $33AC, $33B0, $33B3, $57BA)
- read/modify/write: 0 (-)
- immediate write values: $A8
- confidence: 0.80
- reason: Static RAM address $0070 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=4, writes=8.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0071
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($332D)
- direct writes: 2 ($33A3, $3757)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($331F)
- immediate write values: -
- confidence: 0.64
- reason: Static RAM address $0071 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0072
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 2 ($33CE, $547F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 1 ($57BF)
- indirect writes: 5 ($33D6, $33DF, $33EB, $33F0, $57C8)
- read/modify/write: 0 (-)
- immediate write values: $F8
- confidence: 0.72
- reason: Static RAM address $0072 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=7.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0073
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($33C5)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $0073 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0074
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 2 ($33D0, $5483)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 1 ($57CD)
- indirect writes: 5 ($33DA, $33E3, $33E7, $33F4, $57D6)
- read/modify/write: 0 (-)
- immediate write values: $20
- confidence: 0.72
- reason: Static RAM address $0074 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=7.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0075
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($33C9)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $0075 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0076
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 2 ($5747, $80F1)
- indexed writes: 5 ($5489, $574C, $5755, $7FDD, $805F)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.70
- reason: Static RAM address $0076 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=5.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $007B
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 1 ($5490)
- indexed reads: 2 ($5758, $80F6)
- indexed writes: 3 ($5763, $7FE2, $8063)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $0A
- confidence: 0.68
- reason: Static RAM address $007B is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=4.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $007C
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5494)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $17
- confidence: 0.58
- reason: Static RAM address $007C is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $007D
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5498)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $27
- confidence: 0.58
- reason: Static RAM address $007D is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $007E
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($549C)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $0E
- confidence: 0.58
- reason: Static RAM address $007E is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $007F
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($54A0)
- indexed reads: 0 (-)
- indexed writes: 1 ($57F5)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $22
- confidence: 0.60
- reason: Static RAM address $007F is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0080
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($7FE7)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $0080 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0086
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($902F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($9029)
- immediate write values: $04
- confidence: 0.60
- reason: Static RAM address $0086 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0087
- domain: `zero_page`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($839F)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $0087 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $008C
- domain: `zero_page`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 2 ($96FC, $9702)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $008C is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $008D
- domain: `zero_page`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.56
- reason: Static RAM address $008D is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $0096
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($7728)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 2 ($7B89, $83B5)
- immediate write values: -
- confidence: 0.62
- reason: Static RAM address $0096 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0097
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($7B9B)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $01
- confidence: 0.58
- reason: Static RAM address $0097 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $009C
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 3 ($7761, $7B97, $9727)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00, $01
- confidence: 0.62
- reason: Static RAM address $009C is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00A1
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 7 ($7C1F, $7CDF, $7D36, $7D6E, $7DE0, $7FF1, ...)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00, $01, $03
- confidence: 0.70
- reason: Static RAM address $00A1 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=7.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00A6
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 7 ($7C2B, $7CBD, $7D1B, $7D76, $7DE8, $8004, ...)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $9C, $EC
- confidence: 0.70
- reason: Static RAM address $00A6 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=7.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00AB
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 1 ($2394)
- indexed reads: 7 ($3072, $775B, $7F94, $7FF5, $80DF, $839B, ...)
- indexed writes: 11 ($3074, $7722, $7C3D, $7C93, $7CDB, $7D32, ...)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $08, $09, $0A, $0B, $0D, $13, $80
- confidence: 0.80
- reason: Static RAM address $00AB is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=7, writes=12.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00B0
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 2 ($78D6, $805D)
- indexed writes: 4 ($78D8, $7B6C, $7B7D, $80F3)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.68
- reason: Static RAM address $00B0 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=4.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00B5
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 2 ($78DB, $8061)
- indexed writes: 4 ($78DD, $7B72, $7B83, $80F8)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.68
- reason: Static RAM address $00B5 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=4.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00BA
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 5 ($78A7, $78CA, $8065, $970B, $9711)
- indexed writes: 8 ($78CC, $7C39, $7C97, $7CC4, $7D13, $7D7D, ...)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $60, $64, $69, $A6, $CA
- confidence: 0.80
- reason: Static RAM address $00BA is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=5, writes=8.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00BE
- domain: `zero_page`
- access: `read`
- direct reads: 1 ($8386)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $00BE is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00BF
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($78D0)
- indexed writes: 5 ($7C21, $7CD0, $7D27, $7D8E, $7FED)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $FC, $FD, $FF
- confidence: 0.68
- reason: Static RAM address $00BF is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=5.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00C4
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 3 ($78AD, $78BD, $78C8)
- indexed writes: 6 ($78B5, $78C5, $7C23, $7C9B, $7D38, $7FF3)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $FE
- confidence: 0.74
- reason: Static RAM address $00C4 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=3, writes=6.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00C9
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 4 ($7CCA, $7D21, $7D88, $80DB)
- indexed writes: 5 ($7B87, $7DF9, $7FEB, $8067, $8109)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00, $01, $96, $FF
- confidence: 0.74
- reason: Static RAM address $00C9 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=4, writes=5.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00CE
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 5 ($7C9D, $7CC6, $7D1F, $7DEC, $8058)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00, $01
- confidence: 0.66
- reason: Static RAM address $00CE is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=5.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00D3
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 10 ($787A, $7C2F, $7CD4, $7D2B, $7D81, $7E00, ...)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $40, $54, $57, $61, $67, $D7
- confidence: 0.76
- reason: Static RAM address $00D3 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=10.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00D7
- domain: `zero_page`
- access: `read`
- direct reads: 1 ($838B)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $00D7 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00D8
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 2 ($7B8C, $8101)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $00D8 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00DC
- domain: `zero_page`
- access: `read`
- direct reads: 1 ($8393)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $00DC is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00DD
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($7B91)
- direct writes: 2 ($772F, $7B93)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $02
- confidence: 0.62
- reason: Static RAM address $00DD is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00DE
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($4620)
- direct writes: 1 ($4630)
- indexed reads: 0 (-)
- indexed writes: 1 ($465B)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.62
- reason: Static RAM address $00DE is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00DF
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($4632)
- direct writes: 1 ($463E)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $00DF is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00E0
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($462E)
- direct writes: 1 ($2D5F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $00E0 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00E1
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($463C)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($2E8B)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $00E1 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00E2
- domain: `zero_page`
- access: `read`
- direct reads: 1 ($30FF)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $00E2 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00E3
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($30FD)
- direct writes: 1 ($1B0F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($1B24)
- immediate write values: $00
- confidence: 0.62
- reason: Static RAM address $00E3 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00E4
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($3105)
- direct writes: 1 ($1B20)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 2 ($4628, $462C)
- read/modify/write: 1 ($1B15)
- immediate write values: -
- confidence: 0.66
- reason: Static RAM address $00E4 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=4.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00E5
- domain: `zero_page`
- access: `read`
- direct reads: 2 ($3103, $4624)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $00E5 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00E6
- domain: `zero_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 2 ($4636, $463A)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $00E6 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00E7
- domain: `zero_page`
- access: `read`
- direct reads: 3 ($3111, $38C9, $3928)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.62
- reason: Static RAM address $00E7 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=3, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00E8
- domain: `zero_page`
- access: `readwrite`
- direct reads: 2 ($38C1, $38F6)
- direct writes: 0 (-)
- indexed reads: 1 ($45E9)
- indexed writes: 1 ($4653)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.64
- reason: Static RAM address $00E8 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=3, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00EC
- domain: `zero_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 2 ($45C6, $45F2)
- indexed writes: 3 ($45F0, $45F6, $4651)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.66
- reason: Static RAM address $00EC is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00EE
- domain: `zero_page`
- access: `read`
- direct reads: 3 ($307E, $3321, $3389)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.62
- reason: Static RAM address $00EE is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=3, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00EF
- domain: `zero_page`
- access: `read`
- direct reads: 2 ($3084, $338D)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $00EF is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=2, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00F0
- domain: `zero_page`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($45D8)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $00F0 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00F8
- domain: `zero_page`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($45CE)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $00F8 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00FC
- domain: `zero_page`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($45D2)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $00FC is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00FE
- domain: `zero_page`
- access: `readwrite`
- direct reads: 3 ($4F41, $500A, $501D)
- direct writes: 3 ($4F28, $5008, $501B)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 3 ($4F2F, $4F31, $4F33)
- immediate write values: $00
- confidence: 0.74
- reason: Static RAM address $00FE is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=3, writes=6.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $00FF
- domain: `zero_page`
- access: `readwrite`
- direct reads: 1 ($4F46)
- direct writes: 1 ($4F38)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $00FF is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0100
- domain: `stack_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($3A5E)
- indexed writes: 2 ($3A37, $3A52)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $0100 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0103
- domain: `stack_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($3A75)
- indexed writes: 1 ($3A49)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $0103 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0106
- domain: `stack_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($3A6D)
- indexed writes: 2 ($3A3E, $3A4D)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.54
- reason: Static RAM address $0106 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $010C
- domain: `stack_page`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($3BB5)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $010C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $010F
- domain: `stack_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($3BAE)
- indexed writes: 1 ($3CC5)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.52
- reason: Static RAM address $010F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0112
- domain: `stack_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($3BF2)
- indexed writes: 1 ($3B9B)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $0112 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0115
- domain: `stack_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($3B98)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($3BF7)
- immediate write values: $01
- confidence: 0.52
- reason: Static RAM address $0115 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0118
- domain: `stack_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($3CCA)
- indexed writes: 1 ($3B7B)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $0118 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $011B
- domain: `stack_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 2 ($3B85, $3CDA)
- indexed writes: 1 ($3B75)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $011B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $011E
- domain: `stack_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($3BC9)
- indexed writes: 1 ($3B82)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $011E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0121
- domain: `stack_page`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($3B8B)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $0121 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0124
- domain: `stack_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($3BDA)
- indexed writes: 1 ($3BE3)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $0124 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $012A
- domain: `stack_page`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($3BE6)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $012A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0130
- domain: `stack_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 2 ($3BBC, $3BE0)
- indexed writes: 2 ($3B90, $3BED)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.56
- reason: Static RAM address $0130 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0133
- domain: `stack_page`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($3BC1)
- indexed writes: 1 ($3B93)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $0133 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0200
- domain: `system_workspace`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($14F6)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $0200 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in page 2/3 system workspace, so this may be a KERNAL vector/flag or a game-owned override of system RAM.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0288
- domain: `system_workspace`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($115D)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $08
- confidence: 0.50
- reason: Static RAM address $0288 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in page 2/3 system workspace, so this may be a KERNAL vector/flag or a game-owned override of system RAM.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0300
- domain: `system_workspace`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($14E0)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $0300 is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in page 2/3 system workspace, so this may be a KERNAL vector/flag or a game-owned override of system RAM.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $03FF
- domain: `system_workspace`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($8603)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $03FF is touched from decoded code, so it is a good state/label candidate.
- reason: Lives in page 2/3 system workspace, so this may be a KERNAL vector/flag or a game-owned override of system RAM.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0400
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($4E69)
- direct writes: 1 ($4D55)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $0400 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0621
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $0621 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: At least one touch comes from recursively confirmed code.

### $06A9
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $06A9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $08DD
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1123)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $08DD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0AF9
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($8BD9)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $0AF9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0AFA
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($8BE1)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $0AFA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0BAC
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($10A1)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $0BAC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0CDA
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1120)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $0CDA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0CDD
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1126)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $0CDD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0FAC
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($10A4)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $0FAC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $0FE8
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($1151)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $0FE8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1038
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($1139)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $1038 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $10AF
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($10B3)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $10AF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1133
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($112F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($1136)
- immediate write values: $4F
- confidence: 0.52
- reason: Static RAM address $1133 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1410
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($3736)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $1410 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $16C0
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($2E96)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $16C0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1700
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($85B6)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $1700 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1705
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($85C6)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $1705 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1718
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($85C9)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $1718 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1A2D
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $1A2D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $1A2E
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($91F0, $944F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.52
- reason: Static RAM address $1A2E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1ABA
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $1ABA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $1AC9
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $1AC9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $1BA5
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $1BA5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $1BD6
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $1BD6 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $1C26
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $1C26 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $1C34
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($1C17, $1C2E)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 2 ($1C3C, $1C41)
- immediate write values: $00, $2F
- confidence: 0.56
- reason: Static RAM address $1C34 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=4.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1C64
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1C5A)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $1C64 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1C89
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $1C89 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $1C8F
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $1C8F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $1C99
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1C95)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $1C99 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1CA0
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1C92)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $1CA0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1CA7
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1C8F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $1CA7 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1CAD
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $1CAD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $1CB6
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($32C4)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($333D)
- immediate write values: $62
- confidence: 0.52
- reason: Static RAM address $1CB6 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1CDB
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($1C0A, $1CB9)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $1CDB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1DA9
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $1DA9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $1DB9
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1DB5)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($1DE3)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $1DB9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1DC4
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($1DE6)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $1DC4 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1DCD
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1DC0)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $1DCD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1DDF
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1DD6)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $1DDF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1E25
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1C4F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $1E25 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1E85
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($1C0D, $1CBC)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $1E85 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1EBC
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $1EBC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $1ED7
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1EE3)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $07
- confidence: 0.50
- reason: Static RAM address $1ED7 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1EF3
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $1EF3 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $1FAB
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $1FAB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $1FAF
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1BFD)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $1FAF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1FD1
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1C03)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $1FD1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $1FF3
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1C00)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $1FF3 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2012
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($1C06, $2015)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $2012 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2057
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($1EE6)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $2057 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $205F
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($1EEC)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $205F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2097
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($201B)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $2097 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2098
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($2021)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $2098 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2099
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($2027)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $2099 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $20B0
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($2002)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $20B0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $20B1
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($2008)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $20B1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $20BF
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($1D9C)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $20BF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $20D4
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 3 ($1DBA, $1DC5, $1DD1)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $20D4 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=3, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2109
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($1C4C)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $2109 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $210D
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($1C60)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $210D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2115
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $2115 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $2118
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $2118 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $217E
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($2164)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $217E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $21B2
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($2182)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $21B2 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $21C8
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($21B7)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $21C8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $21DC
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($21BC)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $21DC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $21F7
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($21C1)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $21F7 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $220F
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $220F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $2238
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($221E)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $2238 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2239
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($2226)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $2239 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $22AC
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $22AC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $22C7
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($21E2)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $22C7 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $22CA
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($21C9)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $22CA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $230D
- domain: `main_ram`
- access: `readwrite`
- direct reads: 2 ($21C4, $21DF)
- direct writes: 1 ($2206)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($21FF)
- immediate write values: $42
- confidence: 0.56
- reason: Static RAM address $230D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2324
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($2130)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $2324 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $232D
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($2139)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $232D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2336
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($2142)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $2336 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2911
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($286C)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $20
- confidence: 0.50
- reason: Static RAM address $2911 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2D4A
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $2D4A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $2DC1
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($5F24)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $2DC1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2E2B
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($2D59)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($334C)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $2E2B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2EA2
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($2D61, $30D0)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($30C2)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $2EA2 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2EBD
- domain: `main_ram`
- access: `readwrite`
- direct reads: 2 ($38FD, $9010)
- direct writes: 3 ($2D64, $308E, $65EE)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($30BF)
- immediate write values: $00
- confidence: 0.60
- reason: Static RAM address $2EBD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=4.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2ED8
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($30CC)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $2ED8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2F59
- domain: `main_ram`
- access: `readwrite`
- direct reads: 5 ($2E6C, $3344, $38D9, $3938, $50CF)
- direct writes: 1 ($2D5C)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $2F59 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=5, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $2F6A
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($2E72)
- direct writes: 2 ($2D55, $30C9)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $FF
- confidence: 0.54
- reason: Static RAM address $2F6A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $30AB
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($2D67, $3354)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $05
- confidence: 0.52
- reason: Static RAM address $30AB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $30E4
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $30E4 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $30FA
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($2D6A, $30D3)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $30FA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $313E
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($3144)
- direct writes: 1 ($3141)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $313E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3155
- domain: `main_ram`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($5F27)
- indexed writes: 1 ($8DD5)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $3155 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $315E
- domain: `main_ram`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($5F2F)
- indexed writes: 1 ($8DE0)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $315E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3167
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($2E6F)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $3167 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3263
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $3263 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $326F
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $326F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $328D
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $328D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $329C
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($326A, $327D)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $26, $27
- confidence: 0.52
- reason: Static RAM address $329C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $32AA
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($3265, $3274)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.52
- reason: Static RAM address $32AA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $32C2
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $32C2 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $3338
- domain: `main_ram`
- access: `readwrite`
- direct reads: 3 ($6954, $8778, $878B)
- direct writes: 3 ($32D3, $333A, $8792)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $3338 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=3, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3364
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($335B)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $50
- confidence: 0.50
- reason: Static RAM address $3364 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3379
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 3 ($32CF, $3384, $3396)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $FF
- confidence: 0.54
- reason: Static RAM address $3379 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $33A7
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $33A7 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $33B6
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $33B6 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $33BA
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($33B6)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $33BA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $33FA
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 3 ($3325, $3399, $33CB)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $33FA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=3, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $345D
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 3 ($332A, $339E, $33C2)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $345D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=3, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $34C0
- domain: `main_ram`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 2 ($3391, $33BD)
- indexed writes: 2 ($32C9, $3333)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00, $01
- confidence: 0.56
- reason: Static RAM address $34C0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3523
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($2D4C)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $3523 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $352B
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($8E33)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $352B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $352C
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($2D4F)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($3347)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $352C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $35CA
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($3770)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $35CA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $362C
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($376A)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $362C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3662
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($3764)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $3662 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $36A6
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($3740)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $36A6 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $36B3
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($377D)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $36B3 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $38E8
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $38E8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $38EE
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($38E0)
- direct writes: 2 ($38CB, $38E5)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $38EE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $38EF
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($38D3)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $38EF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3947
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $3947 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $3948
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($3922)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($391B)
- immediate write values: $08
- confidence: 0.52
- reason: Static RAM address $3948 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $394F
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($393F)
- direct writes: 2 ($392A, $3944)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $394F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3950
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($3932)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $3950 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3955
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($394B)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $3955 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $396D
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $396D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $3973
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $3973 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $39AD
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $39AD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $39C9
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($39A9)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.50
- reason: Static RAM address $39C9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $39D5
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $39D5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $39F9
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $39F9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $3A04
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $3A04 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $3A0A
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $3A0A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $3A29
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $3A29 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $3A2E
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $3A2E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $3A58
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $3A58 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $3A7C
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($3A78)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $3A7C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3A7D
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($3A72)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $3A7D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3A86
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $3A86 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $3A99
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($3AA1)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $FF
- confidence: 0.50
- reason: Static RAM address $3A99 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3AA5
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($3AAD)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $FF
- confidence: 0.50
- reason: Static RAM address $3AA5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3AEA
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $3AEA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $3BAE
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $3BAE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $3BD8
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($3BCC)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $3BD8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3BDE
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($3BD2)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $3BDE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3CC3
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $3CC3 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $3CEA
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $3CEA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $3D66
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($3B78)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $3D66 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3D6C
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($3B72)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $3D6C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $3D72
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 3 ($3B7F, $3B88, $3CEA)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $3D72 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=3, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4046
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($14AB)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $F0
- confidence: 0.50
- reason: Static RAM address $4046 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $404A
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($14B0)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.50
- reason: Static RAM address $404A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $404C
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($14B5)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.50
- reason: Static RAM address $404C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $404E
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($14BA)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $30
- confidence: 0.50
- reason: Static RAM address $404E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4050
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($14BF)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $48
- confidence: 0.50
- reason: Static RAM address $4050 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4135
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $4135 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $4159
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($4667)
- direct writes: 1 ($4143)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($467F)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $4159 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4163
- domain: `main_ram`
- access: `readwrite`
- direct reads: 2 ($200E, $418E)
- direct writes: 1 ($4146)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($4193)
- immediate write values: -
- confidence: 0.56
- reason: Static RAM address $4163 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $416C
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $416C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $4170
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $4170 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $4171
- domain: `main_ram`
- access: `readwrite`
- direct reads: 2 ($41B7, $6DBC)
- direct writes: 1 ($413D)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($41BC)
- immediate write values: $00
- confidence: 0.56
- reason: Static RAM address $4171 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4178
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $4178 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $4179
- domain: `main_ram`
- access: `readwrite`
- direct reads: 2 ($4180, $41C4)
- direct writes: 1 ($4140)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($41D6)
- immediate write values: -
- confidence: 0.56
- reason: Static RAM address $4179 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $417D
- domain: `main_ram`
- access: `readwrite`
- direct reads: 3 ($3900, $41BF, $91CA)
- direct writes: 2 ($418A, $419D)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.58
- reason: Static RAM address $417D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=3, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4180
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $4180 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $419B
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $419B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $41A1
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $41A1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $41AE
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($41CF)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($41AA)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $41AE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $41F4
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($41E9, $41F0)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $01
- confidence: 0.52
- reason: Static RAM address $41F4 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $41F8
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($4187, $4200)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $01
- confidence: 0.52
- reason: Static RAM address $41F8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $420C
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $420C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $420D
- domain: `main_ram`
- access: `readwrite`
- direct reads: 3 ($435B, $466E, $7736)
- direct writes: 1 ($436A)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($4232)
- immediate write values: $0F
- confidence: 0.58
- reason: Static RAM address $420D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=3, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4211
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4365)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($4214)
- immediate write values: $03
- confidence: 0.52
- reason: Static RAM address $4211 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $424B
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($45BF)
- direct writes: 1 ($464B)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($45ED)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $424B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $42A8
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($45FC)
- direct writes: 1 ($464E)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $42A8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $436E
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($4217)
- direct writes: 1 ($4360)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $436E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $44B1
- domain: `main_ram`
- access: `readwrite`
- direct reads: 5 ($41DC, $4340, $459D, $5F62, $9415)
- direct writes: 2 ($4353, $4660)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.62
- reason: Static RAM address $44B1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=5, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4599
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($434F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $12
- confidence: 0.50
- reason: Static RAM address $4599 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $459D
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $459D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $45B8
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($45AF)
- direct writes: 1 ($434A)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.52
- reason: Static RAM address $45B8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $461E
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $461E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $4647
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $4647 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $466D
- domain: `main_ram`
- access: `readwrite`
- direct reads: 6 ($3A29, $41DF, $4343, $474D, $4A35, $8F5F)
- direct writes: 2 ($4663, $468A)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $06
- confidence: 0.74
- reason: Static RAM address $466D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=6, writes=2.
- reason: At least one touch comes from recursively confirmed code.
- contexts:

### $4697
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $4697 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $4756
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4682)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $4756 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $478D
- domain: `main_ram`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($4603)
- indexed writes: 1 ($4655)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $478D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4791
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($4614)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $4791 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4799
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($4658)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $4799 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $47C1
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($460F)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $47C1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $47C5
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($4608)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $47C5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $47CE
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($421C)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $47CE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $47E4
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $47E4 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $47FB
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $47FB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $4806
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($47FB)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $3B
- confidence: 0.50
- reason: Static RAM address $4806 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4826
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $4826 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $48F2
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($4A4E)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $48F2 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $48F6
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($7766)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $48F6 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $48FA
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($468F, $4848)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $01
- confidence: 0.52
- reason: Static RAM address $48FA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4940
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($4843)
- direct writes: 1 ($47E6)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.52
- reason: Static RAM address $4940 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $49DF
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($467A)
- direct writes: 2 ($487E, $91DD)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $49DF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $49EC
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($486B)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $49EC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4A3D
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($47E9, $4A42)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.52
- reason: Static RAM address $4A3D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4A4B
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($15F9)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $60
- confidence: 0.50
- reason: Static RAM address $4A4B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4AB1
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $4AB1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $4AE0
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($148D)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $4AE0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4AE2
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $4AE2 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $4B6F
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($4B7B)
- direct writes: 1 ($4B80)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $4B6F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4B70
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($4B85)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $4B70 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4BA4
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1490)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $4BA4 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4C6A
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($22A7)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $4C6A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4CDC
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $4CDC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $4D5D
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $4D5D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $4D63
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $4D63 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $4D7C
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $4D7C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $4D88
- domain: `main_ram`
- access: `readwrite`
- direct reads: 3 ($65E7, $6790, $6DF0)
- direct writes: 3 ($4D65, $4D76, $4E70)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $01, $02, $05
- confidence: 0.60
- reason: Static RAM address $4D88 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=3, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4E5A
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4E51)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $4E5A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4E63
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4E54)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $4E63 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4ECE
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $4ECE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $4EEE
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($4D96)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $4EEE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4EF6
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($6506)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.50
- reason: Static RAM address $4EF6 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $4F50
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4F07)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $28
- confidence: 0.50
- reason: Static RAM address $4F50 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $502E
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $502E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $503A
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($502E, $5040)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $503A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5050
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $5050 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $5057
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $5057 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $5084
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $5084 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $509A
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $509A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $50AC
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $50AC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $50AD
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($5034, $503B)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.52
- reason: Static RAM address $50AD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $50DE
- domain: `main_ram`
- access: `readwrite`
- direct reads: 2 ($50D6, $7860)
- direct writes: 5 ($421F, $4D6A, $4D99, $5071, $7868)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.62
- reason: Static RAM address $50DE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=5.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $50E0
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($15EF)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $27
- confidence: 0.50
- reason: Static RAM address $50E0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $50E1
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($15F4)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $51
- confidence: 0.50
- reason: Static RAM address $50E1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $50E3
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $50E3 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $50EE
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($422F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $50EE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $50EF
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($5A3A)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $50EF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $50F0
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 4 ($5044, $504A, $5084, $50B3)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.56
- reason: Static RAM address $50F0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=4, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $50F1
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($50AE)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $50F1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $50F5
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 4 ($221B, $38C6, $3925, $6C5C)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.56
- reason: Static RAM address $50F5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=4, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $510E
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 4 ($2221, $38CE, $392D, $6C63)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.56
- reason: Static RAM address $510E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=4, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5185
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $5185 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $51AC
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($518A)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $51AC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $51AD
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($51F5)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $51AD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $51B0
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($51A0)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $51B0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $51B2
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($519A)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $51B2 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $51B3
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($51FB)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $51B3 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $51B5
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($519D)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $51B5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $51B6
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5210)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $51B6 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $51B9
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($51A6)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $51B9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $51BB
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($518D)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $51BB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $51BC
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($520A)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $51BC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $51BE
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5192)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $51BE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $51BF
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($51F8)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $51BF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $51C2
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($51A3)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $51C2 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $51C4
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5195)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $51C4 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $51C5
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($520D)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $51C5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $522F
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($51F2)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $522F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5232
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5207)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $5232 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5237
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $5237 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $5242
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $5242 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $5252
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $5252 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $5385
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $5385 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $53A6
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($52D6)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $53A6 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $53AA
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($52DF)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $53AA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $53AE
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($527E)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $53AE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $53B2
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($5266)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $53B2 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $53B6
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($526F)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $53B6 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5463
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 3 ($5529, $553E, $5553)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $5463 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=3, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5471
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $5471 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $55FF
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $55FF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $57D9
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $57D9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $5800
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $5800 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $5806
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($57FC)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($5880)
- immediate write values: $0C
- confidence: 0.52
- reason: Static RAM address $5806 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $580D
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($587A)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $580D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5851
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($5888)
- direct writes: 1 ($588D)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $5851 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5852
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($5895)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $5852 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $585A
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5890)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $585A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $585B
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($5898)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $585B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5968
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $5968 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $5976
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($599C)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $5976 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5999
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($599F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $5999 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $59AF
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($4868)
- direct writes: 1 ($5D9B)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $59AF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $59BD
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($5A26, $5D93)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.52
- reason: Static RAM address $59BD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $59C0
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $59C0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $5A4C
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $5A4C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $5D0A
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5D59)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $5D0A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5D67
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $5D67 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $5D8D
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $5D8D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $5DA9
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5DA4)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $5DA9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5DBC
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $5DBC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $5DBD
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 3 ($5D7E, $5DB3, $5F2C)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $5DBD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5DC8
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 3 ($5D88, $5DB8, $5F34)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $5DC8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5F38
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $5F38 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $5F46
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5F3E)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $5F46 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5F54
- domain: `main_ram`
- access: `readwrite`
- direct reads: 2 ($5F6C, $5F7C)
- direct writes: 1 ($5F4F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $5F54 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5F6A
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1614)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $80
- confidence: 0.50
- reason: Static RAM address $5F6A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5F97
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5D98)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.50
- reason: Static RAM address $5F97 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5F98
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($5D79)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $5F98 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5F9D
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($5D83)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $5F9D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5FA2
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($5F42)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $5FA2 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5FA9
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($5F47)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $5FA9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5FB0
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($5F55)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $5FB0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5FB7
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($5F5B)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $5FB7 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5FBE
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($5F6F)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $5FBE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5FC5
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($5F75)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $5FC5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5FCC
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($5F7F)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $5FCC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $5FD3
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($5F85)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $5FD3 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6334
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6334 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6350
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6350 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6352
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($1C35)
- direct writes: 2 ($6343, $6359)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $2F
- confidence: 0.54
- reason: Static RAM address $6352 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $635D
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($6362)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $14
- confidence: 0.50
- reason: Static RAM address $635D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6371
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($6365)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $6371 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6373
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($6368)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $6373 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6384
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($633A)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $6384 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $638A
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($633E)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $638A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $639E
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($87A2)
- direct writes: 1 ($6336)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $03
- confidence: 0.52
- reason: Static RAM address $639E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $63B1
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $63B1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $63BD
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $63BD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $64AF
- domain: `main_ram`
- access: `read`
- direct reads: 2 ($1BE6, $1EC0)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $64AF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $64B0
- domain: `main_ram`
- access: `read`
- direct reads: 2 ($1BE9, $1EC5)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $64B0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $64B1
- domain: `main_ram`
- access: `read`
- direct reads: 2 ($1BEC, $1ECA)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $64B1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6504
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6504 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6548
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6548 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6565
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6565 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6566
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($654E)
- direct writes: 3 ($6517, $656D, $9146)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($6DA5)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $6566 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=4.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $658C
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($657B)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $658C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $65B7
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $65B7 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $65C1
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $65C1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $65C2
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($65B9)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($65C5)
- immediate write values: $02
- confidence: 0.52
- reason: Static RAM address $65C2 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $66C9
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($677A, $698A)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $0F
- confidence: 0.52
- reason: Static RAM address $66C9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $66DC
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $66DC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $66E5
- domain: `main_ram`
- access: `readwrite`
- direct reads: 2 ($3747, $38FA)
- direct writes: 3 ($2876, $650C, $6575)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $7D
- confidence: 0.58
- reason: Static RAM address $66E5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $670F
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($6509)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $670F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $675D
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($6971, $6978)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $01, $FF
- confidence: 0.52
- reason: Static RAM address $675D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6761
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($6994)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $4B
- confidence: 0.50
- reason: Static RAM address $6761 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6786
- domain: `main_ram`
- access: `readwrite`
- direct reads: 3 ($6797, $679E, $67AE)
- direct writes: 1 ($6985)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($67AB)
- immediate write values: $21
- confidence: 0.58
- reason: Static RAM address $6786 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=3, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $67C4
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($67D6)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($67E3)
- immediate write values: $05
- confidence: 0.52
- reason: Static RAM address $67C4 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $686A
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $686A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6873
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 3 ($6878, $6DE6, $87AF)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($686F)
- immediate write values: $00, $30
- confidence: 0.56
- reason: Static RAM address $6873 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=4.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $68A2
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($650F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $68A2 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $68B4
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($69AE)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $04
- confidence: 0.50
- reason: Static RAM address $68B4 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $68B6
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($6DD5)
- direct writes: 2 ($68D8, $6E00)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00, $0B
- confidence: 0.54
- reason: Static RAM address $68B6 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $68D7
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($68CF)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $68D7 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $691F
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($6CAB)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $691F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $699B
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($697B)
- direct writes: 2 ($6968, $6980)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $699B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $69E8
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($6533, $87BD)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $C5, $D5
- confidence: 0.52
- reason: Static RAM address $69E8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6AD0
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6AD0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6AD7
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6AD7 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6B07
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($6B13)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($6B16)
- immediate write values: $07
- confidence: 0.52
- reason: Static RAM address $6B07 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6B73
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6B73 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6B7A
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($6B83)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $84
- confidence: 0.50
- reason: Static RAM address $6B7A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6BAC
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($6B37)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($6B4B)
- immediate write values: $00
- confidence: 0.52
- reason: Static RAM address $6BAC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6BAD
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($6B3A)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $6BAD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6BAE
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($655C)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $0C
- confidence: 0.50
- reason: Static RAM address $6BAE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6BAF
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 2 ($658E, $6597)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $6BAF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6BCB
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($677D)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $6BCB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6BDB
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($67A6)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $6BDB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6BFD
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($6772, $698F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $02
- confidence: 0.52
- reason: Static RAM address $6BFD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6BFE
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($68DB)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $6BFE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6C0F
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 2 ($68E0, $6DD9)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $6C0F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6C4D
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6C4D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6CA8
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6CA8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6CC4
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($6CB9)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $6CC4 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6CC8
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6CC8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6D93
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6D93 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6DAB
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6DAB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6DF0
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6DF0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6E1C
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6E1C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6E55
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6E55 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6E61
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6E61 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6E68
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6E68 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $6EE1
- domain: `main_ram`
- access: `readwrite`
- direct reads: 2 ($4677, $4A4B)
- direct writes: 1 ($6DCD)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $6EE1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $6FE1
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $6FE1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $704F
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 4 ($3109, $6538, $66A0, $6BA8)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.56
- reason: Static RAM address $704F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=4.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7086
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $7086 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $7089
- domain: `main_ram`
- access: `readwrite`
- direct reads: 2 ($433B, $96E7)
- direct writes: 1 ($4198)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.54
- reason: Static RAM address $7089 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $709A
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($96F7)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $709A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $709F
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($9706)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $709F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $70A9
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $70A9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $70AF
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($971D)
- direct writes: 1 ($9722)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $70AF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $71B3
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $71B3 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $71C1
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $71C1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $71CF
- domain: `main_ram`
- access: `readwrite`
- direct reads: 4 ($6512, $6551, $65E2, $900D)
- direct writes: 4 ($65F1, $71BB, $71C3, $71DC)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00, $01, $FF
- confidence: 0.64
- reason: Static RAM address $71CF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=4, writes=4.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $71D5
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($71C8)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $3F
- confidence: 0.50
- reason: Static RAM address $71D5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7222
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $7222 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $722B
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $722B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $727B
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($2046)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $727B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $72F5
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($72EC)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $72F5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7300
- domain: `main_ram`
- access: `readwrite`
- direct reads: 3 ($72E0, $72EF, $73CF)
- direct writes: 2 ($72F6, $7623)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $7300 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=3, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7307
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($730A)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $7307 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $73B6
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($73B0)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($73B9)
- immediate write values: $00
- confidence: 0.52
- reason: Static RAM address $73B6 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $73D9
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 2 ($73E1, $9092)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $73D9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $73DB
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($6DF7)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($73DE)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $73DB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7512
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($750C)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($7515)
- immediate write values: $00
- confidence: 0.52
- reason: Static RAM address $7512 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7553
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($7556)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $7553 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $757B
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $757B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $7589
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $7589 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $75CE
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($75AC)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.50
- reason: Static RAM address $75CE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $75D9
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($75C9)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.50
- reason: Static RAM address $75D9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $75E8
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $75E8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $771A
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $771A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $7733
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($41D9)
- direct writes: 1 ($791B)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($7751)
- immediate write values: $FF
- confidence: 0.54
- reason: Static RAM address $7733 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $775F
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $775F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $790B
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $790B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $7919
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $7919 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $791F
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($790D)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $07
- confidence: 0.50
- reason: Static RAM address $791F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7925
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 3 ($4685, $774E, $7920)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $03, $0F
- confidence: 0.54
- reason: Static RAM address $7925 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7936
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($771E)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $05
- confidence: 0.50
- reason: Static RAM address $7936 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7974
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($7A2E, $7AA2)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00, $05
- confidence: 0.52
- reason: Static RAM address $7974 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $79B8
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($772A, $83AE)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.52
- reason: Static RAM address $79B8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7B44
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $7B44 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $7B5B
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($7A8A)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $7B5B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7B8C
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $7B8C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $7B95
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $7B95 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $7BA3
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $7BA3 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $7BC5
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($7C28)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $7BC5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7BC8
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($7CBA)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $7BC8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7BCB
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($7D18)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $7BCB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7BCE
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 2 ($7D73, $7DE5)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $7BCE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7BD1
- domain: `main_ram`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($786B)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($7877)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $7BD1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7BD6
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 6 ($7C31, $7CD6, $7D2D, $7D83, $7E02, $7FFF)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $7BD6 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=6.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7BDB
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($3078)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $FF
- confidence: 0.50
- reason: Static RAM address $7BDB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7BE0
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($7913)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.50
- reason: Static RAM address $7BE0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7C38
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($7A29)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $7C38 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7D6C
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $7D6C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $7DEB
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($7A9D)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $7DEB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7DF2
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($7A9A)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $7DF2 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7DF8
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($7A85)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $7DF8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7F5A
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $7F5A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $7F7D
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($7F91)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($7F8A)
- immediate write values: $05
- confidence: 0.52
- reason: Static RAM address $7F7D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7F84
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($7F87)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $7F84 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $7FC5
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($7F7E)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $7FC5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8073
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($806C)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8073 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $809B
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $809B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $80C4
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($80B6)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $80C4 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $80C6
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($80B9)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $80C6 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8182
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($80FE)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8182 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $81BE
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($598F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.50
- reason: Static RAM address $81BE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $83C4
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($7B9F)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($83A3)
- immediate write values: $32
- confidence: 0.52
- reason: Static RAM address $83C4 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $841C
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $841C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $843F
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($8422)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $843F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $844E
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $844E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $84A2
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $84A2 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $84B5
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 4 ($687B, $80E5, $8691, $86AB)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.56
- reason: Static RAM address $84B5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=4, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $84C1
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 5 ($4B4B, $80C7, $80CF, $80D4, $86BD)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $84C1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=5, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $84F5
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($7B8E)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $84F5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $84FA
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($3CCE)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $84FA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8502
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $8502 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $850E
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($860C)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $850E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8619
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $8619 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $8690
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($868C)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $30
- confidence: 0.50
- reason: Static RAM address $8690 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $86D0
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $86D0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $872E
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($86A0)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $872E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $873C
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($86BA)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $873C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $874A
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($86CC)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $874A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8772
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $8772 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $87CD
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $87CD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $87F8
- domain: `main_ram`
- access: `readwrite`
- direct reads: 2 ($887D, $8890)
- direct writes: 2 ($8623, $88A3)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $3A, $4B
- confidence: 0.56
- reason: Static RAM address $87F8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $87FD
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($15FE)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $B5
- confidence: 0.50
- reason: Static RAM address $87FD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $87FE
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1609)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $89
- confidence: 0.50
- reason: Static RAM address $87FE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $880D
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1601)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $880D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $880E
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($160C)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $880E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8820
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($889C)
- direct writes: 2 ($8628, $8884)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $13
- confidence: 0.54
- reason: Static RAM address $8820 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8832
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1604)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8832 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8833
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($160F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8833 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8843
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($861E)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8843 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $886B
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($87AA)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $886B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $887A
- domain: `main_ram`
- access: `readwrite`
- direct reads: 2 ($88B1, $9582)
- direct writes: 2 ($861B, $879E)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $32, $FF
- confidence: 0.56
- reason: Static RAM address $887A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $88B1
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $88B1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $88B9
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($862D)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($88E7)
- immediate write values: $08
- confidence: 0.52
- reason: Static RAM address $88B9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $88DA
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($88BF)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $88DA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $88DB
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($88C5)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $88DB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $88DD
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($88CB)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $88DD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $88DE
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($88D1)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $88DE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8912
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($8630)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8912 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8955
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($87A5)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8955 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8A01
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($88BC)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8A01 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8A0A
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($88C2)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8A0A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8A13
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($88C8)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8A13 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8A1C
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($88CE)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8A1C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8A25
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($88D4)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8A25 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8A5A
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $8A5A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $8AC6
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $8AC6 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $8AE9
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($8AEC)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8AE9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8B06
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $8B06 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $8B0B
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($8AC8, $8AF4)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00, $16
- confidence: 0.52
- reason: Static RAM address $8B0B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8B7E
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($8ACB, $8AF8)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $8B7E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8BD1
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $8BD1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $8BE5
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $8BE5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $8C66
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($8AA9)
- direct writes: 1 ($8E3F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $8C66 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8CD9
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($8CD0)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8CD9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8CDA
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($8CD3)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8CDA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8CEF
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($8BE7)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($8CF7)
- immediate write values: $08
- confidence: 0.52
- reason: Static RAM address $8CEF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8D2E
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $8D2E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $8D5E
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($8C3D)
- direct writes: 0 (-)
- indexed reads: 5 ($8C1D, $8C23, $8C4D, $8CD8, $8D1B)
- indexed writes: 5 ($8BED, $8C0C, $8C29, $8D1E, $8D23)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.70
- reason: Static RAM address $8D5E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=6, writes=5.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8D5F
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($8C40)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8D5F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8D60
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($8C43)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8D60 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8D64
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($8C30)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8D64 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8D65
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($8C33)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8D65 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8D66
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($8C36)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8D66 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8D67
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($8BEA)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8D67 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8D70
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($8C52, $8D26)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $8D70 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8D71
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($8CDF)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8D71 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8D7A
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($8CE5)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8D7A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8D83
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($8CFA)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8D83 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8D8C
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($8D02)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8D8C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8D94
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $8D94 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $8DB0
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($8DBD)
- direct writes: 1 ($8DA4)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($8DC3)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $8DB0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8DE6
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $8DE6 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $8E26
- domain: `main_ram`
- access: `read`
- direct reads: 2 ($8A9B, $8CA3)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $8E26 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8E50
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $8E50 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $8E51
- domain: `main_ram`
- access: `readwrite`
- direct reads: 2 ($8A9E, $8CC5)
- direct writes: 1 ($8E44)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($8C55)
- immediate write values: $12
- confidence: 0.56
- reason: Static RAM address $8E51 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8F41
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $8F41 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $8F47
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $8F47 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $8F6A
- domain: `main_ram`
- access: `readwrite`
- direct reads: 3 ($41E4, $9384, $93F3)
- direct writes: 2 ($8DE8, $8E47)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.58
- reason: Static RAM address $8F6A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=3, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8FA2
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($8F7A)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8FA2 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8FA3
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($8F80)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8FA3 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8FA4
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($8F86)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8FA4 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8FA5
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($8F8C)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8FA5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8FA6
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($8F92)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8FA6 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8FA7
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($8F98)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8FA7 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8FAF
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($8E3C)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8FAF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8FB8
- domain: `main_ram`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 2 ($8DB5, $8DC9)
- indexed writes: 2 ($8D9D, $8DC0)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $FF
- confidence: 0.56
- reason: Static RAM address $8FB8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=2, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8FC1
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($8DCD)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8FC1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8FCA
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($8DD8)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8FCA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8FD3
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8DD0)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8FD3 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8FDC
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8DDB)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $8FDC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8FE5
- domain: `main_ram`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 3 ($8CA6, $8E2B, $8F64)
- indexed writes: 1 ($8D98)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $01
- confidence: 0.56
- reason: Static RAM address $8FE5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=3, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $8FEE
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $8FEE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $9014
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($3905)
- direct writes: 2 ($87B5, $9073)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.54
- reason: Static RAM address $9014 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $901B
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($65BE, $71E1)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00, $FF
- confidence: 0.52
- reason: Static RAM address $901B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $906F
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $906F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $9087
- domain: `main_ram`
- access: `readwrite`
- direct reads: 3 ($6B40, $74F3, $7518)
- direct writes: 1 ($909C)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.56
- reason: Static RAM address $9087 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=3, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $90D5
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($9088)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.50
- reason: Static RAM address $90D5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $9128
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $9128 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $9136
- domain: `main_ram`
- access: `read`
- direct reads: 9 ($1D89, $52B8, $651D, $65DD, $695D, $6C56, ...)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.66
- reason: Static RAM address $9136 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=9, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $91CA
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $91CA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $91E4
- domain: `main_ram`
- access: `read`
- direct reads: 5 ($7C25, $7CB7, $7D15, $7D70, $7DE2)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.58
- reason: Static RAM address $91E4 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=5, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $91EE
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $91EE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $9261
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5992)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $9261 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $92E7
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $92E7 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $93F0
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($9392)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $93F0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $9472
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $9472 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $94E1
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $94E1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $9612
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($9461)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $9612 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $9811
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $9811 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $A20E
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($8D92)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $A20E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C000
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($4E58)
- direct writes: 1 ($4E61)
- indexed reads: 0 (-)
- indexed writes: 3 ($2237, $88D9, $88DC)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.58
- reason: Static RAM address $C000 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=4.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C23E
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($5521)
- direct writes: 1 ($5526)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $C23E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C274
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($5536)
- direct writes: 1 ($553B)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $C274 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C28A
- domain: `main_ram`
- access: `readwrite`
- direct reads: 1 ($554B)
- direct writes: 1 ($5550)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $C28A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C3A8
- domain: `main_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($5DA7)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C3A8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C3F7
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8CB2)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $FC
- confidence: 0.50
- reason: Static RAM address $C3F7 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C3F8
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($22B2, $477B)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $DF
- confidence: 0.62
- reason: Static RAM address $C3F8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: At least one touch comes from recursively confirmed code.
- contexts:
  - around $477B:
    - `  $4771  lda imm $00DE`
    - `  $4773  sta abs $C3F9`
    - `  $4776  sta abs $C7F9`
    - `  $4779  lda imm $00DF`
    - `> $477B  sta abs $C3F8`
    - `  $477E  sta abs $C7F8`
    - `  $4781  lda imm $000B`
    - `  $4783  sta abs $D027`
    - `  $4786  lda imm $0000`
    - `  $4788  sta abs $D028`

### $C3F9
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($22AE, $4773)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $DE
- confidence: 0.62
- reason: Static RAM address $C3F9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: At least one touch comes from recursively confirmed code.
- contexts:
  - around $4773:
    - `  $476A  and imm $00FC`
    - `  $476C  ora imm $0000`
    - `  $476E  sta abs $D010`
    - `  $4771  lda imm $00DE`
    - `> $4773  sta abs $C3F9`
    - `  $4776  sta abs $C7F9`
    - `  $4779  lda imm $00DF`
    - `  $477B  sta abs $C3F8`
    - `  $477E  sta abs $C7F8`
    - `  $4781  lda imm $000B`

### $C3FA
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($7093)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.50
- reason: Static RAM address $C3FA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C3FB
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4A6C)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.50
- reason: Static RAM address $C3FB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C3FC
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4A73)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C3FC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C3FD
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1ED0)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C3FD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C3FE
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($311B)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C3FE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C3FF
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 2 ($3117, $838D)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $68
- confidence: 0.52
- reason: Static RAM address $C3FF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C400
- domain: `main_ram`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($219F)
- indexed writes: 1 ($2133)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $C400 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C409
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($2136)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C409 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C410
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($2150)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C410 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C43E
- domain: `main_ram`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($2192)
- indexed writes: 1 ($213C)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $C43E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C447
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($213F)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C447 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C44E
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($2153)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C44E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C47C
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($2145)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C47C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C485
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($2148)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C485 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C48C
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($2156)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C48C is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C7F7
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8CB5)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C7F7 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C7F8
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($477E)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $C7F8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: At least one touch comes from recursively confirmed code.
- contexts:
  - around $477E:
    - `  $4773  sta abs $C3F9`
    - `  $4776  sta abs $C7F9`
    - `  $4779  lda imm $00DF`
    - `  $477B  sta abs $C3F8`
    - `> $477E  sta abs $C7F8`
    - `  $4781  lda imm $000B`
    - `  $4783  sta abs $D027`
    - `  $4786  lda imm $0000`
    - `  $4788  sta abs $D028`
    - `  $478B  pla`

### $C7F9
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4776)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.60
- reason: Static RAM address $C7F9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: At least one touch comes from recursively confirmed code.
- contexts:
  - around $4776:
    - `  $476C  ora imm $0000`
    - `  $476E  sta abs $D010`
    - `  $4771  lda imm $00DE`
    - `  $4773  sta abs $C3F9`
    - `> $4776  sta abs $C7F9`
    - `  $4779  lda imm $00DF`
    - `  $477B  sta abs $C3F8`
    - `  $477E  sta abs $C7F8`
    - `  $4781  lda imm $000B`
    - `  $4783  sta abs $D027`

### $C7FA
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($7096)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C7FA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C7FB
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4A6F)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C7FB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C7FC
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($4A76)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C7FC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C7FD
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1ED3)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C7FD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C7FF
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($8390)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C7FF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C807
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8606)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C807 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C858
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($52E5)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C858 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C85F
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($52DC)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C85F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C860
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($52D9)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C860 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C867
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($52E2)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C867 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C873
- domain: `main_ram`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 1 ($529F)
- indexed reads: 1 ($5296)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $C873 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C874
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($5299)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C874 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C877
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($5291)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C877 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C878
- domain: `main_ram`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 1 ($52B5)
- indexed reads: 1 ($52AC)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $C878 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C879
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($52AF)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C879 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C87F
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($52A9)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C87F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C880
- domain: `main_ram`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 1 ($52CB)
- indexed reads: 1 ($52C2)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $C880 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C881
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($52C5)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C881 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C89F
- domain: `main_ram`
- access: `read`
- direct reads: 1 ($52BF)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C89F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C8AD
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8F7D)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C8AD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C8B5
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8F83)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C8B5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C8C9
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8F89)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C8C9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C8CD
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8F95)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C8CD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C8D1
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8F8F)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C8D1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $C8D5
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8F9B)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $C8D5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CC40
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($57DD)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CC40 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CD00
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($57E0)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CD00 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CE00
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($57E3)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CE00 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CEB0
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($3739)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CEB0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CEB8
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($3733)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CEB8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CF00
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($57E6)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CF00 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CFE0
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($525A)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.50
- reason: Static RAM address $CFE0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CFE1
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($525D)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CFE1 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CFE2
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5269)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CFE2 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CFE3
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5272)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CFE3 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CFE4
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5275)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CFE4 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CFE5
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($5283)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CFE5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CFE8
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($5286)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CFE8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CFEB
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5278)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CFEB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CFEC
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($527B)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CFEC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CFED
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($526C)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CFED is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CFEE
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5263)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CFEE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CFEF
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($5260)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CFEF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CFF0
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($45A6)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CFF0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CFF8
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 2 ($45A9, $4F0E)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $CFF8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CFFA
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($4F18)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CFFA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CFFE
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8CE2)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CFFE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $CFFF
- domain: `main_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8CE8)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $CFFF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $E150
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($6B25)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.50
- reason: Static RAM address $E150 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $E38D
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($5510)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $E38D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $F080
- domain: `high_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($6591)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $F080 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $F0C0
- domain: `high_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($659A)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $F0C0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $F0CD
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($6B28)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $F0CD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $F3D8
- domain: `high_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($1CBF)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $F3D8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $F3D9
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($1CC2)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $F3D9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $F3DA
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($1CC5)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $F3DA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $F3EC
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1D84)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $F3EC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $F418
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 2 ($1CCB, $1D9F)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $F418 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $F419
- domain: `high_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($1CC8)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $F419 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $F41A
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($1CCE)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $F41A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FB39
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($2032)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FB39 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FB8F
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($2050)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FB8F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FBB9
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($2035)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FBB9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FC0F
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($2053)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FC0F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FC39
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1FFF)
- indexed reads: 0 (-)
- indexed writes: 1 ($2038)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $FC39 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FC3A
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($2005)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FC3A is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FC3B
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($200B)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FC3B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FCB9
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($201E)
- indexed reads: 0 (-)
- indexed writes: 1 ($203B)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $FCB9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FCBA
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($2024)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FCBA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FCBB
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($202A)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FCBB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FD00
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($5245)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FD00 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FD40
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($6594)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FD40 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FD47
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($4B6E)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FD47 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FD80
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 2 ($2362, $659D)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $7E
- confidence: 0.52
- reason: Static RAM address $FD80 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FD81
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($2365)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FD81 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FD82
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($2368)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FD82 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FDBB
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($500C)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FDBB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FDBC
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($500F)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FDBC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FDBD
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($5012)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FDBD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FDC0
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 3 ($1B01, $236B, $4F43)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.54
- reason: Static RAM address $FDC0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FDC2
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($236E)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FDC2 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FDDD
- domain: `high_ram`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($5015)
- indexed writes: 1 ($501F)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $FDDD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FDDE
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($5022)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FDDE is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FDDF
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($5025)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FDDF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FDE0
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($4F48)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FDE0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FDED
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8AD0)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FDED is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FDFC
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($8AE4)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $F0
- confidence: 0.50
- reason: Static RAM address $FDFC is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FE00
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($5248)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FE00 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FE20
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($4F3E)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $00
- confidence: 0.50
- reason: Static RAM address $FE20 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FE2D
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8AD3)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FE2D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FE4F
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($1C65)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FE4F is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FE52
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($1C68)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FE52 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FE55
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($1C6B)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FE55 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FE6D
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8AD6)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FE6D is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FE80
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($524B)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FE80 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FEAD
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8AD9)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FEAD is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FEED
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8ADC)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FEED is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FF00
- domain: `high_ram`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 3 ($51AE, $51B7, $51C0)
- indexed writes: 1 ($8BF7)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $FF
- confidence: 0.56
- reason: Static RAM address $FF00 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=3, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FF01
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8BFA)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FF01 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FF02
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($8BFF)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $F8
- confidence: 0.50
- reason: Static RAM address $FF02 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FF43
- domain: `high_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($5219)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FF43 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=0.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FF55
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($1DE0)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FF55 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FF58
- domain: `high_ram`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 1 ($1BF4)
- indexed writes: 1 ($1DCE)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.52
- reason: Static RAM address $FF58 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FF8B
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1BD8)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $2A
- confidence: 0.50
- reason: Static RAM address $FF8B is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FF8E
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1BDB)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FF8E is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FF91
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1BE3)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $3A
- confidence: 0.50
- reason: Static RAM address $FF91 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FF94
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($1BDE)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FF94 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FF98
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($1BF7)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FF98 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FFC5
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 1 ($2871)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 1 ($2AA3)
- immediate write values: $5A
- confidence: 0.52
- reason: Static RAM address $FFC5 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=2.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FFC7
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 1 ($14CE)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.50
- reason: Static RAM address $FFC7 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=1.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FFE0
- domain: `high_ram`
- access: `read`
- direct reads: 0 (-)
- direct writes: 0 (-)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.48
- reason: Static RAM address $FFE0 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=0.
- reason: Current evidence comes only from probable-code islands.

### $FFF8
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 12 ($1510, $2378, $269B, $2883, $9207, $939D, ...)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $1D, $2C, $5E, $7D, $99, $A0, $B3, $B7, $BB, $E7
- confidence: 0.72
- reason: Static RAM address $FFF8 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=12.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FFF9
- domain: `high_ram`
- access: `write`
- direct reads: 0 (-)
- direct writes: 12 ($1515, $237D, $26A0, $2888, $920C, $93A2, ...)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $15, $23, $26, $28, $92, $93, $94, $95
- confidence: 0.72
- reason: Static RAM address $FFF9 is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=0, writes=12.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FFFA
- domain: `high_ram`
- access: `readwrite`
- direct reads: 1 ($3973)
- direct writes: 3 ($1BB6, $398B, $91FD)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $46, $BD, $D2
- confidence: 0.56
- reason: Static RAM address $FFFA is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FFFB
- domain: `high_ram`
- access: `readwrite`
- direct reads: 1 ($397A)
- direct writes: 3 ($1BBB, $3990, $9202)
- indexed reads: 0 (-)
- indexed writes: 0 (-)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: $1B, $39, $47
- confidence: 0.56
- reason: Static RAM address $FFFB is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=1, writes=3.
- reason: Current evidence comes only from probable-code islands.
- contexts:

### $FFFF
- domain: `high_ram`
- access: `readwrite`
- direct reads: 0 (-)
- direct writes: 1 ($3A7B)
- indexed reads: 4 ($2168, $51AB, $51B1, $51BD)
- indexed writes: 7 ($38ED, $45B6, $45B9, $51B4, $51BA, $51C3, ...)
- indirect reads: 0 (-)
- indirect writes: 0 (-)
- read/modify/write: 0 (-)
- immediate write values: -
- confidence: 0.72
- reason: Static RAM address $FFFF is touched from decoded code, so it is a good state/label candidate.
- reason: Reads=4, writes=8.
- reason: Current evidence comes only from probable-code islands.
- contexts:

## Purpose Hypotheses

### $0002-$0003  pointer_pair
- label hint: `zp_ptr_02`
- confidence: 0.72
- related: $0002, $0003
- reason: Zero-page pointer $0002-$0003 is assembled by consecutive load/store pairs.
- reason: Pointer bytes are loaded dynamically, so the final target depends on runtime state.
- reason: Pointer setup comes from a probable code island and should be validated in context.

### $0002  counter
- label hint: `counter_0002`
- confidence: 0.60
- related: $0002
- reason: Address $0002 is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $0003  counter
- label hint: `counter_0003`
- confidence: 0.60
- related: $0003
- reason: Address $0003 is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $0003  flag
- label hint: `flag_0003`
- confidence: 0.58
- related: $0003
- reason: Address $0003 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0006  counter
- label hint: `counter_0006`
- confidence: 0.60
- related: $0006
- reason: Address $0006 is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $0008  flag
- label hint: `flag_0008`
- confidence: 0.58
- related: $0008
- reason: Address $0008 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $000B-$FD47  table
- label hint: `table_000B`
- confidence: 0.70
- related: $000B, $FD47
- reason: Indexed or loop-based accesses cluster around $000B, $FD47.
- reason: 2 consecutive absolute-indexed mixed access(es) use Y as the table index.
- reason: Referenced bases cluster around $000B, $FD47.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $000B  flag
- label hint: `flag_000B`
- confidence: 0.58
- related: $000B
- reason: Address $000B is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $000D  counter
- label hint: `counter_000D`
- confidence: 0.60
- related: $000D
- reason: Address $000D is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $000D  flag
- label hint: `flag_000D`
- confidence: 0.58
- related: $000D
- reason: Address $000D is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $000E  flag
- label hint: `flag_000E`
- confidence: 0.58
- related: $000E
- reason: Address $000E is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $000F  flag
- label hint: `flag_000F`
- confidence: 0.58
- related: $000F
- reason: Address $000F is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0012  buffer
- label hint: `zp_work_12`
- confidence: 0.46
- related: $0012
- reason: Zero-page address $0012 is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $0015-$0016  pointer_pair
- label hint: `zp_ptr_FD47`
- confidence: 0.80
- related: $0015, $0016
- reason: Zero-page pointer $0015-$0016 is assembled by consecutive load/store pairs.
- reason: Both bytes are immediate, yielding constant target $FD47.
- reason: Pointer setup comes from a probable code island and should be validated in context.

### $0017  counter
- label hint: `counter_0017`
- confidence: 0.60
- related: $0017
- reason: Address $0017 is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $0017  flag
- label hint: `flag_0017`
- confidence: 0.58
- related: $0017
- reason: Address $0017 is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0018  counter
- label hint: `counter_0018`
- confidence: 0.60
- related: $0018
- reason: Address $0018 is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $001B  counter
- label hint: `counter_001B`
- confidence: 0.60
- related: $001B
- reason: Address $001B is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $0021  buffer
- label hint: `zp_work_21`
- confidence: 0.46
- related: $0021
- reason: Zero-page address $0021 is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $0022  buffer
- label hint: `zp_work_22`
- confidence: 0.46
- related: $0022
- reason: Zero-page address $0022 is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $0024  buffer
- label hint: `zp_work_24`
- confidence: 0.46
- related: $0024
- reason: Zero-page address $0024 is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $0027-$0028  pointer_pair
- label hint: `zp_ptr_00AC`
- confidence: 0.80
- related: $0027, $0028
- reason: Zero-page pointer $0027-$0028 is assembled by consecutive load/store pairs.
- reason: Both bytes are immediate, yielding constant target $00AC.
- reason: Pointer setup comes from a probable code island and should be validated in context.

### $0027  counter
- label hint: `counter_0027`
- confidence: 0.60
- related: $0027
- reason: Address $0027 is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $0028  flag
- label hint: `flag_0028`
- confidence: 0.58
- related: $0028
- reason: Address $0028 is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0029  pointer_target
- label hint: `ptr_target_0029`
- confidence: 0.72
- related: $0029
- reason: Zero-page pointer $0034 resolves to constant target $0029 here.
- reason: This target is a strong candidate for a table, buffer, or dispatch structure.

### $0029  buffer
- label hint: `zp_work_29`
- confidence: 0.46
- related: $0029
- reason: Zero-page address $0029 is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $002A  flag
- label hint: `flag_002A`
- confidence: 0.58
- related: $002A
- reason: Address $002A is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $002A  buffer
- label hint: `zp_work_2A`
- confidence: 0.46
- related: $002A
- reason: Zero-page address $002A is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $002F  buffer
- label hint: `zp_work_2F`
- confidence: 0.46
- related: $002F
- reason: Zero-page address $002F is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $0032-$0033  pointer_pair
- label hint: `zp_ptr_32`
- confidence: 0.72
- related: $0032, $0033
- reason: Zero-page pointer $0032-$0033 is assembled by consecutive load/store pairs.
- reason: Pointer bytes are loaded dynamically, so the final target depends on runtime state.
- reason: Pointer setup comes from a probable code island and should be validated in context.

### $0032  counter
- label hint: `counter_0032`
- confidence: 0.60
- related: $0032
- reason: Address $0032 is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $0032  flag
- label hint: `flag_0032`
- confidence: 0.58
- related: $0032
- reason: Address $0032 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0033  counter
- label hint: `counter_0033`
- confidence: 0.60
- related: $0033
- reason: Address $0033 is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $0033  flag
- label hint: `flag_0033`
- confidence: 0.58
- related: $0033
- reason: Address $0033 is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0034-$0035  pointer_pair
- label hint: `zp_ptr_0029`
- confidence: 0.80
- related: $0034, $0035
- reason: Zero-page pointer $0034-$0035 is assembled by consecutive load/store pairs.
- reason: Both bytes are immediate, yielding constant target $0029.
- reason: Pointer setup comes from a probable code island and should be validated in context.

### $0034  counter
- label hint: `counter_0034`
- confidence: 0.60
- related: $0034
- reason: Address $0034 is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $0035  counter
- label hint: `counter_0035`
- confidence: 0.60
- related: $0035
- reason: Address $0035 is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $0035  flag
- label hint: `flag_0035`
- confidence: 0.58
- related: $0035
- reason: Address $0035 is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0036  flag
- label hint: `flag_0036`
- confidence: 0.58
- related: $0036
- reason: Address $0036 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0037-$0038  pointer_pair
- label hint: `zp_ptr_9990`
- confidence: 0.80
- related: $0037, $0038
- reason: Zero-page pointer $0037-$0038 is assembled by consecutive load/store pairs.
- reason: Both bytes are immediate, yielding constant target $9990.
- reason: Pointer setup comes from a probable code island and should be validated in context.

### $0039  flag
- label hint: `flag_0039`
- confidence: 0.58
- related: $0039
- reason: Address $0039 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $003D-$003E  pointer_pair
- label hint: `zp_ptr_0401`
- confidence: 0.80
- related: $003D, $003E
- reason: Zero-page pointer $003D-$003E is assembled by consecutive load/store pairs.
- reason: Both bytes are immediate, yielding constant target $0401.
- reason: Pointer setup comes from a probable code island and should be validated in context.

### $004A  counter
- label hint: `counter_004A`
- confidence: 0.60
- related: $004A
- reason: Address $004A is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $004A  flag
- label hint: `flag_004A`
- confidence: 0.58
- related: $004A
- reason: Address $004A is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $004B  counter
- label hint: `counter_004B`
- confidence: 0.60
- related: $004B
- reason: Address $004B is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $004B  flag
- label hint: `flag_004B`
- confidence: 0.58
- related: $004B
- reason: Address $004B is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $004D  flag
- label hint: `flag_004D`
- confidence: 0.58
- related: $004D
- reason: Address $004D is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0050  flag
- label hint: `flag_0050`
- confidence: 0.58
- related: $0050
- reason: Address $0050 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0053  flag
- label hint: `flag_0053`
- confidence: 0.58
- related: $0053
- reason: Address $0053 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0054  flag
- label hint: `flag_0054`
- confidence: 0.58
- related: $0054
- reason: Address $0054 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0061  flag
- label hint: `flag_0061`
- confidence: 0.58
- related: $0061
- reason: Address $0061 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0061  buffer
- label hint: `zp_work_61`
- confidence: 0.46
- related: $0061
- reason: Zero-page address $0061 is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $0065  flag
- label hint: `flag_0065`
- confidence: 0.58
- related: $0065
- reason: Address $0065 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0069-$006A  pointer_pair
- label hint: `zp_ptr_60F8`
- confidence: 0.80
- related: $0069, $006A
- reason: Zero-page pointer $0069-$006A is assembled by consecutive load/store pairs.
- reason: Both bytes are immediate, yielding constant target $60F8.
- reason: Pointer setup comes from a probable code island and should be validated in context.

### $0069  counter
- label hint: `counter_0069`
- confidence: 0.60
- related: $0069
- reason: Address $0069 is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $006B  counter
- label hint: `counter_006B`
- confidence: 0.60
- related: $006B
- reason: Address $006B is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $006C  buffer
- label hint: `zp_work_6C`
- confidence: 0.46
- related: $006C
- reason: Zero-page address $006C is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $006D  counter
- label hint: `counter_006D`
- confidence: 0.60
- related: $006D
- reason: Address $006D is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $006D  flag
- label hint: `flag_006D`
- confidence: 0.58
- related: $006D
- reason: Address $006D is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0071  flag
- label hint: `flag_0071`
- confidence: 0.58
- related: $0071
- reason: Address $0071 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0076-$007B  table
- label hint: `table_0076`
- confidence: 0.70
- related: $0076, $007B
- reason: Indexed or loop-based accesses cluster around $0076, $007B.
- reason: 2 consecutive absolute-indexed mixed access(es) use Y as the table index.
- reason: Referenced bases cluster around $0076, $007B.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $0076  flag
- label hint: `flag_0076`
- confidence: 0.58
- related: $0076
- reason: Address $0076 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0076  buffer
- label hint: `zp_work_76`
- confidence: 0.46
- related: $0076
- reason: Zero-page address $0076 is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $007B-$007C  pointer_pair
- label hint: `zp_ptr_170A`
- confidence: 0.80
- related: $007B, $007C
- reason: Zero-page pointer $007B-$007C is assembled by consecutive load/store pairs.
- reason: Both bytes are immediate, yielding constant target $170A.
- reason: Pointer setup comes from a probable code island and should be validated in context.

### $007B  buffer
- label hint: `zp_work_7B`
- confidence: 0.46
- related: $007B
- reason: Zero-page address $007B is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $007D-$007E  pointer_pair
- label hint: `zp_ptr_0E27`
- confidence: 0.80
- related: $007D, $007E
- reason: Zero-page pointer $007D-$007E is assembled by consecutive load/store pairs.
- reason: Both bytes are immediate, yielding constant target $0E27.
- reason: Pointer setup comes from a probable code island and should be validated in context.

### $0096  counter
- label hint: `counter_0096`
- confidence: 0.60
- related: $0096
- reason: Address $0096 is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $00AB  buffer
- label hint: `zp_work_AB`
- confidence: 0.46
- related: $00AB
- reason: Zero-page address $00AB is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $00AC  pointer_target
- label hint: `ptr_target_00AC`
- confidence: 0.72
- related: $00AC
- reason: Zero-page pointer $0027 resolves to constant target $00AC here.
- reason: This target is a strong candidate for a table, buffer, or dispatch structure.

### $00B0  flag
- label hint: `flag_00B0`
- confidence: 0.58
- related: $00B0
- reason: Address $00B0 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $00B0  buffer
- label hint: `zp_work_B0`
- confidence: 0.46
- related: $00B0
- reason: Zero-page address $00B0 is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $00B5  flag
- label hint: `flag_00B5`
- confidence: 0.58
- related: $00B5
- reason: Address $00B5 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $00B5  buffer
- label hint: `zp_work_B5`
- confidence: 0.46
- related: $00B5
- reason: Zero-page address $00B5 is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $00BA  buffer
- label hint: `zp_work_BA`
- confidence: 0.46
- related: $00BA
- reason: Zero-page address $00BA is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $00BF  buffer
- label hint: `zp_work_BF`
- confidence: 0.46
- related: $00BF
- reason: Zero-page address $00BF is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $00C4  buffer
- label hint: `zp_work_C4`
- confidence: 0.46
- related: $00C4
- reason: Zero-page address $00C4 is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $00C9  buffer
- label hint: `zp_work_C9`
- confidence: 0.46
- related: $00C9
- reason: Zero-page address $00C9 is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $00DE  flag
- label hint: `flag_00DE`
- confidence: 0.58
- related: $00DE
- reason: Address $00DE is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $00E3  flag
- label hint: `flag_00E3`
- confidence: 0.58
- related: $00E3
- reason: Address $00E3 is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $00E4  flag
- label hint: `flag_00E4`
- confidence: 0.58
- related: $00E4
- reason: Address $00E4 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $00EC  flag
- label hint: `flag_00EC`
- confidence: 0.58
- related: $00EC
- reason: Address $00EC is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $00EC  buffer
- label hint: `zp_work_EC`
- confidence: 0.46
- related: $00EC
- reason: Zero-page address $00EC is both read and written from multiple sites.
- reason: This is consistent with hot-path scratch state or a byte-sized work variable.

### $00FE  counter
- label hint: `counter_00FE`
- confidence: 0.60
- related: $00FE
- reason: Address $00FE is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $00FE  flag
- label hint: `flag_00FE`
- confidence: 0.58
- related: $00FE
- reason: Address $00FE is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0100  flag
- label hint: `flag_0100`
- confidence: 0.58
- related: $0100
- reason: Address $0100 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0106  flag
- label hint: `flag_0106`
- confidence: 0.58
- related: $0106
- reason: Address $0106 is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0112-$0115  table
- label hint: `table_0112`
- confidence: 0.62
- related: $0112, $0115
- reason: Indexed or loop-based accesses cluster around $0112, $0115.
- reason: 2 consecutive absolute-indexed write access(es) use X as the table index.
- reason: Referenced bases cluster around $0112, $0115.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $011B-$011E  table
- label hint: `table_011B`
- confidence: 0.70
- related: $011B, $011E
- reason: Indexed or loop-based accesses cluster around $011B, $011E.
- reason: 2 consecutive absolute-indexed mixed access(es) use X as the table index.
- reason: Referenced bases cluster around $011B, $011E.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $0124-$0130  table
- label hint: `table_0124`
- confidence: 0.75
- related: $0124, $012A, $0130
- reason: Indexed or loop-based accesses cluster around $0124, $012A, $0130.
- reason: 3 consecutive absolute-indexed mixed access(es) use X as the table index.
- reason: Referenced bases cluster around $0124, $012A, $0130.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $0130-$0133  table
- label hint: `table_0130`
- confidence: 0.62
- related: $0130, $0133
- reason: Indexed or loop-based accesses cluster around $0130, $0133.
- reason: 2 consecutive absolute-indexed write access(es) use X as the table index.
- reason: Referenced bases cluster around $0130, $0133.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $0130  flag
- label hint: `flag_0130`
- confidence: 0.58
- related: $0130
- reason: Address $0130 is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $0200  mode_flag
- label hint: `sys_override_0200`
- confidence: 0.42
- related: $0200
- reason: Page-2/page-3 address $0200 is overwritten by game code.
- reason: This is often a KERNAL flag/vector override or borrowed system workspace.

### $0288  mode_flag
- label hint: `sys_override_0288`
- confidence: 0.42
- related: $0288
- reason: Page-2/page-3 address $0288 is overwritten by game code.
- reason: This is often a KERNAL flag/vector override or borrowed system workspace.

### $0300  mode_flag
- label hint: `sys_override_0300`
- confidence: 0.42
- related: $0300
- reason: Page-2/page-3 address $0300 is overwritten by game code.
- reason: This is often a KERNAL flag/vector override or borrowed system workspace.

### $03FF-$C807  table
- label hint: `table_03FF`
- confidence: 0.70
- related: $03FF, $C807
- reason: Indexed or loop-based accesses cluster around $03FF, $C807.
- reason: 2 consecutive absolute-indexed mixed access(es) use X as the table index.
- reason: Referenced bases cluster around $03FF, $C807.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $0401  pointer_target
- label hint: `ptr_target_0401`
- confidence: 0.72
- related: $0401
- reason: Zero-page pointer $003D resolves to constant target $0401 here.
- reason: This target is a strong candidate for a table, buffer, or dispatch structure.

### $0E27  pointer_target
- label hint: `ptr_target_0E27`
- confidence: 0.72
- related: $0E27
- reason: Zero-page pointer $007D resolves to constant target $0E27 here.
- reason: This target is a strong candidate for a table, buffer, or dispatch structure.

### $1705-$1718  table
- label hint: `table_1705`
- confidence: 0.62
- related: $1705, $1718
- reason: Indexed or loop-based accesses cluster around $1705, $1718.
- reason: 2 consecutive absolute-indexed read access(es) use X as the table index.
- reason: Referenced bases cluster around $1705, $1718.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $170A  pointer_target
- label hint: `ptr_target_170A`
- confidence: 0.72
- related: $170A
- reason: Zero-page pointer $007B resolves to constant target $170A here.
- reason: This target is a strong candidate for a table, buffer, or dispatch structure.

### $1C34  counter
- label hint: `counter_1C34`
- confidence: 0.60
- related: $1C34
- reason: Address $1C34 is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $2324-$C447  table
- label hint: `table_2324`
- confidence: 0.78
- related: $2324, $232D, $C400, $C409, $C43E, $C447
- reason: Indexed or loop-based accesses cluster around $2324, $232D, $C400, $C409, $C43E, $C447.
- reason: 6 consecutive absolute-indexed mixed access(es) use X as the table index.
- reason: Referenced bases cluster around $2324, $232D, $C400, $C409, $C43E, $C447.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $2336-$C485  table
- label hint: `table_2336`
- confidence: 0.75
- related: $2336, $C47C, $C485
- reason: Indexed or loop-based accesses cluster around $2336, $C47C, $C485.
- reason: 3 consecutive absolute-indexed mixed access(es) use X as the table index.
- reason: Referenced bases cluster around $2336, $C47C, $C485.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $2EBD  flag
- label hint: `flag_2EBD`
- confidence: 0.58
- related: $2EBD
- reason: Address $2EBD is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $3155-$8FDC  state_block
- label hint: `state_block_3155`
- confidence: 0.88
- related: $3155, $315E, $8FD3, $8FDC
- reason: Indexed or loop-based accesses cluster around $3155, $315E, $8FD3, $8FDC.
- reason: Backward branch at $8DE4 forms a loop over 12 instructions.
- reason: 4 indexed store(s) target $3155, $315E, $8FD3, $8FDC.
- reason: Indexed stores repeat without a matching indexed source load, which is more consistent with a fill/clear loop than a copy loop.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $3338  flag
- label hint: `flag_3338`
- confidence: 0.58
- related: $3338
- reason: Address $3338 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $34C0  flag
- label hint: `flag_34C0`
- confidence: 0.58
- related: $34C0
- reason: Address $34C0 is written with a small immediate set ($00, $01) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $3523-$352C  table
- label hint: `table_3523`
- confidence: 0.70
- related: $3523, $352C
- reason: Indexed or loop-based accesses cluster around $3523, $352C.
- reason: 2 consecutive absolute-indexed mixed access(es) use X as the table index.
- reason: Referenced bases cluster around $3523, $352C.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $38EE  flag
- label hint: `flag_38EE`
- confidence: 0.58
- related: $38EE
- reason: Address $38EE is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $394F  flag
- label hint: `flag_394F`
- confidence: 0.58
- related: $394F
- reason: Address $394F is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $4159  flag
- label hint: `flag_4159`
- confidence: 0.58
- related: $4159
- reason: Address $4159 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $4163  flag
- label hint: `flag_4163`
- confidence: 0.58
- related: $4163
- reason: Address $4163 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $4171  flag
- label hint: `flag_4171`
- confidence: 0.58
- related: $4171
- reason: Address $4171 is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $4179  flag
- label hint: `flag_4179`
- confidence: 0.58
- related: $4179
- reason: Address $4179 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $417D  flag
- label hint: `flag_417D`
- confidence: 0.58
- related: $417D
- reason: Address $417D is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $424B  flag
- label hint: `flag_424B`
- confidence: 0.58
- related: $424B
- reason: Address $424B is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $44B1  flag
- label hint: `flag_44B1`
- confidence: 0.58
- related: $44B1
- reason: Address $44B1 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $478D-$4799  buffer
- label hint: `buffer_478D`
- confidence: 0.74
- related: $478D, $4799
- reason: Indexed or loop-based accesses cluster around $478D, $4799.
- reason: Backward branch at $465E forms a loop over 7 instructions.
- reason: 2 indexed store(s) target $478D, $4799.
- reason: Indexed stores repeat without a matching indexed source load, which is more consistent with a fill/clear loop than a copy loop.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $478D-$4799  table
- label hint: `table_478D`
- confidence: 0.62
- related: $478D, $4799
- reason: Indexed or loop-based accesses cluster around $478D, $4799.
- reason: 2 consecutive absolute-indexed write access(es) use X as the table index.
- reason: Referenced bases cluster around $478D, $4799.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $49DF  flag
- label hint: `flag_49DF`
- confidence: 0.58
- related: $49DF
- reason: Address $49DF is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $50DE  flag
- label hint: `flag_50DE`
- confidence: 0.58
- related: $50DE
- reason: Address $50DE is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $60F8  pointer_target
- label hint: `ptr_target_60F8`
- confidence: 0.72
- related: $60F8
- reason: Zero-page pointer $0069 resolves to constant target $60F8 here.
- reason: This target is a strong candidate for a table, buffer, or dispatch structure.

### $6566  flag
- label hint: `flag_6566`
- confidence: 0.58
- related: $6566
- reason: Address $6566 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $699B  flag
- label hint: `flag_699B`
- confidence: 0.58
- related: $699B
- reason: Address $699B is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $7300  flag
- label hint: `flag_7300`
- confidence: 0.58
- related: $7300
- reason: Address $7300 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $73D9  counter
- label hint: `counter_73D9`
- confidence: 0.60
- related: $73D9
- reason: Address $73D9 is updated with INC/DEC/shift-style read-modify-write instructions.
- reason: That pattern often indicates a counter, timer, or packed state byte.

### $8D5E-$8D67  table
- label hint: `table_8D5E`
- confidence: 0.70
- related: $8D5E, $8D67
- reason: Indexed or loop-based accesses cluster around $8D5E, $8D67.
- reason: 2 consecutive absolute-indexed mixed access(es) use X as the table index.
- reason: Referenced bases cluster around $8D5E, $8D67.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $8D5E  flag
- label hint: `flag_8D5E`
- confidence: 0.58
- related: $8D5E
- reason: Address $8D5E is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $8DB0  flag
- label hint: `flag_8DB0`
- confidence: 0.58
- related: $8DB0
- reason: Address $8DB0 is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $8F6A  flag
- label hint: `flag_8F6A`
- confidence: 0.58
- related: $8F6A
- reason: Address $8F6A is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $8FB8-$8FE5  buffer
- label hint: `buffer_8FB8`
- confidence: 0.74
- related: $8FB8, $8FE5
- reason: Indexed or loop-based accesses cluster around $8FB8, $8FE5.
- reason: Backward branch at $8DA1 forms a loop over 6 instructions.
- reason: 2 indexed store(s) target $8FB8, $8FE5.
- reason: Immediate accumulator load suggests a fill loop with value $FF.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $9014  flag
- label hint: `flag_9014`
- confidence: 0.58
- related: $9014
- reason: Address $9014 is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $9990  pointer_target
- label hint: `ptr_target_9990`
- confidence: 0.72
- related: $9990
- reason: Zero-page pointer $0037 resolves to constant target $9990 here.
- reason: This target is a strong candidate for a table, buffer, or dispatch structure.

### $C000  buffer
- label hint: `buffer_C000`
- confidence: 0.74
- related: $C000
- reason: Indexed or loop-based accesses cluster around $C000.
- reason: Backward branch at $88E0 forms a loop over 4 instructions.
- reason: 2 indexed store(s) target $C000.
- reason: Indexed stores repeat without a matching indexed source load, which is more consistent with a fill/clear loop than a copy loop.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $C000  table
- label hint: `table_C000`
- confidence: 0.62
- related: $C000
- reason: Indexed or loop-based accesses cluster around $C000.
- reason: 2 consecutive absolute-indexed write access(es) use Y as the table index.
- reason: Referenced bases cluster around $C000.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $C000  flag
- label hint: `flag_C000`
- confidence: 0.58
- related: $C000
- reason: Address $C000 is written with a small immediate set ($00) and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.

### $C3F7-$C7F7  buffer
- label hint: `buffer_C3F7`
- confidence: 0.74
- related: $C3F7, $C7F7
- reason: Indexed or loop-based accesses cluster around $C3F7, $C7F7.
- reason: Backward branch at $8CB9 forms a loop over 4 instructions.
- reason: 2 indexed store(s) target $C3F7, $C7F7.
- reason: Indexed stores repeat without a matching indexed source load, which is more consistent with a fill/clear loop than a copy loop.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $C3F7-$C7F7  table
- label hint: `table_C3F7`
- confidence: 0.62
- related: $C3F7, $C7F7
- reason: Indexed or loop-based accesses cluster around $C3F7, $C7F7.
- reason: 2 consecutive absolute-indexed write access(es) use X as the table index.
- reason: Referenced bases cluster around $C3F7, $C7F7.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $C400-$C485  state_block
- label hint: `state_block_C400`
- confidence: 0.90
- related: $C400, $C409, $C43E, $C447, $C47C, $C485
- reason: Indexed or loop-based accesses cluster around $C400, $C409, $C43E, $C447, $C47C, $C485.
- reason: Backward branch at $214C forms a loop over 11 instructions.
- reason: 6 indexed store(s) target $C400, $C409, $C43E, $C447, $C47C, $C485.
- reason: 3 indexed load(s) suggest a copy loop from $2324, $232D, $2336.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $C410-$C48C  state_block
- label hint: `state_block_C410`
- confidence: 0.85
- related: $C410, $C44E, $C48C
- reason: Indexed or loop-based accesses cluster around $C410, $C44E, $C48C.
- reason: Backward branch at $215A forms a loop over 5 instructions.
- reason: 3 indexed store(s) target $C410, $C44E, $C48C.
- reason: Indexed stores repeat without a matching indexed source load, which is more consistent with a fill/clear loop than a copy loop.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $C410-$C48C  table
- label hint: `table_C410`
- confidence: 0.67
- related: $C410, $C44E, $C48C
- reason: Indexed or loop-based accesses cluster around $C410, $C44E, $C48C.
- reason: 3 consecutive absolute-indexed write access(es) use X as the table index.
- reason: Referenced bases cluster around $C410, $C44E, $C48C.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $C873-$C874  table
- label hint: `table_C873`
- confidence: 0.70
- related: $C873, $C874
- reason: Indexed or loop-based accesses cluster around $C873, $C874.
- reason: 2 consecutive absolute-indexed mixed access(es) use X as the table index.
- reason: Referenced bases cluster around $C873, $C874.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $C878-$C879  table
- label hint: `table_C878`
- confidence: 0.70
- related: $C878, $C879
- reason: Indexed or loop-based accesses cluster around $C878, $C879.
- reason: 2 consecutive absolute-indexed mixed access(es) use X as the table index.
- reason: Referenced bases cluster around $C878, $C879.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $C880-$C881  table
- label hint: `table_C880`
- confidence: 0.70
- related: $C880, $C881
- reason: Indexed or loop-based accesses cluster around $C880, $C881.
- reason: 2 consecutive absolute-indexed mixed access(es) use X as the table index.
- reason: Referenced bases cluster around $C880, $C881.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $C8AD-$C8D5  state_block
- label hint: `state_block_C8AD`
- confidence: 0.88
- related: $C8AD, $C8B5, $C8C9, $C8CD, $C8D1, $C8D5
- reason: Indexed or loop-based accesses cluster around $C8AD, $C8B5, $C8C9, $C8CD, $C8D1, $C8D5.
- reason: Backward branch at $8F9F forms a loop over 14 instructions.
- reason: 6 indexed store(s) target $C8AD, $C8B5, $C8C9, $C8CD, $C8D1, $C8D5.
- reason: Indexed stores repeat without a matching indexed source load, which is more consistent with a fill/clear loop than a copy loop.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $CC40-$CF00  state_block
- label hint: `state_block_CC40`
- confidence: 0.88
- related: $CC40, $CD00, $CE00, $CF00
- reason: Indexed or loop-based accesses cluster around $CC40, $CD00, $CE00, $CF00.
- reason: Backward branch at $57EA forms a loop over 6 instructions.
- reason: 4 indexed store(s) target $CC40, $CD00, $CE00, $CF00.
- reason: Indexed stores repeat without a matching indexed source load, which is more consistent with a fill/clear loop than a copy loop.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $CC40-$CF00  table
- label hint: `table_CC40`
- confidence: 0.70
- related: $CC40, $CD00, $CE00, $CF00
- reason: Indexed or loop-based accesses cluster around $CC40, $CD00, $CE00, $CF00.
- reason: 4 consecutive absolute-indexed write access(es) use X as the table index.
- reason: Referenced bases cluster around $CC40, $CD00, $CE00, $CF00.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $CFE5-$CFE8  buffer
- label hint: `buffer_CFE5`
- confidence: 0.74
- related: $CFE5, $CFE8
- reason: Indexed or loop-based accesses cluster around $CFE5, $CFE8.
- reason: Backward branch at $528A forms a loop over 4 instructions.
- reason: 2 indexed store(s) target $CFE5, $CFE8.
- reason: Indexed stores repeat without a matching indexed source load, which is more consistent with a fill/clear loop than a copy loop.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $CFE5-$CFE8  table
- label hint: `table_CFE5`
- confidence: 0.62
- related: $CFE5, $CFE8
- reason: Indexed or loop-based accesses cluster around $CFE5, $CFE8.
- reason: 2 consecutive absolute-indexed write access(es) use X as the table index.
- reason: Referenced bases cluster around $CFE5, $CFE8.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $CFF0-$CFF8  buffer
- label hint: `buffer_CFF0`
- confidence: 0.74
- related: $CFF0, $CFF8
- reason: Indexed or loop-based accesses cluster around $CFF0, $CFF8.
- reason: Backward branch at $45AD forms a loop over 4 instructions.
- reason: 2 indexed store(s) target $CFF0, $CFF8.
- reason: Indexed stores repeat without a matching indexed source load, which is more consistent with a fill/clear loop than a copy loop.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $CFF0-$CFF8  table
- label hint: `table_CFF0`
- confidence: 0.62
- related: $CFF0, $CFF8
- reason: Indexed or loop-based accesses cluster around $CFF0, $CFF8.
- reason: 2 consecutive absolute-indexed write access(es) use Y as the table index.
- reason: Referenced bases cluster around $CFF0, $CFF8.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $F080-$FD40  table
- label hint: `table_F080`
- confidence: 0.70
- related: $F080, $FD40
- reason: Indexed or loop-based accesses cluster around $F080, $FD40.
- reason: 2 consecutive absolute-indexed mixed access(es) use X as the table index.
- reason: Referenced bases cluster around $F080, $FD40.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $F0C0-$FD80  table
- label hint: `table_F0C0`
- confidence: 0.70
- related: $F0C0, $FD80
- reason: Indexed or loop-based accesses cluster around $F0C0, $FD80.
- reason: 2 consecutive absolute-indexed mixed access(es) use X as the table index.
- reason: Referenced bases cluster around $F0C0, $FD80.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $F3D8-$F41A  table
- label hint: `table_F3D8`
- confidence: 0.78
- related: $F3D8, $F3D9, $F3DA, $F418, $F419, $F41A
- reason: Indexed or loop-based accesses cluster around $F3D8, $F3D9, $F3DA, $F418, $F419, $F41A.
- reason: 6 consecutive absolute-indexed mixed access(es) use X as the table index.
- reason: Referenced bases cluster around $F3D8, $F3D9, $F3DA, $F418, $F419, $F41A.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $FB39-$FCB9  state_block
- label hint: `state_block_FB39`
- confidence: 0.88
- related: $FB39, $FBB9, $FC39, $FCB9
- reason: Indexed or loop-based accesses cluster around $FB39, $FBB9, $FC39, $FCB9.
- reason: Backward branch at $203F forms a loop over 6 instructions.
- reason: 4 indexed store(s) target $FB39, $FBB9, $FC39, $FCB9.
- reason: Indexed stores repeat without a matching indexed source load, which is more consistent with a fill/clear loop than a copy loop.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $FB39-$FCB9  table
- label hint: `table_FB39`
- confidence: 0.70
- related: $FB39, $FBB9, $FC39, $FCB9
- reason: Indexed or loop-based accesses cluster around $FB39, $FBB9, $FC39, $FCB9.
- reason: 4 consecutive absolute-indexed write access(es) use X as the table index.
- reason: Referenced bases cluster around $FB39, $FBB9, $FC39, $FCB9.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $FD00-$FE80  state_block
- label hint: `state_block_FD00`
- confidence: 0.85
- related: $FD00, $FE00, $FE80
- reason: Indexed or loop-based accesses cluster around $FD00, $FE00, $FE80.
- reason: Backward branch at $524F forms a loop over 5 instructions.
- reason: 3 indexed store(s) target $FD00, $FE00, $FE80.
- reason: Indexed stores repeat without a matching indexed source load, which is more consistent with a fill/clear loop than a copy loop.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $FD00-$FE80  table
- label hint: `table_FD00`
- confidence: 0.67
- related: $FD00, $FE00, $FE80
- reason: Indexed or loop-based accesses cluster around $FD00, $FE00, $FE80.
- reason: 3 consecutive absolute-indexed write access(es) use X as the table index.
- reason: Referenced bases cluster around $FD00, $FE00, $FE80.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $FD40-$FD80  buffer
- label hint: `buffer_FD40`
- confidence: 0.74
- related: $FD40, $FD80
- reason: Indexed or loop-based accesses cluster around $FD40, $FD80.
- reason: Backward branch at $65A1 forms a loop over 14 instructions.
- reason: 2 indexed store(s) target $FD40, $FD80.
- reason: Indexed stores repeat without a matching indexed source load, which is more consistent with a fill/clear loop than a copy loop.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $FD47  pointer_target
- label hint: `ptr_target_FD47`
- confidence: 0.72
- related: $FD47
- reason: Zero-page pointer $0015 resolves to constant target $FD47 here.
- reason: This target is a strong candidate for a table, buffer, or dispatch structure.

### $FD80-$FDC2  state_block
- label hint: `state_block_FD80`
- confidence: 0.88
- related: $FD80, $FD81, $FD82, $FDC0, $FDC2
- reason: Indexed or loop-based accesses cluster around $FD80, $FD81, $FD82, $FDC0, $FDC2.
- reason: Backward branch at $2374 forms a loop over 9 instructions.
- reason: 5 indexed store(s) target $FD80, $FD81, $FD82, $FDC0, $FDC2.
- reason: Indexed stores repeat without a matching indexed source load, which is more consistent with a fill/clear loop than a copy loop.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $FD80-$FDC2  table
- label hint: `table_FD80`
- confidence: 0.70
- related: $FD80, $FD81, $FD82, $FDC0, $FDC2
- reason: Indexed or loop-based accesses cluster around $FD80, $FD81, $FD82, $FDC0, $FDC2.
- reason: 5 consecutive absolute-indexed write access(es) use X as the table index.
- reason: Referenced bases cluster around $FD80, $FD81, $FD82, $FDC0, $FDC2.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $FDBB-$FDDD  table
- label hint: `table_FDBB`
- confidence: 0.78
- related: $FDBB, $FDBC, $FDBD, $FDDD
- reason: Indexed or loop-based accesses cluster around $FDBB, $FDBC, $FDBD, $FDDD.
- reason: 4 consecutive absolute-indexed mixed access(es) use Y as the table index.
- reason: Referenced bases cluster around $FDBB, $FDBC, $FDBD, $FDDD.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $FDC0-$FE20  state_block
- label hint: `state_block_FDC0`
- confidence: 0.85
- related: $FDC0, $FDE0, $FE20
- reason: Indexed or loop-based accesses cluster around $FDC0, $FDE0, $FE20.
- reason: Backward branch at $4F4C forms a loop over 8 instructions.
- reason: 3 indexed store(s) target $FDC0, $FDE0, $FE20.
- reason: Immediate accumulator load suggests a fill loop with value $00.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $FDDD-$FDDF  table
- label hint: `table_FDDD`
- confidence: 0.67
- related: $FDDD, $FDDE, $FDDF
- reason: Indexed or loop-based accesses cluster around $FDDD, $FDDE, $FDDF.
- reason: 3 consecutive absolute-indexed write access(es) use Y as the table index.
- reason: Referenced bases cluster around $FDDD, $FDDE, $FDDF.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $FDED-$FEED  state_block
- label hint: `state_block_FDED`
- confidence: 0.88
- related: $FDED, $FE2D, $FE6D, $FEAD, $FEED
- reason: Indexed or loop-based accesses cluster around $FDED, $FE2D, $FE6D, $FEAD, $FEED.
- reason: Backward branch at $8AE0 forms a loop over 7 instructions.
- reason: 5 indexed store(s) target $FDED, $FE2D, $FE6D, $FEAD, $FEED.
- reason: Indexed stores repeat without a matching indexed source load, which is more consistent with a fill/clear loop than a copy loop.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $FDED-$FEED  table
- label hint: `table_FDED`
- confidence: 0.70
- related: $FDED, $FE2D, $FE6D, $FEAD, $FEED
- reason: Indexed or loop-based accesses cluster around $FDED, $FE2D, $FE6D, $FEAD, $FEED.
- reason: 5 consecutive absolute-indexed write access(es) use X as the table index.
- reason: Referenced bases cluster around $FDED, $FE2D, $FE6D, $FEAD, $FEED.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $FE4F-$FE55  state_block
- label hint: `state_block_FE4F`
- confidence: 0.87
- related: $FE4F, $FE52, $FE55
- reason: Indexed or loop-based accesses cluster around $FE4F, $FE52, $FE55.
- reason: Backward branch at $1C76 forms a loop over 18 instructions.
- reason: 3 indexed store(s) target $FE4F, $FE52, $FE55.
- reason: 1 indexed load(s) suggest a copy loop from $210D.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $FE4F-$FE55  table
- label hint: `table_FE4F`
- confidence: 0.67
- related: $FE4F, $FE52, $FE55
- reason: Indexed or loop-based accesses cluster around $FE4F, $FE52, $FE55.
- reason: 3 consecutive absolute-indexed write access(es) use Y as the table index.
- reason: Referenced bases cluster around $FE4F, $FE52, $FE55.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $FF00-$FF01  table
- label hint: `table_FF00`
- confidence: 0.62
- related: $FF00, $FF01
- reason: Indexed or loop-based accesses cluster around $FF00, $FF01.
- reason: 2 consecutive absolute-indexed write access(es) use X as the table index.
- reason: Referenced bases cluster around $FF00, $FF01.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $FF58-$FF98  table
- label hint: `table_FF58`
- confidence: 0.70
- related: $FF58, $FF98
- reason: Indexed or loop-based accesses cluster around $FF58, $FF98.
- reason: 2 consecutive absolute-indexed mixed access(es) use X as the table index.
- reason: Referenced bases cluster around $FF58, $FF98.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $FFFF  buffer
- label hint: `buffer_FFFF`
- confidence: 0.74
- related: $FFFF
- reason: Indexed or loop-based accesses cluster around $FFFF.
- reason: Backward branch at $45BD forms a loop over 4 instructions.
- reason: 2 indexed store(s) target $FFFF.
- reason: Indexed stores repeat without a matching indexed source load, which is more consistent with a fill/clear loop than a copy loop.
- reason: Loop comes from a probable code island and should be validated by reading the routine.

### $FFFF  table
- label hint: `table_FFFF`
- confidence: 0.70
- related: $FFFF
- reason: Indexed or loop-based accesses cluster around $FFFF.
- reason: 2 consecutive absolute-indexed mixed access(es) use X as the table index.
- reason: Referenced bases cluster around $FFFF.
- reason: Pattern comes from a probable code island and should be interpreted carefully.

### $FFFF  flag
- label hint: `flag_FFFF`
- confidence: 0.58
- related: $FFFF
- reason: Address $FFFF is written with a small immediate set () and later read back.
- reason: That pattern is more consistent with a flag/mode byte than with arbitrary data.
