import type { ReactNode } from "react";

// Shared shell for the cart + disk panels. Each panel renders its own
// medium-specific grid (SVG ring vs bank stack), but the heading and
// origin-filter pill bar are identical and live here.

export interface MediumOriginPillSpec {
  key: string;
  label: string;
  count: number;
}

export interface MediumPanelShellProps {
  title: string;
  countSummary: string;
  filterTitle?: string;
  filterPills?: MediumOriginPillSpec[];
  activeFilter?: string;
  onSelectFilter?: (key: string) => void;
  tabs?: ReactNode;
  children: ReactNode;
}

export function MediumPanelShell({
  title,
  countSummary,
  filterTitle,
  filterPills,
  activeFilter,
  onSelectFilter,
  tabs,
  children,
}: MediumPanelShellProps) {
  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>{title}</h3>
        <span>{countSummary}</span>
      </div>
      {tabs}
      {filterPills && filterPills.length > 0 ? (
        <div className="cart-lut-filter">
          {filterTitle ? <span className="cart-lut-filter-title">{filterTitle}</span> : null}
          {filterPills.map((pill) => (
            <button
              key={pill.key}
              type="button"
              className={activeFilter === pill.key ? "cart-lut-pill cart-lut-pill-active" : "cart-lut-pill"}
              onClick={() => onSelectFilter?.(pill.key)}
            >
              <span>{pill.label}</span>
              <span className="cart-lut-pill-count">{pill.count}</span>
            </button>
          ))}
        </div>
      ) : null}
      {children}
    </section>
  );
}
