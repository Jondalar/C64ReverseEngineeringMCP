// Spec 814 §5 — the finished macro, in an editor that speaks the parser's grammar.
//
// Three properties, and the first two are one rule with two faces:
//
//   1. It validates with the REAL parser. Not a regex, not a second grammar in the
//      browser — `parseFeature`, the same function the executor runs. Errors are
//      shown on the line they belong to, in the parser's own words.
//   2. Autocomplete comes from the parser's exported vocabulary, never from a list
//      typed into this file.
//   3. It is EDITABLE, because the recorder proposes and the human decides: swap a
//      wait for an anchor, drop three fumbled keypresses, rename a capture.
//
// A client that keeps its own copy of what a verb is becomes a second authority,
// and a second authority drifts. The cockpit did exactly that the week this was
// written and answered `unknown command: /turbo` for a verb the daemon had. An
// editor with a hand-written verb list is the same mistake with a nicer font.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { authorOfComment, parseFeature, stripTrailingComment } from "../../../../src/project-knowledge/scenario-gherkin.js";
import { completions, keyTokens } from "../../../../src/project-knowledge/scenario-vocabulary.js";

interface Props {
  initialText: string;
  warnings: readonly string[];
  onClose: () => void;
}

const SUGGESTIONS = [...completions(), ...keyTokens().map((t) => ({
  label: t,
  doc: "A named key inside a typed string.",
  section: "step" as const,
}))];

/** Filter suggestions by what is being typed on the current line. */
function suggest(fragment: string): typeof SUGGESTIONS {
  const f = fragment.trim().toLowerCase();
  if (!f) return SUGGESTIONS.slice(0, 12);
  const words = f.split(/\s+/);
  return SUGGESTIONS.filter((s) => {
    const l = s.label.toLowerCase();
    return words.every((w) => l.includes(w));
  }).slice(0, 12);
}

export function ScenarioOverlay({ initialText, warnings, onClose }: Props): React.JSX.Element {
  const [text, setText] = useState(initialText);
  const [name, setName] = useState("recorded-run");
  const [caret, setCaret] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setText(initialText); }, [initialText]);

  const parsed = useMemo(() => parseFeature(text, `${name}.feature`), [text, name]);
  const lines = useMemo(() => text.split("\n"), [text]);

  // Which line the caret is on, and what is on it — that is the whole context the
  // completion needs.
  const caretLine = useMemo(() => {
    const before = text.slice(0, caret);
    return before.split("\n").length - 1;
  }, [text, caret]);
  const fragment = lines[caretLine] ?? "";
  const suggestions = useMemo(() => suggest(fragment), [fragment]);

  const issuesByLine = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const i of parsed.issues) {
      const at = m.get(i.line) ?? [];
      at.push(i.message);
      m.set(i.line, at);
    }
    return m;
  }, [parsed]);

  const authors = useMemo(() => {
    const set = new Set<string>();
    for (const l of lines) {
      const a = authorOfComment(stripTrailingComment(l).comment);
      if (a) set.add(a);
    }
    return set;
  }, [lines]);

  /**
   * §5.4 — drop everything one party did.
   *
   * The session is SHARED, so a recording is what happened to this machine, all of
   * it. Recording only the human's half would be tidier and wrong — the LLM's load
   * would be missing and the replay would stop two lines later. Recording everything
   * and MARKING it keeps the file correct and makes "throw out what does not belong"
   * one click. It is a textual filter on purpose: a hand editor does the same thing
   * by deleting the lines.
   */
  const dropBy = (who: "human" | "llm"): void => {
    setText(lines.filter((l) => authorOfComment(stripTrailingComment(l).comment) !== who).join("\n"));
  };

  const insert = (snippet: string): void => {
    const area = areaRef.current;
    if (!area) return;
    const at = area.selectionStart;
    const next = `${text.slice(0, at)}${snippet}${text.slice(area.selectionEnd)}`;
    setText(next);
    // Put the caret where the first `<placeholder>` is, so the next thing typed
    // replaces it rather than landing after the whole form.
    const hole = snippet.indexOf("<");
    requestAnimationFrame(() => {
      const pos = hole >= 0 ? at + hole : at + snippet.length;
      area.focus();
      area.setSelectionRange(pos, hole >= 0 ? at + snippet.indexOf(">") + 1 : pos);
    });
  };

  const save = async (): Promise<void> => {
    setSaveError(null);
    // §6 — a `.feature` that does not parse is not a scenario, and writing one
    // produces a file that fails at the moment someone else tries to use it.
    if (parsed.issues.length) {
      setSaveError(`line ${parsed.issues[0].line}: ${parsed.issues[0].message}`);
      return;
    }
    const clean = name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "recorded-run";
    try {
      const r = await fetch("/api/scenario/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: clean, text }),
      });
      const body = (await r.json()) as { path?: string; error?: string };
      if (!r.ok || body.error) throw new Error(body.error ?? `HTTP ${r.status}`);
      setSaved(body.path ?? clean);
    } catch (e) {
      setSaveError((e as Error).message);
    }
  };

  return (
    <div className="wb-overlay" role="dialog" aria-label="Recorded scenario">
      <div className="wb-overlay-panel wb-scenario">
        <div className="wb-overlay-bar">
          <strong>⏺ Recorded scenario</strong>
          <label className="wb-scenario-name">
            name
            <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
            .feature
          </label>
          {authors.has("llm") && (
            <button className="wb-btn" onClick={() => dropBy("llm")} title="Remove every step the LLM made">
              drop the LLM's steps
            </button>
          )}
          {authors.has("human") && authors.has("llm") && (
            <button className="wb-btn" onClick={() => dropBy("human")} title="Remove every step you made">
              drop my steps
            </button>
          )}
          <span className="wb-controls-spacer" />
          <span className={parsed.issues.length ? "wb-scenario-red" : "wb-scenario-green"}>
            {parsed.issues.length
              ? `${parsed.issues.length} problem${parsed.issues.length === 1 ? "" : "s"}`
              : `${parsed.scenarios.length} scenario${parsed.scenarios.length === 1 ? "" : "s"} · ${parsed.scenarios.reduce((n, s) => n + s.steps.length, 0)} steps`}
          </span>
          <button className="wb-btn" onClick={() => void save()} disabled={parsed.issues.length > 0}>
            ⬇ Save to project
          </button>
          <button className="wb-btn" onClick={onClose}>✕ Close</button>
        </div>

        {warnings.length > 0 && (
          <ul className="wb-scenario-warnings">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}
        {saved && <p className="wb-scenario-saved">saved → {saved}</p>}
        {saveError && <p className="wb-scenario-red">{saveError}</p>}

        <div className="wb-scenario-body">
          <div className="wb-scenario-editor">
            {/* The gutter carries the parser's verdict per line, so an error is next
                to the line it is about rather than in a list underneath. */}
            <div className="wb-scenario-gutter">
              {lines.map((_, i) => (
                <div
                  key={i}
                  className={issuesByLine.has(i + 1) ? "wb-gutter-bad" : caretLine === i ? "wb-gutter-here" : ""}
                  title={issuesByLine.get(i + 1)?.join("\n")}
                >
                  {issuesByLine.has(i + 1) ? "●" : i + 1}
                </div>
              ))}
            </div>
            <textarea
              ref={areaRef}
              value={text}
              spellCheck={false}
              onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }}
              onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
              onClick={(e) => setCaret(e.currentTarget.selectionStart)}
            />
          </div>

          <div className="wb-scenario-side">
            {issuesByLine.has(caretLine + 1) && (
              <div className="wb-scenario-lineerr">
                {issuesByLine.get(caretLine + 1)!.map((m, i) => <p key={i}>{m}</p>)}
              </div>
            )}
            <p className="wb-scenario-sidehead">what this notation understands</p>
            <ul className="wb-scenario-suggest">
              {suggestions.map((s, i) => (
                <li key={i}>
                  <button className="wb-btn wb-btn-tiny" onClick={() => insert(s.label)} title={s.doc}>
                    {s.label}
                  </button>
                  <span className="wb-scenario-doc">{s.doc}</span>
                </li>
              ))}
              {suggestions.length === 0 && <li className="wb-scenario-doc">nothing matches that line</li>}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
