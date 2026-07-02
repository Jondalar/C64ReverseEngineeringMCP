// Firehose content-dedup (view-layer, display-only) — helper contract + parity.
// Runs the ACTUAL ui/src/lib/dedupe.ts via tsx (the same code the UI imports),
// asserting: (1) correct content-key collapse counts, (2) survivor precedence
// (answered>open, active>archived, max confidence, newest), and (3) the PARITY
// property that makes it safe — output is a SUBSET of the input by id (no
// fabricated survivor id), so every id-lookup on the full array still resolves.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

const { dedupeEntities, dedupeFindings, dedupeQuestions, dedupeByContentKey } =
  await import(`${ROOT}/ui/src/lib/dedupe.ts`);

console.log("Firehose content-dedup — helper contract + parity\n");

// ── entities: (kind,name) key + active>archived precedence ──
const entities = [
  { id: "e1", kind: "state-variable", name: "counter_0012", status: "archived", confidence: 0.5, updatedAt: "2026-06-03T14:00:00Z" },
  { id: "e2", kind: "state-variable", name: "counter_0012", status: "active", confidence: 0.5, updatedAt: "2026-06-03T16:00:00Z" },
  { id: "e3", kind: "state-variable", name: "counter_0013", status: "active", confidence: 0.4, updatedAt: "2026-06-03T10:00:00Z" },
  { id: "e4", kind: "code-segment", name: "counter_0012", status: "active", confidence: 0.9, updatedAt: "2026-06-03T10:00:00Z" }, // different kind → own group
];
const de = dedupeEntities(entities);
ok(de.length === 3, "entities collapse by (kind,name)", `got ${de.length} of 4`);
ok(de.find((e) => e.name === "counter_0012" && e.kind === "state-variable")?.id === "e2",
  "entity survivor = active over archived", de.find((e) => e.name === "counter_0012" && e.kind === "state-variable")?.id);
ok(de.some((e) => e.id === "e4"), "different kind = separate group (not collapsed)");

// ── findings: title key + max confidence ──
const findings = [
  { id: "f1", title: "RAM 0013 counter", status: "active", confidence: 0.6, updatedAt: "2026-06-03T10:00:00Z" },
  { id: "f2", title: "RAM 0013 counter", status: "active", confidence: 0.9, updatedAt: "2026-06-03T09:00:00Z" },
  { id: "f3", title: "RAM 001D buffer", status: "active", confidence: 0.5, updatedAt: "2026-06-03T10:00:00Z" },
];
const df = dedupeFindings(findings);
ok(df.length === 2, "findings collapse by title", `got ${df.length} of 3`);
ok(df.find((f) => f.title === "RAM 0013 counter")?.id === "f2",
  "finding survivor = max confidence (0.9 over 0.6)", df.find((f) => f.title === "RAM 0013 counter")?.id);

// ── questions: title key + answered>open (THE regression the audit flagged) ──
const questions = [
  { id: "q1", title: "Validate 00E1 flag", status: "answered", confidence: 0.5, updatedAt: "2026-05-30T10:00:00Z", answeredByFindingId: "finding-x" },
  { id: "q2", title: "Validate 00E1 flag", status: "open", confidence: 0.5, updatedAt: "2026-06-03T10:00:00Z" }, // newer but re-opened by a re-run
  { id: "q3", title: "Validate 001F flag", status: "open", confidence: 0.5, updatedAt: "2026-06-03T10:00:00Z" },
];
const dq = dedupeQuestions(questions);
ok(dq.length === 2, "questions collapse by title", `got ${dq.length} of 3`);
const survivor = dq.find((q) => q.title === "Validate 00E1 flag");
ok(survivor?.id === "q1" && survivor?.status === "answered",
  "question survivor = ANSWERED over newer-but-open (no answer loss)", `${survivor?.id}/${survivor?.status}`);

// ── PARITY property: output ⊆ input by id (no fabricated ids) ──
const inputIds = new Set([...entities, ...findings, ...questions].map((r) => r.id));
const outputIds = [...de, ...df, ...dq].map((r) => r.id);
ok(outputIds.every((id) => inputIds.has(id)), "every survivor id ∈ input (no fabricated id → lookups resolve)", outputIds.join(","));
ok(new Set(outputIds).size === outputIds.length, "no duplicate survivor ids in output");

// ── order preserved (first-appearance) ──
const order = dedupeByContentKey(
  [{ id: "a", name: "z", kind: "k" }, { id: "b", name: "a", kind: "k" }, { id: "c", name: "z", kind: "k" }],
  (r) => r.name,
);
ok(order.map((r) => r.id).join(",") === "a,b", "first-appearance order preserved", order.map((r) => r.id).join(","));

// ── empty + singleton ──
ok(dedupeEntities([]).length === 0, "empty input → empty output");
ok(dedupeEntities([{ id: "s", kind: "k", name: "n", status: "active", confidence: 1 }]).length === 1, "singleton passes through");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} firehose-dedupe: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
