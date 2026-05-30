// Spec 730 §5 / §5.1 — the machine-readable workflow model.
//
// This is the SINGLE SOURCE of step ids, phase ids, default tool names, branch
// ids, and completion checks for the step orchestrator (agent_next_step /
// agent_run_step). It is a small typed `as const` table — NOT a JSON loader and
// NOT a framework. 730 does not invent a new workflow; it operationalizes the
// existing LLM-human-MCP-runtime swimlane as code.
//
// agent_next_step MUST read step/phase/tool/branch/completion data from here.
// Only the explanation (`why`), counts, concrete file paths, and human prompts
// are computed dynamically from project state.
//
// `defaultTool` is ALWAYS either a callable DEFAULT-surface tool name or
// undefined (ask-human, and change-validate which is blocked until Spec 711).
// It must never be an internal/advanced tool — those only appear in the
// orchestrator's `doNotCall` leakage list.

export type WorkflowActor = "mcp" | "llm" | "human" | "runtime";

export interface WorkflowStep {
  /** Stable step id (kebab-case). Source of truth for agent_next_step. */
  readonly id: string;
  /** Product phase id (a family of steps), per §5 valid next-step families. */
  readonly phase: string;
  /** Who performs the step. */
  readonly actor: WorkflowActor;
  /**
   * The single callable DEFAULT-surface tool that performs this step, or
   * undefined when the step is a human decision (`ask-human`) or is not yet
   * implementable from the product surface (`change-validate`, blocked).
   */
  readonly defaultTool: string | undefined;
  /** Human-readable title used in suggestions. */
  readonly title: string;
  /** Conditions that mark the step done (consumed by completion checks). */
  readonly completionChecks: readonly string[];
  /** Valid iterative branch step ids reachable after this step. */
  readonly branches: readonly string[];
  /**
   * Set when the step cannot be run from the product surface yet. The only
   * blocked MVP step is `change-validate` (patch/validate loop), gated on
   * Spec 711.
   */
  readonly blockedUntil?: string;
}

export const C64RE_WORKFLOW_STEPS = [
  {
    id: "project-init",
    phase: "project-setup",
    actor: "mcp",
    defaultTool: "project_init",
    title: "Initialize the C64RE project",
    completionChecks: ["project-initialized"],
    branches: ["inventory-sync", "media-inspect", "ask-human"],
  },
  {
    id: "inventory-sync",
    phase: "media-inventory",
    actor: "mcp",
    defaultTool: "project_inventory_sync",
    title: "Register / import / rebuild project state",
    completionChecks: ["no-unregistered-files", "no-unimported-manifests", "views-fresh"],
    branches: ["media-inspect", "static-analyze", "runtime-trace", "ask-human"],
  },
  {
    id: "media-inspect",
    phase: "media-inventory",
    actor: "llm",
    defaultTool: "inspect_disk",
    title: "Inspect known media before extraction",
    completionChecks: ["media-directory-read"],
    branches: ["media-extract", "disk-raw-inspect", "cart-chunk-inspect"],
  },
  {
    id: "media-extract",
    phase: "extraction",
    actor: "llm",
    defaultTool: "extract_disk",
    title: "Extract DOS files / CRT banks / payloads",
    completionChecks: ["payloads-extracted"],
    branches: ["inventory-sync", "static-analyze", "disk-raw-inspect", "cart-chunk-inspect"],
  },
  {
    id: "disk-raw-inspect",
    phase: "raw-disk-inspection",
    actor: "llm",
    defaultTool: "list_g64_slots",
    title: "Inspect raw G64/disk structure",
    completionChecks: ["raw-disk-inspected"],
    branches: ["media-extract", "record-knowledge", "inventory-sync"],
  },
  {
    id: "cart-chunk-inspect",
    phase: "cartridge-inspection",
    actor: "llm",
    defaultTool: "bulk_create_cart_chunk_payloads",
    title: "Promote / inspect cartridge bank chunks",
    completionChecks: ["cart-chunks-inspected"],
    branches: ["static-analyze", "record-knowledge", "inventory-sync"],
  },
  {
    id: "static-analyze",
    phase: "static-disassembly",
    actor: "llm",
    defaultTool: "analyze_prg",
    title: "Produce structural PRG analysis",
    completionChecks: ["analysis-present"],
    branches: ["static-disassemble", "runtime-trace"],
  },
  {
    id: "static-disassemble",
    phase: "static-disassembly",
    actor: "llm",
    defaultTool: "disasm_prg",
    title: "Produce ASM / TASS source",
    completionChecks: ["source-present"],
    branches: ["semantic-annotate", "runtime-trace", "record-knowledge"],
  },
  {
    id: "semantic-annotate",
    phase: "semantic-annotation",
    actor: "llm",
    defaultTool: "propose_annotations",
    title: "Add semantic labels / comments / segment knowledge",
    completionChecks: ["annotations-present"],
    branches: ["record-knowledge", "runtime-trace", "change-validate"],
  },
  {
    id: "runtime-trace",
    phase: "runtime-trace",
    actor: "runtime",
    defaultTool: "runtime_session_start",
    title: "Run Headless and capture trace / marks / screens",
    completionChecks: ["trace-captured"],
    branches: ["trace-query", "visual-inspect", "record-knowledge"],
  },
  {
    id: "trace-query",
    phase: "trace-validation",
    actor: "llm",
    defaultTool: "runtime_query_events",
    title: "Query traces for executed code / data / loader facts",
    completionChecks: ["trace-mined"],
    branches: ["static-disassemble", "visual-inspect", "record-knowledge"],
  },
  {
    id: "visual-inspect",
    phase: "visual-inspection",
    actor: "llm",
    defaultTool: "runtime_vic_inspect_at",
    title: "Resolve screen pixels / assets to runtime/VIC evidence",
    completionChecks: ["visual-resolved"],
    branches: ["record-knowledge", "runtime-trace"],
  },
  {
    id: "record-knowledge",
    phase: "documentation",
    actor: "llm",
    defaultTool: "save_finding",
    title: "Persist findings / entities / relations",
    completionChecks: ["knowledge-saved"],
    branches: ["inventory-sync", "static-disassemble", "runtime-trace", "ask-human"],
  },
  {
    id: "ask-human",
    phase: "human-decision",
    actor: "human",
    defaultTool: undefined,
    title: "Ask the cracker / operator for a decision",
    completionChecks: ["human-answered"],
    branches: ["inventory-sync", "static-analyze", "runtime-trace"],
  },
  {
    id: "change-validate",
    phase: "change-validation",
    actor: "llm",
    defaultTool: undefined,
    title: "Patch / change / validate loop",
    completionChecks: ["change-validated"],
    branches: ["runtime-trace", "record-knowledge"],
    blockedUntil: "Spec 711",
  },
] as const;

export type WorkflowStepId = (typeof C64RE_WORKFLOW_STEPS)[number]["id"];

const STEP_BY_ID = new Map<string, WorkflowStep>(
  C64RE_WORKFLOW_STEPS.map((s) => [s.id, s as WorkflowStep]),
);

export function workflowStep(id: string): WorkflowStep | undefined {
  return STEP_BY_ID.get(id);
}

/** Internal implementation tools the product surface must never recommend as a
 * next action — they may appear ONLY in agent_next_step's `doNotCall` list as
 * forbidden leakage (Spec 730 §1 / §8). They are wrapped behind product
 * facades (project_inventory_sync / build_all_views). */
export const FORBIDDEN_PRODUCT_TOOLS: readonly string[] = [
  "register_existing_files",
  "scan_registration_delta",
  "import_manifest_artifact",
  "build_disk_layout_view",
  "build_cartridge_layout_view",
] as const;
