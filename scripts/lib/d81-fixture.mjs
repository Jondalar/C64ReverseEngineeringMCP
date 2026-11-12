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

/**
 * A 1581 image built piece by piece (Spec 921 tests): header 40/0, BAM links 40/1 and 40/2, an
 * empty directory at 40/3. Files are chains written from a given track/sector; a partition is a
 * contiguous range, optionally holding its own header (`T/0`, 'D' at $02) and directory (`T/3`).
 * Nothing here is allocated in the BAM: the parser reads sectors, not allocation.
 */
export class D81Image {
  constructor({ diskName = "C64RE TEST", id = "RE" } = {}) {
    this.img = new Uint8Array(80 * SECTORS * 256);
    this.rootDir = [];
    this.header(40, diskName, id);
    this.img.set([40, 2, 0x44, 0xbb], off(40, 1));
    this.img.set([0, 0xff, 0x44, 0xbb], off(40, 2));
    this.img.set([0, 0xff], off(40, 3));
  }

  /** A header sector at track/0: link to track/3, 'D', name, id, "3D". */
  header(track, diskName, id) {
    const h = off(track, 0);
    this.img.set([track, 3, 0x44, 0x00], h);
    this.img.set(petscii(diskName, 16), h + 4);
    this.img.set([0xa0, 0xa0, id.charCodeAt(0), id.charCodeAt(1), 0xa0, 0x33, 0x44, 0xa0, 0xa0], h + 20);
  }

  /** Raw bytes into a sector (from byte 0). */
  put(track, sector, bytes) { this.img.set(bytes, off(track, sector)); return this; }

  /** A file's chain: `bytes` cut in 254-byte pieces over consecutive sectors from track/sector. Returns the cells. */
  chain(track, sector, bytes) {
    const cells = [];
    let t = track, s = sector;
    for (let at = 0; at < bytes.length || cells.length === 0; at += 254) {
      cells.push([t, s]);
      let nt = t, ns = s + 1;
      if (ns >= SECTORS) { ns = 0; nt += 1; }
      const piece = bytes.subarray(at, at + 254);
      const last = at + 254 >= bytes.length;
      this.img.set(last ? [0, piece.length + 1] : [nt, ns], off(t, s));
      this.img.set(piece, off(t, s) + 2);
      t = nt; s = ns;
      if (last) break;
    }
    return cells;
  }

  /** A directory entry in the directory sector at `dirTrack`/3 (slot 0..7). */
  entry(dirTrack, slot, type, track, sector, name, size) {
    const o = off(dirTrack, 3) + slot * 32;
    this.img.set([type, track, sector], o + 2);
    this.img.set(petscii(name, 16), o + 5);
    this.img.set([size & 0xff, size >> 8], o + 30);
  }

  /** A PRG whose chain starts at track/sector, listed in the root directory. */
  addFile(name, bytes, track, sector) {
    const cells = this.chain(track, sector, bytes);
    this.entry(40, this.rootDir.length, 0x82, track, sector, name, cells.length);
    this.rootDir.push(name);
    return cells;
  }

  /**
   * A CBM partition of `sectors` sectors from track/0 (or `sector`), listed in the root directory.
   * `files` ([{name, bytes, track, sector}]) make it a subdirectory: header at track/0, its
   * directory at track/3, the files' chains absolute (they sit inside the partition).
   * `nested` is a partition entry placed in that sub-directory: {name, track, sector, size}.
   */
  addPartition(name, track, sectors, { sector = 0, files = [], nested = [], diskName = name, fill } = {}) {
    if (files.length > 0 || nested.length > 0) {
      this.header(track, diskName, "SB");
      this.img.set([0, 0xff], off(track, 3));
      files.forEach((f, i) => {
        const cells = this.chain(f.track, f.sector, f.bytes);
        this.entry(track, i, 0x82, f.track, f.sector, f.name, cells.length);
      });
      nested.forEach((n, i) => this.entry(track, files.length + i, 0x85, n.track, n.sector, n.name, n.size));
    } else if (fill !== undefined) {
      for (let i = 0; i < sectors; i++) {
        const abs = (track - 1) * SECTORS + sector + i;
        this.img.fill(fill & 0xff, abs * 256, abs * 256 + 256);
        this.img[abs * 256] = i & 0xff;
      }
    }
    this.entry(40, this.rootDir.length, 0x85, track, sector, name, sectors);
    this.rootDir.push(name);
  }
}
