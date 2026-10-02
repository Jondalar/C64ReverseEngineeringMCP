// A minimal 1581 image holding one PRG: 80 tracks of 40 256-byte sectors (819 200 bytes),
// header 40/0, BAM 40/1 and 40/2, directory 40/3, the file on 1/0. Written here rather than
// checked in so a test carries no medium it did not make. Checked once against VICE's
// c1541 (`-dir` lists the file, `-read` gives the bytes back).

const SECTORS = 40;
const off = (track, sector) => ((track - 1) * SECTORS + sector) * 256;
const petscii = (s, len) => {
  const out = new Uint8Array(len).fill(0xa0);
  for (let i = 0; i < Math.min(s.length, len); i++) out[i] = s.toUpperCase().charCodeAt(i);
  return out;
};

/** `prg` is the file as on disk: load address first. At most 254 bytes — one sector. */
export function d81WithPrg(name, prg, { diskName = "C64RE TEST", id = "RE" } = {}) {
  if (prg.length > 254) throw new Error("d81WithPrg: one sector only (254 bytes)");
  const img = new Uint8Array(80 * SECTORS * 256);

  const hdr = off(40, 0);
  img.set([40, 3, 0x44, 0x00], hdr);
  img.set(petscii(diskName, 16), hdr + 4);
  img.set([0xa0, 0xa0], hdr + 20);
  img.set([id.charCodeAt(0), id.charCodeAt(1), 0xa0, 0x33, 0x44, 0xa0, 0xa0], hdr + 22);

  // BAM: a track's entry is its free count and 5 bitmap bytes, a set bit = free.
  const used = new Map([[40, [0, 1, 2, 3]], [1, [0]]]);
  for (const [sector, next] of [[1, [40, 2]], [2, [0, 0xff]]]) {
    const b = off(40, sector);
    img.set([...next, 0x44, 0xbb, id.charCodeAt(0), id.charCodeAt(1), 0xc0, 0x00], b);
    const first = sector === 1 ? 1 : 41;
    for (let t = first; t < first + 40; t++) {
      const taken = used.get(t) ?? [];
      const bits = new Uint8Array(5).fill(0xff);
      for (const s of taken) bits[s >> 3] &= ~(1 << (s & 7));
      img.set([SECTORS - taken.length, ...bits], b + 0x10 + (t - first) * 6);
    }
  }

  const dir = off(40, 3);
  img.set([0x00, 0xff], dir);
  img.set([0x82, 1, 0], dir + 2);
  img.set(petscii(name, 16), dir + 5);
  img.set([1, 0], dir + 30);

  const data = off(1, 0);
  img.set([0x00, prg.length + 1], data);
  img.set(prg, data + 2);
  return img;
}
