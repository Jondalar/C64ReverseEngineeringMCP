This is a regression test suggested by PiCiJi, the author of "Denise".

The game "Bounty Bob" uses STA ABS,X to acknowledge the CIA1 interrupt flags
(shortly before the title picture). The value in Akku is 0, which means the
store does not change the interrupt mask, however the "dummy read" that happens
one cycle before will acknowledge the interrupt flags.

Some earlier version of "Denise" had a bug that resulted in a second IRQ being
triggered.
