// A minimal 1541 image holding one PRG: 35 tracks, 683 sectors (174 848 bytes), BAM and disk
// name on 18/0, the directory on 18/1, the file chained from 1/0. Written here rather than checked
// in so a test carries no medium it did not make. The same layout `d81-fixture.mjs` gives a 1581.

const SECTORS_ON = (track) => (track <= 17 ? 21 : track <= 24 ? 19 : track <= 30 ? 18 : 17);
const TRACK_START = (() => {
  const out = [0];
  let at = 0;
  for (let t = 1; t <= 35; t++) { out[t] = at; at += SECTORS_ON(t); }
  return out;
})();
const off = (track, sector) => (TRACK_START[track] + sector) * 256;
const petscii = (s, len) => {
  const out = new Uint8Array(len).fill(0xa0);
  for (let i = 0; i < Math.min(s.length, len); i++) out[i] = s.toUpperCase().charCodeAt(i);
  return out;
};

/** `prg` is the file as on disk: load address first. The file may span sectors (254 data bytes each, from track 1). */
export function d64WithPrg(name, prg, { diskName = "C64RE TEST", id = "RE" } = {}) {
  const img = new Uint8Array(683 * 256);
  const used = new Map([[18, new Set([0, 1])]]);

  // the file's chain: track 1, sectors 0, 1, 2, … (interleave is a speed matter, not a correctness one)
  const blocks = [];
  for (let i = 0; i < prg.length; i += 254) blocks.push(prg.subarray(i, i + 254));
  if (blocks.length === 0) blocks.push(new Uint8Array(0));
  blocks.forEach((b, i) => {
    const o = off(1, i);
    if (i + 1 < blocks.length) img.set([1, i + 1], o);
    else img.set([0, b.length + 1], o);
    img.set(b, o + 2);
    (used.get(1) ?? used.set(1, new Set()).get(1)).add(i);
  });

  // BAM: free count and 3 bitmap bytes per track (a set bit = free), from byte 4
  const bam = off(18, 0);
  img.set([18, 1, 0x41, 0x00], bam);
  for (let t = 1; t <= 35; t++) {
    const taken = used.get(t) ?? new Set();
    const bits = [0, 0, 0];
    let free = 0;
    for (let s = 0; s < SECTORS_ON(t); s++) {
      if (taken.has(s)) continue;
      bits[s >> 3] |= 1 << (s & 7);
      free++;
    }
    img.set([free, ...bits], bam + 4 * t);
  }
  img.set(petscii(diskName, 16), bam + 0x90);
  img.set([0xa0, 0xa0, id.charCodeAt(0), id.charCodeAt(1), 0xa0, 0x32, 0x41, 0xa0, 0xa0, 0xa0, 0xa0], bam + 0xa0);

  const dir = off(18, 1);
  img.set([0x00, 0xff], dir);
  img.set([0x82, 1, 0], dir + 2);
  img.set(petscii(name, 16), dir + 5);
  img.set([blocks.length & 0xff, blocks.length >> 8], dir + 30);
  return img;
}
