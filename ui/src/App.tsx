import { createContext, startTransition, useContext, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HexView } from "./components/HexView.js";
import { AsmView, type AsmViewSource } from "./components/AsmView.js";
import { CartridgeMemoryGrid } from "./components/CartridgeMemoryGrid.js";
import { latestArtifactsByLineage, lineageVersionCount, isLatestInLineage } from "./lib/lineage.js";
import { isInternalArtifact, isInternalEntity } from "./lib/internal.js";

// Bug 24: nested panels read this to filter artifact lists to latest-only
// (default) or pass through (when "Show all versions" toggle is on).
// Identity-safe: when showAllVersions is true, latest() returns its input.
import { FileInspector, type FileInspectorActionButton, type FileInspectorHeadlineExtra, type FileInspectorMetaRow, type FileInspectorSpanRow } from "./components/FileInspector.js";
import { MediumPanelShell, type MediumOriginPillSpec } from "./components/MediumPanelShell.js";
import { BootTracePanel } from "./components/BootTracePanel.js";
import { C64GraphicsView, type GraphicsRenderKind } from "./components/C64GraphicsView.js";
// BUG-011/012: the visualization panels were extracted into a shared module so
// v1 + v3 render the same real UI (heatmap / SVG disk / bank-chip grid / flow svg).
import {
  MemoryMapPanel, CartridgePanel, DiskPanel, FlowPanel, EntityInspector,
  LineageVisibilityContext, useLineageVisibility,
  InternalVisibilityContext, useInternalVisibility,
} from "./components/workspace-panels.js";
// Spec 724B: the v3 Live C64 runtime tab, embedded into the product workbench.
// Self-contained (its own screen/controls/monitor/inspector via the WS client);
// styled by the scoped .wb-live CSS. WS connects lazily on first use (Live tab).
import { LiveTab } from "./workbench/tabs/Live.js";
import { getClient } from "./workbench/ws-client.js";
import { MonitorPopout } from "./workbench/components/MonitorPopout.js";
import type { CartridgeLutChunk } from "./types.js";
import type {
  ArtifactRecord,
  ArtifactVersionGroup,
  AuditCachedResponse,
  EntityRecord,
  FindingRecord,
  FlowGraphView,
  LoadSequenceView,
  MemoryMapView,
  OpenQuestionRecord,
  PrgReverseWorkflowResponse,
  ProjectAuditFinding,
  ProjectRepairOperation,
  ProjectRepairResponse,
  ProjectTeamMember,
  RelationRecord,
  WorkspaceUiSnapshot,
} from "./types";

// Spec 059 / UX1: view-centric tab structure (16 → 11). Removed:
// findings/entities/flows/relations (record-list tabs — surface inside
// inspector instead), load (folded into Flow sub-mode), activity
// (folded into Dashboard).
type TabId = "home" | "live" | "dashboard" | "questions" | "docs" | "memory" | "graphics" | "scrub" | "cartridge" | "disk" | "payloads" | "flow" | "listing";

interface UiConfig {
  defaultProjectDir: string;
}

interface UiDocument {
  id: string;
  title: string;
  relativePath: string;
  updatedAt: string;
  role?: string;
  unregistered?: boolean;
}

interface DiscoveredMarkdownDoc {
  path: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
  title?: string;
}

interface DocsApiResponse {
  projectDir: string;
  docs: DiscoveredMarkdownDoc[];
}

interface GraphicsItem {
  id: string;
  label: string;
  kind: string;
  start: number;
  end: number;
  length: number;
  prgArtifactId: string;
  prgRelativePath: string;
  prgLoadAddress: number;
  fileOffset: number;
  analysisArtifactId: string;
  confirmed?: boolean;
  rejected?: boolean;
  rejectedReason?: string;
  confirmedByArtifactId?: string;
}

interface GraphicsApiResponse {
  projectDir: string;
  items: GraphicsItem[];
  warnings: string[];
}

interface DocGroup {
  id: string;
  title: string;
  docs: UiDocument[];
}

interface TodoComposerState {
  mode: "task" | "question";
  title: string;
  description: string;
  entityIds: string[];
  artifactIds: string[];
}

type DiskFileSelection = { diskArtifactId: string; fileId: string };
type CartChunkSelection = { cartridgeArtifactId: string; chunk: CartridgeLutChunk };

// Spec 773 — the 5-phase RE project lifecycle (the first-level experience).
// The phase-strip is NAVIGATION (free forward/back), not a hard gate; the tab-strip
// below it is the phase-tools row for the active phase. Mirrors
// src/agent-orchestrator/lifecycle.ts + docs/product-vision §2A.
type Phase = "onboarding" | "discovery" | "re" | "build" | "release";
const PHASE_ORDER: Phase[] = ["onboarding", "discovery", "re", "build", "release"];
const PHASE_LABELS: Record<Phase, string> = {
  onboarding: "Onboarding",
  discovery: "Discovery",
  re: "Reverse Engineering",
  build: "Build",
  release: "Release",
};
const ALL_PHASES: Phase[] = PHASE_ORDER;
// Shorter labels for the narrow vertical rail (full names live in PHASE_LABELS).
const PHASE_RAIL_LABELS: Record<Phase, string> = { ...PHASE_LABELS, re: "Reverse Eng." };

// Each tab is a phase tool. Disk + Cartridge are FIRST-CLASS expert surfaces in
// Discovery + RE (hard constraint — directly reachable, never buried). Dashboard /
// Live / Questions / Docs are cross-phase (available in every phase).
const allTabs: Array<{ id: TabId; label: string; phases: Phase[] }> = [
  // Phase-home cockpit for the phases without a rich data-view of their own.
  { id: "home", label: "Overview", phases: ["onboarding", "build", "release"] },
  { id: "live", label: "Live", phases: ALL_PHASES }, // TRX64 runtime evidence — cross-phase, not a lifecycle stage
  { id: "dashboard", label: "Dashboard", phases: ALL_PHASES },
  { id: "questions", label: "Questions", phases: ALL_PHASES },
  { id: "docs", label: "Docs", phases: ALL_PHASES },
  { id: "memory", label: "Memory Map", phases: ["discovery", "re"] },
  { id: "graphics", label: "Graphics", phases: ["discovery", "re"] },
  { id: "scrub", label: "Scrub", phases: ["re"] },
  { id: "disk", label: "Disk", phases: ["discovery", "re"] },
  { id: "cartridge", label: "Cartridge", phases: ["discovery", "re"] },
  { id: "payloads", label: "Payloads", phases: ["discovery", "re"] },
  { id: "flow", label: "Flow Graph", phases: ["re"] },
  { id: "listing", label: "Annotated Listing", phases: ["re"] },
];

// Spec 773 Loop 3 — opinionated (not placeholder) phase-home cockpits for the phases
// that have no rich data-view of their own (Onboarding / Build / Release). READ-ONLY:
// facts come from existing project state; mutations stay agent-led (Loops 4-6 add the
// controlled writes). Sparse state produces a concrete NEXT ACTION, never an empty box.
interface PhaseHomeModel {
  intent: string;
  known: Array<{ label: string; value: string; ok?: boolean }>;
  missing: string[];
  next: string;
  tools: Array<{ label: string; phase: Phase; tab: TabId }>;
}

function phaseHomeModel(phase: Phase, snapshot: WorkspaceUiSnapshot): PhaseHomeModel | null {
  const disks = snapshot.views.diskLayout.disks.length;
  const carts = snapshot.views.cartridgeLayout.cartridges.length;
  const prgs = snapshot.artifacts.filter((a) => a.kind === "prg").length;
  const hasMedia = disks + carts + prgs > 0;
  const goals = snapshot.projectProfile?.goals ?? [];
  const workflow = snapshot.projectProfile?.workflow;
  const loaderModel = snapshot.projectProfile?.loaderModel;
  const buildCmd = snapshot.projectProfile?.build?.command;
  const testCmd = snapshot.projectProfile?.test?.command;
  const openQ = snapshot.openQuestions.length;
  const findings = snapshot.counts.findings;
  const checkpoints = snapshot.checkpoints.length;
  const keyDocs = snapshot.views.projectDashboard.keyDocuments.length;
  const hasListing = snapshot.views.annotatedListing.entries.length > 0;
  const versionGroups = snapshot.artifactVersionGroups.length;
  const mediaSummary = hasMedia
    ? [disks ? `${disks} disk` : "", carts ? `${carts} cart` : "", prgs ? `${prgs} PRG` : ""].filter(Boolean).join(" · ")
    : "none registered";

  if (phase === "onboarding") {
    const goalType = snapshot.projectProfile?.goalType;
    const mission = snapshot.projectProfile?.mission;
    const hasGoal = Boolean(goalType || mission || goals.length);
    const goalText = mission || goalType || (goals.length ? goals.join(" · ") : "not captured yet");
    return {
      intent: "Start the project: capture the goal, get oriented, and — if useful — play/watch the title with TRX64 before diving in.",
      known: [
        { label: "Goal / mission", value: goalText, ok: hasGoal },
        ...(goalType && mission ? [{ label: "Goal type", value: goalType, ok: true }] : []),
        { label: "Workflow profile", value: workflow ?? "not selected", ok: !!workflow },
        { label: "Input media", value: mediaSummary, ok: hasMedia },
        { label: "Runtime", value: "TRX64 backend — play/watch via Live", ok: true },
      ],
      missing: [
        ...(hasGoal ? [] : ["Goal / mission not captured"]),
        ...(workflow ? [] : ["Workflow profile not selected"]),
        ...(hasMedia ? [] : ["No input media registered"]),
      ],
      next: !hasGoal
        ? "Ask the agent to capture the project goal (EasyFlash port / cheat-trainer / enhancement / loader-replacement / bugfix / documentation) into the project profile."
        : hasMedia
          ? "Play/watch the title in Live to form an initial complexity impression, then move to Discovery."
          : "Register the input media, then run extraction in Discovery.",
      tools: [
        { label: "Play / watch (Live)", phase: "onboarding", tab: "live" },
        { label: "Docs", phase: "onboarding", tab: "docs" },
        { label: "Go to Discovery →", phase: "discovery", tab: "disk" },
      ],
    };
  }

  if (phase === "build") {
    return {
      intent: "Turn the reverse-engineering knowledge into a modified target artifact — decide target medium, loader strategy, and the feature/patch plan, then assemble + validate.",
      known: [
        { label: "Candidate source", value: `${prgs} PRG · ${versionGroups} version group${versionGroups === 1 ? "" : "s"}`, ok: prgs > 0 },
        { label: "Annotated listing", value: hasListing ? "available" : "not built yet", ok: hasListing },
        { label: "Build command", value: buildCmd ?? "not set", ok: !!buildCmd },
        { label: "Loader model", value: loaderModel ?? "not defined", ok: !!loaderModel },
      ],
      missing: [
        "Target medium (decide)",
        "Loader / transformation strategy",
        "Feature / patch plan",
        ...(buildCmd ? [] : ["Build/validation command not set"]),
      ],
      next: !hasListing
        ? "Reach a solid annotated listing in Reverse Engineering first, then decide the build target with the agent."
        : "Decide the target medium + loader strategy with the agent, then assemble the modified artifact (workflow runner).",
      tools: [
        { label: "Annotated Listing", phase: "re", tab: "listing" },
        { label: "Payloads", phase: "re", tab: "payloads" },
        { label: "Docs", phase: "build", tab: "docs" },
        { label: "Questions", phase: "build", tab: "questions" },
      ],
    };
  }

  if (phase === "release") {
    return {
      intent: "Stabilize, test, package and hand off the finished artifact — local QA, tester loops, release notes, final package.",
      known: [
        { label: "Docs / reports", value: keyDocs ? `${keyDocs} key document${keyDocs === 1 ? "" : "s"}` : "none yet", ok: keyDocs > 0 },
        { label: "Test command", value: testCmd ?? "not set", ok: !!testCmd },
        { label: "Open issues (questions)", value: String(openQ), ok: openQ === 0 },
        { label: "Checkpoints", value: String(checkpoints), ok: checkpoints > 0 },
      ],
      missing: ["Local QA run", "Tester feedback", "Release candidate / final package", "Release notes"],
      next: openQ > 0
        ? `Resolve the ${openQ} open question${openQ === 1 ? "" : "s"} / known issues, run local QA, then package a release candidate (via the agent).`
        : "Run local QA and capture results, then package a release candidate (via the agent).",
      tools: [
        { label: "Docs / reports", phase: "release", tab: "docs" },
        { label: "Questions", phase: "release", tab: "questions" },
        { label: "Validate (Live)", phase: "release", tab: "live" },
      ],
    };
  }

  return null; // discovery + re use their rich tool views, not a phase-home
}

// Spec 773 Loop 4 — Onboarding goal-capture form. goalType is FREE text (datalist
// suggestions only); writes through the existing project-profile contract via onSave.
const GOAL_TYPE_SUGGESTIONS = ["EasyFlash port", "cheat-trainer", "enhancement", "loader-replacement", "bugfix", "documentation"];
const WORKFLOW_OPTIONS = ["full-re", "cracker-only", "analyst-deep", "targeted-routine", "bugfix"];

function OnboardingGoalForm({
  profile,
  onSave,
}: {
  profile: WorkspaceUiSnapshot["projectProfile"];
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [goalType, setGoalType] = useState(profile?.goalType ?? "");
  const [mission, setMission] = useState(profile?.mission ?? "");
  const [strategy, setStrategy] = useState(profile?.strategy ?? "");
  const [complexity, setComplexity] = useState(profile?.complexity ?? "");
  const [workflow, setWorkflow] = useState<string>(profile?.workflow ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const captured = Boolean(profile?.mission || profile?.goalType);

  async function submit() {
    setSaving(true);
    setSaved(false);
    setErr(null);
    try {
      await onSave({
        goalType: goalType.trim() || undefined,
        mission: mission.trim() || undefined,
        strategy: strategy.trim() || undefined,
        complexity: complexity.trim() || undefined,
        workflow: workflow || undefined,
      });
      setSaved(true);
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel-card goal-form">
      <div className="section-heading"><h2>{captured ? "Goal (edit)" : "Capture the goal"}</h2></div>
      <div className="goal-form-grid">
        <label>Goal type
          <input list="goal-type-suggestions" value={goalType} onChange={(e) => setGoalType(e.target.value)} placeholder="e.g. EasyFlash port — free text" />
          <datalist id="goal-type-suggestions">
            {GOAL_TYPE_SUGGESTIONS.map((s) => <option key={s} value={s} />)}
          </datalist>
        </label>
        <label>Workflow profile
          <select value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
            <option value="">—</option>
            {WORKFLOW_OPTIONS.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </label>
        <label className="goal-form-wide">Mission
          <input value={mission} onChange={(e) => setMission(e.target.value)} placeholder="one-line goal statement" />
        </label>
        <label className="goal-form-wide">Strategy
          <textarea value={strategy} onChange={(e) => setStrategy(e.target.value)} rows={2} placeholder="how you'll approach it" />
        </label>
        <label className="goal-form-wide">Complexity impression
          <input value={complexity} onChange={(e) => setComplexity(e.target.value)} placeholder="from play/watch — optional" />
        </label>
      </div>
      <div className="goal-form-actions">
        <button type="button" className="primary-button" onClick={submit} disabled={saving}>{saving ? "Saving…" : "Save goal"}</button>
        {saved ? <span className="goal-form-ok">saved ✓</span> : null}
        {err ? <span className="goal-form-err">{err}</span> : null}
      </div>
      <p className="goal-form-note">Free-form — you or the agent can capture/update this (same project-profile contract).</p>
    </div>
  );
}

// Spec 773 Onboarding redirect — rule-based SUGGESTED agent team, derived from the
// captured goal + media. Shown only until the harness persists a team via
// saveProjectProfile (profile.team[]); the persisted team then wins.
const TEAM_ROLE_LABELS: Record<ProjectTeamMember["role"], string> = {
  "re-lead": "RE Lead / Orchestrator",
  "runtime-forensics": "Runtime Forensics (TRX64)",
  "media-cartographer": "Media Cartographer",
  "loader-packer": "Loader / Packer Analyst",
  "semantic-annotator": "Semantic RE Annotator",
  "build-engineer": "Build / Transformation Engineer",
  "qa-release": "QA / Release",
};

function suggestedTeam(snapshot: WorkspaceUiSnapshot): ProjectTeamMember[] {
  const goalType = (snapshot.projectProfile?.goalType ?? "").toLowerCase();
  const hasDisk = snapshot.views.diskLayout.disks.length > 0;
  const hasCart = snapshot.views.cartridgeLayout.cartridges.length > 0;
  const hasMedia = hasDisk || hasCart || snapshot.artifacts.some((a) => a.kind === "prg");
  const docsOnly = /doc/.test(goalType);
  const wantsBuild = /port|loader|enhanc|cheat|train|bug|fix|crack/.test(goalType);
  const loaderFocus = /loader|port|crack/.test(goalType) || hasDisk || hasCart;
  const mk = (
    role: ProjectTeamMember["role"],
    status: ProjectTeamMember["status"],
    why: string,
  ): ProjectTeamMember => ({ role, label: TEAM_ROLE_LABELS[role], status, why, source: "suggested" });
  return [
    mk("re-lead", "active", "Drives the workflow, owns the brief and the decisions."),
    mk("runtime-forensics", "active", "Boots the title in TRX64 to observe behaviour and gather runtime evidence."),
    mk(
      "media-cartographer",
      hasMedia ? "active" : "planned",
      hasMedia ? "Inventories the disk / CRT / payload layout." : "Maps the medium once input is registered.",
    ),
    mk("loader-packer", loaderFocus ? "active" : "planned", "Analyses the loader / packer / depacker chain."),
    mk("semantic-annotator", "planned", "Names routines and classifies payloads during Reverse Engineering."),
    mk(
      "build-engineer",
      docsOnly ? "not-needed" : wantsBuild ? "planned" : "later",
      docsOnly ? "No build output needed for a documentation goal." : "Assembles the modified medium / loader / feature in Build.",
    ),
    mk("qa-release", "later", "Runs local QA and packages the release near the end."),
  ];
}

function resolveTeam(snapshot: WorkspaceUiSnapshot): {
  members: ProjectTeamMember[];
  source: "suggested" | "agent-authored";
} {
  const persisted = snapshot.projectProfile?.team ?? [];
  if (persisted.length) return { members: persisted, source: "agent-authored" };
  return { members: suggestedTeam(snapshot), source: "suggested" };
}

// A ready-to-paste prompt that starts the onboarding dialogue in the attached coding
// agent (Claude Code / Codex). The conversation + reasoning live in the harness; C64RE
// only records + visualizes the resulting brief. Pure template — no LLM in the WebUI.
function buildKickoffPrompt(snapshot: WorkspaceUiSnapshot): string {
  const name = snapshot.project.name;
  const disks = snapshot.views.diskLayout.disks.length;
  const carts = snapshot.views.cartridgeLayout.cartridges.length;
  const prgs = snapshot.artifacts.filter((a) => a.kind === "prg").length;
  const media =
    [disks ? `${disks} disk` : "", carts ? `${carts} cart` : "", prgs ? `${prgs} PRG` : ""]
      .filter(Boolean)
      .join(", ") || "none registered yet";
  const profile = snapshot.projectProfile;
  const goal = profile?.mission || profile?.goalType || "not captured yet";
  const workflow = profile?.workflow || "not selected";
  return [
    `You are the C64RE lead agent for the reverse-engineering project "${name}".`,
    `Runtime backend: TRX64. Persist everything through the C64RE MCP tools`,
    `(save_project_profile, save_open_question, save_finding, save_entity) — do not keep it only in chat.`,
    ``,
    `Project state so far:`,
    `- Input media: ${media}`,
    `- Goal: ${goal}`,
    `- Workflow profile: ${workflow}`,
    `- Open questions: ${snapshot.openQuestions.length}`,
    ``,
    `Run a kickoff conversation with me to build the Project Brief. Ask ONE question at a time:`,
    `1. What do we want to achieve with this title? (port / cheat-trainer / enhancement / loader-replacement / bugfix / documentation / other — free text)`,
    `2. Should we first play/watch it together in TRX64 (the Live tab)?`,
    `3. What makes this game/project interesting or risky?`,
    `4. What output counts as success?`,
    ``,
    `As we go, capture goalType, mission, strategy, complexity and assumptions into the`,
    `project profile. Then propose a BMAD-style agent team (re-lead, runtime-forensics,`,
    `media-cartographer, loader-packer, semantic-annotator, build-engineer, qa-release) —`,
    `which are active now, which planned later, and why — and persist it via`,
    `save_project_profile (profile.team[], source "agent-authored").`,
  ].join("\n");
}

// Spec 773 Onboarding redirect — the Kickoff Cockpit. ONE guided surface (not a
// dashboard of equal cards): harness note + kickoff prompt, then Project Brief, then
// Agent Team, then Play/Watch, and finally the editable summary form (collapsed). The
// onboarding CONVERSATION happens in the coding-agent harness via MCP; this cockpit
// records + visualizes the resulting brief. No LLM / chat in the WebUI.
function OnboardingKickoffCockpit({
  snapshot,
  onNavigate,
  onSaveGoal,
  onRefresh,
}: {
  snapshot: WorkspaceUiSnapshot;
  onNavigate: (phase: Phase, tab: TabId) => void;
  onSaveGoal: (patch: Record<string, unknown>) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const model = phaseHomeModel("onboarding", snapshot);
  const profile = snapshot.projectProfile;
  const team = resolveTeam(snapshot);
  const assumptions = profile?.assumptions ?? [];
  const topQuestions = snapshot.openQuestions.slice(0, 5);
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const kickoffPrompt = buildKickoffPrompt(snapshot);

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(kickoffPrompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  if (!model) return null;

  return (
    <div className="kickoff">
      {/* 1 — Harness dialogue note + kickoff prompt affordance (primary) */}
      <div className="panel-card kickoff-harness">
        <div className="kickoff-harness-head">
          <span className="kickoff-badge">Kickoff</span>
          <p className="kickoff-harness-note">
            The onboarding conversation runs in your coding agent (Claude&nbsp;Code / Codex) via MCP —
            C64RE records &amp; visualizes the resulting brief. This is a cockpit, not a chat.
          </p>
        </div>
        <div className="kickoff-actions">
          <button type="button" className="primary-button" onClick={copyPrompt}>
            {copied ? "Copied ✓" : "Copy kickoff prompt"}
          </button>
          <button type="button" className="tab-button" onClick={refresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh state"}
          </button>
          <button type="button" className="tab-button" onClick={() => onNavigate("onboarding", "live")}>
            Open Live ▸ Play / Watch
          </button>
        </div>
        <details className="kickoff-prompt-preview">
          <summary>Preview kickoff prompt</summary>
          <pre>{kickoffPrompt}</pre>
        </details>
      </div>

      {/* 2 — Project Brief */}
      <div className="panel-card kickoff-brief">
        <div className="section-heading">
          <h2>Project Brief</h2>
          <span className="kickoff-sub">assembled from project state</span>
        </div>
        <div className="phase-home-facts">
          {model.known.map((fact) => (
            <div key={fact.label} className="phase-home-fact">
              <span className={fact.ok ? "phase-home-dot ok" : "phase-home-dot"} />
              <span className="phase-home-fact-label">{fact.label}</span>
              <span className="phase-home-fact-value">{fact.value}</span>
            </div>
          ))}
        </div>
        {assumptions.length ? (
          <div className="kickoff-block">
            <h3>Assumptions</h3>
            <ul className="phase-home-questions">
              {assumptions.map((a) => <li key={a}>{a}</li>)}
            </ul>
          </div>
        ) : null}
        <div className="kickoff-block">
          <h3>Open / needed</h3>
          {model.missing.length ? (
            <ul className="phase-home-missing">
              {model.missing.map((m) => <li key={m}>{m}</li>)}
            </ul>
          ) : (
            <p className="phase-home-clear">Brief looks complete for this phase.</p>
          )}
        </div>
        {topQuestions.length ? (
          <div className="kickoff-block">
            <div className="section-heading">
              <h3>Open questions</h3>
              <button type="button" className="ghost-button" onClick={() => onNavigate("onboarding", "questions")}>
                all {snapshot.openQuestions.length} →
              </button>
            </div>
            <ul className="phase-home-questions">
              {topQuestions.map((q) => <li key={q.id}>{q.title}</li>)}
            </ul>
          </div>
        ) : null}
        <p className="kickoff-next"><strong>Next:</strong> {model.next}</p>
      </div>

      {/* 3 — Agent Team */}
      <div className="panel-card kickoff-team">
        <div className="section-heading">
          <h2>Agent team</h2>
          <span className="kickoff-sub">
            {team.source === "agent-authored" ? "selected by harness" : "suggested — the harness can override via MCP"}
          </span>
        </div>
        <div className="kickoff-team-list">
          {team.members.map((m) => (
            <div key={m.role} className={`kickoff-team-member s-${m.status}`}>
              <div className="kickoff-team-head">
                <span className="kickoff-team-label">{m.label}</span>
                <span className={`kickoff-team-status st-${m.status}`}>{m.status}</span>
                {m.source === "suggested" ? <span className="kickoff-team-tag">suggested</span> : null}
              </div>
              <p className="kickoff-team-why">{m.why}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 4 — Play / Watch with TRX64 */}
      <div className="panel-card kickoff-playwatch">
        <div className="section-heading"><h2>Play / Watch with TRX64</h2></div>
        <p className="kickoff-playwatch-note">
          Boot the title in the TRX64 runtime to form a first complexity impression and capture
          screenshots / traces / observations — then feed them back into the brief.
        </p>
        <button type="button" className="primary-button" onClick={() => onNavigate("onboarding", "live")}>
          Open Live ▸
        </button>
      </div>

      {/* 5 — Editable summary form (secondary, collapsed) */}
      <details className="kickoff-form-wrap">
        <summary>Editable brief summary (manual override)</summary>
        <OnboardingGoalForm profile={profile} onSave={onSaveGoal} />
      </details>
    </div>
  );
}

function PhaseHomePanel({
  phase,
  snapshot,
  onNavigate,
  onSaveGoal,
  onRefresh,
}: {
  phase: Phase;
  snapshot: WorkspaceUiSnapshot;
  onNavigate: (phase: Phase, tab: TabId) => void;
  onSaveGoal: (patch: Record<string, unknown>) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  // Onboarding gets its dedicated dialogue-driven Kickoff Cockpit (Spec 773 redirect);
  // Build/Release keep the generic phase-home layout below.
  if (phase === "onboarding") {
    return (
      <OnboardingKickoffCockpit
        snapshot={snapshot}
        onNavigate={onNavigate}
        onSaveGoal={onSaveGoal}
        onRefresh={onRefresh}
      />
    );
  }
  const model = phaseHomeModel(phase, snapshot);
  if (!model) return null;
  const topQuestions = snapshot.openQuestions.slice(0, 4);
  return (
    <div className="phase-home">
      <div className="panel-card phase-home-intro">
        <div className="phase-home-title">{PHASE_LABELS[phase]}</div>
        <p className="phase-home-intent">{model.intent}</p>
      </div>

      <div className="phase-home-grid">
        <div className="panel-card">
          <div className="section-heading"><h2>Known</h2></div>
          <div className="phase-home-facts">
            {model.known.map((fact) => (
              <div key={fact.label} className="phase-home-fact">
                <span className={fact.ok ? "phase-home-dot ok" : "phase-home-dot"} />
                <span className="phase-home-fact-label">{fact.label}</span>
                <span className="phase-home-fact-value">{fact.value}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel-card">
          <div className="section-heading"><h2>Missing / blockers</h2></div>
          {model.missing.length ? (
            <ul className="phase-home-missing">
              {model.missing.map((m) => <li key={m}>{m}</li>)}
            </ul>
          ) : (
            <p className="phase-home-clear">Nothing blocking in this phase.</p>
          )}
        </div>
      </div>

      <div className="panel-card phase-home-next">
        <div className="section-heading"><h2>Next action</h2></div>
        <p>{model.next}</p>
        <div className="phase-home-tools">
          {model.tools.map((tool) => (
            <button key={tool.label} type="button" className="tab-button" onClick={() => onNavigate(tool.phase, tool.tab)}>
              {tool.label}
            </button>
          ))}
        </div>
      </div>

      {topQuestions.length ? (
        <div className="panel-card">
          <div className="section-heading">
            <h2>Open questions</h2>
            <button type="button" className="ghost-button" onClick={() => onNavigate(phase, "questions")}>
              all {snapshot.openQuestions.length} →
            </button>
          </div>
          <ul className="phase-home-questions">
            {topQuestions.map((q) => <li key={q.id}>{q.title}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// Files we want to open in the (mon) hex viewer. Anything else (.json,
// .md, .asm, .tass, .sym, etc.) is text the listing/docs panes already
// handle, so we hide the icon to avoid noise.
const C64_BINARY_EXTENSIONS = new Set([".prg", ".bin", ".crt", ".d64", ".g64", ".sid", ".raw"]);

function isC64BinaryArtifact(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return C64_BINARY_EXTENSIONS.has(lower.slice(dot));
}

function asmDialectForPath(relativePath: string): AsmViewSource["dialect"] {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".tass")) return "64tass";
  if (lower.endsWith(".asm")) return "kickass";
  return "plain";
}

// BUG-019 — rank ASM/source artifacts so the UI defaults to the CURRENT BEST
// version, not the stale generated disassembly. Higher = better.
//   final-*-source        → curated final output (best)
//   *-source              → semantic / hand source (e.g. *_semantic.tass)
//   (unknown role)        → hand-made files with no assigned role still beat
//                           the generated heuristic dump
//   disasm / disasm-tass  → the auto-generated *_disasm.* dump (lowest)
// A "_semantic" path adds a small nudge so the curated source wins ties.
function asmArtifactPriority(artifact: ArtifactRecord): number {
  let base: number;
  switch (artifact.role) {
    case "final-kickassembler-source":
    case "final-64tass-source":
      base = 400; break;
    case "kickassembler-source":
    case "64tass-source":
      base = 300; break;
    case "disasm":
    case "disasm-tass":
      base = 100; break;
    default:
      base = 200; break;
  }
  if (/_semantic\./i.test(artifact.relativePath)) base += 50;
  return base;
}

// Spec 730 §7 — subject key for a source artifact. Mirrors the MCP
// `subjectIdForArtifact`: base stem with the trailing _disasm/_semantic/_notes
// qualifier stripped so every version of one payload clusters into one subject.
function subjectIdForArtifactPath(relativePath: string): string {
  const file = relativePath.split("/").pop() ?? relativePath;
  const stem = file.replace(/\.[^.]+$/, "");
  return stem.replace(/_(disasm|semantic|notes|curated|final|src|source)$/i, "");
}

function asmSourceForArtifact(artifact: ArtifactRecord): AsmViewSource {
  const dialect = asmDialectForPath(artifact.relativePath);
  return {
    id: artifact.id,
    label: dialect === "kickass" ? "KickAss" : dialect === "64tass" ? "64tass" : artifact.relativePath,
    path: artifact.relativePath,
    dialect,
  };
}

// Spec 730 §7 — THE single best-version resolver shared by Disk Inspector,
// Payloads, Annotated Listing, and the ASM overlay. It prefers the version
// group's currentArtifactId (manual OR auto) when one exists for the subject;
// otherwise it falls back to the existing rank logic (asmArtifactPriority).
// The returned list is best-first so the default action opens the current best
// version; older versions remain available as the following entries.
function bestAsmSourcesForArtifacts(
  artifacts: ArtifactRecord[],
  versionGroups: ArtifactVersionGroup[] = [],
): AsmViewSource[] {
  const bestByDialect = new Map<AsmViewSource["dialect"], ArtifactRecord>();
  for (const artifact of artifacts) {
    const dialect = asmDialectForPath(artifact.relativePath);
    const current = bestByDialect.get(dialect);
    if (!current || asmArtifactPriority(artifact) > asmArtifactPriority(current)) {
      bestByDialect.set(dialect, artifact);
    }
  }
  const deduped = [...bestByDialect.values()];

  // §7 unified resolution — if any candidate belongs to a version group, float
  // that group's current artifact to the front (it may not be the highest
  // dialect-priority pick when a manual current was chosen). The current
  // artifact id is the single source of truth across all four surfaces.
  const groupBySubject = new Map(versionGroups.map((g) => [g.subjectId, g]));
  const idsInCandidates = new Set(deduped.map((a) => a.id));
  let currentId: string | undefined;
  // Prefer a manual current; otherwise any auto current whose artifact is among
  // the candidates. (Walk in stable order for determinism.)
  for (const a of artifacts) {
    const group = groupBySubject.get(subjectIdForArtifactPath(a.relativePath));
    if (!group) continue;
    if (!idsInCandidates.has(group.currentArtifactId)) continue;
    if (group.currentSource === "manual") { currentId = group.currentArtifactId; break; }
    if (!currentId) currentId = group.currentArtifactId;
  }

  const dialectOrder: Record<AsmViewSource["dialect"], number> = { kickass: 0, "64tass": 1, plain: 2 };
  const ordered = deduped.sort((left, right) => {
    // The version-group current always sorts first.
    if (currentId) {
      if (left.id === currentId && right.id !== currentId) return -1;
      if (right.id === currentId && left.id !== currentId) return 1;
    }
    const byPriority = asmArtifactPriority(right) - asmArtifactPriority(left);
    if (byPriority !== 0) return byPriority;
    return dialectOrder[asmDialectForPath(left.relativePath)] - dialectOrder[asmDialectForPath(right.relativePath)];
  });
  return ordered.map(asmSourceForArtifact);
}

// Spec 730 §7.2 — Inspector "Source / Versions" section. Shows the current best
// version + other versions for a payload/artifact subject with role/format/status
// and the open / make current / mark stale actions. `make current` and
// `mark stale` POST to the workspace server, which persists in the knowledge
// store (a later project_inventory_sync respects a manual current). Conflicts
// surface as a "needs decision" banner, not a silent guess.
function ArtifactVersionsSection({
  candidates,
  versionGroups,
  projectDir,
  onOpenAsm,
  onReload,
}: {
  candidates: ArtifactRecord[];
  versionGroups: ArtifactVersionGroup[];
  projectDir: string;
  onOpenAsm: (title: string, sources: AsmViewSource[]) => void;
  onReload: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only source files (.asm/.tass/.sym) participate as versions.
  const sourceCandidates = candidates.filter((a) => /\.(asm|tass|sym)$/i.test(a.relativePath));
  if (sourceCandidates.length === 0) return null;

  const byId = new Map(sourceCandidates.map((a) => [a.id, a]));
  // Resolve the subject from the first candidate; find its persisted group.
  const subjectId = subjectIdForArtifactPath(sourceCandidates[0]!.relativePath);
  const group = versionGroups.find((g) => g.subjectId === subjectId);

  // Build the display rows: prefer the persisted group's members (they carry
  // status + role + the chosen current); otherwise derive from candidates so the
  // section still renders before the first sync.
  type Row = { artifact: ArtifactRecord; role: string; format: string; status: string; isCurrent: boolean };
  let rows: Row[];
  let currentSource: "auto" | "manual" = "auto";
  let needsDecision = false;
  if (group) {
    currentSource = group.currentSource;
    needsDecision = Boolean(group.needsDecision);
    const grp = group;
    rows = grp.versions.flatMap((v): Row[] => {
      const artifact = byId.get(v.artifactId) ?? candidates.find((a) => a.id === v.artifactId);
      if (!artifact) return [];
      return [{ artifact, role: v.role, format: v.format, status: v.status, isCurrent: v.artifactId === grp.currentArtifactId }];
    });
  } else {
    // No group yet — derive best-first ordering from the rank resolver.
    const ordered = bestAsmSourcesForArtifacts(sourceCandidates, []);
    rows = ordered.map((s, idx) => {
      const artifact = byId.get(s.id)!;
      return {
        artifact,
        role: artifact.role ?? "unknown",
        format: s.dialect === "kickass" ? "kickass" : s.dialect === "64tass" ? "64tass" : "other",
        status: idx === 0 ? "current" : "available",
        isCurrent: idx === 0,
      };
    });
  }
  if (rows.length === 0) return null;

  const current = rows.find((r) => r.isCurrent) ?? rows[0]!;
  const others = rows.filter((r) => r !== current);

  async function act(url: string, body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await postJson(url, { projectDir, subjectId, ...body });
      await onReload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const open = (artifact: ArtifactRecord) => onOpenAsm(artifact.title, bestAsmSourcesForArtifacts([artifact], versionGroups));
  const renderRow = (row: Row, key: string) => (
    <div key={key} className="record-card">
      <div className="record-topline">
        <span>{(row.artifact.relativePath.split("/").pop()) ?? row.artifact.relativePath}</span>
        <span className="record-status">{row.format} · {row.role} · {row.status}</span>
      </div>
      <div className="record-actions">
        <button type="button" className="payload-button" disabled={busy} onClick={() => open(row.artifact)}>open</button>
        {!row.isCurrent ? (
          <button type="button" className="payload-button" disabled={busy}
            onClick={() => act("/api/artifact-version/set-current", { artifactId: row.artifact.id })}>make current</button>
        ) : null}
        {row.status !== "stale" ? (
          <button type="button" className="payload-button" disabled={busy}
            onClick={() => act("/api/artifact-version/mark-stale", { artifactId: row.artifact.id, status: "stale" })}>mark stale</button>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="inspector-block">
      <h4>Source / Versions ({rows.length})</h4>
      {needsDecision ? (
        <div className="inline-warning">Needs decision — two sources tie on rank. Pick one as current.</div>
      ) : null}
      {error ? <div className="inline-warning">{error}</div> : null}
      <div className="record-stack compact">
        <div className="record-subhead">Current ({currentSource})</div>
        {renderRow(current, "current")}
        {others.length > 0 ? <div className="record-subhead">Other versions</div> : null}
        {others.map((row, i) => renderRow(row, `other-${i}`))}
      </div>
    </div>
  );
}

function binaryArtifactPriority(artifact: ArtifactRecord): number {
  switch (artifact.role) {
    case "rebuilt-prg":
      return 300;
    case "analysis-target":
      return 200;
    default:
      return 100;
  }
}

function hex(value: number, digits = 4): string {
  return `$${value.toString(16).toUpperCase().padStart(digits, "0")}`;
}

function shortTime(value: string): string {
  return new Date(value).toLocaleString("de-DE", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function pct(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.text();
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

function normalizeKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function docPriority(doc: UiDocument): number {
  const name = doc.title.toLowerCase();
  if (name.includes("first_analysis") || name.includes("handoff") || name.includes("overview") || name.includes("summary")) {
    return 0;
  }
  if (name.endsWith("_pointer_facts.md") || name.endsWith("_ram_facts.md")) {
    return 2;
  }
  return 1;
}

function docGroupId(doc: UiDocument): string {
  if (doc.unregistered) return "discovered";
  const name = doc.title.toLowerCase();
  if (docPriority(doc) === 0) return "main";
  if (name.endsWith("_pointer_facts.md") || name.endsWith("_ram_facts.md")) return "facts";
  return "notes";
}

function docGroupTitle(groupId: string): string {
  if (groupId === "main") return "Main Docs";
  if (groupId === "facts") return "Per-File Facts";
  if (groupId === "discovered") return "Discovered (unregistered)";
  return "Other Notes";
}

function buildDocs(
  artifacts: ArtifactRecord[],
  discovered: DiscoveredMarkdownDoc[] = [],
): UiDocument[] {
  const registered = artifacts
    .filter((artifact) => artifact.relativePath.toLowerCase().startsWith("doc/") || artifact.relativePath.toLowerCase().endsWith(".md"))
    .map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      relativePath: artifact.relativePath,
      updatedAt: artifact.updatedAt,
      role: artifact.role,
    }));

  const registeredPaths = new Set(registered.map((doc) => doc.relativePath.toLowerCase()));
  const fallback: UiDocument[] = discovered
    .filter((entry) => !registeredPaths.has(entry.relativePath.toLowerCase()))
    .map((entry) => ({
      id: `discovered:${entry.relativePath}`,
      title: entry.title?.trim() || entry.relativePath.split("/").pop()?.replace(/\.md$/i, "") || entry.relativePath,
      relativePath: entry.relativePath,
      updatedAt: entry.modifiedAt,
      role: "discovered",
      unregistered: true,
    }));

  return [...registered, ...fallback].sort((left, right) => {
    const priorityDelta = docPriority(left) - docPriority(right);
    if (priorityDelta !== 0) return priorityDelta;
    return left.relativePath.localeCompare(right.relativePath);
  });
}

function groupDocs(docs: UiDocument[]): DocGroup[] {
  const groups = new Map<string, UiDocument[]>();
  for (const doc of docs) {
    const groupId = docGroupId(doc);
    groups.set(groupId, [...(groups.get(groupId) ?? []), doc]);
  }
  return ["main", "notes", "facts", "discovered"]
    .map((groupId) => ({
      id: groupId,
      title: docGroupTitle(groupId),
      docs: groups.get(groupId) ?? [],
    }))
    .filter((group) => group.docs.length > 0);
}

function renderInlineMarkdown(text: string): Array<string | ReactNode> {
  const result: Array<string | ReactNode> = [];
  let remaining = text;
  let key = 0;
  while (remaining.length > 0) {
    const codeMatch = remaining.match(/`([^`]+)`/);
    if (!codeMatch || codeMatch.index === undefined) {
      result.push(remaining);
      break;
    }
    if (codeMatch.index > 0) {
      result.push(remaining.slice(0, codeMatch.index));
    }
    result.push(<code key={`code-${key++}`}>{codeMatch[1]}</code>);
    remaining = remaining.slice(codeMatch.index + codeMatch[0].length);
  }
  return result;
}

function isMarkdownTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(trimmed);
}

function splitMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function ThinMarkdown({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let codeBlock: string[] = [];
  let inCode = false;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ");
    nodes.push(<p key={`p-${nodes.length}`}>{renderInlineMarkdown(text)}</p>);
    paragraph = [];
  }

  function flushList() {
    if (listItems.length === 0) return;
    nodes.push(
      <ul key={`ul-${nodes.length}`}>
        {listItems.map((item, index) => <li key={`li-${index}`}>{renderInlineMarkdown(item)}</li>)}
      </ul>,
    );
    listItems = [];
  }

  function flushCode() {
    if (codeBlock.length === 0) return;
    nodes.push(<pre key={`pre-${nodes.length}`}><code>{codeBlock.join("\n")}</code></pre>);
    codeBlock = [];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trimEnd();
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBlock.push(rawLine);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const nextLine = lines[index + 1]?.trimEnd() ?? "";
    if (line.includes("|") && isMarkdownTableSeparator(nextLine)) {
      flushParagraph();
      flushList();
      const header = splitMarkdownTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const rowLine = lines[index].trimEnd();
        if (!rowLine.trim() || !rowLine.includes("|")) {
          index -= 1;
          break;
        }
        rows.push(splitMarkdownTableRow(rowLine));
        index += 1;
      }
      nodes.push(
        <div key={`table-wrap-${nodes.length}`} className="markdown-table-wrap">
          <table className="markdown-table">
            <thead>
              <tr>
                {header.map((cell, cellIndex) => <th key={`h-${cellIndex}`}>{renderInlineMarkdown(cell)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`r-${rowIndex}`}>
                  {row.map((cell, cellIndex) => <td key={`c-${rowIndex}-${cellIndex}`}>{renderInlineMarkdown(cell)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const text = heading[2];
      if (level === 1) nodes.push(<h1 key={`h-${nodes.length}`}>{text}</h1>);
      else if (level === 2) nodes.push(<h2 key={`h-${nodes.length}`}>{text}</h2>);
      else nodes.push(<h3 key={`h-${nodes.length}`}>{text}</h3>);
      continue;
    }
    const listMatch = line.match(/^[-*]\s+(.*)$/);
    if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1]);
      continue;
    }
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushCode();

  return <div className="thin-markdown">{nodes}</div>;
}

function MetricTile({ title, value, tone }: { title: string; value: string; tone: string }) {
  return (
    <article className={`metric-tile metric-${tone}`}>
      <div className="metric-label">{title}</div>
      <div className="metric-value">{value}</div>
    </article>
  );
}

// Spec 050 Block D: 7-cell pill showing per-artifact phase
// progress. ✓ done · ⨯ pending · — not required for active
// workflow. Frozen artifacts get a 🔒 prefix.
function PhaseBadge({ phase, frozen }: { phase?: number; frozen?: boolean }) {
  const current = phase ?? 1;
  const cells = [1, 2, 3, 4, 5, 6, 7].map((p) => {
    if (frozen && p === current) return "🔒";
    if (p < current) return "✓";
    if (p === current) return "•";
    return "⨯";
  }).join("");
  const label = frozen ? `frozen at phase ${current}` : `phase ${current}/7`;
  return (
    <span className="phase-badge" title={label} aria-label={label}>
      {cells}
    </span>
  );
}

// Spec 050 Block B: dashboard panel that fetches the per-artifact
// status matrix and renders one row per PRG / raw / extract
// artifact with phase badge + completion + quality + relevance.
interface PerArtifactStatusRow {
  artifactId: string;
  title: string;
  kind: string;
  platform?: string;
  phase?: number;
  phaseFrozen?: boolean;
  relativePath: string;
  steps: Array<{ name: string; status: "done" | "pending" | "blocked" }>;
  completionPctAnalyst: number;
  completionPctCracker: number;
}

interface PerArtifactStatusResponse {
  projectDir: string;
  count: number;
  items: PerArtifactStatusRow[];
}

function PerArtifactStatusPanel({ projectDir }: { projectDir: string }) {
  const [rows, setRows] = useState<PerArtifactStatusRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"completion" | "title" | "phase">("completion");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchJson<PerArtifactStatusResponse>(`/api/per-artifact-status?projectDir=${encodeURIComponent(projectDir)}`);
        if (!cancelled) setRows(data.items ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [projectDir]);

  const sorted = useMemo(() => {
    const copy = [...rows];
    switch (sortBy) {
      case "completion": copy.sort((a, b) => b.completionPctAnalyst - a.completionPctAnalyst); break;
      case "title": copy.sort((a, b) => a.title.localeCompare(b.title)); break;
      case "phase": copy.sort((a, b) => (b.phase ?? 1) - (a.phase ?? 1)); break;
    }
    return copy;
  }, [rows, sortBy]);

  if (loading) return <div className="empty-inline">Loading per-artifact status…</div>;
  if (error) return <div className="inspector-error"><pre>{error}</pre></div>;
  if (rows.length === 0) return <div className="empty-inline">No phase-tracked artifacts.</div>;

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Per-Artifact Status</h3>
        <span>{rows.length} artifacts</span>
      </div>
      <div className="inspector-chip-row">
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
          <option value="completion">sort: completion ↓</option>
          <option value="title">sort: title ↑</option>
          <option value="phase">sort: phase ↓</option>
        </select>
      </div>
      <div className="questions-table">
        <div className="questions-row questions-row-head">
          <span className="questions-cell-title">Title</span>
          <span className="questions-cell-meta">phase</span>
          <span className="questions-cell-meta">analyst%</span>
          <span className="questions-cell-meta">cracker%</span>
          <span className="questions-cell-meta">platform</span>
        </div>
        {sorted.slice(0, 200).map((r) => (
          <div key={r.artifactId} className="questions-row">
            <span className="questions-cell-title" title={r.relativePath}>{r.title}</span>
            <span className="questions-cell-meta"><PhaseBadge phase={r.phase} frozen={r.phaseFrozen} /></span>
            <span className="questions-cell-meta">{r.completionPctAnalyst}%</span>
            <span className="questions-cell-meta">{r.completionPctCracker}%</span>
            <span className="questions-cell-meta">{r.platform ?? "c64"}</span>
          </div>
        ))}
        {sorted.length > 200 ? <div className="empty-inline">Showing first 200 of {sorted.length}.</div> : null}
      </div>
    </section>
  );
}

function RecordList({
  title,
  items,
  onSelectEntity,
}: {
  title: string;
  items: Array<{ id: string; title: string; summary?: string; status: string; confidence?: number; entityId?: string; updatedAt: string }>;
  onSelectEntity?: (entityId: string) => void;
}) {
  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>{title}</h3>
      </div>
      <div className="record-stack">
        {items.length === 0 ? <div className="empty-state">No records.</div> : null}
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="record-card"
            onClick={() => item.entityId && onSelectEntity?.(item.entityId)}
            disabled={!item.entityId}
          >
            <div className="record-topline">
              <span>{item.title}</span>
              <span className="record-status">{item.status}</span>
            </div>
            {item.summary ? <p>{item.summary}</p> : null}
            <div className="record-meta">
              {item.confidence !== undefined ? <span>{pct(item.confidence)}</span> : null}
              <span>{shortTime(item.updatedAt)}</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

const ALL_REPAIR_OPS: ProjectRepairOperation[] = [
  "merge-fragments",
  "register-artifacts",
  "import-analysis",
  "import-manifest",
  "build-views",
];

function AuditPanel({
  projectDir,
  onReloadWorkspace,
}: {
  projectDir: string;
  onReloadWorkspace: () => Promise<void>;
}) {
  const [audit, setAudit] = useState<AuditCachedResponse | null>(null);
  const [busy, setBusy] = useState<"audit" | "audit-fresh" | "repair-dry" | "repair-safe" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRepair, setLastRepair] = useState<ProjectRepairResponse | null>(null);

  async function loadAudit(fresh: boolean) {
    setError(null);
    setBusy(fresh ? "audit-fresh" : "audit");
    try {
      const url = `/api/audit?projectDir=${encodeURIComponent(projectDir)}${fresh ? "&fresh=1" : ""}`;
      const data = await fetchJson<AuditCachedResponse>(url);
      setAudit(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(null);
    }
  }

  async function runRepair(mode: "dry-run" | "safe") {
    if (mode === "safe" && !window.confirm("Run safe repair? This will write to knowledge/ and views/. Source files are not deleted.")) {
      return;
    }
    setError(null);
    setBusy(mode === "safe" ? "repair-safe" : "repair-dry");
    try {
      const data = await postJson<ProjectRepairResponse>("/api/repair", {
        projectDir,
        mode,
        operations: ALL_REPAIR_OPS,
      });
      setLastRepair(data);
      await loadAudit(true);
      if (mode === "safe") await onReloadWorkspace();
    } catch (repairError) {
      setError(repairError instanceof Error ? repairError.message : String(repairError));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void loadAudit(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir]);

  const findings: ProjectAuditFinding[] = audit?.audit.findings ?? [];
  const counts = audit?.audit.counts;

  return (
    <section className="panel-card audit-panel">
      <div className="section-heading">
        <h3>Project Audit</h3>
        <span>{audit ? `${audit.audit.severity} (${audit.cacheStatus})` : "loading..."}</span>
      </div>
      <div className="inspector-chip-row">
        <button type="button" className="inspector-chip" disabled={busy !== null} onClick={() => loadAudit(true)}>
          {busy === "audit-fresh" ? "Auditing..." : "Refresh audit"}
        </button>
        <button
          type="button"
          className="inspector-chip"
          disabled={busy !== null || !audit?.audit.safeRepairAvailable}
          onClick={() => runRepair("dry-run")}
        >
          {busy === "repair-dry" ? "Planning..." : "Dry-run repair"}
        </button>
        <button
          type="button"
          className="inspector-chip"
          disabled={busy !== null || !audit?.audit.safeRepairAvailable}
          onClick={() => runRepair("safe")}
        >
          {busy === "repair-safe" ? "Repairing..." : "Run safe repair"}
        </button>
      </div>
      {error ? <div className="inspector-error">{error}</div> : null}
      {counts ? (
        <div className="record-meta">
          <span>nested={counts.nestedKnowledgeStores}</span>
          <span>broken={counts.brokenArtifactPaths}</span>
          <span>missing={counts.missingArtifacts}</span>
          <span>unregistered={counts.unregisteredFiles}</span>
          <span>unimported={counts.unimportedAnalysisArtifacts + counts.unimportedManifestArtifacts}</span>
          <span>staleViews={counts.staleViews}</span>
        </div>
      ) : null}
      <div className="record-stack compact">
        {findings.length === 0 ? (
          <div className="empty-inline">No audit findings.</div>
        ) : (
          findings.slice(0, 5).map((finding) => (
            <article key={finding.id} className="mini-card">
              <div className="record-topline">
                <span>[{finding.severity}] {finding.title}</span>
              </div>
              <p>{finding.whyItMatters}</p>
              <p><strong>Fix:</strong> {finding.suggestedFix}</p>
              {finding.paths.length > 0 ? (
                <div className="record-meta">
                  <span>{finding.paths.length} affected path(s)</span>
                </div>
              ) : null}
            </article>
          ))
        )}
      </div>
      {lastRepair ? (
        <details className="audit-repair-result">
          <summary>{`Last repair (${lastRepair.mode}) — executed=${lastRepair.executed.length} skipped=${lastRepair.skipped.length}`}</summary>
          <div className="record-stack compact">
            {lastRepair.planned.length > 0 ? (
              <article className="mini-card">
                <strong>Planned</strong>
                <pre>{lastRepair.planned.slice(0, 20).join("\n")}</pre>
              </article>
            ) : null}
            {lastRepair.executed.length > 0 ? (
              <article className="mini-card">
                <strong>Executed</strong>
                <pre>{lastRepair.executed.slice(0, 20).join("\n")}</pre>
              </article>
            ) : null}
            {lastRepair.skipped.length > 0 ? (
              <article className="mini-card">
                <strong>Skipped</strong>
                <pre>{lastRepair.skipped.slice(0, 20).join("\n")}</pre>
              </article>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function WorkflowRunnerPanel({
  snapshot,
  onReloadWorkspace,
}: {
  snapshot: WorkspaceUiSnapshot;
  onReloadWorkspace: () => Promise<void>;
}) {
  const { latest } = useLineageVisibility();
  const { visibleArtifacts: visibleA } = useInternalVisibility();
  const prgArtifacts = useMemo(
    () => visibleA(latest(snapshot.artifacts.filter((artifact) => artifact.kind === "prg" || artifact.relativePath.toLowerCase().endsWith(".prg")))),
    [snapshot.artifacts, latest, visibleA],
  );
  const [selected, setSelected] = useState<string | null>(prgArtifacts[0]?.id ?? null);
  const [mode, setMode] = useState<"quick" | "full">("full");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PrgReverseWorkflowResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected || !prgArtifacts.find((artifact) => artifact.id === selected)) {
      setSelected(prgArtifacts[0]?.id ?? null);
    }
  }, [prgArtifacts, selected]);

  async function runWorkflow() {
    const artifact = prgArtifacts.find((entry) => entry.id === selected);
    if (!artifact) return;
    setError(null);
    setBusy(true);
    try {
      const data = await postJson<PrgReverseWorkflowResponse>("/api/run-prg-workflow", {
        projectDir: snapshot.project.rootPath,
        prgPath: artifact.relativePath,
        mode,
      });
      setResult(data);
      await onReloadWorkspace();
    } catch (workflowError) {
      setError(workflowError instanceof Error ? workflowError.message : String(workflowError));
    } finally {
      setBusy(false);
    }
  }

  if (prgArtifacts.length === 0) {
    return (
      <section className="panel-card workflow-panel">
        <div className="section-heading">
          <h3>PRG Reverse Workflow</h3>
          <span>no PRG artifacts</span>
        </div>
        <p className="empty-inline">Register a PRG with project_init, then run project_inventory_sync to enable the workflow runner.</p>
      </section>
    );
  }

  return (
    <section className="panel-card workflow-panel">
      <div className="section-heading">
        <h3>PRG Reverse Workflow</h3>
        <span>{result ? result.status : "idle"}</span>
      </div>
      <div className="inspector-chip-row">
        <select
          value={selected ?? ""}
          onChange={(event) => setSelected(event.target.value || null)}
          disabled={busy}
        >
          {prgArtifacts.map((artifact) => (
            <option key={artifact.id} value={artifact.id}>{artifact.relativePath}</option>
          ))}
        </select>
        <select value={mode} onChange={(event) => setMode(event.target.value === "quick" ? "quick" : "full")} disabled={busy}>
          <option value="full">full (analyze + disasm + reports)</option>
          <option value="quick">quick (analyze + disasm only)</option>
        </select>
        <button
          type="button"
          className="inspector-chip"
          disabled={busy || !selected}
          onClick={runWorkflow}
        >
          {busy ? "Running..." : "Run reverse workflow"}
        </button>
      </div>
      {error ? <div className="inspector-error">{error}</div> : null}
      {result ? (
        <div className="record-stack compact">
          <article className="mini-card">
            <strong>Status: {result.status}</strong>
            <p>Imported entities={result.importedCounts.entities} findings={result.importedCounts.findings} relations={result.importedCounts.relations} flows={result.importedCounts.flows} questions={result.importedCounts.openQuestions}</p>
            <p>{result.nextRequiredAction}</p>
          </article>
          <article className="mini-card">
            <strong>Phases</strong>
            <pre>{result.phases.map((p) => `[${p.status}] ${p.phase}${p.reason ? " — " + p.reason : ""}`).join("\n")}</pre>
          </article>
          {result.artifactsWritten.length > 0 ? (
            <article className="mini-card">
              <strong>Artifacts written</strong>
              <pre>{result.artifactsWritten.join("\n")}</pre>
            </article>
          ) : null}
          {result.viewsBuilt.length > 0 ? (
            <article className="mini-card">
              <strong>Views rebuilt</strong>
              <pre>{result.viewsBuilt.join("\n")}</pre>
            </article>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

type QuestionStatusFilter = "all" | "open" | "researching" | "answered" | "invalidated" | "deferred";
type QuestionPriorityFilter = "all" | "low" | "medium" | "high" | "critical";
type QuestionSort = "updatedDesc" | "updatedAsc" | "confidenceAsc" | "confidenceDesc" | "priorityDesc";

const PRIORITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function QuestionsPanel({
  snapshot,
  onSelectQuestion,
  onReloadWorkspace,
}: {
  snapshot: WorkspaceUiSnapshot;
  onSelectQuestion: (questionId: string) => void;
  onReloadWorkspace: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<QuestionStatusFilter>("open");
  const [priorityFilter, setPriorityFilter] = useState<QuestionPriorityFilter>("all");
  const [kindFilter, setKindFilter] = useState("");
  const [sort, setSort] = useState<QuestionSort>("updatedDesc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  // Spec 061 / UX3: track active bulk-revaluate tasks so questions can
  // show a "re-eval pending" badge. Pending = question.id ∈ task.questionIds
  // AND question.updatedAt < task.createdAt (agent hasn't touched yet).
  const [activeBulkTasks, setActiveBulkTasks] = useState<Array<{ id: string; questionIds: string[]; createdAt: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const data = await fetch(`/api/tasks/active-bulk?projectDir=${encodeURIComponent(snapshot.project.rootPath)}`).then((r) => r.json()) as { tasks: Array<{ id: string; questionIds: string[]; createdAt: string }> };
        if (!cancelled) setActiveBulkTasks(data.tasks ?? []);
      } catch {
        if (!cancelled) setActiveBulkTasks([]);
      }
      if (!cancelled) timer = setTimeout(poll, 30000);
    }
    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [snapshot.project.rootPath]);
  const pendingByQuestionId = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of activeBulkTasks) {
      for (const qid of t.questionIds) {
        if (!map.has(qid)) map.set(qid, t.id);
      }
    }
    return map;
  }, [activeBulkTasks]);

  const kinds = useMemo(() => {
    const set = new Set<string>();
    for (const q of snapshot.openQuestions) set.add(q.kind);
    return [...set].sort();
  }, [snapshot.openQuestions]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    let list = snapshot.openQuestions.filter((q) => {
      if (statusFilter !== "all" && q.status !== statusFilter) return false;
      if (priorityFilter !== "all" && q.priority !== priorityFilter) return false;
      if (kindFilter && q.kind !== kindFilter) return false;
      if (needle) {
        const hay = `${q.title} ${q.description ?? ""} ${q.answerSummary ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    list = [...list].sort((a, b) => {
      switch (sort) {
        case "updatedAsc": return a.updatedAt.localeCompare(b.updatedAt);
        case "updatedDesc": return b.updatedAt.localeCompare(a.updatedAt);
        case "confidenceAsc": return a.confidence - b.confidence;
        case "confidenceDesc": return b.confidence - a.confidence;
        case "priorityDesc": return (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
      }
    });
    return list;
  }, [snapshot.openQuestions, search, statusFilter, priorityFilter, kindFilter, sort]);

  const visible = filtered.slice(0, 500);
  const allVisibleSelected = visible.length > 0 && visible.every((q) => selected.has(q.id));

  function toggleId(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const q of visible) next.delete(q.id);
      } else {
        for (const q of visible) next.add(q.id);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function applyBatch(patch: { status?: "deferred" | "invalidated" | "answered" | "open"; priority?: "low" | "medium" | "high" | "critical"; answerSummary?: string }) {
    if (selected.size === 0) return;
    setError(null);
    setBusy(true);
    try {
      const ids = [...selected];
      const data = await postJson<{ updated: string[]; errors: Array<{ id: string; error: string }> }>("/api/open-question/batch", {
        projectDir: snapshot.project.rootPath,
        ids,
        patch,
      });
      setLastResult(`Updated ${data.updated.length} of ${ids.length}.${data.errors.length > 0 ? ` ${data.errors.length} errors.` : ""}`);
      if (data.errors.length > 0) {
        setError(data.errors.slice(0, 5).map((e) => `${e.id}: ${e.error}`).join("\n"));
      }
      setSelected(new Set());
      await onReloadWorkspace();
    } catch (batchError) {
      setError(batchError instanceof Error ? batchError.message : String(batchError));
    } finally {
      setBusy(false);
    }
  }

  async function batchSetPriority() {
    const value = window.prompt("New priority (low/medium/high/critical):", "medium")?.trim().toLowerCase();
    if (!value) return;
    if (!["low", "medium", "high", "critical"].includes(value)) {
      setError("Invalid priority.");
      return;
    }
    await applyBatch({ priority: value as "low" | "medium" | "high" | "critical" });
  }

  // Spec 061 / UX3: bulk re-evaluate. Phase 1 deterministic sweep runs
  // server-side; phase 2 queues an automation task the LLM picks up via
  // c64re_whats_next. Returns the task id + post-sweep counts.
  async function batchRevaluate() {
    if (selected.size === 0) return;
    setError(null);
    setBusy(true);
    try {
      const ids = [...selected];
      const data = await postJson<{
        taskId: string;
        questionCount: number;
        phase1: { archived: number; answered: number; sweepCounts: Array<{ artifactId: string; archived: number; answered: number }> };
        remainingForPhase2: number;
      }>("/api/tasks/bulk-revaluate", {
        projectDir: snapshot.project.rootPath,
        questionIds: ids,
        priority: "medium",
      });
      setLastResult(
        `Re-evaluation queued. Phase 1 closed ${data.phase1.answered} of ${data.questionCount} questions automatically; ` +
        `${data.remainingForPhase2} remain for the LLM agent (task ${data.taskId}).`
      );
      setSelected(new Set());
      await onReloadWorkspace();
    } catch (revaluateError) {
      setError(revaluateError instanceof Error ? revaluateError.message : String(revaluateError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel-card questions-panel">
      <div className="section-heading">
        <h3>Questions</h3>
        <span>{filtered.length} of {snapshot.openQuestions.length} | selected {selected.size}</span>
      </div>
      <div className="inspector-chip-row">
        <input
          type="search"
          placeholder="Search title / summary"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as QuestionStatusFilter)}>
          <option value="all">all status</option>
          <option value="open">open</option>
          <option value="researching">researching</option>
          <option value="answered">answered</option>
          <option value="invalidated">invalidated</option>
          <option value="deferred">deferred</option>
        </select>
        <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as QuestionPriorityFilter)}>
          <option value="all">all priority</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="critical">critical</option>
        </select>
        <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}>
          <option value="">all kinds</option>
          {kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </select>
        <select value={sort} onChange={(event) => setSort(event.target.value as QuestionSort)}>
          <option value="updatedDesc">updated ↓</option>
          <option value="updatedAsc">updated ↑</option>
          <option value="confidenceAsc">confidence ↑</option>
          <option value="confidenceDesc">confidence ↓</option>
          <option value="priorityDesc">priority ↓</option>
        </select>
      </div>
      <div className="inspector-chip-row">
        <button type="button" className="inspector-chip" onClick={selectAllVisible} disabled={busy || visible.length === 0}>
          {allVisibleSelected ? "Unselect visible" : `Select visible (${visible.length})`}
        </button>
        <button type="button" className="inspector-chip" onClick={clearSelection} disabled={busy || selected.size === 0}>
          Clear selection
        </button>
        <button type="button" className="inspector-chip" disabled={busy || selected.size === 0} onClick={batchRevaluate} title="Phase 1 sweep (deterministic) + Phase 2 LLM task queued via UX3.">
          {busy ? "..." : `Re-evaluate ${selected.size}`}
        </button>
        <button type="button" className="inspector-chip" disabled={busy || selected.size === 0} onClick={() => applyBatch({ status: "deferred" })}>
          {busy ? "..." : `Defer ${selected.size}`}
        </button>
        <button type="button" className="inspector-chip" disabled={busy || selected.size === 0} onClick={() => applyBatch({ status: "invalidated" })}>
          {`Invalidate ${selected.size}`}
        </button>
        <button type="button" className="inspector-chip" disabled={busy || selected.size === 0} onClick={() => applyBatch({ status: "open" })}>
          {`Reopen ${selected.size}`}
        </button>
        <button type="button" className="inspector-chip" disabled={busy || selected.size === 0} onClick={batchSetPriority}>
          {`Set priority ${selected.size}`}
        </button>
      </div>
      {lastResult ? <div className="empty-inline">{lastResult}</div> : null}
      {error ? <div className="inspector-error"><pre>{error}</pre></div> : null}
      {filtered.length > visible.length ? (
        <div className="empty-inline">Showing first {visible.length} of {filtered.length}. Tighten the filter to see more.</div>
      ) : null}
      <div className="questions-table">
        <div className="questions-row questions-row-head">
          <span className="questions-cell-check"></span>
          <span className="questions-cell-title">Title</span>
          <span className="questions-cell-meta">kind</span>
          <span className="questions-cell-meta">prio</span>
          <span className="questions-cell-meta">conf</span>
          <span className="questions-cell-meta">status</span>
          <span className="questions-cell-meta">updated</span>
        </div>
        {visible.map((question) => (
          <div key={question.id} className="questions-row">
            <span className="questions-cell-check">
              <input
                type="checkbox"
                checked={selected.has(question.id)}
                onChange={() => toggleId(question.id)}
                disabled={busy}
              />
            </span>
            <button
              type="button"
              className="questions-cell-title questions-row-title"
              onClick={() => onSelectQuestion(question.id)}
            >
              {question.title}
              {pendingByQuestionId.has(question.id) ? (
                <span className="questions-pending-badge" title={`Re-eval task ${pendingByQuestionId.get(question.id)} pending. Agent picks it up via c64re_whats_next.`}>
                  re-eval pending
                </span>
              ) : null}
            </button>
            <span className="questions-cell-meta">{question.kind}</span>
            <span className="questions-cell-meta">{question.priority}</span>
            <span className="questions-cell-meta">{pct(question.confidence)}</span>
            <span className="questions-cell-meta">{question.status}</span>
            <span className="questions-cell-meta">{shortTime(question.updatedAt)}</span>
          </div>
        ))}
        {filtered.length === 0 ? <div className="empty-inline">No questions match the current filter.</div> : null}
      </div>
    </section>
  );
}

// Spec 021 knowledge tabs: read-only flat-table panels for findings,
// entities, flows, relations. Each panel mirrors the QuestionsPanel
// pattern (search + filters + sort + virtualised rows capped at 500).
// Click a row title -> selects the related entity in the workspace.

function visibleSlice<T>(items: T[]): { visible: T[]; truncated: number } {
  const visible = items.slice(0, 500);
  return { visible, truncated: items.length - visible.length };
}

function FindingsPanel({
  snapshot,
  onSelectEntity,
}: {
  snapshot: WorkspaceUiSnapshot;
  onSelectEntity: (entityId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("");
  const [sort, setSort] = useState<"updatedDesc" | "updatedAsc" | "confidenceDesc" | "confidenceAsc">("updatedDesc");
  const kinds = useMemo(() => {
    const set = new Set<string>();
    for (const f of snapshot.findings) set.add(f.kind);
    return [...set].sort();
  }, [snapshot.findings]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    let list = snapshot.findings.filter((f) => {
      if (statusFilter !== "all" && f.status !== statusFilter) return false;
      if (kindFilter && f.kind !== kindFilter) return false;
      if (needle) {
        const hay = `${f.title} ${f.summary ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    list = [...list].sort((a, b) => {
      switch (sort) {
        case "updatedAsc": return a.updatedAt.localeCompare(b.updatedAt);
        case "updatedDesc": return b.updatedAt.localeCompare(a.updatedAt);
        case "confidenceAsc": return a.confidence - b.confidence;
        case "confidenceDesc": return b.confidence - a.confidence;
      }
    });
    return list;
  }, [snapshot.findings, search, statusFilter, kindFilter, sort]);
  const { visible, truncated } = visibleSlice(filtered);
  return (
    <section className="panel-card questions-panel">
      <div className="section-heading">
        <h3>Findings</h3>
        <span>{filtered.length} of {snapshot.findings.length}</span>
      </div>
      <div className="inspector-chip-row">
        <input type="search" placeholder="Search title / summary" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">all status</option>
          <option value="proposed">proposed</option>
          <option value="active">active</option>
          <option value="confirmed">confirmed</option>
          <option value="rejected">rejected</option>
          <option value="archived">archived</option>
        </select>
        <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
          <option value="">all kinds</option>
          {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="updatedDesc">updated ↓</option>
          <option value="updatedAsc">updated ↑</option>
          <option value="confidenceDesc">confidence ↓</option>
          <option value="confidenceAsc">confidence ↑</option>
        </select>
      </div>
      {truncated > 0 ? <div className="empty-inline">Showing first {visible.length} of {filtered.length}. Tighten the filter to see more.</div> : null}
      <div className="questions-table">
        <div className="questions-row questions-row-head">
          <span className="questions-cell-title">Title</span>
          <span className="questions-cell-meta">kind</span>
          <span className="questions-cell-meta">conf</span>
          <span className="questions-cell-meta">status</span>
          <span className="questions-cell-meta">entities</span>
          <span className="questions-cell-meta">updated</span>
        </div>
        {visible.map((finding) => (
          <div key={finding.id} className="questions-row">
            <button
              type="button"
              className="questions-cell-title questions-row-title"
              onClick={() => finding.entityIds[0] && onSelectEntity(finding.entityIds[0])}
              disabled={finding.entityIds.length === 0}
              title={finding.summary ?? ""}
            >
              {finding.title}
            </button>
            <span className="questions-cell-meta">{finding.kind}</span>
            <span className="questions-cell-meta">{pct(finding.confidence)}</span>
            <span className="questions-cell-meta">{finding.status}</span>
            <span className="questions-cell-meta">{finding.entityIds.length}</span>
            <span className="questions-cell-meta">{shortTime(finding.updatedAt)}</span>
          </div>
        ))}
        {filtered.length === 0 ? <div className="empty-inline">No findings match the current filter.</div> : null}
      </div>
    </section>
  );
}

function EntitiesPanel({
  snapshot,
  onSelectEntity,
}: {
  snapshot: WorkspaceUiSnapshot;
  onSelectEntity: (entityId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [sort, setSort] = useState<"name" | "addressAsc" | "confidenceDesc">("name");
  const kinds = useMemo(() => {
    const set = new Set<string>();
    for (const e of snapshot.entities) set.add(e.kind);
    return [...set].sort();
  }, [snapshot.entities]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    let list = snapshot.entities.filter((e) => {
      if (kindFilter && e.kind !== kindFilter) return false;
      if (needle) {
        const hay = `${e.name} ${e.summary ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    list = [...list].sort((a, b) => {
      switch (sort) {
        case "name": return a.name.localeCompare(b.name);
        case "addressAsc": return (a.addressRange?.start ?? Number.POSITIVE_INFINITY) - (b.addressRange?.start ?? Number.POSITIVE_INFINITY);
        case "confidenceDesc": return b.confidence - a.confidence;
      }
    });
    return list;
  }, [snapshot.entities, search, kindFilter, sort]);
  const { visible, truncated } = visibleSlice(filtered);
  return (
    <section className="panel-card questions-panel">
      <div className="section-heading">
        <h3>Entities</h3>
        <span>{filtered.length} of {snapshot.entities.length}</span>
      </div>
      <div className="inspector-chip-row">
        <input type="search" placeholder="Search name / summary" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
          <option value="">all kinds</option>
          {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="name">name ↑</option>
          <option value="addressAsc">address ↑</option>
          <option value="confidenceDesc">confidence ↓</option>
        </select>
      </div>
      {truncated > 0 ? <div className="empty-inline">Showing first {visible.length} of {filtered.length}. Tighten the filter to see more.</div> : null}
      <div className="questions-table">
        <div className="questions-row questions-row-head">
          <span className="questions-cell-title">Name</span>
          <span className="questions-cell-meta">kind</span>
          <span className="questions-cell-meta">address</span>
          <span className="questions-cell-meta">conf</span>
          <span className="questions-cell-meta">artifacts</span>
        </div>
        {visible.map((entity) => (
          <div key={entity.id} className="questions-row">
            <button
              type="button"
              className="questions-cell-title questions-row-title"
              onClick={() => onSelectEntity(entity.id)}
              title={entity.summary ?? ""}
            >
              {entity.name}
            </button>
            <span className="questions-cell-meta">{entity.kind}</span>
            <span className="questions-cell-meta">
              {entity.addressRange ? `$${entity.addressRange.start.toString(16).toUpperCase().padStart(4, "0")}` : "—"}
            </span>
            <span className="questions-cell-meta">{pct(entity.confidence)}</span>
            <span className="questions-cell-meta">{entity.artifactIds.length}</span>
          </div>
        ))}
        {filtered.length === 0 ? <div className="empty-inline">No entities match the current filter.</div> : null}
      </div>
    </section>
  );
}

function FlowsPanel({
  snapshot,
  onSelectEntity,
}: {
  snapshot: WorkspaceUiSnapshot;
  onSelectEntity: (entityId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return snapshot.flows.filter((f) => {
      if (!needle) return true;
      const hay = `${f.title} ${f.summary ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [snapshot.flows, search]);
  const { visible, truncated } = visibleSlice(filtered);
  return (
    <section className="panel-card questions-panel">
      <div className="section-heading">
        <h3>Flows</h3>
        <span>{filtered.length} of {snapshot.flows.length}</span>
      </div>
      <div className="inspector-chip-row">
        <input type="search" placeholder="Search title / summary" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {truncated > 0 ? <div className="empty-inline">Showing first {visible.length} of {filtered.length}. Tighten the filter to see more.</div> : null}
      <div className="questions-table">
        <div className="questions-row questions-row-head">
          <span className="questions-cell-title">Title</span>
          <span className="questions-cell-meta">kind</span>
          <span className="questions-cell-meta">steps</span>
          <span className="questions-cell-meta">entities</span>
          <span className="questions-cell-meta">updated</span>
        </div>
        {visible.map((flow) => (
          <div key={flow.id} className="questions-row">
            <button
              type="button"
              className="questions-cell-title questions-row-title"
              onClick={() => flow.entityIds[0] && onSelectEntity(flow.entityIds[0])}
              disabled={flow.entityIds.length === 0}
              title={flow.summary ?? ""}
            >
              {flow.title}
            </button>
            <span className="questions-cell-meta">{flow.kind}</span>
            <span className="questions-cell-meta">{flow.nodes.length}</span>
            <span className="questions-cell-meta">{flow.entityIds.length}</span>
            <span className="questions-cell-meta">{shortTime(flow.updatedAt)}</span>
          </div>
        ))}
        {filtered.length === 0 ? <div className="empty-inline">No flows match the current filter.</div> : null}
      </div>
    </section>
  );
}

function RelationsPanel({
  snapshot,
  onSelectEntity,
}: {
  snapshot: WorkspaceUiSnapshot;
  onSelectEntity: (entityId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const kinds = useMemo(() => {
    const set = new Set<string>();
    for (const r of snapshot.relations) set.add(r.kind);
    return [...set].sort();
  }, [snapshot.relations]);
  const entityNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of snapshot.entities) map.set(e.id, e.name);
    return map;
  }, [snapshot.entities]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return snapshot.relations.filter((r) => {
      if (kindFilter && r.kind !== kindFilter) return false;
      if (!needle) return true;
      const sourceName = entityNameById.get(r.sourceEntityId) ?? r.sourceEntityId;
      const targetName = entityNameById.get(r.targetEntityId) ?? r.targetEntityId;
      const hay = `${r.title} ${r.summary ?? ""} ${sourceName} ${targetName}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [snapshot.relations, search, kindFilter, entityNameById]);
  const { visible, truncated } = visibleSlice(filtered);
  return (
    <section className="panel-card questions-panel">
      <div className="section-heading">
        <h3>Relations</h3>
        <span>{filtered.length} of {snapshot.relations.length}</span>
      </div>
      <div className="inspector-chip-row">
        <input type="search" placeholder="Search source/target/title" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
          <option value="">all kinds</option>
          {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </div>
      {truncated > 0 ? <div className="empty-inline">Showing first {visible.length} of {filtered.length}. Tighten the filter to see more.</div> : null}
      <div className="questions-table">
        <div className="questions-row questions-row-head">
          <span className="questions-cell-title">Title</span>
          <span className="questions-cell-meta">kind</span>
          <span className="questions-cell-meta">source</span>
          <span className="questions-cell-meta">target</span>
          <span className="questions-cell-meta">conf</span>
        </div>
        {visible.map((relation) => (
          <div key={relation.id} className="questions-row">
            <button
              type="button"
              className="questions-cell-title questions-row-title"
              onClick={() => onSelectEntity(relation.sourceEntityId)}
              title={relation.summary ?? ""}
            >
              {relation.title}
            </button>
            <span className="questions-cell-meta">{relation.kind}</span>
            <span className="questions-cell-meta" title={relation.sourceEntityId}>
              {entityNameById.get(relation.sourceEntityId) ?? relation.sourceEntityId.slice(0, 12)}
            </span>
            <span className="questions-cell-meta" title={relation.targetEntityId}>
              {entityNameById.get(relation.targetEntityId) ?? relation.targetEntityId.slice(0, 12)}
            </span>
            <span className="questions-cell-meta">{pct(relation.confidence)}</span>
          </div>
        ))}
        {filtered.length === 0 ? <div className="empty-inline">No relations match the current filter.</div> : null}
      </div>
    </section>
  );
}

function DashboardPanel({
  snapshot,
  onSelectEntity,
  onSelectQuestion,
  onOpenDocument,
  onReloadWorkspace,
}: {
  snapshot: WorkspaceUiSnapshot;
  onSelectEntity: (entityId: string) => void;
  onSelectQuestion: (questionId: string) => void;
  onOpenDocument: (path: string) => void;
  onReloadWorkspace: () => Promise<void>;
}) {
  return (
    <div className="dashboard-shell">
      <section className="panel-card overview-panel">
        <div className="section-heading">
          <h3>Overall State</h3>
          <span>{snapshot.project.status}</span>
        </div>
        <div className="overview-grid">
          {snapshot.views.projectDashboard.overview.map((item) => (
            <article key={item.id} className="overview-card">
              <h4>{item.title}</h4>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="panel-card">
        <div className="section-heading">
          <h3>Open Questions</h3>
          <span>{snapshot.openQuestions.filter((q) => q.status === "open" || q.status === "researching").length} open · click to inspect</span>
        </div>
        <div className="record-stack">
          {snapshot.views.projectDashboard.openQuestions.length === 0 ? (
            <div className="empty-inline">No open questions in the dashboard view. Run build_all_views or rebuild from the audit panel below.</div>
          ) : null}
          {snapshot.views.projectDashboard.openQuestions.slice(0, 8).map((question) => (
            <button key={question.id} type="button" className="record-card" onClick={() => onSelectQuestion(question.id)}>
              <div className="record-topline">
                <span>{question.title}</span>
                <span className="record-status">{question.status}</span>
              </div>
              {question.summary ? <p>{question.summary}</p> : null}
            </button>
          ))}
        </div>
      </section>

      <div className="split-columns">
        <section className="panel-card">
          <div className="section-heading">
            <h3>Current Work</h3>
            <span>tasks</span>
          </div>
          <div className="record-stack">
            {snapshot.views.projectDashboard.openTasks.length === 0 ? (
              <div className="empty-inline">No open tasks.</div>
            ) : null}
            {snapshot.views.projectDashboard.openTasks.slice(0, 6).map((task) => (
              <button
                key={task.id}
                type="button"
                className="record-card"
                onClick={() => {
                  const entityId = snapshot.tasks.find((candidate) => candidate.id === task.id)?.entityIds[0];
                  if (entityId) onSelectEntity(entityId);
                }}
              >
                <div className="record-topline">
                  <span>{task.title}</span>
                  <span className="record-status">{task.status}</span>
                </div>
                {task.summary ? <p>{task.summary}</p> : null}
              </button>
            ))}
          </div>
        </section>
        <section className="panel-card">
          <div className="section-heading">
            <h3>Key Documents</h3>
            <span>{snapshot.views.projectDashboard.keyDocuments.length} docs</span>
          </div>
          <div className="record-stack">
            {snapshot.views.projectDashboard.keyDocuments.map((doc) => (
              <button
                key={doc.id}
                type="button"
                className="record-card"
                onClick={() => doc.summary && onOpenDocument(doc.summary)}
              >
                <div className="record-topline">
                  <span>{doc.title}</span>
                  <span className="record-status">doc</span>
                </div>
                {doc.summary ? <p>{doc.summary}</p> : null}
                <div className="record-meta">
                  <span>{shortTime(doc.updatedAt)}</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>

      <AuditPanel projectDir={snapshot.project.rootPath} onReloadWorkspace={onReloadWorkspace} />
      <PerArtifactStatusPanel projectDir={snapshot.project.rootPath} />
      <WorkflowRunnerPanel snapshot={snapshot} onReloadWorkspace={onReloadWorkspace} />
      {/* Spec 059 / UX1: Recent Activity tab folded into Dashboard. */}
      <ActivityPanel snapshot={snapshot} />
    </div>
  );
}

function DocsPanel({
  docs,
  selectedPath,
  onSelectPath,
  content,
  loading,
  error,
}: {
  docs: UiDocument[];
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  content: string;
  loading: boolean;
  error: string | null;
}) {
  const selectedDoc = docs.find((doc) => doc.relativePath === selectedPath) ?? docs[0];
  const groups = groupDocs(docs);

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Docs</h3>
        <span>{docs.length} markdown files</span>
      </div>
      <div className="docs-shell">
        <div className="docs-list">
          <div className="docs-list-stack">
            {groups.map((group) => (
              <section key={group.id} className="docs-group">
                <div className="docs-group-title">
                  <strong>{group.title}</strong>
                  <span>{group.docs.length}</span>
                </div>
                <div className={group.id === "facts" ? "record-stack docs-tree-stack" : "record-stack"}>
                  {group.docs.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      className={selectedDoc?.relativePath === doc.relativePath ? "record-card active-record" : "record-card"}
                      onClick={() => onSelectPath(doc.relativePath)}
                    >
                      <div className="record-topline">
                        <span>{doc.title}</span>
                        <span className="record-status">{doc.unregistered ? "unregistered" : (doc.role ?? "doc")}</span>
                      </div>
                      <p>{doc.relativePath}</p>
                      <div className="record-meta">
                        <span>{shortTime(doc.updatedAt)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
        <div className="docs-viewer">
          <div className="detail-title-row">
            <h4>{selectedDoc?.title ?? "No document selected"}</h4>
            <span>{selectedDoc?.relativePath ?? ""}</span>
          </div>
          {loading ? <div className="empty-state">Loading document...</div> : null}
          {error ? <div className="error-banner">{error}</div> : null}
          {!loading && !error && content ? <ThinMarkdown content={content} /> : null}
          {!loading && !error && !content ? <div className="empty-state">No markdown content.</div> : null}
        </div>
      </div>
    </section>
  );
}

const GRAPHICS_GROUP_ORDER: Array<{ id: string; title: string; matches: (kind: string) => boolean }> = [
  { id: "sprites", title: "Sprites", matches: (kind) => kind === "sprite" },
  { id: "charsets", title: "Charsets", matches: (kind) => kind === "charset" || kind === "charset_source" },
  { id: "bitmaps", title: "Bitmaps", matches: (kind) => kind === "bitmap" || kind === "hires_bitmap" || kind === "multicolor_bitmap" || kind === "bitmap_source" },
  { id: "screens", title: "Screen / Color", matches: (kind) => kind === "screen_ram" || kind === "screen_source" || kind === "color_source" },
];

function groupGraphics(items: GraphicsItem[]): Array<{ id: string; title: string; items: GraphicsItem[] }> {
  return GRAPHICS_GROUP_ORDER
    .map((group) => ({ id: group.id, title: group.title, items: items.filter((item) => group.matches(item.kind)) }))
    .filter((group) => group.items.length > 0);
}

// Bug 23 (Stage 2): derive the marks map from items. Single source of truth.
function deriveGraphicsMarks(items: GraphicsItem[]): Record<string, { status: "rejected" | "confirmed"; note?: string }> {
  const map: Record<string, { status: "rejected" | "confirmed"; note?: string }> = {};
  for (const item of items) {
    if (item.confirmed === true) map[item.id] = { status: "confirmed" };
    else if (item.rejected === true) map[item.id] = { status: "rejected", note: item.rejectedReason };
  }
  return map;
}

function formatHex16(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

function formatBytes(value: number): string {
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function GraphicsPanel({
  items,
  selectedId,
  onSelect,
  bytes,
  loading,
  error,
  charsetPairId,
  onSelectCharsetPair,
  charsetBytes,
  marks,
  onMark,
  hideRejected,
  onToggleHideRejected,
}: {
  items: GraphicsItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  bytes: Uint8Array | null;
  loading: boolean;
  error: string | null;
  charsetPairId: string | null;
  onSelectCharsetPair: (id: string | null) => void;
  charsetBytes: Uint8Array | null;
  marks: Record<string, { status: "rejected" | "confirmed"; note?: string }>;
  onMark: (itemId: string, status: "rejected" | "confirmed" | "clear") => void;
  hideRejected: boolean;
  onToggleHideRejected: (next: boolean) => void;
}) {
  const visibleItems = hideRejected ? items.filter((item) => marks[item.id]?.status !== "rejected") : items;
  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0];
  const groups = groupGraphics(visibleItems);
  const renderKind = (selected?.kind ?? "sprite") as GraphicsRenderKind;
  const showColours = !!selected;
  const charsetCandidates = items.filter((item) => item.kind === "charset" || item.kind === "charset_source");
  const screenLikeKind = selected && (selected.kind === "screen_ram" || selected.kind === "screen_source" || selected.kind === "color_source");
  const rejectedCount = items.filter((item) => marks[item.id]?.status === "rejected").length;
  const confirmedCount = items.filter((item) => marks[item.id]?.status === "confirmed").length;
  const selectedMark = selected ? marks[selected.id] : undefined;

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Graphics</h3>
        <span>{items.length} segments · {confirmedCount} confirmed · {rejectedCount} rejected</span>
        <label style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
          <input type="checkbox" checked={hideRejected} onChange={(e) => onToggleHideRejected(e.target.checked)} />
          Hide rejected
        </label>
      </div>
      <div className="docs-shell">
        <div className="docs-list">
          <div className="docs-list-stack">
            {groups.map((group) => (
              <section key={group.id} className="docs-group">
                <div className="docs-group-title">
                  <strong>{group.title}</strong>
                  <span>{group.items.length}</span>
                </div>
                <div className="record-stack">
                  {group.items.map((item) => {
                    const mark = marks[item.id];
                    const markBadge = mark?.status === "rejected" ? "rejected" : mark?.status === "confirmed" ? "confirmed" : item.kind;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={selected?.id === item.id ? "record-card active-record" : "record-card"}
                        onClick={() => onSelect(item.id)}
                        style={mark?.status === "rejected" ? { opacity: 0.55 } : undefined}
                      >
                        <div className="record-topline">
                          <span>{item.label}</span>
                          <span className="record-status">{markBadge}</span>
                        </div>
                        <p>${formatHex16(item.start)}–${formatHex16(item.end)} · {formatBytes(item.length)}</p>
                        <div className="record-meta">
                          <span>{item.prgRelativePath}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
        <div className="docs-viewer">
          <div className="detail-title-row">
            <h4>{selected?.label ?? "No graphics segment selected"}</h4>
            <span>{selected ? `${selected.kind} · $${formatHex16(selected.start)}–$${formatHex16(selected.end)} · ${formatBytes(selected.length)}` : ""}</span>
          </div>
          {selected ? (
            <div className="c64-mark-row" style={{ display: "flex", gap: "8px", padding: "4px 0", fontSize: "12px" }}>
              <span style={{ color: "#9aa4b2" }}>Status: <strong>{selectedMark?.status ?? "unmarked"}</strong></span>
              <button type="button" disabled={selectedMark?.status === "confirmed"} onClick={() => onMark(selected.id, "confirmed")}>Confirm graphics</button>
              <button type="button" disabled={selectedMark?.status === "rejected"} onClick={() => onMark(selected.id, "rejected")}>Mark wrong</button>
              {selectedMark ? <button type="button" onClick={() => onMark(selected.id, "clear")}>Clear mark</button> : null}
            </div>
          ) : null}
          {screenLikeKind && charsetCandidates.length > 0 ? (
            <div className="c64-charmap-pairing">
              <label>
                Pair with charset:&nbsp;
                <select
                  value={charsetPairId ?? ""}
                  onChange={(event) => onSelectCharsetPair(event.target.value || null)}
                >
                  <option value="">(none — render bytes as charset grid)</option>
                  {charsetCandidates.map((charset) => (
                    <option key={charset.id} value={charset.id}>
                      {charset.label} (${formatHex16(charset.start)}–${formatHex16(charset.end)}, {formatBytes(charset.length)})
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
          {selected ? (
            <C64GraphicsView
              bytes={bytes}
              loading={loading}
              error={error}
              kind={renderKind}
              showColourPicker={showColours}
              charsetBytes={screenLikeKind ? charsetBytes ?? undefined : undefined}
            />
          ) : (
            <div className="empty-state">Select a graphics segment to render it.</div>
          )}
        </div>
      </div>
    </section>
  );
}

type ScrubKind = "sprite" | "charset" | "bitmap";

const SCRUB_BLOCK_BYTES: Record<ScrubKind, number> = {
  sprite: 64,
  charset: 8,
  bitmap: 320, // 8 bytes per cell × 40 cells = one row of an 8000-byte hires bitmap
};

function ScrubPanel({
  artifacts,
  projectRoot,
  onOpenHex,
  onOpenAsm,
}: {
  artifacts: ArtifactRecord[];
  projectRoot: string;
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number }) => void;
  onOpenAsm: (title: string, sources: AsmViewSource[]) => void;
}) {
  // Filter rules:
  //  1. Only PRG / CRT / raw — same as before.
  //  2. Hide rebuild-check artifacts (Bug 14 followup; they pollute
  //     the list with auto-generated *_disasm_rebuild_check.prg
  //     entries that are not real source PRGs).
  //  3. Lineage filter (Bug 24): default = highest versionRank per
  //     lineageRoot. The "Show all versions" toggle in the header
  //     bypasses it via the LineageVisibilityContext.
  const lineageVisibility = useLineageVisibility();
  const internalVisibility = useInternalVisibility();
  const scrubArtifactsRaw = artifacts.filter((artifact) =>
    (artifact.kind === "prg" || artifact.kind === "crt" || artifact.kind === "raw")
    && artifact.role !== "rebuild-check"
  );
  const scrubArtifacts = internalVisibility.visibleArtifacts(lineageVisibility.latest(scrubArtifactsRaw))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const [selectedPath, setSelectedPath] = useState<string>(scrubArtifacts[0]?.relativePath ?? "");
  const [offsetText, setOffsetText] = useState<string>("0000");
  const [windowText, setWindowText] = useState<string>("1000");
  const [kind, setKind] = useState<ScrubKind>("charset");
  const [multicolor, setMulticolor] = useState<boolean>(false);
  const [columns, setColumns] = useState<number>(32);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [prgLoadAddress, setPrgLoadAddress] = useState<number | null>(null);

  function parseHex(value: string): number {
    const clean = value.trim().replace(/^\$/, "").replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]+$/.test(clean)) return 0;
    return Number.parseInt(clean, 16);
  }

  function formatHex(value: number): string {
    return value.toString(16).toUpperCase().padStart(4, "0");
  }

  useEffect(() => {
    if (!selectedPath) {
      setBytes(null);
      setFileSize(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const offset = parseHex(offsetText);
        const length = Math.max(1, parseHex(windowText));
        const params = new URLSearchParams({
          projectDir: projectRoot,
          path: selectedPath,
          offset: String(offset),
          length: String(length),
        });
        const response = await fetch(`/api/artifact/raw?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (cancelled) return;
        setBytes(new Uint8Array(buffer));
        const total = response.headers.get("Content-Range");
        // Best-effort size via separate HEAD-style probe: /api/artifact/raw returns the
        // requested slice, so just fall back to size inference by re-querying length=1
        // at a far offset. For the spike we leave fileSize null when unknown.
        setFileSize(total ? Number.parseInt(total.split("/")[1] ?? "", 10) || null : null);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
          setBytes(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedPath, offsetText, windowText, projectRoot]);

  function step(deltaBytes: number) {
    const current = parseHex(offsetText);
    const next = Math.max(0, current + deltaBytes);
    setOffsetText(formatHex(next));
  }

  // Pull the 2-byte PRG load-address header so the annotation form can
  // map file offsets to C64 addresses automatically.
  useEffect(() => {
    if (!selectedPath) {
      setPrgLoadAddress(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const params = new URLSearchParams({ projectDir: projectRoot, path: selectedPath, offset: "0", length: "2" });
        const response = await fetch(`/api/artifact/raw?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buf = new Uint8Array(await response.arrayBuffer());
        if (cancelled) return;
        if (buf.length >= 2) setPrgLoadAddress(buf[0]! | (buf[1]! << 8));
      } catch {
        if (!cancelled) setPrgLoadAddress(null);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedPath, projectRoot]);

  async function saveAnnotation() {
    if (!selectedArtifact) return;
    if (selectedArtifact.kind !== "prg") {
      setAnnotateStatus("Annotations require a PRG artifact.");
      return;
    }
    setAnnotateBusy(true);
    setAnnotateStatus("");
    try {
      const fileOffset = parseHex(offsetText);
      const windowBytes = Math.max(1, parseHex(windowText));
      const start = (prgLoadAddress ?? 0) + Math.max(0, fileOffset - 2);
      const end = start + windowBytes - 1;
      const segmentKind = kind === "bitmap" ? (multicolor ? "multicolor_bitmap" : "hires_bitmap") : kind;
      const response = await fetch("/api/scrub/annotate-segment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectDir: projectRoot,
          prgPath: selectedPath,
          start: start.toString(16).toUpperCase().padStart(4, "0"),
          end: end.toString(16).toUpperCase().padStart(4, "0"),
          kind: segmentKind,
          label: annotateLabel.trim() || undefined,
          comment: annotateComment.trim() || undefined,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { annotationsPath: string; totalSegments: number };
      setAnnotateStatus(`Saved → ${payload.annotationsPath} (${payload.totalSegments} segments).`);
    } catch (saveError) {
      setAnnotateStatus(`Save failed: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
    } finally {
      setAnnotateBusy(false);
    }
  }

  const blockBytes = SCRUB_BLOCK_BYTES[kind];

  const [annotateLabel, setAnnotateLabel] = useState<string>("");
  const [annotateComment, setAnnotateComment] = useState<string>("");
  const [annotateStatus, setAnnotateStatus] = useState<string>("");
  const [annotateBusy, setAnnotateBusy] = useState<boolean>(false);

  const selectedArtifact = scrubArtifacts.find((artifact) => artifact.relativePath === selectedPath);
  const stem = selectedArtifact ? selectedArtifact.relativePath.replace(/\.[^.]+$/, "").replace(/^.*\//, "") : "";
  const pairedAsmSources = stem
    ? bestAsmSourcesForArtifacts(
        artifacts.filter((artifact) => {
          const lower = artifact.relativePath.toLowerCase();
          if (!lower.endsWith(".asm") && !lower.endsWith(".tass")) return false;
          return lower.includes(stem.toLowerCase());
        }),
      )
    : [];
  const showMon = selectedArtifact ? isC64BinaryArtifact(selectedArtifact.relativePath) : false;

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Scrub</h3>
        <span>Free-form memory browser — pick a file, scroll the address, render any slice</span>
      </div>
      {selectedArtifact ? (
        <div className="scrub-inspector" style={{
          display: "flex", flexWrap: "wrap", gap: "16px", padding: "10px 12px",
          background: "rgba(255,255,255,0.04)", borderRadius: "6px", marginBottom: "8px",
          fontSize: "12px", alignItems: "center",
        }}>
          <div><strong>{selectedArtifact.title}</strong></div>
          <div style={{ color: "#9aa4b2" }}>kind: {selectedArtifact.kind}</div>
          <div style={{ color: "#9aa4b2" }}>role: {selectedArtifact.role ?? "—"}</div>
          <div style={{ color: "#9aa4b2" }}>status: {selectedArtifact.status}</div>
          <div style={{ color: "#9aa4b2" }}>{selectedArtifact.relativePath}</div>
          <div style={{ marginLeft: "auto", display: "flex", gap: "6px" }}>
            {showMon ? (
              <button
                type="button"
                onClick={() => onOpenHex(selectedArtifact.relativePath, {
                  title: `${selectedArtifact.title} (hex)`,
                  baseAddress: 0,
                })}
              >
                (mon)
              </button>
            ) : null}
            {pairedAsmSources.length > 0 ? (
              <button
                type="button"
                onClick={() => onOpenAsm(`${selectedArtifact.title} disasm`, pairedAsmSources)}
              >
                .asm
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="docs-shell">
        <div className="docs-list" style={{ minWidth: "280px" }}>
          <div className="docs-list-stack" style={{ gap: "12px" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
              File:
              <select value={selectedPath} onChange={(e) => setSelectedPath(e.target.value)}>
                {scrubArtifacts.map((artifact) => (
                  <option key={artifact.id} value={artifact.relativePath}>
                    {artifact.title} ({artifact.kind})
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
              Offset (hex):
              <input
                type="text"
                value={offsetText}
                onChange={(e) => setOffsetText(e.target.value)}
                style={{ fontFamily: "ui-monospace, monospace" }}
              />
            </label>
            <div style={{ display: "flex", gap: "4px", fontSize: "11px" }}>
              <button type="button" onClick={() => step(-blockBytes * 4)}>--row</button>
              <button type="button" onClick={() => step(-blockBytes)}>-blk</button>
              <button type="button" onClick={() => step(-1)}>-1</button>
              <button type="button" onClick={() => step(1)}>+1</button>
              <button type="button" onClick={() => step(blockBytes)}>+blk</button>
              <button type="button" onClick={() => step(blockBytes * 4)}>+row</button>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
              Window (hex bytes):
              <input
                type="text"
                value={windowText}
                onChange={(e) => setWindowText(e.target.value)}
                style={{ fontFamily: "ui-monospace, monospace" }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
              Kind:
              <select value={kind} onChange={(e) => setKind(e.target.value as ScrubKind)}>
                <option value="charset">charset (8x8)</option>
                <option value="sprite">sprite (24x21)</option>
                <option value="bitmap">bitmap (320x200)</option>
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
              <input type="checkbox" checked={multicolor} onChange={(e) => setMulticolor(e.target.checked)} />
              Multicolor
            </label>
            {kind !== "bitmap" ? (
              <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
                Columns per row ({kind === "sprite" ? `${columns}×24 = ${columns * 24}px wide` : `${columns}×8 = ${columns * 8}px wide`}):
                <input
                  type="number"
                  min={1}
                  max={128}
                  value={columns}
                  onChange={(e) => setColumns(Math.max(1, Math.min(128, Number.parseInt(e.target.value, 10) || 1)))}
                />
              </label>
            ) : null}
            <p style={{ fontSize: "11px", color: "#9aa4b2", margin: 0 }}>
              Block size: {blockBytes} bytes. Use <strong>+blk / -blk</strong> to jump exactly one block at a time.
            </p>
            {fileSize ? <p style={{ fontSize: "11px", color: "#9aa4b2", margin: 0 }}>File size: {fileSize} B</p> : null}
            {prgLoadAddress !== null ? (
              <p style={{ fontSize: "11px", color: "#9aa4b2", margin: 0 }}>Load address: ${prgLoadAddress.toString(16).toUpperCase().padStart(4, "0")}</p>
            ) : null}
            {selectedArtifact?.kind === "prg" ? (
              <div style={{ borderTop: "1px solid #30363d", paddingTop: "10px", marginTop: "6px", display: "flex", flexDirection: "column", gap: "6px" }}>
                <strong style={{ fontSize: "12px" }}>Save as segment</strong>
                <p style={{ fontSize: "11px", color: "#9aa4b2", margin: 0 }}>
                  Persists the current window into <code>{selectedArtifact?.relativePath.replace(/\.[^.]+$/, "")}_annotations.json</code> as a kind=
                  <code>{kind === "bitmap" ? (multicolor ? "multicolor_bitmap" : "hires_bitmap") : kind}</code> segment. Picked up by the next <code>disasm_prg</code> run.
                </p>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
                  Label (optional):
                  <input
                    type="text"
                    value={annotateLabel}
                    onChange={(e) => setAnnotateLabel(e.target.value)}
                    placeholder="e.g. title_screen_charset"
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
                  Comment (optional):
                  <input
                    type="text"
                    value={annotateComment}
                    onChange={(e) => setAnnotateComment(e.target.value)}
                    placeholder="why this slice is graphics"
                  />
                </label>
                <button type="button" onClick={saveAnnotation} disabled={annotateBusy}>
                  {annotateBusy ? "Saving…" : "Save segment"}
                </button>
                {annotateStatus ? <p style={{ fontSize: "11px", color: "#9aa4b2", margin: 0 }}>{annotateStatus}</p> : null}
              </div>
            ) : null}
          </div>
        </div>
        <div className="docs-viewer">
          <div className="detail-title-row">
            <h4>{selectedPath || "No file"}</h4>
            <span>offset=${offsetText.toUpperCase()} window=${windowText.toUpperCase()} {kind}{multicolor ? "·mc" : ""}</span>
          </div>
          {selectedPath ? (
            <C64GraphicsView
              bytes={bytes}
              loading={loading}
              error={error}
              kind={(kind === "bitmap" ? (multicolor ? "multicolor_bitmap" : "hires_bitmap") : kind) as GraphicsRenderKind}
              multicolor={kind !== "bitmap" ? multicolor : undefined}
              columns={kind !== "bitmap" ? columns : undefined}
              showColourPicker={true}
            />
          ) : (
            <div className="empty-state">No artifact available to scrub.</div>
          )}
        </div>
      </div>
    </section>
  );
}




type MediaFilter = "all" | "disk" | "cartridge";

function artifactMediaClass(kind: string | undefined): "disk" | "cartridge" | "other" {
  if (!kind) return "other";
  const k = kind.toLowerCase();
  if (k.includes("d64") || k.includes("g64") || k.includes("disk")) return "disk";
  if (k.includes("crt") || k.includes("cart") || k.includes("chip")) return "cartridge";
  return "other";
}

function diskFileSelectionForEntity(snapshot: WorkspaceUiSnapshot, entityId: string): DiskFileSelection | null {
  for (const disk of snapshot.views.diskLayout.disks) {
    const file = disk.files.find((candidate) => candidate.entityId === entityId);
    if (file) return { diskArtifactId: disk.artifactId, fileId: file.id };
  }
  return null;
}

function firstDiskFileSelection(snapshot: WorkspaceUiSnapshot): DiskFileSelection | null {
  const disk = snapshot.views.diskLayout.disks.find((candidate) => candidate.files.length > 0);
  const file = disk?.files[0];
  return disk && file ? { diskArtifactId: disk.artifactId, fileId: file.id } : null;
}

function diskSelectionEntityId(snapshot: WorkspaceUiSnapshot, selection: DiskFileSelection | null): string | null {
  if (!selection) return null;
  const disk = snapshot.views.diskLayout.disks.find((candidate) => candidate.artifactId === selection.diskArtifactId);
  return disk?.files.find((file) => file.id === selection.fileId)?.entityId ?? null;
}

function tabHasEntity(snapshot: WorkspaceUiSnapshot, entityId: string, tab: TabId): boolean {
  const entity = snapshot.entities.find((candidate) => candidate.id === entityId);
  if (!entity) return false;
  if (tab === "dashboard") return true;
  if (tab === "docs" || tab === "graphics" || tab === "scrub") return false;
  if (tab === "memory") {
    return Boolean(entity.addressRange)
      || snapshot.views.memoryMap.cells.some((cell) => cell.entityIds.includes(entityId) || cell.dominantEntityId === entityId)
      || snapshot.views.memoryMap.regions.some((region) => region.entityId === entityId)
      || snapshot.views.memoryMap.highlights.some((highlight) => highlight.entityId === entityId);
  }
  if (tab === "disk") return diskFileSelectionForEntity(snapshot, entityId) !== null;
  if (tab === "flow") return snapshot.views.loadSequence.items.some((item) => item.primaryEntityId === entityId || item.entityIds.includes(entityId))
    || snapshot.views.flowGraph.nodes.some((node) => node.entityId === entityId)
    || Object.values(snapshot.views.flowGraph.modes ?? {}).some((mode) => mode.nodes.some((node) => node.entityId === entityId));
  if (tab === "listing") return snapshot.views.annotatedListing.entries.some((entry) => entry.entityId === entityId);
  if (tab === "cartridge") {
    const isCartridgeEntity = entity.kind.toLowerCase().includes("chip")
      || entity.kind.toLowerCase().includes("bank")
      || entity.mediumSpans?.some((span) => span.kind === "slot")
      || entity.artifactIds.some((artifactId) => snapshot.views.cartridgeLayout.cartridges.some((cart) => cart.artifactId === artifactId));
    return Boolean(isCartridgeEntity);
  }
  return false;
}

function firstEntityForTab(snapshot: WorkspaceUiSnapshot, tab: TabId): string | null {
  if (tab === "dashboard") {
    return snapshot.findings.flatMap((finding) => finding.entityIds)[0] ?? snapshot.entities[0]?.id ?? null;
  }
  if (tab === "memory") {
    return snapshot.views.memoryMap.regions.find((region) => region.entityId)?.entityId
      ?? snapshot.views.memoryMap.highlights.find((highlight) => highlight.entityId)?.entityId
      ?? snapshot.views.memoryMap.cells.flatMap((cell) => cell.dominantEntityId ? [cell.dominantEntityId] : cell.entityIds)[0]
      ?? null;
  }
  if (tab === "cartridge") {
    return snapshot.entities.find((entity) => tabHasEntity(snapshot, entity.id, "cartridge"))?.id ?? null;
  }
  if (tab === "disk") {
    return snapshot.views.diskLayout.disks.flatMap((disk) => disk.files.map((file) => file.entityId).filter(Boolean))[0] ?? null;
  }
  if (tab === "flow") {
    const loadFirst = snapshot.views.loadSequence.items.flatMap((item) => item.primaryEntityId ? [item.primaryEntityId] : item.entityIds)[0];
    if (loadFirst) return loadFirst;
  }
  if (tab === "flow") {
    return snapshot.views.flowGraph.nodes.find((node) => node.entityId)?.entityId
      ?? Object.values(snapshot.views.flowGraph.modes ?? {}).flatMap((mode) => mode.nodes.map((node) => node.entityId).filter(Boolean))[0]
      ?? null;
  }
  if (tab === "listing") {
    return snapshot.views.annotatedListing.entries.find((entry) => entry.entityId)?.entityId ?? null;
  }
  return null;
}

function LoadSequencePanel({
  view,
  snapshot,
  selectedEntityId,
  onSelectEntity,
}: {
  view: LoadSequenceView;
  snapshot: WorkspaceUiSnapshot;
  selectedEntityId?: string | null;
  onSelectEntity: (entityId: string) => void;
}) {
  const artifactKindById = useMemo(() => {
    const map = new Map<string, string>();
    for (const artifact of snapshot.artifacts) map.set(artifact.id, artifact.kind);
    return map;
  }, [snapshot.artifacts]);

  const diskCount = view.items.filter((item) => item.artifactIds.some((id) => artifactMediaClass(artifactKindById.get(id)) === "disk")).length;
  const cartCount = view.items.filter((item) => item.artifactIds.some((id) => artifactMediaClass(artifactKindById.get(id)) === "cartridge")).length;
  const showMediaFilter = diskCount > 0 && cartCount > 0;
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");

  const visibleItems = useMemo(() => {
    if (mediaFilter === "all") return view.items;
    return view.items.filter((item) =>
      item.artifactIds.some((id) => artifactMediaClass(artifactKindById.get(id)) === mediaFilter),
    );
  }, [view.items, artifactKindById, mediaFilter]);
  const visibleItemIds = new Set(visibleItems.map((item) => item.id));
  const visibleEdges = view.edges.filter((edge) => visibleItemIds.has(edge.fromItemId) && visibleItemIds.has(edge.toItemId));

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Load Sequence</h3>
        <span>{visibleItems.length} payloads / {visibleEdges.length} transitions</span>
      </div>
      {showMediaFilter ? (
        <div className="cart-lut-filter">
          <span className="cart-lut-filter-title">Source</span>
          <button
            type="button"
            className={mediaFilter === "all" ? "cart-lut-pill cart-lut-pill-active" : "cart-lut-pill"}
            onClick={() => setMediaFilter("all")}
          >
            <span>all</span>
            <span className="cart-lut-pill-count">{view.items.length}</span>
          </button>
          <button
            type="button"
            className={mediaFilter === "disk" ? "cart-lut-pill cart-lut-pill-active" : "cart-lut-pill"}
            onClick={() => setMediaFilter("disk")}
          >
            <span>disk</span>
            <span className="cart-lut-pill-count">{diskCount}</span>
          </button>
          <button
            type="button"
            className={mediaFilter === "cartridge" ? "cart-lut-pill cart-lut-pill-active" : "cart-lut-pill"}
            onClick={() => setMediaFilter("cartridge")}
          >
            <span>cartridge</span>
            <span className="cart-lut-pill-count">{cartCount}</span>
          </button>
        </div>
      ) : null}
      <div className="sequence-strip">
        {visibleItems.map((item, index) => (
          <div key={item.id} className="sequence-step">
            <button
              type="button"
              className={selectedEntityId && (item.primaryEntityId === selectedEntityId || item.entityIds.includes(selectedEntityId)) ? "sequence-card active-record" : "sequence-card"}
              onClick={() => item.primaryEntityId && onSelectEntity(item.primaryEntityId)}
              disabled={!item.primaryEntityId}
            >
              <div className="sequence-card-top">
                <span className="sequence-order">{String(index + 1).padStart(2, "0")}</span>
                <span className="sequence-role">{item.role}</span>
              </div>
              <h4>{item.title}</h4>
              <p>{item.purposeSummary ?? "No purpose summary available."}</p>
              <div className="record-meta">
                <span>{pct(item.confidence)}</span>
                {item.entryAddresses[0] !== undefined ? <span>entry {hex(item.entryAddresses[0])}</span> : null}
                {item.targetRanges[0] ? <span>target {hex(item.targetRanges[0].start)}-{hex(item.targetRanges[0].end)}</span> : null}
              </div>
            </button>
            {index < visibleItems.length - 1 ? <div className="sequence-arrow" aria-hidden="true">↓</div> : null}
          </div>
        ))}
      </div>
      <div className="split-columns">
        <div className="detail-card">
          <div className="detail-title-row">
            <h4>Transition Logic</h4>
            <span>payload-centric</span>
          </div>
          <div className="record-stack">
            {visibleEdges.map((edge) => (
              <article key={edge.id} className="record-card static-card">
                <div className="record-topline">
                  <span>{edge.title}</span>
                  <span className="record-status">{edge.kind}</span>
                </div>
                <div className="record-meta">
                  <span>{pct(edge.confidence)}</span>
                  {edge.summary ? <span>{edge.summary}</span> : null}
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// Spec 059 / UX1: wraps FlowPanel with a Load sub-mode that delegates
// to LoadSequencePanel — folds the standalone Load Sequence tab in.
function FlowPanelWithLoadMode({
  flowGraph,
  entities,
  relations,
  selectedEntityId,
  onSelectEntity,
  loadView,
  snapshot,
}: {
  flowGraph: FlowGraphView;
  entities: EntityRecord[];
  relations: RelationRecord[];
  selectedEntityId?: string | null;
  onSelectEntity: (entityId: string) => void;
  loadView: LoadSequenceView;
  snapshot: WorkspaceUiSnapshot;
}) {
  const [topMode, setTopMode] = useState<"graph" | "load">("graph");
  return (
    <section className="panel-card">
      <div className="inspector-chip-row" style={{ marginBottom: "0.5rem" }}>
        <button
          type="button"
          className={topMode === "graph" ? "tab-button active" : "tab-button"}
          onClick={() => setTopMode("graph")}
        >
          Flow Graph
        </button>
        <button
          type="button"
          className={topMode === "load" ? "tab-button active" : "tab-button"}
          onClick={() => setTopMode("load")}
        >
          Load Sequence
        </button>
      </div>
      {topMode === "graph" ? (
        <FlowPanel
          flowGraph={flowGraph}
          entities={entities}
          relations={relations}
          selectedEntityId={selectedEntityId}
          onSelectEntity={onSelectEntity}
        />
      ) : (
        <LoadSequencePanel
          view={loadView}
          snapshot={snapshot}
          selectedEntityId={selectedEntityId}
          onSelectEntity={onSelectEntity}
        />
      )}
    </section>
  );
}


// Spec 051 / Sprint 44: annotation draft viewer side panel.
interface AnnotationDraft {
  segments: Array<{ start: string; end: string; kind: string; label?: string; comment?: string; confidence: number; reason: string; autoGenerated: true }>;
  labels: Array<{ address: string; label: string; comment?: string; confidence: number; reason: string; autoGenerated: true }>;
  routines: Array<{ address: string; name: string; summary: string; confidence: number; reason: string; autoGenerated: true }>;
  openQuestions: Array<{ title: string; description: string; confidence: number; source: "static-analysis" }>;
  buckets: { high: number; medium: number; low: number };
  source: { analysisPath: string; listingPath?: string };
  generatedAt: string;
}

function AnnotationDraftPanel({ projectDir }: { projectDir: string }) {
  const [draftPath, setDraftPath] = useState("");
  const [draft, setDraft] = useState<AnnotationDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    segments: Set<number>; labels: Set<number>; routines: Set<number>;
  }>({ segments: new Set(), labels: new Set(), routines: new Set() });
  // Spec 051 follow-up: per-suggestion edit overrides. Maps
  // (kind, index) -> { label?, comment?, summary? }. Save merges
  // overrides into the persisted JSON.
  const [edits, setEdits] = useState<Record<string, { label?: string; comment?: string; summary?: string }>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);

  function editKey(kind: string, i: number) { return `${kind}:${i}`; }
  function setEditField(key: string, field: "label" | "comment" | "summary", value: string) {
    setEdits((current) => ({ ...current, [key]: { ...current[key], [field]: value } }));
  }

  async function loadDraft() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<{ projectDir: string; path: string; content: AnnotationDraft }>(`/api/annotations/draft?projectDir=${encodeURIComponent(projectDir)}&path=${encodeURIComponent(draftPath)}`);
      setDraft(data.content);
      // Default: accept high-confidence (≥0.8) suggestions
      setPending({
        segments: new Set(data.content.segments.map((s, i) => s.confidence >= 0.8 ? i : -1).filter((i) => i >= 0)),
        labels: new Set(data.content.labels.map((s, i) => s.confidence >= 0.8 ? i : -1).filter((i) => i >= 0)),
        routines: new Set(data.content.routines.map((s, i) => s.confidence >= 0.8 ? i : -1).filter((i) => i >= 0)),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function toggle(kind: "segments" | "labels" | "routines", index: number) {
    setPending((p) => {
      const next = new Set(p[kind]);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return { ...p, [kind]: next };
    });
  }

  async function saveAll() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const finalPath = draftPath.replace(/\.draft\.json$/i, ".json");
      const payload = {
        segments: draft.segments.filter((_, i) => pending.segments.has(i)).map(({ start, end, kind, label, comment }, i) => {
          const override = edits[editKey("segments", i)];
          return { start, end, kind, label: override?.label ?? label, comment: override?.comment ?? comment };
        }),
        labels: draft.labels.filter((_, i) => pending.labels.has(i)).map(({ address, label, comment }, i) => {
          const override = edits[editKey("labels", i)];
          return { address, label: override?.label ?? label, comment: override?.comment ?? comment };
        }),
        routines: draft.routines.filter((_, i) => pending.routines.has(i)).map(({ address, name, summary }, i) => {
          const override = edits[editKey("routines", i)];
          return { address, name: override?.label ?? name, summary: override?.summary ?? summary };
        }),
      };
      const result = await postJson<{ projectDir: string; finalPath: string; ok: boolean }>("/api/annotations/save", {
        projectDir,
        finalPath,
        payload,
      });
      setSavedPath(result.finalPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Annotation Draft Viewer</h3>
        {draft ? <span>high {draft.buckets.high} · med {draft.buckets.medium} · low {draft.buckets.low}</span> : null}
      </div>
      <div className="inspector-chip-row">
        <input
          type="text"
          placeholder="path to *_annotations.draft.json"
          value={draftPath}
          onChange={(e) => setDraftPath(e.target.value)}
        />
        <button type="button" className="inspector-chip" onClick={loadDraft} disabled={loading || !draftPath}>
          {loading ? "..." : "Load"}
        </button>
        {draft ? (
          <button type="button" className="inspector-chip" onClick={saveAll} disabled={saving}>
            {saving ? "Saving..." : `Save ${pending.segments.size + pending.labels.size + pending.routines.size} accepted`}
          </button>
        ) : null}
      </div>
      {error ? <div className="inspector-error"><pre>{error}</pre></div> : null}
      {savedPath ? <div className="empty-inline">Saved → {savedPath}</div> : null}
      {draft ? (
        <div className="questions-table">
          <div className="questions-row questions-row-head">
            <span className="questions-cell-check">✓</span>
            <span className="questions-cell-title">Suggestion</span>
            <span className="questions-cell-meta">type</span>
            <span className="questions-cell-meta">confidence</span>
          </div>
          {draft.segments.map((s, i) => {
            const key = editKey("segments", i);
            const override = edits[key];
            const editing = editingKey === key;
            return (
              <div key={`s-${i}`} className="questions-row">
                <span className="questions-cell-check">
                  <input type="checkbox" checked={pending.segments.has(i)} onChange={() => toggle("segments", i)} />
                </span>
                <span className="questions-cell-title" title={s.reason}>
                  ${s.start}-${s.end} {s.kind}{" "}
                  {editing ? (
                    <>
                      <input value={override?.label ?? s.label ?? ""} onChange={(e) => setEditField(key, "label", e.target.value)} placeholder="label" />
                      <input value={override?.comment ?? s.comment ?? ""} onChange={(e) => setEditField(key, "comment", e.target.value)} placeholder="comment" />
                    </>
                  ) : (
                    <>{override?.label ?? s.label ?? ""}{override?.comment ? ` // ${override.comment}` : ""}</>
                  )}
                </span>
                <span className="questions-cell-meta">segment</span>
                <span className="questions-cell-meta">
                  {s.confidence.toFixed(2)}
                  <button type="button" className="inspector-chip" onClick={() => setEditingKey(editing ? null : key)}>{editing ? "✓" : "✎"}</button>
                </span>
              </div>
            );
          })}
          {draft.labels.map((l, i) => {
            const key = editKey("labels", i);
            const override = edits[key];
            const editing = editingKey === key;
            return (
              <div key={`l-${i}`} className="questions-row">
                <span className="questions-cell-check">
                  <input type="checkbox" checked={pending.labels.has(i)} onChange={() => toggle("labels", i)} />
                </span>
                <span className="questions-cell-title" title={l.reason}>
                  ${l.address}{" "}
                  {editing ? (
                    <input value={override?.label ?? l.label} onChange={(e) => setEditField(key, "label", e.target.value)} placeholder="label" />
                  ) : (
                    override?.label ?? l.label
                  )}
                </span>
                <span className="questions-cell-meta">label</span>
                <span className="questions-cell-meta">
                  {l.confidence.toFixed(2)}
                  <button type="button" className="inspector-chip" onClick={() => setEditingKey(editing ? null : key)}>{editing ? "✓" : "✎"}</button>
                </span>
              </div>
            );
          })}
          {draft.routines.map((r, i) => {
            const key = editKey("routines", i);
            const override = edits[key];
            const editing = editingKey === key;
            return (
              <div key={`r-${i}`} className="questions-row">
                <span className="questions-cell-check">
                  <input type="checkbox" checked={pending.routines.has(i)} onChange={() => toggle("routines", i)} />
                </span>
                <span className="questions-cell-title" title={r.reason}>
                  ${r.address}{" "}
                  {editing ? (
                    <>
                      <input value={override?.label ?? r.name} onChange={(e) => setEditField(key, "label", e.target.value)} placeholder="name" />
                      <input value={override?.summary ?? r.summary} onChange={(e) => setEditField(key, "summary", e.target.value)} placeholder="summary" />
                    </>
                  ) : (
                    <>{override?.label ?? r.name} — {override?.summary ?? r.summary}</>
                  )}
                </span>
                <span className="questions-cell-meta">routine</span>
                <span className="questions-cell-meta">
                  {r.confidence.toFixed(2)}
                  <button type="button" className="inspector-chip" onClick={() => setEditingKey(editing ? null : key)}>{editing ? "✓" : "✎"}</button>
                </span>
              </div>
            );
          })}
          {draft.openQuestions.length > 0 ? (
            <div className="empty-inline">{draft.openQuestions.length} open question(s) in draft. Use propose_annotations --persist-questions to save them.</div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ListingPanel({
  snapshot,
  query,
  setQuery,
  selectedEntityId,
  onSelectEntity,
}: {
  snapshot: WorkspaceUiSnapshot;
  query: string;
  setQuery: (value: string) => void;
  selectedEntityId?: string | null;
  onSelectEntity: (entityId: string) => void;
}) {
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const entries = snapshot.views.annotatedListing.entries.filter((entry) => {
    if (!deferredQuery) {
      return true;
    }
    return [entry.title, entry.kind, entry.comment ?? "", hex(entry.start), hex(entry.end)]
      .join(" ")
      .toLowerCase()
      .includes(deferredQuery);
  });

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Annotated Listing</h3>
        <span>{entries.length} visible entries</span>
      </div>
      <label className="project-input-wrap">
        <span>Filter segments</span>
        <input
          value={query}
          onChange={(event) => startTransition(() => setQuery(event.target.value))}
          placeholder="Search address, label, kind, or comment"
        />
      </label>
      <div className="listing-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Range</th>
              <th>Label</th>
              <th>Kind</th>
              <th>Comment</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className={entry.entityId === selectedEntityId ? "active-row" : ""} onClick={() => entry.entityId && onSelectEntity(entry.entityId)}>
                <td>{hex(entry.start)}-{hex(entry.end)}</td>
                <td>{entry.title}</td>
                <td>{entry.kind}</td>
                <td>{entry.comment ?? "-"}</td>
                <td>{pct(entry.confidence)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Spec 770 — file-centric inspector for a payload/blob (option B). Reuses the
// shared FileInspector shell (mediumKind="payload"), like Disk/Cartridge files.
// A payload entity carries no sector chain, so the spans block is empty (the
// shell hides it); the actions are mon (raw) / mon (depacked) / asm / reverse
// workflow, plus +task / +question.
function PayloadFileInspector({
  snapshot,
  payload,
  onClose,
  onOpenHex,
  onOpenAsm,
  onRunPayloadWorkflow,
  onCreateTask,
  onCreateQuestion,
  onReloadWorkspace,
}: {
  snapshot: WorkspaceUiSnapshot;
  payload: WorkspaceUiSnapshot["entities"][number];
  onClose: () => void;
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number> }) => void;
  onOpenAsm: (title: string, sources: AsmViewSource[]) => void;
  onRunPayloadWorkflow: (payloadId: string, mode?: "quick" | "full") => Promise<PrgReverseWorkflowResponse>;
  onReloadWorkspace: () => void | Promise<void>;
} & LlmTodoActions) {
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const artifactById = useMemo(() => new Map(snapshot.artifacts.map((a) => [a.id, a])), [snapshot.artifacts]);
  const sourceArtifact = payload.payloadSourceArtifactId ? artifactById.get(payload.payloadSourceArtifactId) : undefined;
  const depackedArtifact = payload.payloadDepackedArtifactId ? artifactById.get(payload.payloadDepackedArtifactId) : undefined;
  const asmArtifacts = (payload.payloadAsmArtifactIds ?? [])
    .map((id) => artifactById.get(id))
    .filter((a): a is typeof snapshot.artifacts[number] => Boolean(a));
  const asmSources = bestAsmSourcesForArtifacts(asmArtifacts, snapshot.artifactVersionGroups ?? []);

  const load = payload.payloadLoadAddress ?? payload.addressRange?.start;
  // NOTE: a payload entity's addressRange is the load-address POINT, not the
  // byte length — deriving a size from it would read "1 bytes". True size needs
  // the source artifact's bytes, which the user reaches via mon (raw).

  const headlineExtras: FileInspectorHeadlineExtra[] = [
    { key: "kind", text: payload.kind },
  ];
  if (load !== undefined) headlineExtras.push({ key: "load", text: `load ${hex(load)}` });

  const metaRows: FileInspectorMetaRow[] = [];
  if (load !== undefined) metaRows.push({ key: "load", label: "load address", value: hex(load) });
  if (sourceArtifact) metaRows.push({ key: "source", label: "source", value: sourceArtifact.relativePath });
  if (depackedArtifact) metaRows.push({ key: "depacked", label: "depacked", value: depackedArtifact.relativePath });

  const primaryAction: FileInspectorActionButton | undefined = sourceArtifact ? {
    label: "mon (raw)",
    title: `Open hex view of ${sourceArtifact.relativePath}`,
    enabled: true,
    onClick: () => onOpenHex(sourceArtifact.relativePath, { title: `${payload.name} (raw)`, baseAddress: load }),
  } : undefined;

  const secondaryActions: FileInspectorActionButton[] = [];
  if (depackedArtifact) {
    secondaryActions.push({
      label: "mon (depacked)",
      title: `Open hex view of depacked bytes ${depackedArtifact.relativePath}`,
      enabled: true,
      onClick: () => onOpenHex(depackedArtifact.relativePath, { title: `${payload.name} (depacked)`, baseAddress: load }),
    });
  }
  if (asmSources.length > 0) {
    secondaryActions.push({
      label: `asm${asmSources.some((s) => s.dialect === "64tass") ? "/.tass" : ""}`,
      title: `Open disassembly (${asmSources.map((s) => s.label).join(" / ")})`,
      enabled: true,
      onClick: () => onOpenAsm(payload.name, asmSources),
    });
  }
  const canRunWorkflow = Boolean(sourceArtifact || depackedArtifact) && (payload.payloadFormat === "prg" || load !== undefined);
  secondaryActions.push({
    label: workflowBusy ? "running..." : "reverse workflow",
    title: load !== undefined ? `Run analyze + disasm + reports on ${payload.name}` : "Set a load address before running the workflow",
    enabled: !workflowBusy && canRunWorkflow,
    onClick: () => {
      setWorkflowBusy(true);
      onRunPayloadWorkflow(payload.id, "full")
        .then((result) => window.alert(`Workflow ${result.status}.\nImported entities=${result.importedCounts.entities} findings=${result.importedCounts.findings}.\nNext: ${result.nextRequiredAction}`))
        .catch((error) => window.alert(`Workflow failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => setWorkflowBusy(false));
    },
  });
  const taskArtifactIds = [sourceArtifact?.id, depackedArtifact?.id, ...asmArtifacts.map((a) => a.id)].filter((x): x is string => Boolean(x));
  secondaryActions.push({
    label: "+ task",
    title: `Create an LLM follow-up task for ${payload.name}`,
    enabled: true,
    onClick: () => onCreateTask({
      title: `Investigate ${payload.name}`,
      description: `${load !== undefined ? `Load address: ${hex(load)}\n` : ""}${payload.payloadFormat ? `Format: ${payload.payloadFormat}\n` : ""}\nNext step:`,
      entityIds: [payload.id],
      artifactIds: taskArtifactIds,
    }),
  });
  secondaryActions.push({
    label: "+ question",
    title: `Create an open question for ${payload.name}`,
    enabled: true,
    onClick: () => onCreateQuestion({
      title: `What is the role of ${payload.name}?`,
      description: `${load !== undefined ? `Load address: ${hex(load)}\n` : ""}${payload.payloadFormat ? `Format: ${payload.payloadFormat}\n` : ""}\nQuestion:`,
      entityIds: [payload.id],
      artifactIds: taskArtifactIds,
    }),
  });

  return (
    <FileInspector
      mediumKind="payload"
      title={payload.name}
      packer={payload.payloadPacker}
      format={payload.payloadFormat}
      notes={payload.summary ? [payload.summary] : undefined}
      headlineExtras={headlineExtras}
      metaRows={metaRows}
      primaryAction={primaryAction}
      secondaryActions={secondaryActions}
      spansLabel=""
      spans={[]}
      extraSections={
        asmArtifacts.length > 0 ? (
          <ArtifactVersionsSection
            candidates={asmArtifacts}
            versionGroups={snapshot.artifactVersionGroups ?? []}
            projectDir={snapshot.project.rootPath}
            onOpenAsm={onOpenAsm}
            onReload={onReloadWorkspace}
          />
        ) : undefined
      }
      onClose={onClose}
    />
  );
}

function PayloadsPanel({
  snapshot,
  onOpenHex,
  onOpenAsm,
  onRunPayloadWorkflow,
  onReloadWorkspace,
  selectedPayloadId,
  onSelectPayload,
}: {
  snapshot: WorkspaceUiSnapshot;
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number> }) => void;
  onOpenAsm: (title: string, sources: AsmViewSource[]) => void;
  onRunPayloadWorkflow: (payloadId: string, mode?: "quick" | "full") => Promise<PrgReverseWorkflowResponse>;
  onReloadWorkspace: () => void | Promise<void>;
  selectedPayloadId: string | null;
  onSelectPayload: (payloadId: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorPerId, setErrorPerId] = useState<Record<string, string>>({});

  function handleRun(payloadId: string) {
    setErrorPerId((current) => {
      const next = { ...current };
      delete next[payloadId];
      return next;
    });
    setBusyId(payloadId);
    onRunPayloadWorkflow(payloadId, "full")
      .then((result) => {
        window.alert(`Workflow ${result.status}.\nImported entities=${result.importedCounts.entities} findings=${result.importedCounts.findings}.\nNext: ${result.nextRequiredAction}`);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setErrorPerId((current) => ({ ...current, [payloadId]: message }));
      })
      .finally(() => setBusyId((current) => (current === payloadId ? null : current)));
  }

  // A payload is any entity that carries payload metadata (load address
  // or kind=payload) — disk files imported via manifest-import already
  // populate this. Cart chunks are surfaced via the cartridge view's
  // chunk inspector; once they get entity records they will appear
  // here too.
  const payloads = useMemo(() => {
    return snapshot.entities
      .filter((entity) =>
        entity.kind === "payload" ||
        entity.kind === "disk-file" ||
        entity.payloadLoadAddress !== undefined
      )
      .sort((a, b) => {
        const la = a.payloadLoadAddress ?? a.addressRange?.start ?? 0xffff;
        const lb = b.payloadLoadAddress ?? b.addressRange?.start ?? 0xffff;
        if (la !== lb) return la - lb;
        return a.name.localeCompare(b.name);
      });
  }, [snapshot.entities]);

  const artifactById = useMemo(() => new Map(snapshot.artifacts.map((a) => [a.id, a])), [snapshot.artifacts]);

  const [filter, setFilter] = useState<string>("");
  const visible = filter
    ? payloads.filter((p) =>
        p.name.toLowerCase().includes(filter.toLowerCase()) ||
        (p.payloadFormat ?? "").includes(filter.toLowerCase())
      )
    : payloads;

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Payloads</h3>
        <span>{visible.length}{visible.length !== payloads.length ? ` of ${payloads.length}` : ""} payloads</span>
      </div>
      <input
        type="search"
        placeholder="filter by name or format"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="payload-filter-input"
      />
      <div className="payload-list">
        {visible.length === 0 ? (
          <div className="empty-state">
            No payloads yet. Run <code>extract_disk</code> / <code>extract_crt</code> against this project, or call <code>register_payload</code> to register a custom-loader blob.
          </div>
        ) : null}
        {visible.map((payload) => {
          const sourceArtifact = payload.payloadSourceArtifactId ? artifactById.get(payload.payloadSourceArtifactId) : undefined;
          const depackedArtifact = payload.payloadDepackedArtifactId ? artifactById.get(payload.payloadDepackedArtifactId) : undefined;
          const asmArtifacts = (payload.payloadAsmArtifactIds ?? [])
            .map((id) => artifactById.get(id))
            .filter((a): a is typeof snapshot.artifacts[number] => Boolean(a));
          const load = payload.payloadLoadAddress ?? payload.addressRange?.start;
          const loadText = load !== undefined ? `$${load.toString(16).toUpperCase().padStart(4, "0")}` : "—";
          // Spec 050 Block D: phase badge per payload (resolves
          // through payloadSourceArtifactId or first artifactId).
          const sourceArtifactForBadge = artifactById.get(payload.payloadSourceArtifactId ?? payload.artifactIds[0] ?? "");
          return (
            <article
              key={payload.id}
              className={`payload-card${selectedPayloadId === payload.id ? " active-record" : ""}`}
              onClick={() => onSelectPayload(payload.id)}
              style={{ cursor: "pointer" }}
            >
              <header>
                <strong>{payload.name}</strong>
                {sourceArtifactForBadge ? <PhaseBadge phase={sourceArtifactForBadge.phase} frozen={sourceArtifactForBadge.phaseFrozen} /> : null}
                <span className="payload-load">load {loadText}</span>
                {payload.payloadFormat ? <span className="payload-format">{payload.payloadFormat}</span> : null}
                {payload.payloadPacker ? <span className="payload-packer">{payload.payloadPacker}</span> : null}
              </header>
              {payload.summary ? <p>{payload.summary}</p> : null}
              <footer className="payload-actions">
                {sourceArtifact ? (
                  <button
                    type="button"
                    className="payload-button payload-button-mon"
                    title={`Open hex view of ${sourceArtifact.relativePath}`}
                    onClick={() => onOpenHex(sourceArtifact.relativePath, {
                      title: `${payload.name} (raw)`,
                      baseAddress: load,
                    })}
                  >
                    mon (raw)
                  </button>
                ) : null}
                {depackedArtifact ? (
                  <button
                    type="button"
                    className="payload-button payload-button-mon"
                    title={`Open hex view of depacked bytes ${depackedArtifact.relativePath}`}
                    onClick={() => onOpenHex(depackedArtifact.relativePath, {
                      title: `${payload.name} (depacked)`,
                      baseAddress: load,
                    })}
                  >
                    mon (depacked)
                  </button>
                ) : null}
                {asmArtifacts.length > 0 ? (
                  <button
                    type="button"
                    className="payload-button payload-button-asm"
                    title={`Open disassembly (${asmArtifacts.length} source${asmArtifacts.length === 1 ? "" : "s"})`}
                    onClick={() => onOpenAsm(payload.name, bestAsmSourcesForArtifacts(asmArtifacts, snapshot.artifactVersionGroups ?? []))}
                  >
                    asm
                  </button>
                ) : null}
                {!sourceArtifact && !depackedArtifact && asmArtifacts.length === 0 ? (
                  <span className="payload-empty">no linked artifacts (run register_payload or link_payload_to_asm)</span>
                ) : null}
                {(sourceArtifact || depackedArtifact) ? (
                  <button
                    type="button"
                    className="payload-button"
                    title={load !== undefined ? `Run reverse workflow on ${payload.name}` : "Set payloadLoadAddress before running the workflow"}
                    disabled={busyId !== null || (payload.payloadFormat !== "prg" && load === undefined)}
                    onClick={() => handleRun(payload.id)}
                  >
                    {busyId === payload.id ? "running..." : "reverse workflow"}
                  </button>
                ) : null}
              </footer>
              {asmArtifacts.length > 0 ? (
                <ArtifactVersionsSection
                  candidates={asmArtifacts}
                  versionGroups={snapshot.artifactVersionGroups ?? []}
                  projectDir={snapshot.project.rootPath}
                  onOpenAsm={onOpenAsm}
                  onReload={onReloadWorkspace}
                />
              ) : null}
              {errorPerId[payload.id] ? <div className="inspector-error"><pre>{errorPerId[payload.id]}</pre></div> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ActivityPanel({ snapshot }: { snapshot: WorkspaceUiSnapshot }) {
  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Recent Activity</h3>
        <span>{snapshot.recentTimeline.length} events</span>
      </div>
      <div className="record-stack">
        {snapshot.recentTimeline.map((event) => (
          <article key={event.id} className="timeline-card">
            <strong>{event.title}</strong>
            {event.summary ? <p>{event.summary}</p> : null}
            <span>{shortTime(event.createdAt)}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function TodoComposer({
  draft,
  saving,
  error,
  onChange,
  onClose,
  onSave,
}: {
  draft: TodoComposerState;
  saving: boolean;
  error: string | null;
  onChange: (next: TodoComposerState) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <div className="hex-overlay-backdrop" onClick={onClose}>
      <div className="hex-overlay todo-overlay" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header className="hex-overlay-header">
          <div>
            <h3>{draft.mode === "task" ? "New LLM Task" : "New Open Question"}</h3>
            <p>
              {draft.entityIds.length} linked entities · {draft.artifactIds.length} linked artifacts
            </p>
          </div>
          <div className="hex-overlay-header-actions">
            <button type="button" className="ghost-button" onClick={onClose}>cancel</button>
            <button type="button" className="primary-button" onClick={onSave} disabled={saving || !draft.title.trim()}>
              {saving ? "saving…" : "save"}
            </button>
          </div>
        </header>
        <div className="hex-overlay-body todo-overlay-body">
          <label className="project-input-wrap">
            <span>Title</span>
            <input
              value={draft.title}
              onChange={(event) => onChange({ ...draft, title: event.target.value })}
              placeholder={draft.mode === "task" ? "Investigate loader handoff" : "What triggers this payload?"}
              autoFocus
            />
          </label>
          <label className="project-input-wrap">
            <span>Description</span>
            <textarea
              className="todo-textarea"
              value={draft.description}
              onChange={(event) => onChange({ ...draft, description: event.target.value })}
              placeholder="Context for the LLM"
              rows={8}
            />
          </label>
          {error ? <div className="error-banner">{error}</div> : null}
        </div>
      </div>
    </div>
  );
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

interface LlmTodoActions {
  onCreateTask: (defaults: { title: string; description?: string; entityIds?: string[]; artifactIds?: string[] }) => void;
  onCreateQuestion: (defaults: { title: string; description?: string; entityIds?: string[]; artifactIds?: string[] }) => void;
}

type InspectorMode = "disk-file" | "memory" | "flow" | "payload" | "cartridge" | "generic";

function QuestionInspector({
  snapshot,
  question,
  onClose,
  onSelectEntity,
  onOpenDocument,
  onOpenHex,
  onCreateTask,
  onUpdateStatus,
}: {
  snapshot: WorkspaceUiSnapshot;
  question: OpenQuestionRecord;
  onClose: () => void;
  onSelectEntity: (entityId: string) => void;
  onOpenDocument: (path: string) => void;
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number> }) => void;
  onCreateTask: (defaults: { title: string; description?: string; entityIds?: string[]; artifactIds?: string[] }) => void;
  onUpdateStatus: (questionId: string, status: "answered" | "invalidated" | "deferred" | "open", answerSummary?: string) => Promise<void>;
}) {
  const [busyAction, setBusyAction] = useState<"answered" | "invalidated" | "deferred" | "open" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function runStatusChange(next: "answered" | "invalidated" | "deferred" | "open") {
    setActionError(null);
    setBusyAction(next);
    try {
      let answerSummary: string | undefined;
      if (next === "answered") {
        const reply = window.prompt("Answer summary (optional):", question.answerSummary ?? "") ?? "";
        answerSummary = reply.trim() || undefined;
      }
      await onUpdateStatus(question.id, next, answerSummary);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  }

  const lineageVisibility = useLineageVisibility();
  const internalVisibility = useInternalVisibility();
  const entitiesById = new Map(snapshot.entities.map((entity) => [entity.id, entity]));
  const findingsById = new Map(snapshot.findings.map((finding) => [finding.id, finding]));
  const artifactsById = new Map(snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
  const linkedFindings = question.findingIds
    .map((findingId) => findingsById.get(findingId))
    .filter((finding): finding is FindingRecord => finding !== undefined);
  const linkedEntities = uniqueById(
    [...question.entityIds, ...linkedFindings.flatMap((finding) => finding.entityIds)]
      .map((entityId) => entitiesById.get(entityId))
      .filter((entity): entity is EntityRecord => entity !== undefined),
  );
  // Bug 24 + Bug 26: linked artifacts in the question inspector —
  // latest version per lineage AND drop infrastructure files.
  const linkedArtifacts = internalVisibility.visibleArtifacts(lineageVisibility.latest(uniqueById(
    [...question.artifactIds, ...linkedFindings.flatMap((finding) => finding.artifactIds)]
      .map((artifactId) => artifactsById.get(artifactId))
      .filter((artifact): artifact is ArtifactRecord => artifact !== undefined),
  )));

  function openArtifact(artifact: ArtifactRecord) {
    if (artifact.relativePath.toLowerCase().endsWith(".md")) {
      onOpenDocument(artifact.relativePath);
      return;
    }
    if (isC64BinaryArtifact(artifact.relativePath)) {
      onOpenHex(artifact.relativePath, { title: artifact.title });
    }
  }

  return (
    <section className="panel-card inspector-card">
      <div className="section-heading">
        <h3>Open Question</h3>
        <button type="button" className="mon-icon-button" onClick={onClose}>back</button>
      </div>
      <div className="inspector-head">
        <strong>{question.title}</strong>
        <span>{question.status}</span>
      </div>
      <div className="record-meta">
        <span>{question.kind}</span>
        <span>{question.priority}</span>
        <span>{pct(question.confidence)}</span>
        <span>{shortTime(question.updatedAt)}</span>
      </div>
      {question.description ? <p className="inspector-copy">{question.description}</p> : null}
      {question.answerSummary ? <p className="inspector-copy">{question.answerSummary}</p> : null}
      <div className="inspector-chip-row">
        {linkedEntities.slice(0, 4).map((entity) => (
          <button key={entity.id} type="button" className="inspector-chip" onClick={() => onSelectEntity(entity.id)}>
            {entity.name}
          </button>
        ))}
        <button
          type="button"
          className="inspector-chip"
          onClick={() => onCreateTask({
            title: `Resolve question: ${question.title}`,
            description: question.description,
            entityIds: linkedEntities.map((entity) => entity.id),
            artifactIds: linkedArtifacts.map((artifact) => artifact.id),
          })}
        >
          + LLM Task
        </button>
      </div>
      <div className="inspector-chip-row">
        <button
          type="button"
          className="inspector-chip"
          disabled={busyAction !== null || question.status === "answered"}
          onClick={() => runStatusChange("answered")}
        >
          {busyAction === "answered" ? "Answering…" : "Answer"}
        </button>
        <button
          type="button"
          className="inspector-chip"
          disabled={busyAction !== null || question.status === "invalidated"}
          onClick={() => runStatusChange("invalidated")}
        >
          {busyAction === "invalidated" ? "Invalidating…" : "Invalidate"}
        </button>
        <button
          type="button"
          className="inspector-chip"
          disabled={busyAction !== null || question.status === "deferred"}
          onClick={() => runStatusChange("deferred")}
        >
          {busyAction === "deferred" ? "Deferring…" : "Defer"}
        </button>
        {question.status !== "open" ? (
          <button
            type="button"
            className="inspector-chip"
            disabled={busyAction !== null}
            onClick={() => runStatusChange("open")}
          >
            {busyAction === "open" ? "Reopening…" : "Reopen"}
          </button>
        ) : null}
      </div>
      {actionError ? <div className="inspector-error">{actionError}</div> : null}
      <div className="inspector-block">
        <h4>Linked Findings</h4>
        {linkedFindings.length === 0 ? <div className="empty-inline">No linked findings.</div> : null}
        <div className="record-stack compact">
          {linkedFindings.map((finding) => (
            <article key={finding.id} className="mini-card">
              <strong>{finding.title}</strong>
              <p>{finding.summary ?? finding.kind}</p>
              <div className="record-meta">
                <span>{finding.status}</span>
                <span>{pct(finding.confidence)}</span>
              </div>
            </article>
          ))}
        </div>
      </div>
      <div className="inspector-block">
        <h4>Linked Artifacts</h4>
        {linkedArtifacts.length === 0 ? <div className="empty-inline">No linked artifacts.</div> : null}
        <div className="record-stack compact">
          {linkedArtifacts.map((artifact) => (
            <button key={artifact.id} type="button" className="record-card" onClick={() => openArtifact(artifact)}>
              <div className="record-topline">
                <span>{artifact.title}</span>
                <span className="record-status">{artifact.kind}</span>
              </div>
              <p>{artifact.relativePath}</p>
              <div className="record-meta">
                <span>{artifact.role ?? artifact.scope}</span>
                <span>{pct(artifact.confidence)}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function d64SectorOffset(track: number, sector: number): number {
  let offset = 0;
  for (let t = 1; t < track; t += 1) {
    const perTrack = t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17;
    offset += perTrack * 256;
  }
  return offset + sector * 256;
}

function d64SectorsInTrack(track: number): number {
  return track <= 17 ? 21 : track <= 24 ? 19 : track <= 30 ? 18 : 17;
}

function DiskFileInspector({
  snapshot,
  selection,
  onClose,
  onOpenHex,
  onOpenAsm,
  onOpenTab,
  onSelectEntity,
  onCreateTask,
  onCreateQuestion,
  onRunPrgWorkflow,
  onRunPayloadWorkflow,
  onReloadWorkspace,
}: {
  snapshot: WorkspaceUiSnapshot;
  selection: { diskArtifactId: string; fileId: string };
  onClose: () => void;
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number> }) => void;
  onOpenAsm: (title: string, sources: AsmViewSource[]) => void;
  onOpenTab: (tab: TabId) => void;
  onSelectEntity: (entityId: string) => void;
  onRunPrgWorkflow: (prgPath: string, mode?: "quick" | "full") => Promise<PrgReverseWorkflowResponse>;
  onRunPayloadWorkflow: (payloadId: string, mode?: "quick" | "full") => Promise<PrgReverseWorkflowResponse>;
  onReloadWorkspace: () => void | Promise<void>;
} & LlmTodoActions) {
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const disk = snapshot.views.diskLayout.disks.find((candidate) => candidate.artifactId === selection.diskArtifactId);
  const file = disk?.files.find((candidate) => candidate.id === selection.fileId);
  const diskArtifact = snapshot.artifacts.find((artifact) => artifact.id === selection.diskArtifactId);
  // Prefer the image path (e.g. lykia_disk1.d64) over the manifest path
  // (analysis/disks/disk1/manifest.json). Sector/whole-file views need
  // the raw image, not the JSON manifest.
  const diskPath = disk?.imageRelativePath ?? diskArtifact?.relativePath;
  const isDiskImage = Boolean(diskPath && /\.(d64|g64)$/i.test(diskPath));

  if (!file || !disk) {
    return (
      <section className="panel-card inspector-card">
        <div className="section-heading">
          <h3>Disk file</h3>
          <button type="button" className="mon-icon-button" onClick={onClose}>back</button>
        </div>
        <div className="empty-state">File no longer present in snapshot.</div>
      </section>
    );
  }

  function openSectorMon(track: number, sector: number, bytesUsed: number, partIndex: number, total: number) {
    if (!diskPath) return;
    const params = new URLSearchParams({
      projectDir: snapshot.project.rootPath,
      path: diskPath,
      track: String(track),
      sector: String(sector),
    });
    onOpenHex(diskPath, {
      title: `${disk!.diskName ?? disk!.title} · ${file!.title} · T${track}/S${sector} (${partIndex + 1}/${total})`,
      baseAddress: 0,
      fetchUrl: `/api/disk/sector-bytes?${params.toString()}`,
    });
  }

  async function openWholeFileMon() {
    if (!diskPath || !isDiskImage || file!.sectorChain.length === 0) return;
    // Translate the manifest's sectorChain into explicit
    // (track, sector, offsetInSector, length) windows. Custom-LUT files
    // on protected loaders (Lykia etc.) record bytesUsed=256 with NO
    // link bytes, so we read the whole sector. Standard KERNAL files
    // record bytesUsed<=254 with the first two bytes being the link, so
    // we skip the link and read exactly bytesUsed from offset 2.
    const chain = file!.sectorChain.map((cell) => {
      const fullSector = cell.bytesUsed >= 256;
      return {
        track: cell.track,
        sector: cell.sector,
        offsetInSector: fullSector ? 0 : 2,
        length: fullSector ? 256 : cell.bytesUsed,
      };
    });
    try {
      const response = await fetch("/api/disk/assemble-chain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectDir: snapshot.project.rootPath,
          path: diskPath,
          chain,
          stripLoadAddress: false,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      // Standard D64 PRGs have a 2-byte load-address header at the
      // start; we keep it in the blob so the user sees the raw file
      // bytes. The addr column starts at the load address when known
      // (then every subsequent row reflects the C64-side address).
      const addressBase = file!.loadAddress !== undefined
        ? (file!.loadAddress - Math.min(2, bytes.length)) & 0xffff
        : 0;
      onOpenHex(diskPath, {
        title: `${disk!.diskName ?? disk!.title} · ${file!.title} · assembled (${totalSectors} sectors, ${bytes.length} B)`,
        baseAddress: addressBase,
        bytes,
        packerHint: file!.packer,
      });
    } catch (error) {
      onOpenHex(diskPath, {
        title: `${file!.title} · error`,
        bytes: new TextEncoder().encode(`Failed to assemble chain: ${error instanceof Error ? error.message : String(error)}`),
      });
    }
  }

  const totalSectors = file.sectorChain.length;
  const totalBytes = file.sectorChain.reduce((sum, cell) => sum + (cell.bytesUsed || 254), 0);

  // Cross-reference discovery — only meaningful for actual files, not
  // memory regions, so we keep this scoped to DiskFileInspector.
  const fileStem = (file.relativePath ?? file.title ?? "").split("/").pop()?.replace(/\.[^.]+$/, "")?.toLowerCase();
  // Bug 24 + Bug 26: pair against latest version per lineage AND drop
  // infrastructure files so older / internal revisions don't pollute.
  const lineageVisibility = useLineageVisibility();
  const internalVisibility = useInternalVisibility();
  const visibleForPairing = internalVisibility.visibleArtifacts(lineageVisibility.latest(snapshot.artifacts));
  const asmSources: AsmViewSource[] = fileStem
    ? bestAsmSourcesForArtifacts(
        visibleForPairing
          .filter((artifact) => /\.(asm|tass|s|a65)$/i.test(artifact.relativePath))
          .filter((artifact) => artifact.relativePath.toLowerCase().includes(fileStem)),
        snapshot.artifactVersionGroups ?? [],
      )
    : [];
  // Spec 730 §7.2 — raw source artifacts for this file, feeding the Inspector
  // "Source / Versions" section (kept as ArtifactRecord, not AsmViewSource).
  const sourceArtifactsForFile = fileStem
    ? visibleForPairing
        .filter((artifact) => /\.(asm|tass|sym)$/i.test(artifact.relativePath))
        .filter((artifact) => artifact.relativePath.toLowerCase().includes(fileStem))
    : [];
  const payloadBinaryArtifact = fileStem
    ? [...visibleForPairing]
        .filter((artifact) => artifact.kind === "prg" && artifact.relativePath.toLowerCase().includes(fileStem))
        .sort((left, right) => binaryArtifactPriority(right) - binaryArtifactPriority(left))[0]
    : undefined;

  const linkedLoadItems = snapshot.views.loadSequence.items.filter((item) => {
    if (file.entityId && item.entityIds.includes(file.entityId)) return true;
    if (item.artifactIds.includes(disk.artifactId)) return true;
    return false;
  });

  const headlineExtras: FileInspectorHeadlineExtra[] = [
    { key: "type", text: file.type },
    { key: "sectors", text: `${totalSectors} sectors` },
    { key: "bytes", text: `${totalBytes} bytes` },
  ];
  if (file.loadAddress !== undefined) {
    headlineExtras.push({ key: "load", text: `load ${hex(file.loadAddress)}` });
  }

  const metaRows: FileInspectorMetaRow[] = [
    {
      key: "origin",
      label: "origin",
      value: `${file.loadType}${file.loaderSource ? ` · via ${file.loaderSource}` : ""}`,
    },
    ...(payloadBinaryArtifact ? [{
      key: "payload-image",
      label: "payload image",
      value: payloadBinaryArtifact.relativePath,
    }] : []),
    {
      key: "disk-image",
      label: "disk image",
      value: diskPath ?? "(no path)",
    },
  ];

  const secondaryActions: FileInspectorActionButton[] = [];
  if (asmSources.length > 0) {
    secondaryActions.push({
      label: `.asm${asmSources.some((source) => source.dialect === "64tass") ? "/.tass" : ""}`,
      title: `Open best available source (${asmSources.map((source) => source.label).join(" / ")})`,
      enabled: true,
      onClick: () => onOpenAsm(`${file.title}`, asmSources),
    });
  }
  if (payloadBinaryArtifact && isC64BinaryArtifact(payloadBinaryArtifact.relativePath)) {
    secondaryActions.push({
      label: "mon prg",
      title: `Open payload image ${payloadBinaryArtifact.relativePath}`,
      enabled: true,
      onClick: () => onOpenHex(payloadBinaryArtifact.relativePath, {
        title: `${file.title} · ${payloadBinaryArtifact.title}`,
        baseAddress: file.loadAddress,
      }),
    });
  }
  // Prefer the payload-aware workflow when the disk file has an entity
  // record (any kind) carrying enough metadata. Fall back to the legacy
  // PRG-path workflow only when the file has a `.prg` extension and no
  // entity record exists.
  if (file.entityId) {
    secondaryActions.push({
      label: workflowBusy ? "running..." : "reverse workflow",
      title: `Run analyze + disasm + reports + view rebuild on payload ${file.entityId}`,
      enabled: !workflowBusy,
      onClick: () => {
        setWorkflowBusy(true);
        onRunPayloadWorkflow(file.entityId!, "full")
          .then((result) => {
            window.alert(`Workflow ${result.status}.\nImported entities=${result.importedCounts.entities} findings=${result.importedCounts.findings}.\nNext: ${result.nextRequiredAction}`);
          })
          .catch((error) => {
            window.alert(`Workflow failed: ${error instanceof Error ? error.message : String(error)}`);
          })
          .finally(() => setWorkflowBusy(false));
      },
    });
  } else if (payloadBinaryArtifact && payloadBinaryArtifact.relativePath.toLowerCase().endsWith(".prg")) {
    const prgPath = payloadBinaryArtifact.relativePath;
    secondaryActions.push({
      label: workflowBusy ? "running..." : "reverse workflow",
      title: `Run analyze + disasm + reports + view rebuild on ${prgPath}`,
      enabled: !workflowBusy,
      onClick: () => {
        setWorkflowBusy(true);
        onRunPrgWorkflow(prgPath, "full")
          .then((result) => {
            window.alert(`Workflow ${result.status}.\nImported entities=${result.importedCounts.entities} findings=${result.importedCounts.findings}.\nNext: ${result.nextRequiredAction}`);
          })
          .catch((error) => {
            window.alert(`Workflow failed: ${error instanceof Error ? error.message : String(error)}`);
          })
          .finally(() => setWorkflowBusy(false));
      },
    });
  }
  if (linkedLoadItems.length > 0) {
    secondaryActions.push({
      label: "→ load seq",
      title: `Open in Load Sequence (${linkedLoadItems.map((item) => item.title).join(", ")})`,
      enabled: true,
      onClick: () => {
        const target = linkedLoadItems[0]!;
        if (target.primaryEntityId) onSelectEntity(target.primaryEntityId);
        onOpenTab("flow");
      },
    });
  }
  secondaryActions.push({
    label: "+ task",
    title: `Create an LLM follow-up task for ${file.title}`,
    enabled: true,
    onClick: () => onCreateTask({
      title: `Investigate ${file.title}`,
      description: `${file.relativePath ?? file.title}\n${file.loadAddress !== undefined ? `Load address: ${hex(file.loadAddress)}\n` : ""}${file.loaderSource ? `Loaded via: ${file.loaderSource}\n` : ""}\nNext step:`,
      entityIds: file.entityId ? [file.entityId] : [],
      artifactIds: [disk.artifactId, ...(payloadBinaryArtifact ? [payloadBinaryArtifact.id] : [])],
    }),
  });
  secondaryActions.push({
    label: "+ question",
    title: `Create an open question for ${file.title}`,
    enabled: true,
    onClick: () => onCreateQuestion({
      title: `What is the role of ${file.title}?`,
      description: `${file.relativePath ?? file.title}\n${file.loadAddress !== undefined ? `Load address: ${hex(file.loadAddress)}\n` : ""}${file.loaderSource ? `Loaded via: ${file.loaderSource}\n` : ""}\nQuestion:`,
      entityIds: file.entityId ? [file.entityId] : [],
      artifactIds: [disk.artifactId, ...(payloadBinaryArtifact ? [payloadBinaryArtifact.id] : [])],
    }),
  });

  const spans: FileInspectorSpanRow[] = file.sectorChain.map((cell, partIndex) => ({
    id: `${cell.track}-${cell.sector}`,
    primary: `T${cell.track} / S${cell.sector}`,
    status: cell.isLast ? "last" : `→ ${cell.nextTrack}/${cell.nextSector}`,
    subText: `link $00/$01 + ${cell.bytesUsed || 254} B payload`,
    footerLeft: `step ${cell.index + 1}/${totalSectors}`,
    footerRight: diskPath?.toLowerCase().endsWith(".d64") ? `offset $${d64SectorOffset(cell.track, cell.sector).toString(16).toUpperCase().padStart(6, "0")}` : undefined,
    monEnabled: Boolean(diskPath) && Boolean(isDiskImage),
    monTitle: `Open hex view for T${cell.track}/S${cell.sector} (256 B)`,
    onMon: () => openSectorMon(cell.track, cell.sector, cell.bytesUsed, partIndex, totalSectors),
  }));

  return (
    <FileInspector
      mediumKind="disk"
      title={file.title}
      swatchColor={file.color}
      packer={file.packer}
      format={file.format}
      notes={file.notes}
      headlineExtras={headlineExtras}
      metaRows={metaRows}
      primaryAction={{
        label: `mon (${totalSectors} sectors, ${totalBytes} B)`,
        enabled: Boolean(diskPath) && Boolean(isDiskImage) && file.sectorChain.length > 0,
        onClick: openWholeFileMon,
      }}
      secondaryActions={secondaryActions}
      spansLabel={`Sector chain (${totalSectors})`}
      spans={spans}
      extraSections={
        sourceArtifactsForFile.length > 0 ? (
          <ArtifactVersionsSection
            candidates={sourceArtifactsForFile}
            versionGroups={snapshot.artifactVersionGroups ?? []}
            projectDir={snapshot.project.rootPath}
            onOpenAsm={onOpenAsm}
            onReload={onReloadWorkspace}
          />
        ) : null
      }
      onClose={onClose}
    />
  );
}

function CartChunkInspector({
  snapshot,
  selection,
  onClose,
  onOpenHex,
  onOpenAsm,
  onRunPayloadWorkflow,
}: {
  snapshot: WorkspaceUiSnapshot;
  selection: { cartridgeArtifactId: string; chunk: CartridgeLutChunk };
  onClose: () => void;
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number> }) => void;
  onOpenAsm: (title: string, sources: AsmViewSource[]) => void;
  onRunPayloadWorkflow: (payloadId: string, mode?: "quick" | "full") => Promise<PrgReverseWorkflowResponse>;
}) {
  const [chunkWorkflowBusy, setChunkWorkflowBusy] = useState(false);
  const lineageVisibility = useLineageVisibility();
  const internalVisibility = useInternalVisibility();
  const cartridge = snapshot.views.cartridgeLayout.cartridges.find((cart) => cart.artifactId === selection.cartridgeArtifactId);
  const chunk = selection.chunk;
  const refs = chunk.refs?.length ? chunk.refs : [{ lut: chunk.lut, index: chunk.index, destAddress: chunk.destAddress }];
  const spans = chunk.spans?.length ? chunk.spans : [{ bank: chunk.bank, offsetInBank: chunk.offsetInBank, length: chunk.length }];
  const manifestArtifact = snapshot.artifacts.find((artifact) => artifact.id === selection.cartridgeArtifactId);
  const manifestDir = manifestArtifact?.relativePath.includes("/") ? manifestArtifact.relativePath.slice(0, manifestArtifact.relativePath.lastIndexOf("/")) : "";
  const slotBaseAddress = chunk.slot === "ROMH" ? (cartridge?.slotLayout?.isUltimax ? 0xe000 : 0xa000) : (chunk.slot === "ULTIMAX_ROMH" ? 0xe000 : 0x8000);

  function chipForSpan(spanBank: number) {
    return cartridge?.chips.find((candidate) => {
      const candidateSlot = candidate.slot ?? "ROML";
      if (chunk.slot === "ROML" && candidateSlot !== "ROML") return false;
      if ((chunk.slot === "ROMH" || chunk.slot === "ULTIMAX_ROMH") && candidateSlot === "ROML") return false;
      return candidate.bank === spanBank;
    });
  }

  function chipPathForSpan(spanBank: number): string | undefined {
    const chip = chipForSpan(spanBank);
    if (!chip?.file) return undefined;
    return manifestDir ? `${manifestDir}/${chip.file}` : chip.file;
  }

  function openMonSpan(span: { bank: number; offsetInBank: number; length: number }, partIndex: number) {
    const chipPath = chipPathForSpan(span.bank);
    if (!chipPath) return;
    onOpenHex(chipPath, {
      title: `${cartridge?.cartridgeName ?? "cartridge"} · ${chunk.lut}.${String(chunk.index).padStart(2, "0")} bank ${span.bank} ${chunk.slot} (part ${partIndex + 1}/${spans.length})`,
      baseAddress: slotBaseAddress + span.offsetInBank,
      offset: span.offsetInBank,
      length: span.length,
    });
  }

  async function openAssembledChunkMon() {
    if (spans.length === 0) return;
    try {
      const buffers: Uint8Array[] = [];
      for (const span of spans) {
        const chipPath = chipPathForSpan(span.bank);
        if (!chipPath) throw new Error(`No chip file for bank ${span.bank}`);
        const params = new URLSearchParams({
          path: chipPath,
          offset: String(span.offsetInBank),
          length: String(span.length),
        });
        if (snapshot.project.rootPath) params.set("projectDir", snapshot.project.rootPath);
        const response = await fetch(`/api/artifact/raw?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status} for bank ${span.bank}`);
        buffers.push(new Uint8Array(await response.arrayBuffer()));
      }
      const total = buffers.reduce((sum, buf) => sum + buf.length, 0);
      const bytes = new Uint8Array(total);
      let cursor = 0;
      for (const buf of buffers) {
        bytes.set(buf, cursor);
        cursor += buf.length;
      }
      const destAddress = chunk.destAddress ?? (slotBaseAddress + chunk.offsetInBank);
      // For Lykia BB2 (and any other packer that needs the dest-page hi
      // byte to seed its bit buffer) the depacker needs destHi as a
      // hint. We always send it when destAddress is known; the server
      // ignores it for unrelated packers.
      const packerContext: Record<string, string | number> = {};
      if (chunk.destAddress !== undefined) {
        packerContext.destHi = (chunk.destAddress >> 8) & 0xff;
        packerContext.destAddress = chunk.destAddress;
        packerContext.endAddress = (chunk.destAddress + chunk.length) & 0xffff;
      }
      onOpenHex(manifestArtifact?.relativePath ?? "cartridge", {
        title: `${cartridge?.cartridgeName ?? "cartridge"} · ${chunk.lut}.${String(chunk.index).padStart(2, "0")} assembled (${bytes.length} B${spans.length > 1 ? `, ${spans.length} spans` : ""})`,
        baseAddress: destAddress,
        bytes,
        packerHint: chunk.packer,
        packerContext: Object.keys(packerContext).length > 0 ? packerContext : undefined,
      });
    } catch (error) {
      onOpenHex("cartridge", {
        title: `${chunk.lut}.${String(chunk.index).padStart(2, "0")} · error`,
        bytes: new TextEncoder().encode(`Failed to assemble chunk: ${error instanceof Error ? error.message : String(error)}`),
      });
    }
  }

  const headlineExtras: FileInspectorHeadlineExtra[] = [
    { key: "len", text: `${chunk.length} bytes` },
    { key: "origin", text: `origin bank ${String(chunk.bank).padStart(2, "0")} ${chunk.slot}` },
    { key: "off", text: `off $${chunk.offsetInBank.toString(16).toUpperCase().padStart(4, "0")}` },
  ];
  if (spans.length > 1) {
    headlineExtras.push({ key: "spans", text: `spans ${spans.length} banks`, className: "chunk-inspector-tag" });
  }

  const metaRows: FileInspectorMetaRow[] = [];
  if (cartridge) {
    metaRows.push({
      key: "cartridge",
      label: "cartridge",
      value: cartridge.cartridgeName ?? cartridge.title,
    });
  }

  // Resolve relation-driven ASM sources. link_cart_chunk_to_asm tags the
  // chunk entity with cart-chunk:<key> and creates a derived-from
  // relation pointing at the asm artifact's entity.
  const chunkKey = `${chunk.bank}:${chunk.slot}:${chunk.offsetInBank}:${chunk.length}`;
  const chunkTag = `cart-chunk:${chunkKey}`;
  const chunkEntity = snapshot.entities.find((entity) => (entity.tags ?? []).includes(chunkTag));
  const linkedAsmArtifactIds = chunkEntity
    ? new Set(
        snapshot.relations
          .filter((relation) => relation.sourceEntityId === chunkEntity.id && relation.kind === "derived-from")
          .flatMap((relation) => {
            const target = snapshot.entities.find((entity) => entity.id === relation.targetEntityId);
            return target?.artifactIds ?? [];
          }),
      )
    : new Set<string>();
  const linkedAsmArtifacts = [...linkedAsmArtifactIds]
    .map((artifactId) => snapshot.artifacts.find((artifact) => artifact.id === artifactId))
    .filter((artifact): artifact is typeof snapshot.artifacts[number] => Boolean(artifact))
    .filter((artifact) => /\.(asm|tass|s|a65)$/i.test(artifact.relativePath));

  // Heuristic fallback: when the agent never ran link_cart_chunk_to_asm,
  // fall back to matching by chip-file stem. e.g. a chunk that lives in
  // bank_13_8000.bin with an asm artifact bank_13_8000.asm next to it
  // gets surfaced even without an explicit relation.
  let cartAsmSources: AsmViewSource[];
  if (linkedAsmArtifacts.length > 0) {
    cartAsmSources = bestAsmSourcesForArtifacts(linkedAsmArtifacts, snapshot.artifactVersionGroups ?? []);
  } else {
    const chipStems = new Set<string>();
    for (const span of spans) {
      const chip = chipForSpan(span.bank);
      if (!chip?.file) continue;
      const stem = chip.file.replace(/\.[^.]+$/, "");
      if (stem) chipStems.add(stem);
    }
    // Bug 24 + Bug 26: filter to latest version per lineage AND drop
    // infrastructure files so older / internal revisions don't get
    // bundled into the inspector.
    const fallbackAsm = internalVisibility.visibleArtifacts(lineageVisibility.latest(snapshot.artifacts)).filter((artifact) => {
      if (!/\.(asm|tass|s|a65)$/i.test(artifact.relativePath)) return false;
      const stem = artifact.relativePath.split("/").pop()!.replace(/\.[^.]+$/, "");
      return chipStems.has(stem);
    });
    cartAsmSources = bestAsmSourcesForArtifacts(fallbackAsm, snapshot.artifactVersionGroups ?? []);
  }

  const fileSpans: FileInspectorSpanRow[] = spans.map((span, partIndex) => {
    const chipPath = chipPathForSpan(span.bank);
    return {
      id: `${span.bank}-${span.offsetInBank}`,
      primary: `Bank ${String(span.bank).padStart(2, "0")} ${chunk.slot}`,
      status: `${span.length} B`,
      subText: `chip off $${span.offsetInBank.toString(16).toUpperCase().padStart(4, "0")} · C64 $${(slotBaseAddress + span.offsetInBank).toString(16).toUpperCase().padStart(4, "0")}`,
      footerLeft: chipPath ?? "(no chip)",
      footerRight: partIndex === 0 ? "head" : `cont ${partIndex + 1}/${spans.length}`,
      monEnabled: Boolean(chipPath),
      monTitle: `Open hex view of this ${span.length}-byte span`,
      onMon: () => openMonSpan(span, partIndex),
    };
  });

  const extraSections = (
    <div className="inspector-block">
      <h4>LUT references ({refs.length})</h4>
      <div className="record-stack compact">
        {refs.map((ref) => (
          <div key={`${ref.lut}-${ref.index}`} className="record-card">
            <div className="record-topline">
              <span>{ref.lut}.{String(ref.index).padStart(2, "0")}</span>
              <span className="record-status">{ref.destAddress !== undefined ? `→ $${ref.destAddress.toString(16).toUpperCase().padStart(4, "0")}` : "—"}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const chunkSecondaryActions: FileInspectorActionButton[] = [];
  if (cartAsmSources.length > 0) {
    chunkSecondaryActions.push({
      label: `.asm${cartAsmSources.length > 1 ? "/.tass" : ""}`,
      title: `Open linked disassembly (${cartAsmSources.map((source) => source.label).join(" / ")})`,
      enabled: true,
      onClick: () => onOpenAsm(`${chunk.lut}.${String(chunk.index).padStart(2, "0")}`, cartAsmSources),
    });
  }
  const chunkPayloadKey = `cart-chunk:${chunk.bank}:${chunk.slot}:${chunk.offsetInBank}:${chunk.length}`;
  const matchingPayload = snapshot.entities.find((entity) =>
    entity.kind === "payload" && (entity.tags ?? []).includes(chunkPayloadKey),
  );
  if (matchingPayload) {
    chunkSecondaryActions.push({
      label: chunkWorkflowBusy ? "running..." : "reverse workflow",
      title: `Run analyze + disasm + reports + view rebuild on payload ${matchingPayload.name}`,
      enabled: !chunkWorkflowBusy,
      onClick: () => {
        setChunkWorkflowBusy(true);
        onRunPayloadWorkflow(matchingPayload.id, "full")
          .then((result) => {
            window.alert(`Workflow ${result.status}.\nImported entities=${result.importedCounts.entities} findings=${result.importedCounts.findings}.\nNext: ${result.nextRequiredAction}`);
          })
          .catch((error) => {
            window.alert(`Workflow failed: ${error instanceof Error ? error.message : String(error)}`);
          })
          .finally(() => setChunkWorkflowBusy(false));
      },
    });
  } else {
    chunkSecondaryActions.push({
      label: "reverse workflow (no payload)",
      title: "Run bulk_create_cart_chunk_payloads or register_payload first to promote this chunk to a payload entity, then re-open this inspector.",
      enabled: false,
      onClick: () => undefined,
    });
  }

  return (
    <FileInspector
      mediumKind="cartridge"
      title={`${chunk.lut}.${String(chunk.index).padStart(2, "0")}`}
      swatchColor={chunk.color}
      packer={chunk.packer}
      format={chunk.format}
      notes={chunk.notes}
      headlineExtras={headlineExtras}
      metaRows={metaRows}
      primaryAction={{
        label: `mon (assembled — ${chunk.length} B${spans.length > 1 ? `, ${spans.length} spans` : ""})`,
        enabled: spans.length > 0,
        onClick: openAssembledChunkMon,
      }}
      secondaryActions={chunkSecondaryActions}
      spansLabel={`Physical placement (${spans.length} ${spans.length === 1 ? "span" : "spans"})`}
      spans={fileSpans}
      extraSections={extraSections}
      onClose={onClose}
    />
  );
}

export function App() {
  // Spec 754/757 — MON pop-out: the same (one) bundle opened with
  // `?monitor=1&sessionId=…` in a separate OS window renders ONLY the monitor
  // bound to that live session. Checked before any hook; the query is constant
  // per window so the branch is stable across renders (hook order preserved).
  {
    const q = new URLSearchParams(window.location.search);
    if (q.get("monitor") === "1") {
      return <MonitorPopout sessionId={q.get("sessionId") ?? ""} />;
    }
  }
  const [snapshot, setSnapshot] = useState<WorkspaceUiSnapshot | null>(null);
  const [discoveredDocs, setDiscoveredDocs] = useState<DiscoveredMarkdownDoc[]>([]);
  const [graphicsItems, setGraphicsItems] = useState<GraphicsItem[]>([]);
  const [selectedGraphicsId, setSelectedGraphicsId] = useState<string | null>(null);
  const [graphicsBytes, setGraphicsBytes] = useState<Uint8Array | null>(null);
  const [graphicsLoading, setGraphicsLoading] = useState(false);
  const [graphicsError, setGraphicsError] = useState<string | null>(null);
  const [charsetPairId, setCharsetPairId] = useState<string | null>(null);
  const [charsetPairBytes, setCharsetPairBytes] = useState<Uint8Array | null>(null);
  const [graphicsMarks, setGraphicsMarks] = useState<Record<string, { status: "rejected" | "confirmed"; note?: string }>>({});
  const [hideRejectedGraphics, setHideRejectedGraphics] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  // Spec 773 — the active lifecycle phase (the phase-strip). Navigation only, not a gate.
  const [activePhase, setActivePhase] = useState<Phase>("discovery");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const phaseAutoInit = useRef(false);
  // Spec 724B — Live runtime tab session state.
  const [liveSessionId, setLiveSessionId] = useState<string>("");
  const [liveRunState, setLiveRunState] = useState<"running" | "paused" | "off">("running");
  // Mirror in a ref so async backend broadcasts can see the live value without a
  // stale closure: a real OFF (machine unplugged, UI-only state) must NOT be
  // clobbered into "paused" by the debug/paused that power-off's own debug/pause
  // produces. OFF is exited only by the Power button.
  const liveRunStateRef = useRef(liveRunState);
  liveRunStateRef.current = liveRunState;
  const [liveConn, setLiveConn] = useState<"connecting" | "open" | "closed" | "error">("closed");
  const [liveCycle, setLiveCycle] = useState<number>(0);
  // BUG-018 — surface the runtime connection + session in the always-visible
  // product header (human/LLM coordination). The product IS a runtime workbench,
  // so connect on mount (not only on the Live tab) and keep the conn/session/
  // cycle state current; the header chip below renders it.
  useEffect(() => {
    return getClient().onState(setLiveConn);
  }, []);
  // Pick the running session once the socket is open, re-running when it flips to
  // open (mirrors the v3 shell). Firing before open rejects with no conn dep.
  useEffect(() => {
    if (liveSessionId || liveConn !== "open") return;
    let alive = true;
    getClient().call<Array<{ sessionId: string }>>("session/list").then((sessions) => {
      if (alive && sessions.length > 0) setLiveSessionId(sessions[0].sessionId);
    }).catch(() => { /* runtime backend may be down; header shows the conn state */ });
    return () => { alive = false; };
  }, [liveConn, liveSessionId]);
  // Poll the cycle counter while connected to a session (lightweight; matches the
  // v3 header). No frame subscription here — frames stay a Live-tab concern.
  useEffect(() => {
    if (liveConn !== "open" || !liveSessionId) return;
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const s = await getClient().call<{ c64Cycles?: number; runState?: "running" | "paused" }>("session/state", { session_id: liveSessionId });
        if (alive) {
          setLiveCycle(s.c64Cycles ?? 0);
          // Mirror the DAEMON run-state so the Run/Pause button is correct on
          // connect/reload (broadcasts only fire on a transition, so a session
          // already running/paused at connect would otherwise show the default).
          // Pure backend→UI mirror — never a command (no echo loop). OFF is
          // UI-only and must not be overwritten by the live machine's state.
          if (s.runState && liveRunStateRef.current !== "off") setLiveRunState(s.runState);
        }
      } catch { /* ignore */ }
      if (alive) setTimeout(tick, 1000);
    };
    tick();
    return () => { alive = false; };
  }, [liveConn, liveSessionId]);
  // Spec 754 — the RUN/Pause button (MachineControls, always visible) must reflect
  // the DAEMON run-state no matter WHO drove it: the toolbar, an MCP client, or the
  // monitor `g`/Pause from the MON pop-out (a separate OS window). Previously the
  // only daemon→button sync lived in the Live tab, so a `g` in the pop-out ran the
  // machine server-side but the main-window button stayed on "Run" until you
  // clicked it. These listeners live at App level (always mounted) so `g` flips the
  // button with no second RUN click, on any tab.
  useEffect(() => {
    if (liveConn !== "open" || !liveSessionId) return;
    const c = getClient();
    const mine = (p: any) => !p?.session_id || p.session_id === liveSessionId;
    // OFF stays OFF (UI-only "unplugged" state): a paused-class broadcast must not
    // flip it to "paused" (power-off itself sends debug/pause → debug/paused).
    const offGuard = () => liveRunStateRef.current === "off";
    const offRun = c.onNotification("debug/running", (p: any) => { if (mine(p) && !offGuard()) setLiveRunState("running"); });
    const offStop = c.onNotification("debug/stopped", (p: any) => { if (mine(p) && !offGuard()) setLiveRunState("paused"); });
    const offPause = c.onNotification("debug/paused", (p: any) => { if (mine(p) && !offGuard()) setLiveRunState("paused"); });
    const offBp = c.onNotification("debug/breakpoint_hit", (p: any) => { if (mine(p) && !offGuard()) setLiveRunState("paused"); });
    const offObs = c.onNotification("debug/observer_hit", (p: any) => { if (mine(p) && !offGuard()) setLiveRunState("paused"); });
    return () => { offRun(); offStop(); offPause(); offBp(); offObs(); };
  }, [liveConn, liveSessionId]);
  const [listingQuery, setListingQuery] = useState("");
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [tabSelections, setTabSelections] = useState<Partial<Record<TabId, string>>>({});
  const [selectedDocPath, setSelectedDocPath] = useState<string | null>(null);
  const [docContent, setDocContent] = useState("");
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [hexOverlay, setHexOverlay] = useState<{ path: string; title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number>; markers?: Array<{ offset: number; label: string }> } | null>(null);
  const [asmOverlay, setAsmOverlay] = useState<{ title: string; sources: AsmViewSource[] } | null>(null);
  const [todoComposer, setTodoComposer] = useState<TodoComposerState | null>(null);
  const [todoSaving, setTodoSaving] = useState(false);
  const [todoError, setTodoError] = useState<string | null>(null);
  // Bug 24: default = list latest version per lineage. Toggle exposes
  // V0..V(n-1) for debugging.
  const [showAllVersions, setShowAllVersions] = useState<boolean>(false);
  // Bug 26 / Spec 058: default hide infrastructure files. Toggle for debug.
  const [showInternal, setShowInternal] = useState<boolean>(false);
  const visibleArtifacts = useMemo(
    () => (snapshot ? (showAllVersions ? snapshot.artifacts : latestArtifactsByLineage(snapshot.artifacts)) : []),
    [snapshot, showAllVersions],
  );

  function openAsmOverlay(title: string, sources: AsmViewSource[]) {
    if (sources.length === 0) return;
    setAsmOverlay({ title, sources });
  }
  const [selectedCartChunk, setSelectedCartChunk] = useState<CartChunkSelection | null>(null);
  const [selectedDiskFile, setSelectedDiskFile] = useState<DiskFileSelection | null>(null);
  // Spec 770 — the Payloads tab now drives a file-centric FileInspector
  // (mediumKind="payload"), like Disk/Cartridge. Clicking a payload card sets
  // this; the right aside renders PayloadFileInspector for it.
  const [selectedPayloadId, setSelectedPayloadId] = useState<string | null>(null);

  function openHexOverlay(path: string, options?: { title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number>; markers?: Array<{ offset: number; label: string }> }) {
    setHexOverlay({
      path,
      title: options?.title,
      baseAddress: options?.baseAddress,
      offset: options?.offset,
      length: options?.length,
      fetchUrl: options?.fetchUrl,
      bytes: options?.bytes,
      packerHint: options?.packerHint,
      packerContext: options?.packerContext,
      markers: options?.markers,
    });
  }

  useEffect(() => {
    void (async () => {
      try {
        const loadedConfig = await fetchJson<UiConfig>("/api/config");
        await loadWorkspace(loadedConfig.defaultProjectDir);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setLoading(false);
      }
    })();
  }, []);

  async function loadWorkspace(nextProjectDir: string) {
    setLoading(true);
    setError(null);
    try {
      const encoded = encodeURIComponent(nextProjectDir);
      const [nextSnapshot, docsResponse, graphicsResponse] = await Promise.all([
        fetchJson<WorkspaceUiSnapshot>(`/api/workspace?projectDir=${encoded}`),
        fetchJson<DocsApiResponse>(`/api/docs?projectDir=${encoded}`).catch(() => ({ projectDir: nextProjectDir, docs: [] as DiscoveredMarkdownDoc[] })),
        fetchJson<GraphicsApiResponse>(`/api/graphics?projectDir=${encoded}`).catch(() => ({ projectDir: nextProjectDir, items: [] as GraphicsItem[], warnings: [] as string[] })),
      ]);
      setSnapshot(nextSnapshot);
      setDiscoveredDocs(docsResponse.docs);
      setGraphicsItems(graphicsResponse.items);
      // Bug 23 (Stage 2): graphicsMarks is now derived from the items
      // themselves (which carry confirmed/rejected from the analysis JSON).
      // Single source of truth — no separate /api/graphics-marks fetch.
      setGraphicsMarks(deriveGraphicsMarks(graphicsResponse.items));
      setSelectedGraphicsId(graphicsResponse.items[0]?.id ?? null);
      setSelectedEntityId(null);
      setSelectedQuestionId(null);
      setTabSelections({});
      // Bug 24: latest version per lineage in the docs list. The "show
      // all versions" toggle re-runs this via the useMemo path below.
      const nextDocs = buildDocs(latestArtifactsByLineage(nextSnapshot.artifacts), docsResponse.docs);
      setSelectedDocPath(nextDocs[0]?.relativePath ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function setGraphicsMark(itemId: string, status: "rejected" | "confirmed" | "clear") {
    if (!snapshot) return;
    const item = graphicsItems.find((g) => g.id === itemId);
    if (!item) return;
    try {
      // Bug 23 (Stage 2): single write path. Both UI clicks and agent
      // MCP calls land in the same store (the *_analysis.json segment
      // flags), so the counter and buckets always agree.
      const endpoint = status === "confirmed"
        ? "/api/segment/confirm"
        : status === "rejected"
          ? "/api/segment/reject"
          : "/api/segment/clear";
      const body: Record<string, unknown> = {
        projectDir: snapshot.project.rootPath,
        artifactId: item.prgArtifactId,
        address: item.start,
        length: item.length,
        kind: item.kind,
      };
      if (status === "rejected") body.reason = "User marked wrong via Graphics tab.";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Refetch the graphics view so item.confirmed/rejected reflect the
      // change. Cheap — the endpoint is a single file read per analysis JSON.
      const encoded = encodeURIComponent(snapshot.project.rootPath);
      const refreshed = await fetchJson<GraphicsApiResponse>(`/api/graphics?projectDir=${encoded}`).catch(() => null);
      if (refreshed) {
        setGraphicsItems(refreshed.items);
        setGraphicsMarks(deriveGraphicsMarks(refreshed.items));
      } else {
        // Fall back to optimistic local update if the refetch failed.
        setGraphicsItems(graphicsItems.map((g) => g.id !== itemId ? g : ({
          ...g,
          confirmed: status === "confirmed" ? true : undefined,
          rejected: status === "rejected" ? true : undefined,
          rejectedReason: status === "rejected" ? (body.reason as string) : undefined,
        })));
        setGraphicsMarks((prev) => {
          const next = { ...prev };
          if (status === "clear") delete next[itemId];
          else next[itemId] = { status, note: status === "rejected" ? (body.reason as string) : undefined };
          return next;
        });
      }
    } catch (markError) {
      console.error("graphics mark failed", markError);
    }
  }

  function createTaskFromUi(defaults: { title: string; description?: string; entityIds?: string[]; artifactIds?: string[] }) {
    setTodoError(null);
    setTodoComposer({
      mode: "task",
      title: defaults.title,
      description: defaults.description ?? "",
      entityIds: defaults.entityIds ?? [],
      artifactIds: defaults.artifactIds ?? [],
    });
  }

  function createQuestionFromUi(defaults: { title: string; description?: string; entityIds?: string[]; artifactIds?: string[] }) {
    setTodoError(null);
    setTodoComposer({
      mode: "question",
      title: defaults.title,
      description: defaults.description ?? "",
      entityIds: defaults.entityIds ?? [],
      artifactIds: defaults.artifactIds ?? [],
    });
  }

  async function updateQuestionStatus(
    questionId: string,
    status: "answered" | "invalidated" | "deferred" | "open",
    answerSummary?: string,
  ) {
    if (!snapshot) return;
    await postJson("/api/open-question", {
      projectDir: snapshot.project.rootPath,
      id: questionId,
      status,
      answerSummary,
    });
    await loadWorkspace(snapshot.project.rootPath);
    if (status !== "open") {
      setSelectedQuestionId(null);
    }
  }

  async function runPrgWorkflowFromInspector(prgPath: string, mode: "quick" | "full" = "full"): Promise<PrgReverseWorkflowResponse> {
    if (!snapshot) throw new Error("No workspace loaded");
    const result = await postJson<PrgReverseWorkflowResponse>("/api/run-prg-workflow", {
      projectDir: snapshot.project.rootPath,
      prgPath,
      mode,
    });
    await loadWorkspace(snapshot.project.rootPath);
    return result;
  }

  async function runPayloadWorkflowFromInspector(payloadId: string, mode: "quick" | "full" = "full"): Promise<PrgReverseWorkflowResponse> {
    if (!snapshot) throw new Error("No workspace loaded");
    const result = await postJson<PrgReverseWorkflowResponse>("/api/run-payload-workflow", {
      projectDir: snapshot.project.rootPath,
      payloadId,
      mode,
    });
    await loadWorkspace(snapshot.project.rootPath);
    return result;
  }

  async function saveTodoComposer() {
    if (!snapshot || !todoComposer || !todoComposer.title.trim()) return;
    setTodoSaving(true);
    setTodoError(null);
    try {
      if (todoComposer.mode === "task") {
        await postJson("/api/task", {
          projectDir: snapshot.project.rootPath,
          title: todoComposer.title.trim(),
          description: todoComposer.description.trim() || undefined,
          kind: "llm-followup",
          priority: "medium",
          entityIds: todoComposer.entityIds,
          artifactIds: todoComposer.artifactIds,
        });
      } else {
        await postJson("/api/open-question", {
          projectDir: snapshot.project.rootPath,
          title: todoComposer.title.trim(),
          description: todoComposer.description.trim() || undefined,
          kind: "llm-question",
          priority: "medium",
          entityIds: todoComposer.entityIds,
          artifactIds: todoComposer.artifactIds,
        });
      }
      setTodoComposer(null);
      await loadWorkspace(snapshot.project.rootPath);
    } catch (saveError) {
      setTodoError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setTodoSaving(false);
    }
  }

  useEffect(() => {
    if (!snapshot || !charsetPairId) {
      setCharsetPairBytes(null);
      return;
    }
    const charsetItem = graphicsItems.find((entry) => entry.id === charsetPairId);
    if (!charsetItem) {
      setCharsetPairBytes(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const params = new URLSearchParams({
          projectDir: snapshot.project.rootPath,
          path: charsetItem.prgRelativePath,
          offset: String(charsetItem.fileOffset),
          length: String(charsetItem.length),
        });
        const response = await fetch(`/api/artifact/raw?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (!cancelled) setCharsetPairBytes(new Uint8Array(buffer));
      } catch {
        if (!cancelled) setCharsetPairBytes(null);
      }
    })();
    return () => { cancelled = true; };
  }, [snapshot, charsetPairId, graphicsItems]);

  useEffect(() => {
    if (!snapshot || !selectedGraphicsId) {
      setGraphicsBytes(null);
      setGraphicsError(null);
      return;
    }
    const item = graphicsItems.find((entry) => entry.id === selectedGraphicsId);
    if (!item) {
      setGraphicsBytes(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setGraphicsLoading(true);
      setGraphicsError(null);
      try {
        const params = new URLSearchParams({
          projectDir: snapshot.project.rootPath,
          path: item.prgRelativePath,
          offset: String(item.fileOffset),
          length: String(item.length),
        });
        const response = await fetch(`/api/artifact/raw?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (!cancelled) setGraphicsBytes(new Uint8Array(buffer));
      } catch (loadError) {
        if (!cancelled) {
          setGraphicsError(loadError instanceof Error ? loadError.message : String(loadError));
          setGraphicsBytes(null);
        }
      } finally {
        if (!cancelled) setGraphicsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [snapshot, selectedGraphicsId, graphicsItems]);

  useEffect(() => {
    if (!snapshot || !selectedDocPath) {
      setDocContent("");
      setDocError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setDocLoading(true);
      setDocError(null);
      try {
        const encodedProject = encodeURIComponent(snapshot.project.rootPath);
        const encodedPath = encodeURIComponent(selectedDocPath);
        const nextContent = await fetchText(`/api/document?projectDir=${encodedProject}&path=${encodedPath}`);
        if (!cancelled) {
          setDocContent(nextContent);
        }
      } catch (loadError) {
        if (!cancelled) {
          setDocError(loadError instanceof Error ? loadError.message : String(loadError));
          setDocContent("");
        }
      } finally {
        if (!cancelled) {
          setDocLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot, selectedDocPath]);

  const selectedEntity = snapshot?.entities.find((entity) => entity.id === selectedEntityId);
  const selectedQuestion = snapshot?.openQuestions.find((question) => question.id === selectedQuestionId);
  const selectedPayload = snapshot?.entities.find((entity) => entity.id === selectedPayloadId);
  // Bug 24 + Bug 26: filter to latest version per lineage AND drop
  // infrastructure files (manifests, FACTS reports etc.). Toggles override.
  const docs = useMemo(() => {
    if (!snapshot) return [];
    let list: ArtifactRecord[] = showAllVersions ? snapshot.artifacts : latestArtifactsByLineage(snapshot.artifacts);
    if (!showInternal) list = list.filter((a) => !isInternalArtifact(a));
    return buildDocs(list, discoveredDocs);
  }, [snapshot, discoveredDocs, showAllVersions, showInternal]);
  const visibleTabs = snapshot
    ? allTabs.filter((tab) => {
        // Spec 773 — only show a tab if it is a tool of the active lifecycle phase.
        if (!tab.phases.includes(activePhase)) return false;
        if (tab.id === "dashboard") return true;
        if (tab.id === "questions") return snapshot.openQuestions.length > 0;
        if (tab.id === "docs") return docs.length > 0;
        if (tab.id === "memory") return snapshot.views.memoryMap.cells.length > 0;
        if (tab.id === "graphics") return graphicsItems.length > 0;
        if (tab.id === "scrub") return snapshot.artifacts.some((artifact) => artifact.kind === "prg" || artifact.kind === "crt" || artifact.kind === "raw");
        if (tab.id === "cartridge") return snapshot.views.cartridgeLayout.cartridges.length > 0;
        if (tab.id === "disk") return snapshot.views.diskLayout.disks.length > 0;
        // Spec 059 / UX1: Flow Graph tab covers both flow-graph nodes
        // and the folded-in load sequence items.
        if (tab.id === "flow") return snapshot.views.flowGraph.nodes.length > 0
          || snapshot.views.loadSequence.items.length > 0;
        if (tab.id === "listing") return snapshot.views.annotatedListing.entries.length > 0;
        return true;
      })
    : allTabs;

  useEffect(() => {
    if (!visibleTabs.some((tab) => tab.id === activeTab)) {
      setActiveTab(visibleTabs[0]?.id ?? "dashboard");
    }
  }, [activeTab, visibleTabs]);

  // Spec 773 — on first project load, land on the recommended lifecycle phase
  // (derived from workflow state). One-shot: never override the user's navigation.
  useEffect(() => {
    if (!snapshot || phaseAutoInit.current) return;
    phaseAutoInit.current = true;
    if (snapshot.lifecyclePhase) handlePhaseChange(snapshot.lifecyclePhase as Phase);
  }, [snapshot]);

  function handleSelectEntity(entityId: string, tabId: TabId = activeTab) {
    setSelectedEntityId(entityId);
    setSelectedQuestionId(null);
    setTabSelections((current) => ({ ...current, [tabId]: entityId }));
    setSelectedCartChunk(null);
    setSelectedDiskFile(null);
    setSelectedPayloadId(null);
  }

  // Spec 770 — pick a payload blob (file-centric inspector). Mirrors the disk/
  // cart selectors: it owns the right aside, so clear the competing selections.
  function handleSelectPayload(payloadId: string) {
    setSelectedPayloadId(payloadId);
    setSelectedCartChunk(null);
    setSelectedDiskFile(null);
    setSelectedQuestionId(null);
  }

  function handleSelectQuestion(questionId: string) {
    if (!snapshot) return;
    const question = snapshot.openQuestions.find((candidate) => candidate.id === questionId);
    if (!question) return;
    const linkedFindingEntityId = question.findingIds
      .map((findingId) => snapshot.findings.find((finding) => finding.id === findingId)?.entityIds[0])
      .find((entityId): entityId is string => entityId !== undefined);
    const nextEntityId = question.entityIds[0] ?? linkedFindingEntityId ?? null;
    setSelectedQuestionId(questionId);
    setSelectedEntityId(nextEntityId);
    if (nextEntityId) setTabSelections((current) => ({ ...current, dashboard: nextEntityId }));
    setSelectedCartChunk(null);
    setSelectedDiskFile(null);
    setSelectedPayloadId(null);
  }

  function currentFocusEntityId(): string | null {
    if (!snapshot) return selectedEntityId;
    return selectedEntityId ?? diskSelectionEntityId(snapshot, selectedDiskFile);
  }

  // Spec 773 — switching lifecycle phase. Onboarding/Build/Release land on their
  // phase-home "Overview"; the tool-rich phases keep the current tab when it's valid,
  // else fall back to the Dashboard overview.
  function handlePhaseChange(nextPhase: Phase) {
    setActivePhase(nextPhase);
    if (nextPhase === "onboarding" || nextPhase === "build" || nextPhase === "release") {
      setActiveTab("home");
      return;
    }
    const current = allTabs.find((tab) => tab.id === activeTab);
    if (!current || !current.phases.includes(nextPhase)) setActiveTab("dashboard");
  }

  // Spec 773 Loop 4 — the one controlled write: persist the captured goal through the
  // existing project-profile contract, then reload the snapshot so the cockpit reflects it.
  async function handleSaveGoal(patch: Record<string, unknown>) {
    if (!snapshot) return;
    await postJson("/api/project/profile", { projectDir: snapshot.project.rootPath, ...patch });
    await loadWorkspace(snapshot.project.rootPath);
  }

  function handleOpenTab(nextTab: TabId) {
    // Spec 770 — payload selection is scoped to the Payloads tab; drop it on leave.
    if (nextTab !== "payloads") setSelectedPayloadId(null);
    if (!snapshot) {
      setActiveTab(nextTab);
      return;
    }

    const preferredEntityId = currentFocusEntityId();
    const rememberedEntityId = tabSelections[nextTab];
    const nextEntityId =
      preferredEntityId && tabHasEntity(snapshot, preferredEntityId, nextTab)
        ? preferredEntityId
        : rememberedEntityId && tabHasEntity(snapshot, rememberedEntityId, nextTab)
          ? rememberedEntityId
          : firstEntityForTab(snapshot, nextTab);

    if (nextTab === "disk") {
      const nextDiskSelection =
        nextEntityId ? diskFileSelectionForEntity(snapshot, nextEntityId) : selectedDiskFile
          ?? firstDiskFileSelection(snapshot);
      setSelectedDiskFile(nextDiskSelection);
      setSelectedCartChunk(null);
      setSelectedQuestionId(null);
      setSelectedEntityId(nextEntityId ?? diskSelectionEntityId(snapshot, nextDiskSelection));
      if (nextEntityId) setTabSelections((current) => ({ ...current, disk: nextEntityId }));
    } else {
      setSelectedDiskFile(null);
      if (nextTab !== "cartridge") setSelectedCartChunk(null);
      if (nextTab !== "dashboard") setSelectedQuestionId(null);
      setSelectedEntityId(nextEntityId);
      if (nextEntityId) setTabSelections((current) => ({ ...current, [nextTab]: nextEntityId }));
    }

    setActiveTab(nextTab);
  }

  const lineageVisibilityValue = useMemo(
    () => ({
      showAllVersions,
      latest: <T extends ArtifactRecord>(items: T[]): T[] =>
        showAllVersions ? items : latestArtifactsByLineage(items),
    }),
    [showAllVersions],
  );

  const internalVisibilityValue = useMemo(
    () => ({
      showInternal,
      visibleArtifacts: <T extends ArtifactRecord>(items: T[]): T[] =>
        showInternal ? items : items.filter((a) => !isInternalArtifact(a)),
      visibleEntities: <T extends EntityRecord>(items: T[], artifactsById: Map<string, ArtifactRecord>): T[] =>
        showInternal ? items : items.filter((e) => !isInternalEntity(e, artifactsById)),
    }),
    [showInternal],
  );

  return (
    <InternalVisibilityContext.Provider value={internalVisibilityValue}>
    <LineageVisibilityContext.Provider value={lineageVisibilityValue}>
    <div className={activeTab === "live" ? "app-root live-mode" : "app-root"}>
      <div className={`app-shell${railCollapsed ? " rail-collapsed" : ""}`}>
        {/* Spec 773 — phases as a LEFT vertical rail (collapsible), so the phase axis is
            spatially distinct from the tool row (fixes the "two horizontal button bands"
            confusion). VS-Code activity-bar pattern; the tool-strip stays at the top of
            the content column. */}
        <nav className="phase-rail" aria-label="Project lifecycle">
          <button
            type="button"
            className="rail-collapse"
            onClick={() => setRailCollapsed((value) => !value)}
            aria-label={railCollapsed ? "Expand phases" : "Collapse phases"}
            title={railCollapsed ? "Expand phases" : "Collapse phases"}
          >
            {railCollapsed ? "»" : "«"}
          </button>
          {PHASE_ORDER.map((phase, idx) => {
            const isActive = phase === activePhase;
            const isRecommended = snapshot?.lifecyclePhase === phase;
            return (
              <button
                key={phase}
                type="button"
                className={isActive ? "rail-phase active" : "rail-phase"}
                aria-current={isActive ? "step" : undefined}
                onClick={() => handlePhaseChange(phase)}
                title={`${idx + 1}. ${PHASE_LABELS[phase]}${isRecommended ? " — recommended by workflow state" : ""}`}
              >
                <span className="rail-badge">
                  {idx + 1}
                  {isRecommended ? <span className="rail-reco" aria-label="recommended">●</span> : null}
                </span>
                <span className="rail-label">{PHASE_RAIL_LABELS[phase]}</span>
              </button>
            );
          })}
        </nav>
        <div className="app-column">
          <header className="hero-shell hero-compact">
            <div className="hero-ident">
              <span className="hero-name">{snapshot?.project.name ?? "Project"}</span>
              <span className="hero-brand">C64RE · by DKL/TREX</span>
            </div>
          </header>

      {error ? <div className="error-banner">{error}</div> : null}

      {!snapshot ? (
        <main className="loading-shell">
          <div className="panel-card empty-state">{loading ? "Loading workspace snapshot..." : "No snapshot loaded."}</div>
        </main>
      ) : (
        <main className={activeTab === "docs" || activeTab === "live" ? "app-main-grid docs-mode" : "app-main-grid"}>
          <nav className="tab-strip" aria-label="Workspace views">
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={activeTab === tab.id ? "tab-button active" : "tab-button"}
                onClick={() => handleOpenTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
            {/* Spec 773 — the visibility filters moved out of the (removed) fat header
                into a small unobtrusive control at the right end of the tool row. */}
            <div className="tab-strip-controls">
              <label className="tab-toggle" title="Show V0..V(n-1) per lineage (default: latest only)">
                <input type="checkbox" checked={showAllVersions} onChange={(event) => setShowAllVersions(event.target.checked)} />
                all versions
              </label>
              <label className="tab-toggle" title="Show manifests / analysis JSON / internal files (default: hidden)">
                <input type="checkbox" checked={showInternal} onChange={(event) => setShowInternal(event.target.checked)} />
                internal
              </label>
            </div>
          </nav>

          <section className="workspace-main">
            {activeTab === "home" ? (
              <PhaseHomePanel
                phase={activePhase}
                snapshot={snapshot}
                onNavigate={(nextPhase, nextTab) => {
                  setActivePhase(nextPhase);
                  handleOpenTab(nextTab);
                }}
                onSaveGoal={handleSaveGoal}
                onRefresh={async () => { await loadWorkspace(snapshot.project.rootPath); }}
              />
            ) : null}
            {activeTab === "live" ? (
              <LiveTab
                sessionId={liveSessionId}
                setSessionId={setLiveSessionId}
                runState={liveRunState}
                setRunState={setLiveRunState}
                statusSlot={
                  // BUG-018 — runtime conn/session status, in the Live controls
                  // bar (next to Audio) per user request, not the global header.
                  <span className="runtime-status-bar rt-inline" role="status" aria-label="Runtime status">
                    <span className={`rt-conn rt-conn-${liveConn}`} title="Runtime WS connection">
                      <span className="rt-dot" />{liveConn}
                    </span>
                    <span className="rt-field">session: <strong>{liveSessionId || "(none)"}</strong></span>
                    <span className="rt-field">cycle: {liveCycle.toLocaleString()}</span>
                  </span>
                }
              />
            ) : null}
            {activeTab === "dashboard" ? (
              <DashboardPanel
                snapshot={snapshot}
                onSelectEntity={(entityId) => handleSelectEntity(entityId, "dashboard")}
                onSelectQuestion={handleSelectQuestion}
                onOpenDocument={(path) => {
                  setSelectedDocPath(path);
                  handleOpenTab("docs");
                }}
                onReloadWorkspace={() => loadWorkspace(snapshot.project.rootPath)}
              />
            ) : null}

            {activeTab === "questions" ? (
              <QuestionsPanel
                snapshot={snapshot}
                onSelectQuestion={handleSelectQuestion}
                onReloadWorkspace={() => loadWorkspace(snapshot.project.rootPath)}
              />
            ) : null}

            {/* Spec 059 / UX1: findings/entities/flows/relations panels
                removed from tab strip. Knowledge surfaces now live
                inside the Inspector pane on every view. Raw access:
                list_findings/list_entities/list_relations/list_flows
                MCP tools or knowledge/*.json on disk. */}

            {activeTab === "docs" ? (
              <DocsPanel
                docs={docs}
                selectedPath={selectedDocPath}
                onSelectPath={setSelectedDocPath}
                content={docContent}
                loading={docLoading}
                error={docError}
              />
            ) : null}
            {activeTab === "memory" ? <MemoryMapPanel snapshot={snapshot} selectedEntityId={selectedEntityId} onSelectEntity={(entityId) => handleSelectEntity(entityId, "memory")} /> : null}
            {activeTab === "scrub" ? (
              <ScrubPanel
                artifacts={snapshot.artifacts}
                projectRoot={snapshot.project.rootPath}
                onOpenHex={openHexOverlay}
                onOpenAsm={openAsmOverlay}
              />
            ) : null}
            {activeTab === "graphics" ? (
              <GraphicsPanel
                items={graphicsItems}
                selectedId={selectedGraphicsId}
                onSelect={setSelectedGraphicsId}
                bytes={graphicsBytes}
                loading={graphicsLoading}
                error={graphicsError}
                charsetPairId={charsetPairId}
                onSelectCharsetPair={setCharsetPairId}
                charsetBytes={charsetPairBytes}
                marks={graphicsMarks}
                onMark={setGraphicsMark}
                hideRejected={hideRejectedGraphics}
                onToggleHideRejected={setHideRejectedGraphics}
              />
            ) : null}
            {activeTab === "cartridge" ? (
              <CartridgePanel
                snapshot={snapshot}
                onSelectEntity={(entityId) => handleSelectEntity(entityId, "cartridge")}
                onSelectChunk={(cartridgeArtifactId, chunk) => {
                  setSelectedCartChunk({ cartridgeArtifactId, chunk });
                  setSelectedEntityId(null);
                  setSelectedQuestionId(null);
                }}
                onOpenHex={openHexOverlay}
              />
            ) : null}
            {activeTab === "disk" ? (
              <DiskPanel
                snapshot={snapshot}
                selectedDiskFile={selectedDiskFile}
                onSelectEntity={(entityId) => handleSelectEntity(entityId, "disk")}
                onSelectDiskFile={(diskArtifactId, fileId) => {
                  const disk = snapshot.views.diskLayout.disks.find((candidate) => candidate.artifactId === diskArtifactId);
                  const file = disk?.files.find((candidate) => candidate.id === fileId);
                  setSelectedDiskFile({ diskArtifactId, fileId });
                  setSelectedEntityId(file?.entityId ?? null);
                  setSelectedQuestionId(null);
                  if (file?.entityId) setTabSelections((current) => ({ ...current, disk: file.entityId! }));
                  setSelectedCartChunk(null);
                }}
                onOpenHex={openHexOverlay}
              />
            ) : null}
            {activeTab === "payloads" ? (
              <PayloadsPanel
                snapshot={snapshot}
                onOpenHex={openHexOverlay}
                onOpenAsm={openAsmOverlay}
                onRunPayloadWorkflow={runPayloadWorkflowFromInspector}
                onReloadWorkspace={() => loadWorkspace(snapshot.project.rootPath)}
                selectedPayloadId={selectedPayloadId}
                onSelectPayload={handleSelectPayload}
              />
            ) : null}
            {/* Spec 059 / UX1: standalone Load Sequence tab folded
                into Flow Graph as the "Load" sub-mode below. */}
            {activeTab === "flow" ? (
              <FlowPanelWithLoadMode
                flowGraph={snapshot.views.flowGraph}
                entities={snapshot.entities}
                relations={snapshot.relations}
                selectedEntityId={selectedEntityId}
                onSelectEntity={(entityId) => handleSelectEntity(entityId, "flow")}
                loadView={snapshot.views.loadSequence}
                snapshot={snapshot}
              />
            ) : null}
            {activeTab === "listing" ? (
              <>
                <ListingPanel
                  snapshot={snapshot}
                  query={listingQuery}
                  setQuery={setListingQuery}
                  selectedEntityId={selectedEntityId}
                  onSelectEntity={(entityId) => handleSelectEntity(entityId, "listing")}
                />
                <AnnotationDraftPanel projectDir={snapshot.project.rootPath} />
              </>
            ) : null}
            {/* Spec 059 / UX1: standalone Activity tab removed; the
                widget folds into the Dashboard. */}
          </section>

          {activeTab !== "docs" && activeTab !== "live" ? (
            <aside className="workspace-side">
              {selectedCartChunk ? (
                <CartChunkInspector
                  snapshot={snapshot}
                  selection={selectedCartChunk}
                  onClose={() => setSelectedCartChunk(null)}
                  onOpenHex={openHexOverlay}
                  onOpenAsm={openAsmOverlay}
                  onRunPayloadWorkflow={runPayloadWorkflowFromInspector}
                />
              ) : selectedDiskFile ? (
                <DiskFileInspector
                  snapshot={snapshot}
                  selection={selectedDiskFile}
                  onClose={() => setSelectedDiskFile(null)}
                  onOpenHex={openHexOverlay}
                  onOpenAsm={openAsmOverlay}
                  onOpenTab={handleOpenTab}
                  onSelectEntity={(entityId) => handleSelectEntity(entityId)}
                  onCreateTask={createTaskFromUi}
                  onCreateQuestion={createQuestionFromUi}
                  onRunPrgWorkflow={runPrgWorkflowFromInspector}
                  onRunPayloadWorkflow={runPayloadWorkflowFromInspector}
                  onReloadWorkspace={() => loadWorkspace(snapshot.project.rootPath)}
                />
              ) : (activeTab === "payloads" && selectedPayload) ? (
                <PayloadFileInspector
                  snapshot={snapshot}
                  payload={selectedPayload}
                  onClose={() => setSelectedPayloadId(null)}
                  onOpenHex={openHexOverlay}
                  onOpenAsm={openAsmOverlay}
                  onRunPayloadWorkflow={runPayloadWorkflowFromInspector}
                  onCreateTask={createTaskFromUi}
                  onCreateQuestion={createQuestionFromUi}
                  onReloadWorkspace={() => loadWorkspace(snapshot.project.rootPath)}
                />
              ) : selectedQuestion ? (
                <QuestionInspector
                  snapshot={snapshot}
                  question={selectedQuestion}
                  onClose={() => setSelectedQuestionId(null)}
                  onSelectEntity={handleSelectEntity}
                  onOpenDocument={(path) => {
                    setSelectedDocPath(path);
                    handleOpenTab("docs");
                  }}
                  onOpenHex={openHexOverlay}
                  onCreateTask={createTaskFromUi}
                  onUpdateStatus={updateQuestionStatus}
                />
              ) : (
                <EntityInspector
                  snapshot={snapshot}
                  entity={selectedEntity}
                  onSelectEntity={handleSelectEntity}
                  onOpenDocument={(path) => {
                    setSelectedDocPath(path);
                    handleOpenTab("docs");
                  }}
                  onOpenTab={handleOpenTab}
                  onOpenHex={openHexOverlay}
                  onCreateTask={createTaskFromUi}
                  onCreateQuestion={createQuestionFromUi}
                />
              )}
            </aside>
          ) : null}
        </main>
      )}
        </div>{/* app-column */}
      </div>{/* app-shell */}
      {hexOverlay ? (
        <HexView
          path={hexOverlay.path}
          projectDir={snapshot?.project.rootPath}
          title={hexOverlay.title}
          baseAddress={hexOverlay.baseAddress}
          offset={hexOverlay.offset}
          length={hexOverlay.length}
          fetchUrl={hexOverlay.fetchUrl}
          bytes={hexOverlay.bytes}
          packerHint={hexOverlay.packerHint}
          packerContext={hexOverlay.packerContext}
          markers={hexOverlay.markers}
          onClose={() => setHexOverlay(null)}
        />
      ) : null}
      {asmOverlay ? (
        <AsmView
          title={asmOverlay.title}
          projectDir={snapshot?.project.rootPath}
          sources={asmOverlay.sources}
          onClose={() => setAsmOverlay(null)}
        />
      ) : null}
      {todoComposer ? (
        <TodoComposer
          draft={todoComposer}
          saving={todoSaving}
          error={todoError}
          onChange={setTodoComposer}
          onClose={() => {
            setTodoComposer(null);
            setTodoError(null);
          }}
          onSave={saveTodoComposer}
        />
      ) : null}
    </div>
    </LineageVisibilityContext.Provider>
    </InternalVisibilityContext.Provider>
  );
}
