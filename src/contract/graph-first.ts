// Spec 881 — the graph before the listing.
//
// The server's own instructions say the graph tools ARE the static analysis, indexed, and
// that they come before opening a full listing. Nothing enforced it and nothing measured
// it. Across the supervised runs of 2026-09-24/25 there were 103 reads of the rendered
// listing against 5 `disasm` calls — a 6000-line file read whole, repeatedly, to answer
// questions one graph call answers.
//
// Two mechanisms, and they are deliberately different in kind:
//
//   D1  a door: `read_artifact` refuses a LARGE listing until the graph has been asked
//       something this session. It binds what passes through it and nothing else.
//   D2  a measure: the ratio rides the contract footer as a delta and refuses nothing.
//
// Neither is sufficient. A shell `grep` walks past D1 untouched — 877's stated boundary —
// and D2 cannot see that shell at all. What D2 can do is make the tool-side habit visible,
// and the unattended series showed a footer delta changing behaviour where a static one
// did not.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const LEDGER = "graph-first.json";

/**
 * A listing this long is not read to answer a question; it is read because asking was
 * harder. Below it a whole read is the reasonable thing and the door stays silent.
 *
 * A constant with its reasoning beside it, not a setting: a threshold that can be
 * configured is turned down once, by whoever it annoys, and never back. It is a guess from
 * the listings in the corpus and §6 of the spec says so — the first supervised run after
 * this ships is what corrects it.
 */
export const LARGE_LISTING_LINES = 1500;

/** The five doors that count as having asked the graph. */
export const GRAPH_TOOLS: ReadonlySet<string> = new Set([
  "graph_find", "graph_node", "graph_edges", "graph_path", "graph_overview",
]);

interface GraphFirstLedger {
  /** Graph-tool calls seen since `agent_onboard` last re-armed this. */
  graphCalls: number;
  /** Listing reads served since then, through tools. Shell reads are invisible here. */
  listingReads: number;
  /** Large listings already served this session — the door asks once, not every time. */
  served: string[];
  /** What the last footer said, so it can speak on a delta and stay quiet otherwise. */
  lastReported?: string;
}

const EMPTY: GraphFirstLedger = { graphCalls: 0, listingReads: 0, served: [] };

function ledgerPath(projectDir: string): string {
  return join(projectDir, "knowledge", LEDGER);
}

function read(projectDir: string): GraphFirstLedger {
  try {
    const p = ledgerPath(projectDir);
    if (!existsSync(p)) return { ...EMPTY };
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<GraphFirstLedger>;
    return {
      graphCalls: typeof raw.graphCalls === "number" ? raw.graphCalls : 0,
      listingReads: typeof raw.listingReads === "number" ? raw.listingReads : 0,
      served: Array.isArray(raw.served) ? raw.served.map(String) : [],
      lastReported: typeof raw.lastReported === "string" ? raw.lastReported : undefined,
    };
  } catch {
    return { ...EMPTY };
  }
}

function write(projectDir: string, l: GraphFirstLedger): void {
  try {
    const p = ledgerPath(projectDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(l, null, 2)}\n`, "utf8");
  } catch {
    /* A counter that cannot be written must never break the call it was counting. */
  }
}

/**
 * A new session starts owed nothing and having asked nothing. Called by `agent_onboard`,
 * the same way it re-arms the project rules and 877 D4's alias notices — a server outlives
 * a session, and a door armed per process fires once a week.
 */
export function resetGraphFirst(projectDir: string): void {
  write(projectDir, { ...EMPTY });
}

/** One of the five was called. */
export function noteGraphQuery(projectDir: string): void {
  const l = read(projectDir);
  l.graphCalls += 1;
  write(projectDir, l);
}

/** A listing went out through a tool. */
export function noteListingRead(projectDir: string, artifact: string): void {
  const l = read(projectDir);
  l.listingReads += 1;
  if (!l.served.includes(artifact)) l.served.push(artifact);
  write(projectDir, l);
}

export interface GraphFirstVerdict {
  /** null = go ahead. A string = the refusal, ready to return. */
  refusal: string | null;
}

/**
 * D1. Decide whether this read may proceed.
 *
 * The refusal is not a no. It names the file, its size, and the one call that would open
 * it — a door that only refuses teaches people to walk around it, and there is a shell
 * right there to walk around it with.
 */
export function graphFirstVerdict(
  projectDir: string,
  absPath: string,
  lineCount: number,
): GraphFirstVerdict {
  if (lineCount < LARGE_LISTING_LINES) return { refusal: null };

  const l = read(projectDir);
  if (l.graphCalls > 0) return { refusal: null };

  const rel = relative(resolve(projectDir), resolve(absPath)) || absPath;
  // Asked once per artifact per session. The point was to make the graph the FIRST
  // question, not to ration the text: a second read goes through.
  if (l.served.includes(rel)) return { refusal: null };

  return {
    refusal: [
      `# read_artifact refused — ${lineCount} lines, and the graph has not been asked yet`,
      "",
      `\`${rel}\` is ${lineCount} lines. The graph holds what is in it — routines, labels,`,
      "call and data edges, who writes which address — indexed, and answers a question in one",
      "call instead of a file in your context.",
      "",
      "Ask it something first. Any one of these opens this door:",
      "",
      "  graph_overview                 what this project is made of, and where the mass is",
      "  graph_find <address|name>      every node that matches, with ids that round-trip",
      "  graph_node <id>                one node in full",
      "  graph_edges <id>               what calls it, what it calls, what it touches",
      "  graph_path <from> <to>         how one reaches the other",
      "",
      "Then read this file if you still need the text — the refusal is once per session per",
      "file, and it does not come back for this one.",
      "",
      "The listing is not the knowledge. It is the rendering of it (Spec 822.2).",
    ].join("\n"),
  };
}

/**
 * D2. One line for the contract footer, or "" when nothing moved.
 *
 * Reports and never refuses: refusing a record punishes the behaviour we want. Speaks only
 * on a delta, because an identical footer becomes a banner and a banner is skipped — both
 * measured in the unattended series (run 7 against run 6).
 */
export function graphFirstFooter(projectDir: string): string {
  const l = read(projectDir);
  if (l.graphCalls === 0 && l.listingReads === 0) return "";

  const state = `${l.graphCalls}:${l.listingReads}`;
  if (state === l.lastReported) return "";
  write(projectDir, { ...l, lastReported: state });

  if (l.listingReads === 0) {
    return `Graph: ${l.graphCalls} quer${l.graphCalls === 1 ? "y" : "ies"}, no listing pulled into context yet.`;
  }
  const ratio = (l.graphCalls / l.listingReads).toFixed(1);
  const note = l.graphCalls >= l.listingReads
    ? "the indexed path is carrying the work"
    : "the listing is being read more often than the graph is asked";
  // Says what it counts. The 103 reads that motivated this spec were SHELL reads, which an
  // MCP server cannot see; claiming a ratio over all reading would be a number this cannot
  // measure.
  return `Graph: ${l.graphCalls} quer${l.graphCalls === 1 ? "y" : "ies"} against ${l.listingReads} listing read${l.listingReads === 1 ? "" : "s"} through tools (${ratio}×) — ${note}.`;
}
