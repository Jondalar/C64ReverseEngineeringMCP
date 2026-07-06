// MCP server-level instructions — injected into the client's context whenever this server
// is connected (which is always: c64-re is a global MCP). This is the ONE surface that is
// present even in a fresh folder before any project wiring, so it is where we catch the
// bare `/init` before it improvises.
//
// Why this exists: a fresh `/init` in a new C64 folder has the c64-re TOOLS available but
// no directive to consult them, so it explored sibling projects "to learn convention" and
// cargo-culted their SUPERSEDED trace-first workflow into a new CLAUDE.md — the exact
// flight-to-runtime the read-before-runtime gate exists to stop, now baked into founding
// doctrine (2026-07-06, Winter Games). The tool-layer gate cannot cover a prose document;
// this pointer does — it makes the authoritative, current doctrine the thing `/init` reads.

export const SERVER_INSTRUCTIONS = `c64-re is the Commodore 64 reverse-engineering MCP (always connected). It owns the canonical C64 RE workflow, project scaffold, and doctrine.

WHEN a repo contains C64 media (.g64/.d64/.d81/.crt/.prg/.t64/.tap) OR you are asked to /init, document, or set up a C64 reverse-engineering project:
- BEFORE writing any CLAUDE.md, README, or workflow doc, get the canonical flow from THIS server: call project_init and read the c64re_agent_doctrine prompt (and project_status for the workflow contract).
- Do NOT infer the RE workflow from other projects' CLAUDE.md files. Sibling C64 projects may carry a SUPERSEDED trace-first / "boot in the runtime and trace the loader" method — do not inherit it. This server is the single source of truth; the sibling docs are not.

THE DOCTRINE IS STATIC-FIRST (docs/agent-doctrine.md §0.5):
- Disassemble + understand the code, and do disk/G64/D64 forensics, FIRST. Follow the loader breadcrumb statically. Reimplement decoders/depackers from what you READ and apply them to the bytes (sandbox_depack, extract_disk_custom_lut) — that is the static path.
- Runtime is ONLY to VERIFY a result you derived by reading — never to discover structure. And you rarely even need it: the emulator is a deterministic function of static inputs (the image bits + the known C64/1541 ROMs + the known CPUs), so anything VICE/TRX64 can PLAY from a .g64/.d64, disassembly + forensics can crack. "Custom-GCR" and "packed" are more static WORK, not "needs runtime".

Accordingly this server REFUSES runtime discovery shortcuts: runtime_loader_lens, runtime_trace_start and the trace-analysis tools require a read-derived hypothesis (a concrete $address + what you read that points there), and the payload-extraction doors refuse a standard-GCR medium (it is a static depack). Read the code first; trace, if at all, only to confirm.`;
