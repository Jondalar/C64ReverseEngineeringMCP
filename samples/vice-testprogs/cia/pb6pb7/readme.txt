
This tests an unusual condition first noticed in the demo "Love" by Agony Design:
https://csdb.dk/release/?id=2881

The "press space" check in the "turn disk" part looks like this:

.C:443b  A9 7F       LDA #$7F
.C:443d  8D 00 DC    STA $DC00
.C:4440  A9 FF       LDA #$FF
.C:4442  8D 02 DC    STA $DC02
.C:4445  A9 00       LDA #$00
.C:4447  8D 03 DC    STA $DC03
.C:444a  A9 01       LDA #$01
.C:444c  8D 0E DC    STA $DC0E
.C:444f  A9 08       LDA #$08
.C:4451  8D 0F DC    STA $DC0F
.C:4454  AD 01 DC    LDA $DC01
.C:4457  C9 EF       CMP #$EF
.C:4459  D0 F9       BNE $4454
.C:445b  4C AB 46    JMP $46AB

The reason it fails before r42562 is related to bit 1 of $dc0e and $dc0f, which
control if TA and/or TB respectively will control bits PB6 and PB7.
