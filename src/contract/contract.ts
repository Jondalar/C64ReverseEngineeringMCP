// Spec 848 — the project contract: what the human expects, written once, before leaving.
//
// The owner, correcting the premise of the first unattended run: "Ne moment, ich würde ja
// schon klar sagen was ich erwarte BEVOR ich weggehe." The trial gave its agent a scope
// and explicitly left the order open, which is not how he works — and there was nowhere
// for expectations to live anyway. In a prompt they die with the session; in steering.md
// they survive as prose, and prose is advisory.
//
// So: a contract, stored, in a vocabulary the machine can check.
//
// TWO RULES SHAPE IT.
//
// It asks about DELIVERY, never about FACTS. At the kickoff of Neuromancer nobody knows
// whether the game saves, how many runtimes it has, or where free RAM is — that is the
// work. A contract that asks "does it save?" collects a guess and then wears it like a
// finding. It asks "I want to know whether and how it saves", which is an instruction.
//
// It may demand LESS than the default. Spec 844's slot list is a TEMPLATE, not a law: a
// game with no save has no S10, and today that is decided by a condition I guessed at. If
// the contract could only add, it would be my defaults with extra steps.
//
// It is also where the three numbers nobody had finally live — the coverage threshold
// (844 S12), the runtime ratchet (844 D5) and the orphan ratio (846). They were global
// defaults picked blind; 0.6 coverage was visibly wrong for Ultima VI on first contact.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface DocumentDemand {
  /** `$4300-$73FC`, or an artifact name — what a document must cover. */
  covers: string;
  /** Why this needs writing up, in the owner's words. */
  why?: string;
}

export interface ProjectContract {
  /** What the job is, in one sentence. Not checkable — it is the frame for a human. */
  goal: string;
  deliver: {
    /** Which Spec 844 slots this project owes. Omitted = the full default set. */
    slots?: string[];
    /** Bytes inside a HUMANLY named thing, as a fraction. Machine names do not count. */
    namedRatio?: number;
    /** Bytes inside any known address range, as a fraction (844 S12). */
    coverageRatio?: number;
    /** Payloads that must carry semantic annotations before this counts as done. */
    annotate?: string[];
    /** Synthesis that must exist and declare itself (Spec 847). */
    documents?: DocumentDemand[];
  };
  limits?: {
    /** Gated runtime calls allowed with no durable record (844 D5). */
    runtimeRatchet?: number;
    /** Fraction of nodes allowed outside every named boundary (846). */
    orphanRatio?: number;
  };
}

/** No contract = the defaults that were in the code before. Never a refusal. */
export const DEFAULT_CONTRACT: ProjectContract = {
  goal: "(no contract set — using defaults)",
  deliver: { coverageRatio: 0.6 },
  limits: { runtimeRatchet: 4, orphanRatio: 0.5 },
};

export function contractPath(projectDir: string): string {
  return join(projectDir, "knowledge", "contract.json");
}

export function loadContract(projectDir: string): { contract: ProjectContract; present: boolean } {
  const p = contractPath(projectDir);
  if (!existsSync(p)) return { contract: DEFAULT_CONTRACT, present: false };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<ProjectContract>;
    return {
      present: true,
      contract: {
        goal: typeof raw.goal === "string" ? raw.goal : DEFAULT_CONTRACT.goal,
        deliver: { ...(raw.deliver ?? {}) },
        limits: { ...DEFAULT_CONTRACT.limits, ...(raw.limits ?? {}) },
      },
    };
  } catch {
    // A malformed contract must not brick the project; it is reported by the lint.
    return { contract: DEFAULT_CONTRACT, present: false };
  }
}

export function saveContract(projectDir: string, contract: ProjectContract): string {
  const p = contractPath(projectDir);
  mkdirSync(join(projectDir, "knowledge"), { recursive: true });
  writeFileSync(p, JSON.stringify(contract, null, 2) + "\n");
  return p;
}

/**
 * The questions a kickoff asks. C64RE supplies them; the HARNESS conducts the dialog and
 * writes the answer back — the same division as Spec 846 D5. C64RE never holds a model
 * client, and a question handed over is not a model driven.
 *
 * Every one of these asks for a deliverable. None asks what is true about the game.
 */
export const KICKOFF_QUESTIONS: ReadonlyArray<{ field: string; ask: string; note: string }> = [
  {
    field: "goal",
    ask: "What is this job for, in one sentence?",
    note: "e.g. \"judge whether this can be ported to an EasyFlash cartridge\". The frame, not a checkable.",
  },
  {
    field: "deliver.slots",
    ask: "Which of the fourteen standard questions must be answered for THIS game?",
    note: "The default is all of them. Drop the ones that cannot apply — a game with no save owes no S10.",
  },
  {
    field: "deliver.annotate",
    ask: "Which parts must be semantically annotated, not merely disassembled?",
    note: "Naming is where meaning enters the graph. Name the payloads whose routines must carry names.",
  },
  {
    field: "deliver.documents",
    ask: "What must be written up as prose, and covering which range?",
    note: "The argued narrative a graph cannot hold. Give the address range or artifact it must cover.",
  },
  {
    field: "deliver.namedRatio",
    ask: "How much of the code must carry human names before this counts as mapped?",
    note: "A fraction. Machine names (unknown_3E00, addr_0006) do not count toward it.",
  },
];

export function formatContract(c: ProjectContract, present: boolean): string {
  const out: string[] = [];
  out.push(present ? `Contract: ${c.goal}` : "No contract set — running on defaults.");
  const d = c.deliver ?? {};
  if (d.slots) out.push(`  slots owed:    ${d.slots.join(", ")}`);
  else out.push("  slots owed:    (all of the default fourteen)");
  if (d.annotate?.length) out.push(`  annotate:      ${d.annotate.join(", ")}`);
  if (d.documents?.length) out.push(`  documents:     ${d.documents.map((x) => x.covers).join(", ")}`);
  if (d.namedRatio !== undefined) out.push(`  named:         >= ${(d.namedRatio * 100).toFixed(0)} %`);
  if (d.coverageRatio !== undefined) out.push(`  coverage:      >= ${(d.coverageRatio * 100).toFixed(0)} %`);
  const l = c.limits ?? {};
  if (l.runtimeRatchet !== undefined) out.push(`  ratchet:       ${l.runtimeRatchet} runtime calls without a record`);
  if (l.orphanRatio !== undefined) out.push(`  orphans:       <= ${(l.orphanRatio * 100).toFixed(0)} %`);
  if (!present) {
    out.push("", "`contract_set` writes one. It says what you EXPECT — never what is true about the");
    out.push("game, which is the work and is not knowable at kickoff.");
  }
  return out.join("\n");
}
