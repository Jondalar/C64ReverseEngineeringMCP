import type { ReactNode } from "react";

// FileInspector — shared shell for the disk-file and cart-chunk inspectors.
// Both media expose the same conceptual structure (file with a list of
// spans + optional cross-refs), so the only thing the per-medium wrapper
// has to do is shape its domain object into these props.

export type FileInspectorMediumKind = "disk" | "cartridge";

export interface FileInspectorActionButton {
  label: string;
  title?: string;
  enabled: boolean;
  onClick: () => void;
}

export interface FileInspectorSpanRow {
  id: string;
  primary: string;
  status: string;
  subText?: string;
  footerLeft?: string;
  footerRight?: string;
  monEnabled: boolean;
  monTitle?: string;
  onMon?: () => void;
}

export interface FileInspectorMetaRow {
  key: string;
  label: string;
  value: string;
}

export interface FileInspectorHeadlineExtra {
  key: string;
  text: string;
  className?: string;
}

export interface FileInspectorProps {
  mediumKind: FileInspectorMediumKind;
  title: string;
  swatchColor?: string;
  packer?: string;
  format?: string;
  notes?: string[];
  headlineExtras: FileInspectorHeadlineExtra[];
  metaRows: FileInspectorMetaRow[];
  primaryAction?: FileInspectorActionButton;
  secondaryActions?: FileInspectorActionButton[];
  spansLabel: string;
  spans: FileInspectorSpanRow[];
  extraSections?: ReactNode;
  onClose: () => void;
}

const HEADER_LABEL: Record<FileInspectorMediumKind, string> = {
  disk: "Disk file",
  cartridge: "Cartridge file",
};

export function FileInspector({
  mediumKind,
  title,
  swatchColor,
  packer,
  format,
  notes,
  headlineExtras,
  metaRows,
  primaryAction,
  secondaryActions,
  spansLabel,
  spans,
  extraSections,
  onClose,
}: FileInspectorProps) {
  return (
    <section className="panel-card inspector-card">
      <div className="section-heading">
        <h3>{HEADER_LABEL[mediumKind]}</h3>
        <button type="button" className="mon-icon-button" onClick={onClose}>back</button>
      </div>
      <div className="chunk-inspector-summary">
        <div className="chunk-inspector-headline">
          <span className="chunk-color-swatch" style={{ background: swatchColor ?? "#444" }} />
          <strong>
            {title}
            {packer ? <span className="packer-tag">{packer}</span> : null}
          </strong>
          {headlineExtras.map((extra) => (
            <span key={extra.key} className={extra.className}>{extra.text}</span>
          ))}
        </div>
        <div className="chunk-inspector-paths">
          {metaRows.map((row) => (
            <div key={row.key}>
              <span className="chunk-inspector-label">{row.label}</span>
              <span>{row.value}</span>
            </div>
          ))}
          {(packer || format) && !metaRows.some((row) => row.label === "packer / format") ? (
            <div>
              <span className="chunk-inspector-label">packer / format</span>
              <span>{[packer, format].filter(Boolean).join(" · ")}</span>
            </div>
          ) : null}
          {notes && notes.length > 0 ? (
            <div>
              <span className="chunk-inspector-label">notes</span>
              <span>{notes.join(" · ")}</span>
            </div>
          ) : null}
        </div>
        <div className="chunk-inspector-action-row">
          {primaryAction ? (
            <button
              type="button"
              className="mon-icon-button chunk-inspector-mon"
              disabled={!primaryAction.enabled}
              onClick={primaryAction.onClick}
              title={primaryAction.title}
            >
              {primaryAction.label}
            </button>
          ) : null}
          {(secondaryActions ?? []).map((action) => (
            <button
              key={action.label}
              type="button"
              className="mon-icon-button"
              disabled={!action.enabled}
              onClick={action.onClick}
              title={action.title}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
      <div className="inspector-block">
        <h4>{spansLabel}</h4>
        <div className="record-stack compact">
          {spans.map((span) => (
            <div key={span.id} className="record-card-row">
              <div className="record-card">
                <div className="record-topline">
                  <span>{span.primary}</span>
                  <span className="record-status">{span.status}</span>
                </div>
                {span.subText ? <p>{span.subText}</p> : null}
                {(span.footerLeft || span.footerRight) ? (
                  <div className="record-meta">
                    {span.footerLeft ? <span>{span.footerLeft}</span> : null}
                    {span.footerRight ? <span>{span.footerRight}</span> : null}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="mon-icon-button"
                title={span.monTitle}
                disabled={!span.monEnabled}
                onClick={span.onMon}
              >
                mon
              </button>
            </div>
          ))}
        </div>
      </div>
      {extraSections}
    </section>
  );
}
