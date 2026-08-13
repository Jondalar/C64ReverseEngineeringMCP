// Spec 750.4 + 750.5 — the two addressing kinds §1 names that are not a LUT.
//
// §1's model has three: LUT (index → position), code-embedded position (the T/S or
// bank baked into the loader's own instructions), and dispatch (an index steering a
// loader). 750.7 covers the first through the indexed-access anchor. These two cover
// the rest, from the same proven source — `codeAnalysis.instructions`, where every
// instruction carries its mnemonic, addressing mode and resolved operand.
//
// Same discipline as 750.7: propose, do not decide. A pattern match names a CANDIDATE
// entry point and quotes the instructions that made it one. It never writes, and it
// never claims to know what the routine does.

export interface AnalysedInstruction {
  address: number;
  mnemonic?: string;
  addressingMode?: string;
  operandValue?: number;
  targetAddress?: number;
  size?: number;
}

export interface ProposedEntryPoint {
  kind: "sector-load" | "dispatch";
  /** The address to declare as the entry point. */
  address: number;
  /** For sector-load: the position baked into the code. */
  track?: number;
  sector?: number;
  /** For dispatch: the table the index reads, when one is visible. */
  tableAddress?: number;
  /** Instruction addresses that produced this reading, so it can be checked. */
  witnesses: number[];
  evidence: string[];
  confidence: number;
}

const hx = (n: number) => `$${n.toString(16).toUpperCase().padStart(4, "0")}`;
const h2 = (n: number) => `$${n.toString(16).toUpperCase().padStart(2, "0")}`;

/** 750.4 — a POSITION baked into the code.
 *
 *  The shape is an immediate track and an immediate sector loaded close together and
 *  followed by a call: `LDA #$11 / LDX #$04 / JSR $xxxx`. The registers vary by loader,
 *  so this matches on the VALUES being plausible rather than on which register holds
 *  which — a 1541 has tracks 1..40 and at most 21 sectors, and that pair of ranges is
 *  narrow enough to be worth something.
 *
 *  It is a candidate, not a finding: `LDA #$11 / LDX #$04` is also two ordinary
 *  constants. The JSR is what makes it worth reporting, and the confidence says how
 *  tight the window was. */
export function detectSectorLoads(
  instructions: AnalysedInstruction[],
  opts: { window?: number; minCallSites?: number } = {},
): ProposedEntryPoint[] {
  const window = opts.window ?? 8;
  const out: ProposedEntryPoint[] = [];
  const LOADS = new Set(["lda", "ldx", "ldy"]);
  const plausibleTrack = (v: number) => v >= 1 && v <= 40;
  const plausibleSector = (v: number) => v <= 20;

  // Search BACKWARDS from each call. Forwards was wrong in a way the shapes hide: the
  // scan ran past the `jsr` that ends one parameter setup and paired that call's SECTOR
  // with the next call's TRACK, inventing positions like 1/17 out of two unrelated
  // sites. A call is the boundary of its own setup.
  for (let k = 0; k < instructions.length; k++) {
    const c = instructions[k];
    if (c.mnemonic !== "jsr" || c.targetAddress === undefined) continue;

    const imms: AnalysedInstruction[] = [];
    for (let j = k - 1; j >= 0 && j >= k - window; j--) {
      const x = instructions[j];
      // Another call ends this setup — anything before it belongs to that one.
      if (x.mnemonic === "jsr") break;
      if (!LOADS.has((x.mnemonic ?? "").toLowerCase())) continue;
      if (x.addressingMode !== "imm" || x.operandValue === undefined) continue;
      imms.unshift(x);
    }
    if (imms.length < 2) continue;

    // Take the LAST two immediates before the call — those are the ones still in the
    // registers. Which of the pair is track and which is sector is the loader's own
    // convention, so try the reading that fits both ranges and report only that.
    const [x, y] = imms.slice(-2);
    let track: number | undefined, sector: number | undefined, first = x, second = y;
    if (plausibleTrack(x.operandValue!) && plausibleSector(y.operandValue!)) {
      track = x.operandValue; sector = y.operandValue;
    } else if (plausibleTrack(y.operandValue!) && plausibleSector(x.operandValue!)) {
      track = y.operandValue; sector = x.operandValue; first = y; second = x;
    }
    if (track === undefined || sector === undefined) continue;

    const span = c.address - Math.min(x.address, y.address);
    out.push({
      kind: "sector-load",
      address: c.targetAddress,
      track,
      sector,
      witnesses: [x.address, y.address, c.address],
      evidence: [
        `${first.mnemonic} #${h2(track)} at ${hx(first.address)} (track ${track}?), ${second.mnemonic} #${h2(sector)} at ${hx(second.address)} (sector ${sector}?), then jsr ${hx(c.targetAddress)} at ${hx(c.address)} — ${span} bytes apart`,
        "Two immediates and a call. Plausible as a baked-in position; also plausible as two ordinary constants — read the target before declaring it.",
      ],
      confidence: Math.max(0.25, Math.min(0.5, 0.5 - span / 100)),
    });
  }

  // A real load routine is CALLED MANY TIMES, with different positions. `lda #$01 /
  // ldx #$00 / jsr` is also just two parameters and a call, which is the commonest
  // shape in any 6502 program — on its own it reported forty candidates in code that
  // reads no disk at all. Grouping by the call TARGET and demanding several distinct
  // (track, sector) pairs is what separates a loader from ordinary parameter passing:
  // nobody calls the same routine with fifteen different plausible T/S pairs by
  // accident.
  const byTarget = new Map<number, ProposedEntryPoint[]>();
  for (const p of out) {
    const bucket = byTarget.get(p.address) ?? [];
    bucket.push(p);
    byTarget.set(p.address, bucket);
  }
  const kept: ProposedEntryPoint[] = [];
  for (const [target, group] of byTarget) {
    const pairs = new Set(group.map((g) => `${g.track}/${g.sector}`));
    if (pairs.size < (opts.minCallSites ?? 3)) continue;
    const best = group.sort((a, b) => b.confidence - a.confidence)[0];
    kept.push({
      ...best,
      witnesses: group.flatMap((g) => g.witnesses).slice(0, 12),
      evidence: [
        `${hx(target)} is called from ${group.length} site(s) with ${pairs.size} DISTINCT position(s): ${[...pairs].slice(0, 8).join(", ")}${pairs.size > 8 ? " …" : ""}`,
        ...best.evidence.slice(0, 1),
        "Many call sites with different positions is what makes this a load routine rather than two parameters and a call.",
      ],
      // Called with many distinct positions is real evidence; two is a coincidence.
      confidence: Math.min(0.8, 0.3 + pairs.size * 0.06),
    });
  }
  return kept.sort((a, b) => b.confidence - a.confidence).slice(0, 20);
}

/** 750.5 — DISPATCH: an index steering where control goes.
 *
 *  Two shapes, and both are named rather than guessed at:
 *
 *    `JMP (vector)`   — an indirect jump. The vector is the dispatch point; whoever
 *                       writes it decides the target.
 *    the RTS trampoline — `LDA table,X / PHA / LDA table2,X / PHA / RTS`, which pushes
 *                       a computed address and returns to it. Two parallel tables of
 *                       high and low bytes, which is also a `layout=columns` table:
 *                       750.7's anchor will have found the same pair from the other
 *                       side, and the two agreeing is worth more than either alone. */
export function detectDispatch(instructions: AnalysedInstruction[]): ProposedEntryPoint[] {
  const out: ProposedEntryPoint[] = [];

  for (let i = 0; i < instructions.length; i++) {
    const ins = instructions[i];

    // Indirect jump.
    if (ins.mnemonic === "jmp" && ins.addressingMode === "ind") {
      const vector = ins.targetAddress ?? ins.operandValue;
      out.push({
        kind: "dispatch",
        address: ins.address,
        tableAddress: vector,
        witnesses: [ins.address],
        evidence: [
          `jmp (${vector !== undefined ? hx(vector) : "?"}) at ${hx(ins.address)} — control goes wherever that vector points, so whoever writes it is the dispatcher`,
        ],
        confidence: 0.7,
      });
      continue;
    }

    // RTS trampoline: two indexed loads each followed by a push, then a return.
    if (ins.mnemonic !== "lda" || !(ins.addressingMode ?? "").startsWith("abs,")) continue;
    const w = instructions.slice(i, i + 10);
    const pushes = w.filter((x) => x.mnemonic === "pha").length;
    const rtsAt = w.findIndex((x) => x.mnemonic === "rts");
    const indexedLoads = w.filter((x) => x.mnemonic === "lda" && (x.addressingMode ?? "").startsWith("abs,"));
    if (pushes < 2 || rtsAt < 0 || indexedLoads.length < 2) continue;

    const tables = [...new Set(indexedLoads.map((x) => x.targetAddress ?? x.operandValue).filter((v): v is number => v !== undefined))];
    out.push({
      kind: "dispatch",
      address: ins.address,
      tableAddress: tables[0],
      witnesses: [ins.address, ...w.filter((x) => x.mnemonic === "pha" || x.mnemonic === "rts").map((x) => x.address)],
      evidence: [
        `RTS trampoline at ${hx(ins.address)}: ${indexedLoads.length} indexed load(s) from ${tables.map(hx).join(" / ")}, ${pushes} push(es), then rts`,
        "The pushed address is computed from the tables, so the index chooses the target. Those tables are a columns-layout pair — declare_lut_descriptor can describe them, and suggest_lut_descriptor should have found the same pair from the code side.",
      ],
      confidence: 0.75,
    });
  }
  return dedupeByAddress(out).slice(0, 40);
}

function dedupeByAddress(list: ProposedEntryPoint[]): ProposedEntryPoint[] {
  const seen = new Map<string, ProposedEntryPoint>();
  for (const p of list) {
    const key = `${p.kind}:${p.address}:${p.track ?? ""}:${p.sector ?? ""}`;
    const prev = seen.get(key);
    if (!prev || p.confidence > prev.confidence) seen.set(key, p);
  }
  return [...seen.values()].sort((a, b) => b.confidence - a.confidence);
}

export function formatEntryPoints(list: ProposedEntryPoint[]): string {
  if (!list.length) {
    return "No baked-in position and no dispatch found. A loader that computes its position, or reaches its target through a pointer the disassembler could not resolve, leaves neither pattern behind — read the code.";
  }
  const out: string[] = [];
  const bySort = { "sector-load": [] as ProposedEntryPoint[], dispatch: [] as ProposedEntryPoint[] };
  for (const p of list) bySort[p.kind].push(p);

  if (bySort.dispatch.length) {
    out.push(`DISPATCH — ${bySort.dispatch.length} candidate(s): an index steering where control goes`);
    for (const p of bySort.dispatch) {
      out.push(`  ${hx(p.address)}  confidence ${p.confidence.toFixed(2)}${p.tableAddress !== undefined ? `  table ${hx(p.tableAddress)}` : ""}`);
      for (const e of p.evidence) out.push(`     ${e}`);
    }
    out.push("");
  }
  if (bySort["sector-load"].length) {
    out.push(`CODE-EMBEDDED POSITION — ${bySort["sector-load"].length} candidate(s): a track/sector baked into the loader`);
    for (const p of bySort["sector-load"]) {
      out.push(`  ${hx(p.address)}  T${p.track}/S${p.sector}  confidence ${p.confidence.toFixed(2)}`);
      for (const e of p.evidence) out.push(`     ${e}`);
    }
    out.push("");
  }
  out.push("Nothing was written. Each of these is a pattern in the instructions, not a reading of what the routine does — open the witnesses before declaring one.");
  return out.join("\n");
}
