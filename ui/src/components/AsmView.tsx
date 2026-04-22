import { useEffect, useMemo, useState } from "react";

export interface AsmViewSource {
  id: string;
  label: string;
  path: string;
  dialect: "kickass" | "64tass" | "plain";
}

interface AsmViewProps {
  title: string;
  projectDir?: string;
  sources: AsmViewSource[];
  onClose: () => void;
}

interface LoadedSource {
  status: "loading" | "ok" | "error";
  text?: string;
  error?: string;
}

// Lightweight 6502 assembly tokenizer for syntax colouring. Handles both
// KickAssembler (`//`, `/* */`, `.pc = $0801`, `:label`, dot-directives)
// and 64tass (`;`, `* = $0801`, `label:`). Renders one row per source
// line so long files stay scrollable without React re-rendering anything
// fancy.

const MNEMONICS = new Set([
  "adc","and","asl","bcc","bcs","beq","bit","bmi","bne","bpl","brk","bvc","bvs","clc","cld","cli","clv","cmp","cpx","cpy","dec","dex","dey","eor","inc","inx","iny","jmp","jsr","lda","ldx","ldy","lsr","nop","ora","pha","php","pla","plp","rol","ror","rti","rts","sbc","sec","sed","sei","sta","stx","sty","tax","tay","tsx","txa","txs","tya",
  // Common undocumented opcodes
  "alr","anc","arr","axs","dcp","isc","lax","rla","rra","sax","slo","sre","jam",
]);

function tokenizeAsmLine(line: string, dialect: AsmViewSource["dialect"]): Array<{ text: string; klass?: string }> {
  if (line.length === 0) return [];
  const tokens: Array<{ text: string; klass?: string }> = [];
  // Comment first — once we hit one, paint the rest of the line.
  const lineCommentChar = dialect === "64tass" ? ";" : "//";
  const ci = dialect === "64tass" ? line.indexOf(";") : line.indexOf("//");
  let codePart = line;
  let trailingComment: string | undefined;
  if (ci >= 0) {
    codePart = line.slice(0, ci);
    trailingComment = line.slice(ci);
  }

  // Tokenise codePart: words, numbers, strings, punctuation.
  const re = /(\s+)|("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')|(\$[0-9a-fA-F]+|%[01]+|0x[0-9a-fA-F]+|\d+)|([.][a-zA-Z_][\w]*)|([a-zA-Z_][\w]*:)|([a-zA-Z_][\w]*)|([#$%&*+,\-/<>=?@\\^|~()[\]{}.])|(.)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(codePart)) !== null) {
    const [_, ws, dquoted, squoted, num, directive, label, ident, punct, other] = match;
    if (ws) { tokens.push({ text: ws }); continue; }
    if (dquoted ?? squoted) { tokens.push({ text: (dquoted ?? squoted)!, klass: "asm-string" }); continue; }
    if (num) { tokens.push({ text: num, klass: "asm-number" }); continue; }
    if (directive) { tokens.push({ text: directive, klass: "asm-directive" }); continue; }
    if (label) { tokens.push({ text: label, klass: "asm-label" }); continue; }
    if (ident) {
      const lower = ident.toLowerCase();
      tokens.push({ text: ident, klass: MNEMONICS.has(lower) ? "asm-mnemonic" : "asm-ident" });
      continue;
    }
    if (punct) { tokens.push({ text: punct, klass: "asm-punct" }); continue; }
    tokens.push({ text: other ?? "" });
  }

  if (trailingComment) tokens.push({ text: trailingComment, klass: "asm-comment" });
  return tokens;
}

export function AsmView({ title, projectDir, sources, onClose }: AsmViewProps) {
  const [activeId, setActiveId] = useState<string>(sources[0]?.id ?? "");
  const active = sources.find((source) => source.id === activeId) ?? sources[0];
  const [cache, setCache] = useState<Record<string, LoadedSource>>({});

  useEffect(() => {
    if (!active) return;
    if (cache[active.id]?.status === "ok" || cache[active.id]?.status === "loading") return;
    setCache((prev) => ({ ...prev, [active.id]: { status: "loading" } }));
    const params = new URLSearchParams({ path: active.path });
    if (projectDir) params.set("projectDir", projectDir);
    fetch(`/api/document?${params.toString()}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((text) => {
        setCache((prev) => ({ ...prev, [active.id]: { status: "ok", text } }));
      })
      .catch((err: unknown) => {
        setCache((prev) => ({ ...prev, [active.id]: { status: "error", error: err instanceof Error ? err.message : String(err) } }));
      });
  }, [active, projectDir, cache]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const lines = useMemo(() => {
    if (!active) return [];
    const loaded = cache[active.id];
    if (loaded?.status !== "ok" || !loaded.text) return [];
    return loaded.text.split("\n");
  }, [active, cache]);

  return (
    <div className="hex-overlay-backdrop" onClick={onClose}>
      <div className="hex-overlay asm-overlay" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header className="hex-overlay-header">
          <div>
            <h3>{title}</h3>
            <p>{active?.path ?? ""} · {active?.dialect ?? "plain"}</p>
          </div>
          <div className="hex-overlay-header-actions">
            {sources.length > 1 ? (
              <div className="asm-tabs">
                {sources.map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    className={source.id === activeId ? "asm-tab asm-tab-active" : "asm-tab"}
                    onClick={() => setActiveId(source.id)}
                  >
                    {source.label}
                  </button>
                ))}
              </div>
            ) : null}
            <button type="button" className="hex-overlay-close" onClick={onClose} aria-label="Close source view">×</button>
          </div>
        </header>
        <div className="hex-overlay-body">
          {!active ? (
            <div className="hex-overlay-empty">No source available.</div>
          ) : cache[active.id]?.status === "loading" ? (
            <div className="hex-overlay-empty">Loading…</div>
          ) : cache[active.id]?.status === "error" ? (
            <div className="hex-overlay-error">{cache[active.id]?.error}</div>
          ) : (
            <pre className="asm-grid">
              {lines.map((line, lineIndex) => (
                <div key={lineIndex} className="asm-row">
                  <span className="asm-lineno">{String(lineIndex + 1).padStart(5, " ")}</span>
                  <span className="asm-line">
                    {tokenizeAsmLine(line, active.dialect).map((token, idx) => (
                      <span key={idx} className={token.klass}>{token.text}</span>
                    ))}
                  </span>
                </div>
              ))}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
