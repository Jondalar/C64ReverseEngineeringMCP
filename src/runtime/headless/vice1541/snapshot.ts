// PORT OF: vice/src/snapshot.c — module-stream layer (in-memory).
//
// Spec 705.A step 1: a VICE-shaped, in-memory snapshot subsystem serializer for
// the VICE1541 drive. NOT a reduced parallel serializer — it reproduces VICE's
// exact module byte layout (16-byte padded name + major + minor + LE dword
// size, back-patched on close) and little-endian read/write primitives, so the
// bytes are the same VICE writes. The only substitution vs VICE is the backing
// store: VICE's `FILE *` becomes a random-access in-memory byte buffer with an
// ftell/fseek-style cursor (module_close back-patches the size dword).
//
// Scope: the per-module byte stream used by the 1541 drive modules
// (byte/word/dword/qword/byte_array). The file-container functions
// (snapshot_create/open/close, read_module) and the double/string/non-byte
// array variants are PORT-STUBs — the drive modules never call them and the
// native RuntimeCheckpoint owns the container, not a VSF file (Spec 705 §3.2).
//
// Spec 612: NL-2 (function names verbatim snake_case), NL-3 (struct fields
// verbatim), NL-4 (one C macro → one TS const, same name), PL-1 (no class
// wrapping a VICE struct — functions take the struct as first arg).

export const SNAPSHOT_MODULE_NAME_LEN = 16;

// In-memory stand-in for VICE's `snapshot_t` (a FILE* + first_module_offset).
// `buf` is the byte store; `pos` is ftell. Writes past the end extend it;
// writes within it overwrite (used by module_close to back-patch the size).
export interface snapshot_t {
  buf: number[];
  pos: number;
  first_module_offset: number;
}

// PORT OF: struct snapshot_module_s (snapshot.c).
export interface snapshot_module_t {
  s: snapshot_t;
  write_mode: number;
  size: number;        // size of the module (incl. header)
  offset: number;      // offset of the module in the buffer
  size_offset: number; // offset of the size field
}

type RW = { ok: boolean; v: number };

function stub(name: string): never {
  throw new Error(`PORT-STUB: ${name} not ported (Spec 705.A — not used by the 1541 drive module stream).`);
}

// ---- in-memory file lifecycle (PL-5 bridge: replace fopen/fclose) ----------

// PORT OF: vice/src/snapshot.c — fopen("wb") equivalent (in-memory backing
// store for the subsystem serializer; no on-disk snapshot file). Bridge shim.
export function snapshot_create_in_memory(): snapshot_t {
  return { buf: [], pos: 0, first_module_offset: 0 };
}

// PORT OF: vice/src/snapshot.c — fopen("rb") equivalent over an in-memory blob.
export function snapshot_open_in_memory(bytes: Uint8Array): snapshot_t {
  return { buf: Array.from(bytes), pos: 0, first_module_offset: 0 };
}

// PORT OF: vice/src/snapshot.c — flush the in-memory backing store to bytes.
export function snapshot_to_bytes(s: snapshot_t): Uint8Array {
  return Uint8Array.from(s.buf);
}

// ---- low-level FILE* equivalents (snapshot.c static helpers; FC-2 exempt) --

function snapshot_write_byte(s: snapshot_t, b: number): number {
  s.buf[s.pos] = b & 0xff;
  s.pos++;
  return 0;
}
function snapshot_write_word(s: snapshot_t, w: number): number {
  if (snapshot_write_byte(s, w & 0xff) < 0 || snapshot_write_byte(s, (w >> 8) & 0xff) < 0) return -1;
  return 0;
}
function snapshot_write_dword(s: snapshot_t, dw: number): number {
  if (snapshot_write_word(s, dw & 0xffff) < 0 || snapshot_write_word(s, (dw >>> 16) & 0xffff) < 0) return -1;
  return 0;
}
function snapshot_write_qword(s: snapshot_t, qw: number): number {
  // VICE writes the low dword then the high dword (LE). JS numbers are exact to
  // 2^53, which covers every CLOCK value the drive reaches in a session.
  if (snapshot_write_dword(s, qw >>> 0) < 0 || snapshot_write_dword(s, Math.floor(qw / 0x100000000) >>> 0) < 0) return -1;
  return 0;
}
function snapshot_write_padded_string_ll(s: snapshot_t, str: string, pad: number, len: number): number {
  for (let i = 0; i < len; i++) {
    if (snapshot_write_byte(s, i < str.length ? (str.charCodeAt(i) & 0xff) : (pad & 0xff)) < 0) return -1;
  }
  return 0;
}
function snapshot_read_byte_ll(s: snapshot_t): RW {
  if (s.pos >= s.buf.length) return { ok: false, v: 0 };
  const v = s.buf[s.pos]! & 0xff;
  s.pos++;
  return { ok: true, v };
}
function snapshot_read_word_ll(s: snapshot_t): RW {
  const lo = snapshot_read_byte_ll(s); if (!lo.ok) return { ok: false, v: 0 };
  const hi = snapshot_read_byte_ll(s); if (!hi.ok) return { ok: false, v: 0 };
  return { ok: true, v: (lo.v | (hi.v << 8)) & 0xffff };
}
function snapshot_read_dword_ll(s: snapshot_t): RW {
  const lo = snapshot_read_word_ll(s); if (!lo.ok) return { ok: false, v: 0 };
  const hi = snapshot_read_word_ll(s); if (!hi.ok) return { ok: false, v: 0 };
  return { ok: true, v: ((lo.v | (hi.v << 16)) >>> 0) };
}

// ---- module create / open / close (snapshot.c:677-800) ---------------------

// PORT OF: vice/src/snapshot.c:677-704 (snapshot_module_create)
export function snapshot_module_create(
  s: snapshot_t, name: string, major_version: number, minor_version: number,
): snapshot_module_t | null {
  const m: snapshot_module_t = { s, write_mode: 1, size: 0, offset: s.pos, size_offset: 0 };
  if (snapshot_write_padded_string_ll(s, name, 0, SNAPSHOT_MODULE_NAME_LEN) < 0
    || snapshot_write_byte(s, major_version) < 0
    || snapshot_write_byte(s, minor_version) < 0
    || snapshot_write_dword(s, 0) < 0) {
    return null;
  }
  m.size = s.pos - m.offset;
  m.size_offset = s.pos - 4;
  return m;
}

// PORT OF: vice/src/snapshot.c:706-773 (snapshot_module_open)
export function snapshot_module_open(
  s: snapshot_t, name: string,
): { module: snapshot_module_t; major: number; minor: number } | null {
  const name_len = name.length;
  s.pos = s.first_module_offset;
  const m: snapshot_module_t = { s, write_mode: 0, size: 0, offset: s.first_module_offset, size_offset: 0 };
  const n = new Uint8Array(SNAPSHOT_MODULE_NAME_LEN);
  for (;;) {
    for (let i = 0; i < SNAPSHOT_MODULE_NAME_LEN; i++) { const r = snapshot_read_byte_ll(s); if (!r.ok) return null; n[i] = r.v; }
    const major = snapshot_read_byte_ll(s); if (!major.ok) return null;
    const minor = snapshot_read_byte_ll(s); if (!minor.ok) return null;
    const size = snapshot_read_dword_ll(s); if (!size.ok) return null;
    m.size = size.v;
    let match = true;
    for (let i = 0; i < name_len; i++) { if (n[i] !== (name.charCodeAt(i) & 0xff)) { match = false; break; } }
    if (match && (name_len === SNAPSHOT_MODULE_NAME_LEN || n[name_len] === 0)) {
      m.size_offset = s.pos - 4;
      return { module: m, major: major.v, minor: minor.v };
    }
    m.offset += m.size;
    if (m.offset >= s.buf.length) return null;
    s.pos = m.offset;
  }
}

// PORT OF: vice/src/snapshot.c:775-797 (snapshot_module_close)
export function snapshot_module_close(m: snapshot_module_t): number {
  if (m.write_mode) {
    m.s.pos = m.size_offset;
    if (snapshot_write_dword(m.s, m.size) < 0) return -1;
  }
  m.s.pos = m.offset + m.size; // skip module
  return 0;
}

// ---- module write primitives (snapshot.c:384-475; bump m.size) -------------

// PORT OF: vice/src/snapshot.c:384-392 (snapshot_module_write_byte)
export function snapshot_module_write_byte(m: snapshot_module_t, b: number): number { if (snapshot_write_byte(m.s, b) < 0) return -1; m.size += 1; return 0; }
// PORT OF: vice/src/snapshot.c:394-402 (snapshot_module_write_word)
export function snapshot_module_write_word(m: snapshot_module_t, w: number): number { if (snapshot_write_word(m.s, w) < 0) return -1; m.size += 2; return 0; }
// PORT OF: vice/src/snapshot.c:404-412 (snapshot_module_write_dword)
export function snapshot_module_write_dword(m: snapshot_module_t, dw: number): number { if (snapshot_write_dword(m.s, dw) < 0) return -1; m.size += 4; return 0; }
// PORT OF: vice/src/snapshot.c:414-422 (snapshot_module_write_qword)
export function snapshot_module_write_qword(m: snapshot_module_t, qw: number): number { if (snapshot_write_qword(m.s, qw) < 0) return -1; m.size += 8; return 0; }
// PORT OF: vice/src/snapshot.c:444-452 (snapshot_module_write_byte_array)
export function snapshot_module_write_byte_array(m: snapshot_module_t, b: Uint8Array, num: number): number { for (let i = 0; i < num; i++) snapshot_write_byte(m.s, b[i] ?? 0); m.size += num; return 0; }
// PORT OF: vice/src/snapshot.c:434-442 (snapshot_module_write_padded_string)
export function snapshot_module_write_padded_string(m: snapshot_module_t, str: string, pad: number, len: number): number {
  if (snapshot_write_padded_string_ll(m.s, str, pad, len) < 0) return -1;
  m.size += len;
  return 0;
}
// PORT OF: vice/src/snapshot.c:454-462 (snapshot_module_write_word_array)
export function snapshot_module_write_word_array(): number { return stub("snapshot_module_write_word_array"); }
// PORT OF: vice/src/snapshot.c:464-472 (snapshot_module_write_dword_array)
export function snapshot_module_write_dword_array(): number { return stub("snapshot_module_write_dword_array"); }
// PORT OF: vice/src/snapshot.c (snapshot_module_write_double)
export function snapshot_module_write_double(): number { return stub("snapshot_module_write_double"); }
// PORT OF: vice/src/snapshot.c (snapshot_module_write_string)
export function snapshot_module_write_string(): number { return stub("snapshot_module_write_string"); }

// ---- module read primitives (snapshot.c:489-560) --------------------------

// PORT OF: vice/src/snapshot.c:489-498 (snapshot_module_read_byte)
export function snapshot_module_read_byte(m: snapshot_module_t): RW { return snapshot_read_byte_ll(m.s); }
// PORT OF: vice/src/snapshot.c (snapshot_module_read_word)
export function snapshot_module_read_word(m: snapshot_module_t): RW { return snapshot_read_word_ll(m.s); }
// PORT OF: vice/src/snapshot.c (snapshot_module_read_dword)
export function snapshot_module_read_dword(m: snapshot_module_t): RW { return snapshot_read_dword_ll(m.s); }
// PORT OF: vice/src/snapshot.c (snapshot_module_read_qword)
export function snapshot_module_read_qword(m: snapshot_module_t): RW {
  const lo = snapshot_read_dword_ll(m.s); if (!lo.ok) return { ok: false, v: 0 };
  const hi = snapshot_read_dword_ll(m.s); if (!hi.ok) return { ok: false, v: 0 };
  return { ok: true, v: hi.v * 0x100000000 + lo.v };
}
// PORT OF: vice/src/snapshot.c (snapshot_module_read_byte_array)
export function snapshot_module_read_byte_array(m: snapshot_module_t, out: Uint8Array, num: number): number {
  for (let i = 0; i < num; i++) { const r = snapshot_read_byte_ll(m.s); if (!r.ok) return -1; out[i] = r.v; }
  return 0;
}
// Signed/unsigned read variants read the SAME LE bytes; only the host-side
// destination type differs (irrelevant for the small drive-state values).
// PORT OF: vice/src/snapshot.c (snapshot_module_read_byte_into_int)
export function snapshot_module_read_byte_into_int(m: snapshot_module_t): RW { return snapshot_read_byte_ll(m.s); }
// PORT OF: vice/src/snapshot.c (snapshot_module_read_byte_into_uint)
export function snapshot_module_read_byte_into_uint(m: snapshot_module_t): RW { return snapshot_read_byte_ll(m.s); }
// PORT OF: vice/src/snapshot.c (snapshot_module_read_word_into_int)
export function snapshot_module_read_word_into_int(m: snapshot_module_t): RW { return snapshot_read_word_ll(m.s); }
// PORT OF: vice/src/snapshot.c (snapshot_module_read_word_into_uint)
export function snapshot_module_read_word_into_uint(m: snapshot_module_t): RW { return snapshot_read_word_ll(m.s); }
// PORT OF: vice/src/snapshot.c (snapshot_module_read_dword_into_int)
export function snapshot_module_read_dword_into_int(m: snapshot_module_t): RW { return snapshot_read_dword_ll(m.s); }
// PORT OF: vice/src/snapshot.c (snapshot_module_read_dword_into_uint)
export function snapshot_module_read_dword_into_uint(m: snapshot_module_t): RW { return snapshot_read_dword_ll(m.s); }
// PORT OF: vice/src/snapshot.c (snapshot_module_read_dword_into_ulong)
export function snapshot_module_read_dword_into_ulong(m: snapshot_module_t): RW { return snapshot_read_dword_ll(m.s); }
// PORT OF: vice/src/snapshot.c (snapshot_module_read_qword_into_int64)
export function snapshot_module_read_qword_into_int64(m: snapshot_module_t): RW { return snapshot_module_read_qword(m); }
// PORT OF: vice/src/snapshot.c (snapshot_module_read_word_array)
export function snapshot_module_read_word_array(): number { return stub("snapshot_module_read_word_array"); }
// PORT OF: vice/src/snapshot.c (snapshot_module_read_dword_array)
export function snapshot_module_read_dword_array(): number { return stub("snapshot_module_read_dword_array"); }
// PORT OF: vice/src/snapshot.c (snapshot_module_read_double)
export function snapshot_module_read_double(): number { return stub("snapshot_module_read_double"); }
// PORT OF: vice/src/snapshot.c (snapshot_module_read_string)
export function snapshot_module_read_string(): number { return stub("snapshot_module_read_string"); }

// ---- snapshot version compares (snapshot.c) -------------------------------

// PORT OF: vice/src/snapshot.c (snapshot_version_is_bigger)
export function snapshot_version_is_bigger(maj: number, min: number, refMaj: number, refMin: number): boolean { return maj > refMaj || (maj === refMaj && min > refMin); }
// PORT OF: vice/src/snapshot.c (snapshot_version_is_smaller)
export function snapshot_version_is_smaller(maj: number, min: number, refMaj: number, refMin: number): boolean { return maj < refMaj || (maj === refMaj && min < refMin); }
// PORT OF: vice/src/snapshot.c (snapshot_version_is_equal)
export function snapshot_version_is_equal(maj: number, min: number, refMaj: number, refMin: number): boolean { return maj === refMaj && min === refMin; }

// ---- file-container + error funcs — PORT-STUB (RuntimeCheckpoint owns the
//      container; the in-memory helpers above replace create/open/close) ----

// PORT OF: vice/src/snapshot.c (snapshot_create)
export function snapshot_create(): number { return stub("snapshot_create"); }
// PORT OF: vice/src/snapshot.c (snapshot_open)
export function snapshot_open(): number { return stub("snapshot_open"); }
// PORT OF: vice/src/snapshot.c (snapshot_close)
export function snapshot_close(): number { return stub("snapshot_close"); }
// PORT OF: vice/src/snapshot.c (snapshot_set_error)
export function snapshot_set_error(): void { /* no-op: errors surface via thrown stubs / negative returns */ }
// PORT OF: vice/src/snapshot.c (snapshot_get_error)
export function snapshot_get_error(): number { return 0; }
// PORT OF: vice/src/snapshot.c (snapshot_display_error)
export function snapshot_display_error(): void { /* no-op */ }

// ---- macro aliases (snapshot.h:104-160; NL-4 one macro → one const) -------

export const SMW_B = snapshot_module_write_byte;
export const SMW_W = snapshot_module_write_word;
export const SMW_DW = snapshot_module_write_dword;
export const SMW_CLOCK = snapshot_module_write_qword;
export const SMW_BA = snapshot_module_write_byte_array;
export const SMR_B = snapshot_module_read_byte;
export const SMR_W = snapshot_module_read_word;
export const SMR_DW = snapshot_module_read_dword;
export const SMR_BA = snapshot_module_read_byte_array;
// PORT OF: vice/src/snapshot.h:129 (SMR_CLOCK macro → snapshot_module_read_qword
// into a CLOCK out-param). ClockRef.value receives the qword.
export function SMR_CLOCK(m: snapshot_module_t, ref: { value: number }): number {
  const r = snapshot_module_read_qword(m);
  if (!r.ok) return -1;
  ref.value = r.v;
  return 0;
}
