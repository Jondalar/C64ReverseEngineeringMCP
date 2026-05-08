iec-bus-delay.prg: measures the time of a signal at the IEC-bus.

original program by Jochen "NLQ" Adler

note: the original program was written to aid in debugging the TC64 drive emu,
      all info specific to that was removed from the following info.

--------------------------------------------------------------------------------

The C64 sends a signal to the floppy which acknowledges this signal to the C64 
and the C64 measures the time until it receives this acknowledge from the 
floppy. It runs with a C64 (or with a C128 in C64-mode, not with a C128 in 
C128-mode) and a 1541 (real or emulated) or a 1571 (not with a 1581). The result 
is not an absolute value; it doesn't show the time from sending the signial 
until receiving it, but it is a relative value to compare two serial devices 
with each other. So I call the result the relative-delay-value.


 Y = % from 0 to 100
 X = delay from 0 to 11 in C64-cycles

      !
 100%-+                   /
      !                  /
      !                 /
      !                /
      !               /
      !              /
      !             /
  50%-+            /
      !           /
      !          /
      !         /
      !        /
      !       /
      !      /
   0%-+------------------------
      0 1 2 3 4 5 6 7 8 9 1 1
                          0 1

 NTSC: y = 14.0 * (x - relativedelay)   => relativedelay = x - ( y / 14.0 )
 PAL:  y = 14.5 * (x - relativedelay)   => relativedelay = x - ( y / 14.5 )

A difference of 0.01us is a measuring error.

I have three serial devices for testing, a 1541-2, a 154old and a 1571. The 
1541-2 has a good average-delay-value; the 1541old is 0.11us slower, the 1571 
is 0.11us faster. So I use the 1541-2

(When the system is cold then the values are 0.01 - 0.02us faster than at a warm 
system)

--------------------------------------------------------------------------------

PAL-C64, 1541-2

  64=f  64=r  64=f  64=r  de-   pos.   IEC-cable
  41=f  41=f  41=r  41=r  vice  in         
  [us]  [us]  [us]  [us]  kind  chain     

a 2.88  2.84  2.91  2.87  41-2  1.o.1    6-4                            
b 2.97  2.94  3.01  2.98  41old 1.o.1    6-4                             
c 2.75  2.72  2.77  2.74  71ext 1.o.1    6-7                      
d 2.99  2.85  2.97  2.83  41-2  1.o.5  6-4-x-x-x-x                         
e 3.00  2.94  3.01  2.94  41-2  5.o.5  6-x-x-x-x-4                         

(a) - (c): The delay-value difference of (my three) original-CBM-drives is 0.22us.
(a) & (d): The difference of one serial device and five serial devices, where the 
measured floppy is the first one in the chain is -0.04 to +0.11us.
(a) & (e): The difference of one serial device and five serial devices, where the 
measured floppy is the last one in the chain is 0.07 to 0.12us.

At a PAL-C128D with its 1571DCR JiffyDOS (JD) works if the value 64=r&41=r is 
>=2.69us and JD doesn't work if this value is <=2.67us.

--------------------------------------------------------------------------------

NTSC-C64, 1541-2

  64=f  64=r  64=f  64=r  de-   pos.   IEC-cable
  41=f  41=f  41=r  41=r  vice  in         
  [us]  [us]  [us]  [us]  kind  chain     

a 3.01  2.97  3.04  3.00  41-2  1.o.1    6-4                            
b 3.12  3.08  3.16  3.12  41old 1.o.1    6-4                             
c 2.88  2.85  2.91  2.88  71ext 1.o.1    6-7                      
d 3.11  2.98  3.10  2.97  41-2  1.o.5  6-4-x-x-x-x                         
e 3.14  3.07  3.13  3.07  41-2  5.o.5  6-x-x-x-x-4                         

--------------------------------------------------------------------------------

[us] = microseconds

6=f: C64 generates falling edge
6=r: C64 generates rising edge
4=f: 1541 generates falling edge
4=r: 1541 generates rising edge

falling = physically falling = from 5V to 0V = from inactive to active (logically rising) 
rising  = physically rising  = from 0V to 5V = from active to inactive (logically falling)

Position in chain:
1.o.1: The measured device is the only serial device (the first one of one ones)
5.o.5: The measured device is the last one of five serial devices in the chain 
       (the fifth one of five ones)

IEC-cable:
6 = C64
4 = 1541
7 = 1547
x = any serial device

6-4           : Cable from C64 to real 1541
6-x-x-x-x-    : Cable from C64 to four floppies

