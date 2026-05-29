# LLM-Human C64RE Swimlane

Ziel: Mensch und LLM arbeiten an einem C64RE-Projekt. Der Einstieg ist geordnet, aber ab der ersten Projektbasis ist die Arbeit nicht linear. Je nach Spiel, Loader, Schutz, Ziel und aktuellem Befund wechseln Trace, Disassembly, Inspect, Changes und Validation in Schleifen.

## 1. Einstieg und Projektbasis

Dieser Teil ist weitgehend linear. Er stellt sicher, dass das LLM weiss, wo es ist, was das Ziel ist und welche Medien/Artefakte existieren.

| Phase | Mensch | LLM / Agent | MCP Project / Knowledge | Headless Runtime | TraceDB / Evidence | Workbench UI |
|---|---|---|---|---|---|---|
| Einstieg | Startet Claude/Codex im Projektordner und sagt: "Verbinde dich mit dem MCP." | Onboardet, erkennt neues oder bestehendes Projekt, meldet Status. | `agent_onboard`, `project_status`, `get_project_profile`, `c64re_whats_next` |  |  |  |
| Ziel klaeren | Sagt Ziel: Crack, EasyFlash-Port, Analyse, Bugfix, Routine. | Setzt Rolle/Workflow, fragt nur fehlende Zielinfos ab. | `agent_set_role`, `start_re_workflow`, `agent_propose_next`, `agent_record_step` |  |  |  |
| Medien bereitstellen | Legt `.d64`, `.g64`, `.crt`, `.prg` und Kontext in den Projektordner. | Sagt, wohin Medien gehoeren, registriert Kontext. | `save_finding`, `save_entity`, `save_open_question`, `list_artifacts` |  |  |  |
| Inventar | Wartet auf erste Rueckmeldung. | Extrahiert und beschreibt Disk/CRT/PRG-Inhalt. | `inspect_disk`, `extract_disk`, `extract_crt`, `disk_sector_allocation`, `list_payloads`, `read_artifact` |  |  | Projekt-Dashboard aktualisierbar. |

## 2. Iterativer Arbeitsraum

Ab hier ist der Ablauf bewusst nicht linear. Das LLM waehlt den naechsten sinnvollen Schritt nach Projektziel, aktuellem Befund und menschlicher Rueckmeldung.

Moegliche Zyklen:

- `Traces -> Disassembles -> Changes`
- `Disassembles -> Changes -> Traces`
- `Disassembles -> Traces zur Validierung/Verbesserung -> Changes`
- `Runtime/Inspect -> Finding -> Disassembly -> Runtime`
- `Change -> Runtime-Test -> Trace-Diff -> naechster Change`

| Arbeitsstrang | Mensch | LLM / Agent | MCP Project / Knowledge | Headless Runtime | TraceDB / Evidence | Workbench UI |
|---|---|---|---|---|---|---|
| Runtime erkunden | Gibt Eingaben: RETURN, FIRE, Joystick, Menuewahl, Diskwechsel. | Startet oder nutzt Session, mountet Medien, laeuft bis sinnvollem Zustand. |  | `runtime_session_start`, `runtime_media_mount`, `runtime_type`, `runtime_joystick`, `runtime_session_run`, `runtime_until`, `runtime_render_screen`, `runtime_session_status` | Screens/Status als Evidence-Kandidaten. | Live-Screen sichtbar. |
| Freeze / Inspect | Bewertet sichtbaren Zustand: Titel, Loader, Fehler, Menue, Asset. | Captured Checkpoint, liest Register/Speicher/Disasm, resolved VIC-Pixel/Cells. | Findings/Entities koennen entstehen. | `runtime_session_snapshot`, `runtime_monitor_registers`, `runtime_monitor_memory`, `runtime_monitor_disasm`, `runtime_vic_inspect_at` | Checkpoint, VIC-Provenance, Evidence Record. | Freeze/Overlay/Inspector. |
| Trace aufnehmen | Laesst Runtime laufen oder hilft interaktiv durch Lade-/Spielphasen. | Sichert oder nutzt Trace und setzt/liest relevante Marker. | Trace wird als Projektartefakt referenziert. | `runtime_session_run` | `runtime_query_events`, `trace_store_info`, `trace_store_query`, `trace_store_anchor_list`, `trace_store_anchor_find` | Trace-Status und bounded Views. |
| Trace auswerten | Fragt: wo haengt der Loader, wo kommt Asset her, was schreibt wohin? | Baut Swimlane, Taint, Loader-Profil, Pfadverfolgung. | `save_finding`, `save_open_question`, `link_entities` |  | `runtime_swimlane_slice`, `runtime_trace_taint`, `runtime_follow_path`, `runtime_profile_loader`, `trace_store_bus_find`, `trace_store_top_pcs` |  |
| Disassembly starten/verbessern | Bestaetigt, dass Disassembly sinnvoll ist, oder fragt nach Code. | Disassembliert Payloads, verbessert Labels/Annotations mit Runtime-Evidence. | `analyze_prg`, `disasm_prg`, `disasm_menu`, `inspect_address_range`, `c64ref_lookup`, `link_payload_to_asm`, `propose_annotations`, `save_finding` | `runtime_resolve_pc` | Runtime-Refs werden zitiert. | Annotated Listing sichtbar. |
| Asset semantisch verknuepfen | Markiert Logo/Sprite/Charset/Screenbereich oder fragt danach. | Matcht sichtbare Daten gegen RAM, File/Payload und Code. | `save_finding`, `save_entity`, `link_entities` | `runtime_vic_inspect_at`, `runtime_monitor_memory` | Evidence Record zeigt Quelle. | Overlay/Inspector zeigt Ref. |
| Change / Patch / Intervention | Entscheidet: Crack, Patch, EF-Port, Fix, Code Overlay, Testbranch. | Erzeugt oder beschreibt Aenderung, haelt Annahmen und Risk fest. | `save_finding`, `save_open_question`, `agent_record_step` | Spaeter: Code-Overlay/Patch-Branch Runtime-Tools. | Vorher/Nachher Evidence. | Branch/Change UI spaeter. |
| Validation | Testet Ergebnis oder gibt neue Eingaben. | Reproduziert per Runtime, Trace oder Views; entscheidet naechsten Zyklus. | `agent_propose_next`, `agent_record_step`, `build_memory_map`, `build_project_dashboard`, `build_annotated_listing_view`, `build_all_views`, `render_docs` | `runtime_session_run`, `runtime_render_screen`, `runtime_session_snapshot` | Trace-/Checkpoint-Vergleich. | Projektstand sichtbar. |
| VICE Oracle | Fordert VICE-Vergleich nur bei echter Divergenz. | Nutzt VICE gezielt als Oracle, nicht als Standardworkflow. | Finding mit Oracle-Bezug. | Headless bleibt Primaerpfad. | VICE-Diff als Evidence. |  |

## 3. Loop-Regel

Nach jedem substantiellen Schritt macht das LLM drei Dinge:

1. Ergebnis im Projekt speichern, nicht nur im Chat.
2. Den naechsten sinnvollen Schritt vorschlagen.
3. Begruenden, warum jetzt Trace, Disassembly, Inspect, Change oder Validation dran ist.

Es gibt keinen festen Zwang, erst komplett zu tracen oder erst komplett zu disassemblieren. Die richtige Reihenfolge ist projektabhaengig.

## 4. Default-Tool-Konsequenz

Das Default-MCP muss diesen iterativen Arbeitsraum tragen. Es darf nicht nur statische Analyse/Knowledge anbieten.

Default sichtbar:

- Agent/Workflow: `agent_onboard`, `agent_propose_next`, `agent_record_step`, `start_re_workflow`
- Knowledge: `save_finding`, `save_entity`, `save_open_question`, `list_*`, `read_artifact`, `link_*`
- Medien/Extraktion: `inspect_disk`, `extract_disk`, `extract_crt`, `disk_sector_allocation`
- Analyse/Disassembly: `analyze_prg`, `disasm_prg`, `disasm_menu`, `inspect_address_range`, `c64ref_lookup`
- Headless Runtime: `runtime_session_start`, `runtime_media_mount`, `runtime_session_run`, `runtime_type`, `runtime_joystick`, `runtime_render_screen`, `runtime_session_snapshot`
- Monitor/Inspect: `runtime_monitor_registers`, `runtime_monitor_memory`, `runtime_monitor_disasm`, `runtime_until`, `runtime_resolve_pc`, `runtime_vic_inspect_at`
- Trace/Evidence: `runtime_query_events`, `trace_store_*`, `runtime_swimlane_slice`, `runtime_trace_taint`, `runtime_follow_path`, `runtime_profile_loader`

Nicht Default:

- `vice_*`: Oracle/Backup bei Divergenz.
- Drive-only Debug-Tools.
- Maintenance/Backfill/Repair/Bulk.
- Alte Runtime-Modi, Lockstep-Schalter, Legacy-Pfade.
