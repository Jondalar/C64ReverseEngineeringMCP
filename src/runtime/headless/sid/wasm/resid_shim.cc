// reSID WASM shim — Spec 703.3
//
// A thin flat C API over reSID's C++ `reSID::SID` so emscripten can export it
// and the TypeScript `SidWasmEngine` (resid-wasm-engine.ts) can drive it via
// cwrap. This file is OUR code (GPL-3.0-or-later, links GPL reSID); it is NOT
// part of the vendored-unmodified set in third_party/resid/.
//
// reSID reference (third_party/resid/sid.h):
//   void  set_chip_model(chip_model)            chip_model { MOS6581=0, MOS8580=1 }
//   bool  set_sampling_parameters(clock, method, sample_freq, ...)
//                                               sampling_method { FAST=0, INTERPOLATE=1,
//                                                                  RESAMPLE=2, RESAMPLE_FASTMEM=3 }
//   void  reset()
//   void  write(reg8 offset, reg8 value)        offset 0x00..0x1f
//   reg8  read(reg8 offset)
//   int   clock(cycle_count& delta_t, short* buf, int n, int interleave=1)
//         -> advances up to delta_t cycles, writes up to n samples to buf,
//            returns #samples written, sets delta_t to remaining (>0 if buf filled).
//   void  clock(cycle_count delta_t)            advance without sampling
//   int   output()                              current 16-bit AUDIO OUT
//
// Single static instance: the integrated runtime drives exactly one SID, so a
// module-level instance matches the existing TS SID lifetime and avoids
// pointer juggling across the WASM boundary. (Mirrors the vice1541 module-global
// convention already used elsewhere in the runtime.)

#include "sid.h"

using namespace reSID;

namespace {
SID g_sid;
int g_clock_remaining = 0;  // cycles not consumed by the last resid_clock (buf filled)
}

extern "C" {

// model: 0 = 6581, 1 = 8580
void resid_set_chip_model(int model) {
  g_sid.set_chip_model(model == 1 ? MOS8580 : MOS6581);
}

// Per-voice enable bitmask. VICE inits this to 0x07 (all three voices) right
// after set_chip_model; the reSID ctor does NOT, so without this call the
// default mask mutes voices. Bit i enables voice i.
void resid_set_voice_mask(int mask) {
  g_sid.set_voice_mask(static_cast<reg4>(mask & 0x0f));
}

// Enable/disable the SID filter stage (VICE: enable_filter(filters_enabled)).
void resid_enable_filter(int enable) {
  g_sid.enable_filter(enable != 0);
}

// method: 0 FAST, 1 INTERPOLATE, 2 RESAMPLE, 3 RESAMPLE_FASTMEM.
// Returns 1 on success, 0 on failure (e.g. invalid resample params).
int resid_set_sampling(double clock_freq, double sample_freq, int method) {
  return g_sid.set_sampling_parameters(
             clock_freq, static_cast<sampling_method>(method), sample_freq)
             ? 1
             : 0;
}

void resid_reset() {
  g_sid.reset();
  g_clock_remaining = 0;
}

void resid_write(int reg, int value) {
  g_sid.write(static_cast<reg8>(reg & 0x1f), static_cast<reg8>(value & 0xff));
}

int resid_read(int reg) {
  return static_cast<int>(g_sid.read(static_cast<reg8>(reg & 0x1f)));
}

// Advance up to `delta` C64 cycles, writing up to `max_samples` signed 16-bit
// mono samples into `buf` (a pointer into the WASM heap supplied by the caller).
// Returns the number of samples produced. If the buffer filled before `delta`
// cycles were consumed, the remainder is stored and readable via
// resid_clock_remaining(); the caller loops until that is 0.
int resid_clock(int delta, short* buf, int max_samples) {
  cycle_count dt = delta;
  int produced = g_sid.clock(dt, buf, max_samples);
  g_clock_remaining = static_cast<int>(dt);
  return produced;
}

int resid_clock_remaining() { return g_clock_remaining; }

// Advance `delta` cycles without producing samples (for clockUntil-style use
// when audio output is muted but SID state must still age).
void resid_clock_silent(int delta) {
  g_sid.clock(static_cast<cycle_count>(delta));
}

// Current 16-bit AUDIO OUT (post external filter).
int resid_output() { return g_sid.output(); }

}  // extern "C"
